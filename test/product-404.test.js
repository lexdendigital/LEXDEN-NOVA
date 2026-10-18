'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../api/_shared');
const aff = require('../api/affiliate/shared');
aff.getDb = () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) });

function run(handlerPath, req, catalog) {
  const orig = shared.getCatalogDoc;
  shared.getCatalogDoc = async () => catalog;
  delete require.cache[require.resolve(handlerPath)];
  const handler = require(handlerPath);
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { shared.getCatalogDoc = orig; resolve({ code: this.code, body: b }); } };
    handler(req, res);
  });
}
const req = (id) => ({ query: { id }, headers: { host: 'x.test' } });

test('demo / deleted product ids return a real 404 with noindex', async () => {
  const r = await run('../api/product', req('p1'), { list: [{ id: 'real-1', name: 'Real' }] });
  assert.equal(r.code, 404); assert.match(r.body, /noindex/);
});
test('real product still 200', async () => {
  assert.equal((await run('../api/product', req('real-1'), { list: [{ id: 'real-1', name: 'Real' }] })).code, 200);
});
test('temporary catalog error never turns a real product into a 404', async () => {
  assert.equal((await run('../api/product', req('real-1'), null)).code, 200);
});
test('missing feed post is 404, present is 200', async () => {
  const s = { feed: [{ id: 'n1', title: 'News' }] };
  assert.equal((await run('../api/feed', req('fp1'), s)).code, 404);
  assert.equal((await run('../api/feed', req('n1'), s)).code, 200);
});
