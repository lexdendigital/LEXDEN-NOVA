'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const files = [
  'js/state.js',
  'api/commerce-pricing.js',
  'api/cj-shipping.js',
  'api/cj-order.js',
  'api/verify-paystack.js',
  'api/product-variants.js',
  'mcp/lib/productImport.js',
  'mcp/tools/cj.js',
];

test('changed checkout, shipping and importer JavaScript files parse cleanly', () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
  }
});
