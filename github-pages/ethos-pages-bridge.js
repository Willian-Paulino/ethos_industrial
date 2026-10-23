(function () {
  'use strict';
  const api = String(window.ETHOS_PAGES_CONFIG?.apiBase || '').replace(/\/+$/,'');
  const key = 'ethos-pages-session:' + api;
  let session;
  try { session = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { session = null; }
  window.ETHOS_PAGES_LOGIN_URL = api + '/pages-login';
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url !== 'string' || !(url.startsWith('/api/') || url === '/logout')) {
      return originalFetch(input, init);
    }
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', 'Bearer ' + String(session?.token || ''));
    const r = await originalFetch(api + url, {...init,headers,mode:'cors',credentials:'omit',cache:'no-store'});
    if (url === '/logout') sessionStorage.removeItem(key);
    if (r.status === 401) {
      sessionStorage.removeItem(key);
      location.replace(window.ETHOS_PAGES_LOGIN_URL);
    }
    return r;
  };
})();
