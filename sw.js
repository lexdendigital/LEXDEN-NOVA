/* LEXDEN NOVA — service worker
 * Scope: app-shell caching only. This file deliberately does NOT touch
 * anything that must always be fresh — Firestore reads/writes, the
 * /api/verify-paystack payment-verification call, the /api/nova-ai AI
 * assistant call, or the open.er-api.com exchange-rate lookup. Those are
 * all left to hit the network untouched (see shouldBypass() below).
 *
 * BUMP THIS on every deploy that changes index.html/manifest/icons —
 * it's the only thing that forces old caches to be dropped and a fresh
 * shell to be fetched. Forgetting to bump it means returning users can
 * keep seeing a stale cached shell indefinitely.
 */
const CACHE_VERSION = 'nova-shell-v1';

// Precached app shell — kept intentionally short because this is a
// single-file SPA; there is no separate bundled CSS/JS to list.
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// Third-party origins that are safe to cache because they're static,
// versioned-by-URL assets (fonts, the Paystack popup SDK) — never API
// responses or anything containing live data.
const CACHEABLE_CROSS_ORIGIN = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'js.paystack.co',
];

// Anything matching these must NEVER be served from cache or intercepted —
// always go straight to the network. This is the actual safety boundary.
function shouldBypass(url) {
  return (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebaseinstallations.googleapis.com') ||
    url.hostname.includes('firebaseappcheck.googleapis.com') ||
    (url.hostname.includes('googleapis.com') && url.pathname.includes('identitytoolkit')) ||
    url.hostname.includes('open.er-api.com') ||          // exchange rates — must always be live
    url.pathname.includes('/api/verify-paystack') ||     // payment verification — must always be live
    url.pathname.includes('/api/nova-ai') ||             // AI assistant call — must always be live
    url.hostname.includes('generativelanguage.googleapis.com') ||
    url.hostname.includes('api.paystack.co')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever intercept simple GETs. POST (Firestore writes, payment
  // verification, the AI call) always passes straight through untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (shouldBypass(url)) return; // let the browser handle it normally

  const isSameOrigin = url.origin === self.location.origin;
  const isCacheableCrossOrigin = CACHEABLE_CROSS_ORIGIN.some((h) => url.hostname.includes(h));
  if (!isSameOrigin && !isCacheableCrossOrigin) return; // e.g. Unsplash images — just go to network

  // Stale-while-revalidate: answer instantly from cache if we have it,
  // and refresh the cache in the background so the *next* load is current.
  // This is what makes a repeat visit on a bad connection feel instant
  // while still self-healing within a load or two after a new deploy.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await networkFetch) || Response.error();
    })
  );
});

// Lets index.html tell a waiting worker to activate immediately after the
// person taps "Refresh" on the update banner, instead of waiting for every
// tab to close.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
