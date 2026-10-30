'use strict';

// NOVA has no default price or delivery-time ceiling.
// An authorized administrator may configure either value centrally.
// null means "no configured business cap", not zero.
const DEFAULT_SHIPPING_POLICY = Object.freeze({
  maxDeliveryDays: null,
  maxShippingUSD: null,
  destinationCountry: 'NG',
  requireVerifiedStock: true,
  requireVerifiedShipping: true,
  requireVerifiedDelivery: true,
  maxShippingUSDPerFulfillment: null,
  maxShippingUSDPerOrder: null,
});

function optionalLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function rootOf(settings = {}) {
  return settings && settings.content ? settings.content : (settings || {});
}

function getShippingPolicy(settings = {}) {
  const saved = rootOf(settings).shippingPolicy || {};
  return Object.freeze({
    maxDeliveryDays: optionalLimit(saved.maxDeliveryDays),
    maxShippingUSD: optionalLimit(saved.maxShippingUSD),
    destinationCountry: String(saved.destinationCountry || DEFAULT_SHIPPING_POLICY.destinationCountry).trim().toUpperCase(),
    requireVerifiedStock: saved.requireVerifiedStock !== false,
    requireVerifiedShipping: saved.requireVerifiedShipping !== false,
    requireVerifiedDelivery: saved.requireVerifiedDelivery !== false,
    maxShippingUSDPerFulfillment: optionalLimit(saved.maxShippingUSDPerFulfillment),
    maxShippingUSDPerOrder: optionalLimit(saved.maxShippingUSDPerOrder),
  });
}

function conservativeDeliveryDays(option = {}, processingFallback = 0) {
  const directRaw = option.totalMaxDays ?? option.estimatedOrderToDoorMaxDays;
  const direct = directRaw == null || directRaw === '' ? NaN : Number(directRaw);
  if (Number.isFinite(direct) && direct >= 0) return direct;

  const processingRaw = option.processingMaxDays ?? option.processingDays ?? processingFallback;
  const transitRaw = option.transitMaxDays ?? option.transitDays;
  const processing = processingRaw == null || processingRaw === '' ? NaN : Number(processingRaw);
  const transit = transitRaw == null || transitRaw === '' ? NaN : Number(transitRaw);
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

function evaluateShippingPolicy({ shippingUSD, totalMaxDeliveryDays, stockVerified, shippingVerified, deliveryVerified, policy }) {
  const p = policy || DEFAULT_SHIPPING_POLICY;
  const reasons = [];

  if (p.requireVerifiedStock && stockVerified !== true) reasons.push('STOCK_UNVERIFIED');
  if (p.requireVerifiedShipping && shippingVerified !== true) reasons.push('NO_SHIPPING_QUOTE');

  if (shippingUSD === null || shippingUSD === undefined || shippingUSD === '' || !Number.isFinite(Number(shippingUSD))) {
    reasons.push('SHIPPING_UNVERIFIED');
  } else if (p.maxShippingUSD !== null && Number(shippingUSD) > p.maxShippingUSD) {
    reasons.push('SHIPPING_TOO_EXPENSIVE');
  }

  const hasDelivery = totalMaxDeliveryDays !== null
    && totalMaxDeliveryDays !== undefined
    && totalMaxDeliveryDays !== ''
    && Number.isFinite(Number(totalMaxDeliveryDays));

  if (p.requireVerifiedDelivery && (deliveryVerified === false || !hasDelivery)) {
    reasons.push('DELIVERY_UNVERIFIED');
  } else if (hasDelivery && p.maxDeliveryDays !== null && Number(totalMaxDeliveryDays) > p.maxDeliveryDays) {
    reasons.push('DELIVERY_TOO_SLOW');
  }

  return { eligible: reasons.length === 0, reasons };
}

module.exports = {
  DEFAULT_SHIPPING_POLICY,
  getShippingPolicy,
  conservativeDeliveryDays,
  evaluateShippingPolicy,
};
