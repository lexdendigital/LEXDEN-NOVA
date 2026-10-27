'use strict';

function uniqueUrls(values) {
  return [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string').map(value => value.trim()).filter(value => /^https?:\/\//i.test(value)))];
}

function buildProductSpecs(source) {
  const specs = {};
  const add = (label, value) => {
    if (value == null || value === '') return;
    const normalized = Array.isArray(value)
      ? value.filter(item => item != null && item !== '').map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ')
      : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (normalized !== '') specs[label] = normalized;
  };
  // Keep a readable admin-facing copy of every normalized attribute CJ
  // provides. The untouched CJ payload is also retained in sourceData.
  add('Supplier product ID', source.pid);
  add('Supplier name', source.supplierName);
  add('Supplier ID', source.supplierId);
  add('Supplier SKU', source.sku);
  add('Supplier category', source.categoryName);
  add('Supplier product type', source.productType);
  add('Source country', source.sourceCountry);
  add('Unit', source.unit);
  add('Product options', source.productOptions);
  add('Material', source.materials);
  add('Package weight (g)', source.packageWeight);
  add('Package materials', source.packageMaterials);
  add('Shipping attributes', source.logisticsAttributes);
  add('Customs code', source.customsCode);
  add('Customs description', source.customsName);
  add('Supplier suggested price', source.suggestedSellPrice);
  add('Listed quantity', source.listedNum);
  add('Product dimensions', source.dimensions);
  add('Source currency', source.supplierCurrency);
  if (source.specifications && typeof source.specifications === 'object') {
    for (const [key, value] of Object.entries(source.specifications)) add(key, value);
  }
  return specs;
}

function stockStatusFrom(stock, variantCount, lookupOk) {
  if (!lookupOk || !variantCount) return '';
  const items = Object.values(stock || {}).filter(item => item && typeof item.inStock === 'boolean');
  if (!items.length) return '';
  return items.some(item => item.inStock) ? 'in_stock' : 'out_of_stock';
}

function deriveSuggestedPricing(productSuggestedPrice, variants = []) {
  const validPrice = value => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const variantPrices = variants
    .map(variant => validPrice(variant && variant.suggestedSellPrice))
    .filter(value => value != null);
  const regularPrice = validPrice(productSuggestedPrice) ?? (variantPrices.length ? Math.min(...variantPrices) : null);
  if (regularPrice == null) return { price: null, salePrice: null, discount: null };
  return {
    price: regularPrice,
    salePrice: Number((regularPrice * 0.6).toFixed(2)),
    discount: 40,
  };
}

function deriveCostBasedPricing(productCost, variants = [], settings = {}, productCurrency = 'USD') {
  const currencyIsUsd = value => ['USD', 'US DOLLAR', 'US DOLLARS'].includes(String(value || '').trim().toUpperCase());
  const numericCost = value => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const priceFor = (cost, currency) => {
    const amount = numericCost(cost);
    if (amount == null || !currencyIsUsd(currency)) return null;
    return require('../../api/commerce-pricing').calculateRetailPriceUSD(amount, settings);
  };
  const variantPrices = variants.map(v => priceFor(
    v && (v.sellPrice ?? v.supplierCostUSD ?? v.costUSD),
    v && (v.sellPriceCurrency || v.supplierCurrency || productCurrency)
  ));
  const knownVariantPrices = variantPrices.filter(v => Number.isFinite(v) && v > 0);
  const productPrice = knownVariantPrices.length
    ? Math.min(...knownVariantPrices)
    : priceFor(productCost, productCurrency);
  return {
    price: productPrice == null ? null : productPrice,
    salePrice: null,
    discount: 0,
    pricingModel: 'supplier-cost-plus-v1',
    variantPrices,
  };
}

module.exports = { uniqueUrls, buildProductSpecs, stockStatusFrom, deriveSuggestedPricing, deriveCostBasedPricing };
