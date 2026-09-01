// /api/cj-orders.js
//
// LEXDEN NOVA × CJ — order list/detail from CJ, and pulling CJ's current
// status back onto our own orders/{reference} doc (README §23). Used by
// the Admin → CJ Dropshipping → Orders screen, and by the customer-facing
// "My Orders" status refresh.
//
// CONTRACT
// GET /api/cj-orders?cjOrderId=...          -> { ok:true, order:{...} }
// GET /api/cj-orders?reference=PAYSTACK_REF&sync=1
//     -> reads orders/{reference}.cj.orderId, pulls fresh status from CJ,
//        writes it back, returns the customer-friendly status.

const { setCors, cjFetch, writeSyncLog, db, FieldValue } = require('./cj-shared');

// CJ's internal statuses -> a short, honest customer-facing label
// (README §23/§31 — never expose raw CJ internals to the shopper).
const FRIENDLY_STATUS = {
  CREATED: 'Paid',
  UNPAID: 'Paid', // our own payment is already confirmed — CJ's own "unpaid" refers to CJ-side settlement, not the customer's payment
  UNSHIPPED: 'Processing',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  CANCELED: 'Cancelled',
};
function toFriendly(cjStatus) {
  return FRIENDLY_STATUS[String(cjStatus || '').toUpperCase()] || 'Processing';
}

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const started = Date.now();

  try {
    // ---- sync a NOVA order's status from CJ ----
    if (req.query.reference) {
      const reference = String(req.query.reference);
      const orderRef = db().collection('orders').doc(reference);
      const snap = await orderRef.get();
      if (!snap.exists || !snap.data().cj || !snap.data().cj.orderId) {
        return res.status(200).json({ ok: false, error: 'No CJ order on file for this reference yet.' });
      }
      const cjOrderId = snap.data().cj.orderId;

      const r = await cjFetch('/shopping/order/getOrderDetail', { query: { orderId: cjOrderId } });
      const tookMs = Date.now() - started;
      if (!r.ok) {
        await writeSyncLog({ event: 'orders.sync', objectId: reference, success: false, message: r.message, tookMs });
        return res.status(200).json({ ok: false, error: r.message });
      }

      const d = r.data || {};
      const cjUpdate = {
        status: d.orderStatus || d.status || snap.data().cj.status,
        trackingNumber: d.trackNumber || d.trackingNumber || snap.data().cj.trackingNumber || '',
        carrier: d.logisticName || snap.data().cj.carrier || '',
        updatedAt: new Date().toISOString(),
      };
      await orderRef.set({ cj: { ...snap.data().cj, ...cjUpdate } }, { merge: true });

      await writeSyncLog({ event: 'orders.sync', objectId: reference, success: true, message: cjUpdate.status, tookMs });
      return res.status(200).json({
        ok: true,
        status: toFriendly(cjUpdate.status),
        trackingNumber: cjUpdate.trackingNumber || null,
        carrier: cjUpdate.carrier || null,
      });
    }

    // ---- raw CJ order detail (admin-facing) ----
    if (req.query.cjOrderId) {
      const r = await cjFetch('/shopping/order/getOrderDetail', { query: { orderId: String(req.query.cjOrderId) } });
      const tookMs = Date.now() - started;
      await writeSyncLog({ event: 'orders.detail', objectId: String(req.query.cjOrderId), success: r.ok, message: r.ok ? 'OK' : r.message, tookMs });
      if (!r.ok) return res.status(200).json({ ok: false, error: r.message });
      return res.status(200).json({ ok: true, order: r.data });
    }

    // ---- list (admin dashboard) ----
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const r = await cjFetch('/shopping/order/list', { query: { pageNum: page, pageSize: 20 } });
    const tookMs = Date.now() - started;
    await writeSyncLog({ event: 'orders.list', success: r.ok, message: r.ok ? 'OK' : r.message, tookMs });
    if (!r.ok) return res.status(200).json({ ok: false, error: r.message });
    return res.status(200).json({ ok: true, orders: (r.data && (r.data.list || r.data.content)) || [] });
  } catch (e) {
    await writeSyncLog({ event: 'orders.query', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Order lookup failed.' });
  }
};
