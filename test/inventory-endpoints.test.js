const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const checkoutApi = require('../api/creator-checkout');
const invApi = require('../api/creator-inventory');

test.before(() => fake.install());
test.after(() => fake.restore());

const mkdb = () => fake.makeDb({
  creators: { c1: { status: 'ACTIVE' }, c2: { status: 'ACTIVE' } },
  products: { p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock: 2, sku: 'A' } } },
});
const mkres = () => { const r = { code: 200, body: null, headers: {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {}, end() { return r; } }; return r; };
const call = async (h, body, ip = '1.1.1.1') => { const res = mkres(); await h({ method: 'POST', body, headers: { 'x-forwarded-for': ip } }, res); return res; };

test('public reserve/release: guests allowed, bad input refused, release frees the unit', async () => {
  const db = mkdb(); const h = checkoutApi.makeHandler({ db });
  const a = await call(h, { action: 'reserve', productId: 'p1', checkoutId: 'checkout-0001', quantity: 2 }, '2.2.2.2');
  assert.equal(a.body.ok, true); assert.equal(db._store.inventoryItems['c1__p1__default__main'].reserved, 2);
  const b = await call(h, { action: 'reserve', productId: 'p1', checkoutId: 'checkout-0002' }, '2.2.2.2');
  assert.equal(b.code, 409); assert.equal(b.body.error.code, 'INSUFFICIENT_STOCK');
  await call(h, { action: 'release', productId: 'p1', checkoutId: 'checkout-0001' }, '2.2.2.2');
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].reserved, 0);
  assert.equal((await call(h, { action: 'reserve', productId: 'p1/x', checkoutId: 'checkout-0003' }, '2.2.2.2')).code, 422);
  assert.equal((await call(h, { action: 'nope', productId: 'p1' }, '2.2.2.2')).code, 400);
});
test('public reserve is rate limited per IP', async () => {
  const h = checkoutApi.makeHandler({ db: mkdb() });
  let last; for (let i = 0; i < 32; i++) last = await call(h, { action: 'reserve', productId: 'p1', checkoutId: `checkout-${1000 + i}` }, '9.9.9.9');
  assert.equal(last.code, 429);
});
test('creator inventory act(): scoped to caller, creators cannot run checkout-only movements', async () => {
  const db = mkdb(); const inv = require('../api/inventory/service');
  await inv.listItems(db, 'c1');
  const id = 'c1__p1__default__main';
  const r = await invApi.act(db, { uid: 'c1', creatorId: 'c1' }, { action: 'adjust', itemId: id, type: 'RESTOCK', quantity: 3, idempotencyKey: 'idem-0000001' });
  assert.equal(r.item.onHand, 5);
  await assert.rejects(invApi.act(db, { uid: 'c2', creatorId: 'c2' }, { action: 'adjust', itemId: id, type: 'RESTOCK', quantity: 3, idempotencyKey: 'idem-0000002' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(invApi.act(db, { uid: 'c1', creatorId: 'c1' }, { action: 'adjust', itemId: id, type: 'CONSUME', quantity: 1, idempotencyKey: 'idem-0000003' }), (e) => e.code === 'ACTION_NOT_ALLOWED');
  await assert.rejects(invApi.act(db, { uid: 'c1', creatorId: 'c1' }, { action: 'bogus' }), (e) => e.code === 'INVALID_ACTION');
  const m = await invApi.act(db, { uid: 'c1', creatorId: 'c1' }, { action: 'map_listing', channel: 'INSTAGRAM', externalId: 'x1', sku: 'A' });
  const view = await invApi.channelsView(db, 'c1');
  assert.equal(view[0].health.status, 'MANUAL'); assert.equal(m.syncEnabled, false);
});
