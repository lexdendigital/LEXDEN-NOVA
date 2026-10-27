'use strict';

// Shared physical-commerce pricing policy for CJ imports and checkout.
// The customer sees item price and shipping separately; both are charged together.
const DEFAULT_POLICY = Object.freeze({
  targetNetMarginPct: 25,
  websiteMaintenanceReservePct: 8,
  paystackPercentFeePct: 1.5,
  paystackUsdPercentFeePct: 3.9,
  paystackFixedFeeNGN: 100,
  fxSafetyBufferPct: 3,
  shipping: {
    preferredMethod: 'CJPacket Postal',
    fallbackMethods: ['CJPacket Liquid Line', 'PostNL'],
    expressMethods: ['DHL Official'],
    quoteTtlMinutes: 30,
    chargeCustomerSeparately: true,
    highShippingItemPriceRatioWarning: 0.6,
    highShippingItemPriceRatioBlock: 1.5,
    enforceShippingRatioBlock: false,
  },
});

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function boundedPct(value, fallback, max = 80) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

function getCommercePricingPolicy(settings = {}) {
  const root = settings && settings.content ? settings.content : (settings || {});
  const saved = root.commercePricingPolicy || {};
  const rawShipping = saved.shipping || {};
  const defaults = DEFAULT_POLICY;
  return {
    version: 1,
    pricingModel: saved.pricingModel || defaults.pricingModel || 'supplier-cost-plus',
    targetNetMarginPct: boundedPct(saved.targetNetMarginPct, defaults.targetNetMarginPct),
    websiteMaintenanceReservePct: boundedPct(saved.websiteMaintenanceReservePct, defaults.websiteMaintenanceReservePct, 40),
    paystackPercentFeePct: boundedPct(saved.paystackPercentFeePct, defaults.paystackPercentFeePct, 20),
    paystackUsdPercentFeePct: boundedPct(saved.paystackUsdPercentFeePct, defaults.paystackUsdPercentFeePct, 20),
    paystackFixedFeeNGN: finiteNonNegative(saved.paystackFixedFeeNGN) ?? defaults.paystackFixedFeeNGN,
    fxSafetyBufferPct: boundedPct(saved.fxSafetyBufferPct, defaults.fxSafetyBufferPct, 25),
    requireSupplierCost: saved.requireSupplierCost !== false,
    applyArtificialSaleDiscount: saved.applyArtificialSaleDiscount === true,
    shipping: {
      preferredMethod: String(rawShipping.preferredMethod || root.cjPreferredShippingMethod || defaults.shipping.preferredMethod),
      fallbackMethods: Array.isArray(rawShipping.fallbackMethods) ? rawShipping.fallbackMethods : (Array.isArray(root.cjFallbackShippingMethods) ? root.cjFallbackShippingMethods : defaults.shipping.fallbackMethods),
      expressMethods: Array.isArray(rawShipping.expressMethods) ? rawShipping.expressMethods : (Array.isArray(root.cjExpressShippingMethods) ? root.cjExpressShippingMethods : defaults.shipping.expressMethods),
      quoteTtlMinutes: Math.min(120, Math.max(5, Number(rawShipping.quoteTtlMinutes) || defaults.shipping.quoteTtlMinutes)),
      chargeCustomerSeparately: rawShipping.chargeCustomerSeparately !== false,
      highShippingItemPriceRatioWarning: boundedPct(Number(rawShipping.highShippingItemPriceRatioWarning) * 100, 60, 500) / 100,
      highShippingItemPriceRatioBlock: boundedPct(Number(rawShipping.highShippingItemPriceRatioBlock) * 100, 150, 500) / 100,
      enforceShippingRatioBlock: rawShipping.enforceShippingRatioBlock === true,
    },
  };
}

function rateForCurrency(settings = {}, currency = 'NGN') {
  const root = settings && settings.content ? settings.content : (settings || {});
  const rates = root.exchangeRates || {};
  const rate = Number(rates[currency]);
  return Number.isFinite(rate) && rate > 0 ? rate : (currency === 'USD' ? 1 : null);
}

// Supplier product cost is normally in USD. Sale prices are stored in USD
// and converted for display/charge by the existing storefront currency layer.
function calculateRetailPriceUSD(supplierCostUSD, settings = {}) {
  const cost = finiteNonNegative(supplierCostUSD);
  if (cost === null || cost <= 0) return null;
  const policy = getCommercePricingPolicy(settings);
  const rate = rateForCurrency(settings, 'NGN');
  if (!rate) return null;
  // Retail pricing covers the highest supported gateway fee so USD
  // customers do not quietly consume the margin reserved for maintenance.
  const worstCasePaymentFeePct = Math.max(policy.paystackPercentFeePct, policy.paystackUsdPercentFeePct);
  const denominator = 1
    - policy.targetNetMarginPct / 100
    - policy.websiteMaintenanceReservePct / 100
    - worstCasePaymentFeePct / 100;
  if (denominator <= 0.05) return null;
  const bufferedCostUSD = cost * (1 + policy.fxSafetyBufferPct / 100);
  const fixedFeeUSD = policy.paystackFixedFeeNGN / rate;
  return Math.ceil(((bufferedCostUSD + fixedFeeUSD) / denominator) * 100) / 100;
}

function roundMajor(value, currency) {
  if (!Number.isFinite(Number(value))) return null;
  return currency === 'NGN' ? Math.ceil(Number(value)) : Math.round(Number(value) * 100) / 100;
}

// The freight is a pass-through cost, protected for a small FX move and the
// variable payment fee. The fixed NGN payment charge is recovered in item pricing.
function calculateShippingCharge(logisticPriceUSD, currency, settings = {}) {
  const freight = finiteNonNegative(logisticPriceUSD);
  if (freight === null) return null;
  const policy = getCommercePricingPolicy(settings);
  const rate = rateForCurrency(settings, currency);
  if (!rate) return null;
  const pct = currency === 'USD' ? policy.paystackUsdPercentFeePct : policy.paystackPercentFeePct;
  const feeDenominator = 1 - pct / 100;
  if (feeDenominator <= 0.5) return null;
  const fxBuffer = currency === 'USD' ? 0 : policy.fxSafetyBufferPct / 100;
  return roundMajor((freight * rate * (1 + fxBuffer)) / feeDenominator, currency);
}

function sortShippingOptions(options, settings = {}) {
  const policy = getCommercePricingPolicy(settings).shipping;
  const preferred = String(policy.preferredMethod || '').toLowerCase();
  const fallbacks = (policy.fallbackMethods || []).map(v => String(v).toLowerCase());
  const express = (policy.expressMethods || []).map(v => String(v).toLowerCase());
  const isExpressMethod = name => express.some(v => name === v || name.includes(v))
    || ['dhl', 'fedex', 'ups', 'express', 'priority'].some(token => name.includes(token));
  const rank = (option) => {
    const name = String(option.logisticName || '').toLowerCase();
    if (preferred && name === preferred) return 0;
    const fallbackIndex = fallbacks.indexOf(name);
    if (fallbackIndex !== -1) return 10 + fallbackIndex;
    if (isExpressMethod(name)) return 100;
    return 50;
  };
  return (options || []).slice().sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta) return delta;
    return (Number(a.logisticPrice) || 0) - (Number(b.logisticPrice) || 0);
  }).map((option, index) => ({
    ...option,
    isPreferred: String(option.logisticName || '').toLowerCase() === preferred,
    isExpress: isExpressMethod(String(option.logisticName || '').toLowerCase()),
    sortOrder: index + 1,
  }));
}

function shippingRatio(shippingAmount, itemAmount) {
  const shipping = finiteNonNegative(shippingAmount);
  const item = finiteNonNegative(itemAmount);
  return shipping === null || item === null || item <= 0 ? null : shipping / item;
}

module.exports = {
  DEFAULT_POLICY,
  getCommercePricingPolicy,
  rateForCurrency,
  calculateRetailPriceUSD,
  calculateShippingCharge,
  sortShippingOptions,
  shippingRatio,
};