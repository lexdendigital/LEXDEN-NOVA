const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fake-firestore');
const { callHandler } = require('../mcp/lib/callHandler');

let DB;
require('../api/affiliate/shared').getDb = () => DB; // patch the root BEFORE creator/shared captures it
const shared = require('../api/creator/shared');
shared.getDb = () => DB;
shared.requireActiveCreator = async () => ({ decoded: { uid: 'u1' }, creator: { status: 'ACTIVE' } });
const handler = require('../api/creator-products');
const resume = (productId) => callHandler(handler, { method: 'POST', body: { action: 'resume', productId } });

test('a creator cannot resume a listing the platform paused for missed deadlines', async () => {
  DB = makeDb({ products: { p1: { creatorId: 'u1', status: 'PAUSED', pausedBySla: true, publishedSnapshot: { offeringType: 'PHYSICAL_PRODUCT' } } } });
  const r = await resume('p1');
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'PAUSED_BY_PLATFORM');
  assert.equal(DB._store.products.p1.status, 'PAUSED');
});

test('a creator cannot resume a link-paused listing while the link still fails', async () => {
  DB = makeDb({ products: { p1: { creatorId: 'u1', status: 'PAUSED', pausedByLink: true, publishedSnapshot: { externalUrl: 'http://127.0.0.1/file' } } } });
  const r = await resume('p1');
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'LINK_NOT_READY');
  assert.equal(DB._store.products.p1.status, 'PAUSED');
});

test('another creator\'s product is not found; a normal self-pause resumes fine', async () => {
  DB = makeDb({ products: { p2: { creatorId: 'zzz', status: 'PAUSED' }, p3: { creatorId: 'u1', status: 'PAUSED', publishedSnapshot: { offeringType: 'DIGITAL_PRODUCT' } } } });
  assert.equal((await resume('p2')).status, 404);
  const r = await resume('p3');
  assert.equal(r.status, 200);
  assert.equal(DB._store.products.p3.status, 'PUBLISHED');
});
