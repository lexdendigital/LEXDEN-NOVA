// /api/creator-order-fulfillment.js
//
// LEXDEN NOVA CREATOR — Stage E. Buyer-side.
//
// GET  /api/creator-order-fulfillment            -> own physical orders' tracking
// GET  /api/creator-order-fulfillment?orderId=X  -> one order's tracking
// POST /api/creator-order-fulfillment { orderId, action:'confirm_delivery',
//        proofPhotoBase64?, proofPhotoMimeType? }
//
// Any signed-in user (a buyer need not be a creator). Ownership by
// buyerUid OR buyerEmail, same reasoning as Stage D's findActiveEntitlement.
const { requireAuth, getDb, writeProductAuditLog, ok, fail, setCors } = require('./creator/shared');
const { getFulfillment, applyFulfillmentPatch, saveProofPhoto } = require('./creator/fulfillment');
const { FULFILLMENT_STATES, assertFulfillmentTransition, assertActorMayTransition } = require('./creator/fulfillment-state-machine');

function isOwnedByBuyer(fulfillment, decoded) {
  return !!(fulfillment.buyerUid && fulfillment.buyerUid === decoded.uid)
    || !!(fulfillment.buyerEmail && decoded.email && fulfillment.buyerEmail === decoded.email);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    decoded = await requireAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  if (req.method === 'GET') {
    try {
      const orderId = req.query && req.query.orderId;
      if (orderId) {
        const fulfillment = await getFulfillment(getDb(), orderId);
        if (!fulfillment || !isOwnedByBuyer(fulfillment, decoded)) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No order found.' });
        return ok(res, { fulfillment });
      }
      // Listing is by buyerUid only (a guest order has no uid to query).
      const snap = await getDb().collection('fulfillments').where('buyerUid', '==', decoded.uid).orderBy('updatedAt', 'desc').limit(100).get();
      return ok(res, { fulfillments: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { orderId, action, proofPhotoBase64, proofPhotoMimeType } = req.body || {};
  if (typeof orderId !== 'string' || !orderId) return fail(res, { status: 422, code: 'MISSING_ORDER_ID', message: 'orderId is required.' });
  if (action !== 'confirm_delivery') return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });

  try {
    const fulfillment = await getFulfillment(getDb(), orderId);
    if (!fulfillment || !isOwnedByBuyer(fulfillment, decoded)) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No order found.' });

    assertActorMayTransition('buyer', FULFILLMENT_STATES.DELIVERED);
    assertFulfillmentTransition(fulfillment.status, FULFILLMENT_STATES.DELIVERED);

    const extra = { deliveryConfirmedBy: 'buyer' };
    if (typeof proofPhotoBase64 === 'string' && proofPhotoBase64.length) {
      extra.proofPhotoStoragePath = await saveProofPhoto(orderId, proofPhotoBase64, proofPhotoMimeType);
    }

    await applyFulfillmentPatch(getDb(), orderId, FULFILLMENT_STATES.DELIVERED, extra);
    await writeProductAuditLog({ actorUid: decoded.uid, actorRole: 'buyer', action: 'fulfillment.confirm_delivery', productId: fulfillment.productId, metadata: { orderId, hadProofPhoto: !!extra.proofPhotoStoragePath } });
    return ok(res, { status: FULFILLMENT_STATES.DELIVERED });
  } catch (e) {
    return fail(res, e);
  }
};
