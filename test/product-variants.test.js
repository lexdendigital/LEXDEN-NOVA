'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findPurchasableVariant, effectivePrice, isSuspiciousSale, resolveProductSelection, selectionAvailability } = require('../api/product-variants');

const product = {
  status: 'published', id: 'tablet', name: 'Nova Tablet', price: 100,
  options: [{ id: 'color', name: 'Color', values: [{ id: 'black', label: 'Black' }, { id: 'blue', label: 'Blue' }] }],
  variants: [
    { id: 'black', optionValues: { color: 'black' }, price: 100, salePrice: 80, stock: 2, active: true },
    { id: 'blue', optionValues: { color: 'blue' }, price: 120, stock: 0, active: true },
  ],
};

test('variant price and accessible option label come from the selected catalog combination', () => {
  const selected = findPurchasableVariant(product, 'black');
  assert.equal(selected.label, 'Black');
  assert.equal(effectivePrice(product, selected.variant), 80);
});

test('payment selection rejects missing, unknown, inactive, and out-of-stock variants', () => {
  assert.equal(findPurchasableVariant(product, null), null);
  assert.equal(findPurchasableVariant(product, 'missing'), null);
  assert.equal(findPurchasableVariant(product, 'blue'), null);
  assert.equal(findPurchasableVariant({ variants: [{ id: 'x', active: false, price: 1 }] }, 'x'), null);
});

test('backend converts the selected sale price using server-owned currency settings', () => {
  assert.deepEqual(resolveProductSelection(product, 'black', 'NGN', { exchangeRates: { NGN: 1500 } }), {
    variant: product.variants[0], variantId: 'black', variantName: 'Black', price: 120000, basePrice: 80, currency: 'NGN',
  });
  assert.equal(resolveProductSelection(product, null, 'NGN', { exchangeRates: { NGN: 1500 } }), null);
});

test('legacy single-price products remain payable and physical out-of-stock items are blocked', () => {
  assert.equal(resolveProductSelection({ status: 'published', price: 20 }, null, 'USD', {}).price, 20);
  const out = { status: 'published', productType: 'PHYSICAL', price: 30, physical: { stockStatus: 'out_of_stock' } };
  assert.equal(selectionAvailability(out, null), false);
  assert.equal(resolveProductSelection(out, null, 'USD', {}), null);
});

test('USD values preserve cents and suspicious sale prices fail closed', () => {
  const p = { status: 'published', price: 8.695, salePrice: 6.613 };
  assert.equal(resolveProductSelection(p, null, 'USD', {}).price, 6.61);
  assert.equal(effectivePrice({ price: 8.69, salePrice: 0.037 }, null), null);
  assert.equal(isSuspiciousSale(8.69, 0.037), true);
  assert.equal(resolveProductSelection({ status: 'published', price: 8.69, salePrice: 0.037 }, null, 'NGN', { exchangeRates: { NGN: 1330 } }), null);
});
