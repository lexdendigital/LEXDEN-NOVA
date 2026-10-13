const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../api/automation/logic');

test('link health: OK resets; BROKEN pauses at 3 in a row; TRANSIENT at 6; BLOCKED at once', () => {
  assert.equal(L.deriveLinkHealth({ state: 'OK' }, { consecutiveBroken: 2, consecutiveTransient: 4 }).consecutiveBroken, 0);
  let prior = {}; const paused = [];
  for (let i = 0; i < 3; i++) { const v = L.deriveLinkHealth({ state: 'BROKEN', code: 'HTTP_404' }, prior); prior = v; paused.push(v.pause); }
  assert.deepEqual(paused, [false, false, true]);
  prior = {}; const t = [];
  for (let i = 0; i < 6; i++) { const v = L.deriveLinkHealth({ state: 'TRANSIENT', code: 'TIMEOUT' }, prior); prior = v; t.push(v.pause); }
  assert.deepEqual(t, [false, false, false, false, false, true]);
  const blocked = L.deriveLinkHealth({ state: 'BLOCKED', code: 'BLOCKED_ADDRESS' }, {});
  assert.equal(blocked.pause, true); assert.equal(blocked.state, 'DEGRADED');
  // a good check in between breaks the streak
  const mid = L.deriveLinkHealth({ state: 'BROKEN', code: 'HTTP_404' }, L.deriveLinkHealth({ state: 'OK' }, { consecutiveBroken: 2 }));
  assert.equal(mid.pause, false);
});

test('pickDue: oldest first, respects the gap and the cap', () => {
  const now = 10_000_000;
  const items = [{ id: 'a', t: now - 1000 }, { id: 'b', t: 0 }, { id: 'c', t: undefined }, { id: 'd', t: now - 7 * 3600 * 1000 }];
  const due = L.pickDue(items, 't', L.LINK_CHECK_GAP_MS, now, 2);
  assert.equal(due.length, 2);
  assert.ok(due.every((x) => x.id !== 'a'));
});

test('reconcileCreator: consistent ledger passes; drift and negatives are reported', () => {
  const sales = [{ creatorEarning: 850 }, { creatorEarning: 425.5 }];
  const wds = [{ status: 'paid', amountRequested: 500 }, { status: 'rejected', amountRequested: 300 }, { status: 'pending', amountRequested: 100 }];
  const good = L.reconcileCreator({ priv: { totalEarned: 1275.5, balanceAvailable: 675.5 }, sales, withdrawals: wds });
  assert.equal(good.ok, true); assert.equal(good.expectedBalance, 675.5);
  const bad = L.reconcileCreator({ priv: { totalEarned: 1275.5, balanceAvailable: 900 }, sales, withdrawals: wds });
  assert.deepEqual(bad.issues.map((i) => i.code), ['BALANCE_MISMATCH']);
  const neg = L.reconcileCreator({ priv: { totalEarned: 0, balanceAvailable: -50 }, sales: [], withdrawals: [{ status: 'paid', amountRequested: 50 }] });
  assert.ok(neg.issues.some((i) => i.code === 'NEGATIVE_BALANCE'));
  assert.equal(L.reconcileCreator({ priv: null, sales: [], withdrawals: [] }).ok, true);
});

test('reconcileOrder: what a paid creator order must have', () => {
  const phys = { creatorProductId: 'p', status: 'paid', amount: 5000, creatorSellerId: 'u', creatorOfferingType: 'PHYSICAL_PRODUCT' };
  assert.deepEqual(L.reconcileOrder(phys, { hasSale: true, hasFulfillment: true }), []);
  assert.deepEqual(L.reconcileOrder(phys, { hasSale: false, hasFulfillment: false }).sort(), ['MISSING_FULFILLMENT', 'MISSING_LEDGER_ENTRY']);
  const dig = { ...phys, creatorOfferingType: 'EBOOK' };
  assert.deepEqual(L.reconcileOrder(dig, { hasSale: true, hasEntitlement: false }), ['MISSING_ENTITLEMENT']);
  assert.deepEqual(L.reconcileOrder({ ...dig, amount: 0 }, { hasSale: false, hasEntitlement: true }), []);   // free: no ledger entry expected
  assert.deepEqual(L.reconcileOrder({ status: 'paid' }, {}), []);                                              // legacy order: not ours
  assert.deepEqual(L.reconcileOrder({ ...phys, status: 'pending' }, {}), []);
});

test('supplier order retry rules', () => {
  const now = 10_000_000;
  const so = { status: 'RETRY_LATER', attempts: 1, updatedAtMs: now - 11 * 60 * 1000 };
  assert.equal(L.shouldRetrySupplierOrder(so, now), true);
  assert.equal(L.shouldRetrySupplierOrder({ ...so, updatedAtMs: now - 60 * 1000 }, now), false);
  assert.equal(L.shouldRetrySupplierOrder({ ...so, attempts: 6 }, now), false);
  assert.equal(L.shouldRetrySupplierOrder({ ...so, cjOrderId: 'X' }, now), false);
  assert.equal(L.shouldRetrySupplierOrder({ ...so, status: 'NEEDS_ATTENTION' }, now), false);
});
