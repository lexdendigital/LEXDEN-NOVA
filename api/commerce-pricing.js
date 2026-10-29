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
    // Customer-facing service levels are independent of the carrier selected here.
    preferredMethod: 'CJPacket Postal',
    fallbackMethods: ['CJPacket Liquid Line', 'PostNL'],
    expressMethods: ['DHL Official'],
    quoteTtlMinutes: 30,
    chargeCustomerSeparately: true,
    // Smart must meet this conservative order-to-door target after processing allowance.
    maxDeliveryDays: 45,
    processingDays: 5,
    smartMaxShippingPremiumPct: 0.40,
    economyMinSavingUSD: 2.50,
    economyMinSavingPct: 0.20,
    allowEconomyOverMaxDays: true,
    highShippingItemPriceRatioWarning: 0.25,
    highShippingItemPriceRatioBlock: 0.35,
    enforceShippingRatioBlock: true,
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
      maxDeliveryDays: Math.min(90, Math.max(7, Number(rawShipping.maxDeliveryDays) || defaults.shipping.maxDeliveryDays)),
      processingDays: Math.min(15, Math.max(0, Number.isFinite(Number(rawShipping.processingDays)) ? Number(rawShipping.processingDays) : defaults.shipping.processingDays)),
      smartMaxShippingPremiumPct: boundedPct(Number(rawShipping.smartMaxShippingPremiumPct) * 100, defaults.shipping.smartMaxShippingPremiumPct * 100, 200) / 100,
      economyMinSavingUSD: finiteNonNegative(rawShipping.economyMinSavingUSD) ?? defaults.shipping.economyMinSavingUSD,
      economyMinSavingPct: boundedPct(Number(rawShipping.economyMinSavingPct) * 100, defaults.shipping.economyMinSavingPct * 100, 100) / 100,
      allowEconomyOverMaxDays: rawShipping.allowEconomyOverMaxDays !== false,
      highShippingItemPriceRatioWarning: boundedPct(Number(rawShipping.highShippingItemPriceRatioWarning) * 100, defaults.shipping.highShippingItemPriceRatioWarning * 100, 500) / 100,
      highShippingItemPriceRatioBlock: boundedPct(Number(rawShipping.highShippingItemPriceRatioBlock) * 100, defaults.shipping.highShippingItemPriceRatioBlock * 100, 500) / 100,
      enforceShippingRatioBlock: rawShipping.enforceShippingRatioBlock !== false,
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

function parseShippingAging(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const range = text.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/i);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min) return { minDays: min, maxDays: max };
    return null;
  }
  const one = text.match(/^\s*(\d+)\s*(?:days?|d)?\s*$/i);
  if (one) {
    const days = Number(one[1]);
    if (Number.isFinite(days) && days >= 0) return { minDays: days, maxDays: days };
  }
  return null;
}

function isExpressShippingMethod(name, settings = {}) {
  const policy = getCommercePricingPolicy(settings).shipping;
  const lower = String(name || '').toLowerCase();
  const configured = (policy.expressMethods || []).map(v => String(v).toLowerCase());
  return configured.some(v => v && (lower === v || lower.includes(v)))
    || ['dhl', 'fedex', 'ups', 'express', 'priority'].some(token => lower.includes(token));
}

/**
 * Maps anonymous carrier quotes into NOVA service promises.
 *
 * - Smart: a non-express route whose maximum quoted transit + processing allowance
 *   meets the configured order-to-door target. From those routes, pick the fastest
 *   route within a bounded premium over the cheapest eligible route.
 * - Economy: a slower, cheaper route only when savings are material. It can exceed
 *   the Smart target, so the customer must explicitly choose it and sees the honest
 *   expanded estimate. If there is no Smart route, Economy is never preselected.
 * - Express: a verified fast route is surfaced only when its shipping-to-item
 *   cost ratio remains below the hard affordability cap.
 *
 * An unknown aging estimate is never described as a known delivery promise.
 */
function selectShippingServices(options, settings = {}, context = {}) {
  const policy = getCommercePricingPolicy(settings).shipping;
  const processingDays = Number.isFinite(Number(context.processingDays))
    ? Math.max(0, Number(context.processingDays))
    : policy.processingDays;
  const productAmountUSD = finiteNonNegative(context.productAmountUSD);
  const maxRatio = policy.highShippingItemPriceRatioBlock;
  const normalized = (options || []).map(option => {
    const aging = parseShippingAging(option.logisticAging);
    const cost = finiteNonNegative(option.logisticPrice);
    const express = isExpressShippingMethod(option.logisticName, settings);
    const ratio = productAmountUSD > 0 && cost != null ? cost / productAmountUSD : null;
    return {
      ...option,
      __aging: aging,
      __cost: cost,
      __express: express,
      __ratio: ratio,
      __minDoorDays: aging ? aging.minDays + processingDays : null,
      __maxDoorDays: aging ? aging.maxDays + processingDays : null,
    };
  }).filter(option => option.__aging && option.__cost != null && option.__cost >= 0
    && option.__ratio != null && option.__ratio <= maxRatio);

  const standard = normalized.filter(option => !option.__express);
  const smartEligible = standard.filter(option => option.__maxDoorDays <= policy.maxDeliveryDays);
  let smart = null;
  if (smartEligible.length) {
    const cheapest = Math.min(...smartEligible.map(option => option.__cost));
    const premiumLimit = cheapest * (1 + policy.smartMaxShippingPremiumPct);
    const reasonablyPriced = smartEligible.filter(option => option.__cost <= premiumLimit + 0.000001);
    reasonablyPriced.sort((a, b) => a.__maxDoorDays - b.__maxDoorDays
      || a.__minDoorDays - b.__minDoorDays
      || a.__cost - b.__cost);
    smart = reasonablyPriced[0];
  }

  const selected = [];
  const toPublicService = (option, serviceLevel, serviceLabel, requiresExplicitChoice, reason) => {
    const { __aging, __cost, __express, __ratio, __minDoorDays, __maxDoorDays, ...publicOption } = option;
    return {
      ...publicOption,
      serviceLevel,
      serviceLabel,
      deliveryEstimate: String(__minDoorDays) + '-' + String(__maxDoorDays) + ' days',
      estimatedOrderToDoorMinDays: __minDoorDays,
      estimatedOrderToDoorMaxDays: __maxDoorDays,
      processingAllowanceDays: processingDays,
      requiresExplicitChoice,
      serviceRationale: reason,
    };
  };

  if (smart) {
    selected.push(toPublicService(smart, 'smart', 'NOVA Smart Delivery', false,
      'Best speed-price compromise among routes that meet the Smart delivery target.'));
    const economyCandidates = standard.filter(option => option !== smart
      && option.__cost < smart.__cost
      && (option.__maxDoorDays > smart.__maxDoorDays || option.__minDoorDays > smart.__minDoorDays)
      && smart.__cost - option.__cost >= policy.economyMinSavingUSD
      && (smart.__cost - option.__cost) / smart.__cost >= policy.economyMinSavingPct);
    economyCandidates.sort((a, b) => a.__cost - b.__cost || b.__maxDoorDays - a.__maxDoorDays);
    if (economyCandidates.length && policy.allowEconomyOverMaxDays) {
      selected.push(toPublicService(economyCandidates[0], 'economy', 'NOVA Economy', true,
        'Slower route offered only because its saving is material; the longer estimate is shown before payment.'));
    }
  } else if (policy.allowEconomyOverMaxDays && standard.length) {
    standard.sort((a, b) => a.__cost - b.__cost || a.__maxDoorDays - b.__maxDoorDays);
    selected.push(toPublicService(standard[0], 'economy', 'NOVA Economy', true,
      'No route met the Smart delivery target; this slower option requires explicit customer acceptance.'));
  }

  const expressCandidates = normalized.filter(option => option.__express
    && option.__maxDoorDays <= policy.maxDeliveryDays);
  expressCandidates.sort((a, b) => a.__maxDoorDays - b.__maxDoorDays || a.__cost - b.__cost);
  if (expressCandidates.length) {
    selected.push(toPublicService(expressCandidates[0], 'express', 'NOVA Express', true,
      'Fast route available at a separately quoted price.'));
  }

  return selected.map((option, index) => ({ ...option, serviceSortOrder: index + 1 }));
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
  parseShippingAging,
  isExpressShippingMethod,
  selectShippingServices,
  sortShippingOptions,
  shippingRatio,
};