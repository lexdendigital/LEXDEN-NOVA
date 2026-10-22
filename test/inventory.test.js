const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const D = require('../api/inventory/domain');
const S = require('../api/inventory/service');

test.before(() => fake.install());
test.after(() => fake.restore());

const snap = (o = {}) => ({ offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'SELLER_STOCK', stock: 1, sku: 'SKU-1', ...o });
function world(products = {}, creatorStatus = 'ACTIVE') {
  return fake.makeDb({
    creators: { c1: { status: creatorStatus }, c2: { status: 'ACTIVE' } },
    products: { p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap() }, ...products },
  });
}
const item = (db, id = 'c1__p1__default__main') => db._store.inventoryItems[id];

// ---------------- domain
test('domain: availableToSell and invariants', () => {
  assert.equal(D.availableToSell({ onHand: 10, reserved: 2, unavailable: 1, safetyStock: 3 }), 4);
  assert.equal(D.availableToSell({ onHand: 1, reserved: 0, unavailable: 0, safetyStock: 5 }), 0);
  assert.throws(() => D.newItem({ creatorId: 'c', productId: 'p', onHand: -1 }));
  assert.throws(() => D.applyMovement(D.newItem({ creatorId: 'c', productId: 'p', onHand: 1 }), { type: 'RESERVE', quantity: 2 }), /Only 1/);
});
test('domain: count cannot go below committed; return-to-stock needs resellable confirmation', () => {
  const it = { ...D.newItem({ creatorId: 'c', productId: 'p', onHand: 5 }), reserved: 2, unavailable: 1 };
  assert.throws(() => D.applyMovement(it, { type: 'COUNT_CORRECTION', countedOnHand: 2 }), (e) => e.code === 'COUNT_BELOW_COMMITTED');
  assert.throws(() => D.applyMovement(it, { type: 'RETURN_TO_STOCK', quantity: 1 }), (e) => e.code === 'RESELLABLE_CONFIRMATION_REQUIRED');
  assert.equal(D.applyMovement(it, { type: 'RETURN_TO_STOCK', quantity: 1, resellableConfirmed: true }).item.onHand, 6);
});
test('domain: matching uses SKU/GTIN/confirmed id only, never a title', () => {
  const items = [{ id: 'a', sku: 'X1' }, { id: 'b', sku: 'X2', gtin: '123' }];
  assert.equal(D.matchListing({ sku: 'x1' }, items).status, 'MAPPED');
  assert.equal(D.matchListing({ title: 'X1 lookalike' }, items).status, 'UNMAPPED');
  assert.equal(D.matchListing({ gtin: '123' }, items).status, 'NEEDS_REVIEW');
  assert.equal(D.matchListing({ sku: 'X1', gtin: '123' }, items).status, 'NEEDS_REVIEW'); // two pools match
});
test('domain: syncHealth never claims connected without a real adapter', () => {
  const now = 1e12;
  assert.equal(D.syncHealth({ mode: 'CONNECTED', adapterAvailable: false, enabled: true, lastSuccessAtMs: now, nowMs: now }).status, 'UNAVAILABLE');
  assert.equal(D.syncHealth({ mode: 'CONNECTED', adapterAvailable: true, enabled: true, lastSuccessAtMs: now - 7 * 3600e3, nowMs: now }).status, 'STALE');
  assert.equal(D.syncHealth({ mode: 'CONNECTED', adapterAvailable: true, enabled: true, lastSuccessAtMs: now - 1000, nowMs: now }).status, 'HEALTHY');
  assert.equal(D.syncHealth({ mode: 'MANUAL_OR_BATCH', nowMs: now }).status, 'MANUAL');
});
test('domain: availability models do not force digital/service into unit stock', () => {
  assert.equal(D.availabilityModelFor('PHYSICAL_PRODUCT', 'SELLER_STOCK').model, 'UNIT_STOCK');
  assert.equal(D.availabilityModelFor('PHYSICAL_PRODUCT', 'CJ_DROPSHIP').model, 'SUPPLIER_AVAILABILITY');
  assert.equal(D.availabilityModelFor('DIGITAL_PRODUCT').model, 'ENTITLEMENT');
  assert.equal(D.availabilityModelFor('APPOINTMENT').model, 'TIME_SLOTS');
});

// ---------------- reservations
test('last unit: two simultaneous buyers, exactly one wins', async () => {
  const db = world();
  const r = await Promise.allSettled([
    S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1' }),
    S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-BBB2' }),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  const lost = r.find((x) => x.status === 'rejected').reason;
  assert.equal(lost.code, 'INSUFFICIENT_STOCK');
  assert.equal(item(db).reserved, 1);
});
test('reserve is idempotent for the same checkout and cannot be reused after expiry', async () => {
  const db = world({ p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap({ stock: 5 }) } });
  const a = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 1000 });
  const b = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 2000 });
  assert.equal(b.reused, true); assert.equal(item(db).reserved, 1); assert.equal(a.reservation.id, b.reservation.id);
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 1000 + 16 * 60e3 }), (e) => e.code === 'RESERVATION_CLOSED');
});
test('expired hold is released automatically so the next buyer can buy', async () => {
  const db = world();
  await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 1000 });
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-BBB2', nowMs: 2000 }), (e) => e.code === 'INSUFFICIENT_STOCK');
  const ok = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-BBB2', nowMs: 1000 + 16 * 60e3 });
  assert.equal(ok.ok, true); assert.equal(item(db).reserved, 1);
});
test('consume once: replay of the same order never double-decrements', async () => {
  const db = world({ p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap({ stock: 5 }) } });
  const r = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1' });
  const a = await S.consumeForOrder(db, { orderRef: 'ORD1', productId: 'p1', reservationId: r.reservation.id });
  const b = await S.consumeForOrder(db, { orderRef: 'ORD1', productId: 'p1', reservationId: r.reservation.id });
  assert.equal(a.ok, true); assert.equal(b.already, true);
  assert.equal(item(db).onHand, 4); assert.equal(item(db).reserved, 0);
  const c = await S.consumeForOrder(db, { orderRef: 'ORD2', productId: 'p1', reservationId: r.reservation.id });
  assert.equal(c.ok, false); assert.equal(c.code, 'RESERVATION_ALREADY_USED');
  assert.equal(item(db).onHand, 4);
});
test('late payment after expiry: honoured only if stock remains, else an explicit failure (no clamp to zero)', async () => {
  const db = world();
  const r = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 1000 });
  await S.sweepExpired(db, { nowMs: 1000 + 16 * 60e3 });
  await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-BBB2', nowMs: 1000 + 17 * 60e3 }); // someone else took the unit
  const late = await S.consumeForOrder(db, { orderRef: 'ORD1', productId: 'p1', reservationId: r.reservation.id });
  assert.equal(late.ok, false); assert.equal(late.code, 'STOCK_UNAVAILABLE_AFTER_PAYMENT');
  assert.ok(item(db).onHand >= 0 && item(db).reserved === 1);
});
test('late payment with stock still free is honoured', async () => {
  const db = world();
  const r = await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', nowMs: 1000 });
  await S.sweepExpired(db, { nowMs: 1000 + 16 * 60e3 });
  const late = await S.consumeForOrder(db, { orderRef: 'ORD1', productId: 'p1', reservationId: r.reservation.id });
  assert.equal(late.ok, true); assert.equal(item(db).onHand, 0);
});
test('direct consume with no reservation cannot oversell', async () => {
  const db = world();
  assert.equal((await S.consumeForOrder(db, { orderRef: 'O1', productId: 'p1' })).ok, true);
  const second = await S.consumeForOrder(db, { orderRef: 'O2', productId: 'p1' });
  assert.equal(second.ok, false); assert.equal(item(db).onHand, 0);
});
test('listing with no numeric stock is out of stock (never unlimited)', async () => {
  const db = world({ p2: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap({ stock: undefined, sku: 'S2' }) } });
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p2', checkoutId: 'checkout-AAA1' }), (e) => e.code === 'INSUFFICIENT_STOCK');
});
test('non-sellable states are refused: unpublished product, suspended seller', async () => {
  const db = world({ p3: { creatorId: 'c1', status: 'DRAFT', publishedSnapshot: snap() } });
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p3', checkoutId: 'checkout-AAA1' }), (e) => e.code === 'NOT_FOR_SALE');
  const db2 = world({}, 'SUSPENDED');
  await assert.rejects(S.reserveForCheckout(db2, { productId: 'p1', checkoutId: 'checkout-AAA1' }), (e) => e.code === 'SELLER_UNAVAILABLE');
});
test('digital and CJ drop-ship listings are not forced into unit stock', async () => {
  const db = world({
    d1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: { offeringType: 'DIGITAL_PRODUCT' } },
    cj1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap({ fulfillmentMode: 'CJ_DROPSHIP' }) },
  });
  assert.equal((await S.reserveForCheckout(db, { productId: 'd1', checkoutId: 'checkout-AAA1' })).tracked, false);
  assert.equal((await S.reserveForCheckout(db, { productId: 'cj1', checkoutId: 'checkout-AAA1' })).tracked, false);
  assert.equal(db._store.inventoryItems && db._store.inventoryItems['c1__d1__default__main'], undefined);
});
test('bad checkout id / quantity are rejected', async () => {
  const db = world();
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'x' }), (e) => e.code === 'BAD_CHECKOUT_ID');
  await assert.rejects(S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', quantity: 0 }), (e) => e.code === 'BAD_QUANTITY');
});

// ---------------- quick actions
async function stocked(n = 10) {
  const db = world({ p1: { creatorId: 'c1', status: 'PUBLISHED', publishedSnapshot: snap({ stock: n }) } });
  await S.listItems(db, 'c1');
  return db;
}
const ID = 'c1__p1__default__main';
test('quick actions: attribution, history, idempotent replay', async () => {
  const db = await stocked(10);
  const a = await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'EXTERNAL_SALE', quantity: 2, channel: 'MARKET_STALL', actor: 'uid-c1', idempotencyKey: 'key-0000001' });
  const b = await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'EXTERNAL_SALE', quantity: 2, channel: 'MARKET_STALL', actor: 'uid-c1', idempotencyKey: 'key-0000001' });
  assert.equal(a.already, false); assert.equal(b.already, true);
  assert.equal(item(db).onHand, 8);
  const h = await S.history(db, 'c1', { itemId: ID });
  const m = h.find((x) => x.type === 'EXTERNAL_SALE');
  assert.equal(m.actor, 'uid-c1'); assert.equal(m.channel, 'MARKET_STALL'); assert.equal(m.before.onHand, 10); assert.equal(m.after.onHand, 8);
});
test('external sale cannot consume units reserved for open orders', async () => {
  const db = await stocked(2);
  await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', quantity: 2 });
  await assert.rejects(S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'EXTERNAL_SALE', quantity: 1, actor: 'u', idempotencyKey: 'key-0000002' }), (e) => e.code === 'INSUFFICIENT_UNRESERVED_STOCK');
});
test('mark unavailable / restore, safety stock lowers availability', async () => {
  const db = await stocked(10);
  await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'MARK_UNAVAILABLE', quantity: 3, reason: 'DAMAGED', actor: 'u', idempotencyKey: 'key-0000003' });
  await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'SAFETY_STOCK_CHANGE', safetyStock: 2, actor: 'u', idempotencyKey: 'key-0000004' });
  assert.equal(D.availableToSell(item(db)), 5);
  await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'RESTORE_AVAILABLE', quantity: 3, actor: 'u', idempotencyKey: 'key-0000005' });
  assert.equal(D.availableToSell(item(db)), 8);
  assert.equal(db._store.products.p1.stockSummary.availableToSell, 8);
});
test('return-to-stock requires confirmation; creators cannot run system movements', async () => {
  const db = await stocked(1);
  await assert.rejects(S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'RETURN_TO_STOCK', quantity: 1, actor: 'u', idempotencyKey: 'key-0000006' }), (e) => e.code === 'RESELLABLE_CONFIRMATION_REQUIRED');
  await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'RETURN_TO_STOCK', quantity: 1, resellableConfirmed: true, actor: 'u', idempotencyKey: 'key-0000007' });
  assert.equal(item(db).onHand, 2);
  for (const type of ['CONSUME', 'RESERVE', 'RELEASE', 'INITIAL_IMPORT']) {
    await assert.rejects(S.adjust(db, { creatorId: 'c1', itemId: ID, type, quantity: 1, actor: 'u', idempotencyKey: 'key-0000008' }), (e) => e.code === 'ACTION_NOT_ALLOWED');
  }
  await assert.rejects(S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'RESTOCK', quantity: 1, actor: 'u' }), (e) => e.code === 'IDEMPOTENCY_KEY_REQUIRED');
});
test('tenant isolation: another creator cannot read or change my stock', async () => {
  const db = await stocked(5);
  await assert.rejects(S.adjust(db, { creatorId: 'c2', itemId: ID, type: 'RESTOCK', quantity: 9, actor: 'x', idempotencyKey: 'key-0000009' }), (e) => e.code === 'NOT_FOUND');
  assert.equal(item(db).onHand, 5);
  assert.deepEqual(await S.listItems(db, 'c2'), []);
  assert.deepEqual(await S.history(db, 'c2', {}), []);
});
test('variant and location isolation + transfer', async () => {
  const db = await stocked(5);
  await S.reserveForCheckout(db, { productId: 'p1', checkoutId: 'checkout-AAA1', variantKey: 'red', locationId: 'main' }).catch(() => {});
  db._store.inventoryItems.shop = { ...D.newItem({ creatorId: 'c1', productId: 'p1', locationId: 'shop', onHand: 0 }) };
  db._store.inventoryItems.shop.locationId = 'shop';
  await S.transfer(db, { creatorId: 'c1', fromItemId: ID, toItemId: 'shop', quantity: 2, actor: 'u', idempotencyKey: 'xfer-000001' });
  await S.transfer(db, { creatorId: 'c1', fromItemId: ID, toItemId: 'shop', quantity: 2, actor: 'u', idempotencyKey: 'xfer-000001' });
  assert.equal(item(db, ID).onHand, 3); assert.equal(db._store.inventoryItems.shop.onHand, 2);
  await assert.rejects(S.transfer(db, { creatorId: 'c1', fromItemId: ID, toItemId: ID, quantity: 1, actor: 'u', idempotencyKey: 'xfer-000002' }), (e) => e.code === 'SAME_LOCATION');
  await assert.rejects(S.transfer(db, { creatorId: 'c1', fromItemId: ID, toItemId: 'shop', quantity: 99, actor: 'u', idempotencyKey: 'xfer-000003' }), (e) => e.code === 'INSUFFICIENT_UNRESERVED_STOCK');
});
test('no republish needed: stock changes never touch the published snapshot', async () => {
  const db = await stocked(5);
  const before = JSON.stringify(db._store.products.p1.publishedSnapshot);
  await S.adjust(db, { creatorId: 'c1', itemId: ID, type: 'RESTOCK', quantity: 5, actor: 'u', idempotencyKey: 'key-0000010' });
  assert.equal(JSON.stringify(db._store.products.p1.publishedSnapshot), before);
  assert.equal(db._store.products.p1.status, 'PUBLISHED');
});

// ---------------- CSV + channels
test('CSV import: preview rejects bad rows, commit is idempotent and per-row reported', async () => {
  const db = await stocked(5);
  const csv = 'sku,quantity,mode\nSKU-1,12,SET\nNOPE,3,ADD\nSKU-1,1,ADD';
  const pv = await S.previewImport(db, 'c1', csv);
  assert.equal(pv.invalidCount, 2); // unknown sku + duplicate sku
  const refused = await S.commitImport(db, { creatorId: 'c1', csvText: csv, importId: 'import-0001', actor: 'u' });
  assert.equal(refused.refused, true); assert.equal(item(db).onHand, 5);
  const good = 'sku,quantity,mode\nSKU-1,12,SET';
  const a = await S.commitImport(db, { creatorId: 'c1', csvText: good, importId: 'import-0002', actor: 'u' });
  const b = await S.commitImport(db, { creatorId: 'c1', csvText: good, importId: 'import-0002', actor: 'u' });
  assert.equal(a.applied, 1); assert.equal(b.applied, 0); assert.equal(b.rows[0].result, 'ALREADY_APPLIED');
  assert.equal(item(db).onHand, 12);
  assert.equal((await S.commitImport(db, { creatorId: 'c1', csvText: 'a,b\n1,2', importId: 'import-0003', actor: 'u' })).refused, true);
});
test('CSV cannot touch another creator\'s SKU', async () => {
  const db = await stocked(5);
  const pv = await S.previewImport(db, 'c2', 'sku,quantity\nSKU-1,99');
  assert.equal(pv.rows[0].valid, false);
});
test('channel mapping: SKU maps, title-only does not, sync cannot be enabled without an adapter', async () => {
  const db = await stocked(5);
  const m = await S.mapChannelListing(db, { creatorId: 'c1', channel: 'INSTAGRAM', externalId: 'ig1', sku: 'SKU-1' });
  assert.equal(m.mappingStatus, 'MAPPED'); assert.equal(m.syncEnabled, false);
  const u = await S.mapChannelListing(db, { creatorId: 'c1', channel: 'INSTAGRAM', externalId: 'ig2', title: 'Shoe' });
  assert.equal(u.mappingStatus, 'UNMAPPED');
  await assert.rejects(S.enableChannelSync(db, { creatorId: 'c1', listingId: m.id, authoritative: 'NOVA', acknowledgedPreview: true }), (e) => e.code === 'CONNECTED_SYNC_UNAVAILABLE');
  await assert.rejects(S.enableChannelSync(db, { creatorId: 'c2', listingId: m.id }), (e) => e.code === 'NOT_FOUND');
});
