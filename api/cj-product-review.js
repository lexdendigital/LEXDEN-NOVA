'use strict';

function isCjPhysicalProduct(product) {
  return !!(product
    && String(product.productType || '').toUpperCase() === 'PHYSICAL'
    && product.physical
    && product.physical.cj
    && String(product.physical.cj.productId || '').trim());
}

function moneyKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : String(value);
}

function textKey(value) {
  return String(value == null ? '' : value).trim();
}

function pricingInputsSnapshot(product) {
  const p = product || {};
  const physical = p.physical || {};
  const cj = physical.cj || {};
  const variants = Array.isArray(p.variants) ? p.variants.map(v => ({
    id: textKey(v && v.id),
    price: moneyKey(v && v.price),
    salePrice: moneyKey(v && v.salePrice),
    cjVariantId: textKey(v && v.cjVariantId),
    sku: textKey(v && v.sku),
    active: v && v.active !== false,
    available: v && v.available !== false,
  })).sort((a, b) => a.id.localeCompare(b.id)) : [];

  return JSON.stringify({
    price: moneyKey(p.price),
    salePrice: moneyKey(p.salePrice),
    supplierId: textKey(physical.supplierId),
    supplierSku: textKey(physical.supplierSku),
    supplierCost: moneyKey(physical.supplierCost),
    supplierCurrency: textKey(physical.supplierCurrency).toUpperCase(),
    shippingCountries: (Array.isArray(physical.shippingCountries) ? physical.shippingCountries : [])
      .map(textKey).filter(Boolean).sort(),
    deliveryEstimate: textKey(physical.deliveryEstimate),
    cjProductId: textKey(cj.productId),
    cjVariantId: textKey(cj.variantId),
    cjSku: textKey(cj.sku),
    sourceCountry: textKey(cj.sourceCountry || physical.sourceCountry).toUpperCase(),
    variants,
  });
}

function hasCjPricingInputsChanged(currentProduct, nextProduct) {
  if (!currentProduct || typeof currentProduct !== 'object') return true;
  return pricingInputsSnapshot(currentProduct) !== pricingInputsSnapshot(nextProduct);
}

function assertCjPhysicalPublicationAllowed(product) {
  if (!product || product.status !== 'published' || !isCjPhysicalProduct(product)) return true;
  const note = textKey(product.pricingReviewNotes);
  if (product.pricingReviewRequired !== false || note.length < 40 || !product.pricingReviewCompletedAt) {
    const error = new Error(
      'Cannot publish this CJ physical product yet. Keep it in Draft until the live supplier cost, stock, shipping route, delivery estimate, full customer total, local market comparison, margin and supplier-funding readiness have been reviewed. Record at least 40 characters of review evidence and save the completed review first.'
    );
    error.status = 400;
    error.code = 'CJ_PRICING_REVIEW_REQUIRED';
    throw error;
  }
  return true;
}

function assertCjPhysicalProductCreatedAsDraft(product) {
  if (isCjPhysicalProduct(product) && product.status === 'published') {
    const error = new Error(
      'New CJ physical products must be created as Draft first. Verify live stock and shipping, compare the delivered price with the local market, then complete the review before publishing.'
    );
    error.status = 400;
    error.code = 'CJ_PRODUCT_MUST_START_AS_DRAFT';
    throw error;
  }
  return true;
}

module.exports = {
  isCjPhysicalProduct,
  pricingInputsSnapshot,
  hasCjPricingInputsChanged,
  assertCjPhysicalPublicationAllowed,
  assertCjPhysicalProductCreatedAsDraft,
};
