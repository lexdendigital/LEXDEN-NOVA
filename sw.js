/* LEXDEN NOVA — service worker
   Jobs:
   1. PWA install + OFFLINE FALLBACK for the app shell.
   2. ALWAYS-LATEST CODE: every page, script and stylesheet is fetched from the
      network first (revalidated, never served from the browser's 10-minute
      cache). The cached copy is used ONLY when the person is offline. So a new
      deploy shows up on the next open — no more "refresh 5 times" — and nobody
      has to remember to bump a version number any more.
   3. A new service worker takes over immediately and reloads any open
      window(s) once, so even an installed PWA that was left open updates itself.
   4. Firebase Cloud Messaging background push.
   Catalog DATA always comes live from Firestore; it is never read from here. */
const CACHE_VERSION = 'nova-shell-v4';
const SHELL_FILES = [
  './', './index.html', './manifest.json', './css/app.css',
  './js/firebase.js', './js/data.js', './js/state.js', './js/core.js', './js/support.js',
  './js/shopper.js', './js/password-visibility.js', './js/nova-ai.js', './js/update.js', './js/boot.js',
  // admin portal + creator workspace (their own pages)
  './admin/', './admin/index.html', './admin/admin.js', './admin/main.js',
  './creator/', './creator/index.html', './creator/creator.js', './creator/main.js',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(SHELL_FILES.map((f) => fetch(f, { cache: 'reload' }).then((r) => r.ok && cache.put(f, r)).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const hadOld = keys.some((k) => k !== CACHE_VERSION);
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Upgrading from an older worker: pages already open are still running old code
    // from the old cache, so reload them once onto the fresh files.
    if (hadOld) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      wins.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only same-origin app files. Firestore, images, fonts, Paystack, the API etc. go straight to the network.
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const fromNetwork = (async () => {
      let res;
      try { res = await fetch(req, { cache: 'no-cache' }); } catch (e) { if (e && e.name === 'TypeError' && req.mode === 'navigate') throw e; res = await fetch(req.url, { cache: 'no-cache' }); }
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })();
    // Network first, so a new deploy is always picked up. On a slow connection (common on
    // mobile data) wait at most 3 seconds, then show the saved copy while the network
    // request carries on and refreshes the cache for next time.
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      const slow = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      const winner = await Promise.race([fromNetwork.catch(() => null), slow]);
      return winner || cached;
    }
    try { return await fromNetwork; } catch (e) {
      if (req.mode === 'navigate') { const shell = await cache.match('./index.html'); if (shell) return shell; }
      throw e;
    }
  })());
});

/* ---------------- Firebase Cloud Messaging (background push) ---------------- */
// If Google's CDN is blocked/unreachable the worker must still install (offline shell + auto-update
// matter more than push), so a failed import only disables background push.
let __fcmLoaded = false;
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  __fcmLoaded = true;
} catch (e) { console.warn('FCM scripts unavailable; push disabled for now', e); }

// Same values as firebaseConfig in index.html — messaging needs its own
// compat-style init inside the service worker (modular SDK can't run
// here the same way).
if (__fcmLoaded) firebase.initializeApp({
  apiKey: "AIzaSyBk4WD0D5m6386sb62KC-5KKMpUuOLC9fs",
  authDomain: "lexden-nova.firebaseapp.com",
  projectId: "lexden-nova",
  storageBucket: "lexden-nova.firebasestorage.app",
  messagingSenderId: "421157476875",
  appId: "1:421157476875:web:c42a605fdb056c8282450e",
});

try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'LEXDEN NOVA';
    const body = (payload.notification && payload.notification.body) || '';
    const icon = (payload.notification && payload.notification.icon) || './icon-192.png';
    self.registration.showNotification(title, { body, icon, data: payload.data || {} });
  });
} catch (e) {
  // If messaging init fails (e.g. unsupported), the app-shell caching
  // above still works fine on its own.
  console.warn('FCM background init failed', e);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const postId = event.notification.data && event.notification.data.postId;
  const targetUrl = self.registration.scope + (postId ? `#feed/${postId}` : '#home');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(targetUrl); return c.focus(); } }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
