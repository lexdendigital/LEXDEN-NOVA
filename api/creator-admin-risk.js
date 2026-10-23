// /api/creator-admin-risk.js
//
// LEXDEN NOVA CREATOR — Stage K (admin): disputes, earnings hold, reconciliation.
//
//   GET  ?view=disputes[&status=OPEN|RESOLVED_REFUND|RESOLVED_REJECTED]
//   GET  ?view=reconcile[&paystack=1]        ledger report (+ optional live Paystack check of recent sales)
//   GET  ?view=settings                      { holdDays, disputeWindowDays }
//   POST {action:"resolve_dispute", disputeId, decision:"REFUND"|"REJECT", note}
//   POST {action:"set_hold_days", days}      0 = no hold (default), max 60
//
// SAFETY: a REFUND decision (1) reverses the creator's share in the ledger (proportional,
// idempotent) and (2) creates a tracked REFUND record (api/core/refunds.js). The dispute is
// only marked resolved when BOTH succeeded; otherwise the call fails and the dispute stays
// OPEN so it can be retried safely. The buyer's money is only reported as returned after
// provider confirmation. A REJECT decision must actually restore the earning or it fails.
// Every decision is written to the audit log.
const { getDb, requireAdminAuth, FieldValue, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const ledger = require('./creator/ledger');
const L = require('./automation/logic');
const { DISPUTE_WINDOW_DAYS } = require('./creator-disputes');
const refunds = require('./core/refunds');
const M = require('./core/money');

const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function notify(db, creatorId, key, title, message) {
  try {
    await db.collection('creatorNotifications').doc(`${creatorId}_${key}`.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 150)).set({
      creatorId, type: 'DISPUTE', severity: 'info', title, message, read: false, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    }, { merge: true });
  } catch (e) { console.warn('notification skipped:', e.message); }
}

async function listDisputes(db, status) {
  let q = db.collection('creatorDisputes');
  if (status) q = q.where('status', '==', status);
  const snap = await q.limit(200).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.openedAtMs || 0) - (a.openedAtMs || 0));
}

const DISPUTE_TO_REFUND_REASON = Object.freeze({
  NOT_RECEIVED: 'NOT_DELIVERED', NOT_AS_DESCRIBED: 'ITEM_DEFECTIVE_WRONG_MISDESCRIBED_OR_UNSAFE',
  FILE_PROBLEM: 'ITEM_DEFECTIVE_WRONG_MISDESCRIBED_OR_UNSAFE', OTHER: 'EXCEPTIONAL_CASE',
});

async function resolveDispute(db, admin, { disputeId, decision, note, refundAmountMinor, refundReason, deductionMinor, deductionEvidence }) {
  if (typeof disputeId !== 'string' || !disputeId || disputeId.includes('/')) throw err(422, 'MISSING_DISPUTE', 'disputeId is required.');
  if (decision !== 'REFUND' && decision !== 'REJECT') throw err(422, 'INVALID_DECISION', 'decision must be REFUND or REJECT.');
  const text = String(note || '').trim().slice(0, 2000);
  if (text.length < 5) throw err(422, 'NOTE_REQUIRED', 'Write a short note explaining the decision (both sides will see it).');
  const ref = db.collection('creatorDisputes').doc(disputeId);
  const snap = await ref.get();
  if (!snap.exists) throw err(404, 'NOT_FOUND', 'Dispute not found.');
  const d = snap.data();
  if (d.status !== 'OPEN') throw err(409, 'ALREADY_RESOLVED', 'This dispute is already resolved.');

  let ledgerResult; let refundInfo = null;
  if (decision === 'REFUND') {
    const saleSnap = await db.collection('creatorSales').doc(d.orderId).get();
    if (!saleSnap.exists) throw err(409, 'LEDGER_FAILED', 'No ledger entry exists for this order, so the refund cannot be reconciled. Nothing was changed.');
    const sale = saleSnap.data();
    const snapshot = ledger.snapshotOfSale(sale);
    const paidMinor = M.toMinor(sale.buyerPaidAmount != null ? sale.buyerPaidAmount : sale.saleAmount);
    const reason = refundReason || DISPUTE_TO_REFUND_REASON[d.reason] || 'EXCEPTIONAL_CASE';
    const amountMinor = refundAmountMinor == null ? paidMinor : Number(refundAmountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > paidMinor) throw err(422, 'INVALID_REFUND_AMOUNT', 'refundAmountMinor must be a whole number of kobo, more than zero and not more than the buyer paid.');
    // Deductions are NEVER automatic: a human proposes one and the rules decide if it is even allowed.
    const dedn = refunds.assessDeduction({ reason, paidMinor: amountMinor, requestedDeductionMinor: Number(deductionMinor) || 0, evidence: deductionEvidence || {} });
    const refundId = `dispute_${disputeId}`;
    // 1) ledger first (idempotent per refundId) — if it fails nothing else happens and the dispute stays OPEN.
    const eligibleShare = Math.min(amountMinor, snapshot.eligibleSubtotalMinor - (Number(sale.refundedEligibleMinor) || 0));
    ledgerResult = await ledger.applyRefundToSale(db, d.orderId, { refundId, refundEligibleMinor: amountMinor >= paidMinor ? null : eligibleShare });
    if (!ledgerResult.refunded) throw err(409, 'LEDGER_FAILED', `Could not reverse the creator's earning (${ledgerResult.reason || 'unknown'}). The dispute stays open.`);
    // 2) the tracked refund record (idempotent). No money moves here.
    const req = await refunds.requestRefund(db, {
      orderId: d.orderId, idempotencyKey: refundId, amountMinor: dedn.refundMinor, paidMinor, currency: sale.currency || 'NGN', reason, disputeId,
      deduction: dedn.allowedDeductionMinor ? { amountMinor: dedn.allowedDeductionMinor, needsManualReview: dedn.needsManualReview, note: dedn.note } : null,
      requestedBy: admin.uid, requestedByRole: 'admin', paymentReference: d.orderId,
    });
    refundInfo = { refundId: req.refund.id, state: req.refund.state, deductionNote: dedn.note, userFacing: refunds.userFacingStatus(req.refund) };
  } else {
    ledgerResult = await ledger.unfreezeSale(db, d.orderId);
    // A rejection that did not restore the earning is NOT a resolution.
    if (!ledgerResult.restored) throw err(409, 'LEDGER_FAILED', `The earning could not be restored (${ledgerResult.reason || 'unknown'}). The dispute stays open for review.`);
  }
  const now = Date.now();
  await ref.set({
    status: decision === 'REFUND' ? 'RESOLVED_REFUND' : 'RESOLVED_REJECTED',
    resolutionNote: text, resolvedAtMs: now, resolvedBy: admin.uid, policyAtDecision: d.policy || null,
    messages: [...(Array.isArray(d.messages) ? d.messages.slice(-49) : []), { by: 'admin', text, atMs: now }],
    ...(decision === 'REFUND' ? { refundId: refundInfo.refundId, buyerRefundOwed: true, buyerRefundPaid: false } : {}),
  }, { merge: true });
  await notify(db, d.creatorId, `dispute_done_${disputeId}`, decision === 'REFUND' ? 'Dispute decided: buyer refund approved' : 'Dispute decided in your favour',
    decision === 'REFUND' ? `${d.productTitle || 'Order'}: your share for this order was reversed. Note: ${text}` : `${d.productTitle || 'Order'}: your earning is no longer on hold. Note: ${text}`);
  writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `dispute.${decision.toLowerCase()}`, targetType: 'dispute', targetId: disputeId, reason: text, metadata: { orderId: d.orderId, refundId: refundInfo && refundInfo.refundId, policyVersion: d.policy && d.policy.version } }).catch(() => {});
  return { status: decision === 'REFUND' ? 'RESOLVED_REFUND' : 'RESOLVED_REJECTED', ledger: ledgerResult, refund: refundInfo,
    reminder: decision === 'REFUND' ? 'The buyer refund is now a tracked request (Admin → Refunds). It is only "completed" after the payment provider confirms it.' : null };
}

// Read-only ledger report. Never raises alerts and never changes data.
async function reconcileReport(db, nowMs, deps = {}, withPaystack = false) {
  const privs = await db.collection('creatorPrivate').limit(500).get();
  const creators = [];
  const totals = { sales: 0, saleAmountNGN: 0, platformFee: 0, earnedHeld: 0, earnedAvailable: 0, withdrawn: 0, refunded: 0 };
  for (const p of privs.docs) {
    const [sales, wds] = await Promise.all([
      db.collection('creatorSales').where('creatorId', '==', p.id).limit(5000).get(),
      db.collection('creatorWithdrawals').where('creatorId', '==', p.id).limit(5000).get(),
    ]);
    const salesData = sales.docs.map((x) => x.data());
    const r = L.reconcileCreator({ priv: p.data(), sales: salesData, withdrawals: wds.docs.map((x) => x.data()) });
    for (const s of salesData) {
      totals.sales += 1;
      if ((s.currency || 'NGN') === 'NGN') totals.saleAmountNGN += Number(s.saleAmount) || 0;
      totals.platformFee += s.status === 'refunded' ? 0 : Number(s.platformFeeAmount) || 0;
      if (s.status === 'refunded') totals.refunded += Number(s.creatorEarning) || 0;
    }
    totals.earnedHeld += r.pendingEarned; totals.earnedAvailable += round2(r.earned - r.pendingEarned); totals.withdrawn += r.withdrawn;
    creators.push({ creatorId: p.id, ok: r.ok, issues: r.issues, earned: r.earned, withdrawn: r.withdrawn, expectedBalance: r.expectedBalance, storedBalance: round2(p.data().balanceAvailable), storedPending: round2(p.data().balancePending) });
  }
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  const out = { generatedAtMs: nowMs, creators: creators.sort((a, b) => Number(a.ok) - Number(b.ok)), totals, problems: creators.filter((c) => !c.ok).length, paystack: null,
    note: 'This report only reads data. Refunds to buyers and payouts are done by the admin; the app never moves money on its own.' };
  if (withPaystack) out.paystack = await paystackCheck(db, deps);
  return out;
}

// Asks Paystack itself about the most recent paid creator sales and compares amounts.
async function paystackCheck(db, deps = {}) {
  const verify = deps.verify || (async (reference) => {
    const { paystackKeyCandidates } = require('./_paystackMode');
    const keys = await paystackKeyCandidates();
    let last = 'No Paystack key is configured.';
    for (const key of keys) {
      const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${key}` } });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.status && j.data) return { ok: true, data: j.data };
      last = j.message || last;
    }
    return { ok: false, error: last };
  });
  const snap = await db.collection('creatorSales').limit(1000).get();
  const sales = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status !== 'refunded')
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)).slice(0, deps.max || 25);
  const rows = [];
  for (const s of sales) {
    let v; try { v = await verify(s.id); } catch (e) { v = { ok: false, error: e.message }; }
    if (!v.ok) { rows.push({ reference: s.id, result: 'UNVERIFIED', detail: v.error || 'Paystack could not confirm this reference.' }); continue; }
    const paidMajor = round2((Number(v.data.amount) || 0) / 100);
    const paid = v.data.status === 'success';
    const match = paid && Math.abs(paidMajor - round2(s.saleAmount)) < 0.01;
    rows.push({ reference: s.id, result: match ? 'MATCH' : 'MISMATCH', paystackStatus: v.data.status, paystackAmount: paidMajor, ledgerAmount: round2(s.saleAmount), currency: s.currency || null });
  }
  return { checked: rows.length, mismatches: rows.filter((r) => r.result === 'MISMATCH').length, unverified: rows.filter((r) => r.result === 'UNVERIFIED').length, rows };
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    let admin;
    try { admin = await requireAdminAuth(req); } catch (e) { return fail(res, e); }
    const db = getDb();
    try {
      if (req.method === 'GET') {
        const q = req.query || {};
        const view = q.view || 'disputes';
        if (view === 'disputes') return ok(res, { disputes: await listDisputes(db, q.status || null) });
        if (view === 'reconcile') return ok(res, await reconcileReport(db, Date.now(), deps, q.paystack === '1' || q.paystack === 'true'));
        if (view === 'settings') return ok(res, { holdDays: await ledger.getHoldDays(db), disputeWindowDays: DISPUTE_WINDOW_DAYS, maxHoldDays: ledger.MAX_HOLD_DAYS });
        return fail(res, err(400, 'INVALID_VIEW', `Unknown view "${view}".`));
      }
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
      const b = req.body || {};
      if (b.action === 'resolve_dispute') return ok(res, await resolveDispute(db, admin, b));
      if (b.action === 'set_hold_days') {
        const days = Number(b.days);
        if (!Number.isInteger(days) || days < 0 || days > ledger.MAX_HOLD_DAYS) return fail(res, err(422, 'INVALID_DAYS', `days must be a whole number from 0 to ${ledger.MAX_HOLD_DAYS}.`));
        await db.collection('catalog').doc('settings').set({ content: { creatorHoldDays: days } }, { merge: true });
        writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: 'settings.hold_days', targetType: 'setting', targetId: 'creatorHoldDays', metadata: { days } }).catch(() => {});
        return ok(res, { holdDays: days, note: days ? 'New sales are held for this many days before they become withdrawable. Existing balances are not affected.' : 'Holding is off: new sales are withdrawable immediately.' });
      }
      return fail(res, err(400, 'INVALID_ACTION', `Unknown action "${b.action}".`));
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.reconcileReport = reconcileReport;
module.exports.paystackCheck = paystackCheck;
module.exports.resolveDispute = resolveDispute;
