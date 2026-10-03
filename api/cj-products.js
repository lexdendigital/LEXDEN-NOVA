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
const { normalizeSearchPayload } = require('./cj-normalize');

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
        // listV2 uses its own parameter names (page/size/keyWord). The
        // pageNum/pageSize/productNameEn names belong to the deprecated
        // /product/list endpoint and are silently ignored by listV2.
        page,
        size: pageSize,
        keyWord: keyword || undefined,
        categoryId,
        countryCode,
        features: ['enable_description', 'enable_category', 'enable_video'],
      },
    });

    const tookMs = Date.now() - started;
    if (!r.ok) {
      await writeSyncLog({ event: 'products.search', success: false, message: r.message, tookMs, detail: { keyword, categoryId } });
      return res.status(200).json({ ok: false, error: r.message });
    }

    // listV2 returns data.content[] groups, and each group contains a
    // productList[]. Mapping the group itself caused successful searches
    // to return "results" with nearly every product field null.
    const payload = r.data && (r.data.data || r.data);
    const { products, rawCount } = normalizeSearchPayload(payload);

    const invalidRows = products.filter(p => !p.pid || !p.name).length;
    await writeSyncLog({ event: 'products.search', success: true, message: `${products.length} results${invalidRows ? `; ${invalidRows} incomplete` : ''}`, tookMs, detail: { keyword, categoryId, page, rawCount, invalidRows } });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({
      ok: true,
      page,
      pageSize,
      total: (payload && (payload.totalRecords || payload.total || payload.totalCount)) || products.length,
      products,
    });
  } catch (e) {
    await writeSyncLog({ event: 'products.search', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Product search failed.' });
  }
};
