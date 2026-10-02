'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('affiliate partner disclosure is conditional on an absolute admin link', () => {
  assert.match(html, /function hasAdminAffiliateLink\(p\)/);
  assert.ok(html.includes("if(!/^https?:\\/\\//i.test(link)) return false;"));
  assert.match(html, /hasAdminAffiliateLink\(p\) \? '<div class="text-2 small">Verified affiliate partner<\/div>' : ''/);
});

test('first visit has a free resource entry point', () => {
  assert.match(html, /Start with something free/);
  assert.match(html, /Useful digital tools and learning resources are available at no cost/);
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

test('inline storefront scripts parse without syntax errors', () => {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  const executable = scripts.filter(([, attrs]) => !/\bsrc\s*=/.test(attrs) && !/application\/ld\+json/i.test(attrs) && !/\btype=["']module["']/i.test(attrs));
  assert.ok(executable.length > 0, 'expected inline storefront JavaScript');
  for (const [, attrs, source] of executable) assert.doesNotThrow(() => new Function(source), `script ${attrs || '(inline)'}`);
});
