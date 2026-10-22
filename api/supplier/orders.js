// api/supplier/orders.js
//
// LEXDEN NOVA CREATOR — Stage G: fulfilling a paid creator order through the
// creator's OWN CJ account, and mirroring CJ's progress back onto the
// buyer-facing Stage E fulfillment.
//
//   paid order ──► createCjOrderForFulfillment ──► supplierOrders/{orderId}
//                                                    │ (CJ ids, errors, pay mode — creator/admin only)
//   CJ shipped ──► syncCjFulfillment ──► fulfillments/{orderId}  PENDING→PACKED→SHIPPED + tracking
//
// MONEY (blueprint §21): the CJ order is created in the CREATOR'S CJ account.
// NOVA never funds it. payType is 3 ("create only", the creator pays inside
// CJ) unless the creator explicitly opted in to automatic payment from their
// CJ balance, in which case it is 2. NOVA never pays out of its own money.
//
// IDEMPOTENCY (blueprint §85 — "if the same webhook arrives twice, NOVA must
// not create two CJ orders"): three layers.
//   1. supplierOrders/{orderId} is claimed in a transaction before any CJ
//      call; a second caller sees the claim and returns.
//   2. If a claim is stale (the process died mid-call), CJ is asked whether an
//      order with our deterministic orderNumber already exists, and that order
//      is ADOPTED instead of creating another.
//   3. A recorded cjOrderId short-circuits everything.
const { FieldValue } = require('../creator/shared');
const { FULFILLMENT_STATES, assertFulfillmentTransition, assertActorMayTransition, assertShippedRequiresTracking } = require('../creator/fulfillment-state-machine');
const { applyFulfillmentPatch } = require('../creator/fulfillment');
const { resolveShipment } = require('../creator/carriers');
const store = require('./store');
const { resolveCountry, planFulfillmentUpdate, normalizeFreightOptions, coded, isTransientCode, isAuthCode } = require('./mapping');

const CLAIM_TTL_MS = 2 * 60 * 1000; // longer than any single CJ call (12s) by a wide margin

const orderNumberFor = (orderId) => `NOVA-${orderId}`;

// Pure: the exact body sent to CJ's createOrderV2. Field names and which are
// required come from CJ's published API (shippingCountry AND
// shippingCountryCode, logisticName and fromCountryCode are all required).
function buildCjOrderPayload({ orderId, delivery, mapping, quantity, country, logisticName, payType }) {
  const d = delivery || {};
  return {
    orderNumber: orderNumberFor(orderId),
    shippingCountryCode: country.code,
    shippingCountry: country.name,
    shippingProvince: d.state || '',
    shippingCity: d.city || '',
    shippingAddress: d.address || '',
    shippingCustomerName: d.name || '',
    shippingPhone: d.phone || '',
    logisticName,
    fromCountryCode: 'CN',
    payType,
    remark: `LEXDEN NOVA order ${orderId}`,
    products: [{ vid: mapping.cjVariantId, quantity }],
  };
}

function missingDeliveryFields(d) {
  const need = [['name', 'recipient name'], ['address', 'street address'], ['city', 'city'], ['phone', 'phone number']];
  return need.filter(([k]) => !d || typeof d[k] !== 'string' || !d[k].trim()).map(([, label]) => label);
}

async function claimSupplierOrder(db, orderId, base, nowMs) {
  const ref = db.collection('supplierOrders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (cur && cur.cjOrderId) return { claimed: false, reason: 'ALREADY_CREATED', record: cur };
    if (cur && cur.status === 'CREATING' && cur.claimedAtMs && nowMs - cur.claimedAtMs < CLAIM_TTL_MS) {
      return { claimed: false, reason: 'IN_PROGRESS', record: cur };
    }
    tx.set(ref, {
      ...base, orderId, status: 'CREATING', claimedAtMs: nowMs,
      attempts: ((cur && cur.attempts) || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(), updatedAtMs: nowMs,
    }, { merge: true });
    return { claimed: true };
  });
}

// Records a failure the creator/admin must act on. Never throws, never
// touches the buyer-facing fulfillment (a failed supplier call is not the
// buyer's problem to see).
async function recordOrderFailure(db, { orderId, creatorId, code, message, status = 'NEEDS_ATTENTION' }) {
  await store.saveSupplierOrder(db, orderId, { creatorId, status, error: { code, message: String(message).slice(0, 300) }, lastAttemptAtMs: Date.now() });
  await store.patchConnection(db, creatorId, { lastOrderError: { orderId, code, message: String(message).slice(0, 200), atMs: Date.now() } }).catch(() => {});
  await store.writeSupplierLog(db, { creatorId, event: 'order.create', objectId: orderId, success: false, message: `${code}: ${message}` });
}

/**
 * Creates (or adopts) the CJ order for a paid creator order.
 * Returns { ok, alreadyCreated?, status, ... } and NEVER throws for an
 * expected supplier problem — those are recorded on supplierOrders/{id} and
 * surfaced to the creator/admin, because this runs in the background after a
 * payment that must not be affected.
 */
async function createCjOrderForFulfillment(db, orderId, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const [fulfillSnap, orderSnap] = await Promise.all([
    db.collection('fulfillments').doc(orderId).get(),
    db.collection('orders').doc(orderId).get(),
  ]);
  if (!fulfillSnap.exists || !orderSnap.exists) return { ok: false, status: 'UNKNOWN_ORDER' };
  const fulfillment = fulfillSnap.data();
  const order = orderSnap.data();
  const creatorId = fulfillment.creatorId;
  if (!creatorId) return { ok: false, status: 'NO_CREATOR' };
  if (order.status !== 'paid') return { ok: false, status: 'NOT_PAID' };
  if (fulfillment.status !== FULFILLMENT_STATES.PENDING) return { ok: false, status: 'NOT_PENDING' };

  const versionId = order.creatorVersionId || fulfillment.versionId;
  const claim = await claimSupplierOrder(db, orderId, { creatorId, versionId, provider: 'CJ', productId: fulfillment.productId }, nowMs);
  if (!claim.claimed) return { ok: true, alreadyCreated: claim.reason === 'ALREADY_CREATED', status: claim.record.status, cjOrderId: claim.record.cjOrderId || null };

  const fail = async (code, message, status) => {
    await recordOrderFailure(db, { orderId, creatorId, code, message, status });
    return { ok: false, status: status || 'NEEDS_ATTENTION', code, message };
  };

  // FUNDING GATE: decided BEFORE any CJ call. See api/supplier/funding.js.
  const funding = require('./funding').evaluateFunding(deps.env || process.env, fulfillment);
  if (!funding.allowed) {
    await require('./funding').holdUnfundedOrder(db, { orderId, creatorId, productId: fulfillment.productId, buyerUid: fulfillment.buyerUid, funding, nowMs });
    return await fail(funding.code, funding.message, 'FUNDING_BLOCKED');
  }

  try {
    const mapping = await store.getMapping(db, versionId);
    if (!mapping || mapping.status !== 'VALID') return await fail('MAPPING_INVALID', 'This listing has no valid CJ mapping.');

    const missing = missingDeliveryFields(fulfillment.delivery);
    if (missing.length) return await fail('DELIVERY_INCOMPLETE', `The buyer's delivery details are missing: ${missing.join(', ')}.`);
    const country = resolveCountry(fulfillment.delivery.country);
    if (!country.code) return await fail('UNSUPPORTED_COUNTRY', `Cannot ship to "${country.name}" — the country is not recognised.`);
    const logisticName = mapping.logisticByCountry && mapping.logisticByCountry[country.code];
    if (!logisticName) return await fail('DESTINATION_NOT_SUPPORTED', `This listing's CJ mapping was not tested for shipping to ${country.name}.`);

    let built;
    try {
      built = await store.buildClientForCreator(db, creatorId, deps);
    } catch (e) {
      // Orders are arriving for a listing whose supplier connection is gone:
      // stop selling it as well as flagging this order.
      require('./service').checkMappingHealth(db, { productId: fulfillment.productId, minGapMs: 0 }, deps).catch(() => {});
      return await fail(e.code || 'SUPPLIER_NOT_CONNECTED', 'The creator\'s CJ connection is not active.');
    }
    const { client, connection } = built;
    const orderNumber = orderNumberFor(orderId);

    // Layer 2 of idempotency: did a previous, interrupted attempt already
    // create this order at CJ? (CJ accepts our own order number as the id.)
    const existing = await client.call('/shopping/order/getOrderDetail', { query: { orderId: orderNumber } });
    if (existing.ok && existing.data && (existing.data.orderId || existing.data.cjOrderId)) {
      const cjOrderId = existing.data.orderId || existing.data.cjOrderId;
      await store.saveSupplierOrder(db, orderId, {
        creatorId, versionId, provider: 'CJ', status: 'ORDERED', cjOrderId, cjOrderNumber: orderNumber,
        cjStatus: existing.data.orderStatus || null, adopted: true, error: null, claimedAtMs: null,
      });
      await store.writeSupplierLog(db, { creatorId, event: 'order.adopt', objectId: orderId, success: true, message: `Adopted CJ order ${cjOrderId}` });
      return { ok: true, alreadyCreated: true, status: 'ORDERED', cjOrderId };
    }

    // Live stock right before ordering — never rely on a stale mapping test.
    const quantity = 1;
    const stockR = await client.call('/product/stock/queryByVid', { query: { vid: mapping.cjVariantId } });
    if (stockR.ok) {
      const rows = Array.isArray(stockR.data) ? stockR.data : [stockR.data];
      const total = rows.reduce((s, r) => s + (Number(r && (r.storageNum ?? r.stockNum ?? r.num ?? r.availableQty)) || 0), 0);
      if (total < quantity) {
        require('./service').checkMappingHealth(db, { productId: fulfillment.productId, minGapMs: 0 }, deps).catch(() => {});
        return await fail('OUT_OF_STOCK', 'CJ is out of stock for this variant — the order was not placed.', 'STOCK_ISSUE');
      }
    } else if (!isTransientCode(stockR.code)) {
      return await fail('STOCK_CHECK_FAILED', stockR.message || 'Could not check CJ stock.');
    }

    const payType = connection.autoPay && connection.autoPay.enabled ? 2 : 3;
    const payload = buildCjOrderPayload({ orderId, delivery: fulfillment.delivery, mapping, quantity, country, logisticName, payType });
    const createR = await client.call('/shopping/order/createOrderV2', { method: 'POST', body: payload });
    if (!createR.ok) {
      const retriable = isTransientCode(createR.code);
      return await fail(retriable ? 'SUPPLIER_UNAVAILABLE' : 'CJ_ORDER_REJECTED', createR.message || 'CJ did not accept the order.', retriable ? 'RETRY_LATER' : 'NEEDS_ATTENTION');
    }

    const data = createR.data || {};
    const cjOrderId = data.orderId || data.cjOrderId || null;
    await store.saveSupplierOrder(db, orderId, {
      creatorId, versionId, provider: 'CJ', status: 'ORDERED', cjOrderId, cjOrderNumber: data.orderNumber || orderNumber,
      cjStatus: data.orderStatus || 'CREATED', payType, paidFromCjBalance: payType === 2, logisticName,
      fundingMode: funding.mode, paymentState: funding.mode === 'NOVA_FUNDED' ? 'NOVA_FUNDING_ATTESTED_BY_ADMIN' : (payType === 2 ? 'AUTO_PAY_REQUESTED' : 'AWAITING_CREATOR_PAYMENT_IN_CJ'),
      error: null, claimedAtMs: null, createdAtMs: nowMs,
    });
    await store.writeSupplierLog(db, { creatorId, event: 'order.create', objectId: orderId, success: true, message: `CJ order ${cjOrderId}` });
    await store.writeProductAudit(db, { actorUid: null, actorRole: 'system', action: 'supplier.order_created', productId: fulfillment.productId, versionId, metadata: { orderId, cjOrderId, payType } });
    return { ok: true, alreadyCreated: false, status: 'ORDERED', cjOrderId, payType };
  } catch (e) {
    return fail('SERVER_ERROR', e.message || 'Unexpected error creating the supplier order.', 'RETRY_LATER');
  }
}

/**
 * Pulls CJ's current state for the order and applies the SAFE part of it to
 * the buyer-facing fulfillment (see planFulfillmentUpdate for the rules).
 */
async function syncCjFulfillment(db, orderId, deps = {}) {
  const so = await store.getSupplierOrder(db, orderId);
  if (!so || !so.cjOrderId) throw coded('There is no CJ order for this order yet.', 'NO_SUPPLIER_ORDER', 409);
  const fulfillSnap = await db.collection('fulfillments').doc(orderId).get();
  if (!fulfillSnap.exists) throw coded('No fulfillment found.', 'NOT_FOUND', 404);
  const fulfillment = fulfillSnap.data();

  const { client } = await store.buildClientForCreator(db, so.creatorId, deps);
  const r = await client.call('/shopping/order/getOrderDetail', { query: { orderId: so.cjOrderId } });
  if (!r.ok) {
    if (isAuthCode(r.code)) await store.patchConnection(db, so.creatorId, { status: 'AUTH_FAILED', lastError: 'CJ rejected the stored credentials. Reconnect your CJ account.' });
    throw coded(isTransientCode(r.code) ? 'CJ could not be reached right now. Try again shortly.' : (r.message || 'CJ did not return the order.'), isTransientCode(r.code) ? 'SUPPLIER_UNAVAILABLE' : 'SUPPLIER_ERROR', 502);
  }

  const cj = r.data || {};
  const plan = planFulfillmentUpdate(fulfillment.status, {
    orderStatus: cj.orderStatus, trackNumber: cj.trackNumber, logisticName: cj.logisticName, trackingUrl: cj.trackingUrl,
  });

  let current = fulfillment.status;
  const applied = [];
  for (const step of plan.transitions) {
    assertFulfillmentTransition(current, step.to);
    assertActorMayTransition('system', step.to);
    const extra = {};
    if (step.to === FULFILLMENT_STATES.SHIPPED) {
      assertShippedRequiresTracking({ carrier: step.carrier, trackingNumber: step.trackingNumber });
      // Same rules as a seller typing it in: sane number, http(s)-only link.
      const ship = resolveShipment({ carrier: step.carrier, trackingNumber: step.trackingNumber, trackingUrl: step.trackingUrl });
      if (!ship.ok) {
        await store.saveSupplierOrder(db, orderId, { cjStatus: plan.supplierPatch.cjStatus, note: 'CJ returned a tracking number NOVA could not accept; enter it manually.' });
        break;
      }
      Object.assign(extra, { carrier: ship.carrier, trackingNumber: ship.trackingNumber, trackingUrl: ship.trackingUrl });
    }
    await applyFulfillmentPatch(db, orderId, step.to, extra);
    await store.writeProductAudit(db, { actorUid: null, actorRole: 'system', action: `fulfillment.cj_${step.to.toLowerCase()}`, productId: fulfillment.productId, metadata: { orderId, cjOrderId: so.cjOrderId } });
    current = step.to;
    applied.push(step.to);
  }

  // The carrier says delivered: record it as its OWN evidence source (separate from the
  // buyer's confirmation) with the CJ order as the provider reference. Idempotent.
  if (plan.supplierPatch.carrierDelivered) {
    await require('../creator/fulfillment').recordDeliveryEvidence(db, orderId, { source: 'CARRIER', atMs: (deps.now || Date.now)(), reference: so.cjOrderId });
  }
  await store.saveSupplierOrder(db, orderId, { ...plan.supplierPatch, lastSyncAtMs: (deps.now || Date.now)() });
  await store.patchConnection(db, so.creatorId, { lastSyncAtMs: (deps.now || Date.now)() });
  return { cjStatus: plan.supplierPatch.cjStatus, supplierStatus: plan.supplierPatch.status || so.status, fulfillmentStatus: current, applied, note: plan.supplierPatch.note || null };
}

module.exports = {
  createCjOrderForFulfillment, syncCjFulfillment,
  buildCjOrderPayload, missingDeliveryFields, claimSupplierOrder, orderNumberFor, CLAIM_TTL_MS,
  normalizeFreightOptions,
};
