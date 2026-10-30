'use strict';

const DEFAULT_SHIPPING_POLICY = Object.freeze({
  maxDeliveryDays: 15,
  maxShippingUSD: 15,
  destinationCountry: 'NG',
  requireVerifiedStock: true,
  requireVerifiedShipping: true,
  maxShippingUSDPerFulfillment: 15,
  maxShippingUSDPerOrder: 15,
});

const numberOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function rootOf(settings = {}) {
  return settings && settings.content ? settings.content : (settings || {});
}

function getShippingPolicy(settings = {}) {
  const saved = rootOf(settings).shippingPolicy || {};
  return Object.freeze({
    maxDeliveryDays: Math.min(15, Math.max(1, numberOr(saved.maxDeliveryDays, 15))),
    maxShippingUSD: Math.min(15, Math.max(0, numberOr(saved.maxShippingUSD, 15))),
    destinationCountry: String(saved.destinationCountry || 'NG').trim().toUpperCase(),
    requireVerifiedStock: saved.requireVerifiedStock !== false,
    requireVerifiedShipping: saved.requireVerifiedShipping !== false,
    maxShippingUSDPerFulfillment: Math.min(15, Math.max(0, numberOr(saved.maxShippingUSDPerFulfillment, 15))),
    maxShippingUSDPerOrder: Math.min(15, Math.max(0, numberOr(saved.maxShippingUSDPerOrder, 15))),
  });
}

function conservativeDeliveryDays(option = {}, processingFallback = 0) {
  const direct = Number(option.totalMaxDays ?? option.estimatedOrderToDoorMaxDays);
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const processing = Number(option.processingMaxDays ?? option.processingDays ?? processingFallback);
  const transit = Number(option.transitMaxDays ?? option.transitDays);
  if (Number.isFinite(processing) && processing >= 0 && Number.isFinite(transit) && transit >= 0) {
    return processing + transit;
  }

  const text = String(option.deliveryRange || option.logisticAging || '').trim();
  const range = text.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*(business\s*)?days?/i);
  if (range) {
    const max = Number(range[2]);
    if (!Number.isFinite(max)) return null;
    const transitMax = range[3] ? Math.ceil(max * 7 / 5) : max;
    return transitMax + (Number.isFinite(processing) && processing >= 0 ? processing : 0);
  }

  const one = text.match(/^\s*(\d+)\s*(business\s*)?days?\s*$/i);
  if (!one) return null;
  const days = Number(one[1]);
  const transitMax = one[2] ? Math.ceil(days * 7 / 5) : days;
  return transitMax + (Number.isFinite(processing) && processing >= 0 ? processing : 0);
}

function evaluateShippingPolicy({ shippingUSD, totalMaxDeliveryDays, stockVerified, shippingVerified, policy }) {
  const p = policy || DEFAULT_SHIPPING_POLICY;
  const reasons = [];
  if (p.requireVerifiedStock && stockVerified !== true) reasons.push('STOCK_UNVERIFIED');
  if (p.requireVerifiedShipping && shippingVerified !== true) reasons.push('NO_SHIPPING_QUOTE');
  if (!Number.isFinite(Number(shippingUSD))) reasons.push('SHIPPING_UNVERIFIED');
  else if (Number(shippingUSD) > Number(p.maxShippingUSD)) reasons.push('SHIPPING_TOO_EXPENSIVE');
  if (!Number.isFinite(Number(totalMaxDeliveryDays))) reasons.push('DELIVERY_UNVERIFIED');
  else if (Number(totalMaxDeliveryDays) > Number(p.maxDeliveryDays)) reasons.push('DELIVERY_TOO_SLOW');
  return { eligible: reasons.length === 0, reasons };
}

module.exports = {
  DEFAULT_SHIPPING_POLICY,
  getShippingPolicy,
  conservativeDeliveryDays,
  evaluateShippingPolicy,
};
