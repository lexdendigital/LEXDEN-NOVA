// /api/creator-entitlements.js
//
// LEXDEN NOVA CREATOR — Stage D.
//
// GET /api/creator-entitlements -> the signed-in buyer's own active
// entitlements, for a "My Library" screen. productTitle/price/currency
// are denormalized at grant time so listing needs no second read.
//
// Only lists entitlements keyed by buyerUid; a guest-checkout entitlement
// (email only) is still downloadable via creator-product-download.js,
// which checks both uid and email.
const { requireAuth, getDb, ok, fail, setCors } = require('./creator/shared');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  }

  let decoded;
  try {
    decoded = await requireAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  try {
    const snap = await getDb().collection('entitlements')
      .where('buyerUid', '==', decoded.uid)
      .where('status', '==', 'active')
      .orderBy('grantedAt', 'desc')
      .get();
    const items = snap.docs.map(d => {
      const v = d.data();
      return { id: d.id, productId: v.productId, productTitle: v.productTitle || null, grantedAt: v.grantedAt, price: v.price, currency: v.currency };
    });
    return ok(res, { entitlements: items });
  } catch (e) {
    return fail(res, e);
  }
};
