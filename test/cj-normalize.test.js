'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSearchPayload } = require('../api/cj-normalize');

test('normalizes the official CJ listV2 content[].productList[] response', () => {
  const result = normalizeSearchPayload({
    pageNumber: 1,
    totalRecords: 1,
    content: [{ keyWord: 'headphones', productList: [{
      id: 'pid-1', nameEn: 'Wireless headphones', sku: 'SPU-1',
      bigImage: 'https://images.example/headphones.jpg', sellPrice: '12.50',
      nowPrice: '10.00', categoryId: 'cat-1', threeCategoryName: 'Audio',
      description: 'Bluetooth headphones', warehouseInventoryNum: 71,
    }] }],
  });
  assert.equal(result.rawCount, 1);
  assert.deepEqual(result.products[0], {
    pid: 'pid-1', name: 'Wireless headphones', image: 'https://images.example/headphones.jpg',
    sku: 'SPU-1', sellPrice: 12.5, variantCount: null, categoryId: 'cat-1',
    categoryName: 'Audio', description: 'Bluetooth headphones', video: null,
    stock: 71, weight: null, listedNum: null, supplierName: 'CJ Dropshipping',
  });
});

test('accepts legacy list responses and keeps non-numeric prices null', () => {
  const result = normalizeSearchPayload({ list: [{
    pid: 'legacy-1', productNameEn: 'Legacy item', productImage: 'https://images.example/item.jpg', sellPrice: 'not-a-price',
  }] });
  assert.equal(result.rawCount, 1);
  assert.equal(result.products[0].pid, 'legacy-1');
  assert.equal(result.products[0].name, 'Legacy item');
  assert.equal(result.products[0].sellPrice, null);
});

test('flattens product groups without mistaking the group for a product', () => {
  const result = normalizeSearchPayload({ content: [
    { productList: [{ id: 'a', nameEn: 'A' }, { id: 'b', nameEn: 'B' }] },
    { productList: [] },
  ] });
  assert.equal(result.rawCount, 2);
  assert.deepEqual(result.products.map(p => p.pid), ['a', 'b']);
  assert.deepEqual(result.products.map(p => p.name), ['A', 'B']);
});
