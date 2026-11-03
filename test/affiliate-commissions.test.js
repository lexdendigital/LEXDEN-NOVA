// Affiliate commission lifecycle (8-day hold, release, refund reversal), coupon codes and
// the withdrawal state guards. Uses the shared in-memory Firestore double.
const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');

// admin.js / coupon.js read getDb at load time, so point the shared module at our fake FIRST.
const shared = require('../api/affiliate/shared');
let currentDb = null;
shared.getDb = () => currentDb;
require.cache[require.resolve('../api/_paystackMode.js')] = {
  id: 'mock', filename: 'mock', loaded: true, exports: { resolvePaystackSecretKey: async () => 'sk_test_x' },
};

const C = require('../api/affiliate/commissions');
const coupon = require('../api/affiliate/coupon');
const adminActions = require('../api/affiliate/admin').actions;
const R = require('../api/core/refunds');
const DAY = C.DAY_MS;

test.before(() => fake.install());
test.after(() => fake.restore());

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
function world(extra = {}) {
  const db = fake.makeDb({
    affiliates: {
      a1: { status: 'active', displayName: 'Coach Lexden', balancePending: 300, balanceAvailable: 50, totalEarned: 350, totalWithdrawn: 0 },
      a2: { status: 'active', displayName: 'Ruth Anselem', balancePending: 100, balanceAvailable: 0, totalEarned: 100, totalWithdrawn: 0 },
      a3: { status: 'suspended', displayName: 'Sam', balancePending: 0, balanceAvailable: 0, totalEarned: 0 },
    },
    affiliateCommissions: {
      due1: { affiliateId: 'a1', status: 'pending', commissionAmount: 100, releaseAtMs: NOW - DAY, dailyKey: 'a1_2026-11-01', linkKey: 'a1_p1' },
      due2: { affiliateId: 'a1', status: 'pending', commissionAmount: 100, releaseAtMs: NOW - 1000 },
      later: { affiliateId: 'a1', status: 'pending', commissionAmount: 100, releaseAtMs: NOW + 3 * DAY },
      other: { affiliateId: 'a2', status: 'pending', commissionAmount: 100, releaseAtMs: NOW - DAY },
      avail: { affiliateId: 'a1', status: 'available', commissionAmount: 50, releaseAtMs: NOW - 20 * DAY },
    },
    ...extra,
  });
  currentDb = db;
  return db;
}
const get = (db, c, id) => db._store[c][id];

test('holdDays: defaults to 8, honours an admin setting, ignores junk', () => {
  assert.equal(C.holdDays({}), 8);
  assert.equal(C.holdDays(null), 8);
  assert.equal(C.holdDays({ affiliateHoldDays: null }), 8);
  assert.equal(C.holdDays({ affiliateHoldDays: '' }), 8);
  assert.equal(C.holdDays({ affiliateHoldDays: 0 }), 0);
  assert.equal(C.holdDays({ affiliateHoldDays: 10 }), 10);
  assert.equal(C.holdDays({ affiliateHoldDays: -3 }), 8);
  assert.equal(C.holdDays({ affiliateHoldDays: 'abc' }), 8);
  assert.equal(C.holdDays({ affiliateHoldDays: 9999 }), 90);
});

test('releaseDue: frees only commissions whose hold has ended, and is idempotent', async () => {
  const db = world();
  const out = await C.releaseDue(db, { nowMs: NOW });
  assert.deepEqual(out, { released: 3, amount: 300 });
  assert.equal(get(db, 'affiliateCommissions', 'due1').status, 'available');
  assert.equal(get(db, 'affiliateCommissions', 'later').status, 'pending'); // still reserved
  assert.equal(get(db, 'affiliates', 'a1').balancePending, 100);   // 300 - 200
  assert.equal(get(db, 'affiliates', 'a1').balanceAvailable, 250); // 50 + 200
  assert.equal(get(db, 'affiliates', 'a2').balanceAvailable, 100);
  const again = await C.releaseDue(db, { nowMs: NOW });
  assert.deepEqual(again, { released: 0, amount: 0 });
  assert.equal(get(db, 'affiliates', 'a1').balanceAvailable, 250); // no double credit
});

test('releaseDue: an affiliate-scoped release never touches anyone else', async () => {
  const db = world();
  const out = await C.releaseDue(db, { affiliateId: 'a2', nowMs: NOW });
  assert.deepEqual(out, { released: 1, amount: 100 });
  assert.equal(get(db, 'affiliateCommissions', 'due1').status, 'pending');
  assert.equal(get(db, 'affiliates', 'a1').balanceAvailable, 50);
});

test('refund reversal: a refund inside the hold cancels the reserved commission and every counter', async () => {
  const db = world({ affiliateLeaderboard: { a1: { totalEarned: 350, salesCount: 3 } }, affiliateDailyStats: { 'a1_2026-11-01': { earnings: 100, sales: 1 } }, affiliateLinkStats: { a1_p1: { sales: 1, clicks: 5 } } });
  const out = await C.reverseForRefund(db, { id: 'rf1', paymentReference: 'due1', orderId: 'due1', paidMinor: 10000, amountMinor: 10000 }, { nowMs: NOW });
  assert.deepEqual(out, { reversed: 1, amount: 100 });
  assert.equal(get(db, 'affiliateCommissions', 'due1').status, 'reversed');
  assert.equal(get(db, 'affiliates', 'a1').balancePending, 200);
  assert.equal(get(db, 'affiliates', 'a1').totalEarned, 250);
  assert.equal(get(db, 'affiliates', 'a1').balanceAvailable, 50); // withdrawable money untouched
  assert.equal(get(db, 'affiliateLeaderboard', 'a1').salesCount, 2);
  assert.equal(get(db, 'affiliateDailyStats', 'a1_2026-11-01').earnings, 0);
  assert.equal(get(db, 'affiliateLinkStats', 'a1_p1').sales, 0);
  assert.equal(db._store.affiliateFlags, undefined); // nothing was released, so nothing to flag
});

test('refund reversal: the same refund replayed does nothing; an unrelated order does nothing', async () => {
  const db = world();
  const refund = { id: 'rf1', paymentReference: 'due2', paidMinor: 5000, amountMinor: 5000 };
  await C.reverseForRefund(db, refund, { nowMs: NOW });
  const again = await C.reverseForRefund(db, refund, { nowMs: NOW });
  assert.deepEqual(again, { reversed: 0, amount: 0 });
  assert.equal(get(db, 'affiliates', 'a1').balancePending, 200); // reduced once, not twice
  const none = await C.reverseForRefund(db, { id: 'rf9', paymentReference: 'no-such-order', paidMinor: 1, amountMinor: 1 });
  assert.deepEqual(none, { reversed: 0, amount: 0 });
});

test('refund reversal after release is applied and flagged for the admin', async () => {
  const db = world();
  const out = await C.reverseForRefund(db, { id: 'rf2', paymentReference: 'avail', paidMinor: 1000, amountMinor: 1000 }, { nowMs: NOW });
  assert.equal(out.amount, 50);
  assert.equal(get(db, 'affiliates', 'a1').balanceAvailable, 0);
  const flags = Object.values(db._store.affiliateFlags || {});
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'COMMISSION_REVERSED_AFTER_RELEASE');
  assert.equal(flags[0].reason, 'BALANCE_REDUCED');
});

test('partial refunds reduce the commission proportionally, measured against the original amount', async () => {
  const db = world();
  await C.reverseForRefund(db, { id: 'p1', paymentReference: 'due1', paidMinor: 10000, amountMinor: 2500 }, { nowMs: NOW }); // 25% of 100
  assert.equal(get(db, 'affiliateCommissions', 'due1').commissionAmount, 75);
  assert.equal(get(db, 'affiliateCommissions', 'due1').status, 'pending');
  await C.reverseForRefund(db, { id: 'p2', paymentReference: 'due1', paidMinor: 10000, amountMinor: 2500 }, { nowMs: NOW }); // another 25% of the ORIGINAL 100
  assert.equal(get(db, 'affiliateCommissions', 'due1').commissionAmount, 50);
  assert.equal(get(db, 'affiliateCommissions', 'due1').reversedAmount, 50);
  assert.equal(get(db, 'affiliates', 'a1').balancePending, 250);
});

test('completing a refund (core/refunds.transition) triggers the commission reversal', async () => {
  const db = world({
    refunds: { r1: { id: 'r1', state: 'PROVIDER_INITIATED', orderId: 'due2', paymentReference: 'due2', paidMinor: 20000, amountMinor: 20000, history: [] } },
  });
  const res = await R.transition(db, 'r1', R.STATES.COMPLETED, { by: 'provider', role: 'provider' });
  assert.equal(res.changed, true);
  for (let i = 0; i < 50 && get(db, 'affiliateCommissions', 'due2').status !== 'reversed'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(get(db, 'affiliateCommissions', 'due2').status, 'reversed');
  // replaying the same transition must not reverse twice
  await R.transition(db, 'r1', R.STATES.COMPLETED, { by: 'provider', role: 'provider' });
  assert.equal(get(db, 'affiliates', 'a1').balancePending, 200);
});

test('coupon: normalisation, claiming, uniqueness and one-code-per-affiliate', async () => {
  const db = world();
  assert.equal(coupon.normalize(' co-ach 25 '), 'COACH25');
  assert.equal(await coupon.createForAffiliate(db, 'a1', 'coach25', 'Coach'), 'COACH25');
  assert.equal(get(db, 'affiliates', 'a1').couponCode, 'COACH25');
  assert.equal(get(db, 'affiliateCoupons', 'COACH25').affiliateId, 'a1');
  await assert.rejects(() => coupon.createForAffiliate(db, 'a2', 'COACH25', 'Ruth'), (e) => e.code === 'CODE_TAKEN' && e.status === 409);
  await assert.rejects(() => coupon.createForAffiliate(db, 'a1', 'OTHER99', 'Coach'), (e) => e.code === 'ALREADY_HAS_CODE' && e.existing === 'COACH25');
  await assert.rejects(() => coupon.createForAffiliate(db, 'a2', 'ab', 'Ruth'), (e) => e.code === 'BAD_CODE');
  await assert.rejects(() => coupon.createForAffiliate(db, 'a2', 'NOVA', 'Ruth'), (e) => e.code === 'RESERVED_CODE');
  await assert.rejects(() => coupon.createForAffiliate(db, 'a3', 'SAM2025', 'Sam'), (e) => e.code === 'NOT_ACTIVE'); // suspended
});

test('coupon: an affiliate with no chosen code gets a generated one that includes their name', async () => {
  const db = world();
  const code = await coupon.createForAffiliate(db, 'a2', '', 'Ruth Anselem');
  assert.match(code, /^RUTHA\d{3}$/);
  assert.equal(get(db, 'affiliates', 'a2').couponCode, code);
});

function callHandler(method, query, body) {
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); }, end() { resolve({ code: this.code || 200 }); } };
    coupon({ method, query: query || {}, body: body || {}, headers: {} }, res);
  });
}

test('coupon: the public checkout check says valid only for a live code of an active affiliate', async () => {
  const db = world({ affiliateCoupons: { GOOD1234: { affiliateId: 'a1' }, SUSP1234: { affiliateId: 'a3' } } });
  currentDb = db;
  assert.deepEqual((await callHandler('GET', { check: 'good1234' })).body, { ok: true, valid: true });
  assert.deepEqual((await callHandler('GET', { check: 'SUSP1234' })).body, { ok: true, valid: false }); // suspended owner
  assert.deepEqual((await callHandler('GET', { check: 'NOPE9999' })).body, { ok: true, valid: false });
  assert.deepEqual((await callHandler('GET', { check: '<script>' })).body, { ok: true, valid: false });
});

// ---- withdrawal state guards (api/affiliate/admin.js) ----
const accountOk = { bankCode: '033', accountNumber: '0123456789', accountName: 'Test User' };
function wdWorld() {
  return world({
    affiliateWithdrawals: {
      rejected: { status: 'rejected', affiliateId: 'a1', amountRequested: 100, amountPayable: 95, payoutAccount: accountOk },
      approved: { status: 'approved', affiliateId: 'a1', amountRequested: 100, amountPayable: 95, payoutAccount: accountOk },
      paid: { status: 'paid', affiliateId: 'a1', amountRequested: 100, amountPayable: 95, payoutAccount: accountOk },
      pending: { status: 'pending', affiliateId: 'a1', amountRequested: 100, amountPayable: 95, payoutAccount: accountOk },
    },
  });
}

test('withdrawals: a rejected withdrawal can never be approved, marked paid or paid out', async () => {
  const db = wdWorld();
  await assert.rejects(() => adminActions.approveWithdrawal({ withdrawalId: 'rejected' }), /Only pending/);
  await assert.rejects(() => adminActions.markWithdrawalPaid({ withdrawalId: 'rejected' }), /Cannot mark as paid/);
  await assert.rejects(() => adminActions.payWithdrawalViaPaystack({ withdrawalId: 'rejected' }), /must be "approved"/);
  await assert.rejects(() => adminActions.markWithdrawalPaid({ withdrawalId: 'paid' }), /Cannot mark as paid/);
  assert.equal(get(db, 'affiliates', 'a1').totalWithdrawn, 0);
});

test('withdrawals: two simultaneous "pay" clicks send exactly one transfer; a Paystack failure is retryable', async () => {
  const db = wdWorld();
  const realFetch = global.fetch;
  const transfers = [];
  let failNext = false;
  global.fetch = async (url, opt) => {
    const b = JSON.parse((opt && opt.body) || '{}');
    if (String(url).endsWith('/transfer')) {
      if (failNext) return { json: async () => ({ status: false, message: 'Insufficient balance' }) };
      transfers.push(b);
    }
    return { json: async () => ({ status: true, data: { recipient_code: 'RCP_1', transfer_code: 'TRF_1', status: 'success' } }) };
  };
  try {
    const results = await Promise.allSettled([
      adminActions.payWithdrawalViaPaystack({ withdrawalId: 'approved' }),
      adminActions.payWithdrawalViaPaystack({ withdrawalId: 'approved' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].reference, 'nova-wd-approved');
    assert.equal(transfers[0].amount, 9500);
    assert.equal(get(db, 'affiliateWithdrawals', 'approved').status, 'paid');
    assert.equal(get(db, 'affiliates', 'a1').totalWithdrawn, 100);

    // A failing Paystack call puts the withdrawal back to "approved" so it can be retried.
    await adminActions.approveWithdrawal({ withdrawalId: 'pending' });
    failNext = true;
    await assert.rejects(() => adminActions.payWithdrawalViaPaystack({ withdrawalId: 'pending' }), /Insufficient balance/);
    assert.equal(get(db, 'affiliateWithdrawals', 'pending').status, 'approved');
    assert.match(get(db, 'affiliateWithdrawals', 'pending').lastPayoutError, /Insufficient/);
  } finally { global.fetch = realFetch; }
});
