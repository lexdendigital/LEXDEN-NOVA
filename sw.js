/* LEXDEN NOVA — service worker
   Two jobs:
   1. PWA app-shell caching (stale-while-revalidate) — installability +
      fast repeat loads. Only the shell (this file's own cache) is
      cached; product/catalog DATA always comes live from Firestore, never
      from this cache, so shoppers never see stale prices/products.
   2. Firebase Cloud Messaging background push — shows a system
      notification when an "Important" feed post triggers a push and the
      app isn't open/focused.

   *** BUMP CACHE_VERSION EVERY TIME YOU REDEPLOY index.html ***
   Browsers can hold on to an old cached copy of the app shell otherwise —
   this is almost always the real cause of "I edited it but my other
   device doesn't show the change": the DATA (Firestore) synced fine, but
   the CODE FILE on that other device's browser was still the cached one.
   Bumping this version forces every device to fetch the new shell on next
   load. */
const CACHE_VERSION = 'nova-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only cache same-origin app-shell files. Everything else (Firestore,
  // images, fonts, Paystack SDK, etc.) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------------- Firebase Cloud Messaging (background push) ---------------- */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Same values as firebaseConfig in index.html — messaging needs its own
// compat-style init inside the service worker (modular SDK can't run
// here the same way).
firebase.initializeApp({
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
