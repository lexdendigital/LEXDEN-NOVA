// api/automation/logic.js
//
// LEXDEN NOVA CREATOR — Stage I: pure decision rules for the scheduled jobs.
// No I/O. Unit tested (test/automation-logic.test.js).
const LINK_BROKEN_BEFORE_PAUSE = 3;     // 3 consecutive "content is gone" checks
const LINK_TRANSIENT_BEFORE_PAUSE = 6;  // 6 consecutive slow/5xx checks (~a day at the default gap)
const LINK_CHECK_GAP_MS = 6 * 3600 * 1000;
const SUPPLIER_CHECK_GAP_MS = 6 * 3600 * 1000;
const SYNC_MIN_GAP_MS = 10 * 60 * 1000;
const ORDER_RETRY_MIN_AGE_MS = 10 * 60 * 1000;
const ORDER_RETRY_MAX_ATTEMPTS = 6;
const BALANCE_TOLERANCE = 0.01;

/**
 * Link health transition (blueprint §76/§86 style).
 *   prior   = { consecutiveBroken, consecutiveTransient } (previous values)
 *   result  = checkExternalLink() output
 * -> { state: HEALTHY|WARNING|DEGRADED, pause, consecutiveBroken, consecutiveTransient, reason }
 */
function deriveLinkHealth(result, prior = {}) {
  const b0 = prior.consecutiveBroken || 0;
  const t0 = prior.consecutiveTransient || 0;
  if (result.state === 'OK') return { state: 'HEALTHY', pause: false, consecutiveBroken: 0, consecutiveTransient: 0, reason: null };
  if (result.state === 'BLOCKED') {
    // A buyer-facing link that points at an internal address is never legitimate.
    return { state: 'DEGRADED', pause: true, consecutiveBroken: b0, consecutiveTransient: t0, reason: `Delivery link is not allowed (${result.code}).` };
  }
  if (result.state === 'BROKEN') {
    const b = b0 + 1;
    const pause = b >= LINK_BROKEN_BEFORE_PAUSE;
    return { state: pause ? 'DEGRADED' : 'WARNING', pause, consecutiveBroken: b, consecutiveTransient: 0, reason: `Delivery link looks broken (${result.code}), ${b} check${b === 1 ? '' : 's'} in a row.` };
  }
  const t = t0 + 1; // TRANSIENT
  const pause = t >= LINK_TRANSIENT_BEFORE_PAUSE;
  return { state: pause ? 'DEGRADED' : 'WARNING', pause, consecutiveBroken: 0, consecutiveTransient: t, reason: `Delivery link was unreachable (${result.code}), ${t} check${t === 1 ? '' : 's'} in a row.` };
}

const isDue = (lastMs, gapMs, nowMs) => !lastMs || nowMs - lastMs >= gapMs;

/** Which products' links/suppliers to check this run: oldest-checked first, capped. */
function pickDue(items, lastField, gapMs, nowMs, limit) {
  return items
    .filter((x) => isDue(x[lastField], gapMs, nowMs))
    .sort((a, b) => (a[lastField] || 0) - (b[lastField] || 0))
    .slice(0, limit);
}

/**
 * Ledger consistency for ONE creator (blueprint §84).
 * earnings: creatorSales docs; withdrawals: creatorWithdrawals docs;
 * priv: creatorPrivate doc. A rejected withdrawal gives the money back.
 */
function reconcileCreator({ priv, sales, withdrawals }) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const issues = [];
  const sum = (list) => round2(list.reduce((s, x) => s + (Number(x.creatorEarning) || 0), 0));
  // A sale with no status is an old-style, immediately available sale.
  const statusOf = (x) => x.status || 'available';
  const availableEarned = sum(sales.filter((x) => statusOf(x) === 'available'));
  // A disputed sale whose money was ALREADY withdrawn (fundsAlreadyWithdrawn) never moved
  // balances, so it is not "pending": it is paid-out-but-disputed.
  const paidOutDisputed = sum(sales.filter((x) => statusOf(x) === 'disputed' && x.fundsAlreadyWithdrawn === true));
  const pendingEarned = sum(sales.filter((x) => statusOf(x) === 'held' || (statusOf(x) === 'disputed' && x.fundsAlreadyWithdrawn !== true)));
  // Recovery that a refund created because the creator had already withdrawn the money.
  // (Settling it off-platform does not change history, so the total is what balances.)
  const recoveryTotal = sum(sales.map((x) => ({ creatorEarning: x.recoveryDueAmount })));
  const earned = round2(availableEarned + pendingEarned + paidOutDisputed); // refunded sales no longer count as earned
  const withdrawn = round2(withdrawals.filter((w) => w.status !== 'rejected').reduce((s, w) => s + (Number(w.amountRequested) || 0), 0));
  const totalEarned = Number((priv && priv.totalEarned) || 0);
  const balance = Number((priv && priv.balanceAvailable) || 0);
  const pending = Number((priv && priv.balancePending) || 0);
  const expectedBalance = round2(availableEarned + paidOutDisputed - withdrawn + recoveryTotal);
  if (Math.abs(totalEarned - earned) > BALANCE_TOLERANCE) issues.push({ code: 'TOTAL_EARNED_MISMATCH', stored: totalEarned, computed: earned });
  if (Math.abs(balance - expectedBalance) > BALANCE_TOLERANCE) issues.push({ code: 'BALANCE_MISMATCH', stored: balance, computed: expectedBalance });
  if (Math.abs(pending - pendingEarned) > BALANCE_TOLERANCE) issues.push({ code: 'PENDING_MISMATCH', stored: pending, computed: pendingEarned });
  if (balance < -BALANCE_TOLERANCE) issues.push({ code: 'NEGATIVE_BALANCE', stored: balance, computed: expectedBalance });
  return { ok: issues.length === 0, issues, earned, withdrawn, expectedBalance, pendingEarned, paidOutDisputed, recoveryTotal };
}

/** Order-level ledger/fulfillment completeness. Pure over already-loaded sets. */
function reconcileOrder(order, { hasSale, hasFulfillment, hasEntitlement }) {
  const issues = [];
  if (!order.creatorProductId || order.status !== 'paid') return issues;
  if (Number(order.amount) > 0 && order.creatorSellerId && !hasSale) issues.push('MISSING_LEDGER_ENTRY');
  if (order.creatorOfferingType === 'PHYSICAL_PRODUCT') { if (!hasFulfillment) issues.push('MISSING_FULFILLMENT'); }
  else if (!hasEntitlement) issues.push('MISSING_ENTITLEMENT');
  return issues;
}

/** Should a supplier order be retried automatically? */
function shouldRetrySupplierOrder(so, nowMs) {
  if (!so || so.cjOrderId) return false;
  if (so.status !== 'RETRY_LATER') return false;
  if ((so.attempts || 0) >= ORDER_RETRY_MAX_ATTEMPTS) return false;
  return nowMs - (so.updatedAtMs || 0) >= ORDER_RETRY_MIN_AGE_MS;
}

module.exports = {
  LINK_BROKEN_BEFORE_PAUSE, LINK_TRANSIENT_BEFORE_PAUSE, LINK_CHECK_GAP_MS, SUPPLIER_CHECK_GAP_MS, SYNC_MIN_GAP_MS,
  ORDER_RETRY_MIN_AGE_MS, ORDER_RETRY_MAX_ATTEMPTS, BALANCE_TOLERANCE,
  deriveLinkHealth, isDue, pickDue, reconcileCreator, reconcileOrder, shouldRetrySupplierOrder,
};
