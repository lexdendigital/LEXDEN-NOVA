'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContentPages, renderAffiliateProgramme } = require('../scripts/generate-content-pages');

const BASE = 'https://lexdendigital.github.io/LEXDEN-NOVA';
const products = [
  { id: 'p1', name: 'Mobile App Course', price: 9.06, salePrice: 5.8, status: 'published' },
  { id: 'cj-internal', shareId: 'p9', name: 'Charger', price: 12, status: 'published' },
];
const settings = {
  content: { affiliateCommissionDefaultPct: 10, affiliateMinWithdrawalNGN: 5000, affiliateWithdrawalFeePct: 2.5 },
  feed: [
    { id: 'fp1', title: 'Old demo that is not valid', body: '' },
    {
      id: 'fp1792008100001', title: 'SELL YOUR FIRST DIGITAL PRODUCT IN 7 DAYS 🚀', date: '2026-10-14', productId: 'p1',
      body: 'You need a small problem & one week.\n\nDAY 1\nPick ONE problem.\n\nDAY 7 — Share it <b>now</b>',
      media: [{ type: 'image', url: 'https://res.cloudinary.com/z/image/upload/v1/a.png' }],
    },
    { id: 'bad id/../x', title: 'Unsafe', body: 'x' },
    { id: 'fp-demo', title: 'Hidden', body: 'x', demo: true },
  ],
};

test('one page per valid feed post; empty, unsafe and demo posts are skipped', () => {
  const { files, feedIds } = buildContentPages(products, settings);
  assert.deepEqual([...feedIds], ['fp1792008100001']);
  assert.ok(files.has('feed/fp1792008100001/index.html'));
  assert.ok(files.has('feed/index.html'));
  assert.ok(files.has('product/index.html'));
  assert.ok(files.has('affiliate-program/index.html'));
  assert.ok(![...files.keys()].some((k) => /demo|bad/.test(k)));
});

test('feed post page has full text, escaped HTML, Article data, canonical and product link', () => {
  const html = buildContentPages(products, settings).files.get('feed/fp1792008100001/index.html');
  assert.match(html, /<h1>SELL YOUR FIRST DIGITAL PRODUCT IN 7 DAYS 🚀<\/h1>/);
  assert.match(html, /small problem &amp; one week\./);
  assert.match(html, /DAY 1<br>\s*Pick ONE problem\./);
  assert.match(html, /Share it &lt;b&gt;now&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>now/);
  assert.match(html, new RegExp('rel="canonical" href="' + BASE + '/feed/fp1792008100001/"'));
  assert.match(html, /href="\.\.\/\.\.\/product\/p1\/"/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'Article');
  assert.equal(ld.datePublished, '2026-10-14');
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test('indexes list every product and post with working relative links', () => {
  const { files } = buildContentPages(products, settings);
  const productIndex = files.get('product/index.html');
  assert.match(productIndex, /href="\.\/p1\/">Mobile App Course<\/a> &mdash; \$5\.80/);
  assert.match(productIndex, /href="\.\/p9\/">Charger<\/a>/);
  assert.match(files.get('feed/index.html'), /href="\.\/fp1792008100001\/"/);
});

test('affiliate programme page takes its figures from live settings and links the join page and terms', () => {
  const html = renderAffiliateProgramme(settings.content);
  assert.match(html, /standard commission is 10%/);
  assert.match(html, /minimum withdrawal is ₦5,000/);
  assert.match(html, /withdrawal fee of 2\.5%/);
  assert.match(html, /href="\.\.\/affiliate\/index\.html"/);
  assert.match(html, /href="\.\.\/legal\/affiliate\.html"/);
  const none = renderAffiliateProgramme({});
  assert.doesNotMatch(none, /Rates and payouts/);
});
