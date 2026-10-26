'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentFeed, FIELDS, toCsv, toJsonl } = require('../api/agent-feed');

const now = Date.parse('2026-10-26T12:00:00Z');
const settingsUSD = { content: { displayCurrency: 'USD', exchangeRates: { USD: 1 }, ratesUpdatedAt: '2026-10-26T00:00:00Z' } };
const makeProduct = (overrides = {}) => ({
  id: 'course-101',
  name: 'LEXDEN Professional Design Course',
  status: 'published',
  active: true,
  productType: 'DIGITAL',
  category: 'courses',
  price: 8.69,
  salePrice: 6.61,
  image: 'https://cdn.example.test/course.jpg',
  description: 'A practical course with guided lessons, exercises, templates, and a portfolio project.',
  seller: 'LEXDEN ACADEMY',
  accessDelivery: 'After payment, the buyer receives personal course access information.',
  ...overrides,
});

test('agent feed emits the expected fields and preserves USD cents', () => {
  const report = buildAgentFeed({ products: [makeProduct()], settings: settingsUSD, now });
  assert.equal(report.rows.length, 1);
  assert.deepEqual(Object.keys(report.rows[0]), FIELDS);
  assert.equal(report.rows[0].price, '8.69 USD');
  assert.equal(report.rows[0].sale_price, '6.61 USD');
  assert.equal(report.rows[0].is_eligible_search, true);
  assert.equal(report.rows[0].is_eligible_checkout, false);
  assert.match(report.rows[0].url, /\/product\/course-101$/);
  assert.equal(report.rows[0].availability, 'in_stock');
});

test('agent feed excludes suspicious discounts, missing images, unpublished products, and external checkout', () => {
  const report = buildAgentFeed({
    products: [
      makeProduct({ id: 'bad-price', salePrice: 0.037 }),
      makeProduct({ id: 'no-image', image: '' }),
      makeProduct({ id: 'draft', status: 'draft' }),
      makeProduct({ id: 'external', externalPaymentLink: 'https://seller.example/checkout' }),
    ],
    settings: settingsUSD,
    now,
  });
  assert.equal(report.rows.length, 0);
  assert.equal(report.excluded.price_requires_review, 1);
  assert.equal(report.excluded.missing_secure_image, 1);
  assert.equal(report.excluded.not_explicitly_published, 1);
  assert.equal(report.excluded.external_checkout_price_unverified, 1);
});

test('physical products require explicit stock and delivery; digital products require delivery information', () => {
  const physical = makeProduct({
    id: 'physical',
    productType: 'PHYSICAL',
    category: 'gadgets',
    physical: { stockStatus: 'in_stock', deliveryEstimate: '3–7 business days' },
  });
  const withoutDelivery = makeProduct({
    id: 'physical-no-delivery',
    productType: 'PHYSICAL',
    category: 'gadgets',
    physical: { stockStatus: 'in_stock', deliveryEstimate: '' },
  });
  const digitalNoDelivery = makeProduct({ id: 'digital-no-delivery', accessDelivery: '' });
  const report = buildAgentFeed({ products: [physical, withoutDelivery, digitalNoDelivery], settings: settingsUSD, now });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].availability, 'in_stock');
  assert.equal(report.excluded.physical_fulfilment_incomplete, 1);
  assert.equal(report.excluded.digital_delivery_incomplete, 1);
});

test('stale exchange rates block a non-USD feed instead of exporting false prices', () => {
  const staleSettings = { content: { displayCurrency: 'NGN', exchangeRates: { NGN: 1330 }, ratesUpdatedAt: '2026-09-01T00:00:00Z' } };
  const report = buildAgentFeed({ products: [makeProduct()], settings: staleSettings, now });
  assert.equal(report.rows.length, 0);
  assert.equal(report.excluded.exchange_rate_stale, 1);
  assert.equal(report.rateCurrent, false);
});

test('JSONL and CSV encoders safely quote text values', () => {
  const rows = [{
    item_id: 'x', title: 'Course, "Pro"', description: 'Line one\nLine two',
    url: 'https://example.test/p/x', brand: 'LEXDEN', seller_name: 'LEXDEN ACADEMY',
    image_url: 'https://cdn.example.test/x.jpg', price: '6.61 USD', availability: 'in_stock',
  }];
  const jsonl = toJsonl(rows);
  assert.equal(JSON.parse(jsonl.trim()).title, 'Course, "Pro"');
  const csv = toCsv(rows);
  assert.match(csv, /"Course, ""Pro"""/);
  assert.match(csv, /"Line one\nLine two"/);
});
