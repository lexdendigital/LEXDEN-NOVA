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
const { fundCjOrder, cjOrderAmountUSD } = require('./cj-funding');
const { queueEmailBackground } = require('./email-shared');

// README §66/§67 — Nigeria-specific note: CJ's own destination-country
// support/cost varies; NG is still passed through as-is to CJ rather than
// silently substituted, so a real "not deliverable to NG" response from CJ
// surfaces honestly instead of being masked.
function buildCjOrderPayload(orderRef, order, product, cjMapping, qty) {
  const d = order.delivery || {};
  return {
    orderNumber: `NOVA-${orderRef}`,
    shippingCountryCode: countryToIso2(d.country) || 'NG',
    shippingCountry: d.country || '',
    shippingProvince: d.state || '',
    shippingCity: d.city || '',
    shippingAddress: d.address || '',
    shippingCustomerName: d.name || '',
    shippingPhone: d.phone || '',
    email: order.email || '',
    shippingZip: d.postalCode || d.zip || '',
    logisticName: d.shippingMethod || '',
    payType: 3,
    remark: `LEXDEN NOVA order ${orderRef}`,
    fromCountryCode: countryToIso2(d.shippingOriginCountry) || 'CN',
    products: [
      { vid: cjMapping.variantId, quantity: qty, shopProductId: product.id },
    ],
  };
}

// Minimal, extend as needed — CJ expects ISO-2 country codes and the
// existing delivery modal collects a free-text country in some builds.
const COUNTRY_ISO2 = { nigeria: 'NG', china: 'CN', 'united states': 'US', 'united kingdom': 'GB', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA', poland: 'PL', germany: 'DE', france: 'FR', netherlands: 'NL', italy: 'IT', spain: 'ES' };
function countryToIso2(country) {
  if (!country) return null;
  const s = String(country).trim();
  if (s.toUpperCase() === 'UK') return 'GB';
  if (s.toUpperCase() === 'EU') return null; // warehouse regions must resolve to a country
  if (/^[A-Z]{2}$/.test(s)) return s;
  return COUNTRY_ISO2[s.toLowerCase()] || null;
}


function canResumeSupplierOrderStatus(status) {
  return ['paid', 'processing', 'supplier_created', 'funding_required'].includes(status);
}

function paystackBalanceText(snapshot) {
  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.balances) || !snapshot.balances.length) {
    return snapshot && snapshot.error ? `Unavailable (${snapshot.error})` : 'Unavailable';
  }
  return snapshot.balances.map(b => `${b.currency} ${Number(b.balanceMajor).toLocaleString('en-NG')}`).join(', ');
}

function alertFundingProblem(reference, order, funding) {
  queueEmailBackground({
    templateKey: 'admin',
    to: { email: process.env.ADMIN_NOTIFY_EMAIL || 'lexdendigital@gmail.com' },
    params: {
      event_type: 'CJ funding required',
      reference_id: reference,
      user_email: order.email || 'Unknown',
      event_time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' WAT',
      priority: 'Urgent',
      details: [
        `Product: ${order.productName || order.productId || 'Unknown'}`,
        `CJ funding state: ${funding.state}`,
        `CJ order amount: ${funding.requiredUSD == null ? 'Unknown' : '$' + Number(funding.requiredUSD).toFixed(2)}`,
        `CJ wallet balance: ${funding.cjBalanceUSD == null ? 'Unknown' : '$' + Number(funding.cjBalanceUSD).toFixed(2)}`,
        `CJ shortfall: ${funding.shortfallUSD == null ? 'Unknown' : '$' + Number(funding.shortfallUSD).toFixed(2)}`,
        `Paystack available balance: ${paystackBalanceText(funding.paystack)}`,
        'Automatic Paystack-to-CJ wallet top-up is not attempted because CJ exposes no documented instant Paystack top-up API. The paid shopper order is preserved and held safely for funding.',
      ].join(' | '),
    },
  });
}

async function finishCjFunding({ reference, orderRef, order, cj, started }) {
  const funding = await fundCjOrder({
    cjFetch,
    cjOrderId: cj.shipmentOrderId || cj.orderId,
    requiredUSD: cj.requiredUSD,
    paystackMode: order.paystackDomain,
  });

  if (funding.ok) {
    const paidCj = {
      ...cj,
      status: 'PAID',
      fundingStatus: 'paid',
      cjBalanceBeforeUSD: funding.cjBalanceUSD,
      requiredUSD: funding.requiredUSD,
      paidAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await orderRef.set({
      status: 'processing',
      requiresManualReview: false,
      fundingIssue: null,
      cj: paidCj,
    }, { merge: true });
    await writeSyncLog({
      event: 'order.pay',
      objectId: reference,
      success: true,
      message: `CJ order paid from wallet: ${paidCj.orderId}`,
      requestId: funding.paymentRequestId,
      tookMs: Date.now() - started,
    });
    return { ok: true, alreadyCreated: true, cj: paidCj };
  }

  const shouldAlert = !cj.fundingAlertedAt || cj.fundingStatus !== funding.state;
  const heldCj = {
    ...cj,
    status: 'AWAITING_FUNDING',
    fundingStatus: funding.state,
    cjBalanceBeforeUSD: funding.cjBalanceUSD == null ? null : funding.cjBalanceUSD,
    requiredUSD: funding.requiredUSD == null ? (cj.requiredUSD || null) : funding.requiredUSD,
    shortfallUSD: funding.shortfallUSD == null ? null : funding.shortfallUSD,
    fundingAlertedAt: shouldAlert ? new Date().toISOString() : (cj.fundingAlertedAt || null),
    updatedAt: new Date().toISOString(),
  };
  await orderRef.set({
    status: 'funding_required',
    requiresManualReview: true,
    fundingIssue: {
      state: funding.state,
      message: funding.message || null,
      cjBalanceUSD: funding.cjBalanceUSD == null ? null : funding.cjBalanceUSD,
      requiredUSD: funding.requiredUSD == null ? null : funding.requiredUSD,
      shortfallUSD: funding.shortfallUSD == null ? null : funding.shortfallUSD,
      paystackBalances: funding.paystack && funding.paystack.ok ? funding.paystack.balances : [],
      paystackBalanceError: funding.paystack && !funding.paystack.ok ? funding.paystack.error : null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    cj: heldCj,
  }, { merge: true });
  await writeSyncLog({
    event: 'order.pay',
    objectId: reference,
    success: false,
    message: funding.message || funding.state,
    tookMs: Date.now() - started,
    detail: { state: funding.state, requiredUSD: funding.requiredUSD, cjBalanceUSD: funding.cjBalanceUSD, shortfallUSD: funding.shortfallUSD },
  });
  if (shouldAlert) alertFundingProblem(reference, order, funding);
  return {
    ok: false,
    error: 'funding_required',
    fundingState: funding.state,
    message: 'The supplier order was created, but CJ could not be paid automatically. The order is safely held and the admin has been alerted.',
    cj: heldCj,
  };
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

    if (!canResumeSupplierOrderStatus(order.status)) {
      return res.status(200).json({ ok: false, error: 'not_paid', message: 'This order has not been verified as paid.' });
    }
    if (!order.delivery) {
      // Digital/service order — nothing for CJ to do. Not an error.
      return res.status(200).json({ ok: false, error: 'not_physical', message: 'This order has no delivery details — nothing to fulfil via CJ.' });
    }

    // ---- Idempotency: if CJ already has this order, NEVER create it again.
    // A previously-created but unpaid order resumes only its funding step. ----
    if (order.cj && order.cj.orderId) {
      if (order.cj.fundingStatus === 'paid' || order.cj.status === 'PAID') {
        await writeSyncLog({ event: 'order.create', objectId: reference, success: true, message: 'Idempotent replay — already paid', tookMs: Date.now() - started });
        return res.status(200).json({ ok: true, alreadyCreated: true, cj: order.cj });
      }
      const resumed = await finishCjFunding({ reference, orderRef, order, cj: order.cj, started });
      return res.status(200).json(resumed);
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
    const selectedVariant=Array.isArray(product.variants)?product.variants.find(variant=>String(variant.id)===String(order.variantId||'')):null;
    const cjMapping=selectedVariant&&selectedVariant.cjVariantId
      ? {...(product.physical.cj||{}),variantId:selectedVariant.cjVariantId,sku:selectedVariant.sku||product.physical.cj?.sku}
      : product.physical.cj;
    if (!cjMapping || !cjMapping.variantId) {
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'no_cj_mapping', tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'invalid_product', message: 'This product has no CJ variant mapping — cannot auto-fulfil.' });
    }

    // Physical orders must use the exact route selected and paid for at checkout.
    // Never silently let CJ substitute a different (possibly much more expensive) carrier.
    const routeName = order.delivery.shippingMethod;
    const quoteId = order.delivery.shippingQuoteId;
    if (!routeName || !quoteId) {
      await orderRef.set({ status: 'shipping_quote_issue', shippingQuoteIssue: 'missing_route_or_quote', requiresManualReview: true }, { merge: true });
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'missing_shipping_route_quote', tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'shipping_quote_missing', message: 'This order has no verified shipping route. It has been held for manual review.' });
    }
    const quoteSnap = await db().collection('shippingQuotes').doc(String(quoteId)).get();
    const quote = quoteSnap.exists ? quoteSnap.data() : null;
    if (!quote || quote.status !== 'reserved' || quote.usedBy !== reference || quote.logisticName !== routeName
      || String(quote.productId) !== String(order.productId) || String(quote.variantId || '') !== String(order.variantId || '')
      || String(quote.startCountryCode || 'CN') !== String(countryToIso2(order.delivery.shippingOriginCountry) || 'CN')) {
      await orderRef.set({ status: 'shipping_quote_issue', shippingQuoteIssue: 'quote_route_mismatch', requiresManualReview: true }, { merge: true });
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'shipping_quote_route_mismatch', tookMs: Date.now() - started });
      return res.status(200).json({ ok: false, error: 'shipping_quote_mismatch', message: 'The selected shipping route could not be verified. This order has been held for manual review.' });
    }

    const qty = Math.max(1, parseInt(order.quantity, 10) || 1);

    // ---- Live stock check right before creating the order (README §37 —
    // "do not rely on stale inventory for final order approval"). ----
    const stockR = await cjFetch('/product/stock/queryByVid', { query: { vid: cjMapping.variantId } });
    const data = stockR && stockR.data;
    const rows = Array.isArray(data) ? data
      : data && Array.isArray(data.list) ? data.list
      : data && Array.isArray(data.rows) ? data.rows
      : data && Array.isArray(data.byWarehouse) ? data.byWarehouse
      : data && Array.isArray(data.warehouseList) ? data.warehouseList
      : data && Array.isArray(data.inventories) ? data.inventories
      : data && Array.isArray(data.warehouses) ? data.warehouses
      : data && Array.isArray(data.data) ? data.data
      : data && typeof data === 'object' ? [data] : [];
    const stockOrigin = countryToIso2(order.delivery.shippingOriginCountry || quote.startCountryCode) || 'CN';
    const originRows = rows.filter(row => {
      const rawOrigin = row && (row.area ?? row.areaCode ?? row.countryCode ?? row.country ?? row.storageCountryCode ?? row.warehouseCountryCode);
      return countryToIso2(rawOrigin) === stockOrigin;
    });
    const originQty = originRows.reduce((sum, row) => {
      const rawQty = row && (row.storageNum ?? row.stockNum ?? row.num ?? row.quantity ?? row.qty ?? row.availableStock ?? row.inventoryNum ?? row.total ?? row.stock);
      const amount = Number(rawQty);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0);
    if (!stockR || !stockR.ok || !originRows.length || originQty < qty) {
      const issue = !stockR || !stockR.ok ? 'stock_unverified' : 'out_of_stock_at_selected_origin';
      await orderRef.set({ status: 'stock_issue', requiresManualReview: true, stockIssue: issue }, { merge: true });
      await writeSyncLog({
        event: 'order.create', objectId: reference, success: false,
        message: `Stock not verified at selected origin ${stockOrigin}: need ${qty}, have ${originQty}`,
        tookMs: Date.now() - started,
        detail: { issue, origin: stockOrigin },
      });
      return res.status(200).json({
        ok: false,
        error: issue,
        message: 'The selected warehouse can no longer fulfil this item. The order has been held for review; the route will not be silently changed.',
      });
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
    const requiredUSD = cjOrderAmountUSD(cjResult);
    const cj = {
      orderId: cjResult.orderId || cjResult.cjOrderId || null,
      shipmentOrderId: cjResult.shipmentOrderId || null,
      orderNumber: cjResult.orderNumber || payload.orderNumber,
      status: 'CREATED_UNPAID',
      fundingStatus: 'pending',
      requiredUSD,
      trackingNumber: '',
      carrier: '',
      variantId: cjMapping.variantId,
      sku: cjMapping.sku || null,
      quantity: qty,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!cj.orderId) {
      await orderRef.set({
        status: 'cj_order_failed',
        requiresManualReview: true,
        cjError: { message: 'CJ created the order response without an orderId.', code: 'MISSING_CJ_ORDER_ID', at: FieldValue.serverTimestamp() },
      }, { merge: true });
      await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: 'CJ response missing orderId', requestId: createR.requestId, tookMs });
      return res.status(200).json({ ok: false, error: 'cj_error', message: 'CJ did not return a usable supplier order id. The order has been held for admin review.' });
    }

    // Save the supplier order BEFORE attempting payment. If this process dies
    // after CJ created it, the retry sees cj.orderId and resumes payment only.
    await orderRef.set({ status: 'supplier_created', cj }, { merge: true });
    await writeSyncLog({ event: 'order.create', objectId: reference, success: true, message: `CJ order created: ${cj.orderId}`, requestId: createR.requestId, tookMs });

    const funded = await finishCjFunding({ reference, orderRef, order, cj, started });
    funded.alreadyCreated = false;
    return res.status(200).json(funded);
  } catch (e) {
    await writeSyncLog({ event: 'order.create', objectId: reference, success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'server_error', message: 'Unexpected error creating the supplier order.' });
  }
};

// Export the pure payload builder for focused unit tests; the default export remains the HTTP handler.
module.exports.buildCjOrderPayload = buildCjOrderPayload;
module.exports.canResumeSupplierOrderStatus = canResumeSupplierOrderStatus;
