'use strict';

function uniqueUrls(values) {
  return [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string').map(value => value.trim()).filter(value => /^https?:\/\//i.test(value)))];
}

function buildProductSpecs(source) {
  const specs = {};
  const add = (label, value) => {
    if (value == null || value === '') return;
    specs[label] = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value);
  };
  add('Supplier category', source.categoryName);
  add('Product options', source.productOptions);
  add('Material', source.materials);
  add('Package weight (g)', source.packageWeight);
  add('Package materials', source.packageMaterials);
  add('Shipping attributes', source.logisticsAttributes);
  add('Customs code', source.customsCode);
  add('Customs description', source.customsName);
  add('Supplier suggested price (USD)', source.suggestedSellPrice);
  if (source.specifications && typeof source.specifications === 'object') {
    for (const [key, value] of Object.entries(source.specifications)) add(key, value);
  }
  return specs;
}

function stockStatusFrom(stock, variantCount, lookupOk) {
  if (!lookupOk || !variantCount) return 'out_of_stock';
  return Object.values(stock || {}).some(item => item && item.inStock) ? 'in_stock' : 'out_of_stock';
}

module.exports = { uniqueUrls, buildProductSpecs, stockStatusFrom };
