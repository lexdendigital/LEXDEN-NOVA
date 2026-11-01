#!/usr/bin/env node
'use strict';

// Writes catalog.json and llms.txt: a plain, machine-readable copy of the public
// catalogue for search engines and AI assistants. It uses the same eligibility
// rule as the product pages, so every entry has a real page behind it.
const fs = require('node:fs');
const path = require('node:path');
const {
  PAGES_BASE, APP_NAME, fetchLiveProducts, getEligibleProducts,
  effectivePrice, productImage, plainText, firstParagraph,
} = require('./generate-product-share-pages');

const ROOT = path.resolve(__dirname, '..');

function buildCatalog(products) {
  const items = getEligibleProducts(products).map(function (entry) {
    const p = entry.product;
    const price = effectivePrice(p);
    return {
      id: entry.routeId,
      name: plainText(p.name),
      description: firstParagraph(p.metaDescription || p.description, 300),
      type: String(p.productType || 'DIGITAL').toLowerCase(),
      category: plainText(p.categoryName || p.category || ''),
      seller: plainText(p.seller || APP_NAME),
      price: price === null ? null : Number(price.toFixed(2)),
      currency: 'USD',
      availability: p.outOfStock === true ? 'OutOfStock' : 'InStock',
      url: PAGES_BASE + '/product/' + entry.routeId + '/',
      image: productImage(p) || null,
    };
  }).sort(function (a, b) { return a.id.localeCompare(b.id, 'en', { numeric: true }); });
  return { name: APP_NAME, site: PAGES_BASE + '/', productCount: items.length, products: items };
}

function buildLlmsTxt(catalog) {
  const lines = [
    '# ' + APP_NAME,
    '',
    '> A marketplace for digital products, courses, services and selected physical products, with an affiliate programme.',
    '',
    '## Key pages',
    '- [Home](' + PAGES_BASE + '/index.html)',
    '- [All products](' + PAGES_BASE + '/product/)',
    '- [Feed](' + PAGES_BASE + '/feed/)',
    '- [Affiliate programme](' + PAGES_BASE + '/affiliate-program/)',
    '- [Machine-readable catalogue (JSON)](' + PAGES_BASE + '/catalog.json)',
    '- Live read-only API: https://lexden-nova.onrender.com/api/catalog (search with ?q=, filter with ?type=)',
    '- Read-only MCP server (no sign-in, no purchase tools): https://lexden-nova.onrender.com/mcp/public',
    '',
    '## Products',
  ];
  catalog.products.forEach(function (p) {
    const price = p.price === null ? '' : ' (USD ' + p.price.toFixed(2) + ')';
    lines.push('- [' + p.name + '](' + p.url + ')' + price + (p.description ? ': ' + p.description : ''));
  });
  return lines.join('\n') + '\n';
}

async function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* new file */ }
  if (old === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

async function main() {
  const catalog = buildCatalog(await fetchLiveProducts());
  if (!catalog.products.length) throw new Error('Catalogue is empty; refusing to overwrite catalog.json.');
  const a = await writeIfChanged(path.join(ROOT, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const b = await writeIfChanged(path.join(ROOT, 'llms.txt'), buildLlmsTxt(catalog));
  console.log('Catalogue: ' + catalog.productCount + ' products; catalog.json ' + (a ? 'updated' : 'unchanged') + ', llms.txt ' + (b ? 'updated' : 'unchanged') + '.');
}

if (require.main === module) {
  main().catch(function (error) { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; });
}

module.exports = { buildCatalog, buildLlmsTxt };
