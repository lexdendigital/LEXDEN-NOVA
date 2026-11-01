// /api/affiliate/mark-verified-reviews.js
//
// Cron-callable sweep that labels a review "Verified Purchase" once the same person has a
// real paid order for that product. Firestore Rules will not let a shopper set this flag
// themselves (see firestore.rules), so this admin-SDK sweep is the only path that can.
//
// A review counts as verified when an order exists with status "paid" (or "success", kept
// for older records), the same product, and either the same uid or — for an older review
// written before uid was always attached — the same email.

const { getDb } = require('./shared');

const BATCH_LIMIT = 200;
const PAID_STATUSES = new Set(['paid', 'success']);

async function hasMatchingOrder(db, review) {
  if (review.productId && review.uid) {
    const byUid = await db.collection('orders')
      .where('productId', '==', review.productId)
      .where('uid', '==', review.uid)
      .limit(5).get();
    if (byUid.docs.some((d) => PAID_STATUSES.has(d.data().status))) return true;
  }
  if (review.productId && review.email) {
    const byEmail = await db.collection('orders')
      .where('productId', '==', review.productId)
      .where('email', '==', review.email)
      .limit(5).get();
    if (byEmail.docs.some((d) => PAID_STATUSES.has(d.data().status))) return true;
  }
  return false;
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  let db;
  try { db = getDb(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

  let snap;
  try {
    snap = await db.collection('reviews').where('verifiedPurchase', '==', false).limit(BATCH_LIMIT).get();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Query failed: ' + e.message });
  }
  // A review created before this field existed has no verifiedPurchase key at all, so the
  // equality query above misses it; Firestore cannot query "field missing" directly, so a
  // second pass reads everything and filters in JS. Both passes share the same batch cap.
  let legacySnap;
  try {
    legacySnap = await db.collection('reviews').limit(BATCH_LIMIT).get();
  } catch (e) {
    legacySnap = { docs: [] };
  }
  const seen = new Set(snap.docs.map((d) => d.id));
  const legacy = legacySnap.docs.filter((d) => !seen.has(d.id) && !('verifiedPurchase' in d.data()));
  const candidates = [...snap.docs, ...legacy];

  let verified = 0, checked = 0, errors = 0;
  for (const doc of candidates) {
    checked += 1;
    try {
      const isVerified = await hasMatchingOrder(db, doc.data());
      await doc.ref.set({ verifiedPurchase: isVerified }, { merge: true });
      if (isVerified) verified += 1;
    } catch (e) {
      errors += 1;
    }
  }
  return res.status(200).json({ ok: true, checked, verified, errors });
}

module.exports = handler;
module.exports.hasMatchingOrder = hasMatchingOrder;
module.exports.PAID_STATUSES = PAID_STATUSES;
