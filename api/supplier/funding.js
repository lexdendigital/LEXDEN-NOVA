// api/supplier/funding.js
//
// WHO PAYS CJ is a money decision, so it is explicit and fail-safe. NOVA never silently falls
// back to "the creator pays in their own CJ account" (the legacy payType 3 behaviour) because the
// buyer has already paid NOVA: if nobody funds the supplier order, the buyer is waiting on a
// parcel that will never be bought.
//   DISABLED         (default) no CJ call is made. The order is held, an operator-visible exception is
//                    opened and the buyer's remedy (refund / alternative) is recorded.
//   CREATOR_ACCOUNT  explicit opt-in. The order is created in the creator's own CJ account. The record
//                    says truthfully whether payment is still awaited or auto-pay was requested.
//   NOVA_FUNDED      NOVA pays. No CJ payment adapter exists, so an admin attests per order (confirmNovaFunding);
//                    until then the order stays held. The attestation is NOT verified with CJ and says so.
const cfg = require('../core/config');
const checkout = require('../creator/checkout');

function evaluateFunding(env = process.env, fulfillment = null) {
  const mode = cfg.flags(env).cjFundingMode;
  if (mode === 'CREATOR_ACCOUNT') return { allowed: true, mode };
  if (mode === 'NOVA_FUNDED') {
    // NOVA pays the supplier itself. There is no CJ payment adapter, so an ADMIN attests, per order,
    // that NOVA has funded (or will fund) it. Until then nothing is sent to CJ.
    const nf = fulfillment && fulfillment.novaFunding;
    if (nf && nf.confirmed === true) return { allowed: true, mode, attestedBy: nf.confirmedBy || null };
    return { allowed: false, mode, code: 'NOVA_FUNDING_PENDING', message: 'Waiting for NOVA to fund this supplier order. An admin must confirm funding before it is sent.' };
  }
  return { allowed: false, mode: 'DISABLED', code: 'CJ_FUNDING_DISABLED', message: 'Supplier order funding is not enabled, so the supplier order was NOT placed. The buyer must be offered a refund or alternative.' };
}

/** Holds the order + records the buyer remedy. Idempotent. Never throws. */
async function holdUnfundedOrder(db, { orderId, creatorId, productId, buyerUid = null, funding, nowMs = Date.now() }) {
  try {
    await checkout.openException(db, { orderId, code: checkout.EXCEPTION_CODES.SUPPLIER_FUNDING_UNAVAILABLE, creatorId, productId, buyerUid, details: { fundingMode: funding.mode, reason: funding.code }, nowMs });
    await db.collection('fulfillments').doc(orderId).update({ exceptionOpen: true });
    await db.collection('creatorSales').doc(orderId).update({ exceptionOpen: true }).catch(() => {});
  } catch (e) { console.error('holdUnfundedOrder failed:', e && e.message); }
}

/** Admin attests NOVA has funded this order. Mode must be NOVA_FUNDED. Does not call CJ and does not move money. */
async function confirmNovaFunding(db, { orderId, adminUid, reference, note = null, env = process.env, nowMs = Date.now() }) {
  const err = (status, code, message) => Object.assign(new Error(message), { status, code });
  if (cfg.flags(env).cjFundingMode !== 'NOVA_FUNDED') throw err(409, 'NOT_NOVA_FUNDED_MODE', 'CJ_FUNDING_MODE is not NOVA_FUNDED.');
  if (String(reference || '').trim().length < 3) throw err(422, 'REFERENCE_REQUIRED', 'Enter the CJ payment/reference you used (at least 3 characters).');
  const ref = db.collection('fulfillments').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw err(404, 'UNKNOWN_ORDER', 'Order not found.');
  const f = snap.data();
  if (f.novaFunding && f.novaFunding.confirmed) return { already: true };
  await ref.set({ novaFunding: { confirmed: true, confirmedBy: adminUid, confirmedAtMs: nowMs, reference: String(reference).slice(0, 80), note: note ? String(note).slice(0, 300) : null, verifiedWithCj: false } }, { merge: true });
  const exs = await db.collection('orderExceptions').where('orderId', '==', orderId).where('state', '==', 'OPEN').limit(10).get();
  for (const d of exs.docs) {
    if (d.data().code === checkout.EXCEPTION_CODES.SUPPLIER_FUNDING_UNAVAILABLE) await checkout.resolveException(db, { id: d.id, resolution: 'FULFILLED_ANYWAY', actor: adminUid, note: 'NOVA funding confirmed by admin.', nowMs });
  }
  return { already: false };
}

module.exports = { evaluateFunding, holdUnfundedOrder, confirmNovaFunding };
