'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('../api/file-storage');

test('signer sorts params, skips empty ones, and appends the secret (Cloudinary rule)', () => {
  const crypto = require('crypto');
  const want = crypto.createHash('sha1').update('public_id=sample&timestamp=1315060510abcd').digest('hex');
  assert.equal(fs.sign({ timestamp: 1315060510, public_id: 'sample', empty: '', nothing: undefined }, 'abcd'), want);
});

test('private upload goes to Cloudinary as authenticated raw and returns a provider tag', async () => {
  process.env.CLOUDINARY_API_KEY = 'k'; process.env.CLOUDINARY_API_SECRET = 's';
  const real = global.fetch; let seen;
  global.fetch = async (url, init) => { seen = { url, body: init.body }; return { ok: true, text: async () => '{"public_id":"x"}' }; };
  try {
    const r = await fs.savePrivate('creator-documents/u1/d1.pdf', Buffer.from('hi'), 'application/pdf');
    assert.deepEqual(r, { storagePath: 'creator-documents/u1/d1.pdf', storageProvider: 'cloudinary' });
    assert.match(seen.url, /\/raw\/upload$/);
    assert.equal(seen.body.get('type'), 'authenticated');
    assert.ok(seen.body.get('signature'));
    assert.equal(seen.body.get('api_secret'), null);
  } finally { global.fetch = real; }
});

test('download link is signed, expires, and never contains the secret', async () => {
  process.env.CLOUDINARY_API_KEY = 'k'; process.env.CLOUDINARY_API_SECRET = 'topsecret';
  const url = await fs.signedDownloadUrl({ storageProvider: 'cloudinary', storagePath: 'product-assets/a/b.zip' }, Date.now() + 60000);
  assert.match(url, /\/raw\/download\?/);
  assert.match(url, /expires_at=\d+/);
  assert.match(url, /signature=[0-9a-f]{40}/);
  assert.ok(!url.includes('topsecret'));
});

test('public image upload works with only the unsigned preset (no keys needed)', async () => {
  delete process.env.CLOUDINARY_API_KEY; delete process.env.CLOUDINARY_API_SECRET;
  const real = global.fetch; let seen;
  global.fetch = async (url, init) => { seen = init.body; return { ok: true, text: async () => '{"secure_url":"https://res.cloudinary.com/z/x.png","public_id":"p"}' }; };
  try {
    const r = await fs.savePublicImage('products/a/generated/1.png', Buffer.from([1, 2, 3]), 'image/png');
    assert.equal(r.url, 'https://res.cloudinary.com/z/x.png');
    assert.equal(seen.get('upload_preset'), 'lexden-nova');
  } finally { global.fetch = real; }
});

test('without keys or Firebase bucket, private save gives a clear error', async () => {
  delete process.env.CLOUDINARY_API_KEY; delete process.env.CLOUDINARY_API_SECRET; delete process.env.FIREBASE_STORAGE_BUCKET;
  await assert.rejects(() => fs.savePrivate('a/b.pdf', Buffer.from('x'), 'application/pdf'), /CLOUDINARY_API_KEY/);
});
