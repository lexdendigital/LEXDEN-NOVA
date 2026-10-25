'use strict';

function normalizeSearchPayload(payload) {
  const groups = Array.isArray(payload) ? payload : (payload && (payload.content || payload.list || payload.records)) || [];
  const raw = groups.flatMap(group => {
    if (Array.isArray(group)) return group;
    if (group && Array.isArray(group.productList)) return group.productList;
    if (group && Array.isArray(group.list)) return group.list;
    return group && typeof group === 'object' ? [group] : [];
  });
  return {
    rawCount: raw.length,
    products: raw.map(p => ({
      pid: p.pid || p.productId || p.id,
      name: p.productNameEn || p.nameEn || p.productName || p.name,
      image: p.productImage || p.bigImage || (Array.isArray(p.productImageSet) ? p.productImageSet[0] : null) || p.image,
      sku: p.productSku || p.sku || p.spu,
      sellPrice: firstPrice(p.sellPrice, p.nowPrice, p.discountPrice, p.price),
      priceText: [p.sellPrice, p.nowPrice].find(v => typeof v === 'string' && /\d/.test(v)) || null,
      variantCount: p.variantNum || p.variantCount || null,
      categoryId: p.categoryId || null,
      categoryName: p.threeCategoryName || p.categoryName || null,
      description: p.description || '',
      video: Array.isArray(p.videoList) ? p.videoList[0] || null : (p.productVideo || null),
      stock: p.warehouseInventoryNum ?? p.totalVerifiedInventory ?? null,
      weight: p.productWeight ?? p.weight ?? null,
      listedNum: p.listedNum ?? null,
      supplierName: p.supplierName || 'CJ Dropshipping',
    })),
  };
}

// CJ's list endpoint often returns a price RANGE as text ("1.20 -- 3.50")
// or a string with a currency mark. Number() of those is NaN, which used to
// blank the price on most search results. Take the lowest figure in the
// text; the exact per-variant price comes from the product detail on import.
function priceFrom(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const nums = String(value).match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  const n = Math.min(...nums.map(Number));
  return Number.isFinite(n) ? n : null;
}
function firstPrice(...values) {
  for (const v of values) { const n = priceFrom(v); if (n != null) return n; }
  return null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { normalizeSearchPayload, priceFrom };
