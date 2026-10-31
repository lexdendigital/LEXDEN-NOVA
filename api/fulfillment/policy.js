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

function conservativeDeliveryBounds(option = {}, processingFallback = 0) {
  const directMaxRaw = option.totalMaxDays ?? option.estimatedOrderToDoorMaxDays;
  const directMax = directMaxRaw == null || directMaxRaw === '' ? NaN : Number(directMaxRaw);
  if (Number.isFinite(directMax) && directMax >= 0) {
    const directMinRaw = option.totalMinDays ?? option.estimatedOrderToDoorMinDays;
    const directMin = directMinRaw == null || directMinRaw === '' ? directMax : Number(directMinRaw);
    if (!Number.isFinite(directMin) || directMin < 0 || directMin > directMax) return null;
    return { minDays: directMin, maxDays: directMax };
  }

  const processingRaw = option.processingMaxDays ?? option.processingDays ?? processingFallback;
  const transitMaxRaw = option.transitMaxDays ?? option.transitDays;
  const transitMinRaw = option.transitMinDays ?? option.transitDays ?? transitMaxRaw;
  const processing = processingRaw == null || processingRaw === '' ? NaN : Number(processingRaw);
  const transitMin = transitMinRaw == null || transitMinRaw === '' ? NaN : Number(transitMinRaw);
  const transitMax = transitMaxRaw == null || transitMaxRaw === '' ? NaN : Number(transitMaxRaw);
  if (Number.isFinite(processing) && processing >= 0
    && Number.isFinite(transitMin) && transitMin >= 0
    && Number.isFinite(transitMax) && transitMax >= transitMin) {
    return { minDays: processing + transitMin, maxDays: processing + transitMax };
  }

  const text = String(option.deliveryRange || option.logisticAging || '').trim();
  // CJ commonly returns bare ranges such as "12-50" without a "days" suffix.
  // Treat unitless ranges as calendar days; explicitly stated business days
  // are conservatively converted to calendar-day bounds.
  const range = text.match(/^\s*(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*(?:(business\s*)?(?:days?|d))?\s*$/i);
  const processingDays = Number.isFinite(processing) && processing >= 0 ? processing : 0;
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
    const businessDays = !!range[3];
    const transitMinDays = businessDays ? Math.ceil(min * 7 / 5) : min;
    const transitMaxDays = businessDays ? Math.ceil(max * 7 / 5) : max;
    return {
      minDays: transitMinDays + processingDays,
      maxDays: transitMaxDays + processingDays,
    };
  }

  const one = text.match(/^\s*(\d+)\s*(?:(business\s*)?(?:days?|d))?\s*$/i);
  if (!one) return null;
  const days = Number(one[1]);
  if (!Number.isFinite(days) || days < 0) return null;
  const transitDays = one[2] ? Math.ceil(days * 7 / 5) : days;
  return { minDays: transitDays + processingDays, maxDays: transitDays + processingDays };
}

function conservativeDeliveryDays(option = {}, processingFallback = 0) {
  const bounds = conservativeDeliveryBounds(option, processingFallback);
  return bounds ? bounds.maxDays : null;
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
  conservativeDeliveryBounds,
  evaluateShippingPolicy,
};
