'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProductPage, isIndexableCatalogProduct, isPublicCatalogProduct,
  isSuspiciousDiscount, effectiveCatalogPrice,
} = require('../api/product-page');

const makeProduct = (overrides = {}) => ({
  id: 'course-101',
  name: 'LEXDEN Professional Design Course',
  status: 'published',
  productType: 'DIGITAL',
  category: 'courses',
  price: 8.69,
  salePrice: 6.61,
  image: 'https://cdn.example.test/course.jpg',
  description: 'A practical course with lessons, guided exercises, templates, and a portfolio project.',
  seller: 'LEXDEN ACADEMY',
  accessDelivery: 'After payment, the buyer receives the course access information.',
  ...overrides,
});
const settings = { content: { displayCurrency: 'USD', exchangeRates: { USD: 1 }, ratesUpdatedAt: '2026-10-26T00:00:00Z' } };

test('server-rendered product page contains visible product content and matching Offer schema', () => {
  const html = buildProductPage({ id: 'course-101', product: makeProduct(), settings, baseUrl: 'https://lexden-nova.onrender.com' });
  assert.match(html, /LEXDEN Professional Design Course/);
  assert.match(html, /\$6\.61/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /"priceCurrency":"USD"/);
  assert.match(html, /"price":"6\.61"/);
  assert.match(html, /https:\/\/lexden-nova\.onrender\.com\/product\/course-101/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test('extreme discounts and product-type conflicts suppress indexable product data', () => {
  const suspicious = makeProduct({ price: 8.69, salePrice: 0.037 });
  assert.equal(isSuspiciousDiscount(suspicious), true);
  assert.equal(effectiveCatalogPrice(suspicious), null);
  assert.equal(isIndexableCatalogProduct(suspicious), false);
  const html = buildProductPage({ id: suspicious.id, product: suspicious, settings });
  assert.match(html, /noindex,follow/);
  assert.doesNotMatch(html, /"@type":"Product"/);
  assert.equal(isIndexableCatalogProduct(makeProduct({ productType: 'PHYSICAL' })), false);
});

test('draft, inactive, statusless, missing-image, and missing-content products are not indexable', () => {
  assert.equal(isPublicCatalogProduct(makeProduct({ status: 'draft' })), false);
  assert.equal(isPublicCatalogProduct(makeProduct({ active: false })), false);
  assert.equal(isPublicCatalogProduct(makeProduct({ status: undefined })), false);
  assert.equal(isIndexableCatalogProduct(makeProduct({ image: '' })), false);
  assert.equal(isIndexableCatalogProduct(makeProduct({ description: 'Too short' })), false);
});

test('untrusted product title markup is stripped before rendering', () => {
  const html = buildProductPage({
    id: 'unsafe',
    product: makeProduct({ name: '<img src=x onerror=alert(1)> Trusted Course' }),
    settings,
    baseUrl: 'https://lexden-nova.onrender.com',
  });
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /Trusted Course/);
});
