const { applyCors } = require('../cors');
// /api/affiliate/shared.js
//
// Shared helpers for every affiliate program backend file
// (withdraw.js, admin.js, track.js, abandon-emails.js, and verify-paystack.js
// one level up). Mirrors the Firebase Admin init pattern already used
// elsewhere in this repo — same env vars, same \n-restore handling.

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

function getDb() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      rawKey = rawKey.slice(1, -1);
    }
    const privateKey = rawKey.replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Missing Firebase Admin env vars. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.');
    }
    const appOptions = { credential: cert({ projectId, clientEmail, privateKey }) };
    const storageBucket = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
    if (storageBucket) appOptions.storageBucket = storageBucket;
    initializeApp(appOptions);
  }
  return getFirestore();
}

// Verifies the Firebase ID token an affiliate's browser sends in
// `Authorization: Bearer <token>`. Returns the decoded token (has .uid,
// .email) or throws — callers should catch and respond 401.
async function requireAffiliateAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const e = new Error('Missing Authorization header.');
    e.status = 401;
    throw e;
  }
  // The Admin app MUST be initialised before getAuth(). On a cold start the
  // first request can be an auth-only endpoint (e.g. /api/creator-application)
  // that has not touched Firestore yet; getAuth() then throws "default app
  // does not exist", which used to be reported to the shopper as an expired
  // session. Config problems are a 500, never a fake 401.
  try {
    getDb();
  } catch (e) {
    const err = new Error('Server auth is not configured: ' + (e && e.message ? e.message : 'init failed'));
    err.status = 500;
    throw err;
  }
  try {
    return await getAuth().verifyIdToken(token);
  } catch (e) {
    const code = e && (e.code || (e.errorInfo && e.errorInfo.code)) || '';
    const msg = String(e && e.message || '');
    // Only genuine token problems are a 401. Anything else (network blip
    // fetching Google's certs, clock skew on the host) is a retryable 503.
    const tokenProblem = /^auth\/(argument-error|id-token-expired|id-token-revoked|invalid-id-token|user-disabled|user-not-found)/.test(String(code)) ||
      /decoding Firebase ID token|expired|invalid/i.test(msg) && !/ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|socket/i.test(msg);
    const err = new Error(tokenProblem
      ? 'Invalid or expired session — please sign in again.'
      : 'Could not verify your sign-in right now — please try again in a moment.');
    err.status = tokenProblem ? 401 : 503;
    err.code = tokenProblem ? 'BAD_TOKEN' : 'AUTH_UNAVAILABLE';
    console.error('[auth] verifyIdToken failed:', code, msg.slice(0, 200));
    throw err;
  }
}

// Admin check: your app already has exactly ONE admin account
// (ruthanselem2@gmail.com — same address hardcoded in index.html's
// ADMIN_EMAIL constant and firestore.rules' isAdmin()). This just checks
// the signed-in caller's email against that same address — nothing to
// configure. ADMIN_EMAILS is an optional comma-separated override only
// if you ever add a second admin; you can ignore it entirely otherwise.
function isAdminEmail(email) {
  const list = (process.env.ADMIN_EMAILS || 'ruthanselem2@gmail.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

async function requireAdminAuth(req) {
  const decoded = await requireAffiliateAuth(req);
  if (!isAdminEmail(decoded.email)) {
    const e = new Error('Not authorized.');
    e.status = 403;
    throw e;
  }
  return decoded;
}

function setCors(res) {
  applyCors(res.req, res, { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, Authorization' });
}

// Adds `n` WITHDRAWAL-ELIGIBLE days to `from`, skipping Sundays — this is
// the exact rule you set: request today -> next eligible request is after
// 7 days that count, with Sundays not counted toward those 7 (you're at
// church, no processing happens that day anyway). Returns a Date.
function addNonSundayDays(from, n) {
  const d = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) added++; // 0 = Sunday
  }
  return d;
}

// Same Firebase Admin app as getDb(), just handed back as the Auth client
// instead of Firestore. Added for the MCP layer (mcp/oauth.js verifies the
// admin's ID token here, and a diagnostics tool looks up the admin's Auth
// user record by email) — nothing in the existing HTTP API needed this
// exported before now, since requireAffiliateAuth() called getAuth()
// internally.
function getAuthAdmin() {
  getDb(); // ensures initializeApp() has run — see getDb() above
  return getAuth();
}

function getFirebaseBucket() {
  getDb(); // initialize the shared Admin app first
  const bucketName = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  if (!bucketName) throw new Error('Set FIREBASE_STORAGE_BUCKET to the exact bucket name shown in Firebase Console → Storage before using product image uploads.');
  return getStorage().bucket(bucketName);
}

module.exports = { getDb, getAuthAdmin, getFirebaseBucket, FieldValue, requireAffiliateAuth, requireAdminAuth, isAdminEmail, setCors, addNonSundayDays };
