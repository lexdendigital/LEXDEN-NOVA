'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getEligibleProducts,
  renderProductPreview,
  firstParagraph,
  socialImage,
} = require('../scripts/generate-product-share-pages');

test('only live non-demo products become share preview routes', () => {
  const products = [
    { id: 'p1', name: 'Demo course', status: 'published' },
    { id: 'draft-1', name: 'Draft item', status: 'draft' },
    { id: 'cj-internal-1', shareId: 'p13', name: 'Crossbody bag', status: 'published' },
    { id: 'cj-internal-2', name: 'Charger', status: 'published' },
  ];
  const routes = getEligibleProducts(products);
  assert.deepEqual(routes.map((entry) => entry.routeId), ['p13', 'cj-internal-2']);
});

test('duplicate public share IDs fail instead of generating ambiguous previews', () => {
  assert.throws(
    () => getEligibleProducts([
      { id: 'internal-1', shareId: 'p99', status: 'published' },
      { id: 'internal-2', shareId: 'p99', status: 'published' },
    ]),
    /Duplicate product share ID "p99"/,
  );
});

test('product preview includes correct metadata, image and app destination', () => {
  const html = renderProductPreview({
    id: 'cj-power-bank',
    shareId: 'p2',
    name: 'Power Bank "Ultra"',
    metaDescription: '  Slim & useful power bank.  ',
    image: 'https://cf.cjdropshipping.com/power-bank.jpg',
  }, 'p2');

  assert.match(html, /og:type" content="product"/);
  assert.match(html, /og:locale" content="en_NG"/);
  assert.match(html, /og:title" content="Power Bank &quot;Ultra&quot;"/);
  assert.match(html, /og:description" content="Slim &amp; useful power bank\."/);
  assert.match(html, /og:image" content="https:\/\/cf\.cjdropshipping\.com\/power-bank\.jpg"/);
  assert.match(html, /product\/p2\//);
  assert.match(html, /index\.html#product\/p2/);
  assert.match(html, /LEXDEN NOVA catalog-generated preview/);
});

test('first paragraph is reduced to plain, bounded metadata text', () => {
  assert.equal(firstParagraph('First <strong>paragraph</strong>.\n\nSecond paragraph.', 100), 'First paragraph .');
  assert.ok(firstParagraph('x'.repeat(250), 200).length <= 200);
});

test('Cloudinary social previews use a crawler-friendly 1200x630 JPEG transform', () => {
  assert.equal(
    socialImage('https://res.cloudinary.com/example/image/upload/v1/catalog/item.webp'),
    'https://res.cloudinary.com/example/image/upload/c_fill,w_1200,h_630,f_jpg,q_auto/v1/catalog/item.webp',
  );
});
