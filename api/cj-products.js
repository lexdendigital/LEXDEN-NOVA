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

    const raw = (r.data && (r.data.list || r.data.content || r.data.data)) || [];
    const products = raw.map(p => ({
      pid: p.pid || p.productId || p.id,
      name: p.productNameEn || p.nameEn || p.productName || p.name,
      image: p.productImage || p.bigImage || p.image,
      sku: p.productSku || p.sku,
      sellPrice: p.sellPrice != null ? Number(p.sellPrice) : (p.price != null ? Number(p.price) : null),
      variantCount: p.variantNum || p.variantCount || null,
      categoryId: p.categoryId || null,
      supplierName: p.supplierName || 'CJ Dropshipping',
    }));

    await writeSyncLog({ event: 'products.search', success: true, message: `${products.length} results`, tookMs, detail: { keyword, categoryId, page } });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({
      ok: true,
      page,
      pageSize,
      total: (r.data && (r.data.total || r.data.totalCount)) || products.length,
      products,
    });
  } catch (e) {
    await writeSyncLog({ event: 'products.search', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Product search failed.' });
  }
};
