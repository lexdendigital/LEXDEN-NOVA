'use strict';

function listVariants(product) {
  return Array.isArray(product && product.variants) ? product.variants.filter(v => v && typeof v === 'object') : [];
}

function findPurchasableVariant(product, variantId) {
  const variants = listVariants(product);
  if (!variants.length) return variantId ? null : { variant: null, label: null };
  if (!variantId) return null; // never silently charge the parent price for a configured variant product
  const variant = variants.find(v => String(v.id) === String(variantId));
  const hasStock = variant && variant.stock !== undefined && variant.stock !== null && variant.stock !== '' && Number.isFinite(Number(variant.stock));
  if (!variant || variant.active === false || variant.available === false || (hasStock && Number(variant.stock) <= 0)) return null;
  const options = product.options || [];
  const values = variant.optionValues || {};
  const label = options.map(option => {
    const valueId = values[option.id];
    const value = (option.values || []).find(item => String(item.id) === String(valueId));
    return value ? value.label : valueId;
  }).filter(Boolean).join(' • ') || variant.title || variant.name || null;
  return { variant, label };
}

function effectivePrice(product, variant) {
  const base = variant && typeof variant.price === 'number' ? variant.price : product && product.price;
  if (typeof base !== 'number' || !Number.isFinite(base) || base < 0) return null;
  const sale = variant && typeof variant.salePrice === 'number' ? variant.salePrice : (!variant && product && product.salePrice);
  return typeof sale === 'number' && Number.isFinite(sale) && sale >= 0 && sale < base ? sale : base;
}

function resolveProductSelection(product, variantId, currency, settings) {
  if (!product) return null;
  const match = findPurchasableVariant(product, variantId);
  if (!match || !selectionAvailability(product, match.variant)) return null;
  const basePrice = effectivePrice(product, match.variant);
  if (basePrice === null) return null;
  const rates = settings && (settings.exchangeRates || settings.content && settings.content.exchangeRates);
  const rate = rates && typeof rates[currency] === 'number' && rates[currency] > 0 ? rates[currency] : 1;
  return {
    variant: match.variant,
    variantId: match.variant ? String(match.variant.id) : null,
    variantName: match.label,
    price: Math.round(basePrice * rate),
    basePrice,
    currency,
  };
}

function selectionAvailability(product, variant) {
  if (variant && variant.available === false) return false;
  if (variant && variant.stock !== undefined && variant.stock !== null && variant.stock !== '' && Number.isFinite(Number(variant.stock)) && Number(variant.stock) <= 0) return false;
  if (!variant && product && product.productType === 'PHYSICAL' && product.physical && product.physical.stockStatus === 'out_of_stock') return false;
  return true;
}

module.exports = { listVariants, findPurchasableVariant, effectivePrice, resolveProductSelection, selectionAvailability };
