'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateRetailPriceUSD,
  calculateShippingCharge,
  sortShippingOptions,
  shippingRatio,
} = require('../api/commerce-pricing');

const settings = {
  exchangeRates: { USD: 1, NGN: 1343.09 },
  cjPreferredShippingMethod: 'CJPacket Postal',
  cjFallbackShippingMethods: ['CJPacket Liquid Line', 'PostNL'],
  cjExpressShippingMethods: ['DHL Official'],
  commercePricingPolicy: {
    targetNetMarginPct: 25,
    websiteMaintenanceReservePct: 8,
    paystackPercentFeePct: 1.5,
    paystackFixedFeeNGN: 100,
    fxSafetyBufferPct: 3,
    shipping: {
      preferredMethod: 'CJPacket Postal',
      fallbackMethods: ['CJPacket Liquid Line', 'PostNL'],
      expressMethods: ['DHL Official'],
      highShippingItemPriceRatioWarning: 0.6,
    },
  },
};

test('cost-plus retail pricing includes reserve, gateway fee, FX cushion and a target margin', () => {
  const price = calculateRetailPriceUSD(3.34, settings);
  assert.ok(price > 3.34);
  assert.equal(price, Math.ceil(price * 100) / 100);
  assert.equal(calculateRetailPriceUSD(null, settings), null);
  assert.equal(calculateRetailPriceUSD(3.34, { exchangeRates: {} }), null);
});

test('shipping fee is a separate pass-through amount converted into the selected payment currency', () => {
  const ngn = calculateShippingCharge(5.02, 'NGN', settings);
  const usd = calculateShippingCharge(5.02, 'USD', settings);
  assert.ok(ngn > 5000);
  assert.equal(ngn, Math.ceil(ngn));
  assert.equal(usd, 5.22);
  assert.equal(calculateShippingCharge(null, 'NGN', settings), null);
});

test('shipping methods prioritize the configured route and keep express options last', () => {
  const result = sortShippingOptions([
    { logisticName: 'DHL Official', logisticPrice: 85 },
    { logisticName: 'CJPacket Liquid Line', logisticPrice: 5 },
    { logisticName: 'CJPacket Postal', logisticPrice: 8 },
    { logisticName: 'PostNL', logisticPrice: 7 },
  ], settings);
  assert.deepEqual(result.map(x => x.logisticName), [
    'CJPacket Postal', 'CJPacket Liquid Line', 'PostNL', 'DHL Official',
  ]);
  assert.equal(result[0].isPreferred, true);
  assert.equal(result[3].isExpress, true);
});

test('shipping ratio marks freight-heavy items without forcing a policy block', () => {
  assert.equal(shippingRatio(8, 10), 0.8);
  assert.equal(shippingRatio(8, 0), null);
});
