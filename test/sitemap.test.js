'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSitemapXml } = require('../api/sitemap');

const product = (id, overrides = {}) => ({
  id, name: 'LEXDEN Professional Design Course', status: 'published', active: true,
  productType: 'DIGITAL', category: 'courses', price: 12, salePrice: 9,
  image: 'https://cdn.example.test/course.jpg',
  description: 'A real course with complete details, guided lessons, templates, and a practical project.',
  ...overrides,
});

test('sitemap lists only published, complete, indexable product pages', () => {
  const xml = buildSitemapXml({
    products: [
      product('real-1'),
      product('a&b'),
      product('draft-1', { status: 'draft' }),
      product('inactive-1', { active: false }),
      product('no-image', { image: '' }),
      product('bad-discount', { salePrice: 0.01 }),
      product('wrong-type', { productType: 'PHYSICAL' }),
    ],
    now: new Date('2026-10-17T10:00:00Z'),
  });
  assert.match(xml, /\/product\/real-1</);
  assert.match(xml, /\/product\/a%26b</);
  assert.doesNotMatch(xml, /draft-1/);
  assert.doesNotMatch(xml, /inactive-1/);
  assert.doesNotMatch(xml, /no-image/);
  assert.doesNotMatch(xml, /bad-discount/);
  assert.doesNotMatch(xml, /wrong-type/);
  assert.match(xml, /<lastmod>2026-10-17<\/lastmod>/);
  assert.doesNotMatch(xml, /index\.html/);
});

test('sitemap escapes XML and excludes any item that fails required catalog checks', () => {
  const xml = buildSitemapXml({
    products: [product('id<&', { name: 'Name <not index text>' })],
    now: new Date('2026-10-17T10:00:00Z'),
  });
  assert.match(xml, /\/product\/id%3C%26/);
  assert.match(xml, /<urlset/);
  assert.match(xml, /<\/urlset>/);
});
