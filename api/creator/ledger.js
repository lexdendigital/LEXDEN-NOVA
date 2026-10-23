// api/creator/ledger.js
//
// LEXDEN NOVA CREATOR — the earning side of the money ledger.
//
// WHAT CHANGED (implementation prompt Part I §1, §2, §7):
//  * The creator commission is the approved 10% of the ELIGIBLE sale subtotal,
//    computed in integer minor units by api/core/money.js and stored as an
//    immutable feeSnapshot on the sale (rate, basis, amounts). A later rate change
//    never rewrites an existing sale; refunds always use the sale's own snapshot.
//  * A PHYSICAL sale is credited as HELD with releaseGate:'DELIVERY'. A timer can
//    never release it: only authoritative delivery evidence (carrier, buyer
//    confirmation, one-time code, admin-verified exception) starts the
//    buyer-protection clock (markDelivered), and releaseDueHolds only releases a
//    sale whose clock has started and has expired with no open dispute/exception.
//    Digital goods and services keep the optional creatorHoldDays timer.
//  * Freezing a sale for a dispute is race-safe and never double-deducts: it runs in
//    a transaction together with opening the dispute (api/creator-disputes.js) and,
//    if the money has already been reserved/paid out by a withdrawal, it does NOT
//    push the balance negative — it marks the sale fundsAlreadyWithdrawn and records
//    a ledgerExceptions row for an admin to recover under the approved policy.
//  * Refund reversal is proportional, cumulative and idempotent per refundId.
//
// This is NOT an escrow. Earnings are "pending" until release conditions are met;
// nothing here claims NOVA holds buyer funds in trust (see policy 04/05/16).
//
// Balance/earnings fields live on creatorPrivate/{uid}, NEVER on creators/{uid}
// (that doc is the public storefront profile). Balance fields are still stored in
// major units for compatibility with the existing UI/reconciliation; every value
// written here is derived from exact integer minor units (and mirrored as *Minor
// on the sale) so no float drift is introduced.
const { getDb: sharedGetDb, FieldValue } = require('./shared');
const cfg = require('../core/config');
const M = require('../core/money');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HOLD_DAYS = 60;
const DEFAULT_PLATFORM_FEE_PCT = cfg.CREATOR_COMMISSION_BPS / 100; // 10 (kept for callers that display it)

// Pure, kept for backward compatibility with callers/tests. Exact for 2dp amounts.
function splitByFeePct(amount, pct) {
  const minor = M.toMinor(amount);
  const feeMinor = M.percentOfMinor(minor, Math.round(pct * 100));
  return { feeAmount: M.toMajor(feeMinor), netAmount: M.toMajor(minor - feeMinor) };
}

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;
const errOf = (status, code, message) => Object.assign(new Error(message), { status, code });

async function getSettingsContent(db) {
  const snap = await db.collection('catalog').doc('settings').get();
  return (snap.exists && snap.data().content) || {};
}

async function getHoldDays(db) {
  const c = await getSettingsContent(db);
  const n = Number(c.creatorHoldDays);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_HOLD_DAYS) : 0;
}

/** The sale's immutable fee snapshot; legacy sales (major units only) get a derived one. */
function snapshotOfSale(sale) {
  if (sale.feeSnapshot && Number.isSafeInteger(sale.feeSnapshot.eligibleSubtotalMinor)) return sale.feeSnapshot;
  const eligibleSubtotalMinor = M.toMinor(num(sale.saleAmount));
  const commissionMinor = M.toMinor(num(sale.platformFeeAmount));
  return { legacy: true, eligibleSubtotalMinor, commissionMinor, creatorNetMinor: eligibleSubtotalMinor - commissionMinor, commissionBps: Math.round(num(sale.platformFeePct) * 100) };
}

// ---------------------------------------------------------------------------
// Crediting a sale
// ---------------------------------------------------------------------------
// Idempotent on `reference`: the sale doc is created in a transaction that only
// credits the balance if it did not already exist, so a retried verify-paystack
// call or a replayed webhook can never double-credit (or double-charge the fee).
async function attributeCreatorEarning(db, { reference, creatorId, productId, productTitle, offeringType, amountMajor, currency, fulfillmentMode, deliveryMajor = 0, taxMajor = 0, itemDiscountMajor = 0, exceptionOpen = false }) {
  if (!creatorId) return { credited: false, reason: 'NO_CREATOR' };
  if (!amountMajor || amountMajor <= 0) return { credited: false, reason: 'FREE' };

  const content = await getSettingsContent(db);
  const bps = cfg.resolveCreatorCommissionBps(content);
  const paidMinor = M.toMinor(amountMajor);
  const deliveryMinor = M.toMinor(deliveryMajor);
  const taxMinor = M.toMinor(taxMajor);
  const itemDiscountMinor = M.toMinor(itemDiscountMajor);
  // The buyer paid `paidMinor`; delivery/tax collected for others are not commissionable.
  const merchandiseMinor = paidMinor - deliveryMinor - taxMinor + itemDiscountMinor;
  const snapshot = M.computeCreatorSale({ merchandiseMinor, itemDiscountMinor, deliveryMinor, taxMinor, bps });
  if (snapshot.creatorNetMinor <= 0) return { credited: false, reason: 'ZERO_EARNING' };

  const category = cfg.disputeCategoryFor(offeringType);
  const physical = category === 'PHYSICAL';
  const holdDays = !physical && typeof content.creatorHoldDays === 'number' && content.creatorHoldDays > 0 ? Math.min(Math.floor(content.creatorHoldDays), MAX_HOLD_DAYS) : 0;
  const protectionDays = cfg.resolveProtectionDays(content);
  const nowMs = Date.now();
  const earning = M.toMajor(snapshot.creatorNetMinor);
  const held = physical || holdDays > 0;

  const saleRef = db.collection('creatorSales').doc(reference);
  const privRef = db.collection('creatorPrivate').doc(creatorId);
  const credited = await db.runTransaction(async (tx) => {
    const existing = await tx.get(saleRef);
    if (existing.exists) return false;
    tx.set(saleRef, {
      creatorId,
      productId: productId || null,
      productTitle: productTitle || null,
      offeringType: offeringType || null,
      fulfillmentMode: fulfillmentMode || null,
      orderId: reference,
      saleAmount: M.toMajor(snapshot.eligibleSubtotalMinor),
      buyerPaidAmount: M.toMajor(snapshot.buyerPaidMinor),
      currency: currency || null,
      platformFeePct: bps / 100,
      platformFeeAmount: M.toMajor(snapshot.commissionMinor),
      creatorEarning: earning,
      saleAmountMinor: snapshot.eligibleSubtotalMinor,
      platformFeeMinor: snapshot.commissionMinor,
      creatorEarningMinor: snapshot.creatorNetMinor,
      feeSnapshot: { ...snapshot },
      disputePolicy: cfg.disputePolicySnapshot(offeringType),
      status: held || exceptionOpen ? 'held' : 'available',
      ...(exceptionOpen ? { exceptionOpen: true } : {}),
      ...(physical
        ? { releaseGate: 'DELIVERY', holdReason: 'AWAITING_DELIVERY', protectionDays, releaseAtMs: null }
        : (holdDays ? { releaseGate: 'TIMER', releaseAtMs: nowMs + holdDays * DAY_MS, holdDays } : { releaseGate: 'NONE' })),
      refundedEligibleMinor: 0,
      createdAtMs: nowMs,
      createdAt: FieldValue.serverTimestamp(),
    });
    // set+merge so a missing creatorPrivate doc is initialised, not a NOT_FOUND.
    tx.set(privRef, held
      ? { balancePending: FieldValue.increment(earning), totalEarned: FieldValue.increment(earning) }
      : { balanceAvailable: FieldValue.increment(earning), totalEarned: FieldValue.increment(earning) }, { merge: true });
    return true;
  });
  return { credited, creatorEarning: earning, commissionMinor: snapshot.commissionMinor, held, releaseGate: physical ? 'DELIVERY' : 'TIMER_OR_NONE' };
}

// ---------------------------------------------------------------------------
// Delivery-gated release
// ---------------------------------------------------------------------------
/**
 * Records delivery evidence on the sale and (for authoritative evidence only)
 * starts the buyer-protection clock. Idempotent: the first authoritative evidence
 * wins; later evidence is appended to the audit trail but never moves the date.
 */
async function markDelivered(db, orderId, { atMs = Date.now(), source }) {
  const saleRef = db.collection('creatorSales').doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) return { updated: false, reason: 'NO_SALE' };
    const sale = snap.data();
    const evidence = Array.isArray(sale.deliveryEvidence) ? sale.deliveryEvidence.slice(-9) : [];
    evidence.push({ source, atMs });
    const patch = { deliveryEvidence: evidence };
    let started = false;
    if (sale.releaseGate === 'DELIVERY' && sale.status === 'held' && sale.releaseAtMs == null && cfg.isAuthoritativeEvidence(source)) {
      patch.deliveredAtMs = atMs;
      patch.deliveryEvidenceSource = source;
      patch.releaseAtMs = atMs + num(sale.protectionDays != null ? sale.protectionDays : cfg.DEFAULT_PROTECTION_DAYS_AFTER_DELIVERY) * DAY_MS;
      patch.holdReason = 'BUYER_PROTECTION_PERIOD';
      started = true;
    }
    tx.set(saleRef, patch, { merge: true });
    return { updated: true, releaseClockStarted: started, releaseAtMs: patch.releaseAtMs || sale.releaseAtMs || null };
  });
}

// Moves ONE held sale to available. Idempotent (re-checks status inside the transaction)
// and refuses a delivery-gated sale whose clock has not started or has not expired.
async function releaseSale(db, saleId, nowMs = Date.now()) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists || snap.data().status !== 'held') return false;
    const sale = snap.data();
    if (sale.releaseGate === 'DELIVERY' && (sale.releaseAtMs == null || !cfg.isAuthoritativeEvidence(sale.deliveryEvidenceSource))) return false;
    if (sale.releaseAtMs != null && num(sale.releaseAtMs) > nowMs) return false;
    if (sale.exceptionOpen === true) return false;
    const earning = num(sale.creatorEarning);
    tx.set(saleRef, { status: 'available', releasedAtMs: nowMs, holdReason: null }, { merge: true });
    tx.set(db.collection('creatorPrivate').doc(sale.creatorId), {
      balancePending: FieldValue.increment(-earning),
      balanceAvailable: FieldValue.increment(earning),
    }, { merge: true });
    return true;
  });
}

async function releaseDueHolds(db, nowMs, limit = 200) {
  const snap = await db.collection('creatorSales').where('status', '==', 'held').limit(1000).get();
  // Reconciliation with the fulfilment record: if authoritative delivery evidence exists
  // there but the ledger clock never started (a failed sync), start it now. This is the
  // ONLY way a delivery-gated sale moves, and it needs evidence, never just age.
  let resynced = 0;
  for (const d of snap.docs) {
    const s = d.data();
    if (s.releaseGate !== 'DELIVERY' || s.releaseAtMs != null) continue;
    const f = await db.collection('fulfillments').doc(d.id).get();
    if (!f.exists) continue;
    const fd = f.data();
    const evidence = [];
    if (fd.deliveredAtMs && cfg.isAuthoritativeEvidence(fd.deliveryEvidenceSource)) evidence.push({ source: fd.deliveryEvidenceSource, atMs: fd.deliveredAtMs });
    for (const e of (Array.isArray(fd.evidenceTrail) ? fd.evidenceTrail : [])) if (cfg.isAuthoritativeEvidence(e.source)) evidence.push({ source: e.source, atMs: e.atMs });
    if (evidence.length) {
      const first = evidence.sort((a, b) => a.atMs - b.atMs)[0];
      const r = await markDelivered(db, d.id, first);
      if (r.releaseClockStarted) resynced += 1;
    }
  }
  const fresh = resynced ? await db.collection('creatorSales').where('status', '==', 'held').limit(1000).get() : snap;
  // A sale with no releaseAtMs (awaiting delivery) is NEVER due, whatever its age.
  const due = fresh.docs.filter((d) => { const s = d.data(); return s.releaseAtMs != null && num(s.releaseAtMs) <= nowMs; }).slice(0, limit);
  const awaitingDelivery = fresh.docs.filter((d) => d.data().releaseAtMs == null).length;
  let released = 0;
  for (const d of due) { if (await releaseSale(db, d.id, nowMs)) released += 1; }
  return { held: fresh.docs.length, awaitingDelivery, resynced, released };
}

// ---------------------------------------------------------------------------
// Dispute freeze / unfreeze (race-safe)
// ---------------------------------------------------------------------------
/**
 * PURE planner used inside a transaction. Given the sale and the creator's private
 * doc as read in that transaction, returns the writes to apply — or a refusal.
 * It never lets balanceAvailable go negative: if the available balance cannot
 * cover the sale (money already reserved by / paid out through a withdrawal) the
 * sale is frozen WITHOUT touching balances and a recovery exception is raised.
 */
function planFreeze(sale, priv, { disputeId, nowMs = Date.now() }) {
  if (!sale) return { ok: false, reason: 'NO_SALE' };
  if (sale.status === 'disputed') return { ok: true, already: true, saleUpdate: null, privUpdate: null };
  if (sale.status !== 'available' && sale.status !== 'held') return { ok: false, reason: 'NOT_FREEZABLE' };
  const earning = num(sale.creatorEarning);
  const saleUpdate = { status: 'disputed', frozenFrom: sale.status, disputeId: disputeId || null, frozenAtMs: nowMs };
  let privUpdate = null; let exception = null;
  if (sale.status === 'available') {
    if (num(priv && priv.balanceAvailable) + 1e-9 >= earning) {
      privUpdate = { balanceAvailable: FieldValue.increment(-earning), balancePending: FieldValue.increment(earning) };
    } else {
      saleUpdate.fundsAlreadyWithdrawn = true;
      exception = { type: 'DISPUTE_AFTER_WITHDRAWAL', creatorId: sale.creatorId, orderId: sale.orderId, amount: earning, availableAtFreeze: round2(num(priv && priv.balanceAvailable)), disputeId: disputeId || null };
    }
  }
  return { ok: true, saleUpdate, privUpdate, exception };
}

async function freezeSale(db, saleId, disputeId) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) return { frozen: false, reason: 'NO_SALE' };
    const sale = snap.data();
    const privRef = db.collection('creatorPrivate').doc(sale.creatorId);
    const priv = (await tx.get(privRef)).data() || {};
    const plan = planFreeze(sale, priv, { disputeId });
    if (!plan.ok) return { frozen: false, reason: plan.reason };
    if (plan.already) return { frozen: true, already: true };
    tx.set(saleRef, plan.saleUpdate, { merge: true });
    if (plan.privUpdate) tx.set(privRef, plan.privUpdate, { merge: true });
    if (plan.exception) tx.set(db.collection('ledgerExceptions').doc(`dispute_${saleId}`), { ...plan.exception, status: 'OPEN', createdAtMs: Date.now() }, { merge: true });
    return { frozen: true, fundsAlreadyWithdrawn: !!plan.saleUpdate.fundsAlreadyWithdrawn };
  });
}

// Dispute rejected: the earning goes back where it came from. Returns restored:false
// (never throws) when the sale was not in a disputed state, so callers MUST check it.
async function unfreezeSale(db, saleId, nowMs = Date.now()) {
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists || snap.data().status !== 'disputed') return { restored: false, reason: snap.exists ? 'NOT_DISPUTED' : 'NO_SALE' };
    const sale = snap.data();
    const clear = { disputeId: null, frozenFrom: null, frozenAtMs: null, fundsAlreadyWithdrawn: false };
    const exRef = db.collection('ledgerExceptions').doc(`dispute_${saleId}`);
    if (sale.fundsAlreadyWithdrawn) {
      // The earning had already been paid out; the dispute failed, so it simply stands.
      tx.set(saleRef, { ...clear, status: 'available' }, { merge: true });
      tx.set(exRef, { status: 'CLOSED_NO_ACTION', closedAtMs: nowMs }, { merge: true });
      return { restored: true, to: 'available', balanceMoved: false };
    }
    // A delivery-gated or timed sale that is still inside its protection period goes back to held.
    const backToHeld = sale.frozenFrom === 'held' && (sale.exceptionOpen === true || sale.releaseAtMs == null || num(sale.releaseAtMs) > nowMs);
    if (backToHeld) { tx.set(saleRef, { ...clear, status: 'held' }, { merge: true }); return { restored: true, to: 'held', balanceMoved: false }; }
    const earning = num(sale.creatorEarning);
    tx.set(saleRef, { ...clear, status: 'available', releasedAtMs: nowMs }, { merge: true });
    tx.set(db.collection('creatorPrivate').doc(sale.creatorId), {
      balancePending: FieldValue.increment(-earning), balanceAvailable: FieldValue.increment(earning),
    }, { merge: true });
    return { restored: true, to: 'available', balanceMoved: true };
  });
}

// ---------------------------------------------------------------------------
// Refund reversal (proportional, cumulative, idempotent per refundId)
// ---------------------------------------------------------------------------
/**
 * Reverses the creator's share for a refund of `refundEligibleMinor` of the eligible
 * subtotal (omit for "everything still unrefunded"). Applying the same refundId twice
 * is a no-op. Never drives balanceAvailable negative: any part the creator has already
 * withdrawn is recorded as recoveryDue for an admin to handle under the approved policy.
 */
async function applyRefundToSale(db, saleId, { refundId, refundEligibleMinor = null, nowMs = Date.now() } = {}) {
  if (!refundId) throw errOf(422, 'REFUND_ID_REQUIRED', 'A refund id is required for idempotency.');
  const saleRef = db.collection('creatorSales').doc(saleId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(saleRef);
    if (!snap.exists) return { refunded: false, reason: 'NO_SALE' };
    const sale = snap.data();
    if (sale.refundsApplied && sale.refundsApplied[refundId]) return { refunded: true, already: true, ...sale.refundsApplied[refundId] };
    if (sale.status === 'refunded') return { refunded: true, already: true };
    const snapshot = snapshotOfSale(sale);
    const done = num(sale.refundedEligibleMinor);
    const remaining = snapshot.eligibleSubtotalMinor - done;
    const amount = refundEligibleMinor == null ? remaining : refundEligibleMinor;
    if (amount <= 0 || amount > remaining) return { refunded: false, reason: 'AMOUNT_OUT_OF_RANGE' };
    const rev = M.reverseForRefund(snapshot, { refundEligibleMinor: amount, alreadyRefundedEligibleMinor: done });
    const earningReversed = M.toMajor(rev.creatorNetReversedMinor);
    const privRef = db.collection('creatorPrivate').doc(sale.creatorId);
    const priv = (await tx.get(privRef)).data() || {};

    const pending = sale.status === 'held' || sale.status === 'disputed';
    let takeFromBalance = 0; let recovery = 0; let privUpdate;
    if (pending && !sale.fundsAlreadyWithdrawn) {
      privUpdate = { balancePending: FieldValue.increment(-earningReversed), totalEarned: FieldValue.increment(-earningReversed) };
    } else if (sale.fundsAlreadyWithdrawn) {
      recovery = earningReversed;
      privUpdate = { totalEarned: FieldValue.increment(-earningReversed), recoveryDue: FieldValue.increment(recovery) };
    } else {
      takeFromBalance = Math.min(Math.max(0, num(priv.balanceAvailable)), earningReversed);
      recovery = round2(earningReversed - takeFromBalance);
      privUpdate = { balanceAvailable: FieldValue.increment(-takeFromBalance), totalEarned: FieldValue.increment(-earningReversed), ...(recovery > 0 ? { recoveryDue: FieldValue.increment(recovery) } : {}) };
    }

    const newDone = done + amount;
    const full = newDone === snapshot.eligibleSubtotalMinor;
    const remainingEarningMinor = (snapshot.creatorNetMinor) - ((sale.netReversedMinor || 0) + rev.creatorNetReversedMinor);
    const applied = { refundEligibleMinor: amount, commissionReversedMinor: rev.commissionReversedMinor, creatorNetReversedMinor: rev.creatorNetReversedMinor, recoveryDue: recovery, atMs: nowMs };
    tx.set(saleRef, {
      refundedEligibleMinor: newDone,
      commissionReversedMinor: (sale.commissionReversedMinor || 0) + rev.commissionReversedMinor,
      netReversedMinor: (sale.netReversedMinor || 0) + rev.creatorNetReversedMinor,
      creatorEarning: M.toMajor(remainingEarningMinor),
      platformFeeAmount: M.toMajor(snapshot.commissionMinor - ((sale.commissionReversedMinor || 0) + rev.commissionReversedMinor)),
      ...(recovery > 0 ? { recoveryDueAmount: round2(num(sale.recoveryDueAmount) + recovery) } : {}),
      refundsApplied: { ...(sale.refundsApplied || {}), [refundId]: applied },
      ...(full ? { status: 'refunded', refundedAtMs: nowMs } : (sale.status === 'disputed' ? {} : {})),
    }, { merge: true });
    tx.set(privRef, privUpdate, { merge: true });
    if (recovery > 0) tx.set(db.collection('ledgerExceptions').doc(`recovery_${saleId}_${refundId}`.slice(0, 150)), { type: 'RECOVERY_DUE_AFTER_REFUND', creatorId: sale.creatorId, orderId: saleId, amount: recovery, refundId, status: 'OPEN', createdAtMs: nowMs }, { merge: true });
    return { refunded: true, fullyRefunded: full, earning: earningReversed, recoveryDue: recovery, creatorId: sale.creatorId, commissionReversedMinor: rev.commissionReversedMinor };
  });
}

// Back-compat wrapper: reverse everything still unrefunded on the sale.
async function refundSale(db, saleId, nowMs = Date.now(), refundId = null) {
  return applyRefundToSale(db, saleId, { refundId: refundId || `full_${saleId}`, nowMs });
}

module.exports = {
  getHoldDays, releaseSale, releaseDueHolds, markDelivered, freezeSale, unfreezeSale, refundSale, applyRefundToSale,
  planFreeze, snapshotOfSale, MAX_HOLD_DAYS, splitByFeePct, DEFAULT_PLATFORM_FEE_PCT, attributeCreatorEarning, getDb: sharedGetDb,
};
