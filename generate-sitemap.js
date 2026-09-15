#!/usr/bin/env node
// Regenerates sitemap.xml from the SAME live Firestore data the admin
// portal's "Sitemap" tab reads from — meant to be run by
// .github/workflows/update-sitemap.yml on every push, so sitemap.xml
// never goes stale even if nobody remembers to click "Download" by hand.
//
// Uses Firestore's public REST API (no service account, no secret keys —
// read access to `catalog/*` is intentionally public in firestore.rules,
// the same trusted pattern the app's own api/verify-paystack.js already
// relies on). Node 18+ has global fetch, which is all this needs.
//
// Keep the two constants below in sync with index.html if you ever
// rename the Firebase project or move the Vercel link-preview deploy.
const FIRESTORE_PROJECT = 'lexden-nova';
const SITE_URL = 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
const NOVA_LINKS_BASE = 'https://lexden-nova-links.vercel.app';

function fsValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
  if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
  return null;
}
function fsFields(fields) {
  const out = {};
  for (const k in fields || {}) out[k] = fsValue(fields[k]);
  return out;
}
async function getCatalogDoc(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/catalog/${docId}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Firestore fetch failed for catalog/${docId}: ${r.status}`);
  const data = await r.json();
  return fsFields(data.fields || {});
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function main() {
  const [productsDoc, settingsDoc] = await Promise.all([
    getCatalogDoc('products'),
    getCatalogDoc('settings'),
  ]);
  const products = Array.isArray(productsDoc.list) ? productsDoc.list : [];
  const feed = Array.isArray(settingsDoc.feed) ? settingsDoc.feed : [];
  const today = new Date().toISOString().slice(0, 10);

  // Mirrors buildSitemapEntries() in index.html — see the long comment
  // above that function for exactly why /service/{id}, /feed and
  // /contact are intentionally excluded (no real page exists for them).
  const urls = [
    { loc: SITE_URL, freq: 'daily', pri: '1.0' },
    { loc: SITE_URL + '#products', freq: 'daily', pri: '0.9' },
    ...products.filter(p => p && p.status !== 'draft').map(p => ({
      loc: `${NOVA_LINKS_BASE}/product/${p.id}`, freq: 'weekly', pri: '0.9',
    })),
    { loc: SITE_URL + '#service', freq: 'weekly', pri: '0.6' },
    ...feed.map(f => ({ loc: `${NOVA_LINKS_BASE}/feed/${f.id}`, freq: 'monthly', pri: '0.5' })),
    { loc: SITE_URL + '#about', freq: 'monthly', pri: '0.5' },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')
    + `\n</urlset>\n`;

  const fs = await import('node:fs/promises');
  await fs.writeFile('sitemap.xml', xml, 'utf8');
  console.log(`sitemap.xml written with ${urls.length} URLs.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
