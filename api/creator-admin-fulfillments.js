// /api/creator-admin-fulfillments.js
//
// LEXDEN NOVA CREATOR — Stage E. Admin-only.
//
// GET  /api/creator-admin-fulfillments[?status=SHIPPED] -> queue, any creator
// POST /api/creator-admin-fulfillments { orderId, action, reason? }
//   mark_packed, mark_shipped, cancel (same as the creator endpoint) plus
//   admin-only: mark_returned { reason }, mark_delivered (force-confirm).
//
// Exists for support/override; routine fulfillment is the creator's and
// buyer's own job via the other endpoints.
const { requireAdminAuth, getDb, writeProductAuditLog, ok, fail, setCors } = require('./creator/shared');
const { getFulfillment, applyFulfillmentPatch } = require('./creator/fulfillment');
const { evaluateSla } = require('./creator/sla');
const { resolveShipment } = require('./creator/carriers');
const {
  FULFILLMENT_STATES,
  assertFulfillmentTransition, assertActorMayTransition,
  assertShippedRequiresTracking, assertReasonRequired,
} = require('./creator/fulfillment-state-machine');

const ACTIONS = {
  mark_packed: { to: FULFILLMENT_STATES.PACKED },
  mark_shipped: { to: FULFILLMENT_STATES.SHIPPED },
  cancel: { to: FULFILLMENT_STATES.CANCELLED },
  mark_returned: { to: FULFILLMENT_STATES.RETURNED },
  mark_delivered: { to: FULFILLMENT_STATES.DELIVERED },
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try {
    admin = await requireAdminAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  if (req.method === 'GET') {
    try {
      const status = req.query && req.query.status;
      let query = getDb().collection('fulfillments');
      if (status) query = query.where('status', '==', status);
      const snap = await query.orderBy('updatedAt', 'desc').limit(100).get();
      const nowMs = Date.now();
      return ok(res, { fulfillments: snap.docs.map(d => { const x = { id: d.id, ...d.data() }; return { ...x, sla: evaluateSla(x, nowMs) }; }) });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { orderId, action, carrier, trackingNumber, trackingUrl, reason } = req.body || {};
  if (typeof orderId !== 'string' || !orderId) return fail(res, { status: 422, code: 'MISSING_ORDER_ID', message: 'orderId is required.' });
  const spec = ACTIONS[action];
  if (!spec) return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });

  try {
    const fulfillment = await getFulfillment(getDb(), orderId);
    if (!fulfillment) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No fulfillment order found.' });

    assertActorMayTransition('admin', spec.to);
    assertFulfillmentTransition(fulfillment.status, spec.to);
    assertReasonRequired(spec.to, reason);

    const extra = {};
    if (spec.to === FULFILLMENT_STATES.SHIPPED) {
      assertShippedRequiresTracking({ carrier, trackingNumber });
      const ship = resolveShipment({ carrier, trackingNumber, trackingUrl });
      if (!ship.ok) return fail(res, { status: 422, code: 'INVALID_TRACKING', message: 'Please check the tracking details.', errors: ship.errors });
      extra.carrier = ship.carrier;
      extra.trackingNumber = ship.trackingNumber;
      extra.trackingUrl = ship.trackingUrl;
    }
    if (spec.to === FULFILLMENT_STATES.CANCELLED) extra.cancelReason = reason.trim();
    if (spec.to === FULFILLMENT_STATES.RETURNED) extra.returnReason = reason.trim();
    if (spec.to === FULFILLMENT_STATES.DELIVERED) extra.deliveryConfirmedBy = 'admin';

    await applyFulfillmentPatch(getDb(), orderId, spec.to, extra);
    await writeProductAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `fulfillment.${action}`, productId: fulfillment.productId, reason: reason || null, metadata: { orderId, to: spec.to } });
    return ok(res, { status: spec.to });
  } catch (e) {
    return fail(res, e);
  }
};
