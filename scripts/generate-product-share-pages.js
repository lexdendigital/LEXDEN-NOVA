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
const DEMO_PRODUCT_IDS = new Set(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
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
    if (DEMO_PRODUCT_IDS.has(internalId)) continue;
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

function renderProductPreview(product, routeId) {
  const title = plainText(product.seoTitle || product.name || APP_NAME) || APP_NAME;
  const description = firstParagraph(product.metaDescription || product.shortDescription || product.description, 200) || FALLBACK_DESCRIPTION;
  const image = socialImage(productImage(product));
  const pageUrl = PAGES_BASE + '/product/' + routeId + '/';
  const canonicalUrl = RENDER_BASE + '/product/' + encodeURIComponent(routeId);
  const destination = '../../index.html#product/' + encodeURIComponent(routeId);
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
    '  <meta http-equiv="refresh" content="0; url=' + escapedDestination + '">',
    '  <script>window.location.replace(' + JSON.stringify(destination) + ');</script>',
    '  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b1c;color:#fff;font:16px/1.6 system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:520px;text-align:center}a{color:#00d9ff}</style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Opening ' + escapedTitle + '…</h1>',
    '    <p>If the product does not open automatically, <a href="' + escapedDestination + '">open it in LEXDEN NOVA</a>.</p>',
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
  DEMO_PRODUCT_IDS,
  getEligibleProducts,
  renderProductPreview,
  firstParagraph,
  socialImage,
};
