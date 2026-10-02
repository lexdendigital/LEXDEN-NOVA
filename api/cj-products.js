// /api/cj-products.js
//
// LEXDEN NOVA × CJ — categories + product search/list, for the Admin
// "Import from CJ" screen (README §13). Read-only, cacheable, no secrets
// in the response.
//
// CONTRACT
// GET /api/cj-products?mode=categories
//   -> { ok:true, categories:[...] }
// GET /api/cj-products?mode=search&keyword=...&categoryId=...&page=1&pageSize=20&countryCode=NG
//   -> { ok:true, page, pageSize, total, products:[{pid,name,image,sku,sellPrice,...}] }

const { setCors, cjFetch, writeSyncLog } = require('./cj-shared');

// Categories change rarely — small in-memory cache per warm instance.
let categoryCache = null;
let categoryCacheAt = 0;
const CATEGORY_TTL_MS = 60 * 60 * 1000; // 1 hour

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const mode = String(req.query.mode || 'search');
  const started = Date.now();

  try {
    if (mode === 'categories') {
      if (categoryCache && Date.now() - categoryCacheAt < CATEGORY_TTL_MS) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.status(200).json({ ok: true, categories: categoryCache, cached: true });
      }
      const r = await cjFetch('/product/getCategory');
      if (!r.ok) {
        await writeSyncLog({ event: 'products.categories', success: false, message: r.message, tookMs: Date.now() - started });
        return res.status(200).json({ ok: false, error: r.message });
      }
      categoryCache = r.data;
      categoryCacheAt = Date.now();
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json({ ok: true, categories: r.data });
    }

    // ---- search / list ----
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const keyword = String(req.query.keyword || req.query.q || '').trim().slice(0, 100);
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : undefined;
    const countryCode = req.query.countryCode ? String(req.query.countryCode).toUpperCase() : undefined;

    const r = await cjFetch('/product/listV2', {
      query: {
        pageNum: page,
        pageSize,
        productNameEn: keyword || undefined,
        categoryId,
        countryCode,
      },
    });

    const tookMs = Date.now() - started;
    if (!r.ok) {
      await writeSyncLog({ event: 'products.search', success: false, message: r.message, tookMs, detail: { keyword, categoryId } });
      return res.status(200).json({ ok: false, error: r.message });
    }

    // ---- Extract the product list -----------------------------------------
    // CJ's /product/listV2 response shape is not always consistent across
    // account tiers, API versions, and country filters. We try every known
    // container key before falling back to an empty array so a shape change
    // never silently produces zero or stub results.
    let raw = [];
    if (r.data) {
      if (Array.isArray(r.data))              raw = r.data;              // data IS the list
      else if (Array.isArray(r.data.list))    raw = r.data.list;         // standard v2 shape
      else if (Array.isArray(r.data.content)) raw = r.data.content;      // Spring-page shape
      else if (Array.isArray(r.data.data))    raw = r.data.data;         // nested-data shape
      else if (Array.isArray(r.data.result))  raw = r.data.result;       // result-array shape
      else if (Array.isArray(r.data.products)) raw = r.data.products;    // labelled-products
    }

    // ---- Map CJ field names → our canonical shape -------------------------
    // CJ has changed field names between API versions and product types.
    // Each property tries every known alias so a rename on CJ's side doesn't
    // silently null out the whole catalog.
    const products = raw.map(p => ({
      pid:
        p.pid || p.productId || p.id || p.productSid || null,

      name:
        p.productNameEn || p.nameEn || p.productName ||
        p.name || p.title || p.productTitle || null,

      image:
        p.productImage || p.bigImage || p.image ||
        p.imageUrl || p.mainImage || p.thumbnail || null,

      sku:
        p.productSku || p.sku || p.skuCode || null,

      sellPrice:
        p.sellPrice  != null ? Number(p.sellPrice)  :
        p.price      != null ? Number(p.price)      :
        p.salePrice  != null ? Number(p.salePrice)  :
        p.retailPrice != null ? Number(p.retailPrice) : null,

      variantCount:
        p.variantNum   != null ? p.variantNum   :
        p.variantCount != null ? p.variantCount :
        p.skuNum       != null ? p.skuNum       :
        p.skuCount     != null ? p.skuCount     : null,

      categoryId:   p.categoryId   || null,
      supplierName: p.supplierName || 'CJ Dropshipping',
    }));

    // ---- Diagnostics -------------------------------------------------------
    // When results look thin (< 3), log the raw response shape so the next
    // sync-log check shows exactly which keys CJ returned — making any future
    // field-name mismatch immediately visible without needing a network tab.
    const syncDetail = { keyword, categoryId, page, rawCount: raw.length };
    if (products.length < 3 && r.data && typeof r.data === 'object') {
      syncDetail.dataKeys = Object.keys(r.data);
      if (raw.length > 0 && raw[0] && typeof raw[0] === 'object') {
        syncDetail.firstItemKeys = Object.keys(raw[0]);
      }
    }

    await writeSyncLog({ event: 'products.search', success: true, message: `${products.length} results`, tookMs, detail: syncDetail });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({
      ok: true,
      page,
      pageSize,
      total: (r.data && (r.data.total || r.data.totalCount || r.data.totalNum || r.data.count)) || products.length,
      products,
    });
  } catch (e) {
    await writeSyncLog({ event: 'products.search', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Product search failed.' });
  }
};
