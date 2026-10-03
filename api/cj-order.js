// /api/cj-order.js
//
// LEXDEN NOVA × CJ — creates the CJ fulfilment order for a PHYSICAL
// product, ONLY after this server has independently confirmed the order
// was really paid (README §20/§21). Never trust "payment successful" from
// the browser alone — this reads the order Firestore doc that
// verify-paystack.js itself wrote after checking Paystack directly.
//
// CONTRACT
// POST { reference }   — the Paystack reference == the orders/{id} doc ID
// Response 200:
//   { ok:true, alreadyCreated:false, cj:{ orderId, orderNumber, status } }
//   { ok:true, alreadyCreated:true,  cj:{...} }        — idempotent replay
//   { ok:false, error:'not_paid' | 'not_physical' | 'invalid_product' |
//                      'out_of_stock' | 'cj_error', message }
//
// IDEMPOTENCY (README §21): the very first thing this does after loading
// the order is check order.cj.orderId — if it's already set, this returns
// that same result instead of creating a second CJ order. Safe to call
// this route as many times as you like for the same reference.

const { setCors, cjFetch, writeSyncLog, getProductsDoc, db, FieldValue } = require('./cj-shared');

// README §66/§67 — Nigeria-specific note: CJ's own destination-country
// support/cost varies; NG is still passed through as-is to CJ rather than
// silently substituted, so a real "not deliverable to NG" response from CJ
// surfaces honestly instead of being masked.
function buildCjOrderPayload(orderRef, order, product, cjMapping, qty) {
  const d = order.delivery || {};
  return {
    orderNumber: `NOVA-${orderRef}`,
    shippingCountryCode: countryToIso2(d.country) || 'NG',
    shippingProvince: d.state || '',
    shippingCity: d.city || '',
    shippingAddress: d.address || '',
    shippingCustomerName: d.name || '',
    shippingPhone: d.phone || '',
    remark: `LEXDEN NOVA order ${orderRef}`,
    fromCountryCode: 'CN',
    products: [
      { vid: cjMapping.variantId, quantity: qty, shopProductId: product.id },
    ],
  };
}

// Minimal, extend as needed — CJ expects ISO-2 country codes and the
// existing delivery modal collects a free-text country in some builds.
const COUNTRY_ISO2 = { nigeria: 'NG', 'united states': 'US', 'united kingdom': 'GB', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA' };
function countryToIso2(country) {
  if (!country) return null;
  const s = String(country).trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return COUNTRY_ISO2[s.toLowerCase()] || null;
}

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const reference = String((req.body && req.body.reference) || '').trim();
  if (!reference) return res.status(200).json({ ok: false, error: 'missing_reference' });

  const started = Date.now();
  const orderRef = db().collection('orders').doc(reference);

  try {
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(200).json({ ok: false, error: 'unknown_order' });
    const order = snap.data();

    if (order.status !== 'paid' && order.status !== 'processing') {
      return res.status(200).json({ ok: false, error: 'not_paid', message: 'This order has not been verified as paid.' });
    }
    if (!order.delivery) {
      // Digital/service order — nothing for CJ to do. Not an error.
      return res.status(200).json({ ok: false, error: 'not_physical', message: 'This order has no delivery details — nothing to fulfil via CJ.' });
    }

    // ---- Idempotency: already created? Return the existing result. ----
    if (order.cj && order.cj.orderId) {
      await writeSyncLog({ event: 'order.create', objectId: reference, success: true, message: 'Idempotent replay', tookMs: Date.now() - started });
      return res.status(200).json({ ok: true, alreadyCreated: true, cj: order.cj });
    }

    // ---- Server-side product/mapping validation (README §41 — never
    // trust price/supplierCost/cjVariantId/stock from the browser; here
    // there ISN'T a browser input at all — everything below comes from
    // Firestore's own product catalog, keyed only by the productId the
    // browser sent at checkout, which verify-paystack.js already priced
    // independently). ----
    const productsDoc = await getProductsDoc();
    const list = Array.isArray(productsDoc.list) ? productsDoc.list : [];
    const product = list.find(p => p && String(p.id) === String(order.productId));
    if (!product || product.productType !== 'PHYSICAL' || !product.physical) {
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'invalid_product', tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'invalid_product', message: 'This product is not a valid CJ-fulfilled physical product.' });
    }
    const cjMapping = product.physical.cj;
    if (!cjMapping || !cjMapping.variantId) {
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'no_cj_mapping', tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'invalid_product', message: 'This product has no CJ variant mapping — cannot auto-fulfil.' });
    }

    const qty = Math.max(1, parseInt(order.quantity, 10) || 1);

    // ---- Live stock check right before creating the order (README §37 —
    // "do not rely on stale inventory for final order approval"). ----
    const stockR = await cjFetch('/product/stock/queryByVid', { query: { vid: cjMapping.variantId } });
    const rows = stockR.ok ? (Array.isArray(stockR.data) ? stockR.data : [stockR.data]) : [];
    const totalQty = rows.reduce((sum, row) => sum + (Number(row && (row.storageNum ?? row.stockNum ?? row.num)) || 0), 0);
    if (stockR.ok && totalQty < qty) {
      await orderRef.set({ status: 'stock_issue' }, { merge: true });
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: `Out of stock: need ${qty}, have ${totalQty}`, tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'out_of_stock', message: 'This item just went out of stock at the supplier — order held for manual review.' });
    }

    // ---- Create the CJ order. ----
    const payload = buildCjOrderPayload(reference, order, product, cjMapping, qty);
    const createR = await cjFetch('/shopping/order/createOrderV2', { method: 'POST', body: payload });
    const tookMs = Date.now() - started;

    if (!createR.ok) {
      await orderRef.set({
        status: 'cj_order_failed',
        cjError: { message: createR.message, code: createR.code, at: FieldValue.serverTimestamp() },
      }, { merge: true });
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: createR.message, requestId: createR.requestId, tookMs });
      return res.status(200).json({ ok: false, error: 'cj_error', message: 'Could not create the supplier order — this has been flagged for admin review.' });
    }

    const cjResult = createR.data || {};
    const cj = {
      orderId: cjResult.orderId || cjResult.cjOrderId || null,
      orderNumber: cjResult.orderNumber || payload.orderNumber,
      status: 'CREATED',
      trackingNumber: '',
      carrier: '',
      variantId: cjMapping.variantId,
      sku: cjMapping.sku || null,
      quantity: qty,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await orderRef.set({ status: 'processing', cj }, { merge: true });

    await writeSyncLog({ event: 'order.create', objectId: reference, success: true, message: `CJ order ${cj.orderId}`, requestId: createR.requestId, tookMs });
    return res.status(200).json({ ok: true, alreadyCreated: false, cj });
  } catch (e) {
    await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'server_error', message: 'Unexpected error creating the supplier order.' });
  }
};
