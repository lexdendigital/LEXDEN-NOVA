'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeProductImage, buildImagePath, appendProductImage, MAX_IMAGE_BYTES } = require('../mcp/lib/productImage');
const { appendCatalogProductMedia } = require('../mcp/lib/settings');

const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);

test('decodes supported generated image bytes and checks the data URI type', () => {
  const result = decodeProductImage(`data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(result.contentType, 'image/png');
  assert.deepEqual(result.buffer, PNG);
  assert.throws(() => decodeProductImage(`data:image/jpeg;base64,${PNG.toString('base64')}`), /does not match/);
});

test('rejects unsupported, malformed, and oversized generated image data', () => {
  assert.throws(() => decodeProductImage('https://example.com/photo.png'), /valid base64/);
  assert.throws(() => decodeProductImage(Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64')), /between 1 byte/);
  assert.throws(() => decodeProductImage(Buffer.from('not an image').toString('base64')), /valid PNG/);
});

test('scopes generated image object paths to safe product ids', () => {
  assert.equal(buildImagePath('sku_123', 'png', 'test-id'), 'products/sku_123/generated/test-id.png');
  assert.throws(() => buildImagePath('../secrets', 'png', 'test-id'), /existing product id/);
});

test('appends media without discarding existing gallery items and enforces the eight-item limit', () => {
  const product = { gallery: [{ url: 'https://old.example/a.jpg' }], images: ['https://old.example/a.jpg'] };
  const next = appendProductImage(product, 'https://storage.example/new.png', 'Illustrative app dashboard');
  assert.equal(next.gallery.length, 2);
  assert.deepEqual(next.gallery[1], { url: 'https://storage.example/new.png', type: 'image', alt: 'Illustrative app dashboard' });
  assert.equal(next.images.length, 2);
  assert.throws(() => appendProductImage({ gallery: Array(8).fill({ url: 'x' }) }, 'https://storage.example/new.png', 'A valid description'), /maximum of 8/);
});

test('catalog media transaction preserves concurrent product fields and updates both image representations', async () => {
  let stored = { list: [{ id: 'p-1', name: 'Keep me', gallery: [], tags: ['existing'] }] };
  const ref = { path: 'catalog/products' };
  const db = {
    doc: () => ref,
    runTransaction: async (work) => work({
      get: async () => ({ exists: true, data: () => stored }),
      set: (_ref, next) => { stored = { ...stored, ...next }; },
    }),
  };
  const saved = await appendCatalogProductMedia(db, 'p-1', { url: 'https://storage.example/one.png', type: 'image', alt: 'Generated preview' });
  assert.equal(saved.name, 'Keep me');
  assert.deepEqual(saved.tags, ['existing']);
  assert.equal(saved.gallery.length, 1);
  assert.deepEqual(saved.images, ['https://storage.example/one.png']);
});
