// GET /api/catalog            -> the public catalogue (same fields as catalog.json), live
// GET /api/catalog?q=term     -> simple text search over name, description, category, seller
// GET /api/catalog?type=physical|digital|course&limit=20
// GET /api/catalog/<id>       -> one product (also /api/catalog?id=<id>)
//
// Read-only and public: it exposes only what product pages already show. Nothing here can
// buy, change or reserve anything. Results are cached for 60 seconds so AI agents and
// crawlers cannot turn into Firestore read load.
const { fetchLiveProducts } = require('../scripts/generate-product-share-pages');
const { buildCatalog } = require('../scripts/generate-catalog');

const TTL_MS = 60 * 1000;
let cache = { at: 0, catalog: null };

async function getCatalog(now) {
  if (cache.catalog && now - cache.at < TTL_MS) return cache.catalog;
  const catalog = buildCatalog(await fetchLiveProducts());
  cache = { at: now, catalog };
  return catalog;
}

function filterProducts(products, query) {
  let list = products;
  const type = String(query.type || '').toLowerCase();
  if (type) list = list.filter((p) => p.type === type);
  const q = String(query.q || '').toLowerCase().trim();
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = [p.name, p.description, p.category, p.seller].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  return list.slice(0, limit);
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // public, read-only, no credentials
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); return res.status(204).end(); }
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Read-only: use GET.' });
  try {
    const catalog = await getCatalog(Date.now());
    const idFromPath = (req.params && req.params.id) || (req.query && req.query.id);
    if (idFromPath) {
      const product = catalog.products.find((p) => p.id === String(idFromPath));
      if (!product) return res.status(404).json({ ok: false, error: 'No product with that id.' });
      return res.status(200).json({ ok: true, product });
    }
    const products = filterProducts(catalog.products, req.query || {});
    return res.status(200).json({ ok: true, name: catalog.name, site: catalog.site, count: products.length, products });
  } catch (e) {
    console.error('catalog api failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Catalogue temporarily unavailable.' });
  }
}

module.exports = handler;
module.exports.filterProducts = filterProducts;
