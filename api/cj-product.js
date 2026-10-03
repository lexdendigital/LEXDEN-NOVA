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
      weight: d.productWeight != null ? Number(d.productWeight) : null,
      supplierName: d.supplierName || 'CJ Dropshipping',
      supplierId: d.supplierId || null,
      sku: d.productSku || d.sku || d.spu || null,
      sellPrice: numberOrNull(d.sellPrice ?? d.productSellPrice ?? d.price),
      suggestedSellPrice: d.suggestSellPrice || d.suggestedSellPrice || null,
      productType: d.productType || null,
      unit: d.productUnit || d.unit || null,
      sourceCountry: d.sourceCountry || 'CN',
      deliveryCycle: d.deliveryCycle || null,
      materials: d.materialNameEnSet || d.materialNameEn || d.materialName || [],
      packageWeight: d.packingWeight != null ? Number(d.packingWeight) : null,
      packageMaterials: d.packingNameEnSet || d.packingNameEn || [],
      productOptions: d.productKeyEn || d.productKeySet || [],
      logisticsAttributes: d.productProEnSet || d.productProEn || [],
      customsCode: d.entryCode || null,
      customsName: d.entryNameEn || null,
      videoIds: Array.isArray(d.productVideo) ? d.productVideo : (d.productVideo ? [d.productVideo] : []),
      specifications: d.productPropertyList || d.specifications || {},
      dimensions: d.productLength || d.productWidth || d.productHeight
        ? { length: d.productLength || null, width: d.productWidth || null, height: d.productHeight || null }
        : null,
      listedNum: d.listedNum || null,
    };

    const variantsPayload = variantsR.data && (variantsR.data.data || variantsR.data);
    const variantsRaw = variantsR.ok
      ? (Array.isArray(variantsPayload) ? variantsPayload : (variantsPayload && (variantsPayload.list || variantsPayload.content || variantsPayload.variants)) || [])
      : [];
    const variants = variantsRaw.map(normalizeVariant);

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

function normalizeVariant(v) {
  if (!v) return null;
  return {
    vid: v.vid || v.variantId,
    pid: v.pid || v.productId || null,
    sku: v.variantSku || v.sku,
    name: v.variantNameEn || v.variantKey || v.name || '',
    image: v.variantImage || v.image || null,
    sellPrice: v.variantSellPrice != null ? Number(v.variantSellPrice) : (v.sellPrice != null ? Number(v.sellPrice) : null),
    weight: v.variantWeight != null ? Number(v.variantWeight) : null,
    length: v.variantLength != null ? Number(v.variantLength) : null,
    width: v.variantWidth != null ? Number(v.variantWidth) : null,
    height: v.variantHeight != null ? Number(v.variantHeight) : null,
    barcode: v.barcode || null,
    unit: v.variantUnit || null,
    standard: v.variantStandard || null,
    suggestedSellPrice: v.variantSugSellPrice != null ? numberOrNull(v.variantSugSellPrice) : null,
    inventories: Array.isArray(v.inventories) ? v.inventories : [],
    // e.g. "Black-128GB" — the human-readable option combination
    variantKey: v.variantKey || v.variantNameEn || null,
  };
}

function normalizeImages(value) {
  const values = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
  return [...new Set(values.map(item => typeof item === 'string' ? item : item && (item.url || item.imageUrl || item.img)).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url.trim())).map(url => url.trim()))];
}
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
