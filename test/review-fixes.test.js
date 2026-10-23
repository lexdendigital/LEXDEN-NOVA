// Regression tests for the independent review's confirmed findings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const R = require('../api/core/refunds');
const { handleRefundEvent } = require('../api/paystack-webhook');
const C = require('../api/creator/checkout');
const P = require('../api/delivery/proof');
const ledger = require('../api/creator/ledger');
const S = require('../api/inventory/service');

test.before(() => fake.install());
test.after(() => fake.restore());

test('refund webhook is matched to ONE refund; unsent refunds are never advanced', async () => {
  const db = fake.makeDb();
  const mk = async (key, amt) => { await R.requestRefund(db, { orderId: 'o9', idempotencyKey: key, amountMinor: amt, paidMinor: 20000, reason: 'NOT_DELIVERED', requestedBy: 'a', paymentReference: 'o9' }); await R.transition(db, key, 'APPROVED', {}); };
  await mk('A', 5000); await mk('B', 7000);
  await R.transition(db, 'B', 'PROVIDER_INITIATED', { patch: { providerRefundId: 'rf_B' } });
  await handleRefundEvent({ event: 'refund.processed', data: { transaction_reference: 'o9', status: 'processed', id: 'rf_B', amount: 7000 } }, { db });
  assert.equal(db._store.refunds.B.state, 'COMPLETED');
  assert.equal(db._store.refunds.A.state, 'APPROVED');
  await R.transition(db, 'A', 'PROVIDER_INITIATED', { patch: { providerRefundId: 'rf_A' } });
  await mk('C', 3000); await R.transition(db, 'C', 'PROVIDER_INITIATED', { patch: { providerRefundId: 'rf_C' } });
  const r = await handleRefundEvent({ event: 'refund.processed', data: { transaction_reference: 'o9', status: 'processed', amount: 123 } }, { db });
  assert.equal(r.handled, false);
  assert.equal(db._store.refunds.A.state, 'PROVIDER_INITIATED'); assert.equal(db._store.refunds.C.state, 'PROVIDER_INITIATED');
  await handleRefundEvent({ event: 'refund.processed', data: { transaction_reference: 'o9', status: 'processed', amount: 3000 } }, { db });
  assert.equal(db._store.refunds.C.state, 'COMPLETED'); assert.equal(db._store.refunds.A.state, 'PROVIDER_INITIATED');
});

test('exception raised again after it was resolved re-opens (never strands the hold flags)', async () => {
  const db = fake.makeDb({ fulfillments: { o1: {} }, creatorSales: { o1: {} } });
  const a = await C.openException(db, { orderId: 'o1', code: 'DELIVERY_PROOF_PROBLEM' });
  await C.resolveException(db, { id: a.id, resolution: 'FULFILLED_ANYWAY', actor: 'a' });
  const b = await C.openException(db, { orderId: 'o1', code: 'DELIVERY_PROOF_PROBLEM' });
  assert.equal(b.reopened, true);
  assert.equal((await C.listExceptions(db)).length, 1);
  // a CANCELLED (invalid) report also lifts the hold
  db._store.creatorSales.o1.exceptionOpen = true; db._store.fulfillments.o1.exceptionOpen = true;
  await C.resolveException(db, { id: a.id, resolution: 'CANCELLED', actor: 'a' });
  assert.equal(db._store.creatorSales.o1.exceptionOpen, false);
});

test('flagging a missing sale never creates a stub document', async () => {
  const db = fake.makeDb({ fulfillments: { o2: { buyerUid: 'b', creatorId: 'c', productId: 'p', status: 'SHIPPED' } } });
  await P.reportProblem(db, { orderId: 'o2', reportedBy: 'b', reason: 'never came at all' });
  assert.equal(db._store.creatorSales && db._store.creatorSales.o2, undefined);
  assert.equal(db._store.fulfillments.o2.exceptionOpen, true);
});

test('settleStock consumes the buyer\'s own hold even without a reservationId (webhook path)', async () => {
  const db = fake.makeDb({ creators: { c1: { status: 'ACTIVE' } }, products: { p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock: 1, sku: 'A' } } } });
  await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'REF_12345678' });
  const out = await C.settleStock(db, { orderId: 'REF_12345678', selection: { creator: { productId: 'p1', creatorId: 'c1', offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK' } } });
  assert.equal(out.ok, true);
  assert.equal(Object.values(db._store.orderExceptions || {}).length, 0);
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].onHand, 0);
});

test('a rejected dispute on a sale with an open exception goes back to held, not available', async () => {
  const db = fake.makeDb({ catalog: { settings: { content: {} } } });
  await ledger.attributeCreatorEarning(db, { reference: 'o3', creatorId: 'c1', productId: 'p', productTitle: 'x', offeringType: 'PHYSICAL_PRODUCT', amountMajor: 10000, currency: 'NGN', exceptionOpen: true });
  await ledger.markDelivered(db, 'o3', { source: 'CARRIER', atMs: 1000 });
  await ledger.freezeSale(db, 'o3', 'd1');
  const r = await ledger.unfreezeSale(db, 'o3', 10 * 365 * 86400000);
  assert.equal(r.to, 'held'); assert.equal(db._store.creatorSales.o3.status, 'held');
});

test('a code cannot start the earning clock for a cancelled order and is not burned', async () => {
  const env = { DELIVERY_CODE_SECRET: 'x'.repeat(40), RIDER_VAULT_ENABLED: 'true' };
  const db = fake.makeDb({ catalog: { settings: { content: {} } }, fulfillments: { o4: { buyerUid: 'b1', creatorId: 'c1', productId: 'p', status: 'SHIPPED' } } });
  await ledger.attributeCreatorEarning(db, { reference: 'o4', creatorId: 'c1', productId: 'p', productTitle: 'x', offeringType: 'PHYSICAL_PRODUCT', amountMajor: 10000, currency: 'NGN' });
  const { code } = await P.issueCode(db, { orderId: 'o4', buyerUid: 'b1', env });
  const t = await P.issueRiderTask(db, { orderId: 'o4', riderId: 'r', env });
  db._store.fulfillments.o4.status = 'CANCELLED';
  const r = await P.verifyCode(db, { orderId: 'o4', code, enteredBy: { type: 'RIDER', taskId: t.taskId, taskToken: t.token }, env });
  assert.equal(r.code, 'ORDER_NOT_IN_TRANSIT');
  assert.equal(db._store.creatorSales.o4.deliveredAtMs, undefined);
  assert.equal(db._store.deliveryCodes.o4.state, 'ACTIVE');
});
