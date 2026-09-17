// /api/cj-shared.js
//
// LEXDEN NOVA × CJ DROPSHIPPING — shared backend helpers.
//
// Every cj-*.js route imports from here. Nothing in this file is ever
// reachable directly from the browser (it isn't a route itself — no
// module.exports = async(req,res) handler).
//
// WHAT THIS OWNS
//   - Firebase Admin init (same credential pattern as verify-paystack.js /
//     send-otp.js — FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
//     FIREBASE_PRIVATE_KEY)
//   - CJ API 2.0 access-token lifecycle: fetches once, caches the token
//     (with its real expiry) in Firestore `cjAuth/token` — a collection no
//     firestore.rule ever grants client read/write on, so it only exists
//     via the Admin SDK — and transparently refreshes/re-authenticates
//     when it's missing, expired, or CJ itself rejects it (401/1804xx).
//   - cjFetch(): the ONE place that actually calls developers.cjdropshipping.com.
//     Adds the auth header, enforces the documented ~1 req/s pace on the
//     authentication endpoints, retries once on a transient failure, and
//     normalizes every CJ error shape into { ok:false, code, message }
//     so no route ever has to guess CJ's JSON shape by hand.
//   - writeSyncLog(): every cj-*.js route calls this once per operation so
//     Admin → CJ Dropshipping → Sync Logs has a real audit trail. Strips
//     anything that looks like a secret before it ever reaches Firestore.
//   - verifyCjWebhookSignature(): HMAC-SHA256 compare for cj-webhook.js.
//   - corsHeaders()/isAllowedOrigin(): identical allow-list to nova-ai.js,
//     duplicated here (not imported) so this file has zero dependency on
//     an edge-runtime module.
//
// ENV VARS THIS FILE READS
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY  (existing)
//   CJ_EMAIL           the email of the CJ account the API app was created under
//   CJ_API_KEY         the API key CJ gave you (Apps → Install App → Others → API)
//   CJ_WEBHOOK_SECRET  used to verify inbound CJ webhook signatures (cj-webhook.js)
//
// CJ_ACCESS_TOKEN / CJ_REFRESH_TOKEN / CJ_OPEN_ID are intentionally NOT read
// from env vars here — a 15-day-lived token pasted into a Vercel env var
// would silently go stale and nobody would notice until orders started
// failing. Instead this file fetches + refreshes the token itself and
// keeps it current in Firestore. If you already have a token from testing
// in Postman, you don't need to paste it anywhere — the first real request
// will mint a fresh one.

const admin = require('firebase-admin');
const crypto = require('crypto');

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

const ALLOWED_ORIGINS = [
  'https://lexdendigital.github.io',
  'https://lexden-nova.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host.startsWith('lexden-nova-') && host.endsWith('-lexdendigitals-projects.vercel.app');
  } catch {
    return false;
  }
}
function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Vary': 'Origin',
  };
}
function setCors(req, res) {
  const h = corsHeaders(req.headers.origin);
  for (const k in h) res.setHeader(k, h[k]);
}

// ---- Firebase Admin (singleton per warm instance) ----
function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY');
  }
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}
function db() {
  initAdmin();
  return admin.firestore();
}
const FieldValue = admin.firestore.FieldValue;

// ---- Simple in-memory pacing for CJ's ~1 req/s auth limit. Best-effort
// only (resets on cold start / doesn't coordinate across instances) — CJ's
// own 429 handling below is the real backstop.
let lastAuthCallAt = 0;
async function paceAuthCall() {
  const minGapMs = 1100;
  const wait = lastAuthCallAt + minGapMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAuthCallAt = Date.now();
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Mint a brand-new CJ access token via CJ_EMAIL + CJ_API_KEY. ----
async function requestNewToken() {
  const email = process.env.CJ_EMAIL;
  const password = process.env.CJ_API_KEY;
  if (!email || !password) {
    throw Object.assign(new Error('CJ_EMAIL / CJ_API_KEY not configured'), { code: 'NOT_CONFIGURED' });
  }
  await paceAuthCall();
  const r = await fetchWithTimeout(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, 9000);
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || json.result === false || !json.data || !json.data.accessToken) {
    throw Object.assign(new Error((json && json.message) || `CJ auth failed (HTTP ${r.status})`), { code: 'AUTH_FAILED', raw: json });
  }
  return json.data; // { accessToken, accessTokenExpiryDate, refreshToken, refreshTokenExpiryDate, ... }
}

async function requestRefreshedToken(refreshToken) {
  await paceAuthCall();
  const r = await fetchWithTimeout(`${CJ_BASE}/authentication/refreshAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  }, 9000);
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || json.result === false || !json.data || !json.data.accessToken) {
    throw Object.assign(new Error((json && json.message) || `CJ refresh failed (HTTP ${r.status})`), { code: 'REFRESH_FAILED', raw: json });
  }
  return json.data;
}

// Reads/writes the single cached-token doc. No firestore.rule matches
// `cjAuth/*`, so it is unreachable from any client SDK — only the Admin
// SDK (this file) can ever touch it. That's the entire security model for
// this collection: not "rules deny it", but "no client path to it exists".
async function saveToken(data) {
  const now = Date.now();
  await db().collection('cjAuth').doc('token').set({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || data.accessToken && null,
    accessTokenExpiryDate: data.accessTokenExpiryDate || null,
    refreshTokenExpiryDate: data.refreshTokenExpiryDate || null,
    openId: data.openId || data.CJUserId || null,
    updatedAt: now,
  }, { merge: true });
}

function isExpiringSoon(expiryDateStr, bufferMs) {
  if (!expiryDateStr) return true;
  const t = Date.parse(expiryDateStr);
  if (Number.isNaN(t)) return true;
  return t - Date.now() < bufferMs;
}

// Returns a valid access token, minting or refreshing one as needed.
// Never throws for "just needs a refresh" — only for real config/auth
// failures (missing creds, CJ rejecting both getAccessToken AND refresh).
async function getValidToken({ forceRefresh = false } = {}) {
  const ref = db().collection('cjAuth').doc('token');
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : null;

  if (!forceRefresh && cur && cur.accessToken && !isExpiringSoon(cur.accessTokenExpiryDate, 6 * 60 * 60 * 1000)) {
    return cur.accessToken;
  }

  // Access token missing/expiring — try a refresh first (cheaper, and CJ's
  // refresh tokens outlive access tokens by ~180 vs 15 days), then fall
  // back to a full re-authentication.
  if (cur && cur.refreshToken && !isExpiringSoon(cur.refreshTokenExpiryDate, 24 * 60 * 60 * 1000)) {
    try {
      const fresh = await requestRefreshedToken(cur.refreshToken);
      await saveToken(fresh);
      return fresh.accessToken;
    } catch (e) {
      console.warn('cj-shared: refresh failed, falling back to full re-auth:', e.message);
    }
  }

  const fresh = await requestNewToken();
  await saveToken(fresh);
  return fresh.accessToken;
}

// ---- The one function every cj-*.js route uses to actually call CJ. ----
// path: e.g. '/product/listV2'  |  method: 'GET'|'POST'
// query: object -> appended as ?a=b for GET
// body: object -> JSON body for POST
// Retries exactly once, with a forced token refresh, on a CJ auth-shaped
// rejection (CJ uses HTTP 200 + result:false + a 1004xx-ish code for an
// expired/invalid token rather than a real 401, so this checks the body,
// not just the status).
async function cjFetch(path, { method = 'GET', query, body, timeoutMs = 12000, _retried = false } = {}) {
  let token;
  try {
    token = await getValidToken();
  } catch (e) {
    return { ok: false, code: e.code || 'AUTH_ERROR', message: e.message };
  }

  let url = `${CJ_BASE}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }

  let res, json;
  try {
    res = await fetchWithTimeout(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'CJ-Access-Token': token,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    }, timeoutMs);
    json = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, code: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: e.message };
  }

  if (res.status === 429) {
    return { ok: false, code: 'RATE_LIMITED', message: 'CJ API rate limit reached — try again shortly.' };
  }

  const tokenLooksInvalid = json && (
    json.code === 1004001 || json.code === 1004002 ||
    /token/i.test(json.message || '') && (json.result === false)
  );
  if ((res.status === 401 || tokenLooksInvalid) && !_retried) {
    try { await getValidToken({ forceRefresh: true }); } catch { /* fall through to error below */ }
    return cjFetch(path, { method, query, body, timeoutMs, _retried: true });
  }

  if (!res.ok || !json || json.result === false) {
    return {
      ok: false,
      code: (json && json.code) || res.status,
      message: (json && json.message) || `CJ API error (HTTP ${res.status})`,
      requestId: json && json.requestId,
    };
  }

  return { ok: true, data: json.data, requestId: json.requestId };
}

// ---- Sync-log writer — Admin → CJ Dropshipping → Sync Logs reads this
// collection. Never pass secrets in `detail`; this also belt-and-braces
// strips anything shaped like a token/key just in case.
const SECRET_KEY_PATTERN = /token|secret|apikey|api_key|password/i;
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(k)) { out[k] = '[redacted]'; continue; }
    const v = obj[k];
    out[k] = (v && typeof v === 'object') ? redact(v) : v;
  }
  return out;
}
async function writeSyncLog({ event, objectId = null, success, message = '', requestId = null, tookMs = null, detail = null }) {
  try {
    await db().collection('cjSyncLogs').add({
      event,
      objectId,
      success: !!success,
      message: String(message || '').slice(0, 500),
      requestId: requestId || null,
      tookMs: tookMs == null ? null : Math.round(tookMs),
      detail: detail ? redact(detail) : null,
      at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writeSyncLog failed (non-fatal):', e.message);
  }
}

// ---- Webhook signature verification (CJ: HMAC-SHA256 over the raw body,
// hex digest, using CJ_WEBHOOK_SECRET). Constant-time compare. ----
function verifyCjWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.CJ_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signatureHeader).trim(), 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// ---- Read/write the whole catalog/products list doc (same shape
// _shared.js / verify-paystack.js already read publicly). Admin SDK write
// here is how cj-order.js / cj-webhook.js update stock & sync fields
// without needing the browser to be the one holding admin auth.
async function getProductsDoc() {
  const snap = await db().collection('catalog').doc('products').get();
  return snap.exists ? snap.data() : { list: [] };
}
async function saveProductsDoc(list) {
  await db().collection('catalog').doc('products').set({ list }, { merge: true });
}

module.exports = {
  db, FieldValue, initAdmin,
  cjFetch, getValidToken,
  writeSyncLog, redact,
  verifyCjWebhookSignature,
  corsHeaders, setCors, isAllowedOrigin,
  getProductsDoc, saveProductsDoc,
  fetchWithTimeout,
};
