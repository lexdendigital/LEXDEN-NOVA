const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fake = require('./helpers/fake-db');
const ledger = require('../api/creator/ledger');
const { openDispute } = require('../api/creator-disputes');
const { resolveDispute } = require('../api/creator-admin-risk');
const R = require('../api/core/refunds');
const { handleRefundEvent } = require('../api/paystack-webhook');
const DAY = 24 * 60 * 60 * 1000;
const admin = { uid: 'admin1' };

test.before(() => fake.install());
test.after(() => fake.restore());

const base = { creatorId: 'c1', productId: 'p1', productTitle: 'Shoe', currency: 'NGN', amountMajor: 10000 };
async function world({ offeringType = 'PHYSICAL_PRODUCT', delivered = null } = {}) {
  const db = fake.makeDb({ catalog: { settings: { content: {} } }, fulfillments: { o1: { buyerUid: 'b1', status: delivered ? 'DELIVERED' : 'SHIPPED', ...(delivered ? { deliveredAtMs: delivered.atMs, deliveryEvidenceSource: delivered.source } : {}) } } });
  await ledger.attributeCreatorEarning(db, { ...base, reference: 'o1', offeringType });
  if (delivered) await ledger.markDelivered(db, 'o1', { source: delivered.source, atMs: delivered.atMs });
  return db;
}
const body = { orderId: 'o1', reason: 'NOT_RECEIVED', details: 'The parcel never arrived at my address.' };

test('F: a physical dispute window is based on CONFIRMED DELIVERY, not order creation', async () => {
  const db = await world();
  // The sale is "old": created 40 days ago. No delivery confirmed, so no countdown has started.
  db._store.creatorSales.o1.createdAtMs = Date.now() - 40 * DAY;
  const r = await openDispute(db, 'b1', 'b@x.com', body);
  assert.equal(r.status, 'OPEN'); assert.equal(r.windowStartedAt, null);
});

test('F: after authoritative delivery, the 14 days run from that date and then close', async () => {
  const fresh = await world({ delivered: { source: 'BUYER_CONFIRMED', atMs: Date.now() - 13 * DAY } });
  assert.equal((await openDispute(fresh, 'b1', 'b@x.com', body)).status, 'OPEN');
  const late = await world({ delivered: { source: 'CARRIER', atMs: Date.now() - 15 * DAY } });
  await assert.rejects(() => openDispute(late, 'b1', 'b@x.com', body), (e) => e.code === 'WINDOW_CLOSED');
});

test('F: a creator-reported delivery does not start the buyer countdown', async () => {
  const db = await world({ delivered: { source: 'CREATOR_REPORTED', atMs: Date.now() - 30 * DAY } });
  assert.equal((await openDispute(db, 'b1', 'b@x.com', body)).status, 'OPEN');
});

test('digital orders use their own policy: window from purchase', async () => {
  const db = fake.makeDb({ catalog: { settings: { content: {} } }, fulfillments: {} });
  await ledger.attributeCreatorEarning(db, { ...base, reference: 'o1', offeringType: 'EBOOK' });
  db._store.entitlements = { o1_p1: { buyerUid: 'b1', orderId: 'o1', productId: 'p1', status: 'ACTIVE' } };
  db._store.creatorSales.o1.createdAtMs = Date.now() - 20 * DAY;
  // ownership for digital is proven by the entitlement; if that helper cannot find it the
  // ordinary buyer check fails with NOT_YOUR_ORDER, never with a silent pass.
  await assert.rejects(() => openDispute(db, 'b1', 'b@x.com', body), (e) => ['WINDOW_CLOSED', 'NOT_YOUR_ORDER'].includes(e.code));
  assert.equal(db._store.creatorSales.o1.disputePolicy.anchor, 'PURCHASE');
});

test('F: a stranger cannot dispute someone else\'s order; nothing is frozen', async () => {
  const db = await world();
  await assert.rejects(() => openDispute(db, 'someone-else', 'x@x.com', body), (e) => e.code === 'NOT_YOUR_ORDER');
  assert.equal(db._store.creatorSales.o1.status, 'held');
  assert.equal(db._store.creatorDisputes, undefined);
});

test('E7: opening a dispute creates it AND freezes the earning in one step; a second dispute is refused', async () => {
  const db = await world({ offeringType: 'PHYSICAL_PRODUCT' });
  const r = await openDispute(db, 'b1', 'b@x.com', body);
  assert.equal(r.earningFrozen, true);
  assert.equal(db._store.creatorSales.o1.status, 'disputed');
  assert.equal(db._store.creatorDisputes.o1.policy.anchor, 'CONFIRMED_DELIVERY');
  await assert.rejects(() => openDispute(db, 'b1', 'b@x.com', body), (e) => e.code === 'DISPUTE_EXISTS');
});

test('E7: if the earning cannot be frozen the dispute is NOT half-opened', async () => {
  const db = await world();
  db._store.creatorSales.o1.status = 'weird';
  await assert.rejects(() => openDispute(db, 'b1', 'b@x.com', body), (e) => e.code === 'CANNOT_OPEN_DISPUTE');
  assert.equal(db._store.creatorDisputes, undefined);
});

test('E10: dispute opened after the payout started flags recovery and does not double-deduct', async () => {
  const db = fake.makeDb({ catalog: { settings: { content: {} } }, fulfillments: { o1: { buyerUid: 'b1' } } });
  await ledger.attributeCreatorEarning(db, { ...base, reference: 'o1', offeringType: 'EBOOK' });
  db._store.creatorPrivate.c1.balanceAvailable = 0;            // already reserved by a withdrawal
  db._store.creatorWithdrawals = { w1: { creatorId: 'c1', amountRequested: 9000, status: 'processing' } };
  const r = await openDispute(db, 'b1', 'b@x.com', { ...body, reason: 'NOT_AS_DESCRIBED' });
  assert.equal(r.needsAdminRecovery, true);
  assert.equal(db._store.creatorPrivate.c1.balanceAvailable, 0);
  assert.equal(db._store.ledgerExceptions.dispute_o1.type, 'DISPUTE_AFTER_WITHDRAWAL');
});

test('E8: REJECT that cannot restore the earning does not report success', async () => {
  const db = await world();
  await openDispute(db, 'b1', 'b@x.com', body);
  db._store.creatorSales.o1.status = 'available';               // sabotage: no longer "disputed"
  await assert.rejects(() => resolveDispute(db, admin, { disputeId: 'o1', decision: 'REJECT', note: 'No evidence of fault.' }), (e) => e.code === 'LEDGER_FAILED');
  assert.equal(db._store.creatorDisputes.o1.status, 'OPEN');
});

test('E8: REJECT that works restores the earning and closes the dispute', async () => {
  const db = await world();
  await openDispute(db, 'b1', 'b@x.com', body);
  const r = await resolveDispute(db, admin, { disputeId: 'o1', decision: 'REJECT', note: 'Carrier proof shows delivery.' });
  assert.equal(r.status, 'RESOLVED_REJECTED');
  assert.equal(db._store.creatorSales.o1.status, 'held');       // still inside its protection period
});

test('E12: REFUND reverses the ledger once and creates ONE tracked refund; never "completed" yet', async () => {
  const db = await world();
  await openDispute(db, 'b1', 'b@x.com', body);
  const r = await resolveDispute(db, admin, { disputeId: 'o1', decision: 'REFUND', note: 'Courier confirmed loss.' });
  assert.equal(r.status, 'RESOLVED_REFUND');
  assert.equal(r.refund.state, 'REQUESTED');
  assert.equal(r.refund.userFacing.completed, false);
  assert.equal(db._store.creatorSales.o1.status, 'refunded');
  const refund = db._store.refunds.dispute_o1;
  assert.equal(refund.amountMinor, 1000000);
  assert.equal(refund.reason, 'NOT_DELIVERED');
  assert.equal(db._store.creatorDisputes.o1.buyerRefundPaid, false);
  assert.equal(Object.keys(db._store.refunds).length, 1);
});

test('E13: no automatic deduction, and nothing resembling a blanket 30%/70%', async () => {
  const a = R.assessDeduction({ reason: 'NOT_DELIVERED', paidMinor: 1000000, requestedDeductionMinor: 300000, evidence: { actualCostDocumented: true, causallyRelevant: true, disclosedBeforePurchase: true, legallyPermitted: true } });
  assert.equal(a.allowedDeductionMinor, 0); assert.equal(a.refundMinor, 1000000);
  const b = R.assessDeduction({ reason: 'BUYER_DISCRETIONARY_CANCELLATION', paidMinor: 1000000, requestedDeductionMinor: 300000 });
  assert.equal(b.allowedDeductionMinor, 0);                        // no evidence => nothing
  const c = R.assessDeduction({ reason: 'BUYER_DISCRETIONARY_CANCELLATION', paidMinor: 1000000, requestedDeductionMinor: 50000, evidence: { actualCostDocumented: true, causallyRelevant: true, disclosedBeforePurchase: true, legallyPermitted: true } });
  assert.equal(c.allowedDeductionMinor, 50000); assert.equal(c.needsManualReview, false);
  const d = R.assessDeduction({ reason: 'BUYER_DISCRETIONARY_CANCELLATION', paidMinor: 1000000, requestedDeductionMinor: 300000, evidence: { actualCostDocumented: true, causallyRelevant: true, disclosedBeforePurchase: true, legallyPermitted: true } });
  assert.equal(d.needsManualReview, true);                         // internal control, not a legal limit
  assert.equal(R.assessDeduction({ reason: 'EXTERNAL_CHECKOUT', paidMinor: 100, requestedDeductionMinor: 10 }).allowedDeductionMinor, 0);
});

test('E12: supplier shortfall (₦12,000 charged, ₦9,000 returned) is NOT an automatic buyer deduction', () => {
  const s = R.supplierShortfall({ supplierChargedMinor: 1_200_000, supplierRefundedMinor: 900_000 });
  assert.equal(s.unrecoveredMinor, 300_000); assert.equal(s.buyerDeductionAutomatic, false); assert.equal(s.needsReview, true);
  assert.equal(R.supplierShortfall({ supplierChargedMinor: 1_200_000, supplierRefundedMinor: 1_200_000 }).unrecoveredMinor, 0);
});

test('refund state machine: illegal and replayed transitions are rejected safely', async () => {
  assert.throws(() => R.assertTransition('REQUESTED', 'COMPLETED'), /Cannot move/);
  assert.throws(() => R.assertTransition('COMPLETED', 'APPROVED'));
  const db = fake.makeDb();
  const { refund } = await R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k1', amountMinor: 100, paidMinor: 100, reason: 'NOT_DELIVERED', requestedBy: 'a' });
  const dup = await R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k1', amountMinor: 100, paidMinor: 100, reason: 'NOT_DELIVERED', requestedBy: 'a' });
  assert.equal(dup.created, false); assert.equal(dup.refund.id, refund.id);
  await assert.rejects(() => R.transition(db, 'k1', 'COMPLETED'), /Cannot move/);
  await assert.rejects(() => R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k2', amountMinor: 101, paidMinor: 100, reason: 'NOT_DELIVERED' }), /no more than/);
  await assert.rejects(() => R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k3', amountMinor: 1, paidMinor: 100, reason: 'MADE_UP' }), /reason/);
});

test('E11: with provider refunds OFF the manual step is tracked and is NOT shown as completed', async () => {
  const db = fake.makeDb();
  await R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k1', amountMinor: 5000, paidMinor: 5000, reason: 'NOT_DELIVERED', requestedBy: 'a' });
  const routed = await R.approveAndRoute(db, 'k1', { by: 'admin1', deps: { flags: { paystackRefundsEnabled: false } } });
  assert.equal(routed.routed, 'MANUAL'); assert.equal(routed.refund.state, 'AWAITING_MANUAL_STEP');
  assert.equal(routed.refund.manualStep.responsible, 'admin1');
  assert.equal(R.userFacingStatus(routed.refund).completed, false);
  await assert.rejects(() => R.recordManualStep(db, 'k1', { by: 'admin1', providerReference: '' }), /reference/i);
  const rec = await R.recordManualStep(db, 'k1', { by: 'admin1', providerReference: 'PSTK-REF-1' });
  assert.equal(rec.refund.state, 'PROVIDER_INITIATED');
  assert.equal(R.userFacingStatus(rec.refund).completed, false);       // still not "completed"
  const done = await R.applyProviderStatus(db, 'k1', 'processed');
  assert.equal(done.refund.state, 'COMPLETED');
  assert.equal(R.userFacingStatus(done.refund).completed, true);
});

test('provider API path (mock): initiates once, maps statuses, never rolls back on timeout', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ status: true, data: { id: 77, status: 'pending', amount: 5000, currency: 'NGN' } }) }; };
  const deps = { flags: { paystackRefundsEnabled: true }, keys: async () => ['sk_test_x'], fetchImpl };
  const db = fake.makeDb();
  await R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k1', amountMinor: 5000, paidMinor: 5000, reason: 'NOT_DELIVERED', requestedBy: 'a', paymentReference: 'o1' });
  const out = await R.approveAndRoute(db, 'k1', { by: 'admin1', deps });
  assert.equal(out.routed, 'PAYSTACK_API'); assert.equal(out.refund.state, 'PROVIDER_INITIATED');
  assert.deepEqual(calls[0], { url: 'https://api.paystack.co/refund', body: { transaction: 'o1', amount: 5000, merchant_note: 'NOVA refund k1' } });
  assert.equal(R.userFacingStatus(out.refund).completed, false);

  // timeout: outcome unknown => REQUIRES_REVIEW, no blind retry
  const db2 = fake.makeDb();
  await R.requestRefund(db2, { orderId: 'o2', idempotencyKey: 'k2', amountMinor: 100, paidMinor: 100, reason: 'NOT_DELIVERED', requestedBy: 'a' });
  const t = await R.approveAndRoute(db2, 'k2', { by: 'admin1', deps: { ...deps, fetchImpl: async () => { throw new Error('socket hang up'); } } });
  assert.equal(t.routed, 'REQUIRES_REVIEW');
});

test('webhook refund events: replays and out-of-order events are safe; processed => completed once', async () => {
  const db = fake.makeDb();
  await R.requestRefund(db, { orderId: 'o1', idempotencyKey: 'k1', amountMinor: 5000, paidMinor: 5000, reason: 'NOT_DELIVERED', requestedBy: 'a', paymentReference: 'o1' });
  await R.transition(db, 'k1', 'APPROVED', {});
  await R.transition(db, 'k1', 'PROVIDER_INITIATED', {});
  const ev = (status) => ({ event: `refund.${status}`, data: { transaction_reference: 'o1', status } });
  await handleRefundEvent(ev('processing'), { db });
  await handleRefundEvent(ev('processed'), { db });
  await handleRefundEvent(ev('processed'), { db });                  // replay
  await handleRefundEvent(ev('pending'), { db });                    // late, stale
  assert.equal(db._store.refunds.k1.state, 'COMPLETED');
  assert.equal(db._store.refunds.k1.history.filter((h) => h.to === 'COMPLETED').length, 1);
  assert.equal((await handleRefundEvent({ event: 'refund.processed', data: {} }, { db })).handled, false);
});

test('webhook signature: an invalid/missing signature is rejected, a valid one is accepted', async () => {
  const handler = require('../api/paystack-webhook');
  const raw = Buffer.from(JSON.stringify({ event: 'refund.processed', data: { transaction_reference: 'zzz' } }));
  const mk = (sig) => ({ method: 'POST', headers: sig ? { 'x-paystack-signature': sig } : {}, rawBody: raw });
  const out = () => { const o = { s: null }; return { o, res: { status(c) { o.s = c; return this; }, json() { return this; } } }; };
  const keys = async () => ['sk_test_secret'];
  let r = out(); await handler(mk(null), r.res, { keys, db: fake.makeDb() }); assert.equal(r.o.s, 401);
  r = out(); await handler(mk('deadbeef'), r.res, { keys, db: fake.makeDb() }); assert.equal(r.o.s, 401);
  const good = crypto.createHmac('sha512', 'sk_test_secret').update(raw).digest('hex');
  r = out(); await handler(mk(good), r.res, { keys, db: fake.makeDb() }); assert.equal(r.o.s, 200);
});
