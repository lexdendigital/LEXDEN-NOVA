// /api/creator-admin-suppliers.js
//
// LEXDEN NOVA CREATOR — Stage G. Admin-only supplier oversight.
//
// GET  /api/creator-admin-suppliers?view=connections   -> every creator's
//        connection STATUS (never credentials/tokens)
// GET  /api/creator-admin-suppliers?view=orders[&status=NEEDS_ATTENTION]
// GET  /api/creator-admin-suppliers?view=logs
// POST /api/creator-admin-suppliers { action, ... }
//   revoke_connection { creatorId, reason }   wipes the creator's stored CJ
//                                             credentials and pauses their
//                                             live dropship listings
//   check_health      { productId }            force a supplier-health check
//   retry_order       { orderId }              re-attempt a failed CJ order
//   sync_order        { orderId }              pull CJ status/tracking now
const { getDb, requireAdminAuth, ok, fail, setCors } = require('./creator/shared');
const supplier = require('./supplier/service');
const orders = require('./supplier/orders');
const store = require('./supplier/store');

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try {
    admin = await requireAdminAuth(req);
  } catch (e) {
    return fail(res, e);
  }
  const db = getDb();

  if (req.method === 'GET') {
    try {
      const view = (req.query && req.query.view) || 'connections';
      if (view === 'connections') {
        const snap = await db.collection('supplierConnections').limit(500).get();
        return ok(res, { connections: snap.docs.map((d) => ({ creatorId: d.data().creatorId, ...store.publicConnectionView({ id: d.id, ...d.data() }) })) });
      }
      if (view === 'orders') {
        let q = db.collection('supplierOrders');
        if (req.query.status) q = q.where('status', '==', String(req.query.status));
        const snap = await q.orderBy('updatedAt', 'desc').limit(100).get();
        return ok(res, { supplierOrders: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
      }
      if (view === 'logs') {
        const snap = await db.collection('supplierSyncLogs').orderBy('createdAt', 'desc').limit(100).get();
        return ok(res, { logs: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
      }
      return fail(res, { status: 400, code: 'INVALID_VIEW', message: `Unknown view "${view}".` });
    } catch (e) {
      return fail(res, e);
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const body = req.body || {};
  try {
    if (body.action === 'revoke_connection') {
      if (typeof body.creatorId !== 'string' || !body.creatorId) return fail(res, { status: 422, code: 'MISSING_CREATOR_ID', message: 'creatorId is required.' });
      if (typeof body.reason !== 'string' || !body.reason.trim()) return fail(res, { status: 422, code: 'REASON_REQUIRED', message: 'A reason is required.' });
      return ok(res, await supplier.disconnectCj(db, { uid: body.creatorId, actorRole: 'admin', actorUid: admin.uid, reason: body.reason.trim().slice(0, 300) }));
    }
    if (body.action === 'check_health') {
      if (typeof body.productId !== 'string' || !body.productId) return fail(res, { status: 422, code: 'MISSING_PRODUCT_ID', message: 'productId is required.' });
      return ok(res, await supplier.checkMappingHealth(db, { productId: body.productId, minGapMs: 0 }));
    }
    if (body.action === 'retry_order' || body.action === 'sync_order') {
      if (typeof body.orderId !== 'string' || !body.orderId || body.orderId.includes('/')) return fail(res, { status: 422, code: 'MISSING_ORDER_ID', message: 'orderId is required.' });
      return ok(res, body.action === 'retry_order'
        ? await orders.createCjOrderForFulfillment(db, body.orderId)
        : await orders.syncCjFulfillment(db, body.orderId));
    }
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${body.action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
