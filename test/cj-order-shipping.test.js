'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cjOrderHandler = require('../api/cj-order');

test('CJ order payload receives the exact route chosen at checkout', () => {
  const payload = cjOrderHandler.buildCjOrderPayload('LN-123', {
    delivery: {
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Agbara',
      address: 'Example Street',
      name: 'Customer',
      phone: '08000000000',
      shippingMethod: 'CJPacket Postal',
      shippingQuoteId: '12345678-1234-1234-1234-123456789abc',
    },
    email: 'buyer@example.com',
  }, { id: 'nova-product' }, { variantId: 'cj-variant-1' }, 1);
  assert.equal(payload.logisticName, 'CJPacket Postal');
  assert.equal(payload.shippingCountryCode, 'NG');
  assert.equal(payload.shippingCountry, 'Nigeria');
  assert.equal(payload.email, 'buyer@example.com');
  assert.equal(payload.payType, 3);
  assert.equal(payload.products[0].vid, 'cj-variant-1');
});


test('funding holds remain resumable without recreating the CJ order', () => {
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('funding_required'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('supplier_created'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('stock_issue'), false);
});
