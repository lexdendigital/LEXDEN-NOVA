const test = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../api/core/config');
const M = require('../api/core/money');

test('approved defaults: 10% creator commission, 5% affiliate withdrawal fee', () => {
  assert.equal(cfg.CREATOR_COMMISSION_BPS, 1000);
  assert.equal(cfg.AFFILIATE_WITHDRAWAL_FEE_BPS, 500);
});

test('stale legacy percentage keys cannot override the approved rates', () => {
  // creatorPlatformFeePct:15 / affiliateWithdrawalFeePct:2.5 are what older admin screens saved.
  assert.equal(cfg.resolveCreatorCommissionBps({ creatorPlatformFeePct: 15 }), 1000);
  assert.equal(cfg.resolveAffiliateWithdrawalFeeBps({ affiliateWithdrawalFeePct: 2.5 }), 500);
  // an explicit, valid new-key override IS honoured; junk is not.
  assert.equal(cfg.resolveCreatorCommissionBps({ creatorCommissionBps: 800 }), 800);
  assert.equal(cfg.resolveCreatorCommissionBps({ creatorCommissionBps: 99999 }), 1000);
  assert.equal(cfg.resolveCreatorCommissionBps({ creatorCommissionBps: 'ten' }), 1000);
  assert.equal(cfg.resolveAffiliateWithdrawalFeeBps({ affiliateWithdrawalFeeBps: 250.5 }), 500);
});

test('toMinor/toMajor are exact and reject sub-kobo precision', () => {
  assert.equal(M.toMinor(19.99), 1999);
  assert.equal(M.toMinor(0.1 + 0.2 + 0.7), 100); // 1.0000000000000002 -> 100
  assert.equal(M.toMajor(1999), 19.99);
  assert.throws(() => M.toMinor(1.005), /decimal/);
  assert.throws(() => M.toMinor('abc'));
  assert.throws(() => M.toMajor(1.5));
});

test('percentOfMinor rounds half up and survives large values', () => {
  assert.equal(M.percentOfMinor(1000, 1000), 100);
  assert.equal(M.percentOfMinor(5, 1000), 1);   // 0.5 -> 1 (half up)
  assert.equal(M.percentOfMinor(4, 1000), 0);   // 0.4 -> 0
  assert.equal(M.percentOfMinor(1, 1000), 0);
  assert.equal(M.percentOfMinor(9_000_000_000_000, 1000), 900_000_000_000);
  assert.throws(() => M.percentOfMinor(-1, 1000));
  assert.throws(() => M.percentOfMinor(100, 10001));
});

test('creator sale: 10% of eligible subtotal; delivery and tax are excluded from commission', () => {
  const s = M.computeCreatorSale({ merchandiseMinor: 1_000_000, itemDiscountMinor: 100_000, deliveryMinor: 150_000, taxMinor: 20_000, bps: 1000 });
  assert.equal(s.eligibleSubtotalMinor, 900_000);
  assert.equal(s.commissionMinor, 90_000);
  assert.equal(s.creatorNetMinor, 810_000);
  assert.equal(s.buyerPaidMinor, 1_070_000);
  assert.equal(s.basis, cfg.FEE_BASIS);
  assert.ok(Object.isFrozen(s));
  assert.throws(() => M.computeCreatorSale({ merchandiseMinor: 100, itemDiscountMinor: 200, bps: 1000 }), /Discount/);
});

test('low-value sales: commission never exceeds the subtotal and net is never negative', () => {
  for (const m of [0, 1, 2, 3, 5, 9, 10, 11, 99, 101]) {
    const s = M.computeCreatorSale({ merchandiseMinor: m, bps: 1000 });
    assert.ok(s.commissionMinor >= 0 && s.commissionMinor <= m);
    assert.equal(s.commissionMinor + s.creatorNetMinor, m);
  }
});

test('full refund reverses exactly the whole commission; partials add up with no leftover', () => {
  const snap = M.computeCreatorSale({ merchandiseMinor: 1999, bps: 1000 }); // commission 200 (199.9 half-up)
  assert.equal(snap.commissionMinor, 200);
  const full = M.reverseForRefund(snap, { refundEligibleMinor: 1999 });
  assert.equal(full.commissionReversedMinor, 200);
  assert.equal(full.creatorNetReversedMinor, 1799);
  assert.equal(full.fullyRefunded, true);

  let done = 0; let comm = 0; let net = 0;
  for (const part of [500, 777, 722]) {
    const r = M.reverseForRefund(snap, { refundEligibleMinor: part, alreadyRefundedEligibleMinor: done });
    done += part; comm += r.commissionReversedMinor; net += r.creatorNetReversedMinor;
  }
  assert.equal(done, 1999);
  assert.equal(comm, 200);        // exactly the original commission
  assert.equal(net, 1799);        // exactly the original creator net
  assert.throws(() => M.reverseForRefund(snap, { refundEligibleMinor: 1, alreadyRefundedEligibleMinor: 1999 }), /exceeds/);
});

test('a later fee-rate change does not alter an already-stored snapshot', () => {
  const before = M.computeCreatorSale({ merchandiseMinor: 100_000, bps: 1000 });
  const after = M.computeCreatorSale({ merchandiseMinor: 100_000, bps: 500 });
  assert.equal(before.commissionMinor, 10_000);
  assert.equal(after.commissionMinor, 5_000);
  // refunds use the SNAPSHOT's bps/commission, never the current config
  const r = M.reverseForRefund(before, { refundEligibleMinor: 100_000 });
  assert.equal(r.commissionReversedMinor, 10_000);
});

test('affiliate withdrawal: ₦10,000 gross -> ₦500 fee -> ₦9,500 payable; provider cost is a separate line', () => {
  const w = M.computeAffiliateWithdrawal({ grossMinor: 1_000_000, bps: 500 });
  assert.equal(w.feeMinor, 50_000);
  assert.equal(w.netPayableMinor, 950_000);
  assert.equal(w.providerCostMinor, 0);
  const w2 = M.computeAffiliateWithdrawal({ grossMinor: 1_000_000, bps: 500, providerCostMinor: 5_000 });
  assert.equal(w2.feeMinor, 50_000);            // fee unchanged by the provider charge
  assert.equal(w2.netPayableMinor, 945_000);
  assert.throws(() => M.computeAffiliateWithdrawal({ grossMinor: 0, bps: 500 }));
  assert.throws(() => M.computeAffiliateWithdrawal({ grossMinor: 1000, bps: 500, providerCostMinor: 1000 }), /too small/);
});

test('creator withdrawal uses its own rate and type, never the affiliate fee', () => {
  const w = M.computeWithdrawal({ grossMinor: 1_000_000, feeBps: 0, feeType: 'CREATOR_WITHDRAWAL' });
  assert.equal(w.feeMinor, 0);
  assert.equal(w.feeType, 'CREATOR_WITHDRAWAL');
  assert.notEqual(w.feeBps, cfg.AFFILIATE_WITHDRAWAL_FEE_BPS);
});

test('dispute policy: physical anchors on confirmed delivery, digital/service on purchase, snapshot carries a version', () => {
  assert.deepEqual(cfg.disputePolicySnapshot('PHYSICAL_PRODUCT'), { version: cfg.DISPUTE_POLICY_VERSION, category: 'PHYSICAL', windowDays: 14, anchor: 'CONFIRMED_DELIVERY' });
  assert.equal(cfg.disputePolicySnapshot('EBOOK').anchor, 'PURCHASE');
  assert.equal(cfg.disputePolicySnapshot('SOMETHING_NEW').category, 'SERVICE'); // unknown never becomes "physical"
});

test('only authoritative evidence can start the release clock; a creator claim cannot', () => {
  assert.equal(cfg.isAuthoritativeEvidence('CARRIER'), true);
  assert.equal(cfg.isAuthoritativeEvidence('BUYER_CONFIRMED'), true);
  assert.equal(cfg.isAuthoritativeEvidence('CREATOR_REPORTED'), false);
  assert.equal(cfg.isAuthoritativeEvidence('RIDER_ENTERED'), false);
});

test('feature flags are fail-safe OFF by default', () => {
  const f = cfg.flags({});
  assert.equal(f.cjFundingMode, 'DISABLED');
  assert.equal(f.paystackRefundsEnabled, false);
  assert.equal(f.policyPublicationApproved, false);
  assert.equal(f.connectedChannelSync, false);
  assert.equal(f.pickupStationsEnabled, false);
  assert.equal(cfg.flags({ CJ_FUNDING_MODE: 'bogus' }).cjFundingMode, 'DISABLED');
  assert.equal(cfg.flags({ CJ_FUNDING_MODE: 'creator_account' }).cjFundingMode, 'CREATOR_ACCOUNT');
});
