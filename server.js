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

const app = express();

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
  if (req.path === '/api/cj-webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// ---- Health check ----
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'LEXDEN NOVA API' });
});
// Kept at the API root too, in case anything checks it there instead.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'LEXDEN NOVA API' });
});

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
  'get-product-fulfilment',
  'process-email-queue',
  'feed',
  'product',
];

for (const name of ENDPOINTS) {
  app.all(`/api/${name}`, require(`./api/${name}`));
}

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
  'process-abandon-emails': './api/affiliate/abandon-emails',
};
for (const [name, path] of Object.entries(AFFILIATE_ENDPOINTS)) {
  app.all(`/api/${name}`, require(path));
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
