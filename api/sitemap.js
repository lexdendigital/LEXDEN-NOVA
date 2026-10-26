// GET /sitemap.xml  (also /api/sitemap)
//
// A LIVE sitemap built from the real catalog in Firestore on every request (cached
// for 10 minutes). Nothing to download or upload any more, and the demo products
// (p1..p8) / demo feed posts (fp1..fp3) can never appear in it.
//
// WHY ON THE RENDER HOST: Google only accepts sitemap URLs that live on the SAME
// host as the sitemap file. The product and feed pages are served by this server
// (/product/:id, /feed/:id), so the sitemap that lists them has to be served from
// here too — the old github.io sitemap listed onrender.com URLs, which Google ignores.
const { getCatalogDoc } = require('./_shared');
const { isIndexableCatalogProduct } = require('./product-page');

const BASE = (process.env.PUBLIC_API_URL || 'https://lexden-nova.onrender.com').replace(/\/+$/, '');
const TTL_MS = 10 * 60 * 1000;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildSitemapXml({ products = [], now = new Date() }) {
  const day = now.toISOString().slice(0, 10);
  const urls = [];
  for (const p of products) if (isIndexableCatalogProduct(p)) urls.push({ loc: `${BASE}/product/${encodeURIComponent(p.id)}`, freq: 'weekly', pri: '0.8' });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((u) => `  <url><loc>${xml(u.loc)}</loc><lastmod>${day}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')
    + '\n</urlset>\n';
}

let cache = { at: 0, body: '' };
async function handler(req, res) {
  try {
    if (!cache.body || Date.now() - cache.at > TTL_MS) {
      const prod = await getCatalogDoc('products');
      cache = {
        at: Date.now(),
        body: buildSitemapXml({ products: (prod && prod.list) || [] }),
      };
    }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(cache.body);
  } catch (e) {
    console.error('sitemap failed:', e && e.message);
    return res.status(500).type('text/plain').send('Sitemap temporarily unavailable.');
  }
}
function robots(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(`User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`);
}

module.exports = handler;
module.exports.buildSitemapXml = buildSitemapXml;
module.exports.robots = robots;
module.exports._reset = () => { cache = { at: 0, body: '' }; };
