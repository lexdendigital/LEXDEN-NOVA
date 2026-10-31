'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, buildLlmsTxt } = require('../scripts/generate-catalog');

test('catalog lists only eligible products with page URLs, sale price and availability', () => {
  const c = buildCatalog([
    { id: 'p3', name: 'Course', description: 'Learn <b>it</b>.', price: 6.16, salePrice: 2.9, status: 'published' },
    { id: 'x', name: 'Demo', status: 'published', demo: true },
    { id: 'cj-1', shareId: 'p15', name: 'Bag', price: 20, productType: 'PHYSICAL', status: 'published' },
  ]);
  assert.deepEqual(c.products.map((p) => p.id), ['p3', 'p15']);
  const course = c.products.find((p) => p.id === 'p3');
  assert.equal(course.price, 2.9);
  assert.equal(course.url, 'https://lexdendigital.github.io/LEXDEN-NOVA/product/p3/');
  assert.equal(course.availability, 'InStock');
  assert.ok(!/</.test(course.description));
  const txt = buildLlmsTxt(c);
  assert.match(txt, /^# LEXDEN NOVA/);
  assert.match(txt, /\[Course\]\(https:\/\/lexdendigital\.github\.io\/LEXDEN-NOVA\/product\/p3\/\) \(USD 2\.90\)/);
});
