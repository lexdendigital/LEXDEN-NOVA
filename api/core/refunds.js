// api/core/refunds.js
//
// Refund lifecycle for buyer money (IMPLEMENTATION PROMPT Part I §8, §9).
//
//   REQUESTED -> APPROVED -> (PROVIDER_INITIATED | AWAITING_MANUAL_STEP)
//              -> PROCESSING -> COMPLETED            (COMPLETED -> REVERSED)
//   any non-terminal -> REQUIRES_REVIEW ; FAILED -> APPROVED (retry) ; -> CANCELLED
//
// Rules this module enforces:
//  * "Completed" exists ONLY when the provider (or a recorded manual provider step
//    plus reconciliation) says so. userFacingStatus() never says "refunded" earlier.
//  * Reasons are OUTCOME-BASED. No buyer deduction is ever applied automatically
//    and there is no blanket 30%/70% rule: a deduction is possible ONLY for a
//    buyer's discretionary cancellation, and only with documented actual cost that
//    was disclosed before purchase and is legally permitted; anything above the
//    (configurable, INTERNAL — not legal) approval threshold needs manual review.
//  * A supplier shortfall (e.g. supplier charged ₦12,000 and refunded ₦9,000) is a
//    NOVA/creator-side recovery question, never an automatic buyer deduction.
//  * Provider calls are idempotent per refund id and never rolled back by a DB write:
//    a timeout leaves the refund PROVIDER_INITIATED/REQUIRES_REVIEW for reconciliation.
const M = require('./money');
const { flags } = require('./config');

const STATES = Object.freeze({
  REQUESTED: 'REQUESTED', APPROVED: 'APPROVED', AWAITING_MANUAL_STEP: 'AWAITING_MANUAL_STEP',
  PROVIDER_INITIATED: 'PROVIDER_INITIATED', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED',
  FAILED: 'FAILED', REVERSED: 'REVERSED', REQUIRES_REVIEW: 'REQUIRES_REVIEW', CANCELLED: 'CANCELLED',
});

const TRANSITIONS = Object.freeze({
  REQUESTED: ['APPROVED', 'REQUIRES_REVIEW', 'CANCELLED'],
  APPROVED: ['PROVIDER_INITIATED', 'AWAITING_MANUAL_STEP', 'REQUIRES_REVIEW', 'CANCELLED'],
  AWAITING_MANUAL_STEP: ['PROVIDER_INITIATED', 'REQUIRES_REVIEW', 'CANCELLED'],
  PROVIDER_INITIATED: ['PROCESSING', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW'],
  PROCESSING: ['COMPLETED', 'FAILED', 'REQUIRES_REVIEW'],
  COMPLETED: ['REVERSED'],
  FAILED: ['APPROVED', 'REQUIRES_REVIEW', 'CANCELLED'],
  REQUIRES_REVIEW: ['APPROVED', 'PROVIDER_INITIATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  REVERSED: [],
  CANCELLED: [],
});

const REASONS = Object.freeze([
  'SELLER_OR_PLATFORM_NONPERFORMANCE', 'UNAVAILABLE_STOCK', 'ITEM_DEFECTIVE_WRONG_MISDESCRIBED_OR_UNSAFE', 'NOT_DELIVERED',
  'BUYER_DISCRETIONARY_CANCELLATION', 'CUSTOM_WORK_OR_APPOINTMENT_SPECIFIC', 'EXTERNAL_CHECKOUT', 'PARTIAL_DELIVERY',
  'DUPLICATE_PAYMENT', 'FRAUD_OR_CHARGEBACK', 'UNSUPPORTED_DELIVERY_COVERAGE', 'EXCEPTIONAL_CASE',
]);

// Reasons for which the buyer MUST receive the full refund with no deduction at all.
const NO_DEDUCTION_REASONS = Object.freeze([
  'SELLER_OR_PLATFORM_NONPERFORMANCE', 'UNAVAILABLE_STOCK', 'ITEM_DEFECTIVE_WRONG_MISDESCRIBED_OR_UNSAFE', 'NOT_DELIVERED',
  'UNSUPPORTED_DELIVERY_COVERAGE', 'DUPLICATE_PAYMENT', 'PARTIAL_DELIVERY', 'FRAUD_OR_CHARGEBACK',
]);

// INTERNAL control, configurable, NOT a legal limit: deductions above this share of the
// refundable amount cannot be approved without the manual/legal review flag.
const DEFAULT_INTERNAL_REVIEW_THRESHOLD_BPS = 1000;

class RefundError extends Error {
  constructor(message, code, status) { super(message); this.name = 'RefundError'; this.code = code || 'REFUND_ERROR'; this.status = status || 409; }
}

function assertTransition(from, to) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, from)) throw new RefundError(`Unknown refund state "${from}".`, 'UNKNOWN_STATE');
  if (!TRANSITIONS[from].includes(to)) throw new RefundError(`Cannot move a refund from ${from} to ${to}.`, 'INVALID_TRANSITION');
}

/**
 * Decides the buyer deduction. NEVER automatic. `requestedDeductionMinor` is what a human
 * proposes; this returns what is permitted and what extra review is required.
 */
function assessDeduction({ reason, paidMinor, requestedDeductionMinor = 0, evidence = {}, thresholdBps = DEFAULT_INTERNAL_REVIEW_THRESHOLD_BPS }) {
  M.assertMinor(paidMinor, 'paid'); M.assertMinor(requestedDeductionMinor, 'deduction');
  if (!REASONS.includes(reason)) throw new RefundError('Unknown refund reason.', 'INVALID_REASON', 422);
  if (requestedDeductionMinor <= 0) return { allowedDeductionMinor: 0, needsManualReview: false, refundMinor: paidMinor, note: 'No deduction.' };
  if (NO_DEDUCTION_REASONS.includes(reason)) return { allowedDeductionMinor: 0, needsManualReview: false, refundMinor: paidMinor, note: 'No deduction is permitted for this reason: the buyer receives the full amount.' };
  if (reason !== 'BUYER_DISCRETIONARY_CANCELLATION') {
    // custom work / external checkout / exceptional: nothing automatic, a human must justify it.
    return { allowedDeductionMinor: 0, needsManualReview: true, refundMinor: paidMinor, note: 'A deduction for this reason needs manual and legal review; none is applied automatically.' };
  }
  const ok = evidence.actualCostDocumented === true && evidence.causallyRelevant === true && evidence.disclosedBeforePurchase === true && evidence.legallyPermitted === true;
  if (!ok) return { allowedDeductionMinor: 0, needsManualReview: false, refundMinor: paidMinor, note: 'A deduction needs documented, actual, causally relevant cost that was disclosed before purchase and is legally permitted. None applied.' };
  const capped = Math.min(requestedDeductionMinor, paidMinor);
  const overThreshold = capped > M.percentOfMinor(paidMinor, thresholdBps);
  return { allowedDeductionMinor: capped, needsManualReview: overThreshold, refundMinor: paidMinor - capped, note: overThreshold ? 'Above the internal review threshold: manual/legal review required before approval.' : 'Deduction supported by recorded evidence.' };
}

/** Supplier-side shortfall. Informational for admin: never converts into an automatic buyer deduction. */
function supplierShortfall({ supplierChargedMinor, supplierRefundedMinor }) {
  M.assertMinor(supplierChargedMinor); M.assertMinor(supplierRefundedMinor);
  const unrecoveredMinor = Math.max(0, supplierChargedMinor - supplierRefundedMinor);
  return { unrecoveredMinor, buyerDeductionAutomatic: false, needsReview: unrecoveredMinor > 0 };
}

// ---- Paystack mapping --------------------------------------------------------
// Verified against https://paystack.com/docs/payments/refunds/ (reviewed 2026-10-18):
// statuses pending | processing | needs-attention | failed | processed; events refund.<status>.
const PAYSTACK_STATUS_TO_STATE = Object.freeze({
  pending: STATES.PROVIDER_INITIATED, processing: STATES.PROCESSING, 'needs-attention': STATES.REQUIRES_REVIEW,
  failed: STATES.FAILED, processed: STATES.COMPLETED, reversed: STATES.REVERSED,
});
const stateForPaystackStatus = (s) => PAYSTACK_STATUS_TO_STATE[String(s || '').toLowerCase()] || null;

/**
 * What the BUYER/CREATOR may be told. "Completed" only when authoritative provider
 * confirmation exists; a ledger reversal or an approval is never described as money returned.
 */
function userFacingStatus(refund) {
  switch (refund && refund.state) {
    case STATES.COMPLETED: return refund.providerConfirmedAtMs ? { label: 'Refund completed', completed: true } : { label: 'Refund being confirmed', completed: false };
    case STATES.REVERSED: return { label: 'Refund reversed by the payment provider — contact support', completed: false };
    case STATES.FAILED: return { label: 'Refund could not be processed — we are following up', completed: false };
    case STATES.REQUIRES_REVIEW: return { label: 'Refund needs a manual check — we are following up', completed: false };
    case STATES.PROCESSING: case STATES.PROVIDER_INITIATED: return { label: 'Refund is being processed by the payment provider (can take several business days)', completed: false };
    case STATES.AWAITING_MANUAL_STEP: case STATES.APPROVED: return { label: 'Refund approved — payment step in progress', completed: false };
    case STATES.CANCELLED: return { label: 'Refund request cancelled', completed: false };
    default: return { label: 'Refund requested', completed: false };
  }
}

// ---- Provider adapter (Paystack). Mock-friendly via deps.fetchImpl. -----------------
async function initiatePaystackRefund({ transactionReference, amountMinor = null, merchantNote = '', customerNote = '' }, deps = {}) {
  if (!(deps.flags || flags()).paystackRefundsEnabled) return { ok: false, code: 'PROVIDER_DISABLED', message: 'Provider refunds are not enabled; use the tracked manual step.' };
  const fetchImpl = deps.fetchImpl || fetch;
  const keys = await (deps.keys ? deps.keys() : require('../_paystackMode').paystackKeyCandidates());
  if (!keys.length) return { ok: false, code: 'NO_KEY', message: 'No Paystack key is configured.' };
  let lastErr = 'Paystack did not accept the refund.';
  for (const key of keys) {
    let r; let j;
    try {
      r = await fetchImpl('https://api.paystack.co/refund', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: transactionReference, ...(amountMinor != null ? { amount: amountMinor } : {}), ...(merchantNote ? { merchant_note: merchantNote.slice(0, 200) } : {}), ...(customerNote ? { customer_note: customerNote.slice(0, 200) } : {}) }),
      });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      // The provider MAY have processed it. Do not retry blindly: reconcile first.
      return { ok: false, code: 'TIMEOUT_UNKNOWN', message: 'The provider did not answer; the refund may or may not exist. Reconcile before retrying.', unknownOutcome: true };
    }
    if (r.ok && j && j.status && j.data) {
      const state = stateForPaystackStatus(j.data.status) || STATES.PROVIDER_INITIATED;
      return { ok: true, state, providerStatus: j.data.status, providerRefundId: j.data.id != null ? String(j.data.id) : null, raw: { amount: j.data.amount, currency: j.data.currency } };
    }
    lastErr = (j && j.message) || lastErr;
  }
  return { ok: false, code: 'PROVIDER_REJECTED', message: lastErr };
}

// ---- Firestore-backed lifecycle -------------------------------------------------
const col = (db) => db.collection('refunds');

/** Creates (idempotently, by key) a refund request. Never moves money. */
async function requestRefund(db, { orderId, idempotencyKey, amountMinor, paidMinor, currency = 'NGN', reason, deduction = null, disputeId = null, requestedBy, requestedByRole = 'admin', paymentReference }) {
  if (!orderId || !idempotencyKey) throw new RefundError('orderId and idempotencyKey are required.', 'MISSING_FIELDS', 422);
  if (!REASONS.includes(reason)) throw new RefundError('Unknown refund reason.', 'INVALID_REASON', 422);
  M.assertMinor(amountMinor, 'refund'); M.assertMinor(paidMinor, 'paid');
  if (amountMinor <= 0 || amountMinor > paidMinor) throw new RefundError('Refund amount must be more than zero and no more than what was paid.', 'AMOUNT_OUT_OF_RANGE', 422);
  const id = String(idempotencyKey).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);
  const ref = col(db).doc(id);
  const doc = {
    id, orderId, disputeId, paymentReference: paymentReference || orderId, reason, currency,
    paidMinor, amountMinor, deduction, state: STATES.REQUESTED,
    history: [{ from: null, to: STATES.REQUESTED, by: requestedBy || null, role: requestedByRole, atMs: Date.now() }],
    providerMode: null, providerRefundId: null, providerStatus: null, providerConfirmedAtMs: null,
    manualStep: null, createdAtMs: Date.now(), updatedAtMs: Date.now(),
  };
  try {
    await ref.create(doc);
    return { created: true, refund: doc };
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) return { created: false, refund: (await ref.get()).data() };
    throw e;
  }
}

/** Single guarded transition. Reads-then-writes inside a transaction so replays/races are safe. */
async function transition(db, refundId, to, { by = null, role = 'admin', patch = {}, note = null } = {}) {
  const ref = col(db).doc(refundId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new RefundError('Refund not found.', 'NOT_FOUND', 404);
    const cur = snap.data();
    if (cur.state === to) return { changed: false, refund: cur }; // idempotent replay
    assertTransition(cur.state, to);
    const next = {
      ...cur, ...patch, state: to, updatedAtMs: Date.now(),
      history: [...(cur.history || []).slice(-29), { from: cur.state, to, by, role, atMs: Date.now(), ...(note ? { note: String(note).slice(0, 300) } : {}) }],
    };
    if (to === STATES.COMPLETED && !next.providerConfirmedAtMs) next.providerConfirmedAtMs = Date.now();
    tx.set(ref, next);
    return { changed: true, refund: next };
  });
}

/** Approve, then either call the provider (flag on) or enter the tracked MANUAL step. */
async function approveAndRoute(db, refundId, { by, deps = {} }) {
  const cur = (await col(db).doc(refundId).get()).data();
  if (!cur) throw new RefundError('Refund not found.', 'NOT_FOUND', 404);
  if (cur.deduction && cur.deduction.needsManualReview && !cur.deduction.reviewedBy) throw new RefundError('This refund includes a deduction that still needs manual/legal review.', 'REVIEW_REQUIRED', 409);
  if (cur.state === STATES.REQUESTED || cur.state === STATES.FAILED || cur.state === STATES.REQUIRES_REVIEW) await transition(db, refundId, STATES.APPROVED, { by });
  const provider = await initiatePaystackRefund({ transactionReference: cur.paymentReference, amountMinor: cur.amountMinor, merchantNote: `NOVA refund ${refundId}` }, deps);
  if (provider.ok) {
    const r = await transition(db, refundId, provider.state === STATES.COMPLETED ? STATES.COMPLETED : STATES.PROVIDER_INITIATED, { by, patch: { providerMode: 'PAYSTACK_API', providerRefundId: provider.providerRefundId, providerStatus: provider.providerStatus } });
    return { routed: 'PAYSTACK_API', refund: r.refund };
  }
  if (provider.unknownOutcome) {
    const r = await transition(db, refundId, STATES.REQUIRES_REVIEW, { by, patch: { providerMode: 'PAYSTACK_API', providerStatus: 'UNKNOWN' }, note: provider.message });
    return { routed: 'REQUIRES_REVIEW', refund: r.refund, message: provider.message };
  }
  if (provider.code === 'PROVIDER_DISABLED' || provider.code === 'NO_KEY') {
    const r = await transition(db, refundId, STATES.AWAITING_MANUAL_STEP, { by, patch: { providerMode: 'MANUAL_DASHBOARD', manualStep: { responsible: by, instruction: 'Refund the buyer from the Paystack dashboard (Transactions → the reference → Refund), then record the provider reference.', recordedAtMs: null } } });
    return { routed: 'MANUAL', refund: r.refund };
  }
  const r = await transition(db, refundId, STATES.FAILED, { by, patch: { providerStatus: 'REJECTED' }, note: provider.message });
  return { routed: 'FAILED', refund: r.refund, message: provider.message };
}

/** Admin attests the manual dashboard refund; COMPLETED still requires confirmation (reconcile / webhook). */
async function recordManualStep(db, refundId, { by, providerReference, note }) {
  if (!providerReference || String(providerReference).trim().length < 3) throw new RefundError('Enter the provider refund reference.', 'REFERENCE_REQUIRED', 422);
  return transition(db, refundId, STATES.PROVIDER_INITIATED, { by, patch: { providerMode: 'MANUAL_DASHBOARD', providerRefundId: String(providerReference).trim().slice(0, 100), manualStep: { responsible: by, recordedAtMs: Date.now(), note: note ? String(note).slice(0, 300) : null } } });
}

/** Applies an authoritative provider status (webhook or reconciliation fetch). */
async function applyProviderStatus(db, refundId, providerStatus, { by = 'provider', deps } = {}) {
  const to = stateForPaystackStatus(providerStatus);
  if (!to) throw new RefundError(`Unrecognised provider status "${providerStatus}".`, 'UNKNOWN_PROVIDER_STATUS', 422);
  const ref = col(db).doc(refundId);
  const cur = (await ref.get()).data();
  if (!cur) throw new RefundError('Refund not found.', 'NOT_FOUND', 404);
  // Skip a stale/earlier provider status (e.g. a late "pending" after "processed").
  const rank = { PROVIDER_INITIATED: 1, PROCESSING: 2, REQUIRES_REVIEW: 2, FAILED: 3, COMPLETED: 3, REVERSED: 4 };
  if ((rank[cur.state] || 0) > (rank[to] || 0) && cur.state !== STATES.FAILED) return { changed: false, refund: cur, ignored: 'STALE_STATUS' };
  const from = [STATES.REQUESTED, STATES.APPROVED, STATES.AWAITING_MANUAL_STEP].includes(cur.state) ? STATES.PROVIDER_INITIATED : null;
  if (from) await transition(db, refundId, STATES.PROVIDER_INITIATED, { by, role: 'provider' });
  return transition(db, refundId, to, { by, role: 'provider', patch: { providerStatus: String(providerStatus), ...(to === STATES.COMPLETED ? { providerConfirmedAtMs: Date.now() } : {}) } });
}

module.exports = {
  STATES, TRANSITIONS, REASONS, NO_DEDUCTION_REASONS, DEFAULT_INTERNAL_REVIEW_THRESHOLD_BPS, RefundError,
  assertTransition, assessDeduction, supplierShortfall, stateForPaystackStatus, userFacingStatus,
  initiatePaystackRefund, requestRefund, transition, approveAndRoute, recordManualStep, applyProviderStatus,
};
