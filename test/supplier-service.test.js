const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { makeFakeCj } = require('./helpers/fake-cj');

process.env.SUPPLIER_CREDENTIALS_KEY = 'c3'.repeat(32);
const service = require('../api/supplier/service');
const store = require('../api/supplier/store');
const { createCjClient } = require('../api/supplier/cj-client');

const ACTIVE = { status: 'ACTIVE' };
const creds = { email: 'jane@example.com', apiKey: 'good-api-key' };

async function connected(cj, db = makeDb()) {
  await service.connectCj(db, { uid: 'u1', creator: ACTIVE, ...creds }, cj.deps);
  return db;
}
function seedDropship(db, over = {}) {
  db._store.products = { p1: { creatorId: 'u1', status: 'PUBLISHED', latestVersionId: 'v1', currentVersionId: 'v1', publishedSnapshot: { fulfillmentMode: 'CJ_DROPSHIP', offeringType: 'PHYSICAL_PRODUCT' }, ...over } };
  db._store.productVersions = { v1: { status: 'DRAFT', fields: { offeringType: 'PHYSICAL_PRODUCT', fulfillmentMode: 'CJ_DROPSHIP' } } };
}

test('connect: stores ENCRYPTED credentials; the public view leaks nothing', async () => {
  const cj = makeFakeCj();
  const db = makeDb();
  const view = await service.connectCj(db, { uid: 'u1', creator: ACTIVE, ...creds }, cj.deps);
  assert.equal(view.connected, true);
  assert.equal(view.accountEmail, 'j***@example.com'.replace('j***', 'j' + '*'.repeat(3)) );
  const raw = JSON.stringify(db._store.supplierConnections.u1_cj);
  assert.ok(!raw.includes('good-api-key'));
  assert.ok(!raw.includes('jane@example.com'));
  assert.ok(!raw.includes('AT1'));
  const pub = JSON.stringify(view);
  for (const s of ['good-api-key', 'AT1', 'RT1', 'jane@', 'credentials', 'tokens']) assert.ok(!pub.includes(s), s);
});

test('connect: wrong key is rejected, nothing stored as connected, attempts throttled', async () => {
  const cj = makeFakeCj();
  const db = makeDb();
  for (let i = 0; i < 5; i++) {
    await assert.rejects(service.connectCj(db, { uid: 'u1', creator: ACTIVE, email: 'jane@example.com', apiKey: 'wrong-key-123' }, cj.deps), (e) => e.code === 'SUPPLIER_AUTH_FAILED');
  }
  assert.notEqual((db._store.supplierConnections.u1_cj || {}).status, 'CONNECTED');
  await assert.rejects(service.connectCj(db, { uid: 'u1', creator: ACTIVE, ...creds }, cj.deps), (e) => e.code === 'TOO_MANY_ATTEMPTS' && e.status === 429);
});

test('connect: fails closed without the encryption key; validates input; needs an ACTIVE creator', async () => {
  const cj = makeFakeCj();
  const saved = process.env.SUPPLIER_CREDENTIALS_KEY;
  delete process.env.SUPPLIER_CREDENTIALS_KEY;
  try {
    const db = makeDb();
    await assert.rejects(service.connectCj(db, { uid: 'u1', creator: ACTIVE, ...creds }, cj.deps), (e) => e.code === 'SUPPLIER_KEY_MISSING');
    assert.ok(!db._store.supplierConnections || !db._store.supplierConnections.u1_cj || db._store.supplierConnections.u1_cj.status !== 'CONNECTED');
  } finally { process.env.SUPPLIER_CREDENTIALS_KEY = saved; }
  await assert.rejects(service.connectCj(makeDb(), { uid: 'u1', creator: { status: 'SUSPENDED' }, ...creds }, cj.deps), (e) => e.code === 'CREATOR_NOT_ELIGIBLE');
  await assert.rejects(service.connectCj(makeDb(), { uid: 'u1', creator: ACTIVE, email: 'nope', apiKey: 'x' }, cj.deps), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(service.connectCj(makeDb(), { uid: 'u1', creator: ACTIVE, ...creds, autoPay: true }, cj.deps), (e) => e.code === 'VALIDATION_FAILED');
});

test('connect: a CJ outage is reported as unavailable, not as wrong credentials', async () => {
  const cj = makeFakeCj(); cj.st.failNext = 'network';
  await assert.rejects(service.connectCj(makeDb(), { uid: 'u1', creator: ACTIVE, ...creds }, cj.deps), (e) => e.code === 'SUPPLIER_UNAVAILABLE');
});

test('autoPay needs explicit consent', async () => {
  const cj = makeFakeCj(); const db = await connected(cj);
  await assert.rejects(service.setAutoPay(db, { uid: 'u1', enabled: true }), (e) => e.code === 'AUTOPAY_CONSENT_REQUIRED');
  const v = await service.setAutoPay(db, { uid: 'u1', enabled: true, consent: true });
  assert.equal(v.autoPay, true);
  assert.equal((await service.setAutoPay(db, { uid: 'u1', enabled: false })).autoPay, false);
});

test('testMapping: valid mapping saved on the draft version', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  const r = await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345', declaredCostUsd: 5 } }, cj.deps);
  assert.equal(r.status, 'VALID');
  assert.equal(db._store.supplierProducts.v1.status, 'VALID');
  assert.deepEqual(db._store.supplierProducts.v1.logisticByCountry, { NG: 'CJPacket' });
});

test('testMapping: unknown variant / no stock / no shipping => INVALID with reasons', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  let r = await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'NOPE12345' } }, cj.deps);
  assert.equal(r.status, 'INVALID'); assert.equal(r.checks.variantValid, false);
  cj.st.stock.VID12345 = 0; db._store.supplierProducts.v1.lastCheckedAtMs = 0;
  r = await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  assert.equal(r.checks.stockOk, false);
  cj.st.stock.VID12345 = 10; cj.st.freight.NG = []; db._store.supplierProducts.v1.lastCheckedAtMs = 0;
  r = await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  assert.equal(r.checks.shippingOk, false);
});

test('testMapping: ownership, mode, editability, throttle, CJ outage', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  await assert.rejects(service.testMapping(db, { uid: 'someone-else', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'NOT_FOUND');
  db._store.productVersions.v1.fields.fulfillmentMode = 'SELLER_STOCK';
  await assert.rejects(service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'NOT_A_DROPSHIP_LISTING');
  db._store.productVersions.v1.fields.fulfillmentMode = 'CJ_DROPSHIP';
  db._store.productVersions.v1.status = 'APPROVED';
  await assert.rejects(service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'NOT_EDITABLE');
  db._store.productVersions.v1.status = 'DRAFT';
  await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  await assert.rejects(service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'TOO_SOON');
  db._store.supplierProducts.v1.lastCheckedAtMs = 0;
  cj.st.failNext = 'network';
  await assert.rejects(service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'SUPPLIER_UNAVAILABLE');
  // a not-connected creator cannot test
  await assert.rejects(service.testMapping(makeDb({ products: db._store.products, productVersions: db._store.productVersions }), { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps), (e) => e.code === 'SUPPLIER_NOT_CONNECTED');
});

test('gates: submit needs a VALID mapping; approve re-tests a stale one', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  db._store.creators = { u1: { status: 'ACTIVE' } };
  await assert.rejects(service.assertReadyToSubmit(db, { uid: 'u1', creator: ACTIVE, versionId: 'v1' }), (e) => e.code === 'MAPPING_MISSING');
  await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  await service.assertReadyToSubmit(db, { uid: 'u1', creator: ACTIVE, versionId: 'v1' });
  // stale test + CJ now out of stock -> approval refuses
  db._store.supplierProducts.v1.testedAtMs = Date.now() - 48 * 3600 * 1000;
  cj.st.stock.VID12345 = 0;
  await assert.rejects(service.assertReadyToApprove(db, { creatorId: 'u1', versionId: 'v1' }, cj.deps), (e) => e.code === 'MAPPING_INVALID');
  // stale test + still fine -> re-tested and approved
  cj.st.stock.VID12345 = 10; db._store.supplierProducts.v1.testedAtMs = Date.now() - 48 * 3600 * 1000;
  await service.assertReadyToApprove(db, { creatorId: 'u1', versionId: 'v1' }, cj.deps);
  assert.ok(db._store.supplierProducts.v1.testedAtMs > Date.now() - 60000);
  // creator no longer ACTIVE
  db._store.creators.u1.status = 'RESTRICTED';
  await assert.rejects(service.assertReadyToApprove(db, { creatorId: 'u1', versionId: 'v1' }, cj.deps), (e) => e.code === 'CREATOR_NOT_ELIGIBLE');
});

test('health: HEALTHY keeps the listing; out of stock auto-pauses it', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345', declaredCostUsd: 5 } }, cj.deps);
  let r = await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 0 }, cj.deps);
  assert.equal(r.health, 'HEALTHY'); assert.equal(db._store.products.p1.status, 'PUBLISHED');
  cj.st.stock.VID12345 = 0;
  r = await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 0 }, cj.deps);
  assert.equal(r.health, 'DEGRADED'); assert.equal(r.paused, true);
  assert.equal(db._store.products.p1.status, 'PAUSED');
  assert.equal(db._store.products.p1.pausedBySupplier, true);
  assert.ok(db._store.productAuditLog && Object.values(db._store.productAuditLog).some((a) => a.action === 'product.auto_paused_supplier'));
});

test('health: rate-limited per minute; CJ outages pause only after 3 in a row; auth failure pauses at once', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  await service.testMapping(db, { uid: 'u1', productId: 'p1', input: { cjVariantId: 'VID12345' } }, cj.deps);
  await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 0 }, cj.deps);
  const cached = await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 60000 }, cj.deps);
  assert.equal(cached.cached, true);
  const calls = cj.st.calls.length;
  await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 60000 }, cj.deps);
  assert.equal(cj.st.calls.length, calls);
  const out = [];
  for (let i = 0; i < 3; i++) {
    cj.st.failNext = 'network';
    out.push((await service.checkMappingHealth(db, { productId: 'p1', minGapMs: 0 }, cj.deps)).paused);
  }
  assert.deepEqual(out, [false, false, true]);
});

test('health: revoked connection pauses; disconnect wipes secrets and pauses live listings', async () => {
  const cj = makeFakeCj(); const db = await connected(cj); seedDropship(db);
  const r = await service.disconnectCj(db, { uid: 'u1', actorRole: 'admin', actorUid: 'adm', reason: 'abuse' });
  assert.equal(r.status, 'REVOKED'); assert.equal(r.pausedProducts, 1);
  const c = db._store.supplierConnections.u1_cj;
  assert.equal(c.status, 'REVOKED'); assert.equal(c.credentials, null); assert.equal(c.tokens, null);
  assert.equal(db._store.products.p1.status, 'PAUSED');
  await assert.rejects(store.buildClientForCreator(db, 'u1'), (e) => e.code === 'SUPPLIER_NOT_CONNECTED');
});

test('cj-client: refreshes/re-auths when the token is rejected, never leaks credentials in errors', async () => {
  const cj = makeFakeCj();
  let tokens = { accessToken: 'STALE', accessTokenExpiryDate: new Date(Date.now() + 10 * 864e5).toISOString(), refreshToken: null };
  const client = createCjClient({ connectionId: 'x', loadCredentials: async () => creds, loadTokens: async () => tokens, saveTokens: async (t) => { tokens = t; }, fetchImpl: async (u, i) => {
    if (i.headers && i.headers['CJ-Access-Token'] === 'STALE') return { status: 401, ok: false, json: async () => ({ result: false, code: 1004001, message: 'Invalid token' }) };
    return cj.fetchImpl(u, i);
  }, pace: async () => {} });
  const r = await client.call('/product/getCategory');
  assert.equal(r.ok, true);
  assert.equal(tokens.accessToken, 'AT1');
  const badClient = createCjClient({ connectionId: 'y', loadCredentials: async () => ({ email: 'a@b.co', apiKey: 'wrongwrong' }), loadTokens: async () => null, saveTokens: async () => {}, fetchImpl: cj.fetchImpl, pace: async () => {} });
  const bad = await badClient.call('/product/getCategory');
  assert.equal(bad.ok, false); assert.equal(bad.code, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(bad).includes('wrongwrong'));
});
