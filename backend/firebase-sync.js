'use strict';
/** ETHOS Firebase bridge: SQLite is authoritative; Firestore is an outbound mirror.
 * Credentials never leave the server; no passwords, sessions or user table are copied.
 */
const crypto = require('node:crypto');
const COLLECTIONS = {
  help_requests: 'help_requests',
  help_events: 'help_events',
  help_messages: 'help_messages',
  internal_notifications: 'notifications'
};
const TABLES = Object.keys(COLLECTIONS);
const stamp = () => new Date().toISOString();
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
function install(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS firebase_sync_meta(
    key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS firebase_sync_outbox(
    entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, sent_revision INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
    last_error TEXT NOT NULL DEFAULT '', synced_at TEXT,
    PRIMARY KEY(entity,entity_id));
    CREATE INDEX IF NOT EXISTS idx_firebase_outbox_pending ON firebase_sync_outbox(next_attempt_at);`);
  db.prepare('INSERT OR IGNORE INTO firebase_sync_meta(key,value) VALUES(?,?)')
    .run('instance_id', crypto.randomUUID());
  for (const table of TABLES) {
    // Triggers track inserts, updates, and deletions, including writes outside the HTTP API.
    for (const [event, row] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']]) {
      const trigger = `ethos_firebase_${table}_${event.toLowerCase()}`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${q(trigger)} AFTER ${event} ON ${q(table)} BEGIN
        INSERT INTO firebase_sync_outbox(entity,entity_id,revision,next_attempt_at)
        VALUES('${table}',${row}.id,1,'1970-01-01T00:00:00.000Z')
        ON CONFLICT(entity,entity_id) DO UPDATE SET
          revision=revision+1, attempts=0,
          next_attempt_at='1970-01-01T00:00:00.000Z', last_error='';
      END;`);
    }
  }
}
function seedExisting(db) {
  for (const table of TABLES) {
    db.exec(`INSERT INTO firebase_sync_outbox(entity,entity_id,revision,next_attempt_at)
      SELECT '${table}',id,1,'1970-01-01T00:00:00.000Z' FROM ${q(table)} WHERE 1
      ON CONFLICT(entity,entity_id) DO UPDATE SET revision=revision+1,attempts=0,
        next_attempt_at='1970-01-01T00:00:00.000Z',last_error='';`);
  }
  return db.prepare('SELECT COUNT(*) AS n FROM firebase_sync_outbox WHERE revision>sent_revision').get().n;
}
function publicRecord(db, entity, id) {
  if (!TABLES.includes(entity)) throw Error('Entidade inválida');
  const r = db.prepare(`SELECT * FROM ${q(entity)} WHERE id=?`).get(id);
  if (!r) return null;
  // Whitelist ensures no future credential fields are accidentally uploaded.
  const fields = {
    help_requests: ['id','user_id','item_type','item_code','description','status','admin_reply','created_at','updated_at','handled_by','category','priority','sector','assigned_to','due_at','resolved_at','first_response_at'],
    help_events: ['id','request_id','actor','action','status','reply','created_at'],
    help_messages: ['id','request_id','user_id','author','body','created_at'],
    internal_notifications: ['id','user_id','request_id','message','created_at','read_at']
  }[entity];
  const out = { id: r.id };
  for (const f of fields) if (Object.hasOwn(r,f)) out[f] = r[f];
  return out;
}
function createBridge(db, opts = {}) {
  const enabled = opts.enabled ?? process.env.ETHOS_FIREBASE_SYNC === '1';
  const namespace = db.prepare("SELECT value FROM firebase_sync_meta WHERE key='instance_id'").get().value;
  const state = { enabled, connected:false, last_success:null, last_error:'', running:false };
  let firestore = opts.firestore || null;
  async function connect() {
    if (!enabled) return false;
    if (firestore) { state.connected=true; return true; }
    try {
      const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
      const { getFirestore } = require('firebase-admin/firestore');
      const app = getApps().find(a=>a.name==='ethos-firestore') || initializeApp({credential:applicationDefault()},'ethos-firestore');
      firestore = getFirestore(app);
      state.connected=true;
      state.last_error='';
      return true;
    } catch(e) {
      state.connected=false;
      state.last_error=String(e.message).slice(0,250);
      return false;
    }
  }
  async function flush(limit=30) {
    if (!enabled || state.running) return 0;
    state.running=true;
    let sent=0;
    try {
      if (!await connect()) return 0;
      const rows=db.prepare(`SELECT * FROM firebase_sync_outbox WHERE revision>sent_revision AND next_attempt_at<=?
        ORDER BY next_attempt_at,entity,entity_id LIMIT ?`).all(stamp(),Math.max(1,Math.min(100,limit)));
      for (const row of rows) {
        try {
          const data=publicRecord(db,row.entity,row.entity_id);
          const doc=firestore.collection('ethos_instances').doc(namespace)
            .collection(COLLECTIONS[row.entity]).doc(String(row.entity_id));
          if (data) await doc.set(data); else await doc.delete();
          db.prepare(`UPDATE firebase_sync_outbox SET sent_revision=?,attempts=0,last_error='',synced_at=?
            WHERE entity=? AND entity_id=? AND revision=?`).run(row.revision,stamp(),row.entity,row.entity_id,row.revision);
          state.last_success=stamp();state.last_error='';state.connected=true;sent++;
        } catch(e) {
          state.connected=false;
          state.last_error=String(e.message).slice(0,250);
          const retrySeconds=Math.min(900,Math.pow(2,Math.min(9,row.attempts+1))*5);
          db.prepare(`UPDATE firebase_sync_outbox SET attempts=attempts+1,last_error=?,next_attempt_at=?
            WHERE entity=? AND entity_id=? AND revision=?`)
            .run(state.last_error,new Date(Date.now()+retrySeconds*1000).toISOString(),row.entity,row.entity_id,row.revision);
          // Stop on cloud outage to avoid flooding requests.
          break;
        }
      }
    } finally { state.running=false; }
    return sent;
  }
  function status() {
    const pending=db.prepare('SELECT COUNT(*) AS n FROM firebase_sync_outbox WHERE revision>sent_revision').get().n;
    const failed=db.prepare("SELECT COUNT(*) AS n FROM firebase_sync_outbox WHERE revision>sent_revision AND attempts>0").get().n;
    return {...state, running:state.running, instance_id:namespace, pending, failed};
  }
  return { connect,flush,status,seed:()=>seedExisting(db) };
}
module.exports = { install,seedExisting,publicRecord,createBridge };
