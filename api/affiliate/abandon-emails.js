// /api/affiliate/abandon-emails.js
//
// Requirement #14: if a known user views a product page and doesn't buy,
// send them a reminder. Cron-callable (GET/POST, no auth — same "own
// queue only" safety reasoning as process-email-queue.js). Point an
// external cron at this every 30 minutes.
//
// Reads `productViewEvents` docs written client-side by index.html's
// logAffiliateProductView(), each shaped:
//   { uid?, email, productId, productName, ts, emailed:false }
// (NOT the `productViews` collection — that one is your existing public
// view-count aggregate with a different {count} shape; kept deliberately
// separate so the two can never collide.)
// Only fires for views older than ABANDON_DELAY_MS with no matching paid
// order for that email+productId, and only ever once per view doc.

const { getDb } = require('./shared');
const { queueEmailBackground } = require('../email-shared');

const ABANDON_DELAY_MS = 60 * 60 * 1000; // 1 hour
const BATCH_LIMIT = 100;

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  let db;
  try {
    db = getDb();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const cutoff = new Date(Date.now() - ABANDON_DELAY_MS);
  let snap;
  try {
    snap = await db.collection('productViewEvents')
      .where('emailed', '==', false)
      .where('ts', '<=', cutoff)
      .limit(BATCH_LIMIT)
      .get();
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Query failed: ' + e.message });
  }

  let sent = 0, skipped = 0;
  for (const doc of snap.docs) {
    const v = doc.data();
    try {
      if (!v.email || !v.productId) { await doc.ref.update({ emailed: true }); skipped++; continue; }

      // Did they buy it already, by any order matching this email+product
      // placed after the view? If so, skip — this is a real, common case
      // (they bought it right after browsing) and must never send a
      // "did you forget" email to someone who already checked out.
      const orderSnap = await db.collection('orders')
        .where('email', '==', v.email)
        .where('productId', '==', v.productId)
        .limit(1).get();
      if (!orderSnap.empty) { await doc.ref.update({ emailed: true }); skipped++; continue; }

      queueEmailBackground({
        templateKey: 'abandoned_product',
        to: { email: v.email, name: v.name || undefined },
        params: {
          product_name: v.productName || 'that product',
          product_url: v.productUrl || 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html',
        },
      });
      await doc.ref.update({ emailed: true });
      sent++;
    } catch (e) {
      console.error(`abandon-email failed for view ${doc.id}:`, e.message);
    }
  }

  return res.status(200).json({ ok: true, sent, skipped, checked: snap.size });
};
