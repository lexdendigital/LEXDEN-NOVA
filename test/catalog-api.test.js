'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterProducts } = require('../api/catalog');

const products = [
  { id: 'p1', name: 'Mobile App Course', description: 'Learn apps', category: 'Courses', seller: 'Selar', type: 'course' },
  { id: 'p2', name: 'Power Bank', description: 'Slim aluminium', category: 'Gadgets', seller: 'CJ Dropshipping', type: 'physical' },
  { id: 'p3', name: 'Cartoon Course', description: 'Animation', category: 'Courses', seller: 'Selar', type: 'digital' },
];

test('catalog API filters by type and text, and caps the limit', () => {
  assert.deepEqual(filterProducts(products, { type: 'physical' }).map((p) => p.id), ['p2']);
  assert.deepEqual(filterProducts(products, { q: 'course selar' }).map((p) => p.id), ['p1', 'p3']);
  assert.deepEqual(filterProducts(products, { q: 'power' }).map((p) => p.id), ['p2']);
  assert.equal(filterProducts(products, { limit: '1' }).length, 1);
  assert.equal(filterProducts(products, { limit: '9999' }).length, 3);
});

test('catalog API is read-only and public', async () => {
  const handler = require('../api/catalog');
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: 'POST', query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
});
