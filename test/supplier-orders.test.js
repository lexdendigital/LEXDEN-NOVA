const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { makeFakeCj } = require('./helpers/fake-cj');

process.env.SUPPLIER_CREDENTIALS_KEY = 'd4'.repeat(32);
// Legacy tests exercise the explicit creator-account funding opt-in; the gate has its own tests below.
process.env.CJ_FUNDING_MODE = 'CREATOR_ACCOUNT';
const service = require('../api/supplier/service');
const orders = require('../api/supplier/orders');

const creds = { email: 'jane@example.com', apiKey: 'good-api-key' };
const delivery = { name: 'Ada Obi', address: '12 Allen Ave', city: 'Ikeja', state: 'Lagos', phone: '08030000000', country: 'Nigeria' };

async function setup(over = {}) {
  const cj = makeFakeCj();
  const db = makeDb();
  await service.connectCj(db, { uid: 'u1', creator: { status: 'ACTIVE' }, ...creds, ...(over.autoPay ? { autoPay: true, autoPayConsent: true } : {}) }, cj.deps);
  db._store.products = { p1: { creatorId: 'u1', status: 'PUBLISHED', latestVersionId: 'v1', currentVersionId: 'v1', publishedSnapshot: { fulfillmentMode: 'CJ_DROPSHIP' } } };
  db._store.productVersions = { v1: { status: 'DRAFT', fields: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'CJ_DROPSHIP' } } };
  await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  db._store.orders = { o1: { status: 'paid', creatorVersionId: 'v1' } };
  db._store.fulfillments = { o1: { creatorId: 'u1', productId: 'p1', versionId: 'v1', status: 'PENDING', delivery, ...(over.fulfillment || {}) } };
  return { cj, db };
}

test('creates ONE CJ order in the creator account with payType 3 by default', async () => {
  const { cj, db } = await setup();
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.ok, true); assert.equal(r.status, 'ORDERED'); assert.equal(r.payType, 3);
  const created = cj.st.calls.filter((c) => c.path === '/shopping/order/createOrderV2');
  assert.equal(created.length, 1);
  const b = created[0].body;
  assert.equal(b.orderNumber, 'NOVA-o1');
  assert.equal(b.logisticName, 'CJPacket');
  assert.equal(b.shippingCountry, 'Nigeria'); assert.equal(b.shippingCountryCode, 'NG');
  assert.equal(b.fromCountryCode, 'CN'); assert.equal(b.payType, 3);
  assert.deepEqual(b.products, [{ vid: 'VID12345', quantity: 1 }]);
  assert.equal(db._store.supplierOrders.o1.cjOrderId, 'CJO1');
  // never on the buyer-readable fulfillment
  assert.ok(!JSON.stringify(db._store.fulfillments.o1).includes('CJO1'));
});

test('payType 2 only when the creator opted in to auto-pay', async () => {
  const { cj, db } = await setup({ autoPay: true });
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.payType, 2);
  assert.equal(db._store.supplierOrders.o1.paidFromCjBalance, true);
});

test('idempotent: calling twice, or concurrently, never makes a second CJ order', async () => {
  const { cj, db } = await setup();
  const [a, b] = await Promise.all([orders.createCjOrderForFulfillment(db, 'o1', cj.deps), orders.createCjOrderForFulfillment(db, 'o1', cj.deps)]);
  const again = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(Object.keys(cj.st.orders).length, 1);
  assert.equal(again.alreadyCreated, true);
  assert.ok([a, b].some((x) => x.status === 'ORDERED'));
});

test('a crashed attempt (stale claim) ADOPTS the order CJ already has instead of duplicating', async () => {
  const { cj, db } = await setup();
  cj.st.orders.CJO9 = { orderId: 'CJO9', orderNumber: 'NOVA-o1', orderStatus: 'CREATED' };
  db._store.supplierOrders = { o1: { creatorId: 'u1', status: 'CREATING', claimedAtMs: Date.now() - 10 * 60 * 1000 } };
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.cjOrderId, 'CJO9'); assert.equal(r.alreadyCreated, true);
  assert.equal(cj.st.calls.filter((c) => c.path === '/shopping/order/createOrderV2').length, 0);
  assert.equal(db._store.supplierOrders.o1.adopted, true);
});

test('a fresh in-progress claim blocks a second worker', async () => {
  const { cj, db } = await setup();
  db._store.supplierOrders = { o1: { creatorId: 'u1', status: 'CREATING', claimedAtMs: Date.now() } };
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.ok, true); assert.equal(r.status, 'CREATING');
  assert.equal(cj.st.calls.filter((c) => c.path === '/shopping/order/createOrderV2').length, 0);
});

test('out of stock at order time: no CJ order, STOCK_ISSUE, listing re-checked and paused', async () => {
  const { cj, db } = await setup();
  cj.st.stock.VID12345 = 0;
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.ok, false); assert.equal(r.status, 'STOCK_ISSUE');
  assert.equal(Object.keys(cj.st.orders).length, 0);
  assert.equal(db._store.supplierOrders.o1.status, 'STOCK_ISSUE');
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(db._store.products.p1.status, 'PAUSED');
  assert.equal(db._store.fulfillments.o1.status, 'PENDING');
});

test('incomplete delivery, unknown country, untested destination and missing mapping are recorded, not sent', async () => {
  for (const [fulfillment, code] of [
    [{ delivery: { ...delivery, phone: '' } }, 'DELIVERY_INCOMPLETE'],
    [{ delivery: { ...delivery, country: 'Atlantis' } }, 'UNSUPPORTED_COUNTRY'],
    [{ delivery: { ...delivery, country: 'Ghana' } }, 'DESTINATION_NOT_SUPPORTED'],
  ]) {
    const { cj, db } = await setup({ fulfillment });
    const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
    assert.equal(r.code, code);
    assert.equal(Object.keys(cj.st.orders).length, 0);
    assert.equal(db._store.supplierOrders.o1.error.code, code);
  }
  const { cj, db } = await setup();
  delete db._store.supplierProducts.v1;
  assert.equal((await orders.createCjOrderForFulfillment(db, 'o1', cj.deps)).code, 'MAPPING_INVALID');
});

test('guards: unpaid, not pending, unknown order', async () => {
  const { cj, db } = await setup();
  db._store.orders.o1.status = 'pending';
  assert.equal((await orders.createCjOrderForFulfillment(db, 'o1', cj.deps)).status, 'NOT_PAID');
  db._store.orders.o1.status = 'paid'; db._store.fulfillments.o1.status = 'SHIPPED';
  assert.equal((await orders.createCjOrderForFulfillment(db, 'o1', cj.deps)).status, 'NOT_PENDING');
  assert.equal((await orders.createCjOrderForFulfillment(db, 'nope', cj.deps)).status, 'UNKNOWN_ORDER');
  assert.equal(Object.keys(cj.st.orders).length, 0);
});

test('revoked connection: order flagged, never throws, never reaches CJ', async () => {
  const { cj, db } = await setup();
  await service.disconnectCj(db, { uid: 'u1', actorRole: 'admin', reason: 'x' });
  const before = cj.st.calls.length;
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.ok, false);
  assert.equal(cj.st.calls.length, before);
  assert.equal(db._store.supplierOrders.o1.status, 'NEEDS_ATTENTION');
});

test('transient CJ failure on create => RETRY_LATER, and a retry then succeeds exactly once', async () => {
  const { cj, db } = await setup();
  const real = cj.fetchImpl;
  let failed = false;
  const deps = { ...cj.deps, fetchImpl: async (u, i) => { if (!failed && u.includes('createOrderV2')) { failed = true; throw new Error('net'); } return real(u, i); } };
  const r1 = await orders.createCjOrderForFulfillment(db, 'o1', deps);
  assert.equal(r1.status, 'RETRY_LATER');
  const r2 = await orders.createCjOrderForFulfillment(db, 'o1', deps);
  assert.equal(r2.status, 'ORDERED');
  assert.equal(Object.keys(cj.st.orders).length, 1);
});

test('sync: CJ shipped with tracking => PACKED then SHIPPED on the buyer fulfillment', async () => {
  const { cj, db } = await setup();
  await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  Object.assign(cj.st.orders.CJO1, { orderStatus: 'SHIPPED', trackNumber: 'TRK99', logisticName: 'CJPacket' });
  const r = await orders.syncCjFulfillment(db, 'o1', cj.deps);
  assert.deepEqual(r.applied, ['PACKED', 'SHIPPED']);
  const f = db._store.fulfillments.o1;
  assert.equal(f.status, 'SHIPPED'); assert.equal(f.trackingNumber, 'TRK99'); assert.equal(f.carrier, 'CJPacket');
  const again = await orders.syncCjFulfillment(db, 'o1', cj.deps);
  assert.deepEqual(again.applied, []);
});

test('sync: shipped without tracking changes nothing; DELIVERED is evidence only; CANCELLED never cancels', async () => {
  const { cj, db } = await setup();
  await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  cj.st.orders.CJO1.orderStatus = 'SHIPPED';
  assert.deepEqual((await orders.syncCjFulfillment(db, 'o1', cj.deps)).applied, []);
  assert.equal(db._store.fulfillments.o1.status, 'PENDING');
  cj.st.orders.CJO1.orderStatus = 'CANCELLED';
  await orders.syncCjFulfillment(db, 'o1', cj.deps);
  assert.equal(db._store.fulfillments.o1.status, 'PENDING');
  assert.equal(db._store.supplierOrders.o1.status, 'CJ_CANCELLED');
  Object.assign(cj.st.orders.CJO1, { orderStatus: 'DELIVERED', trackNumber: 'TRK00001' });
  await orders.syncCjFulfillment(db, 'o1', cj.deps);
  assert.equal(db._store.fulfillments.o1.status, 'SHIPPED');
  assert.equal(db._store.supplierOrders.o1.carrierDelivered, true);
});

test('sync: no CJ order yet is a clear error', async () => {
  const { cj, db } = await setup();
  await assert.rejects(orders.syncCjFulfillment(db, 'o1', cj.deps), (e) => e.code === 'NO_SUPPLIER_ORDER');
});

test('no secrets in supplier order records or logs', async () => {
  const { cj, db } = await setup();
  await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  const dump = JSON.stringify([db._store.supplierOrders, db._store.supplierSyncLogs, db._store.supplierProducts]);
  for (const s of ['good-api-key', 'AT1', 'RT1', 'jane@example.com']) assert.ok(!dump.includes(s), s);
});

test('FUNDING GATE: default (DISABLED) makes NO CJ order call, opens an exception, never falls back to payType 3', async () => {
  const { cj, db } = await setup();
  const before = cj.st.calls.length;
  for (const mode of [undefined, 'DISABLED', 'NOVA_FUNDED', 'garbage']) {
    const env = { ...process.env, CJ_FUNDING_MODE: mode }; if (mode === undefined) delete env.CJ_FUNDING_MODE;
    const r = await orders.createCjOrderForFulfillment(db, 'o1', { ...cj.deps, env });
    assert.equal(r.ok, false); assert.equal(r.status, 'FUNDING_BLOCKED');
    assert.match(r.code, /CJ_FUNDING_DISABLED|NOVA_FUNDING_PENDING/);
  }
  assert.equal(cj.st.calls.some((c) => /createOrder/.test(c.path)), false);
  assert.equal(cj.st.calls.length, before);
  assert.equal(db._store.fulfillments.o1.exceptionOpen, true);
  const ex = Object.values(db._store.orderExceptions || {});
  assert.equal(ex.length, 1); assert.equal(ex[0].code, 'SUPPLIER_FUNDING_UNAVAILABLE'); assert.equal(ex[0].state, 'OPEN');
  assert.equal(db._store.supplierOrders.o1.status, 'FUNDING_BLOCKED');
});
test('FUNDING GATE: CREATOR_ACCOUNT records an honest payment state', async () => {
  const { cj, db } = await setup();
  const r = await orders.createCjOrderForFulfillment(db, 'o1', cj.deps);
  assert.equal(r.ok, true);
  assert.equal(db._store.supplierOrders.o1.paymentState, 'AWAITING_CREATOR_PAYMENT_IN_CJ');
  assert.equal(db._store.supplierOrders.o1.fundingMode, 'CREATOR_ACCOUNT');
});
