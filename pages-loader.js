(async function () {
  'use strict';
  const root = document.getElementById('status');
  const page = document.documentElement.dataset.ethosPage || 'index';
  const cfg = window.ETHOS_PAGES_CONFIG || {};
  const api = String(cfg.apiBase || '').replace(/\/+$/, '');
  const valid = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(api);
  function show(message) { root.textContent = message; }
  if (!valid || api.includes('seu-dominio.com')) {
    show('Configure a URL HTTPS real do servidor em pages-config.js antes de publicar.');
    return;
  }
  const key = 'ethos-pages-session:' + api;
  const loginUrl = api + '/pages-login';
  function goLogin() { sessionStorage.removeItem(key); location.replace(loginUrl); }
  let session;
  try { session = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { session = null; }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = fragment.get('ethos_code');
  if (code) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const r = await fetch(api + '/api/pages/exchange', {
        method: 'POST', mode:'cors', credentials:'omit', cache:'no-store',
        headers: { 'Content-Type':'application/json' }, body: JSON.stringify({code})
      });
      if (!r.ok) throw Error((await r.json()).error || 'Não foi possível autenticar');
      session = await r.json();
      sessionStorage.setItem(key, JSON.stringify(session));
    } catch (e) {
      show('Não foi possível concluir o login: ' + e.message + '. Redirecionando…');
      location.replace(loginUrl); return;
    }
  }
  if (!session || !/^[a-f0-9]{64}$/.test(String(session.token || ''))) { goLogin(); return; }
  if (page === 'index' && session.role === 'common') { location.replace('ajuda.html'); return; }
  if (page === 'admin' && session.role !== 'admin') { location.replace(session.role === 'common' ? 'ajuda.html' : 'index.html'); return; }
  if (page === 'ajuda' && session.role === 'intermediate') { location.replace('index.html'); return; }
  show('Carregando ambiente seguro ETHOS…');
  try {
    const r = await fetch(api + '/api/pages/view?name=' + encodeURIComponent(page), {
      mode:'cors', credentials:'omit', cache:'no-store',
      headers: { Authorization:'Bearer ' + session.token }
    });
    if (r.status === 401) { goLogin(); return; }
    if (!r.ok) throw Error('Servidor retornou HTTP ' + r.status);
    let html = await r.text();
    // A interface existente é preservada, mas os caminhos internos apontam
    // para as páginas estáticas e a API permanece no servidor Node.js.
    html = html.replace(/href="\/"/g,'href="index.html"')
      .replace(/href="\/admin"/g,'href="admin.html"')
      .replace(/href="\/ajuda"/g,'href="ajuda.html"')
      .replace(/src="\/ethos-logo.png"/g,'src="ethos-logo.png"')
      .replace(/window\.open\('\/admin'/g,"window.open('admin.html'")
      .replace(/window\.open\('\/ajuda'/g,"window.open('ajuda.html'")
      .replace(/location\.href='\/login'/g,'location.href=window.ETHOS_PAGES_LOGIN_URL')
      .replace(/location\.href='\/ajuda'/g,"location.href='ajuda.html'")
      .replace(/location\.href='\/'/g,"location.href='index.html'");
    // O bridge deve carregar ANTES de qualquer script original do dashboard.
    html = html.replace(/<head(\s[^>]*)?>/i, match => match + '<script src="ethos-pages-bridge.js"></script>');
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    show('Falha ao conectar ao servidor ETHOS: ' + e.message + '. Verifique HTTPS, CORS e a conexão do servidor.');
  }
})();
