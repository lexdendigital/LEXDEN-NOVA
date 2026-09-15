// /api/process-email-queue.js
//
// LEXDEN NOVA — background retry for emails that failed BOTH fast
// attempts in email-shared.js's sendEmailFast(). This is the "guarantee"
// half of the guarantee: the customer-facing request never waited past
// ~8s worst case (2 x 4s) for Brevo, but a genuinely down/rate-limited
// Brevo doesn't mean the email is lost — it sits in `emailQueue` until
// this route (a Vercel Cron job, see vercel.json's `crons` entry) picks
// it up and retries with exponential backoff, capped at 6 attempts.
//
// Runs on a schedule set in vercel.json (default: every 5 minutes — note
// Vercel Hobby plans only run crons once/day; on Hobby, trigger this
// manually or upgrade to Pro for minute-level cron frequency). Also
// callable directly (GET/POST, no auth) for a manual "retry now" — this
// only ever touches its own queue, never anything payment-related, so it
// is safe to expose without an admin token.

const admin = require('firebase-admin');
const { sendEmailFast } = require('./email-shared');

const MAX_ATTEMPTS = 6;
const BATCH_LIMIT = 25; // don't let one cron tick run forever

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Missing Firebase Admin env vars');
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

function backoffMs(attempts) {
  // 1m, 3m, 9m, 27m, 81m, 243m — plateaus well before MAX_ATTEMPTS
  return Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(3, attempts - 1));
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  try {
    initAdmin();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  const db = admin.firestore();

  let snap;
  try {
    snap = await db.collection('emailQueue')
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', Date.now())
      .limit(BATCH_LIMIT)
      .get();
  } catch (e) {
    // Composite index not yet created on first deploy — Firestore's error
    // message includes a direct console link to create it; surface that
    // rather than failing silently.
    console.error('process-email-queue: query failed (may need a Firestore index):', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }

  let sent = 0, failed = 0, deadLettered = 0;

  for (const doc of snap.docs) {
    const item = doc.data();
    const result = await sendEmailFast(item.payload);
    if (result.ok) {
      sent++;
      await doc.ref.set({ status: 'sent', sentAt: Date.now() }, { merge: true });
      continue;
    }
    const attempts = (item.attempts || 1) + 1;
    if (attempts > MAX_ATTEMPTS) {
      deadLettered++;
      await doc.ref.set({ status: 'failed', attempts, lastError: result.error }, { merge: true });
      console.error(`process-email-queue: giving up on ${doc.id} after ${attempts} attempts:`, result.error);
    } else {
      failed++;
      await doc.ref.set({
        attempts,
        lastError: result.error,
        nextAttemptAt: Date.now() + backoffMs(attempts),
      }, { merge: true });
    }
  }

  return res.status(200).json({ ok: true, checked: snap.size, sent, retrying: failed, deadLettered });
};
