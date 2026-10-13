const test = require('node:test');
const assert = require('node:assert/strict');
const { entitlementId, canDownloadAsset, resolveCreatorProductPrice } = require('../api/creator/entitlements');

test('entitlementId is deterministic for the same order+product', () => {
  assert.equal(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_123', 'prod_abc'));
});

test('entitlementId differs across orders and across products', () => {
  assert.notEqual(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_999', 'prod_abc'));
  assert.notEqual(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_123', 'prod_xyz'));
});

test('no entitlement at all is denied as NO_ENTITLEMENT', () => {
  assert.deepEqual(canDownloadAsset(null), { allowed: false, reason: 'NO_ENTITLEMENT' });
});

test('an active entitlement is allowed', () => {
  assert.deepEqual(canDownloadAsset({ status: 'active' }), { allowed: true, reason: null });
});

test('a revoked entitlement is denied as REVOKED', () => {
  assert.deepEqual(canDownloadAsset({ status: 'revoked' }), { allowed: false, reason: 'REVOKED' });
});

test('any other status is denied as NOT_ACTIVE', () => {
  assert.deepEqual(canDownloadAsset({ status: 'pending' }), { allowed: false, reason: 'NOT_ACTIVE' });
});

const published = (over) => ({ status: 'PUBLISHED', publishedSnapshot: { title: 'A Great eBook', price: 25, currency: 'USD', ...over } });

test('a published, correctly priced product resolves', () => {
  assert.deepEqual(resolveCreatorProductPrice(published(), 'USD'), { price: 25, currency: 'USD', title: 'A Great eBook' });
});

test('a free listing resolves to price 0 regardless of a price field', () => {
  assert.equal(resolveCreatorProductPrice(published({ isFree: true, price: 999 }), 'USD').price, 0);
});

test('null for a non-existent product', () => {
  assert.equal(resolveCreatorProductPrice(null, 'USD'), null);
});

test('null for a product that is not PUBLISHED', () => {
  assert.equal(resolveCreatorProductPrice({ status: 'DRAFT', publishedSnapshot: { price: 25, currency: 'USD' } }, 'USD'), null);
});

test('null when publishedSnapshot is missing', () => {
  assert.equal(resolveCreatorProductPrice({ status: 'PUBLISHED' }, 'USD'), null);
});

test('null for a non-free listing with no positive price', () => {
  assert.equal(resolveCreatorProductPrice(published({ price: 0 }), 'USD'), null);
  assert.equal(resolveCreatorProductPrice(published({ price: -5 }), 'USD'), null);
  assert.equal(resolveCreatorProductPrice(published({ price: 'free' }), 'USD'), null);
});

test('a currency mismatch is never silently matched', () => {
  assert.equal(resolveCreatorProductPrice(published({ currency: 'USD' }), 'NGN'), null);
});

test('a missing paid-currency argument resolves using the snapshot currency', () => {
  assert.equal(resolveCreatorProductPrice(published(), undefined).currency, 'USD');
});
