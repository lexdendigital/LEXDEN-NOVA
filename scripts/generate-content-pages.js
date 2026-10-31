#!/usr/bin/env node
'use strict';

// Builds the crawlable pages that make everything on the site findable in search:
//   feed/<id>/index.html   one page per feed post (full text, Article data)
//   feed/index.html        browsable list of every post, newest first
//   product/index.html     browsable list of every product
//   affiliate-program/     public explanation of the affiliate programme, with the
//                          commission and payout figures read from live settings
// Run by .github/workflows/sync-product-share-pages.yml before the sitemap is built.
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  PAGES_BASE, APP_NAME, GENERATOR_MARKER, FIRESTORE_URL, firestoreValue,
  escapeHtml, plainText, productImage, effectivePrice, formatUsd,
  fetchLiveProducts, getEligibleProducts, firstParagraph, socialImage,
} = require('./generate-product-share-pages');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_URL = FIRESTORE_URL.replace(/\/products$/, '/settings');
const SAFE_ID = /^[A-Za-z0-9._~-]+$/;

async function fetchSettings() {
  const response = await fetch(SETTINGS_URL);
  if (!response.ok) throw new Error('Could not read live settings: HTTP ' + response.status);
  const doc = await response.json();
  if (!doc || !doc.fields) throw new Error('Live settings document has no fields; leaving existing pages untouched.');
  const fields = {};
  for (const key of Object.keys(doc.fields)) fields[key] = firestoreValue(doc.fields[key]);
  return fields;
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
}

function paragraphsHtml(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map(function (part) { return part.trim(); })
    .filter(Boolean)
    .map(function (part) { return '    <p>' + part.split('\n').map(function (line) { return escapeHtml(line.trim()); }).join('<br>\n    ') + '</p>'; })
    .join('\n');
}

const STYLE = '<style>body{margin:0;background:#080b1c;color:#fff;font:16px/1.65 system-ui,sans-serif;padding:24px 16px;box-sizing:border-box}main{max-width:720px;margin:0 auto}nav a{margin-right:14px}img{max-width:100%;height:auto;border-radius:12px;margin:8px 0}a{color:#00d9ff}h1{line-height:1.25}.meta{opacity:.7;font-size:.9rem}.cta{display:inline-block;margin:16px 0;padding:14px 24px;min-height:44px;box-sizing:border-box;background:#00d9ff;color:#080b1c;border-radius:10px;font-weight:700;text-decoration:none}ul{padding-left:20px}li{margin:6px 0}</style>';

function nav(depth) {
  const up = depth ? '../'.repeat(depth) : './';
  return '    <nav aria-label="Site"><a href="' + up + 'index.html">' + APP_NAME + '</a><a href="' + up + 'product/">Products</a><a href="' + up + 'feed/">Feed</a><a href="' + up + 'affiliate-program/">Affiliate programme</a><a href="' + up + 'legal/">Legal</a></nav>';
}

function shell(opts) {
  const url = PAGES_BASE + opts.route;
  const image = opts.image ? socialImage(opts.image) : PAGES_BASE + '/assets/og-home.png';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="generator" content="' + GENERATOR_MARKER + '">',
    '  <title>' + escapeHtml(opts.title) + ' | ' + APP_NAME + '</title>',
    '  <meta name="description" content="' + escapeHtml(opts.description) + '">',
    '  <meta name="robots" content="index, follow, max-image-preview:large">',
    '  <link rel="canonical" href="' + escapeHtml(url) + '">',
    '  <meta property="og:type" content="' + (opts.ogType || 'website') + '">',
    '  <meta property="og:locale" content="en_NG">',
    '  <meta property="og:site_name" content="' + APP_NAME + '">',
    '  <meta property="og:title" content="' + escapeHtml(opts.title) + '">',
    '  <meta property="og:description" content="' + escapeHtml(opts.description) + '">',
    '  <meta property="og:url" content="' + escapeHtml(url) + '">',
    image ? '  <meta property="og:image" content="' + escapeHtml(image) + '">' : '',
    '  <meta name="twitter:card" content="' + (image ? 'summary_large_image' : 'summary') + '">',
    opts.jsonLd ? '  <script type="application/ld+json">' + JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c') + '</script>' : '',
    '  ' + STYLE,
    '</head>',
    '<body>',
    '  <main>',
    nav(opts.depth),
    opts.body,
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].filter(function (line) { return line !== ''; }).join('\n') + '\n';
}

function renderFeedPost(post, productRoute) {
  const title = plainText(post.title) || 'Update';
  const description = firstParagraph(post.body, 200) || 'An update from ' + APP_NAME + '.';
  const date = isoDate(post.date);
  const images = (Array.isArray(post.media) ? post.media : [])
    .filter(function (m) { return m && m.type !== 'video' && typeof m.url === 'string' && /^https?:\/\//.test(m.url); })
    .slice(0, 3);
  const route = '/feed/' + encodeURIComponent(post.id) + '/';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title.slice(0, 110),
    description: description,
    mainEntityOfPage: PAGES_BASE + route,
    author: { '@type': 'Organization', name: APP_NAME },
    publisher: { '@type': 'Organization', name: APP_NAME },
  };
  if (date) { jsonLd.datePublished = date; jsonLd.dateModified = date; }
  if (images.length) jsonLd.image = images.map(function (m) { return m.url; });
  const body = [
    '    <article>',
    '    <h1>' + escapeHtml(title) + '</h1>',
    date ? '    <p class="meta">Published <time datetime="' + date + '">' + date + '</time></p>' : '',
    images.map(function (m, i) { return '    <img src="' + escapeHtml(m.url) + '" alt="' + escapeHtml(title + (images.length > 1 ? ' (' + (i + 1) + ')' : '')) + '" loading="' + (i ? 'lazy' : 'eager') + '">'; }).join('\n'),
    paragraphsHtml(post.body),
    productRoute ? '    <p><a class="cta" href="../../product/' + encodeURIComponent(productRoute) + '/">See the product mentioned</a></p>' : '',
    '    <p><a href="../../index.html#feed/' + encodeURIComponent(post.id) + '">Open this post in ' + APP_NAME + '</a> &middot; <a href="./../">All posts</a></p>',
    '    </article>',
  ].filter(Boolean).join('\n');
  return shell({ title: title, description: description, route: route, image: images[0] && images[0].url, ogType: 'article', jsonLd: jsonLd, body: body, depth: 2 });
}

function renderFeedIndex(posts) {
  const sorted = posts.slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
  const body = [
    '    <h1>' + APP_NAME + ' feed: guides, tips and product news</h1>',
    '    <p>Practical posts on earning online, learning digital skills and choosing useful products. Newest first.</p>',
    '    <ul>',
    sorted.map(function (p) {
      return '      <li><a href="./' + encodeURIComponent(p.id) + '/">' + escapeHtml(plainText(p.title)) + '</a>' + (isoDate(p.date) ? ' <span class="meta">' + isoDate(p.date) + '</span>' : '') + '</li>';
    }).join('\n'),
    '    </ul>',
  ].join('\n');
  return shell({
    title: 'Feed: guides, tips and product news',
    description: 'Guides and updates from ' + APP_NAME + ' on earning online, learning digital skills and finding useful products.',
    route: '/feed/', body: body, depth: 1,
    jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: APP_NAME + ' feed', url: PAGES_BASE + '/feed/' },
  });
}

function renderProductIndex(entries) {
  const body = [
    '    <h1>' + APP_NAME + ' products: courses, tools and more</h1>',
    '    <p>Every product currently listed on ' + APP_NAME + '. Open one for the full description, price and details.</p>',
    '    <ul>',
    entries.map(function (entry) {
      const p = entry.product;
      const price = effectivePrice(p);
      return '      <li><a href="./' + encodeURIComponent(entry.routeId) + '/">' + escapeHtml(plainText(p.name || entry.routeId)) + '</a>' + (price !== null ? ' &mdash; ' + escapeHtml(formatUsd(price)) : '') + '</li>';
    }).join('\n'),
    '    </ul>',
  ].join('\n');
  return shell({
    title: 'Products: courses, tools and more',
    description: 'Browse every course, tool and product listed on ' + APP_NAME + ', each with a clear description, price and seller.',
    route: '/product/', body: body, depth: 1,
    jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: APP_NAME + ' products', url: PAGES_BASE + '/product/' },
  });
}

function renderAffiliateProgramme(content) {
  const pct = Number(content.affiliateCommissionDefaultPct);
  const minWd = Number(content.affiliateMinWithdrawalNGN);
  const wdFee = Number(content.affiliateWithdrawalFeePct);
  const facts = [];
  if (Number.isFinite(pct) && pct > 0) facts.push('The standard commission is ' + pct + '% of the sale value. Individual products can set a different rate, shown in your affiliate dashboard.');
  if (Number.isFinite(minWd) && minWd > 0) facts.push('The minimum withdrawal is ₦' + minWd.toLocaleString('en-NG') + '.');
  if (Number.isFinite(wdFee) && wdFee >= 0) facts.push('A withdrawal fee of ' + wdFee + '% applies when you cash out.');
  const body = [
    '    <h1>' + APP_NAME + ' Affiliate Programme: earn commission by sharing products</h1>',
    '    <p>The Nova Affiliate Programme lets you earn a commission when someone buys a ' + APP_NAME + ' product through your personal link. You do not need to create a product, hold stock or deliver anything.</p>',
    '    <h2>How it works</h2>',
    '    <ol>',
    '      <li>Create your affiliate account.</li>',
    '      <li>Copy your personal link for any product or for the whole store.</li>',
    '      <li>Share it on WhatsApp, social media or anywhere your audience is.</li>',
    '      <li>When a customer buys through your link, the commission is recorded in your dashboard.</li>',
    '      <li>Request a withdrawal to your bank account when you reach the minimum.</li>',
    '    </ol>',
    facts.length ? '    <h2>Rates and payouts</h2>\n    <ul>\n' + facts.map(function (f) { return '      <li>' + escapeHtml(f) + '</li>'; }).join('\n') + '\n    </ul>' : '',
    '    <p><a class="cta" href="../affiliate/index.html">Join the Nova Affiliate Programme</a></p>',
    '    <p>Read the full <a href="../legal/affiliate.html">Affiliate Program Terms</a> before you join.</p>',
  ].filter(Boolean).join('\n');
  return shell({
    title: 'Affiliate Programme: earn commission sharing products',
    description: 'Join the ' + APP_NAME + ' Nova Affiliate Programme: share your link, earn commission when people buy, and withdraw to your bank account.',
    route: '/affiliate-program/', body: body, depth: 1,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: APP_NAME + ' Affiliate Programme', url: PAGES_BASE + '/affiliate-program/' },
  });
}

async function writeIfChanged(filePath, content) {
  let current = '';
  try { current = await fs.readFile(filePath, 'utf8'); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  if (current === content) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

async function removeStaleFeedPages(activeIds) {
  const dir = path.join(ROOT, 'feed');
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error && error.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || activeIds.has(entry.name)) continue;
    const indexPath = path.join(dir, entry.name, 'index.html');
    try {
      const html = await fs.readFile(indexPath, 'utf8');
      if (!html.includes(GENERATOR_MARKER)) continue;
      await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
      removed++;
    } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }
  return removed;
}

// Pure builder, used by main() and by the tests.
function buildContentPages(products, settings) {
  const entries = getEligibleProducts(products);
  const routeByInternalId = new Map(entries.map(function (e) { return [String(e.product.id), e.routeId]; }));
  const feed = (Array.isArray(settings.feed) ? settings.feed : []).filter(function (p) {
    return p && p.id != null && SAFE_ID.test(String(p.id)) && p.demo !== true && plainText(p.title) && plainText(p.body);
  });
  const files = new Map();
  for (const post of feed) {
    files.set('feed/' + post.id + '/index.html', renderFeedPost(post, post.productId ? routeByInternalId.get(String(post.productId)) : ''));
  }
  files.set('feed/index.html', renderFeedIndex(feed));
  files.set('product/index.html', renderProductIndex(entries));
  files.set('affiliate-program/index.html', renderAffiliateProgramme((settings && settings.content) || {}));
  return { files: files, feedIds: new Set(feed.map(function (p) { return String(p.id); })) };
}

async function main() {
  const [products, settings] = await Promise.all([fetchLiveProducts(), fetchSettings()]);
  if (!Array.isArray(settings.feed)) throw new Error('Live settings has no feed list; refusing to modify pages.');
  const built = buildContentPages(products, settings);
  let updated = 0;
  for (const [relPath, html] of built.files) if (await writeIfChanged(path.join(ROOT, relPath), html)) updated++;
  const removed = await removeStaleFeedPages(built.feedIds);
  console.log('Content pages sync complete: ' + built.files.size + ' pages, ' + updated + ' created or updated, ' + removed + ' stale feed pages removed.');
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { buildContentPages, renderFeedPost, renderAffiliateProgramme, renderProductIndex, renderFeedIndex };
