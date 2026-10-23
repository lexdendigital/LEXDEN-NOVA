// api/core/money.js
//
// Integer minor-unit money maths (kobo for NGN). Pure and dependency-free so it
// can be tested exhaustively. Nothing in here uses floating point for amounts:
// percentage maths goes through BigInt so large values cannot lose precision.
//
// Rounding rule (documented in the fee policy): HALF UP to the nearest minor unit.
const { FEE_BASIS, FEE_CONFIG_VERSION } = require('./config');

class MoneyError extends Error {
  constructor(message, code) { super(message); this.name = 'MoneyError'; this.code = code || 'MONEY_ERROR'; this.status = 422; }
}

const isMinor = (n) => typeof n === 'number' && Number.isSafeInteger(n);
function assertMinor(n, label = 'amount') {
  if (!isMinor(n)) throw new MoneyError(`${label} must be a whole number of minor units.`, 'NOT_MINOR_UNITS');
  return n;
}
function assertNonNegMinor(n, label) {
  assertMinor(n, label);
  if (n < 0) throw new MoneyError(`${label} cannot be negative.`, 'NEGATIVE_AMOUNT');
  return n;
}

/** 19.99 -> 1999. Rejects values with more than 2 decimal places and non-finite input. */
function toMinor(major) {
  const n = Number(major);
  if (!Number.isFinite(n)) throw new MoneyError('Amount is not a number.', 'NOT_A_NUMBER');
  const minor = Math.round(n * 100);
  if (Math.abs(minor / 100 - n) > 1e-9) throw new MoneyError('Amount has more than 2 decimal places.', 'TOO_PRECISE');
  return minor;
}
const toMajor = (minor) => assertMinor(minor) / 100;

/** floor((minor * bps + 5000) / 10000): half-up percentage of a minor-unit amount. */
function percentOfMinor(minor, bps) {
  assertNonNegMinor(minor, 'amount');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new MoneyError('Rate must be 0-10000 basis points.', 'BAD_RATE');
  const v = (BigInt(minor) * BigInt(bps) + 5000n) / 10000n;
  return Number(v);
}

/**
 * Creator sale split. The commission applies to the eligible merchandise/service
 * subtotal after item-level discounts; delivery and tax collected for others are
 * never commissionable. Returns an immutable snapshot that is stored on the sale.
 */
function computeCreatorSale({ merchandiseMinor, itemDiscountMinor = 0, deliveryMinor = 0, taxMinor = 0, bps }) {
  assertNonNegMinor(merchandiseMinor, 'merchandise');
  assertNonNegMinor(itemDiscountMinor, 'discount');
  assertNonNegMinor(deliveryMinor, 'delivery');
  assertNonNegMinor(taxMinor, 'tax');
  if (itemDiscountMinor > merchandiseMinor) throw new MoneyError('Discount exceeds the item price.', 'DISCOUNT_TOO_LARGE');
  const eligibleSubtotalMinor = merchandiseMinor - itemDiscountMinor;
  const commissionMinor = percentOfMinor(eligibleSubtotalMinor, bps);
  const creatorGrossMinor = eligibleSubtotalMinor;
  const creatorNetMinor = creatorGrossMinor - commissionMinor;
  return Object.freeze({
    feeConfigVersion: FEE_CONFIG_VERSION,
    basis: FEE_BASIS,
    rounding: 'HALF_UP',
    commissionBps: bps,
    buyerPaidMinor: eligibleSubtotalMinor + deliveryMinor + taxMinor,
    eligibleSubtotalMinor,
    deliveryMinor, taxMinor, itemDiscountMinor,
    creatorGrossMinor,
    commissionMinor,
    creatorNetMinor,
  });
}

/**
 * Proportional reversal for a refund. `refundEligibleMinor` is the part of the
 * ELIGIBLE SUBTOTAL being refunded. Commission is reversed in proportion, and a
 * cumulative approach guarantees that refunding everything reverses exactly the
 * whole commission with no leftover minor unit, regardless of how many partial
 * refunds were made. Idempotency is the caller's job (key the refund id).
 */
function reverseForRefund(snapshot, { refundEligibleMinor, alreadyRefundedEligibleMinor = 0 }) {
  assertNonNegMinor(refundEligibleMinor, 'refund');
  assertNonNegMinor(alreadyRefundedEligibleMinor, 'already refunded');
  const eligible = snapshot.eligibleSubtotalMinor;
  const newTotal = alreadyRefundedEligibleMinor + refundEligibleMinor;
  if (newTotal > eligible) throw new MoneyError('Refund exceeds what was paid for this item.', 'REFUND_TOO_LARGE');
  const cumulativeCommission = (total) => (total === eligible
    ? snapshot.commissionMinor
    : Number((BigInt(snapshot.commissionMinor) * BigInt(total) * 2n + BigInt(eligible)) / (BigInt(eligible) * 2n)));
  const commissionReversedMinor = cumulativeCommission(newTotal) - cumulativeCommission(alreadyRefundedEligibleMinor);
  const creatorNetReversedMinor = refundEligibleMinor - commissionReversedMinor;
  return { refundEligibleMinor, commissionReversedMinor, creatorNetReversedMinor, fullyRefunded: newTotal === eligible };
}

/**
 * Affiliate withdrawal: 5% of the requested GROSS amount. Any provider charge is
 * a separately disclosed line, never folded into the fee. Net must stay positive.
 */
function computeAffiliateWithdrawal({ grossMinor, bps, providerCostMinor = 0 }) {
  assertNonNegMinor(grossMinor, 'withdrawal');
  assertNonNegMinor(providerCostMinor, 'provider cost');
  if (grossMinor <= 0) throw new MoneyError('Withdrawal must be more than zero.', 'ZERO_WITHDRAWAL');
  const feeMinor = percentOfMinor(grossMinor, bps);
  const netPayableMinor = grossMinor - feeMinor - providerCostMinor;
  if (netPayableMinor <= 0) throw new MoneyError('This amount is too small to cover the fees.', 'NET_NOT_POSITIVE');
  return Object.freeze({
    feeConfigVersion: FEE_CONFIG_VERSION, feeType: 'AFFILIATE_WITHDRAWAL', rounding: 'HALF_UP',
    feeBps: bps, grossMinor, feeMinor, providerCostMinor, netPayableMinor,
  });
}

/**
 * Generic withdrawal split used for the CREATOR withdrawal path (rate comes from
 * the creator-specific setting, never from the affiliate fee).
 */
function computeWithdrawal({ grossMinor, feeBps, feeType }) {
  assertNonNegMinor(grossMinor, 'withdrawal');
  if (grossMinor <= 0) throw new MoneyError('Withdrawal must be more than zero.', 'ZERO_WITHDRAWAL');
  const feeMinor = percentOfMinor(grossMinor, feeBps);
  const netPayableMinor = grossMinor - feeMinor;
  if (netPayableMinor <= 0) throw new MoneyError('This amount is too small to cover the fees.', 'NET_NOT_POSITIVE');
  return Object.freeze({ feeConfigVersion: FEE_CONFIG_VERSION, feeType, rounding: 'HALF_UP', feeBps, grossMinor, feeMinor, netPayableMinor });
}

module.exports = {
  MoneyError, isMinor, assertMinor, toMinor, toMajor, percentOfMinor,
  computeCreatorSale, reverseForRefund, computeAffiliateWithdrawal, computeWithdrawal,
};
