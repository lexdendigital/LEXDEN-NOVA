const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const ledger = require('../api/creator/ledger');
const L = require('../api/automation/logic');
const DAY = 24 * 60 * 60 * 1000;

test.before(() => fake.install());
test.after(() => fake.restore());

const physical = { reference: 'o1', creatorId: 'c1', productId: 'p1', productTitle: 'Shoe', offeringType: 'PHYSICAL_PRODUCT', amountMajor: 10000, currency: 'NGN' };
const digital = { ...physical, reference: 'd1', offeringType: 'EBOOK', productTitle: 'Book' };
const settings = (content = {}) => ({ catalog: { settings: { content } } });
const priv = (db, id = 'c1') => db._store.creatorPrivate[id];
const sale = (db, id) => db._store.creatorSales[id];
const recon = (db, id = 'c1') => L.reconcileCreator({
  priv: priv(db, id),
  sales: Object.values(db._store.creatorSales || {}).filter((s) => s.creatorId === id),
  withdrawals: Object.values(db._store.creatorWithdrawals || {}).filter((w) => w.creatorId === id),
});

test('E1: 10% fee applied exactly once; replayed payment events cannot double-credit or double-charge', async () => {
  const db = fake.makeDb(settings());
  const a = await ledger.attributeCreatorEarning(db, digital);
  const b = await ledger.attributeCreatorEarning(db, digital);
  const c = await ledger.attributeCreatorEarning(db, digital);
  assert.equal(a.credited, true); assert.equal(b.credited, false); assert.equal(c.credited, false);
  assert.equal(sale(db, 'd1').platformFeeAmount, 1000);
  assert.equal(sale(db, 'd1').creatorEarning, 9000);
  assert.equal(sale(db, 'd1').feeSnapshot.commissionBps, 1000);
  assert.equal(sale(db, 'd1').feeSnapshot.commissionMinor, 100000);
  assert.equal(priv(db).balanceAvailable, 9000);
  assert.equal(priv(db).totalEarned, 9000);
});

test('E4: a later rate change never rewrites an existing sale; the next sale uses the new rate', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  db._store.catalog.settings.content.creatorCommissionBps = 500;
  await ledger.attributeCreatorEarning(db, { ...digital, reference: 'd2' });
  assert.equal(sale(db, 'd1').feeSnapshot.commissionBps, 1000);
  assert.equal(sale(db, 'd1').creatorEarning, 9000);
  assert.equal(sale(db, 'd2').feeSnapshot.commissionBps, 500);
  assert.equal(sale(db, 'd2').creatorEarning, 9500);
});

test('delivery and tax collected for others are not commissioned', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, { ...digital, amountMajor: 11500, deliveryMajor: 1000, taxMajor: 500 });
  const s = sale(db, 'd1');
  assert.equal(s.feeSnapshot.eligibleSubtotalMinor, 1000000);
  assert.equal(s.platformFeeAmount, 1000);
  assert.equal(s.creatorEarning, 9000);
  assert.equal(s.buyerPaidAmount, 11500);
});

test('E5: a timer alone NEVER releases an undelivered physical sale, however old', async () => {
  const db = fake.makeDb(settings({ creatorHoldDays: 0 }));
  await ledger.attributeCreatorEarning(db, physical);
  assert.equal(sale(db, 'o1').status, 'held');
  assert.equal(sale(db, 'o1').releaseGate, 'DELIVERY');
  assert.equal(sale(db, 'o1').releaseAtMs, null);
  assert.equal(priv(db).balancePending, 9000);
  assert.equal(priv(db).balanceAvailable, undefined);
  const r = await ledger.releaseDueHolds(db, Date.now() + 365 * DAY);
  assert.equal(r.released, 0);
  assert.equal(r.awaitingDelivery, 1);
  assert.equal(sale(db, 'o1').status, 'held');
  assert.equal(await ledger.releaseSale(db, 'o1', Date.now() + 365 * DAY), false);
});

test('a creator-reported or rider-entered "delivered" does NOT start the release clock', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, physical);
  const a = await ledger.markDelivered(db, 'o1', { source: 'CREATOR_REPORTED' });
  const b = await ledger.markDelivered(db, 'o1', { source: 'RIDER_ENTERED' });
  assert.equal(a.releaseClockStarted, false); assert.equal(b.releaseClockStarted, false);
  assert.equal(sale(db, 'o1').releaseAtMs, null);
  assert.equal(sale(db, 'o1').deliveryEvidence.length, 2);
  assert.equal((await ledger.releaseDueHolds(db, Date.now() + 365 * DAY)).released, 0);
});

test('authoritative evidence starts a 14-day protection clock; release happens only after it, once', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, physical);
  const t0 = Date.now();
  const m = await ledger.markDelivered(db, 'o1', { source: 'CARRIER', atMs: t0 });
  assert.equal(m.releaseClockStarted, true);
  assert.equal(sale(db, 'o1').releaseAtMs, t0 + 14 * DAY);
  // a second piece of evidence cannot move the date
  await ledger.markDelivered(db, 'o1', { source: 'BUYER_CONFIRMED', atMs: t0 + 5 * DAY });
  assert.equal(sale(db, 'o1').releaseAtMs, t0 + 14 * DAY);
  assert.equal((await ledger.releaseDueHolds(db, t0 + 13 * DAY)).released, 0);
  const r = await ledger.releaseDueHolds(db, t0 + 14 * DAY + 1);
  assert.equal(r.released, 1);
  assert.equal(priv(db).balanceAvailable, 9000);
  assert.equal(priv(db).balancePending, 0);
  assert.equal((await ledger.releaseDueHolds(db, t0 + 30 * DAY)).released, 0); // idempotent
  assert.equal(priv(db).balanceAvailable, 9000);
  assert.deepEqual(recon(db).issues, []);
});

test('the holds job heals a failed ledger sync from the fulfilment record', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, physical);
  const t0 = Date.now() - 20 * DAY;
  db._store.fulfillments = { o1: { status: 'DELIVERED', deliveredAtMs: t0, deliveryEvidenceSource: 'BUYER_CONFIRMED', ledgerSyncPending: true } };
  const r = await ledger.releaseDueHolds(db, Date.now());
  assert.equal(r.resynced, 1); assert.equal(r.released, 1);
  assert.equal(priv(db).balanceAvailable, 9000);
});

test('digital sales keep the optional timer (default none)', async () => {
  const db = fake.makeDb(settings({ creatorHoldDays: 3 }));
  await ledger.attributeCreatorEarning(db, digital);
  assert.equal(sale(db, 'd1').releaseGate, 'TIMER');
  assert.equal((await ledger.releaseDueHolds(db, Date.now() + 2 * DAY)).released, 0);
  assert.equal((await ledger.releaseDueHolds(db, Date.now() + 4 * DAY)).released, 1);
});

test('E7: freezing moves available -> pending and is idempotent; reconcile stays clean', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  const f1 = await ledger.freezeSale(db, 'd1', 'd1');
  const f2 = await ledger.freezeSale(db, 'd1', 'd1');
  assert.equal(f1.frozen, true); assert.equal(f2.already, true);
  assert.equal(priv(db).balanceAvailable, 0);
  assert.equal(priv(db).balancePending, 9000);
  assert.deepEqual(recon(db).issues, []);
  const u = await ledger.unfreezeSale(db, 'd1');
  assert.deepEqual([u.restored, u.to], [true, 'available']);
  assert.equal(priv(db).balanceAvailable, 9000);
  assert.deepEqual(recon(db).issues, []);
});

test('unfreeze reports restored:false when nothing was frozen (callers must not claim resolution)', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  const u = await ledger.unfreezeSale(db, 'd1');
  assert.equal(u.restored, false);
  assert.equal((await ledger.unfreezeSale(db, 'nope')).restored, false);
});

test('E10: dispute after the money was withdrawn does NOT double-deduct or go negative; recovery is recorded', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);              // 9000 available
  // creator withdraws everything (what api/creator-withdraw.js does)
  db._store.creatorPrivate.c1.balanceAvailable = 0;
  db._store.creatorWithdrawals = { w1: { creatorId: 'c1', amountRequested: 9000, status: 'pending' } };
  assert.deepEqual(recon(db).issues, []);
  const f = await ledger.freezeSale(db, 'd1', 'd1');
  assert.equal(f.frozen, true); assert.equal(f.fundsAlreadyWithdrawn, true);
  assert.equal(priv(db).balanceAvailable, 0);                      // not -9000
  assert.equal(sale(db, 'd1').fundsAlreadyWithdrawn, true);
  assert.equal(db._store.ledgerExceptions.dispute_d1.status, 'OPEN');
  assert.deepEqual(recon(db).issues, []);
  // dispute fails -> stands as it was, exception closed, no balance movement
  const u = await ledger.unfreezeSale(db, 'd1');
  assert.equal(u.restored, true); assert.equal(u.balanceMoved, false);
  assert.equal(priv(db).balanceAvailable, 0);
  assert.equal(db._store.ledgerExceptions.dispute_d1.status, 'CLOSED_NO_ACTION');
  assert.deepEqual(recon(db).issues, []);
});

test('E10b: refund after withdrawal records recoveryDue instead of a negative balance', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  db._store.creatorPrivate.c1.balanceAvailable = 0;
  db._store.creatorWithdrawals = { w1: { creatorId: 'c1', amountRequested: 9000, status: 'paid' } };
  await ledger.freezeSale(db, 'd1', 'd1');
  const r = await ledger.applyRefundToSale(db, 'd1', { refundId: 'rf1' });
  assert.equal(r.refunded, true); assert.equal(r.recoveryDue, 9000);
  assert.equal(priv(db).balanceAvailable, 0);
  assert.equal(priv(db).recoveryDue, 9000);
  assert.equal(priv(db).totalEarned, 0);
  assert.equal(sale(db, 'd1').status, 'refunded');
  assert.deepEqual(recon(db).issues, []);
});

test('E2/E12: partial then final refund reverses commission proportionally, exactly once each, and sums to the whole', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, { ...digital, amountMajor: 19.99 });
  assert.equal(sale(db, 'd1').platformFeeAmount, 2);               // 199.9 kobo -> 200 kobo half-up
  const p1 = await ledger.applyRefundToSale(db, 'd1', { refundId: 'a', refundEligibleMinor: 500 });
  const dup = await ledger.applyRefundToSale(db, 'd1', { refundId: 'a', refundEligibleMinor: 500 });
  assert.equal(p1.refunded, true); assert.equal(dup.already, true);
  assert.equal(sale(db, 'd1').refundedEligibleMinor, 500);
  assert.equal(sale(db, 'd1').status, 'available');
  await ledger.applyRefundToSale(db, 'd1', { refundId: 'b' });     // the rest
  const s = sale(db, 'd1');
  assert.equal(s.status, 'refunded');
  assert.equal(s.commissionReversedMinor, 200);
  assert.equal(s.netReversedMinor, 1799);
  // Balances are stored in major units (see ledger.js header); compare to the kobo.
  assert.equal(Math.abs(Math.round(priv(db).balanceAvailable * 100)), 0);
  assert.equal(Math.abs(Math.round(priv(db).totalEarned * 100)), 0);
  assert.deepEqual(recon(db).issues, []);
  const again = await ledger.applyRefundToSale(db, 'd1', { refundId: 'c' });
  assert.equal(again.already, true);
  assert.equal(Math.abs(Math.round(priv(db).totalEarned * 100)), 0);
});

test('refund cannot exceed what is left to refund', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  const r = await ledger.applyRefundToSale(db, 'd1', { refundId: 'x', refundEligibleMinor: 1000001 });
  assert.equal(r.refunded, false); assert.equal(r.reason, 'AMOUNT_OUT_OF_RANGE');
});

test('refund of a held/pending physical sale reverses pending, not available', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, physical);
  await ledger.applyRefundToSale(db, 'o1', { refundId: 'r' });
  assert.equal(priv(db).balancePending, 0);
  assert.equal(priv(db).totalEarned, 0);
  assert.deepEqual(recon(db).issues, []);
});

test('a legacy sale (major units only, no snapshot) can still be refunded exactly', async () => {
  const db = fake.makeDb({
    ...settings(),
    creatorSales: { old: { creatorId: 'c1', saleAmount: 1000, platformFeePct: 15, platformFeeAmount: 150, creatorEarning: 850, status: 'available' } },
    creatorPrivate: { c1: { balanceAvailable: 850, totalEarned: 850 } },
  });
  const r = await ledger.applyRefundToSale(db, 'old', { refundId: 'legacy' });
  assert.equal(r.refunded, true);
  assert.equal(priv(db).balanceAvailable, 0);
  assert.equal(sale(db, 'old').status, 'refunded');
});

test('concurrent dispute + withdrawal: serialised transactions never produce a negative balance', async () => {
  const db = fake.makeDb(settings());
  await ledger.attributeCreatorEarning(db, digital);
  // withdrawal transaction (same shape as api/creator-withdraw.js) racing with a freeze
  const withdraw = db.runTransaction(async (tx) => {
    const p = (await tx.get(db.collection('creatorPrivate').doc('c1'))).data();
    if (p.balanceAvailable < 9000) return 'insufficient';
    tx.set(db.collection('creatorPrivate').doc('c1'), { balanceAvailable: p.balanceAvailable - 9000 }, { merge: true });
    tx.set(db.collection('creatorWithdrawals').doc('w1'), { creatorId: 'c1', amountRequested: 9000, status: 'pending' });
    return 'ok';
  });
  const freeze = ledger.freezeSale(db, 'd1', 'd1');
  const [w, f] = await Promise.all([withdraw, freeze]);
  assert.ok(priv(db).balanceAvailable >= 0);
  assert.equal(f.frozen, true);
  assert.deepEqual(recon(db).issues, []);
  assert.ok(w === 'ok' || w === 'insufficient');
});
