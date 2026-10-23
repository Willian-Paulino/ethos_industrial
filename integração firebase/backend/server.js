'use strict';
/** ETHOS Industrial | Servidor Node.js com SQLite nativo (Node >=22.13, recomendado 24 LTS).
 * Com notificações SMTP opcionais via Nodemailer. Execute: node server.js serve
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { backup, DatabaseSync } = require('node:sqlite');
const EMAIL_CONFIG_PATH = path.join(__dirname, 'email.config.json');
const firebaseSync = require('./firebase-sync');
let firebaseBridge;

const ROOT = __dirname;
const DB_PATH = path.resolve(process.env.ETHOS_DB_PATH || path.join(ROOT, 'dados', 'ethos.sqlite3'));
const MAX_BYTES = 16 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60;
const FAILED_LOGINS = new Map();
const SIGNUP_ATTEMPTS = new Map();
// Integração GitHub Pages: URL EXATA do projeto publicado, por exemplo
// https://usuario.github.io/ethos-industrial/ (não usar curinga).
const PAGES_URL = (() => {
  const value = String(process.env.ETHOS_PAGES_URL || '').trim();
  if (!value) return null;
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('ETHOS_PAGES_URL precisa ser uma URL HTTPS pública sem query/hash.');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
})();
const PAGES_ORIGIN = PAGES_URL?.origin || null;
const PAGES_CODES = new Map();

let db;
const now = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now() / 1000);
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const safeJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const hasUsers = () => Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
const usernameValid = s => /^[\p{L}\p{N}._-]{3,48}$/u.test(s);
const usernameNormalize = s => String(s || '').trim().toLowerCase();

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH, { timeout: 15000 });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dataset(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,imported_json TEXT,added_json TEXT NOT NULL DEFAULT '[]',actions_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL,updated_by TEXT);
    CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,item TEXT,record_date TEXT,quantity REAL,family TEXT,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_records_item ON records(item);
    CREATE INDEX IF NOT EXISTS idx_records_date ON records(record_date);
    CREATE TABLE IF NOT EXISTS actions(action_key TEXT PRIMARY KEY,status TEXT,owner TEXT,due_date TEXT,priority TEXT,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,revision INTEGER NOT NULL,username TEXT NOT NULL,created_at TEXT NOT NULL,base_count INTEGER,manual_count INTEGER,actions_count INTEGER);
    CREATE TABLE IF NOT EXISTS user_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,operation TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS help_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), item_type TEXT NOT NULL, item_code TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', admin_reply TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, handled_by TEXT);
    CREATE INDEX IF NOT EXISTS idx_help_user ON help_requests(user_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_help_status ON help_requests(status);
    CREATE TABLE IF NOT EXISTS help_events(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES help_requests(id), actor TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL UNIQUE REFERENCES help_requests(id), status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', sent_at TEXT);
  `);
  const cols = db.prepare('PRAGMA table_info(users)').all().map(r => r.name);
  if (!cols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'");
    db.prepare("UPDATE users SET role='admin' WHERE username='admin'").run();
    if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
      const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
      if (first) db.prepare("UPDATE users SET role='admin' WHERE id=?").run(first.id);
    }
  }
  if (!cols.includes('approval_status')) {
    db.exec("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
  }
  // Migração sem perder usuários existentes: editores anteriores tornam-se intermediários.
  db.prepare("UPDATE users SET role='intermediate' WHERE role='editor' AND approval_status='approved'").run();
  db.prepare("UPDATE users SET role='common' WHERE role='editor' AND approval_status='pending'").run();
  db.prepare("UPDATE users SET role='common' WHERE role NOT IN ('admin','intermediate','common')").run();
  // Central inteligente: migração aditiva, preserva todos os chamados anteriores.
  const helpCols = new Set(db.prepare('PRAGMA table_info(help_requests)').all().map(c => c.name));
  for (const [col, ddl] of Object.entries({
    category: "TEXT NOT NULL DEFAULT 'apontamento'",
    priority: "TEXT NOT NULL DEFAULT 'normal'",
    sector: "TEXT NOT NULL DEFAULT ''",
    assigned_to: "TEXT NOT NULL DEFAULT ''",
    due_at: "TEXT",
    resolved_at: "TEXT"
    ,first_response_at: "TEXT"
  })) if (!helpCols.has(col)) db.exec(`ALTER TABLE help_requests ADD COLUMN ${col} ${ddl}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS help_messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES help_requests(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_help_messages_request ON help_messages(request_id,id);
    CREATE TABLE IF NOT EXISTS internal_notifications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      request_id INTEGER REFERENCES help_requests(id),
      message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON internal_notifications(user_id,read_at,id);
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS sla_settings(id INTEGER PRIMARY KEY CHECK(id=1), policy_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO sla_settings(id,policy_json,updated_at,updated_by) VALUES(1,?,?,?)').run(JSON.stringify(DEFAULT_SLA),now(),'sistema');
  // Recupera a primeira resposta administrativa registrada nos chamados antigos.
  db.exec(`UPDATE help_requests SET first_response_at=(
    SELECT MIN(event.created_at) FROM help_events event
    WHERE event.request_id=help_requests.id AND (
      (event.action='status_changed' AND LENGTH(TRIM(event.reply))>0)
      OR (event.action='message' AND EXISTS(SELECT 1 FROM users u WHERE u.username=event.actor AND u.role='admin'))
    )
  ) WHERE first_response_at IS NULL AND EXISTS (
    SELECT 1 FROM help_events event WHERE event.request_id=help_requests.id AND (
      (event.action='status_changed' AND LENGTH(TRIM(event.reply))>0)
      OR (event.action='message' AND EXISTS(SELECT 1 FROM users u WHERE u.username=event.actor AND u.role='admin'))
    )
  );`);
  db.prepare("INSERT OR IGNORE INTO dataset(id,revision,imported_json,added_json,actions_json,updated_at) VALUES(1,0,NULL,'[]','{}',?)").run(now());
  firebaseSync.install(db);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(20);
  return `${salt.toString('base64')}:${crypto.pbkdf2Sync(password, salt, 450000, 32, 'sha256').toString('base64')}`;
}
function verifyPassword(password, stored) {
  try {
    const [saltB64, digestB64] = String(stored).split(':');
    const expected = Buffer.from(digestB64, 'base64');
    const actual = crypto.pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), 450000, expected.length, 'sha256');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(epoch());
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, epoch() + SESSION_TTL);
  return token;
}
function bearerToken(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}
function pagesOriginAllowed(req) {
  return Boolean(PAGES_ORIGIN && req.headers.origin === PAGES_ORIGIN);
}
function pagesCors(req) {
  if (!pagesOriginAllowed(req)) return {};
  return {
    'Access-Control-Allow-Origin': PAGES_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ETHOS-Auto-Refresh',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}
function pagesForm(error, token) {
  return page('Acessar pelo GitHub Pages', `<p>Entre para acessar o ETHOS pelo endereço publicado no GitHub Pages.</p>
  <form method="post" action="/pages-login"><input type="hidden" name="csrf_token" value="${token}">
  <label for="username">Usuário</label><input id="username" name="username" autocomplete="username" required>
  <label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button>Entrar no ETHOS online</button></form>
  <p class="hint"><a href="/cadastro">Solicitar cadastro</a></p>`, error);
}
function sendPagesForm(res, status = 200, error = '') {
  const token = newFormToken();
  return send(res, status, pagesForm(error, token), 'text/html; charset=utf-8', { 'Set-Cookie':formCsrfCookie(token) });
}
function pagesCode(token) {
  const code = crypto.randomBytes(32).toString('hex');
  for (const [key, entry] of PAGES_CODES) if (entry.expires < Date.now()) PAGES_CODES.delete(key);
  if (PAGES_CODES.size > 500) PAGES_CODES.clear();
  PAGES_CODES.set(hashToken(code), { token, expires:Date.now() + 60000 });
  return code;
}
function cookieToken(req) {
  const match = /(?:^|;\s*)ethos_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match ? match[1] : null;
}
function auth(req) {
  const token = bearerToken(req) || cookieToken(req);
  if (!token) return null;
  return db.prepare(`SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND u.approval_status='approved'`).get(hashToken(token), epoch()) || null;
}
function cookie(req, token, maxAge = SESSION_TTL) {
  const secure = req.socket.encrypted || process.env.ETHOS_SECURE_COOKIE === '1';
  return `ethos_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function send(res, status, body = '', type = 'text/html; charset=utf-8', extra = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': data.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "frame-ancestors 'none'", ...extra,
  });
  res.end(data);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain; charset=utf-8', { Location: to, ...extra });
// Os formulários usam um token CSRF vinculado a um cookie HttpOnly.
// Isso evita falsos bloqueios por cabeçalhos Origin/Sec-Fetch-Site alterados
// por alguns ambientes corporativos, sem liberar requisições externas.
const FORM_CSRF_TTL = 30 * 60;
function formCsrfCookie(token) {
  return `ethos_form_csrf=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${FORM_CSRF_TTL}${process.env.ETHOS_SECURE_COOKIE === '1' ? '; Secure' : ''}`;
}
function newFormToken() { return crypto.randomBytes(32).toString('hex'); }
function formCsrfValid(req, body) {
  const match = /(?:^|;\s*)ethos_form_csrf=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  const token = String(new URLSearchParams(body).get('csrf_token') || '');
  if (!match || !/^[a-f0-9]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(token, 'hex'));
}
function sendForm(res, kind, status = 200, error = '') {
  const token = newFormToken();
  const html = kind === 'setup' ? setupPage(error, token) : kind === 'cadastro' ? signupPage(error, token) : loginPage(error, token);
  return send(res, status, html, 'text/html; charset=utf-8', { 'Set-Cookie': formCsrfCookie(token) });
}
function originAllowed(req) {
  if (pagesOriginAllowed(req) && bearerToken(req)) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    const u = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(u.protocol) && u.host === req.headers.host;
  } catch { return false; }
}
async function readBody(req) {
  const headerLen = Number(req.headers['content-length'] || 0);
  if (headerLen > MAX_BYTES) throw Object.assign(new Error('Requisição excede 16 MB'), { status: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error('Requisição excede 16 MB'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function page(title, content, error = '') {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ETHOS Industrial</title>
<style>
:root{font-family:'Segoe UI Variable','Segoe UI',Arial,sans-serif;color:#1b2d44;background:#eef2f7}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 100% 0%,#dfe7f3,transparent 45%),#eef2f7}.auth{width:min(960px,100%);display:grid;grid-template-columns:.93fr 1fr;background:#fff;border:1px solid #e0e6ee;border-radius:24px;overflow:hidden;box-shadow:0 28px 75px #1b2d4420}.visual{position:relative;min-height:590px;display:flex;flex-direction:column;justify-content:space-between;padding:42px 40px;color:#fff;background:linear-gradient(142deg,#111e32 0%,#243851 58%,#7a2645 100%);overflow:hidden}.visual:after{content:'';position:absolute;width:410px;height:410px;border:1px solid #ffffff25;border-radius:50%;left:36%;bottom:-200px;box-shadow:0 0 0 55px #ffffff08,0 0 0 110px #ffffff06}.brand{display:flex;gap:13px;align-items:center;position:relative;z-index:1}.brandmark{display:grid;place-items:center;width:47px;height:47px;border-radius:14px;background:#b6294e;font-size:25px;font-weight:800;letter-spacing:-2px;box-shadow:0 9px 20px #0003}.brand strong{font-size:23px;letter-spacing:-.7px}.brand strong em{color:#f2a6b9;font-style:normal}.brand small{display:block;font-size:10px;letter-spacing:1.8px;color:#d5dfe9;font-weight:700;margin-top:2px}.visual-content{position:relative;z-index:1}.eyebrow{display:block;color:#ffb2c6;letter-spacing:2px;font-size:11px;font-weight:800;margin-bottom:18px}.visual h1{font-size:clamp(32px,4vw,46px);line-height:1.1;letter-spacing:-1.8px;margin:0 0 19px}.visual p{font-size:14px;color:#cbd6e3;max-width:310px;line-height:1.8}.visual-foot{font-size:11px;letter-spacing:1px;color:#b6c4d4;position:relative;z-index:1}.formside{padding:52px 49px 42px;align-self:center}.toplabel{display:inline-flex;gap:7px;align-items:center;background:#f8edf1;color:#9b2342;font-size:10px;font-weight:800;letter-spacing:1.3px;padding:8px 12px;border-radius:100px;margin-bottom:22px}.formside h2{font-size:29px;letter-spacing:-1px;margin:0 0 9px;color:#1b2d44}.formside .lead{color:#788699;font-size:13px;line-height:1.65;margin:0 0 26px}.formside p{font-size:13px;line-height:1.6;color:#728094}.formside label{display:block;margin:16px 0 7px;font-size:12px;font-weight:750;color:#3b4c63}.formside input:not([type=checkbox]){width:100%;border:1px solid #dbe3ec;background:#fbfcfe;border-radius:11px;padding:14px 13px;min-height:47px;font:inherit;color:#1c3048}.formside input:focus{outline:none;border-color:#b12b4b;box-shadow:0 0 0 4px #b12b4b17}.formside button{width:100%;border:0;border-radius:11px;padding:14px;margin-top:22px;background:linear-gradient(110deg,#9b193b,#cb2e53);color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 9px 18px #a7224426}.formside button:hover{filter:brightness(1.05)}.formside a{color:#9d2142;text-decoration:none;font-weight:700}.formside a:hover{text-decoration:underline}.formside .hint{text-align:center;margin-top:19px!important;font-size:12px}.formside .check{display:flex;align-items:center;gap:9px}.formside .check input{width:auto;accent-color:#a51e40}.error{padding:12px;border:1px solid #f0c8d0;background:#fff2f5;color:#9c1838!important;border-radius:10px;margin-top:14px}.auth-note{margin-top:25px;border-top:1px solid #edf0f5;padding-top:17px;color:#93a0af;font-size:11px;text-align:center}@media(max-width:760px){body{padding:13px}.auth{grid-template-columns:1fr;border-radius:18px}.visual{min-height:160px;padding:22px 25px}.visual-content{display:none}.visual-foot{display:none}.formside{padding:30px 25px 26px;width:100%}.formside h2{font-size:25px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
.auth-brand-logo{display:flex;align-items:center;justify-content:center;background:#fff;border-radius:12px;padding:9px 13px;min-height:61px;box-shadow:0 9px 22px #0002}.auth-brand-logo img{width:195px;max-width:100%;height:auto;display:block;object-fit:contain}.auth-brand-subtitle{color:#e5eaf3;font-size:10px;font-weight:800;letter-spacing:1.6px;white-space:nowrap}@media(max-width:760px){.auth-brand-logo img{width:150px}.auth-brand-logo{min-height:48px}}
.auth-brand-logo{padding:0!important;border:0!important;background:transparent!important;box-shadow:none!important;border-radius:0!important;min-height:0!important}.auth-brand-logo img{width:224px!important;height:auto!important;max-width:100%!important;object-fit:contain!important}@media(max-width:760px){.auth-brand-logo img{width:170px!important}}
</style></head><body><div class="auth"><aside class="visual"><div class="brand"><span class="auth-brand-logo"><img src="/ethos-logo.png" alt="Logo ETHOS Industrial" width="224" height="72"></span><small class="auth-brand-subtitle">INDUSTRIAL · PCP</small></div><div class="visual-content"><span class="eyebrow">PLATAFORMA DE GESTÃO</span><h1>Operação mais<br>conectada.<br>Decisões melhores.</h1><p>Controle de implantações MES / ERP, suporte à produção e rastreabilidade em um só ambiente.</p></div><div class="visual-foot">ETHOS INDUSTRIAL &nbsp; / &nbsp; AMBIENTE RESTRITO</div></aside><main class="formside"><span class="toplabel">● ACESSO SEGURO</span><h2>${title}</h2><p class="lead">PCP · Gestão industrial e apontamentos</p>${content}${errorHtml}<div class="auth-note">Acesso exclusivo a usuários autorizados · ETHOS Industrial</div></main></div></body></html>`;
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const loginPage = (error, token) => page('Acessar o sistema', `<form method="post" action="/login"><input type="hidden" name="csrf_token" value="${token}"><label for="username">Usuário</label><input id="username" name="username" autocomplete="username" required><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>Entrar no sistema</button></form><p class="hint" style="text-align:center;margin-top:20px">Ainda não tem acesso? <a href="/cadastro"><strong>Criar minha conta</strong></a></p>`, error);
const signupPage = (error, token) => page('Criar minha conta', `<p>Cadastre seus dados para solicitar acesso ao ETHOS. Um administrador precisará aprovar sua conta antes do primeiro login.</p><form method="post" action="/cadastro"><input type="hidden" name="csrf_token" value="${token}"><label for="username">Nome de usuário</label><input id="username" name="username" minlength="3" maxlength="48" autocomplete="username" placeholder="ex.: joao.producao" required><label for="password">Senha (mínimo 12 caracteres)</label><input id="password" name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><label for="confirm">Confirmar senha</label><input id="confirm" name="confirm" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><label class="check"><input type="checkbox" id="show" onclick="document.getElementById('password').type=document.getElementById('confirm').type=this.checked?'text':'password'"> Mostrar senhas</label><button>Solicitar cadastro</button></form><p class="hint" style="text-align:center;margin-top:20px">Já tem conta? <a href="/login">Voltar ao login</a></p>`, error);
const setupPage = (error, token) => page('Criar administrador', `<p>Primeiro acesso. Crie o usuário principal diretamente nesta página, sem CMD e sem Python.</p><form method="post" action="/setup"><input type="hidden" name="csrf_token" value="${token}"><label for="username">Usuário administrador</label><input id="username" name="username" value="admin" minlength="3" maxlength="48" required><label for="password">Senha (mínimo 12 caracteres)</label><input id="password" name="password" type="password" minlength="12" autocomplete="new-password" required><label for="confirm">Confirmar senha</label><input id="confirm" name="confirm" type="password" minlength="12" autocomplete="new-password" required><label class="check"><input type="checkbox" id="show" onclick="document.getElementById('password').type=document.getElementById('confirm').type=this.checked?'text':'password'"> Mostrar senhas</label><button>Criar administrador e entrar</button></form><p class="hint">Por segurança, o cadastro inicial só pode ser feito no computador servidor (127.0.0.1).</p>`, error);
function getState() {
  const r = db.prepare('SELECT * FROM dataset WHERE id=1').get();
  return { revision:r.revision, imported:r.imported_json === null ? null : safeJson(r.imported_json, null), added:safeJson(r.added_json, []), actions:safeJson(r.actions_json, {}), updatedAt:r.updated_at, updatedBy:r.updated_by };
}
function validateState(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('JSON inválido');
  if (!Number.isSafeInteger(p.revision) || p.revision < 0) throw new Error('Revisão obrigatória');
  if (p.imported !== null && !Array.isArray(p.imported)) throw new Error('Base deve ser uma lista ou null');
  if (!Array.isArray(p.added) || !p.actions || typeof p.actions !== 'object' || Array.isArray(p.actions)) throw new Error('Registros manuais/ações inválidos');
  if ((p.imported?.length || 0) + p.added.length > 80000 || Object.keys(p.actions).length > 30000) throw new Error('Base excede o limite configurado');
  for (const r of [...(p.imported || []), ...p.added]) if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Linha inválida na base');
  for (const [k, a] of Object.entries(p.actions)) if (k.length > 500 || !a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Ação inválida');
}
function family(item) {
  const prefix = String(item || '').split('-')[0];
  return ['21','28'].includes(prefix) ? '21' : ['55','58'].includes(prefix) ? '55' : ['90','98'].includes(prefix) ? '90' : 'Outros';
}
function saveState(p, user, role) {
  validateState(p);
  db.exec('BEGIN IMMEDIATE');
  try {
    const old = getState();
    if (p.revision !== old.revision) {
      db.exec('ROLLBACK');
      return { conflict:old.revision };
    }
    if (role !== 'admin') {
      if (role !== 'intermediate') { db.exec('ROLLBACK'); return { forbidden:true }; }
      // Intermediário só pode acrescentar implantações manuais; nunca alterar
      // base importada, ações, registros anteriores ou excluir itens.
      if (JSON.stringify(p.imported) !== JSON.stringify(old.imported) ||
          JSON.stringify(p.actions) !== JSON.stringify(old.actions) ||
          p.added.length <= old.added.length ||
          JSON.stringify(p.added.slice(0,old.added.length)) !== JSON.stringify(old.added)) {
        db.exec('ROLLBACK'); return { forbidden:true };
      }
    }
    const revision = old.revision + 1;
    db.prepare('UPDATE dataset SET revision=?,imported_json=?,added_json=?,actions_json=?,updated_at=?,updated_by=? WHERE id=1')
      .run(revision, p.imported === null ? null : JSON.stringify(p.imported), JSON.stringify(p.added), JSON.stringify(p.actions), now(), user);
    db.exec('DELETE FROM records; DELETE FROM actions;');
    const insertRow = db.prepare('INSERT INTO records(source,item,record_date,quantity,family,payload) VALUES(?,?,?,?,?,?)');
    for (const [source, rows] of [['base', p.imported || []], ['manual', p.added]]) {
      for (const r of rows) {
        const n = Number(r.Quantidade_ENPR || 0);
        const quantity = Number.isFinite(n) ? n : null;
        insertRow.run(source, String(r.Item || '').slice(0,200), String(r.Data || '').slice(0,32), quantity, family(r.Item), JSON.stringify(r));
      }
    }
    const insertAction = db.prepare('INSERT INTO actions(action_key,status,owner,due_date,priority,payload) VALUES(?,?,?,?,?,?)');
    for (const [k, a] of Object.entries(p.actions)) insertAction.run(k, String(a.status || ''), String(a.owner || ''), String(a.due || ''), String(a.priority || ''), JSON.stringify(a));
    db.prepare('INSERT INTO audit(revision,username,created_at,base_count,manual_count,actions_count) VALUES(?,?,?,?,?,?)')
      .run(revision, user, now(), p.imported?.length || 0, p.added.length, Object.keys(p.actions).length);
    db.exec('COMMIT');
    auditUser(user, role === 'intermediate' ? 'add_implantation' : 'save_dataset', 'revision '+revision);
    return { ok:true, revision, updatedBy:user };
  } catch (err) { try { db.exec('ROLLBACK'); } catch {} throw err; }
}
// Fila persistente: o chamado é salvo antes de tentar enviar o e-mail.
// Em caso de falha de SMTP, o envio é tentado novamente sem bloquear o usuário.
let emailProcessing = false;
function readEmailConfig() {
  if (!fs.existsSync(EMAIL_CONFIG_PATH)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(EMAIL_CONFIG_PATH, 'utf8'));
    const fields = ['host','user','password','from','to'];
    if (fields.some(k => !cfg[k] || String(cfg[k]).includes('PREENCHER'))) return null;
    const port = Number(cfg.port || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {host:String(cfg.host),port,secure:cfg.secure===true,user:String(cfg.user),password:String(cfg.password),from:String(cfg.from),to:String(cfg.to)};
  } catch (e) { console.error('Configuração de e-mail inválida. Confira email.config.json.'); return null; }
}
function notifyUser(userId, requestId, message) {
  db.prepare('INSERT INTO internal_notifications(user_id,request_id,message,created_at) VALUES(?,?,?,?)')
    .run(userId, requestId, message.slice(0,400), now());
}
function notifyAdmins(requestId, message) {
  for (const u of db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND approval_status='approved'").all())
    notifyUser(u.id, requestId, message);
}
const CATEGORIES = ['apontamento','cadastro','transferencia','estoque','sistema','outros'];
const PRIORITIES = ['baixa','normal','alta','critica'];
const HELP_STATUSES = ['pending','approved','resolved'];
// Prazos em horas corridas. Política configurável apenas por administradores.
const DEFAULT_SLA={baixa:{response:24,resolution:96},normal:{response:8,resolution:48},alta:{response:4,resolution:24},critica:{response:1,resolution:8}};
function getSlaPolicy(){const row=db.prepare('SELECT policy_json FROM sla_settings WHERE id=1').get();return safeJson(row?.policy_json,DEFAULT_SLA);}
function validateSlaPolicy(p){
  if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==4)return false;
  return PRIORITIES.every(key=>p[key]&&typeof p[key]==='object'&&Object.keys(p[key]).length===2&&['response','resolution'].every(k=>Number.isInteger(p[key][k])&&p[key][k]>=1&&p[key][k]<=720)&&p[key].response<=p[key].resolution);
}
function buildSlaMetrics(period){
  const days={7:7,30:30,90:90,all:null}[period];
  const since=days?new Date(Date.now()-days*86400000).toISOString():null;
  const rows=since?db.prepare('SELECT * FROM help_requests WHERE created_at>=? ORDER BY id DESC').all(since):db.prepare('SELECT * FROM help_requests ORDER BY id DESC').all();
  const policy=getSlaPolicy(),nowMs=Date.now();
  const totals={total:rows.length,open:0,resolved:0,overdue:0,responseBreached:0,resolutionBreached:0,responseEligible:0,resolutionEligible:0,responseOnTime:0,resolutionOnTime:0,responded:0,firstResponseHours:null,resolutionHours:null};
  let respSum=0,resSum=0;
  const breakdown={priority:{},category:{},sector:{},assigned_to:{}};
  for(const r of rows){
    const created=Date.parse(r.created_at),first=r.first_response_at?Date.parse(r.first_response_at):NaN,resolved=r.resolved_at?Date.parse(r.resolved_at):NaN;
    if(!Number.isFinite(created))continue;
    const sla=policy[r.priority]||policy.normal;
    const responseDeadline=created+sla.response*3600000,resolutionDeadline=created+sla.resolution*3600000;
    const hasFirst=Number.isFinite(first),hasResolved=r.status==='resolved'&&Number.isFinite(resolved);
    const responseEligible=hasFirst||nowMs>responseDeadline;
    const resolutionEligible=hasResolved||nowMs>resolutionDeadline;
    const responseBreached=responseEligible&&(hasFirst?first>responseDeadline:nowMs>responseDeadline);
    const resolutionBreached=resolutionEligible&&(hasResolved?resolved>resolutionDeadline:nowMs>resolutionDeadline);
    if(r.status==='resolved')totals.resolved++;else totals.open++;
    if(!hasResolved&&nowMs>resolutionDeadline)totals.overdue++;
    if(hasFirst){totals.responded++;respSum+=Math.max(0,first-created)/3600000;}
    if(hasResolved)resSum+=Math.max(0,resolved-created)/3600000;
    if(responseEligible){totals.responseEligible++;if(!responseBreached)totals.responseOnTime++;}
    if(resolutionEligible){totals.resolutionEligible++;if(!resolutionBreached)totals.resolutionOnTime++;}
    if(responseBreached)totals.responseBreached++;
    if(resolutionBreached)totals.resolutionBreached++;
    for(const field of Object.keys(breakdown)){
      const key=String(r[field]||'Não informado').trim().slice(0,80)||'Não informado';
      const entry=breakdown[field][key]||(breakdown[field][key]={name:key,total:0,resolved:0,late:0,responded:0,responseBreached:0,resolutionBreached:0});
      entry.total++;if(hasResolved)entry.resolved++;if(!hasResolved&&nowMs>resolutionDeadline)entry.late++;
      if(hasFirst)entry.responded++;if(responseBreached)entry.responseBreached++;if(resolutionBreached)entry.resolutionBreached++;
    }
  }
  totals.firstResponseHours=totals.responded?Math.round(respSum/totals.responded*10)/10:null;
  const resolvedWithTime=rows.filter(r=>r.status==='resolved'&&r.resolved_at&&Number.isFinite(Date.parse(r.resolved_at))).length;
  totals.resolutionHours=resolvedWithTime?Math.round(resSum/resolvedWithTime*10)/10:null;
  const sorted={};for(const [field,groups] of Object.entries(breakdown))sorted[field]=Object.values(groups).sort((a,b)=>b.total-a.total).slice(0,12);
  return {period,policy,totals,breakdown:sorted,generatedAt:now()};
}

function getTicket(id, user) {
  const r=db.prepare('SELECT h.*,u.username FROM help_requests h JOIN users u ON u.id=h.user_id WHERE h.id=?').get(id);
  return r && (user.role==='admin' || r.user_id===user.id) ? r : null;
}
function helpList(user) {
  const rows = user.role === 'admin'
    ? db.prepare("SELECT h.*,u.username FROM help_requests h JOIN users u ON u.id=h.user_id ORDER BY CASE WHEN h.status='resolved' THEN 1 ELSE 0 END,h.id DESC LIMIT 500").all()
    : db.prepare('SELECT h.*,u.username FROM help_requests h JOIN users u ON u.id=h.user_id WHERE h.user_id=? ORDER BY h.id DESC LIMIT 300').all(user.id);
  if (!rows.length) return rows;
  const ids=rows.map(r=>r.id);
  // Evita N+1 consultas; retorna mensagens apenas de chamados autorizados.
  const messages=db.prepare(`SELECT id,request_id,author,body,created_at FROM help_messages WHERE request_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids);
  const grouped=new Map();for(const m of messages){if(!grouped.has(m.request_id))grouped.set(m.request_id,[]);grouped.get(m.request_id).push(m);}
  for(const r of rows)r.messages=grouped.get(r.id)||[];
  return rows;
}
function queueHelpEmail(requestId) {
  db.prepare("INSERT OR IGNORE INTO email_outbox(request_id,status,next_attempt_at) VALUES(?,'pending',?)").run(requestId,now());
  // Agendamento em segundo plano: não bloqueia o cadastro do chamado.
  setImmediate(() => { processEmailQueue().catch(e => console.error('Falha na fila de e-mails:',e.message)); });
}
async function processEmailQueue() {
  if (emailProcessing || !db) return;
  const cfg = readEmailConfig();
  if (!cfg) return;
  emailProcessing = true;
  try {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { console.error('Notificações: instale a dependência com npm install (uma vez).'); return; }
    const transport = nodemailer.createTransport({host:cfg.host,port:cfg.port,secure:cfg.secure,auth:{user:cfg.user,pass:cfg.password},connectionTimeout:12000,greetingTimeout:12000,socketTimeout:20000});
    const pending = db.prepare(`SELECT o.id AS mail_id,o.attempts,h.id,h.item_type,h.item_code,h.description,h.created_at,u.username
      FROM email_outbox o JOIN help_requests h ON h.id=o.request_id JOIN users u ON u.id=h.user_id
      WHERE o.status='pending' AND o.next_attempt_at<=? ORDER BY o.id LIMIT 5`).all(now());
    for (const r of pending) {
      const subject = `[ETHOS PCP] Nova solicitação #${r.id} - ${r.item_code}`.replace(/[\r\n]/g,' ').slice(0,220);
      const textBody = `Nova solicitação de ajuda da Produção\n\nChamado: #${r.id}\nSolicitante: ${r.username}\nTipo de código: ${r.item_type==='ethos'?'ETHOS':'Cliente'}\nCódigo: ${r.item_code}\nData: ${r.created_at}\nStatus: Pendente\n\nDescrição:\n${r.description}\n\nAcesse o ETHOS na rede local para aprovar, responder ou solucionar a solicitação.`;
      try {
        await transport.sendMail({from:cfg.from,to:cfg.to,subject,text:textBody});
        db.prepare("UPDATE email_outbox SET status='sent',attempts=attempts+1,sent_at=?,last_error='' WHERE id=?").run(now(),r.mail_id);
        console.log('E-mail da solicitação #'+r.id+' enviado.');
      } catch (err) {
        const attempts=r.attempts+1;
        const waitMinutes=Math.min(60,Math.pow(2,Math.min(attempts-1,6)));
        const retry=new Date(Date.now()+waitMinutes*60000).toISOString();
        // Evita guardar credenciais ou detalhes potencialmente sensíveis do SMTP no banco.
        db.prepare("UPDATE email_outbox SET attempts=?,next_attempt_at=?,last_error='Falha no SMTP; nova tentativa agendada' WHERE id=?").run(attempts,retry,r.mail_id);
        console.error('Falha ao enviar solicitação #'+r.id+'. Nova tentativa em '+waitMinutes+' min. Código: '+String(err.code||'SMTP'));
      }
    }
    if (typeof transport.close==='function') transport.close();
  } finally { emailProcessing=false; }
}

function auditUser(actor, operation, target) {
  db.prepare('INSERT INTO user_audit(actor,operation,target,created_at) VALUES(?,?,?,?)').run(actor, operation, target, now());
}
function failRate(ip) {
  const prev = FAILED_LOGINS.get(ip);
  if (!prev || Date.now() - prev.start > 10 * 60 * 1000) return false;
  return prev.count >= 8;
}
function failedLogin(ip) {
  const old = FAILED_LOGINS.get(ip);
  const entry = !old || Date.now() - old.start > 10 * 60 * 1000 ? { count:0, start:Date.now() } : old;
  entry.count++;
  FAILED_LOGINS.set(ip, entry);
  if (FAILED_LOGINS.size > 1000) FAILED_LOGINS.clear();
}
async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;
    // O GitHub Pages só pode acessar endpoints explicitamente autorizados.
    // Não são usados cookies de terceiros: a API exige Bearer no modo Pages.
    const isPagesApi = route.startsWith('/api/') || route === '/logout';
    if (req.method === 'OPTIONS' && isPagesApi) {
      if (!pagesOriginAllowed(req)) return json(res,403,{error:'Origem não autorizada'});
      return send(res,204,'','text/plain; charset=utf-8',pagesCors(req));
    }
    if (isPagesApi && pagesOriginAllowed(req)) {
      for (const [k,v] of Object.entries(pagesCors(req))) res.setHeader(k,v);
    }
    if (isPagesApi && req.headers.origin && !originAllowed(req) && !pagesOriginAllowed(req))
      return json(res,403,{error:'Origem não autorizada'});
    if (req.method === 'GET' && route === '/pages-login') {
      if (!PAGES_URL) return json(res,404,{error:'Integração GitHub Pages desativada'});
      if (!hasUsers()) return redirect(res,'/setup');
      return sendPagesForm(res);
    }
    if (req.method === 'POST' && route === '/api/pages/exchange') {
      if (!pagesOriginAllowed(req)) return json(res,403,{error:'Origem não autorizada'});
      let payload; try { payload=JSON.parse(await readBody(req)); } catch { return json(res,400,{error:'JSON inválido'}); }
      const code = String(payload?.code || '');
      if (!/^[a-f0-9]{64}$/.test(code)) return json(res,400,{error:'Código inválido'});
      const key = hashToken(code), entry = PAGES_CODES.get(key);
      PAGES_CODES.delete(key); // Código de uso único mesmo quando inválido/expirado.
      if (!entry || entry.expires < Date.now()) return json(res,401,{error:'Código expirado. Entre novamente.'});
      const session = db.prepare(`SELECT u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND u.approval_status='approved'`).get(hashToken(entry.token),epoch());
      if (!session) return json(res,401,{error:'Sessão inválida'});
      return json(res,200,{token:entry.token,username:session.username,role:session.role,expires_in:SESSION_TTL});
    }
    if (isPagesApi && pagesOriginAllowed(req) && route !== '/api/pages/exchange' && !bearerToken(req))
      return json(res,401,{error:'Sessão online não encontrada'});
    if (req.method === 'GET' && route === '/favicon.ico') return send(res, 204, '');
    if (req.method === 'GET' && route === '/ethos-logo.png') return send(res, 200, fs.readFileSync(path.join(ROOT, 'ethos-logo.png')), 'image/png', { 'Cache-Control': 'public, max-age=86400' });
    if (req.method === 'GET' && route === '/setup') {
      if (hasUsers()) return redirect(res, '/login');
      if (!isLoopback(req)) return send(res, 403, page('Acesso restrito', '<p>Configure o primeiro usuário no próprio computador servidor: http://127.0.0.1:8765</p>'));
      return sendForm(res, 'setup');
    }
    if (req.method === 'GET' && route === '/login') return hasUsers() ? sendForm(res, 'login') : redirect(res, '/setup');
    if (req.method === 'GET' && route === '/cadastro') return hasUsers() ? sendForm(res, 'cadastro') : redirect(res, '/setup');
    if (req.method === 'POST') {
      // Para login e primeiro cadastro, o token duplo (formulário + cookie)
      // é a proteção principal; as rotas de API seguem validando a origem.
      const isForm = route === '/setup' || route === '/login' || route === '/cadastro' || route === '/pages-login';
      if (!isForm && !originAllowed(req)) return json(res, 403, { error:'Origem não autorizada' });
      const raw = await readBody(req);
      if (isForm && !formCsrfValid(req, raw)) {
        console.warn('Formulário sem token de segurança válido:', route);
        return route === '/pages-login' ? sendPagesForm(res,403,'A sessão do formulário expirou. Atualize a página e tente novamente.') : sendForm(res, route.slice(1), 403, 'A sessão do formulário expirou. Atualize a página e tente novamente.');
      }
      if (isForm && !originAllowed(req)) console.warn('Cabeçalho Origin divergente, formulário validado por token:', route);
      if (route === '/setup') {
        if (!isLoopback(req) || hasUsers()) return json(res, 403, { error:'Cadastro inicial não autorizado' });
        const p = new URLSearchParams(raw);
        const username = usernameNormalize(p.get('username'));
        const password = String(p.get('password') || '');
        if (!usernameValid(username)) return sendForm(res, 'setup', 400, 'Usuário: 3 a 48 caracteres (letras, números, ponto, hífen ou _).');
        if (password.length < 12) return sendForm(res, 'setup', 400, 'A senha precisa ter pelo menos 12 caracteres.');
        if (password !== p.get('confirm')) return sendForm(res, 'setup', 400, 'As senhas digitadas não coincidem.');
        const result = db.prepare("INSERT INTO users(username,password_hash,created_at,role) VALUES(?,?,?,'admin')").run(username, hashPassword(password), now());
        auditUser(username, 'create_admin', username);
        const token = createSession(Number(result.lastInsertRowid));
        return redirect(res, '/', { 'Set-Cookie':cookie(req, token) });
      }
      if (route === '/cadastro') {
        if (!hasUsers()) return redirect(res, '/setup');
        const ip = req.socket.remoteAddress || '?';
        const prev = SIGNUP_ATTEMPTS.get(ip);
        if (prev && Date.now() - prev.start < 30 * 60 * 1000 && prev.count >= 5) {
          return sendForm(res, 'cadastro', 429, 'Muitas solicitações. Aguarde 30 minutos e tente novamente.');
        }
        const p = new URLSearchParams(raw);
        const username = usernameNormalize(p.get('username'));
        const password = String(p.get('password') || '');
        if (!usernameValid(username)) return sendForm(res, 'cadastro', 400, 'Usuário: 3 a 48 caracteres (letras, números, ponto, hífen ou _).');
        if (password.length < 12 || password.length > 256) return sendForm(res, 'cadastro', 400, 'A senha deve ter entre 12 e 256 caracteres.');
        if (password !== p.get('confirm')) return sendForm(res, 'cadastro', 400, 'As senhas digitadas não coincidem.');
        if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return sendForm(res, 'cadastro', 409, 'Este nome de usuário já está em uso. Escolha outro.');
        const current = prev && Date.now() - prev.start < 30 * 60 * 1000 ? prev : { count:0, start:Date.now() };
        current.count++;
        SIGNUP_ATTEMPTS.set(ip, current);
        if (SIGNUP_ATTEMPTS.size > 1000) SIGNUP_ATTEMPTS.clear();
        db.prepare("INSERT INTO users(username,password_hash,created_at,active,role,approval_status) VALUES(?,?,?,0,'common','pending')").run(username, hashPassword(password), now());
        auditUser(username, 'request_access', username);
        return send(res, 200, page('Solicitação enviada', `<p>Cadastro solicitado com sucesso! Sua conta está <strong>aguardando aprovação do administrador</strong>.</p><p>Após a aprovação, entre com o usuário e a senha que você acabou de criar.</p><p><a href="/login">Voltar à tela de login</a></p>`));
      }
      if (route === '/login' || route === '/pages-login') {
        if (route === '/pages-login' && !PAGES_URL) return json(res,404,{error:'Integração desativada'});
        const pagesLogin = route === '/pages-login';
        const loginError = (status, message) => pagesLogin ? sendPagesForm(res,status,message) : sendForm(res,'login',status,message);
        const ip = req.socket.remoteAddress || '?';
        if (failRate(ip)) return loginError(429, 'Muitas tentativas. Aguarde 10 minutos antes de tentar novamente.');
        const p = new URLSearchParams(raw);
        const username = usernameNormalize(p.get('username'));
        const password = String(p.get('password') || '');
        const user = db.prepare("SELECT id,password_hash,role FROM users WHERE username=? AND active=1 AND approval_status='approved'").get(username);
        if (!user || !verifyPassword(password, user.password_hash)) {
          failedLogin(ip);
          return loginError(401, 'Usuário ou senha incorretos.');
        }
        FAILED_LOGINS.delete(ip);
        const token = createSession(user.id);
        auditUser(username, 'login', pagesLogin ? 'pages_login_success' : 'login_success');
        if (pagesLogin) return redirect(res, PAGES_URL.href + '#ethos_code=' + pagesCode(token));
        return redirect(res, user.role === 'common' ? '/ajuda' : '/',  { 'Set-Cookie':cookie(req, token) });
      }
      const user = auth(req);
      if (!user) return json(res, 401, { error:'Sessão expirada. Entre novamente.' });
      if (user.role === 'common') auditUser(user.username, 'http_post', route);
      if (route === '/logout') {
        const token = bearerToken(req) || cookieToken(req);
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
        auditUser(user.username, 'logout', 'session');
        return send(res, 200, '', 'text/plain; charset=utf-8', { 'Set-Cookie':cookie(req, '', 0) });
      }
      if (route === '/api/notifications') {
        let p;try{p=JSON.parse(raw)}catch{return json(res,400,{error:'JSON inválido'})}
        if(p.action!=='read')return json(res,400,{error:'Ação inválida'});
        const id=Number(p.id);
        if(!Number.isSafeInteger(id)||id<1)return json(res,400,{error:'ID inválido'});
        db.prepare('UPDATE internal_notifications SET read_at=? WHERE id=? AND user_id=?').run(now(),id,user.id);
        return json(res,200,{ok:true});
      }
      if (route === '/api/help') {
        let p; try { p=JSON.parse(raw); } catch { return json(res,400,{error:'JSON inválido'}); }
        if(p.action==='create') {
          if(user.role!=='common') return json(res,403,{error:'Apenas usuários comuns abrem solicitações nesta área.'});
          const type=String(p.itemType||''),code=String(p.itemCode||'').trim(),desc=String(p.description||'').trim();
          const category=String(p.category||'apontamento'),priority=String(p.priority||'normal'),sector=String(p.sector||'').trim();
          if(!['cliente','ethos'].includes(type)||code.length<2||code.length>100||desc.length<10||desc.length>3000||!CATEGORIES.includes(category)||!PRIORITIES.includes(priority)||sector.length>80)
            return json(res,400,{error:'Confira código, categoria, prioridade, setor e descrição da solicitação.'});
          const today=db.prepare('SELECT COUNT(*) AS n FROM help_requests WHERE user_id=? AND created_at>=?').get(user.id,new Date(Date.now()-86400000).toISOString()).n;
          if(today>=30)return json(res,429,{error:'Limite de 30 solicitações em 24 horas.'});
          const stamp=now();
          const result=db.prepare("INSERT INTO help_requests(user_id,item_type,item_code,description,status,category,priority,sector,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?,?,?)")
            .run(user.id,type,code,desc,category,priority,sector,stamp,stamp);
          const id=Number(result.lastInsertRowid);
          db.prepare("INSERT INTO help_events(request_id,actor,action,status,created_at) VALUES(?,?,'created','pending',?)").run(id,user.username,stamp);
          auditUser(user.username,'help_create','#'+id+' '+type+': '+code+' / '+category+' / '+priority);
          notifyAdmins(id,`Nova solicitação #${id} de ${user.username}: ${code} (${priority})`);
          queueHelpEmail(id);
          return json(res,201,{ok:true,id});
        }
        if(p.action==='message') {
          const id=Number(p.id),body=String(p.body||'').trim();
          if(user.role==='intermediate')return json(res,403,{error:'Sem permissão'});
          if(!Number.isSafeInteger(id)||id<1||body.length<2||body.length>3000)return json(res,400,{error:'Mensagem deve ter de 2 a 3000 caracteres'});
          const ticket=getTicket(id,user);
          if(!ticket)return json(res,404,{error:'Solicitação não encontrada'});
          if(ticket.status==='resolved' && user.role==='common')return json(res,409,{error:'Chamado concluído. Solicite reabertura ao administrador.'});
          const recent=db.prepare('SELECT COUNT(*) AS n FROM help_messages WHERE user_id=? AND created_at>=?').get(user.id,new Date(Date.now()-3600000).toISOString()).n;
          if(recent>=50)return json(res,429,{error:'Limite de mensagens por hora atingido'});
          const stamp=now();
          db.prepare('INSERT INTO help_messages(request_id,user_id,author,body,created_at) VALUES(?,?,?,?,?)').run(id,user.id,user.username,body,stamp);
          if(user.role==='admin') db.prepare('UPDATE help_requests SET first_response_at=COALESCE(first_response_at,?) WHERE id=?').run(stamp,id);
          db.prepare('UPDATE help_requests SET updated_at=? WHERE id=?').run(stamp,id);
          db.prepare('INSERT INTO help_events(request_id,actor,action,status,reply,created_at) VALUES(?,?,?,?,?,?)').run(id,user.username,'message',ticket.status,body,stamp);
          auditUser(user.username,'help_message','#'+id);
          if(user.role==='admin')notifyUser(ticket.user_id,id,`Nova resposta do PCP no chamado #${id}`);
          else notifyAdmins(id,`Nova mensagem de ${user.username} no chamado #${id}`);
          return json(res,201,{ok:true});
        }
        if(p.action==='update') {
          if(user.role!=='admin')return json(res,403,{error:'Apenas administradores atualizam solicitações'});
          const id=Number(p.id),status=String(p.status||''),reply=String(p.reply||'').trim();
          const priority=String(p.priority||'normal'),assigned=String(p.assignedTo||'').trim();
          const due=String(p.dueAt||'').trim();
          if(!Number.isSafeInteger(id)||id<1||!HELP_STATUSES.includes(status)||reply.length>3000||!PRIORITIES.includes(priority)||assigned.length>80|| (due&&!/^\d{4}-\d{2}-\d{2}$/.test(due)))
            return json(res,400,{error:'Dados inválidos'});
          if(due && !Number.isFinite(Date.parse(due+'T12:00:00Z')))return json(res,400,{error:'Prazo inválido'});
          if(status==='resolved' && reply.length<3)return json(res,400,{error:'Informe uma orientação para concluir a solicitação'});
          const previous=getTicket(id,user);
          if(!previous)return json(res,404,{error:'Solicitação não encontrada'});
          const stamp=now();
          if(reply.length>0 && (!previous.admin_reply || previous.admin_reply!==reply))
            db.prepare('UPDATE help_requests SET first_response_at=COALESCE(first_response_at,?) WHERE id=?').run(stamp,id);
          db.prepare('UPDATE help_requests SET status=?,admin_reply=?,priority=?,assigned_to=?,due_at=?,resolved_at=?,updated_at=?,handled_by=? WHERE id=?')
            .run(status,reply,priority,assigned,due||null,status==='resolved'?(previous.resolved_at||stamp):null,stamp,user.username,id);
          db.prepare('INSERT INTO help_events(request_id,actor,action,status,reply,created_at) VALUES(?,?,?,?,?,?)').run(id,user.username,'status_changed',status,reply,stamp);
          auditUser(user.username,'help_update','#'+id+' '+previous.status+' -> '+status+' / '+priority+' / '+assigned);
          if(previous.status!==status||previous.admin_reply!==reply||previous.due_at!==(due||null))
            notifyUser(previous.user_id,id,`Chamado #${id} atualizado pelo PCP: ${status==='resolved'?'Solucionado':status==='approved'?'Aprovado':'Pendente'}`);
          return json(res,200,{ok:true});
        }
        return json(res,400,{error:'Ação desconhecida'});
      }
      if (route === '/api/sla/settings') {
        if(user.role!=='admin')return json(res,403,{error:'Apenas administradores podem alterar o SLA'});
        let p;try{p=JSON.parse(raw)}catch{return json(res,400,{error:'JSON inválido'})}
        if(!validateSlaPolicy(p.policy))return json(res,400,{error:'Informe prazos inteiros de 1 a 720 horas; solução deve ser igual ou superior à resposta.'});
        db.prepare('UPDATE sla_settings SET policy_json=?,updated_at=?,updated_by=? WHERE id=1').run(JSON.stringify(p.policy),now(),user.username);
        auditUser(user.username,'sla_policy_update',JSON.stringify(p.policy));
        return json(res,200,{ok:true,policy:p.policy});
      }
      if (route === '/api/state') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error:'Use application/json' });
        let p;
        try { p = JSON.parse(raw); } catch { return json(res, 400, { error:'JSON inválido' }); }
        try {
          const result = saveState(p, user.username, user.role);
          if (result.forbidden) { auditUser(user.username, 'denied_state_write', 'api/state'); return json(res, 403, { error:'Seu perfil não permite esta alteração.' }); }
          if (result.conflict !== undefined) return json(res, 409, { error:'Outro usuário atualizou a base. Recarregue a página para obter a versão mais recente.', revision:result.conflict });
          return json(res, 200, result);
        } catch (e) {
          if (['JSON inválido','Revisão obrigatória','Base deve ser uma lista ou null','Registros manuais/ações inválidos','Base excede o limite configurado','Linha inválida na base','Ação inválida'].includes(e.message)) return json(res, 400, { error:e.message });
          console.error('Falha de gravação:', e);
          return json(res, 500, { error:'Falha ao gravar no banco. Contate o administrador.' });
        }
      }
      if (route === '/api/users') {
        if (user.role !== 'admin') return json(res, 403, { error:'Apenas administradores podem gerenciar usuários' });
        let p; try { p = JSON.parse(raw); } catch { return json(res, 400, { error:'JSON inválido' }); }
        const username = usernameNormalize(p.username);
        if (p.action === 'create') {
          if (!usernameValid(username) || typeof p.password !== 'string' || p.password.length < 12) return json(res, 400, { error:'Informe usuário válido e senha com pelo menos 12 caracteres.' });
          if (!['admin','intermediate','common'].includes(p.role)) return json(res, 400, { error:'Perfil inválido' });
          if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return json(res, 409, { error:'Usuário já existe' });
          db.prepare('INSERT INTO users(username,password_hash,created_at,role) VALUES(?,?,?,?)').run(username, hashPassword(p.password), now(), p.role);
          auditUser(user.username, 'create_user', username);
          return json(res, 200, { ok:true });
        }
        if (p.action === 'set_role') {
          if (!['admin','intermediate','common'].includes(p.role)) return json(res,400,{error:'Perfil inválido'});
          const target=db.prepare('SELECT id,role,active FROM users WHERE username=?').get(username);
          if(!target)return json(res,404,{error:'Usuário não encontrado'});
          if(target.id===user.id && p.role!=='admin')return json(res,400,{error:'Você não pode remover seu próprio perfil de administrador'});
          if(target.role==='admin' && p.role!=='admin' && target.active){
            const n=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n;
            if(n<=1)return json(res,400,{error:'Não é possível remover o último administrador'});
          }
          db.prepare('UPDATE users SET role=? WHERE id=?').run(p.role,target.id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          auditUser(user.username,'change_role',username+': '+target.role+' -> '+p.role);
          return json(res,200,{ok:true});
        }
        if (p.action === 'approve') {
          const target = db.prepare('SELECT id,approval_status FROM users WHERE username=?').get(username);
          if (!target) return json(res, 404, { error:'Usuário não encontrado' });
          if (target.approval_status !== 'pending') return json(res, 400, { error:'Este cadastro não está pendente' });
          if (!['admin','intermediate','common'].includes(p.role || 'common')) return json(res,400,{error:'Perfil inválido'});
          db.prepare("UPDATE users SET active=1,approval_status='approved',role=? WHERE id=?").run(p.role || 'common',target.id);
          auditUser(user.username, 'approve_user', username);
          return json(res, 200, { ok:true });
        }
        if (p.action === 'reject') {
          const target = db.prepare('SELECT id,approval_status FROM users WHERE username=?').get(username);
          if (!target) return json(res, 404, { error:'Usuário não encontrado' });
          if (target.approval_status !== 'pending') return json(res, 400, { error:'Somente solicitações pendentes podem ser recusadas' });
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          db.prepare('DELETE FROM users WHERE id=?').run(target.id);
          auditUser(user.username, 'reject_user', username);
          return json(res, 200, { ok:true });
        }
        if (p.action === 'reset_password') {
          if (typeof p.password !== 'string' || p.password.length < 12) return json(res, 400, { error:'A nova senha precisa ter pelo menos 12 caracteres' });
          const target = db.prepare('SELECT id FROM users WHERE username=?').get(username);
          if (!target) return json(res, 404, { error:'Usuário não encontrado' });
          db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(p.password), target.id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          auditUser(user.username, 'reset_password', username);
          return json(res, 200, { ok:true });
        }
        if (p.action === 'set_active') {
          const target = db.prepare('SELECT id,role,active FROM users WHERE username=?').get(username);
          if (!target) return json(res, 404, { error:'Usuário não encontrado' });
          if (target.id === user.id && !p.active) return json(res, 400, { error:'Não é possível desativar sua própria conta' });
          if (!p.active && target.role === 'admin') {
            const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n;
            if (admins <= 1) return json(res, 400, { error:'Não é possível desativar o último administrador' });
          }
          db.prepare("UPDATE users SET active=?,approval_status=CASE WHEN ?=1 THEN 'approved' ELSE approval_status END WHERE id=?").run(p.active ? 1 : 0, p.active ? 1 : 0, target.id);
          if (!p.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          auditUser(user.username, p.active ? 'activate_user' : 'deactivate_user', username);
          return json(res, 200, { ok:true });
        }
        return json(res, 400, { error:'Ação desconhecida' });
      }
      return json(res, 404, { error:'Rota inexistente' });
    }
    if (req.method !== 'GET') return json(res, 405, { error:'Método não permitido' });
    if (!hasUsers()) return isLoopback(req) ? redirect(res, '/setup') : send(res, 503, page('Configuração pendente', '<p>Crie o primeiro administrador no computador servidor antes de usar pela rede.</p>'));
    const user = auth(req);
    if (user?.role === 'common' && req.headers['x-ethos-auto-refresh'] !== '1') auditUser(user.username, 'http_get', route);
    if (!user) return route === '/' || route === '/index.html' || route === '/admin' || route === '/ajuda' ? redirect(res, '/login') : json(res, 401, { error:'Sessão expirada' });
    if (route === '/api/pages/view') {
      if (!pagesOriginAllowed(req) || !bearerToken(req)) return json(res,403,{error:'Origem não autorizada'});
      const name = url.searchParams.get('name');
      if (!['index','admin','ajuda'].includes(name)) return json(res,400,{error:'Página inválida'});
      if (name === 'admin' && user.role !== 'admin') return json(res,403,{error:'Apenas administradores'});
      if (name === 'ajuda' && user.role === 'intermediate') return json(res,403,{error:'Sem permissão'});
      if (name === 'index' && user.role === 'common') return json(res,403,{error:'Sem permissão'});
      if (name === 'admin') return send(res,200,adminPage());
      if (name === 'ajuda') return send(res,200,fs.readFileSync(path.join(ROOT,'ajuda.html'),'utf8')
        .replace('__ETHOS_HELP_ROLE__',user.role).replace('__ETHOS_HELP_USER__',escapeHtml(user.username)));
      const state = JSON.stringify(getState()).replace(/[<>&\u2028\u2029]/g, c => ({'<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'}[c]));
      const html = fs.readFileSync(path.join(ROOT,'index.html'),'utf8')
        .replace('"__ETHOS_DB_BOOTSTRAP_JSON__"',state).replace('"__ETHOS_DB_ROLE__"',JSON.stringify(user.role));
      return send(res,200,html);
    }
    if (route === '/api/notifications') {
      if(user.role==='intermediate')return json(res,403,{error:'Sem permissão'});
      const notifications=db.prepare('SELECT id,request_id,message,created_at,read_at FROM internal_notifications WHERE user_id=? ORDER BY id DESC LIMIT 80').all(user.id);
      const unread=db.prepare('SELECT COUNT(*) AS n FROM internal_notifications WHERE user_id=? AND read_at IS NULL').get(user.id).n;
      return json(res,200,{notifications,unread});
    }
    if (route === '/api/admin/firebase-status') {
      if (user.role !== 'admin') return json(res,403,{error:'Apenas administradores'});
      return json(res,200,firebaseBridge.status());
    }
    if (route === '/api/sla/metrics') {
      if(user.role!=='admin')return json(res,403,{error:'Apenas administradores podem consultar indicadores de SLA'});
      const period=String(url.searchParams.get('period')||'30');
      if(!['7','30','90','all'].includes(period))return json(res,400,{error:'Período inválido'});
      return json(res,200,buildSlaMetrics(period));
    }
    if (route === '/api/help') {
      if(user.role==='intermediate')return json(res,403,{error:'Sem permissão'});
      const rows=helpList(user);
      if(user.role==='common' && req.headers['x-ethos-auto-refresh'] !== '1')auditUser(user.username,'help_list','own_requests');
      return json(res,200,{requests:rows});
    }
    if (route === '/api/admin-audit') {
      if(user.role!=='admin')return json(res,403,{error:'Apenas administradores'});
      const events=db.prepare("SELECT a.id,a.actor,a.operation,a.target,a.created_at,u.role FROM user_audit a LEFT JOIN users u ON u.username=a.actor ORDER BY a.id DESC LIMIT 1000").all();
      return json(res,200,{events});
    }
    if (route === '/api/state') {
      if(user.role==='common'){auditUser(user.username,'denied_state_read','api/state');return json(res,403,{error:'Acesso não autorizado'});}
      return json(res,200,getState());
    }
    if (route === '/api/audit' && user.role!=='admin') return json(res,403,{error:'Apenas administradores'});
    if (route === '/api/audit') return json(res, 200, { events:db.prepare('SELECT revision,username,created_at,base_count,manual_count,actions_count FROM audit ORDER BY id DESC LIMIT 100').all() });
    if (route === '/api/health') return json(res, 200, { ok:true, database:'sqlite', user:user.username, role:user.role });
    if (route === '/api/users') {
      if (user.role !== 'admin') return json(res, 403, { error:'Apenas administradores' });
      return json(res, 200, { users:db.prepare("SELECT username,role,active,approval_status,created_at FROM users ORDER BY CASE WHEN approval_status='pending' THEN 0 ELSE 1 END,username").all() });
    }
    if (route === '/ajuda') {
      if(user.role==='intermediate')return send(res,403,page('Acesso negado','<p>Seu perfil não permite acessar solicitações.</p><a href="/">Voltar</a>'));
      if(user.role==='common')auditUser(user.username,'help_page_view','/ajuda');
      const html=fs.readFileSync(path.join(ROOT,'ajuda.html'),'utf8').replace('__ETHOS_HELP_ROLE__',user.role).replace('__ETHOS_HELP_USER__',escapeHtml(user.username));
      return send(res,200,html);
    }
    if (route === '/admin') {
      if (user.role !== 'admin') return send(res, 403, page('Acesso negado', '<p>Somente administradores podem gerenciar usuários.</p><a href="/">Voltar</a>'));
      return send(res, 200, adminPage());
    }
    if (route === '/' || route === '/index.html') {
      if(user.role==='common'){auditUser(user.username,'denied_dashboard','/');return redirect(res,'/ajuda');}
      const state = JSON.stringify(getState()).replace(/[<>&\u2028\u2029]/g, c => ({ '<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029' }[c]));
      const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('"__ETHOS_DB_BOOTSTRAP_JSON__"', state).replace('"__ETHOS_DB_ROLE__"', JSON.stringify(user.role));
      return send(res, 200, page);
    }
    return json(res, 404, { error:'Rota inexistente' });
  } catch (err) {
    console.error('Erro HTTP:', err);
    if (!res.headersSent) return json(res, err.status || 500, { error:err.status === 413 ? err.message : 'Erro interno do servidor' });
    res.end();
  }
}
function adminPage() {
  return fs.readFileSync(path.join(ROOT,'admin.html'),'utf8');
}

async function backupDb() {
  const folder = path.join(ROOT, 'backups');
  fs.mkdirSync(folder, { recursive:true });
  const filename = 'ethos_' + now().replace(/[-:]/g,'').replace(/\..+/, '').replace('T','_') + '.sqlite3';
  const target = path.join(folder, filename);
  await backup(db, target);
  console.log('Backup criado:', target);
  return target;
}
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'serve';
  if (cmd === '--help' || cmd === 'help') {
    console.log('Uso: node server.js serve [--host 127.0.0.1] [--port 8765] | backup | firebase-seed'); return;
  }
  init();
  if (cmd === 'backup') { await backupDb(); db.close(); return; }
  if (cmd === 'firebase-seed') {
    const n=firebaseSync.seedExisting(db);
    console.log('Registros marcados para sincronização: '+n+'. Nenhum dado enviado neste comando.');
    db.close(); return;
  }
  if (cmd !== 'serve') throw Error('Comando inválido: '+cmd);
  firebaseBridge=firebaseSync.createBridge(db);
  if (firebaseBridge.status().enabled) {
    console.log('Firebase: sincronização de saída habilitada.');
    setInterval(()=>firebaseBridge.flush().catch(e=>console.error('Firebase:',e.message)),15000).unref();
    setImmediate(()=>firebaseBridge.flush().catch(e=>console.error('Firebase:',e.message)));
  } else console.log('Firebase: desabilitado (SQLite permanece ativo).');
  const opt = key => { const i = args.indexOf(key); return i >= 0 ? args[i+1] : null; };
  const host = opt('--host') || process.env.ETHOS_HOST || '127.0.0.1';
  const port = Number(opt('--port') || process.env.ETHOS_PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Porta inválida');
  setInterval(() => { processEmailQueue().catch(e => console.error('Fila de e-mails:',e.message)); }, 30000).unref();
  setImmediate(() => { processEmailQueue().catch(e => console.error('Fila de e-mails:',e.message)); });
  const server = http.createServer(handler);
  server.listen(port, host, () => {
    console.log('\n==========================================');
    console.log(' ETHOS Industrial | Node.js + SQLite');
    console.log('==========================================');
    console.log('Acesso local: http://127.0.0.1:'+port);
    console.log('Banco de dados: '+DB_PATH);
    if (!hasUsers()) console.log('PRIMEIRO ACESSO: abra o link acima e crie o administrador.');
    if (host === '0.0.0.0') console.log('REDE LOCAL ATIVA: configure firewall e NÃO exponha esta porta na internet.');
    if (PAGES_URL) console.log('GitHub Pages habilitado: '+PAGES_URL.href+' (API exige HTTPS externo e proxy reverso).');
    console.log('Mantenha esta janela aberta enquanto estiver usando o sistema.\n');
  });
  server.on('error', err => { console.error('Não foi possível iniciar o servidor:', err.message); process.exitCode = 1; });
  process.on('SIGINT', () => { server.close(); db.close(); process.exit(0); });
}
main().catch(err => { console.error('Falha ao iniciar:', err.message); process.exitCode = 1; });
