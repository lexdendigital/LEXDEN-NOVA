// /api/creator-fulfillments.js
//
// LEXDEN NOVA CREATOR — Stage E. Seller-side.
//
// GET  /api/creator-fulfillments[?status=PENDING] -> own fulfillment queue
// POST /api/creator-fulfillments { orderId, action, ... }
//   mark_packed  { orderId }
//   mark_shipped { orderId, carrier, trackingNumber, trackingUrl? }
//   acknowledge  { orderId }          tell NOVA you have seen the order (Stage H SLA)
//   cancel       { orderId, reason }
// Every fulfillment in a GET carries a computed `sla` (on track / at risk / breached).
//
// Requires an active creator AND ownership (fulfillment.creatorId === uid).
const { requireActiveCreator, getDb, writeProductAuditLog, FieldValue, ok, fail, setCors } = require('./creator/shared');
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
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    ({ decoded } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const status = req.query && req.query.status;
      let query = getDb().collection('fulfillments').where('creatorId', '==', uid);
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
  if (action === 'acknowledge') {
    try {
      const f = await getFulfillment(getDb(), orderId);
      if (!f || f.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No fulfillment order found.' });
      if (f.status !== FULFILLMENT_STATES.PENDING) return fail(res, { status: 409, code: 'NOT_PENDING', message: `This order is already ${f.status}.` });
      if (f.acknowledgedAtMs) return ok(res, { acknowledged: true, alreadyAcknowledged: true, acknowledgedAtMs: f.acknowledgedAtMs });
      const nowMs = Date.now();
      await getDb().collection('fulfillments').doc(orderId).set({ acknowledgedAtMs: nowMs, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: 'fulfillment.acknowledge', productId: f.productId, metadata: { orderId } });
      return ok(res, { acknowledged: true, acknowledgedAtMs: nowMs });
    } catch (e) {
      return fail(res, e);
    }
  }
  const spec = ACTIONS[action];
  if (!spec) return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });

  try {
    const fulfillment = await getFulfillment(getDb(), orderId);
    if (!fulfillment || fulfillment.creatorId !== uid) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No fulfillment order found.' });

    assertActorMayTransition('creator', spec.to);
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

    await applyFulfillmentPatch(getDb(), orderId, spec.to, extra);
    await writeProductAuditLog({ actorUid: uid, actorRole: 'creator', action: `fulfillment.${action}`, productId: fulfillment.productId, reason: reason || null, metadata: { orderId, to: spec.to } });
    return ok(res, { status: spec.to });
  } catch (e) {
    return fail(res, e);
  }
};
