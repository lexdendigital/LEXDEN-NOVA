'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateRetailPriceUSD,
  calculateShippingCharge,
  parseShippingAging,
  selectShippingServices,
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
  const expectedWorstCase = Math.ceil(
    ((3.34 * 1.03 + 100 / 1343.09) / (1 - 0.25 - 0.08 - 0.039)) * 100
  ) / 100;
  assert.equal(price, expectedWorstCase);
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

test('shipping ratio helper supports affordability policy checks', () => {
  assert.equal(shippingRatio(8, 10), 0.8);
  assert.equal(shippingRatio(8, 0), null);
});


test('parses CJ shipping aging ranges without inventing an estimate', () => {
  assert.deepEqual(parseShippingAging('12-50'), { minDays: 12, maxDays: 50 });
  assert.deepEqual(parseShippingAging('15–45'), { minDays: 15, maxDays: 45 });
  assert.deepEqual(parseShippingAging('7 days'), { minDays: 7, maxDays: 7 });
  assert.equal(parseShippingAging('unknown'), null);
  assert.equal(parseShippingAging(null), null);
});

test('selects the fastest eligible Smart route within the configured price premium', () => {
  const services = selectShippingServices([
    { logisticName: 'CJPacket Liquid Line', logisticPrice: 7.00, logisticAging: '15-30' },
    { logisticName: 'PostNL', logisticPrice: 9.80, logisticAging: '5-20' },
    { logisticName: 'CJPacket Postal', logisticPrice: 6.00, logisticAging: '12-50' },
  ], settings, { productAmountUSD: 40 });

  assert.equal(services[0].serviceLevel, 'smart');
  assert.equal(services[0].serviceLabel, 'NOVA Smart Delivery');
  assert.equal(services[0].logisticName, 'PostNL');
  assert.equal(services[0].estimatedOrderToDoorMaxDays, 25);
  assert.equal(services[0].deliveryEstimate, '10-25 days');
});

test('offers Economy only for a material saving and requires an explicit choice', () => {
  const services = selectShippingServices([
    { logisticName: 'CJPacket Liquid Line', logisticPrice: 7.00, logisticAging: '15-30' },
    { logisticName: 'PostNL', logisticPrice: 9.80, logisticAging: '5-20' },
    { logisticName: 'CJPacket Postal', logisticPrice: 6.00, logisticAging: '12-50' },
  ], settings, { productAmountUSD: 40 });

  const economy = services.find(service => service.serviceLevel === 'economy');
  assert.ok(economy);
  assert.equal(economy.logisticName, 'CJPacket Postal');
  assert.equal(economy.serviceLabel, 'NOVA Economy');
  assert.equal(economy.requiresExplicitChoice, true);
  assert.equal(economy.estimatedOrderToDoorMaxDays, 55);
});

test('never pretends a slow-only route meets Smart; Economy requires explicit acceptance', () => {
  const services = selectShippingServices([
    { logisticName: 'CJPacket Liquid Line', logisticPrice: 5.00, logisticAging: '20-60' },
    { logisticName: 'PostNL', logisticPrice: 8.00, logisticAging: '15-45' },
  ], settings, { productAmountUSD: 40 });

  assert.equal(services.some(service => service.serviceLevel === 'smart'), false);
  assert.equal(services.length, 1);
  assert.equal(services[0].serviceLevel, 'economy');
  assert.equal(services[0].requiresExplicitChoice, true);
  assert.equal(services[0].estimatedOrderToDoorMaxDays, 65);
});

test('suppresses a financially absurd express route but permits an affordable fast option', () => {
  const services = selectShippingServices([
    { logisticName: 'PostNL', logisticPrice: 6.00, logisticAging: '10-30' },
    { logisticName: 'DHL Official', logisticPrice: 85.41, logisticAging: '3-7' },
  ], settings, { productAmountUSD: 30 });

  assert.equal(services.some(service => service.logisticName === 'DHL Official'), false);

  const affordable = selectShippingServices([
    { logisticName: 'PostNL', logisticPrice: 6.00, logisticAging: '10-30' },
    { logisticName: 'DHL Official', logisticPrice: 4.00, logisticAging: '3-7' },
  ], settings, { productAmountUSD: 30 });

  const express = affordable.find(service => service.serviceLevel === 'express');
  assert.ok(express);
  assert.equal(express.serviceLabel, 'NOVA Express');
  assert.equal(express.requiresExplicitChoice, true);
  assert.equal(express.estimatedOrderToDoorMaxDays, 12);
});

test('rejects unknown delivery estimates and routes whose freight ratio breaks affordability rules', () => {
  const services = selectShippingServices([
    { logisticName: 'Unknown Carrier', logisticPrice: 2.00, logisticAging: 'unknown' },
    { logisticName: 'CJPacket Liquid Line', logisticPrice: 6.00, logisticAging: '20-60' },
  ], settings, { productAmountUSD: 10 });

  assert.deepEqual(services, []);
});


test('checks affordability after NGN conversion and checkout fee buffers, not raw freight alone', () => {
  const services = selectShippingServices([
    { logisticName: 'PostNL', logisticPrice: 2.55, logisticAging: '10-20' },
  ], settings, {
    productAmountUSD: 7.5,
    productAmountMajor: 10073.18,
    currency: 'NGN',
    processingDays: 5,
  });

  // Raw freight is 34% of the USD item price, but the actual NGN amount
  // charged after FX and payment-fee buffers exceeds the 35% hard cap.
  assert.deepEqual(services, []);
});

test('legacy admin values cannot weaken NOVA delivery and affordability guardrails', () => {
  const policy = getCommercePricingPolicy({
    commercePricingPolicy: {
      shipping: {
        maxDeliveryDays: 90,
        processingDays: 0,
        highShippingItemPriceRatioWarning: 0.6,
        highShippingItemPriceRatioBlock: 1.5,
        enforceShippingRatioBlock: false,
        smartMaxShippingPremiumPct: 1.5,
        economyMinSavingUSD: 0,
        economyMinSavingPct: 0,
      },
    },
  }).shipping;

  assert.equal(policy.maxDeliveryDays, 45);
  assert.equal(policy.processingDays, DEFAULT_POLICY.shipping.processingDays);
  assert.equal(policy.highShippingItemPriceRatioWarning, 0.25);
  assert.equal(policy.highShippingItemPriceRatioBlock, 0.35);
  assert.equal(policy.enforceShippingRatioBlock, true);
  assert.equal(policy.smartMaxShippingPremiumPct, 0.4);
  assert.equal(policy.economyMinSavingUSD, 2.5);
  assert.equal(policy.economyMinSavingPct, 0.2);
});
