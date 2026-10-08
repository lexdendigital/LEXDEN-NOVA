const test = require('node:test');
const assert = require('node:assert/strict');
const {
  entitlementId, canDownloadAsset, resolveCreatorProductPrice,
} = require('../api/creator/entitlements');

// ---- entitlementId ----

test('entitlementId is deterministic for the same order+product', () => {
  assert.equal(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_123', 'prod_abc'));
});

test('entitlementId differs across orders and across products', () => {
  assert.notEqual(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_999', 'prod_abc'));
  assert.notEqual(entitlementId('ref_123', 'prod_abc'), entitlementId('ref_123', 'prod_xyz'));
});

// ---- canDownloadAsset ----

test('no entitlement at all is denied as NO_ENTITLEMENT', () => {
  const { allowed, reason } = canDownloadAsset(null);
  assert.equal(allowed, false);
  assert.equal(reason, 'NO_ENTITLEMENT');
});

test('an active entitlement is allowed', () => {
  const { allowed, reason } = canDownloadAsset({ status: 'active' });
  assert.equal(allowed, true);
  assert.equal(reason, null);
});

test('a revoked entitlement is denied as REVOKED, not a generic denial', () => {
  const { allowed, reason } = canDownloadAsset({ status: 'revoked' });
  assert.equal(allowed, false);
  assert.equal(reason, 'REVOKED');
});

test('any other/unknown status is denied as NOT_ACTIVE', () => {
  const { allowed, reason } = canDownloadAsset({ status: 'pending' });
  assert.equal(allowed, false);
  assert.equal(reason, 'NOT_ACTIVE');
});

// ---- resolveCreatorProductPrice ----

function publishedProduct(snapshotOverrides) {
  return {
    status: 'PUBLISHED',
    publishedSnapshot: { title: 'A Great eBook', price: 25, currency: 'USD', ...snapshotOverrides },
  };
}

test('a published, correctly priced product resolves', () => {
  const r = resolveCreatorProductPrice(publishedProduct(), 'USD');
  assert.deepEqual(r, { price: 25, currency: 'USD', title: 'A Great eBook' });
});

test('a free listing resolves to price 0 regardless of a price field', () => {
  const r = resolveCreatorProductPrice(publishedProduct({ isFree: true, price: 999 }), 'USD');
  assert.equal(r.price, 0);
});

test('null is returned (never guessed) for a non-existent product', () => {
  assert.equal(resolveCreatorProductPrice(null, 'USD'), null);
});

test('null is returned for a product that is not PUBLISHED (e.g. a draft)', () => {
  assert.equal(resolveCreatorProductPrice({ status: 'DRAFT', publishedSnapshot: { price: 25, currency: 'USD' } }, 'USD'), null);
});

test('null is returned when publishedSnapshot is missing entirely', () => {
  assert.equal(resolveCreatorProductPrice({ status: 'PUBLISHED' }, 'USD'), null);
});

test('null is returned for a non-free listing with no positive price', () => {
  assert.equal(resolveCreatorProductPrice(publishedProduct({ price: 0 }), 'USD'), null);
  assert.equal(resolveCreatorProductPrice(publishedProduct({ price: -5 }), 'USD'), null);
  assert.equal(resolveCreatorProductPrice(publishedProduct({ price: 'free' }), 'USD'), null);
});

test('a currency mismatch between the snapshot and what was actually paid is never silently matched', () => {
  assert.equal(resolveCreatorProductPrice(publishedProduct({ currency: 'USD' }), 'NGN'), null);
});

test('a missing paid-currency argument still resolves using the snapshot currency', () => {
  const r = resolveCreatorProductPrice(publishedProduct(), undefined);
  assert.equal(r.currency, 'USD');
});
