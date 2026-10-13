// /api/creator-supplier-orders.js
//
// LEXDEN NOVA CREATOR — Stage G. The CJ side of a creator's paid dropship
// orders.
//
// GET  /api/creator-supplier-orders            -> own supplier orders (status,
//        CJ order id, errors that need attention). Buyer-facing tracking stays
//        on /api/creator-order-fulfillment; this is the creator's own view.
// POST /api/creator-supplier-orders { action, orderId }
//   create  retry placing the CJ order (idempotent — never a second order)
//   sync    pull CJ's status/tracking now and mirror the safe part onto the
//           buyer's fulfillment (PENDING -> PACKED -> SHIPPED with tracking)
const { getDb, requireActiveCreator, ok, fail, setCors } = require('./creator/shared');
const orders = require('./supplier/orders');
const store = require('./supplier/store');

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    ({ decoded } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;
  const db = getDb();

  if (req.method === 'GET') {
    try {
      const snap = await db.collection('supplierOrders').where('creatorId', '==', uid).orderBy('updatedAt', 'desc').limit(100).get();
      return ok(res, { supplierOrders: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
    } catch (e) {
      return fail(res, e);
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { orderId, action } = req.body || {};
  if (typeof orderId !== 'string' || !orderId || orderId.includes('/')) {
    return fail(res, { status: 422, code: 'MISSING_ORDER_ID', message: 'orderId is required.' });
  }
  try {
    // Ownership: the fulfillment must belong to this creator.
    const f = await db.collection('fulfillments').doc(orderId).get();
    if (!f.exists || f.data().creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No order found.' });

    if (action === 'create') {
      const r = await orders.createCjOrderForFulfillment(db, orderId);
      return ok(res, r);
    }
    if (action === 'sync') {
      return ok(res, await orders.syncCjFulfillment(db, orderId));
    }
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
