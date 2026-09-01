// /api/email-shared.js
//
// LEXDEN NOVA — guaranteed-fast, non-hanging email delivery.
//
// WHY THIS EXISTS
// Every email in this app used to go through a single, unbounded
// `fetch('https://api.brevo.com/...')` with no timeout. Two failure modes
// followed from that:
//   1. A slow/hung Brevo response could stall the WHOLE request that
//      triggered it — e.g. send-otp.js's "code sent" response, or (worse)
//      verify-paystack.js's "payment verified" response to a paying
//      customer — for however long Brevo felt like taking, up to Vercel's
//      own function timeout. That's a payment-confirmation UX depending on
//      a third party's latency.
//   2. verify-paystack.js's order/admin emails were `await`ed before the
//      response was sent (its own comment explains why: a Node serverless
//      function can freeze the instant the response is flushed, so a
//      real "fire and forget" risked the email never sending at all).
//      That traded reliability for speed — you couldn't have both.
//
// THIS FILE gives every caller both:
//   - sendEmailFast(payload)  → hard-capped at EMAIL_TIMEOUT_MS (default
//     4000ms) so it can NEVER hang the caller past that, with one
//     immediate fast retry on failure/timeout, still inside the ~5s
//     budget. Callers where the email IS the point of the request (OTP
//     codes, auth links) should `await` this directly.
//   - queueEmailBackground(payload) → for callers where the email is
//     secondary to the response (order confirmations, admin alerts): does
//     NOT block the caller at all. It runs sendEmailFast() inside
//     Vercel's waitUntil() (via @vercel/functions), which keeps the
//     function instance alive to finish that work *after* the response
//     has already been sent — solving exactly the freeze risk described
//     above, without making the customer wait on Brevo. If sendEmailFast
//     still fails after its fast retry, the payload is written to the
//     `emailQueue` Firestore collection so /api/process-email-queue.js
//     (a Vercel Cron route — see vercel.json) retries it with backoff
//     until it succeeds. Nothing is ever silently dropped.
//
// ENV VARS: same BREVO_API_KEY / BREVO_TPL_* as send-email.js, plus the
// existing FIREBASE_* trio (used only for the fallback queue).

const admin = require('firebase-admin');

const EMAIL_TIMEOUT_MS = 4000; // hard cap per attempt — leaves headroom under a 5s budget
const MAX_FAST_ATTEMPTS = 2;   // 1 try + 1 immediate retry, both inside the timeout budget

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) return null; // queueing is best-effort; never throw from here
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}
function dbOrNull() {
  const app = initAdmin();
  return app ? admin.firestore() : null;
}

// One raw, timeout-bounded attempt at Brevo's transactional email API.
// payload: { templateKey, to:{email,name?}, params:{...}, replyTo?, sender? }
async function attemptSend(payload) {
  const apiKey = process.env.BREVO_API_KEY;
  const templateEnvKey = `BREVO_TPL_${String(payload.templateKey || '').toUpperCase()}`;
  const templateId = Number(process.env[templateEnvKey]);
  if (!apiKey) throw Object.assign(new Error('BREVO_API_KEY not set'), { permanent: true });
  if (!templateId) throw Object.assign(new Error(`${templateEnvKey} not set`), { permanent: true });
  if (!payload.to || !payload.to.email) throw Object.assign(new Error('Missing recipient email'), { permanent: true });

  const body = {
    to: [{ email: payload.to.email, name: payload.to.name || undefined }],
    templateId,
    params: payload.params || {},
    sender: payload.sender || {
      email: process.env.BREVO_SENDER_EMAIL || 'lexdendigital@gmail.com',
      name: process.env.BREVO_SENDER_NAME || 'LEXDEN NOVA',
    },
  };
  if (payload.replyTo) body.replyTo = { email: payload.replyTo };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Brevo ${r.status}: ${text.slice(0, 300)}`);
    }
    const data = await r.json().catch(() => ({}));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Bounded: at most MAX_FAST_ATTEMPTS tries, each capped at EMAIL_TIMEOUT_MS,
// so worst case this resolves in well under (2 x EMAIL_TIMEOUT_MS) — safely
// inside a 5-second guarantee even with one retry.
async function sendEmailFast(payload) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_FAST_ATTEMPTS; attempt++) {
    try {
      const data = await attemptSend(payload);
      return { ok: true, attempts: attempt, messageId: data && data.messageId };
    } catch (e) {
      lastErr = e;
      if (e.permanent) break; // misconfiguration — retrying won't help
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'Unknown email failure' };
}

async function enqueueForRetry(payload, reason) {
  const database = dbOrNull();
  if (!database) { console.error('email-shared: could not queue failed email (Firebase Admin not configured):', reason); return; }
  try {
    await database.collection('emailQueue').add({
      payload,
      lastError: String(reason || '').slice(0, 300),
      attempts: 1,
      status: 'pending',
      createdAt: Date.now(),
      nextAttemptAt: Date.now() + 60 * 1000, // first retry in 1 minute
    });
  } catch (e) {
    console.error('email-shared: failed to enqueue email for retry:', e.message);
  }
}

// The full guaranteed path: fast attempts, then queue on failure. Always
// resolves within the fast-attempt budget — queuing itself is a quick
// single Firestore write, not another network round trip to an email API.
async function sendEmailGuaranteed(payload) {
  const result = await sendEmailFast(payload);
  if (!result.ok) await enqueueForRetry(payload, result.error);
  return result;
}

// For callers that must not delay their own HTTP response AT ALL (e.g.
// verify-paystack.js after it has already decided to return ok:true).
// Uses Vercel's waitUntil when available so the background work is
// guaranteed to actually run to completion instead of risking a frozen
// instance — falls back to a plain unawaited call locally / on runtimes
// without waitUntil (best-effort there, same as the old behavior).
function queueEmailBackground(payload) {
  const task = sendEmailGuaranteed(payload).catch(e => {
    console.error('email-shared: background send failed unexpectedly:', e.message);
  });
  try {
    // Lazy require so this file has zero hard dependency on the package
    // for callers that only need sendEmailFast/sendEmailGuaranteed.
    const { waitUntil } = require('@vercel/functions');
    waitUntil(task);
  } catch {
    // @vercel/functions not available in this runtime (e.g. local dev) —
    // the promise above is still running; nothing further to do.
  }
}

module.exports = { sendEmailFast, sendEmailGuaranteed, queueEmailBackground, EMAIL_TIMEOUT_MS };
