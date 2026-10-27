// /api/cj-product.js
//
// LEXDEN NOVA × CJ — full product detail + variants for one CJ product,
// used both by the Admin import screen (README §14 step 3-4) and by the
// product editor's [Refresh Variants]/[Test CJ Product] buttons (§32).
//
// CONTRACT
// GET /api/cj-product?pid=CJ_PRODUCT_ID
//   -> { ok:true, product:{ pid,name,description,images,video,category },
//                 variants:[{ vid, sku, name, image, sellPrice, variantKey }] }
// GET /api/cj-product?vid=CJ_VARIANT_ID   (single-variant lookup)
//   -> { ok:true, variant:{...} }

const { setCors, cjFetch, writeSyncLog } = require('./cj-shared');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const pid = req.query.pid ? String(req.query.pid) : null;
  const vid = req.query.vid ? String(req.query.vid) : null;
  if (!pid && !vid) return res.status(200).json({ ok: false, error: 'Provide pid or vid.' });

  const started = Date.now();

  try {
    if (vid && !pid) {
      const r = await cjFetch('/product/variant/queryByVid', { query: { vid } });
      const tookMs = Date.now() - started;
      if (!r.ok) {
        await writeSyncLog({ event: 'product.variant', objectId: vid, success: false, message: r.message, tookMs });
        return res.status(200).json({ ok: false, error: r.message });
      }
      await writeSyncLog({ event: 'product.variant', objectId: vid, success: true, message: 'OK', tookMs });
      return res.status(200).json({ ok: true, variant: normalizeVariant(r.data) });
    }

    const [detailR, variantsR] = await Promise.all([
      cjFetch('/product/query', { query: { pid } }),
      cjFetch('/product/variant/query', { query: { pid } }),
    ]);
    const tookMs = Date.now() - started;

    if (!detailR.ok) {
      await writeSyncLog({ event: 'product.detail', objectId: pid, success: false, message: detailR.message, tookMs });
      return res.status(200).json({ ok: false, error: detailR.message });
    }

    const d = detailR.data || {};
    const images = normalizeImages(d.productImageSet || d.images || d.productImage || d.bigImage || d.image);
    const product = {
      pid: d.pid || pid,
      name: d.productNameEn || d.nameEn || d.productName || d.name,
      description: d.description || d.productDescriptionEn || '',
      images,
      image: images[0] || null,
      video: d.productVideo || d.video || null,
      categoryId: d.categoryId || null,
      categoryName: d.categoryName || null,
      weight: numberOrNull(d.productWeight),
      supplierName: d.supplierName || '',
      supplierCurrency: String(d.productCurrency || d.sellPriceCurrency || d.productSellPriceCurrency || d.currencyCode || d.priceCurrency || d.currency || ''),
      sourceData: d,
      supplierId: d.supplierId || null,
      sku: d.productSku || d.sku || d.spu || null,
      sellPrice: firstNumericOrNull(d.sellPrice, d.productSellPrice, d.price),
      suggestedSellPrice: firstNumericOrNull(d.suggestSellPrice, d.suggestedSellPrice, d.suggestPrice),
      productType: d.productType || null,
      unit: d.productUnit || d.unit || null,
      sourceCountry: d.sourceCountry || '',
      deliveryCycle: d.deliveryCycle || null,
      materials: d.materialNameEnSet || d.materialNameEn || d.materialName || [],
      packageWeight: numberOrNull(d.packingWeight),
      packageMaterials: d.packingNameEnSet || d.packingNameEn || [],
      productOptions: d.productKeyEn || d.productKeySet || [],
      logisticsAttributes: d.productProEnSet || d.productProEn || [],
      customsCode: d.entryCode || null,
      customsName: d.entryNameEn || null,
      videoIds: Array.isArray(d.productVideo) ? d.productVideo : (d.productVideo ? [d.productVideo] : []),
      specifications: d.productPropertyList || d.specifications || {},
      dimensions: [d.productLength, d.productWidth, d.productHeight].some(value => numberOrNull(value) != null)
        ? { length: numberOrNull(d.productLength), width: numberOrNull(d.productWidth), height: numberOrNull(d.productHeight) }
        : null,
      listedNum: d.listedNum ?? null,
    };

    const variantsPayload = variantsR.data && (variantsR.data.data || variantsR.data);
    const variantsRaw = variantsR.ok
      ? (Array.isArray(variantsPayload) ? variantsPayload : (variantsPayload && (variantsPayload.list || variantsPayload.content || variantsPayload.variants)) || [])
      : [];

    // CJ may return conflicting suggested-retail prices for the same variant:
    // /product/query can contain the real variantSugSellPrice while
    // /product/variant/query may echo variantSellPrice into variantSugSellPrice.
    // Reconcile both payloads by VID and prefer the product-detail suggestion
    // only when the variant endpoint's suggestion is missing or merely equals
    // its supplier sell price. This prevents supplier cost from becoming NOVA's
    // storefront regular price while still preserving a genuinely different
    // variant-endpoint suggestion when CJ supplies one.
    const detailVariantsRaw = Array.isArray(d.variants) ? d.variants : [];
    const detailVariantsById = new Map(detailVariantsRaw.map(v => [
      String(v && (v.vid || v.variantId) || ''),
      v,
    ]));
    const variants = variantsRaw.map(v => normalizeVariant(reconcileVariantPricing(
      v,
      detailVariantsById.get(String(v && (v.vid || v.variantId) || '')),
    )));

    await writeSyncLog({
      event: 'product.detail', objectId: pid, success: true,
      message: `${variants.length} variants`, tookMs,
    });

    return res.status(200).json({ ok: true, product, variants, variantsError: variantsR.ok ? null : variantsR.message });
  } catch (e) {
    await writeSyncLog({ event: 'product.detail', objectId: pid || vid, success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Product detail lookup failed.' });
  }
};

function reconcileVariantPricing(variant, detailVariant) {
  if (!variant || !detailVariant) return variant;

  const endpointSuggested = firstNumericOrNull(
    variant.variantSugSellPrice,
    variant.suggestSellPrice,
    variant.suggestedSellPrice,
  );
  const endpointSell = firstNumericOrNull(variant.variantSellPrice, variant.sellPrice);
  const detailSuggested = firstNumericOrNull(
    detailVariant.variantSugSellPrice,
    detailVariant.suggestSellPrice,
    detailVariant.suggestedSellPrice,
  );

  const endpointLooksLikeSupplierCost = endpointSuggested != null
    && endpointSell != null
    && Math.abs(endpointSuggested - endpointSell) < 1e-9;

  if (detailSuggested != null && (endpointSuggested == null || endpointLooksLikeSupplierCost)) {
    return { ...variant, variantSugSellPrice: detailSuggested };
  }
  return variant;
}

function normalizeVariant(v) {
  if (!v) return null;
  return {
    vid: v.vid || v.variantId,
    pid: v.pid || v.productId || null,
    sku: v.variantSku || v.sku,
    name: v.variantNameEn || v.variantKey || v.name || '',
    image: v.variantImage || v.image || null,
    sellPrice: firstNumericOrNull(v.variantSellPrice, v.sellPrice),
    weight: numberOrNull(v.variantWeight),
    length: numberOrNull(v.variantLength),
    width: numberOrNull(v.variantWidth),
    height: numberOrNull(v.variantHeight),
    barcode: v.barcode || null,
    unit: v.variantUnit || null,
    standard: v.variantStandard || null,
    suggestedSellPrice: firstNumericOrNull(v.variantSugSellPrice, v.suggestSellPrice, v.suggestedSellPrice),
    sellPriceCurrency: String(v.variantCurrency || v.variantSellPriceCurrency || v.sellPriceCurrency || v.currencyCode || v.priceCurrency || v.currency || ''),
    sourceData: v,
    inventories: Array.isArray(v.inventories) ? v.inventories : [],
    // e.g. "Black-128GB" — the human-readable option combination
    variantKey: v.variantKey || v.variantNameEn || null,
  };
}

function normalizeImages(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
  return [...new Set(values.map(item => typeof item === 'string' ? item : item && (item.url || item.imageUrl || item.img)).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url.trim())).map(url => url.trim()))];
}
function firstNumericOrNull(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function numberOrNull(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // CJ sometimes includes a currency symbol or thousands separators in price fields.
  // Accept one unambiguous number; ranges/multiple numbers stay blank for review.
  const matches = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length !== 1) return null;
  const n = Number(matches[0]);
  return Number.isFinite(n) ? n : null;
}
