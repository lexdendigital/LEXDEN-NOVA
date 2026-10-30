// server.js
//
// LEXDEN NOVA API — Render entry point.
//
// Render (unlike Vercel) doesn't auto-treat files under /api as
// individual serverless functions, so this one file boots a normal
// Express server and wires each handler in api/*.js to the same path it
// had on Vercel (/api/<name>), plus the /feed/:id and /product/:id
// link-preview routes that used to be vercel.json rewrites. Every
// handler file itself is unchanged from the Vercel version except
// api/nova-ai.js and api/verify-paystack.js — see the comments at the
// top of those two files for exactly what changed and why.

const express = require('express');
const cors = require('cors');
const { mountMcp, recordServerError } = require('./mcp');
const { registerBuiltInProviders } = require('./api/fulfillment/bootstrap');

const app = express();

// Register the global main-store CJ adapter; this does not verify credentials or remote connectivity.
registerBuiltInProviders();

// ---- In-memory recent-error ring buffer (feeds nova_get_recent_server_errors
// via Claude's MCP connection) — Render's free tier has no log API, so this
// is a best-effort substitute that only covers the current process's
// lifetime. Wired up before anything else so it catches startup-time
// failures too.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  recordServerError({ type: 'unhandledRejection', message: (reason && reason.message) || String(reason), stack: reason && reason.stack });
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  recordServerError({ type: 'uncaughtException', message: err.message, stack: err.stack });
});
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy/load balancer

// ---- CORS ----
// Most handlers already set their own Access-Control-* headers per
// route (send-otp.js, verify-otp.js, send-email.js, send-auth-email.js,
// confirm-email-verified.js, verify-paystack.js, and every cj-*.js via
// cj-shared.js's setCors()) — this global layer just makes sure every
// OTHER route (nova-ai.js, and any future endpoint that forgets to set
// its own headers) is covered too, and handles OPTIONS preflight
// consistently everywhere. A route's own res.setHeader() call always
// overrides this if both run.
const DEFAULT_ORIGINS = ['https://lexdendigital.github.io'];
const envOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = envOrigins.length ? envOrigins : DEFAULT_ORIGINS;

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl, health checks, server-to-server (CJ/Paystack webhooks)
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    try {
      const host = new URL(origin).hostname;
      // Any GitHub Pages site and this Render service's own domain (handy
      // for testing endpoints directly from the browser).
      if (host.endsWith('.github.io') || host.endsWith('.onrender.com')) return cb(null, true);
      if (host === 'localhost' || host === '127.0.0.1') return cb(null, true);
    } catch { /* malformed Origin header — fall through to reject */ }
    cb(null, false);
  },
  credentials: true,
}));

// ---- Body parsing ----
// api/cj-webhook.js verifies CJ's HMAC signature against the exact raw
// bytes of the request body (it reads the stream itself), so that one
// route must NOT be pre-parsed by express.json() — parsing would consume
// the stream and re-serialize it, which can silently break signature
// verification. Every other route gets normal JSON parsing (mirrors
// Vercel's automatic body parsing, capped at 10mb per the migration
// README's recommended server.js).
app.use((req, res, next) => {
  if (req.path === '/api/cj-webhook' || req.path === '/api/paystack-webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
// FIX (MCP): OAuth clients (Claude included) POST /token as
// application/x-www-form-urlencoded per RFC 6749 — express.json() alone
// leaves req.body empty, so every token exchange failed with
// "unsupported_grant_type" and Claude kept showing "Connect".
app.use('/token', express.urlencoded({ extended: false }));
app.use('/register', express.urlencoded({ extended: false }));
app.use('/creator/token', express.urlencoded({ extended: false }));
app.use('/creator/register', express.urlencoded({ extended: false }));

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'LEXDEN NOVA API' });
});
// Kept at the API root too, in case anything checks it there instead.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'LEXDEN NOVA API' });
});

// An async handler that throws would otherwise leave the browser waiting
// forever (Express 4 does not catch rejected promises). Wrap so the caller
// always gets an answer and the error lands in the error log.
function safeHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`Handler error on ${req.method} ${req.path}:`, err && err.message);
      try { recordServerError({ type: 'handlerRejection', message: String(err && err.message), stack: err && err.stack, path: req.path }); } catch (_) {}
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Something went wrong on the server. Please try again.' });
    });
  };
}

// ---- API routes ----
// Same list as the migration README's §10 "endpoints to preserve" and
// §27 recommended file structure. app.all() is used (rather than
// app.get/app.post) because several handler files branch on req.method
// themselves (OPTIONS preflight, POST vs GET, 405 for anything else).
const ENDPOINTS = [
  'verify-paystack',
  'send-otp',
  'verify-otp',
  'send-email',
  'send-auth-email',
  'confirm-email-verified',
  'nova-ai',
  'cj-auth',
  'cj-product',
  'cj-products',
  'cj-stock',
  'cj-order',
  'cj-orders',
  'cj-shipping',
  'cj-tracking',
  'cj-webhook',
  'paystack-webhook',
  'get-product-fulfilment',
  'process-email-queue',
  'feed',
  'product',
  'admin-payment-mode',
  'secure-access',
];

for (const name of ENDPOINTS) {
  app.all(`/api/${name}`, safeHandler(require(`./api/${name}`)));
}

// ---- Live sitemap + robots (real catalog only; see api/sitemap.js) ----
const sitemapHandler = require('./api/sitemap');
app.get(['/sitemap.xml', '/api/sitemap'], safeHandler(sitemapHandler));
app.get('/robots.txt', sitemapHandler.robots);

// ---- Affiliate program (added for the affiliate mega-update) — files
// live under api/affiliate/ (its own directory, as requested) but keep
// their original /api/affiliate-* URLs since index.html and
// affiliate/index.html already call those exact paths.
const AFFILIATE_ENDPOINTS = {
  'affiliate-withdraw': './api/affiliate/withdraw',
  'affiliate-admin': './api/affiliate/admin',
  'affiliate-banks': './api/affiliate/banks',
  'affiliate-resolve-account': './api/affiliate/resolve-account',
  'affiliate-ai': './api/affiliate/ai',
  // FIX (mega-fix batch): powers the repeated-failure "Diagnose this"
  // popup in affiliate/index.html — see api/affiliate/diagnose.js.
  'affiliate-diagnose': './api/affiliate/diagnose',
  // FIX (mega-fix batch #2): server-side signup, replacing the client's
  // direct Firestore write — see api/affiliate/signup.js.
  'affiliate-signup': './api/affiliate/signup',
  'process-abandon-emails': './api/affiliate/abandon-emails',
};
for (const [name, path] of Object.entries(AFFILIATE_ENDPOINTS)) {
  app.all(`/api/${name}`, require(path));
}

// ---- LEXDEN NOVA CREATOR (Stage A: data model + auth + state machine) ----
// Files live under api/creator/ (shared helpers, not routes) and flat
// api/creator-*.js route files, same convention as the affiliate program
// above. See CREATOR-STAGE-A-README.md for what Stage A covers and what's
// deliberately deferred to later stages.
const CREATOR_ENDPOINTS = [
  'creator-application',
  'creator-documents',
  'creator-admin-applications',
  // Stage C — product/version engine
  'creator-products',
  'creator-product-assets',
  'creator-admin-products',
  // Stage D — digital delivery (entitlements + signed-URL downloads)
  'creator-entitlements',
  'creator-product-download',
  // Stage E — physical fulfillment, proof of delivery
  'creator-fulfillments',
  'creator-admin-fulfillments',
  'creator-order-fulfillment',
  // Stage F — money/ledger, withdrawals, finance export
  'creator-payout-account',
  'creator-withdraw',
  'creator-admin-finance',
  // Stage G — per-creator CJ dropshipping (creator's own CJ account)
  'creator-supplier-connection',
  'creator-supplier-products',
  'creator-supplier-orders',
  'creator-admin-suppliers', 'creator-admin-sla',
  // Stage I — automation: scheduler door, creator notifications, admin controls
  'creator-cron', 'creator-notifications', 'creator-admin-automation',
  // Email diagnostics (CRON_SECRET-protected): shows exactly why mail is not arriving
  'email-health',
  // Stage J — Creator AI Home (suggest-only co-pilot)
  'creator-ai',
  // Storefront bridge — public, read-only, sanitised listings
  'creator-listings',
  // Stage K — disputes, profile/seller pages, admin risk (holds, reconciliation)
  'creator-disputes',
  'creator-profile',
  'creator-seller',
  'creator-admin-risk',
  // Upgrade: refunds lifecycle, inventory hub, pre-payment stock reservation, order exceptions
  'creator-admin-refunds', 'creator-inventory', 'creator-checkout', 'creator-admin-exceptions', 'delivery-proof', 'policy-accept', 'policy-internal', 'creator-earnings',
  'creator-admin-funding', 'pickup-stations', 'creator-updates', 'creator-channel-shopify',
];
for (const name of CREATOR_ENDPOINTS) {
  app.all(`/api/${name}`, require(`./api/${name}`));
}

// ---- Link-preview routes ----
// Mirrors vercel.json's rewrites: /feed/:id -> /api/feed?id=:id and
// /product/:id -> /api/product?id=:id. feed.js/product.js read the id
// from req.query.id, so the :id route param is copied across before
// calling the same handler function.
const feedHandler = require('./api/feed');
const productHandler = require('./api/product');
app.get('/feed/:id', (req, res) => {
  req.query.id = req.params.id;
  return feedHandler(req, res);
});
app.get('/product/:id', (req, res) => {
  req.query.id = req.params.id;
  return productHandler(req, res);
});

// ---- Affiliate link redirects (/go/:ref and /go/:ref/:pid) ----
// This is what makes click counts *accurate* (requirement #1) — logging
// happens server-side, before any redirect, so ad-blockers that strip
// client-side tracking pixels can't hide a click the way they could if
// this were purely client-side. Then it 302s straight into the storefront
// with ?ref=&pid= so index.html's attribution-capture script (see
// PATCH-index-html-attribution.js) can set the long-lived localStorage
// keys that make the actual sale attribution work.
const STORE_URL = process.env.STORE_URL || 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
const affiliateTrackHandler = require('./api/affiliate/track');
app.get('/go/:ref/:pid?', affiliateTrackHandler(STORE_URL));

// ---- MCP (Claude custom connector) ----
// See mcp/ for the OAuth server + tool registrations, and MCP-SETUP.md
// for how to actually connect Claude to this once it's deployed.
mountMcp(app);

// ---- 404 fallback ----
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---- Error-handling safety net ----
// Most handlers already catch their own errors and send a response
// directly, so this mainly exists to (a) make sure a route that forgot
// to catch something doesn't just hang, and (b) feed
// nova_get_recent_server_errors so a bug like that is actually visible.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  recordServerError({ type: 'expressError', message: err.message, stack: err.stack, path: req.path });
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LEXDEN NOVA API listening on port ${PORT}`);
});

// Stage I — optional built-in scheduler. Off unless CREATOR_CRON_IN_PROCESS=true.
// Render's free web service sleeps when idle, so for dependable schedules ALSO
// call /api/creator-cron from an external pinger (see CREATOR-STAGE-I-README.md).
// Jobs are lock-protected and interval-limited, so running both is harmless.
if (process.env.CREATOR_CRON_IN_PROCESS === 'true') {
  const { runJobs } = require('./api/automation/runner');
  const { getDb } = require('./api/creator/shared');
  const TICK_MS = 10 * 60 * 1000;
  setInterval(() => {
    runJobs(getDb(), [], { trigger: 'in-process' }).catch((e) => console.error('in-process scheduler failed:', e.message));
  }, TICK_MS).unref();
  console.log('Creator scheduler: in-process timer enabled (every 10 min).');
}


// Lifecycle recovery scheduler — deliberately runs inside the existing web
// service so LEXDEN NOVA can keep abandoned-checkout / signup recovery on
// the free Render plan. Free web services may sleep when idle, so timing is
// best-effort while asleep; normal NOVA traffic wakes the backend, and the
// first sweep runs shortly after startup. Suppression checks happen again
// inside the processor before every email.
if (process.env.LIFECYCLE_CRON_IN_PROCESS === 'true') {
  const lifecycleUrl = `http://127.0.0.1:${PORT}/api/process-abandon-emails`;
  const runLifecycleSweep = () => {
    fetch(lifecycleUrl, { headers: { 'cache-control': 'no-cache' } })
      .then(async (r) => {
        const body = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
        console.log('Lifecycle email sweep:', body.slice(0, 500));
      })
      .catch((e) => console.error('Lifecycle email sweep failed:', e.message));
  };
  setTimeout(runLifecycleSweep, 30 * 1000).unref();
  setInterval(runLifecycleSweep, 15 * 60 * 1000).unref();
  console.log('Lifecycle email scheduler: in-process timer enabled (every 15 min while awake).');
}
