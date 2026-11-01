// /api/affiliate/review-requests.js
//
// Cron-callable: asks a shopper to review what they bought, once — about a week after a paid
// order, so they have had time to actually use it. Each order is only ever asked once
// (reviewRequested is set the moment the email is queued, win or lose, so a flaky send never
// turns into a repeat sweep retrying the same order forever and spamming the shopper).

const { getDb } = require('./shared');
const { queueEmailBackground } = require('../email-shared');

const DAY = 24 * 60 * 60 * 1000;
const REVIEW_REQUEST_WAIT_MS = 7 * DAY;
const BATCH_LIMIT = 150;
const PAID_STATUSES = new Set(['paid', 'success']);

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

// True once an order is both paid and old enough to ask about — the one rule this file must
// get right, pulled out so a test can check it without touching Firestore.
function isDueForReviewRequest(order, now) {
  if (!order || !PAID_STATUSES.has(order.status)) return false;
  if (!order.email || !order.productId) return false;
  const paidAt = toMs(order.timestamp) || toMs(order.paidAt);
  return paidAt > 0 && (now - paidAt) >= REVIEW_REQUEST_WAIT_MS;
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  let db;
  try { db = getDb(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  let snap;
  try {
    snap = await db.collection('orders').where('reviewRequested', '==', false).limit(BATCH_LIMIT).get();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Query failed: ' + e.message });
  }
  // Orders written before this field existed have no reviewRequested key at all, so the
  // equality query above misses them; a bounded second pass over recent paid orders catches
  // those (older than the wait window is exactly who this endpoint exists for).
  let legacySnap;
  try {
    legacySnap = await db.collection('orders').where('status', 'in', ['paid', 'success']).limit(BATCH_LIMIT).get();
  } catch (e) {
    legacySnap = { docs: [] };
  }
  const seen = new Set(snap.docs.map((d) => d.id));
  const legacy = legacySnap.docs.filter((d) => !seen.has(d.id) && !('reviewRequested' in d.data()));
  const candidates = [...snap.docs, ...legacy];

  const now = Date.now();
  let sent = 0, skipped = 0, waiting = 0, errors = 0;

  for (const doc of candidates) {
    const o = doc.data() || {};
    try {
      if (!PAID_STATUSES.has(o.status)) { skipped += 1; continue; }
      if (!o.email || !o.productId) { await doc.ref.set({ reviewRequested: true }, { merge: true }); skipped += 1; continue; }
      if (!isDueForReviewRequest(o, now)) { waiting += 1; continue; }
      // Mark requested BEFORE sending: a send that fails is retried by Brevo's own queue
      // (queueEmailBackground), not by this sweep running twice over the same order.
      await doc.ref.set({ reviewRequested: true }, { merge: true });
      await queueEmailBackground({
        templateKey: 'review_request',
        to: { email: o.email, name: (o.deliveryName || '').trim() || undefined },
        params: {
          product_name: o.productName || 'your recent purchase',
          product_id: o.productId,
          review_url: 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html?product=' + encodeURIComponent(o.productId) + '#product/' + encodeURIComponent(o.productId),
        },
      });
      sent += 1;
    } catch (e) {
      errors += 1;
    }
  }
  return res.status(200).json({ ok: true, sent, skipped, waiting, errors });
}

module.exports = handler;
module.exports.isDueForReviewRequest = isDueForReviewRequest;
module.exports.REVIEW_REQUEST_WAIT_MS = REVIEW_REQUEST_WAIT_MS;
module.exports.toMs = toMs;
