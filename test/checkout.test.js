const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const C = require('../api/creator/checkout');
const S = require('../api/inventory/service');
const ledger = require('../api/creator/ledger');

test.before(() => fake.install());
test.after(() => fake.restore());

const snap = { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock: 1, sku: 'A' };
const world = (cs = 'ACTIVE', ps = 'PUBLISHED') => fake.makeDb({
  catalog: { settings: { content: {} } },
  creators: { c1: { status: cs } },
  products: { p1: { creatorId: 'c1', status: ps, publishedSnapshot: snap } },
});
const sel = { creator: { productId: 'p1', creatorId: 'c1', offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK' } };

test('amount verification accepts exact charge and authenticated Paystack fee pass-through only', () => {
  const exact = C.checkAmount({ paidMinor: 1000000, requestedMinor: 1000000, expectedMajor: 10000 });
  assert.equal(exact.ok, true); assert.equal(exact.match, 'EXACT');

  const under = C.checkAmount({ paidMinor: 999999, requestedMinor: 1000000, expectedMajor: 10000 });
  assert.equal(under.ok, false); assert.equal(under.direction, 'UNDERPAID');

  const unexplainedOver = C.checkAmount({ paidMinor: 1000001, expectedMajor: 10000 });
  assert.equal(unexplainedOver.ok, false); assert.equal(unexplainedOver.direction, 'OVERPAID');

  // Production regression: NOVA requested NGN 27,835; Paystack charged
  // NGN 28,360.41 after "Pass fees to customers". This must fulfil.
  const feePassed = C.checkAmount({ paidMinor: 2836041, requestedMinor: 2783500, expectedMajor: 27835 });
  assert.equal(feePassed.ok, true); assert.equal(feePassed.match, 'PAYSTACK_FEE_PASSTHROUGH');

  // Partial-debit safety: requested_amount can still equal the intended total
  // when Paystack actually charged less. Never fulfil from requested_amount alone.
  const partialDebit = C.checkAmount({ paidMinor: 2000000, requestedMinor: 2783500, expectedMajor: 27835 });
  assert.equal(partialDebit.ok, false); assert.equal(partialDebit.direction, 'UNDERPAID');

  assert.equal(C.checkAmount({ paidMinor: 9800 * 100, requestedMinor: 10000 * 100, expectedMajor: 10000 }).ok, false);
  assert.equal(C.checkAmount({ paidMinor: 1999, requestedMinor: 1999, expectedMajor: 19.99 }).ok, true);
  assert.equal(C.checkAmount({ paidMinor: 'x', requestedMinor: 500, expectedMajor: 5 }).ok, false);
});
test('seller must be ACTIVE and product PUBLISHED', async () => {
  assert.equal((await C.checkSellable(world(), 'p1')).ok, true);
  assert.equal((await C.checkSellable(world('SUSPENDED'), 'p1')).code, 'SELLER_NOT_ACTIVE');
  assert.equal((await C.checkSellable(world('ACTIVE', 'ARCHIVED'), 'p1')).code, 'NOT_FOR_SALE');
  assert.equal((await C.checkSellable(world(), 'nope')).code, 'NOT_FOR_SALE');
});
test('exceptions are idempotent per order+code and resolve without moving money', async () => {
  const db = world();
  const a = await C.openException(db, { orderId: 'o1', code: 'AMOUNT_MISMATCH', creatorId: 'c1' });
  const b = await C.openException(db, { orderId: 'o1', code: 'AMOUNT_MISMATCH', creatorId: 'c1' });
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal((await C.listExceptions(db)).length, 1);
  await assert.rejects(C.resolveException(db, { id: a.id, resolution: 'BOGUS' }), (e) => e.status === 422);
  const r = await C.resolveException(db, { id: a.id, resolution: 'REFUNDED', actor: 'admin1' });
  assert.equal(r.orderFullyCleared, true);
  assert.equal((await C.resolveException(db, { id: a.id, resolution: 'REFUNDED', actor: 'admin1' })).already, true);
  assert.equal((await C.listExceptions(db)).length, 0);
});
test('stock shortage after payment opens an exception and flags the sale so earnings stay held', async () => {
  const db = world();
  assert.equal((await C.settleStock(db, { orderId: 'o1', selection: sel })).ok, true);
  const out = await C.settleStock(db, { orderId: 'o2', selection: sel });
  assert.equal(out.ok, false);
  const ex = await C.listExceptions(db);
  assert.equal(ex.length, 1); assert.equal(ex[0].code, 'STOCK_UNAVAILABLE_AFTER_PAYMENT');
  await ledger.attributeCreatorEarning(db, { reference: 'o2', creatorId: 'c1', productId: 'p1', productTitle: 'x', offeringType: 'PHYSICAL_PRODUCT', amountMajor: 1000, currency: 'NGN', exceptionOpen: true });
  const sale = db._store.creatorSales.o2;
  assert.equal(sale.exceptionOpen, true); assert.equal(sale.status, 'held');
  // resolving FULFILLED_ANYWAY lifts the flag on sale + fulfilment
  db._store.fulfillments = { o2: { exceptionOpen: true } };
  await C.resolveException(db, { id: ex[0].id, resolution: 'FULFILLED_ANYWAY', actor: 'a' });
  assert.equal(db._store.creatorSales.o2.exceptionOpen, false); assert.equal(db._store.fulfillments.o2.exceptionOpen, false);
});
test('settleStock: replay never double-consumes; digital/CJ are untracked', async () => {
  const db = world();
  await C.settleStock(db, { orderId: 'o1', selection: sel }); await C.settleStock(db, { orderId: 'o1', selection: sel });
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].onHand, 0);
  assert.equal((await C.settleStock(db, { orderId: 'o3', selection: { creator: { offeringType: 'DIGITAL_PRODUCT' } } })).tracked, false);
  assert.equal((await C.settleStock(db, { orderId: 'o4', selection: { creator: { ...sel.creator, fulfillmentMode: 'CJ_DROPSHIP' } } })).tracked, false);
});
test('a reservation made before payment is the one consumed', async () => {
  const db = world();
  const r = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-0001' });
  assert.equal((await C.settleStock(db, { orderId: 'o1', selection: sel, reservationId: r.reservation.id })).ok, true);
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].reserved, 0);
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].onHand, 0);
});
