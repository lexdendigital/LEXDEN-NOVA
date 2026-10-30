'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cjOrderHandler = require('../api/cj-order');
const cjShippingHandler = require('../api/cj-shipping');

test('CJ order payload receives the exact route chosen at checkout', () => {
  const payload = cjOrderHandler.buildCjOrderPayload('LN-123', {
    delivery: {
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Agbara',
      address: 'Example Street',
      name: 'Customer',
      phone: '08000000000',
      postalCode: '102001',
      shippingMethod: 'CJPacket Postal',
      shippingOriginCountry: 'NG',
      shippingQuoteId: '12345678-1234-1234-1234-123456789abc',
    },
    email: 'buyer@example.com',
  }, { id: 'nova-product' }, { variantId: 'cj-variant-1' }, 1);
  assert.equal(payload.logisticName, 'CJPacket Postal');
  assert.equal(payload.shippingCountryCode, 'NG');
  assert.equal(payload.shippingCountry, 'Nigeria');
  assert.equal(payload.fromCountryCode, 'NG');
  assert.equal(payload.email, 'buyer@example.com');
  assert.equal(payload.shippingZip, '102001');
  assert.equal(payload.payType, 3);
  assert.equal(payload.products[0].vid, 'cj-variant-1');
});


test('supplier orders can resume from funding or recoverable delivery/CJ failures', () => {
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('funding_required'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('supplier_created'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('cj_order_failed'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('delivery_details_issue'), true);
  assert.equal(cjOrderHandler.canResumeSupplierOrderStatus('stock_issue'), false);
});


test('warehouse discovery preserves available Nigeria stock and ignores empty or region-only origins', () => {
  const rows = cjShippingHandler.stockRowsFromResponse({
    list: [
      { area: 'NG', storageNum: 4 },
      { area: 'CN', storageNum: 20 },
      { area: 'US', storageNum: 0 },
      { area: 'EU', storageNum: 9 },
    ],
  });
  const availableOrigins = rows
    .filter(row => {
      const quantity = cjShippingHandler.stockQuantity(row);
      return quantity != null && quantity > 0 && cjShippingHandler.stockOriginCountry(row);
    })
    .map(cjShippingHandler.stockOriginCountry);
  assert.deepEqual(availableOrigins, ['NG', 'CN']);
});

test('CJ order payload uses the verified quote origin instead of assuming China', () => {
  const payload = cjOrderHandler.buildCjOrderPayload('LN-456', {
    delivery: {
      country: 'Nigeria',
      state: 'Lagos',
      city: 'Lagos',
      address: 'Local stock dispatch',
      name: 'Customer',
      phone: '08000000000',
      shippingMethod: 'Local Carrier',
      shippingOriginCountry: 'NG',
    },
  }, { id: 'nova-local' }, { variantId: 'cj-variant-local' }, 1);
  assert.equal(payload.fromCountryCode, 'NG');
  assert.equal(payload.logisticName, 'Local Carrier');
});

test('warehouse parser unwraps nested CJ warehouse arrays', () => {
  const rows = cjShippingHandler.stockRowsFromResponse({
    data: { byWarehouse: [{ area: 'NG', qty: 3 }, { area: 'CN', qty: 20 }] },
  });
  assert.deepEqual(rows.map(row => row.area), ['NG', 'CN']);
});


test('CJ payload preserves courier postal code verbatim after trimming', () => {
  const payload = cjOrderHandler.buildCjOrderPayload('LN-ZIP', {
    delivery: {
      country: 'Nigeria', state: 'Lagos', city: 'Lagos', address: 'Example',
      name: 'Customer', phone: '08000000000', postalCode: ' 102001 ',
      shippingMethod: 'CJPacket Postal', shippingOriginCountry: 'CN',
    },
  }, { id: 'nova-product' }, { variantId: 'cj-variant-1' }, 1);
  assert.equal(payload.shippingZip, '102001');
});
