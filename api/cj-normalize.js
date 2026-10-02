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
      sellPrice: p.sellPrice != null ? numberOrNull(p.sellPrice) : (p.nowPrice != null ? numberOrNull(p.nowPrice) : (p.price != null ? numberOrNull(p.price) : null)),
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

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { normalizeSearchPayload };
