'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The app used to be one big index.html. It is now split (index.html + css/ + js/ + admin/ + creator/),
// so these checks read ALL of those files together, exactly as the old single file read.
const root = path.join(__dirname, '..');
const walk = (d, ext) => fs.existsSync(path.join(root, d)) ? fs.readdirSync(path.join(root, d)).filter(f => f.endsWith(ext)).sort().map(f => fs.readFileSync(path.join(root, d, f), 'utf8')) : [];
const html = [fs.readFileSync(path.join(root, 'index.html'), 'utf8'), ...walk('css', '.css'), ...walk('js', '.js'), ...walk('admin', '.js'), ...walk('creator', '.js')].join('\n');

test('affiliate partner disclosure is conditional on an absolute admin link', () => {
  assert.match(html, /function hasAdminAffiliateLink\(p\)/);
  assert.ok(html.includes("if(!/^https?:\\/\\//i.test(link)) return false;"));
  assert.match(html, /hasAdminAffiliateLink\(p\) \? '<div class="text-2 small">Verified affiliate partner<\/div>' : ''/);
});

test('first visit has a free resource entry point', () => {
  assert.match(html, /Start with something free/);
  assert.match(html, /Useful digital tools and learning resources are available at no cost/);
});

test('the free section only renders when free products exist, with no "being prepared" placeholder', () => {
  assert.match(html, /\$\{freeResources\.length \? `<div class="section" aria-labelledby="freeStartHeading">/);
  assert.ok(!html.includes('Free resources are being prepared'));
});

test('catalog separates digital, physical, and free discovery and searches product attributes', () => {
  assert.match(html, /function productSearchText\(p\)/);
  assert.match(html, /productKind\(p\)!=='physical'/);
  assert.match(html, /productKind\(p\)==='physical'/);
  assert.match(html, /if\(f\.kind==='free'\) list = list\.filter\(isFreeProduct\)/);
  assert.match(html, /id="kindChips"/);
  assert.match(html, /aria-label="Search the Lexden Nova catalog"/);
  assert.match(html, /p\.categoryId===f\.category \|\| p\.category===f\.category/);
});

test('product detail related items stay in the same category and product kind', () => {
  assert.match(html, /item\.categoryId === p\.categoryId && productKind\(item\) === productKind\(p\)/);
});

test('detail actions use category-specific labels including Install for apps', () => {
  assert.match(html, /if\(kind==='app'\) return 'Install'/);
  assert.match(html, /if\(kind==='course'\) return 'Start learning'/);
  assert.match(html, /if\(kind==='ebook'\)/);
  assert.match(html, /function productExperiencePanel\(p\)/);
  assert.match(html, /About this app/);
  assert.match(html, /Course overview/);
  assert.match(html, /Inside this eBook/);
});

test('variant editor, storefront selection, and checkout wiring preserve variant identity', () => {
  assert.match(html, /function buildVariantMatrix\(/);
  assert.match(html, /function readVariantMatrix\(/);
  assert.match(html, /function productVariantSelector\(p\)/);
  assert.match(html, /function selectProductOption\(/);
  assert.match(html, /selectedVariant&&selectedVariant\.id\|\|null/);
  assert.match(html, /productId: product\.id, productName: product\.name,[\s\S]{0,80}variantId/);
  assert.match(html, /variantId: variantId\|\|null/);
});

test('inline storefront scripts parse without syntax errors', () => {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  const executable = scripts.filter(([, attrs]) => !/\bsrc\s*=/.test(attrs) && !/application\/ld\+json/i.test(attrs) && !/\btype=["']module["']/i.test(attrs));
  assert.ok(executable.length > 0, 'expected inline storefront JavaScript');
  for (const [, attrs, source] of executable) assert.doesNotThrow(() => new Function(source), `script ${attrs || '(inline)'}`);
});
