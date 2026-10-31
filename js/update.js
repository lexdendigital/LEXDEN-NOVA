'use strict';

// ---- Auto-update ----
// The service worker serves fresh files (see sw.js). This part makes an
// ALREADY-OPEN page (and an installed PWA left running in the background) notice
// a new deploy by itself and reload onto it — without interrupting someone who is
// typing, paying or signing in; in that case it waits until they are done.
let __reloading = false;
function safeToReloadNow(){
  const h = location.hash || '';
  if(/^#(admin|checkout|pay|signup|login)/.test(h)) return false;
  // Never reload under a signed-in person: a reload re-checks the session over the network and,
  // on a slow connection, briefly shows the signed-out view, which reads as "I was logged out".
  // They get the "update available" banner and refresh when they choose.
  if(window.__fbShopper || window.__fbAdminEmail) return false;
  const ae = document.activeElement;
  if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false;
  if(document.querySelector('.modal-overlay, .modal, #installStepsModal')) return false;
  return true;
}
function reloadForUpdate(){
  if(__reloading) return;
  // Loop guard: at most one automatic reload per 60 seconds.
  const last = Number(sessionStorage.getItem('ln_auto_reload')||0);
  if(Date.now() - last < 60000) return;
  if(!safeToReloadNow()){ appState.updateAvailable = true; try{ render(); }catch(e){} return; }
  __reloading = true;
  try{ sessionStorage.setItem('ln_auto_reload', String(Date.now())); }catch(e){}
  location.reload();
}
// Fingerprint of the app files as served right now (ETag / Last-Modified / size).
async function appFingerprint(){
  // Fingerprint exactly the files THIS page was built from (works for the storefront,
  // admin/ and creator/ alike): the page itself, its stylesheet(s) and its local scripts.
  const urls = [location.pathname];
  document.querySelectorAll('script[src], link[rel="stylesheet"]').forEach(el=>{
    const u = new URL(el.getAttribute('src') || el.getAttribute('href'), location.href);
    if(u.origin === location.origin) urls.push(u.pathname);
  });
  const parts = await Promise.all(urls.map(f =>
    fetch(f, { method:'HEAD', cache:'no-store' })
      .then(r => r.ok ? (r.headers.get('etag')||r.headers.get('last-modified')||r.headers.get('content-length')||'') : '')
      .catch(() => '')));
  return parts.join('|');
}
let __knownFingerprint = null;
async function checkForNewVersion(){
  if(document.hidden || !navigator.onLine) return;
  try{
    if(window.__swRegistration) window.__swRegistration.update().catch(()=>{});
    const fp = await appFingerprint();
    if(!fp.replace(/\|/g,'')) return;               // could not read headers; don't guess
    if(__knownFingerprint === null){ __knownFingerprint = fp; return; }
    if(fp !== __knownFingerprint){ __knownFingerprint = fp; reloadForUpdate(); }
  }catch(e){}
}
function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  // A new worker taking over means new files are ready: reload onto them.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(!hadController){ hadController = true; return; }   // very first install: nothing to refresh
    reloadForUpdate();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register((window.__BASE||'./') + 'sw.js', { scope: (window.__BASE||'./'), updateViaCache:'none' }).then(reg => {
      window.__swRegistration = reg;
      reg.update().catch(()=>{});
    }).catch(e => console.warn('Service worker registration failed', e));
    checkForNewVersion();
    setInterval(checkForNewVersion, 5*60*1000);                       // while open
    document.addEventListener('visibilitychange', () => { if(!document.hidden) checkForNewVersion(); });  // coming back to the app / PWA
    window.addEventListener('online', checkForNewVersion);
    window.addEventListener('pageshow', (e) => { if(e.persisted) checkForNewVersion(); });
  });
}
