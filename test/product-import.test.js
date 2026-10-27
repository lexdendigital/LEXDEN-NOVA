'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  uniqueUrls, buildProductSpecs, stockStatusFrom, deriveSuggestedPricing,
} = require('../mcp/lib/productImport');

test('keeps unique usable supplier image URLs and drops unsafe or blank values', () => {
  assert.deepEqual(uniqueUrls([
    'https://supplier.example/item.jpg', 'https://supplier.example/item.jpg',
    'javascript:alert(1)', '', null, ['https://supplier.example/variant.jpg'],
  ]), ['https://supplier.example/item.jpg', 'https://supplier.example/variant.jpg']);
});

test('preserves supplier technical and customs fields as admin product specs', () => {
  assert.deepEqual(buildProductSpecs({
    categoryName: 'Home > Storage', productOptions: 'Color-Size', materials: ['Metal', 'ABS'],
    packageWeight: 1500, customsCode: '950300', logisticsAttributes: ['Common'],
    specifications: { Voltage: '5V' },
  }), {
    'Supplier category': 'Home > Storage', 'Product options': 'Color-Size', Material: 'Metal, ABS',
    'Package weight (g)': '1500', 'Shipping attributes': 'Common', 'Customs code': '950300', Voltage: '5V',
  });
});

test('does not guess stock state when CJ stock lookup fails or returns no usable state', () => {
  assert.equal(stockStatusFrom({ v1: { inStock: true } }, 1, false), '');
  assert.equal(stockStatusFrom({}, 1, true), '');
  assert.equal(stockStatusFrom({ v1: { total: 0 } }, 1, true), '');
  assert.equal(stockStatusFrom({ v1: { inStock: true } }, 1, true), 'in_stock');
  assert.equal(stockStatusFrom({ v1: { inStock: false } }, 1, true), 'out_of_stock');
});

test('uses CJ suggested price as regular and applies a 40% sale discount', () => {
  assert.deepEqual(deriveSuggestedPricing(85, [{ suggestedSellPrice: 90 }]), {
    price: 85, salePrice: 51, discount: 40,
  });
});

test('uses the lowest known variant suggested price when product-level suggestion is missing', () => {
  assert.deepEqual(deriveSuggestedPricing(null, [
    { suggestedSellPrice: 40 }, { suggestedSellPrice: 35 }, { suggestedSellPrice: null },
  ]), {
    price: 35, salePrice: 21, discount: 40,
  });
});

test('leaves storefront pricing blank when CJ supplies no suggested price', () => {
  assert.deepEqual(deriveSuggestedPricing(null, [
    { sellPrice: 10 }, { suggestedSellPrice: null },
  ]), {
    price: null, salePrice: null, discount: null,
  });
});
