'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSitemapXml, collectStaticPages, productUrls, isNoindex } = require('../scripts/generate-sitemap');
const redirectHandler = require('../api/sitemap');

const BASE = 'https://lexdendigital.github.io/LEXDEN-NOVA';

test('product URLs: real courses included, demo flag and drafts excluded, one host, trailing slash', () => {
  const urls = productUrls([
    { id: 'p1' }, { id: 'p5' }, { id: 'demo-x', demo: true },
    { id: 'real-long-id', shareId: 'p2' }, { id: 'draft-1', status: 'draft' },
  ]);
  assert.deepEqual(urls, [
    BASE + '/product/p1/', BASE + '/product/p5/', BASE + '/product/p2/',
  ]);
});

test('sitemap XML is valid, deduplicated, escaped, and has no lastmod/changefreq/priority', () => {
  const x = buildSitemapXml([BASE + '/b/', BASE + '/a/', BASE + '/a/', BASE + '/q?x=1&y=2']);
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((x.match(/<loc>/g) || []).length, 3);
  assert.match(x, /q\?x=1&amp;y=2/);
  assert.ok(x.indexOf('/a/') < x.indexOf('/b/'));
  assert.doesNotMatch(x, /lastmod|changefreq|priority/);
});

test('static pages: only real indexable files on the Pages host, never tools or noindex pages', () => {
  const urls = collectStaticPages(path.resolve(__dirname, '..'));
  assert.ok(urls.includes(BASE + '/index.html'));
  assert.ok(urls.includes(BASE + '/affiliate/'));
  assert.ok(urls.includes(BASE + '/legal/'));
  assert.ok(urls.includes(BASE + '/legal/terms.html'));
  for (const url of urls) {
    assert.ok(url.startsWith(BASE + '/'), url);
    assert.ok(!url.includes('#'), url);
    assert.doesNotMatch(url, /\/(admin|creator|rider|api|product)\//);
    assert.doesNotMatch(url, /google|\(1\)/);
  }
});

test('noindex detection', () => {
  assert.equal(isNoindex('<meta name="robots" content="noindex, nofollow">'), true);
  assert.equal(isNoindex('<meta name="robots" content="index,follow">'), false);
});

test('Render sitemap route permanently redirects to the single Pages sitemap', () => {
  let status; let location; const headers = {};
  redirectHandler({}, { setHeader: (k, v) => { headers[k] = v; }, redirect: (s, l) => { status = s; location = l; } });
  assert.equal(status, 301);
  assert.equal(location, BASE + '/sitemap.xml');
});
