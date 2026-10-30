#!/usr/bin/env node
'use strict';

// Writes sitemap.xml for the public site. Run by
// .github/workflows/sync-product-share-pages.yml right after the product pages
// are generated, so the sitemap and the pages always agree.
//
// Rules that matter for Google:
//  * One host only. Every URL is on the same host and path prefix as the
//    sitemap itself (https://lexdendigital.github.io/LEXDEN-NOVA/).
//  * Only pages that exist as real files. Product URLs come from the same
//    eligibility rule as the page generator, so a URL is never listed
//    without a page behind it.
//  * Nothing noindex, nothing behind a #fragment (Google ignores fragments),
//    no admin/creator/rider tools.
//  * No <lastmod>, <changefreq> or <priority>. Google ignores the last two,
//    and a lastmod that is not the real change date is treated as noise.
const fs = require('node:fs');
const path = require('node:path');
const { PAGES_BASE, fetchLiveProducts, getEligibleProducts } = require('./generate-product-share-pages');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  'admin', 'api', 'assets', 'chatgpt', 'css', 'download', 'js', 'mcp', 'node_modules',
  'policies', 'product', 'scripts', 'test', 'creator', 'rider',
]);

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isNoindex(html) {
  return /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

// Static pages that are real, indexable files in the repo.
function collectStaticPages(root) {
  const urls = [PAGES_BASE + '/index.html'];
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (rel === '' && SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') || rel.split('/').length >= 2) continue;
        stack.push({ dir: path.join(dir, entry.name), rel: rel ? rel + '/' + entry.name : entry.name });
        continue;
      }
      if (rel === '' || !entry.name.endsWith('.html')) continue;
      if (isNoindex(fs.readFileSync(path.join(dir, entry.name), 'utf8'))) continue;
      const parts = rel.split('/').map(encodeURIComponent);
      urls.push(entry.name === 'index.html'
        ? PAGES_BASE + '/' + parts.join('/') + '/'
        : PAGES_BASE + '/' + parts.join('/') + '/' + encodeURIComponent(entry.name));
    }
  }
  return urls;
}

function productUrls(products) {
  return getEligibleProducts(products).map(function (entry) {
    return PAGES_BASE + '/product/' + encodeURIComponent(entry.routeId) + '/';
  });
}

function buildSitemapXml(urls) {
  const unique = Array.from(new Set(urls)).sort();
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + unique.map(function (loc) { return '  <url><loc>' + escapeXml(loc) + '</loc></url>'; }).join('\n')
    + '\n</urlset>\n';
}

async function main() {
  const products = await fetchLiveProducts();
  const urls = collectStaticPages(ROOT).concat(productUrls(products));
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), buildSitemapXml(urls), 'utf8');
  console.log('sitemap.xml written with ' + new Set(urls).size + ' URLs.');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { buildSitemapXml, collectStaticPages, productUrls, isNoindex };
