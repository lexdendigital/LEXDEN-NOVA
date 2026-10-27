'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSitemapXml } = require('../api/sitemap');

test('sitemap lists real products and feed posts, never demo ids or drafts', () => {
  const x = buildSitemapXml({
    products: [{ id: 'p1' }, { id: 'p5' }, { id: 'real-1' }, { id: 'real-long-id', shareId: 'p2' }, { id: 'draft-1', status: 'draft' }, { id: 'a&b' }],
    feed: [{ id: 'fp1' }, { id: 'news-1' }],
    now: new Date('2026-10-17T10:00:00Z'),
  });
  assert.match(x, /\/product\/real-1</);
  assert.match(x, /\/product\/p2</);
  assert.match(x, /\/product\/a%26b</);
  assert.match(x, /\/feed\/news-1</);
  assert.ok(!/\/product\/p[1-8]</.test(x));
  assert.ok(!/fp1/.test(x));
  assert.ok(!/draft-1/.test(x));
  assert.match(x, /<lastmod>2026-10-17<\/lastmod>/);
  assert.match(x, /index\.html<\/loc>/);
});
