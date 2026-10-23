const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const { run } = require('../scripts/migrate-upgrade');
test.before(() => fake.install());
test.after(() => fake.restore());
const seed = () => fake.makeDb({
  products: {
    p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock: 4, title: 'A' } },
    p2: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', title: 'B' } },
    p3: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'EBOOK' } },
  },
  creatorSales: { o1: { creatorId: 'c1', status: 'available', offeringType: 'PHYSICAL_PRODUCT', creatorEarning: 900 }, o2: { creatorId: 'c1', status: 'held', feeSnapshot: {} } },
});
test('dry run changes NOTHING and reports risks', async () => {
  const db = seed(); const before = JSON.stringify(db._store);
  const r = await run(db, { apply: false });
  assert.equal(JSON.stringify(db._store), before);
  assert.equal(r.dryRun, true); assert.equal(r.listingsOwnStock, 2);
  assert.equal(r.listingsMissingNumericStock.length, 1); assert.equal(r.legacyAvailablePhysicalSales.length, 1); assert.equal(r.salesWithoutFeeSnapshot, 1);
});
test('apply is additive + idempotent and never touches sales or balances', async () => {
  const db = seed(); const salesBefore = JSON.stringify(db._store.creatorSales);
  const a = await run(db, { apply: true }); const b = await run(db, { apply: true });
  assert.equal(a.stockPoolsSeeded, 2); assert.equal(b.stockPoolsSeeded, 0);
  assert.equal(JSON.stringify(db._store.creatorSales), salesBefore);
  assert.equal(db._store.inventoryItems['c1__p1__default__main'].onHand, 4);
  assert.equal(db._store.inventoryItems['c1__p2__default__main'].onHand, 0);
  assert.equal(db._store.creatorPrivate, undefined);
});
