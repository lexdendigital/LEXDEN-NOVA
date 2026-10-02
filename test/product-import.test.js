'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { uniqueUrls, buildProductSpecs, stockStatusFrom } = require('../mcp/lib/productImport');

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

test('does not mark supplier stock as available without a successful stock lookup', () => {
  assert.equal(stockStatusFrom({ v1: { inStock: true } }, 1, false), 'out_of_stock');
  assert.equal(stockStatusFrom({ v1: { inStock: true } }, 1, true), 'in_stock');
  assert.equal(stockStatusFrom({ v1: { inStock: false } }, 1, true), 'out_of_stock');
});
