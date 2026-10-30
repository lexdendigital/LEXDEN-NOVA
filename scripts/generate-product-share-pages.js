#!/usr/bin/env node
'use strict';

// Builds crawler-readable GitHub Pages routes from the live Firestore catalog.
// The storefront is still a client-rendered SPA; social crawlers need a real
// static HTML file for every product URL because they do not run the SPA JS.
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT_DIR = path.join(ROOT, 'product');
const FIRESTORE_PROJECT = 'lexden-nova';
const FIRESTORE_URL = 'https://firestore.googleapis.com/v1/projects/' + FIRESTORE_PROJECT + '/databases/(default)/documents/catalog/products';
const PAGES_BASE = 'https://lexdendigital.github.io/LEXDEN-NOVA';
const RENDER_BASE = 'https://lexden-nova.onrender.com';
const APP_URL = PAGES_BASE + '/index.html';
const APP_NAME = 'LEXDEN NOVA';
const FALLBACK_IMAGE = 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=630&fit=crop';
const FALLBACK_DESCRIPTION = 'Discover products, digital courses and tools at LEXDEN NOVA.';
const GENERATOR_MARKER = 'LEXDEN NOVA catalog-generated preview';
// Demo items are marked with `demo: true` on the product itself. Real products
// such as the p1 and p3-p8 courses must never be hidden by a hard-coded ID list.
const DEMO_PRODUCT_IDS = new Set();
const SAFE_ROUTE_ID = /^[A-Za-z0-9._~-]+$/;

function firestoreValue(value) {
  if (value == null) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, 'integerValue')) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, 'doubleValue')) return value.doubleValue;
  if (Object.prototype.hasOwnProperty.call(value, 'booleanValue')) return value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'arrayValue')) return (value.arrayValue.values || []).map(firestoreValue);
  if (Object.prototype.hasOwnProperty.call(value, 'mapValue')) return firestoreFields(value.mapValue.fields || {});
  return null;
}

function firestoreFields(fields) {
  const output = {};
  for (const key of Object.keys(fields || {})) output[key] = firestoreValue(fields[key]);
  return output;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function plainText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(value, maxLength) {
  const raw = String(value || '');
  const paragraph = raw.split(/\n\s*\n/).map(function (part) { return part.trim(); }).find(Boolean) || raw.trim();
  const clean = plainText(paragraph);
  const limit = maxLength || 200;
  return clean.length > limit ? clean.slice(0, limit - 1).trim() + '…' : clean;
}

function productImage(product) {
  const galleryImage = Array.isArray(product.gallery)
    ? product.gallery.find(function (item) { return item && item.type !== 'video' && typeof item.url === 'string' && item.url.trim(); })
    : null;
  const candidates = [
    product.image,
    galleryImage && galleryImage.url,
    Array.isArray(product.images) ? product.images[0] : '',
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = new URL(candidate.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch (_) {
      // Skip malformed catalog image URLs; the next available image may be valid.
    }
  }
  return FALLBACK_IMAGE;
}

function socialImage(value) {
  try {
    const parsed = new URL(value || FALLBACK_IMAGE);
    if (parsed.hostname === 'res.cloudinary.com' && parsed.pathname.includes('/upload/')) {
      parsed.protocol = 'https:';
      parsed.pathname = parsed.pathname.replace('/upload/', '/upload/c_fill,w_1200,h_630,f_jpg,q_auto/');
    }
    return parsed.toString();
  } catch (_) {
    return FALLBACK_IMAGE;
  }
}

function getEligibleProducts(products) {
  const eligible = [];
  const seenRouteIds = new Set();

  for (const product of Array.isArray(products) ? products : []) {
    if (!product || product.id == null || !String(product.id).trim()) continue;
    const internalId = String(product.id).trim();
    if (DEMO_PRODUCT_IDS.has(internalId) || product.demo === true) continue;
    if (String(product.status || '').toLowerCase() === 'draft') continue;

    const routeId = String(product.shareId || internalId).trim();
    if (!SAFE_ROUTE_ID.test(routeId)) {
      throw new Error('Unsafe product share ID for product ' + internalId + ': ' + routeId);
    }
    if (seenRouteIds.has(routeId)) {
      throw new Error('Duplicate product share ID "' + routeId + '". Refusing to generate ambiguous preview pages.');
    }

    seenRouteIds.add(routeId);
    eligible.push({ product: product, routeId: routeId });
  }
  return eligible;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The price a shopper is charged: the sale price when it is a real discount.
function effectivePrice(product) {
  const price = positiveNumber(product.price);
  const sale = positiveNumber(product.salePrice);
  if (sale !== null && (price === null || sale < price)) return sale;
  return price;
}

function formatUsd(value) {
  return value === null ? '' : '$' + value.toFixed(2);
}

function descriptionParagraphs(value, maxParagraphs) {
  return String(value || '')
    .split(/\n\s*\n/)
    .map(function (part) { return plainText(part); })
    .filter(Boolean)
    .slice(0, maxParagraphs || 12);
}

function buildJsonLd(product, title, description, image, pageUrl) {
  const price = effectivePrice(product);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: title,
    description: description,
    image: [productImage(product)],
    url: pageUrl,
  };
  if (product.itemCode) data.sku = String(product.itemCode);
  if (product.category) data.category = String(product.category);
  if (product.seller) data.brand = { '@type': 'Brand', name: String(product.seller) };
  if (price !== null) {
    const outOfStock = product.physical && product.physical.stockStatus === 'out_of_stock';
    data.offers = {
      '@type': 'Offer',
      url: pageUrl,
      priceCurrency: 'USD',
      price: price.toFixed(2),
      availability: 'https://schema.org/' + (outOfStock ? 'OutOfStock' : 'InStock'),
    };
  }
  // Only publish ratings backed by at least one stored review.
  const rating = positiveNumber(product.rating);
  const reviews = positiveNumber(product.reviewCount);
  if (rating !== null && reviews !== null) {
    data.aggregateRating = { '@type': 'AggregateRating', ratingValue: String(rating), reviewCount: String(reviews) };
  }
  // Keep the JSON safe inside a <script> element.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function renderProductPreview(product, routeId) {
  const title = plainText(product.seoTitle || product.name || APP_NAME) || APP_NAME;
  const description = firstParagraph(product.metaDescription || product.shortDescription || product.description, 200) || FALLBACK_DESCRIPTION;
  const image = socialImage(productImage(product));
  const pageUrl = PAGES_BASE + '/product/' + routeId + '/';
  // One canonical host: the page's own URL, not the Render API server.
  const canonicalUrl = pageUrl;
  const destination = '../../index.html#product/' + encodeURIComponent(routeId);
  const price = effectivePrice(product);
  const listPrice = positiveNumber(product.price);
  const paragraphs = descriptionParagraphs(product.description || product.shortDescription, 12);
  const specs = product.specs && typeof product.specs === 'object' ? Object.keys(product.specs) : [];
  const jsonLd = buildJsonLd(product, title, description, image, pageUrl);
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(description);
  const escapedImage = escapeHtml(image);
  const escapedPageUrl = escapeHtml(pageUrl);
  const escapedCanonicalUrl = escapeHtml(canonicalUrl);
  const escapedDestination = escapeHtml(destination);

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="generator" content="' + GENERATOR_MARKER + '">',
    '  <title>' + escapedTitle + ' | ' + APP_NAME + '</title>',
    '  <meta name="description" content="' + escapedDescription + '">',
    '  <link rel="canonical" href="' + escapedCanonicalUrl + '">',
    '  <meta property="og:type" content="product">',
    '  <meta property="og:locale" content="en_NG">',
    '  <meta property="og:site_name" content="' + APP_NAME + '">',
    '  <meta property="og:title" content="' + escapedTitle + '">',
    '  <meta property="og:description" content="' + escapedDescription + '">',
    '  <meta property="og:image" content="' + escapedImage + '">',
    '  <meta property="og:image:secure_url" content="' + escapedImage + '">',
    '  <meta property="og:image:width" content="1200">',
    '  <meta property="og:image:height" content="630">',
    '  <meta property="og:image:alt" content="' + escapedTitle + '">',
    '  <meta property="og:url" content="' + escapedPageUrl + '">',
    '  <meta name="twitter:card" content="summary_large_image">',
    '  <meta name="twitter:title" content="' + escapedTitle + '">',
    '  <meta name="twitter:description" content="' + escapedDescription + '">',
    '  <meta name="twitter:image" content="' + escapedImage + '">',
    '  <script type="application/ld+json">' + jsonLd + '</script>',
    '  <style>body{margin:0;background:#080b1c;color:#fff;font:16px/1.6 system-ui,sans-serif;padding:24px 16px;box-sizing:border-box}main{max-width:720px;margin:0 auto}img{max-width:100%;height:auto;border-radius:12px}a{color:#00d9ff}.price{font-size:1.5rem;font-weight:700}.was{opacity:.6;text-decoration:line-through;margin-left:8px}.cta{display:inline-block;margin:16px 0;padding:14px 24px;min-height:44px;box-sizing:border-box;background:#00d9ff;color:#080b1c;border-radius:10px;font-weight:700;text-decoration:none}table{border-collapse:collapse}th,td{text-align:left;padding:6px 12px 6px 0;vertical-align:top}</style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <nav aria-label="Site"><a href="../../index.html">&larr; ' + APP_NAME + '</a> &middot; <a href="../">All products</a> &middot; <a href="../../feed/">Feed</a> &middot; <a href="../../affiliate-program/">Affiliate programme</a></nav>',
    '    <h1>' + escapedTitle + '</h1>',
    '    <img src="' + escapedImage + '" alt="' + escapedTitle + '" width="1200" height="630">',
    price !== null
      ? '    <p class="price">' + escapeHtml(formatUsd(price)) + (listPrice !== null && listPrice > price ? '<span class="was">' + escapeHtml(formatUsd(listPrice)) + '</span>' : '') + '</p>'
      : '',
    '    <p><a class="cta" href="' + escapedDestination + '">View and buy on ' + APP_NAME + '</a></p>',
    paragraphs.map(function (text) { return '    <p>' + escapeHtml(text) + '</p>'; }).join('\n'),
    specs.length
      ? '    <h2>Details</h2>\n    <table>\n' + specs.map(function (key) {
        return '      <tr><th scope="row">' + escapeHtml(key) + '</th><td>' + escapeHtml(product.specs[key]) + '</td></tr>';
      }).join('\n') + '\n    </table>'
      : '',
    '  </main>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

async function fetchLiveProducts() {
  const response = await fetch(FIRESTORE_URL);
  if (!response.ok) throw new Error('Could not read live Firestore catalog: HTTP ' + response.status);
  const document = await response.json();
  if (!document || !document.fields || !document.fields.list) {
    throw new Error('Live catalog document has no list field; leaving existing preview pages untouched.');
  }
  const products = firestoreValue(document.fields.list);
  if (!Array.isArray(products)) throw new Error('Live catalog list is not an array; refusing to modify preview pages.');
  return products;
}

async function writeIfChanged(filePath, content) {
  let current = '';
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (current === content) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

async function removeStaleGeneratedPages(activeRouteIds) {
  let entries = [];
  try {
    entries = await fs.readdir(PRODUCT_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || activeRouteIds.has(entry.name)) continue;
    const directory = path.join(PRODUCT_DIR, entry.name);
    const indexPath = path.join(directory, 'index.html');
    try {
      const html = await fs.readFile(indexPath, 'utf8');
      if (!html.includes(GENERATOR_MARKER)) continue;
      await fs.rm(directory, { recursive: true, force: true });
      removed++;
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return removed;
}

async function main() {
  const products = await fetchLiveProducts();
  const entries = getEligibleProducts(products);
  if (entries.length === 0) {
    throw new Error('No eligible products found; refusing to remove existing preview pages.');
  }

  await fs.mkdir(PRODUCT_DIR, { recursive: true });
  const activeRouteIds = new Set(entries.map(function (entry) { return entry.routeId; }));
  let updated = 0;

  for (const entry of entries) {
    const filePath = path.join(PRODUCT_DIR, entry.routeId, 'index.html');
    const html = renderProductPreview(entry.product, entry.routeId);
    if (await writeIfChanged(filePath, html)) updated++;
  }

  const removed = await removeStaleGeneratedPages(activeRouteIds);
  console.log('Product preview sync complete: ' + entries.length + ' published/non-draft products, ' + updated + ' pages created or updated, ' + removed + ' stale generated pages removed.');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  PAGES_BASE,
  APP_NAME,
  GENERATOR_MARKER,
  FIRESTORE_URL,
  firestoreValue,
  escapeHtml,
  plainText,
  productImage,
  effectivePrice,
  formatUsd,
  fetchLiveProducts,
  DEMO_PRODUCT_IDS,
  getEligibleProducts,
  renderProductPreview,
  firstParagraph,
  socialImage,
};
