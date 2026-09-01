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
    const product = {
      pid: d.pid || pid,
      name: d.productNameEn || d.nameEn || d.productName,
      description: d.description || d.productDescriptionEn || '',
      images: Array.isArray(d.productImageSet) ? d.productImageSet
        : Array.isArray(d.images) ? d.images
        : (d.productImage ? [d.productImage] : []),
      video: d.productVideo || d.video || null,
      categoryId: d.categoryId || null,
      categoryName: d.categoryName || null,
      weight: d.productWeight != null ? Number(d.productWeight) : null,
      sourceCountry: d.sourceCountry || 'CN',
      listedNum: d.listedNum || null,
    };

    const variantsRaw = variantsR.ok
      ? (Array.isArray(variantsR.data) ? variantsR.data : (variantsR.data && variantsR.data.list) || [])
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
    // e.g. "Black-128GB" — the human-readable option combination
    variantKey: v.variantKey || v.variantNameEn || null,
  };
}
