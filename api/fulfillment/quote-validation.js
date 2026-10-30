'use strict';

const { resolveSupplierMapping } = require('./product-mapping');
const { routeIds, iso2 } = require('./shipping-quotes');
const { evaluateShippingPolicy, DEFAULT_SHIPPING_POLICY } = require('./policy');

const txt = (value, max = 180) => value == null ? '' : String(value).trim().slice(0, max);
const norm = value => txt(value, 240).toLowerCase().replace(/\s+/g, ' ');

function millis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function eqMoney(a, b) {
  return Number.isFinite(Number(a))
    && Number.isFinite(Number(b))
    && Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

function eqMinor(minor, major) {
  return Number.isFinite(Number(minor)) && Number(minor) === Math.round(Number(major) * 100);
}

function validateProviderNeutralQuote(options = {}) {
  const {
    quote, product, selection, delivery, payment, reference,
    quantity = 1, suppliers = [], policy = DEFAULT_SHIPPING_POLICY, now = Date.now(),
  } = options;
  const fail = (code, reasons = undefined) => ({ ok: false, code, ...(reasons ? { reasons } : {}) });

  if (!quote || typeof quote !== 'object') return fail('QUOTE_MISSING');
  if (!['open', 'reserved'].includes(quote.status)
    || (quote.status === 'reserved' && quote.usedBy !== reference)) return fail('QUOTE_UNAVAILABLE');
  if (String(quote.productId) !== String(product && product.id)
    || String(quote.variantId || '') !== String(selection && selection.variantId || '')) return fail('QUOTE_PRODUCT_MISMATCH');
  if (Number(quote.quantity) !== Number(quantity)) return fail('QUOTE_QUANTITY_MISMATCH');
  if (String(quote.currency) !== String(payment && payment.currency)) return fail('QUOTE_CURRENCY_MISMATCH');

  const destination = quote.destination || {};
  const country = iso2(delivery && delivery.country);
  if (!country
    || String(quote.endCountryCode || destination.countryCode || '') !== country
    || String(destination.countryCode || quote.endCountryCode || '') !== country) return fail('QUOTE_DESTINATION_MISMATCH');

  for (const [quoteKey, deliveryKey] of [
    ['region', 'state'],
    ['city', 'city'],
    ['postalCode', 'postalCode'],
    ['address1', 'address'],
  ]) {
    if (destination[quoteKey] && delivery && delivery[deliveryKey]
      && norm(destination[quoteKey]) !== norm(delivery[deliveryKey])) return fail('QUOTE_DESTINATION_MISMATCH');
  }

  const createdAt = millis(quote.createdAt);
  const expiresAt = millis(quote.expiresAt);
  const paidAt = millis(payment && payment.paidAt) || millis(payment && payment.createdAt) || Number(now);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || paidAt < createdAt - 60000 || paidAt > expiresAt) return fail('QUOTE_EXPIRED');

  if (!txt(quote.logisticName, 160) || !txt(quote.shippingMethod || quote.logisticName, 160)) {
    return fail('QUOTE_SHIPPING_METHOD_MISSING');
  }

  const itemAmount = Number(quote.productAmountMajor);
  const shippingAmount = Number(quote.shippingAmountMajor);
  const totalAmount = Number(quote.totalAmountMajor);
  const expectedItemAmount = Number(selection && selection.price) * Number(quantity);
  if (!Number.isFinite(itemAmount) || !Number.isFinite(shippingAmount) || shippingAmount < 0
    || !Number.isFinite(totalAmount)
    || !eqMoney(itemAmount, expectedItemAmount)
    || !eqMoney(itemAmount + shippingAmount, totalAmount)
    || !eqMinor(payment && payment.amountMinor, totalAmount)) return fail('QUOTE_AMOUNT_MISMATCH');

  const supplierId = txt(quote.supplierId);
  const providerKey = txt(quote.providerKey, 64);
  const externalProductId = txt(quote.externalProductId);
  const externalVariantId = txt(quote.externalVariantId);
  if (!supplierId || !providerKey || !externalProductId || !externalVariantId) return fail('QUOTE_ROUTE_INCOMPLETE');

  const supplier = suppliers.find(item => item && String(item.id) === supplierId);
  if (!supplier || supplier.active === false || String(supplier.providerKey || '') !== providerKey) {
    return fail('QUOTE_SUPPLIER_MISMATCH');
  }

  const route = routeIds(product);
  if (route.disabled) return fail('ROUTING_DISABLED');
  if (route.ids.length && !route.ids.includes(supplierId)) return fail('QUOTE_ROUTE_CHANGED');
  if (!route.ids.length && providerKey !== 'cj') return fail('QUOTE_ROUTE_CHANGED');

  const mapped = resolveSupplierMapping(product, supplierId, providerKey, selection && selection.variantId, {
    allowLegacyCj: providerKey === 'cj',
  });
  if (!mapped.ok) return fail(mapped.code);
  if (String(mapped.mapping.externalProductId || '') !== externalProductId) return fail('QUOTE_MAPPING_CHANGED');
  const mappedVariant = txt(mapped.variantMapping && mapped.variantMapping.externalVariantId || mapped.mapping.externalVariantId);
  if (mappedVariant !== externalVariantId) return fail('QUOTE_VARIANT_MAPPING_CHANGED');
  if (!/^[A-Z]{2}$/.test(txt(quote.startCountryCode, 2))) return fail('QUOTE_ORIGIN_INVALID');

  const policyResult = evaluateShippingPolicy({
    shippingUSD: quote.supplierShippingCostUSD ?? quote.shippingAmountUSD,
    totalMaxDeliveryDays: quote.estimatedOrderToDoorMaxDays,
    stockVerified: quote.stockVerified === true,
    shippingVerified: quote.shippingVerified === true,
    deliveryVerified: quote.deliveryVerified === true,
    policy,
  });
  if (!policyResult.eligible) return fail(policyResult.reasons[0], policyResult.reasons);

  return {
    ok: true,
    fulfillment: {
      mode: 'API_SUPPLIER',
      state: 'PENDING_SUPPLIER',
      supplierId,
      providerKey,
      externalProductId,
      externalVariantId,
      productId: String(product.id),
      variantId: selection.variantId || null,
      quantity: Number(quantity),
      shippingQuoteId: txt(quote.quoteId),
      shippingMethod: txt(quote.shippingMethod || quote.logisticName, 160),
      sourceWarehouse: txt(quote.sourceWarehouse, 120) || null,
      originCountryCode: txt(quote.startCountryCode, 2),
      destinationCountryCode: country,
      supplierShippingCost: Number(quote.supplierShippingCost),
      supplierShippingCurrency: txt(quote.supplierShippingCurrency, 3).toUpperCase(),
      supplierShippingCostUSD: Number(quote.supplierShippingCostUSD),
      quoteTotalAmountMajor: totalAmount,
      currency: txt(quote.currency, 3),
      supplierActiveAtPayment: true,
    },
    delivery: {
      shippingQuoteId: txt(quote.quoteId),
      shippingMethod: txt(quote.shippingMethod || quote.logisticName, 160),
      shippingOriginCountry: txt(quote.startCountryCode, 2),
      shippingAmountMajor: shippingAmount,
      shippingCurrency: txt(quote.currency, 3),
      shippingAmountUSD: Number(quote.shippingAmountUSD),
      shippingETA: quote.logisticAging || null,
      shippingServiceLevel: quote.serviceLevel || null,
      shippingServiceLabel: quote.serviceLabel || 'NOVA Delivery',
      shippingDeliveryEstimate: quote.deliveryEstimate || null,
      shippingEstimatedMaxDays: Number.isFinite(Number(quote.estimatedOrderToDoorMaxDays))
        ? Number(quote.estimatedOrderToDoorMaxDays) : null,
      shippingProcessingAllowanceDays: Number.isFinite(Number(quote.processingAllowanceDays))
        ? Number(quote.processingAllowanceDays) : null,
      shippingQuoteExpiresAt: new Date(expiresAt).toISOString(),
      shippingSupplierId: supplierId,
      shippingProviderKey: providerKey,
      shippingExternalProductId: externalProductId,
      shippingExternalVariantId: externalVariantId,
      shippingSourceWarehouse: txt(quote.sourceWarehouse, 120) || null,
    },
  };
}

module.exports = { validateProviderNeutralQuote, millis, eqMoney, eqMinor };
