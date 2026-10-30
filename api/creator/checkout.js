// api/creator/checkout.js
//
// Server-authoritative checkout rules for creator products. The browser is never trusted for
// price, stock, seller state or fees.
//   * checkAmount()   EXACT amount match in integer minor units (no 2% tolerance).
//   * checkSellable() product PUBLISHED and the seller ACTIVE at the moment of payment.
//   * settleStock()   consumes the reservation (or atomically reserves+consumes) exactly once.
//   * orderExceptions a paid order that cannot be honoured is NEVER silently fulfilled or
//                     dropped: it is recorded, flagged on the sale + fulfilment (so earnings stay
//                     held), and surfaced to admins with the buyer's remedy (refund).
const M = require('../core/money');
const inv = require('../inventory/service');

const EXCEPTION_CODES = Object.freeze({
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  SELLER_NOT_ACTIVE: 'SELLER_NOT_ACTIVE',
  NOT_FOR_SALE: 'NOT_FOR_SALE',
  STOCK_UNAVAILABLE_AFTER_PAYMENT: 'STOCK_UNAVAILABLE_AFTER_PAYMENT',
  SUPPLIER_FUNDING_UNAVAILABLE: 'SUPPLIER_FUNDING_UNAVAILABLE',
  DELIVERY_PROOF_PROBLEM: 'DELIVERY_PROOF_PROBLEM',
});

/**
 * expectedMajor comes from OUR catalogue.
 * paidMinor/requestedMinor come only from Paystack's server-side verify response.
 *
 * Paystack's "Pass fees to customers" setting may make `amount` larger than the
 * amount NOVA requested. In that case `requested_amount` remains the intended
 * transaction amount. We only accept that larger charge when requested_amount
 * exactly matches NOVA's authoritative expected amount.
 *
 * Crucially, paidMinor must NEVER be below expectedMinor even when
 * requested_amount matches. Paystack also exposes requested_amount for partial
 * debits, where the actual customer charge can be lower than requested.
 */
function checkAmount({ paidMinor, requestedMinor = null, expectedMajor }) {
  let expectedMinor;
  try { expectedMinor = M.toMinor(expectedMajor); } catch { return { ok: false, code: 'BAD_EXPECTED_AMOUNT' }; }

  const paid = Number(paidMinor);
  const requested = requestedMinor == null ? null : Number(requestedMinor);
  if (!Number.isSafeInteger(paid)) return { ok: false, code: 'BAD_PAID_AMOUNT', expectedMinor };

  if (paid < expectedMinor) {
    return { ok: false, code: 'AMOUNT_MISMATCH', expectedMinor, paidMinor: paid, requestedMinor: Number.isSafeInteger(requested) ? requested : null, direction: 'UNDERPAID' };
  }
  if (paid === expectedMinor) {
    return { ok: true, expectedMinor, paidMinor: paid, requestedMinor: Number.isSafeInteger(requested) ? requested : null, match: 'EXACT' };
  }
  if (Number.isSafeInteger(requested) && requested === expectedMinor) {
    return { ok: true, expectedMinor, paidMinor: paid, requestedMinor: requested, match: 'PAYSTACK_FEE_PASSTHROUGH' };
  }
  return { ok: false, code: 'AMOUNT_MISMATCH', expectedMinor, paidMinor: paid, requestedMinor: Number.isSafeInteger(requested) ? requested : null, direction: 'OVERPAID' };
}

async function checkSellable(db, productId) {
  const p = await db.collection('products').doc(productId).get();
  if (!p.exists) return { ok: false, code: EXCEPTION_CODES.NOT_FOR_SALE };
  const prod = p.data();
  if (prod.status !== 'PUBLISHED') return { ok: false, code: EXCEPTION_CODES.NOT_FOR_SALE, creatorId: prod.creatorId };
  const c = await db.collection('creators').doc(prod.creatorId).get();
  if (!c.exists || c.data().status !== 'ACTIVE') return { ok: false, code: EXCEPTION_CODES.SELLER_NOT_ACTIVE, creatorId: prod.creatorId };
  return { ok: true, creatorId: prod.creatorId };
}

const exId = (orderId, code) => `${String(orderId).replace(/[^A-Za-z0-9_\-]/g, '_')}__${code}`;

/** Idempotent (create-semantics): the same problem for the same order is recorded once. */
async function openException(db, { orderId, code, creatorId = null, productId = null, buyerUid = null, amountMinor = null, details = {}, nowMs = Date.now() }) {
  const ref = db.collection('orderExceptions').doc(exId(orderId, code));
  try {
    await ref.create({
      orderId, code, creatorId, productId, buyerUid, amountMinor, details, state: 'OPEN',
      buyerRemedy: 'REFUND_OR_ALTERNATIVE', createdAtMs: nowMs, resolvedAtMs: null, resolvedBy: null, resolution: null,
    });
    return { created: true, id: ref.id };
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) {
      // The same problem raised again AFTER it was resolved re-opens it, so the hold flags set by the
      // caller always have an OPEN exception that an admin can see and resolve.
      const cur = await ref.get();
      if (cur.exists && cur.data().state === 'RESOLVED') {
        await ref.set({ state: 'OPEN', reopenedAtMs: nowMs, reopenCount: (cur.data().reopenCount || 0) + 1, resolution: null, resolvedAtMs: null, resolvedBy: null, details }, { merge: true });
        return { created: false, reopened: true, id: ref.id };
      }
      return { created: false, id: ref.id };
    }
    throw e;
  }
}

async function listExceptions(db, { state = 'OPEN', limit = 100 } = {}) {
  const snap = await db.collection('orderExceptions').where('state', '==', state).limit(Math.min(limit, 500)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
}

/**
 * Closing an exception never moves money by itself. resolution is one of REFUNDED (a refund record
 * exists), FULFILLED_ANYWAY (admin confirmed the order can be honoured), CANCELLED. When the LAST
 * open exception on an order closes, the hold flag on the sale + fulfilment is lifted.
 */
async function resolveException(db, { id, resolution, actor, note = null, nowMs = Date.now() }) {
  if (!['REFUNDED', 'FULFILLED_ANYWAY', 'CANCELLED'].includes(resolution)) { const e = new Error('Invalid resolution.'); e.status = 422; throw e; }
  const ref = db.collection('orderExceptions').doc(id);
  const s = await ref.get();
  if (!s.exists) { const e = new Error('Not found.'); e.status = 404; throw e; }
  if (s.data().state !== 'OPEN') return { already: true };
  await ref.set({ state: 'RESOLVED', resolution, resolvedBy: actor || null, resolvedAtMs: nowMs, note: note ? String(note).slice(0, 500) : null }, { merge: true });
  const orderId = s.data().orderId;
  const still = await db.collection('orderExceptions').where('orderId', '==', orderId).where('state', '==', 'OPEN').limit(1).get();
  // Lift the hold when the LAST open exception closes as "fine to proceed" or "not a real problem".
  // REFUNDED keeps the hold (the order is being unwound). update() so a missing doc is never created as a stub.
  if (still.empty && (resolution === 'FULFILLED_ANYWAY' || resolution === 'CANCELLED')) {
    await db.collection('creatorSales').doc(orderId).update({ exceptionOpen: false }).catch(() => {});
    await db.collection('fulfillments').doc(orderId).update({ exceptionOpen: false }).catch(() => {});
  }
  return { already: false, orderFullyCleared: still.empty };
}

/** Physical seller-stock only; everything else has no unit stock to settle. */
async function settleStock(db, { orderId, selection, reservationId = null, nowMs = Date.now() }) {
  const c = selection && selection.creator;
  if (!c || c.offeringType !== 'PHYSICAL_PRODUCT' || (c.fulfillmentMode || 'SELLER_STOCK') !== 'SELLER_STOCK') return { ok: true, tracked: false };
  // The browser's checkout id IS the payment reference, so the hold is derivable server-side
  // (productId__reference). This keeps the webhook path (which has no body) consuming the buyer's own hold.
  const derived = `${String(c.productId).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120)}__${String(orderId).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120)}`;
  const out = await inv.consumeForOrder(db, { orderRef: orderId, productId: c.productId, reservationId: reservationId || derived, nowMs });
  if (out.ok) { await inv.refreshStockSummary(db, c.productId).catch(() => {}); return out; }
  await openException(db, { orderId, code: EXCEPTION_CODES.STOCK_UNAVAILABLE_AFTER_PAYMENT, creatorId: c.creatorId, productId: c.productId, details: { reason: out.code, message: out.message || null }, nowMs });
  return out;
}

module.exports = { EXCEPTION_CODES, checkAmount, checkSellable, openException, listExceptions, resolveException, settleStock };
