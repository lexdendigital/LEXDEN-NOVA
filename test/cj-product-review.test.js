'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCjPhysicalProduct,
  hasCjPricingInputsChanged,
  assertCjPhysicalPublicationAllowed,
  assertCjPhysicalProductCreatedAsDraft,
} = require('../api/cj-product-review');

function cjProduct(overrides = {}) {
  return {
    id: 'cj-test-1',
    productType: 'PHYSICAL',
    status: 'draft',
    price: 20,
    salePrice: null,
    pricingReviewRequired: true,
    physical: {
      supplierId: 'cj',
      supplierSku: 'sku-1',
      supplierCost: 8,
      supplierCurrency: 'USD',
      shippingCountries: ['Nigeria'],
      deliveryEstimate: 'Pending route verification',
      cj: { productId: 'pid-1', variantId: 'vid-1', sku: 'sku-1', sourceCountry: 'CN' },
    },
    variants: [{ id: 'black', price: 20, salePrice: null, cjVariantId: 'vid-1', sku: 'sku-1', active: true, available: true }],
    ...overrides,
  };
}

test('only CJ-linked physical catalogue products require this review gate', () => {
  assert.equal(isCjPhysicalProduct(cjProduct()), true);
  assert.equal(isCjPhysicalProduct(cjProduct({ productType: 'DIGITAL' })), false);
  assert.equal(isCjPhysicalProduct(cjProduct({ physical: { supplierId: 'local' } })), false);
});

test('a CJ physical item cannot be published while pricing review is required', () => {
  const item = cjProduct({ status: 'published' });
  assert.throws(() => assertCjPhysicalPublicationAllowed(item), error => error.code === 'CJ_PRICING_REVIEW_REQUIRED');
});

test('publication requires both review evidence and a completion timestamp', () => {
  const shortEvidence = cjProduct({
    status: 'published',
    pricingReviewRequired: false,
    pricingReviewNotes: 'Looks affordable.',
    pricingReviewCompletedAt: '2026-10-29T10:00:00.000Z',
  });
  assert.throws(() => assertCjPhysicalPublicationAllowed(shortEvidence), error => error.code === 'CJ_PRICING_REVIEW_REQUIRED');

  const missingTimestamp = cjProduct({
    status: 'published',
    pricingReviewRequired: false,
    pricingReviewNotes: 'Reviewed current supplier price, live stock, delivery quotes, local competitors and expected contribution.',
  });
  assert.throws(() => assertCjPhysicalPublicationAllowed(missingTimestamp), error => error.code === 'CJ_PRICING_REVIEW_REQUIRED');
});

test('a completed CJ physical review allows publication', () => {
  const item = cjProduct({
    status: 'published',
    pricingReviewRequired: false,
    pricingReviewNotes: 'Compared current Nigerian competitor prices and full delivered total; verified stock, live freight, delivery estimate, supplier funding and contribution margin.',
    pricingReviewCompletedAt: '2026-10-29T10:00:00.000Z',
  });
  assert.equal(assertCjPhysicalPublicationAllowed(item), true);
});

test('new CJ physical products must start in Draft even if a request claims they are reviewed', () => {
  const item = cjProduct({
    status: 'published',
    pricingReviewRequired: false,
    pricingReviewNotes: 'Compared current Nigerian competitor prices and full delivered total; verified stock, live freight, delivery estimate, supplier funding and contribution margin.',
    pricingReviewCompletedAt: '2026-10-29T10:00:00.000Z',
  });
  assert.throws(() => assertCjPhysicalProductCreatedAsDraft(item), error => error.code === 'CJ_PRODUCT_MUST_START_AS_DRAFT');
  assert.equal(assertCjPhysicalProductCreatedAsDraft({ ...item, status: 'draft' }), true);
});

test('editing product description alone does not invalidate pricing review', () => {
  const current = cjProduct();
  const next = { ...current, description: 'Better copy, same economics.' };
  assert.equal(hasCjPricingInputsChanged(current, next), false);
});

test('changing price, supplier cost, shipping destination or mapped variant invalidates pricing review', () => {
  const current = cjProduct();
  assert.equal(hasCjPricingInputsChanged(current, { ...current, price: 21 }), true);
  assert.equal(hasCjPricingInputsChanged(current, { ...current, physical: { ...current.physical, supplierCost: 8.25 } }), true);
  assert.equal(hasCjPricingInputsChanged(current, { ...current, physical: { ...current.physical, shippingCountries: ['Nigeria', 'Ghana'] } }), true);
  assert.equal(hasCjPricingInputsChanged(current, { ...current, variants: [{ ...current.variants[0], cjVariantId: 'vid-2' }] }), true);
});
