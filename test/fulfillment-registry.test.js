'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProviderRegistryError,
  createProviderRegistry,
} = require('../api/fulfillment/registry');
const { ProviderContractError } = require('../api/fulfillment/adapter-contract');
const { createFakeSupplierAdapter } = require('./fixtures/fake-supplier-adapter');

function fixedClock() {
  return () => new Date('2026-10-30T12:00:00.000Z');
}

test('registers a valid adapter as REGISTERED, not CONNECTED or VERIFIED', () => {
  const registry = createProviderRegistry({ now: fixedClock() });
  const adapter = createFakeSupplierAdapter();
  const result = registry.registerProvider('cj', adapter);

  assert.equal(result.providerKey, 'cj');
  assert.equal(result.registrationState, 'REGISTERED');
  assert.equal(Object.hasOwn(result, 'connected'), false);
  assert.deepEqual(registry.listProviders(), [{
    providerKey: 'cj',
    registrationState: 'REGISTERED',
    healthState: 'UNKNOWN',
    capabilities: adapter.getCapabilities().sort(),
    registeredAt: '2026-10-30T12:00:00.000Z',
  }]);
});

test('rejects malformed or unstable provider keys', () => {
  const registry = createProviderRegistry();
  const adapter = createFakeSupplierAdapter();
  for (const key of ['CJ', 'Cj', 'a', 'provider with spaces', '../cj', '', null]) {
    assert.throws(() => registry.registerProvider(key, adapter), ProviderContractError);
  }
});

test('rejects a duplicate provider key unless replacement is explicitly requested', () => {
  const registry = createProviderRegistry();
  const first = createFakeSupplierAdapter();
  const second = createFakeSupplierAdapter({ capabilities: ['checkStock'] });

  registry.registerProvider('cj', first);
  assert.throws(
    () => registry.registerProvider('cj', second),
    error => error.code === 'PROVIDER_ALREADY_REGISTERED'
  );

  registry.registerProvider('cj', second, { replace: true });
  assert.deepEqual(registry.getProviderCapabilities('cj'), ['checkStock']);
});

test('rejects an adapter without required methods', () => {
  const registry = createProviderRegistry();
  assert.throws(
    () => registry.registerProvider('supplierx', { getCapabilities() { return []; } }),
    error => error.code === 'INVALID_PROVIDER_ADAPTER'
  );
});

test('rejects unknown, duplicate and asynchronous capability declarations', () => {
  const registry = createProviderRegistry();
  const missingMethod = {
    getCapabilities() { return ['createOrder']; },
    healthCheck() { return { ok: true, data: {} }; },
  };
  const unknownCapability = createFakeSupplierAdapter({ capabilities: ['shipEverything'] });
  const duplicateCapability = {
    getCapabilities() { return ['checkStock', 'checkStock']; },
    healthCheck() { return { ok: true, data: {} }; },
    checkStock() { return { ok: true, data: {} }; },
  };
  const asyncCapabilities = {
    getCapabilities() { return Promise.resolve([]); },
    healthCheck() { return { ok: true, data: {} }; },
  };

  assert.throws(() => registry.registerProvider('missing', missingMethod), ProviderContractError);
  assert.throws(() => registry.registerProvider('unknown', unknownCapability), ProviderContractError);
  assert.throws(() => registry.registerProvider('duplicate', duplicateCapability), ProviderContractError);
  assert.throws(() => registry.registerProvider('async', asyncCapabilities), ProviderContractError);
});

test('a declared operation must have an implementation', () => {
  const registry = createProviderRegistry();
  const adapter = {
    getCapabilities() { return ['quoteShipping']; },
    healthCheck() { return { ok: true, data: {} }; },
  };

  assert.throws(
    () => registry.registerProvider('incomplete', adapter),
    error => error.code === 'INVALID_PROVIDER_ADAPTER'
  );
});

test('unsupported operations fail honestly instead of returning fake success', async () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', createFakeSupplierAdapter({ capabilities: ['checkStock'] }));

  const result = await registry.callProvider('supplierx', 'createOrder', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_OPERATION');
  assert.equal(result.providerKey, 'supplierx');
  assert.equal(result.data, null);
});

test('unregistered providers cannot execute an operation', async () => {
  const registry = createProviderRegistry();
  const result = await registry.callProvider('unknown', 'checkStock', {});

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_NOT_REGISTERED');
});

test('normalizes successful provider responses and binds the registered provider key', async () => {
  const registry = createProviderRegistry({ now: fixedClock() });
  const adapter = createFakeSupplierAdapter({ capabilities: ['checkStock'] });
  registry.registerProvider('localvendor', adapter);

  const result = await registry.callProvider('localvendor', 'checkStock', { variantId: 'nv-1' });

  assert.equal(result.ok, true);
  assert.equal(result.providerKey, 'localvendor');
  assert.equal(result.requestId, 'fake-checkStock-1');
  assert.deepEqual(result.data, { available: 0 });
  assert.equal(result.timestamp, '2026-10-30T12:00:00.000Z');
});

test('normalizes provider failures without returning provider data', async () => {
  const registry = createProviderRegistry({ now: fixedClock() });
  registry.registerProvider('supplierx', {
    getCapabilities() { return ['checkStock']; },
    async healthCheck() { return { ok: true, data: {} }; },
    async checkStock() {
      return {
        ok: false,
        code: 'OUT_OF_STOCK',
        message: 'No stock for selected variant.',
        data: { internal: 'must not leak' },
      };
    },
  });

  const result = await registry.callProvider('supplierx', 'checkStock');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUT_OF_STOCK');
  assert.equal(result.data, null);
  assert.equal(result.message, 'No stock for selected variant.');
});

test('does not expose thrown error messages that may contain credentials', async () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', {
    getCapabilities() { return ['createOrder']; },
    async healthCheck() { return { ok: true, data: {} }; },
    async createOrder() { throw new Error('Authorization: Bearer super-secret-token'); },
  });

  const result = await registry.callProvider('supplierx', 'createOrder');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_OPERATION_FAILED');
  assert.equal(result.message.includes('super-secret-token'), false);
});

test('health checks can fail without marking the provider connected', async () => {
  const registry = createProviderRegistry();
  const adapter = createFakeSupplierAdapter({
    capabilities: ['checkStock'],
    health: { ok: false, code: 'AUTH_FAILED', message: 'Authentication failed.', data: null },
  });
  registry.registerProvider('supplierx', adapter);

  const health = await registry.checkProviderHealth('supplierx');
  const listed = registry.listProviders()[0];

  assert.equal(health.ok, false);
  assert.equal(health.code, 'AUTH_FAILED');
  assert.equal(listed.registrationState, 'REGISTERED');
  assert.equal(listed.healthState, 'UNKNOWN');
});

test('supports method availability checks without exposing adapter objects', () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', createFakeSupplierAdapter({ capabilities: ['checkStock'] }));

  assert.equal(registry.hasProviderCapability('supplierx', 'checkStock'), true);
  assert.equal(registry.hasProviderCapability('supplierx', 'createOrder'), false);
  assert.equal(registry.hasProviderCapability('unknown', 'checkStock'), false);
  assert.equal(registry.hasProviderCapability('supplierx', 'notAnOperation'), false);
});

test('unregisters adapters without mutating other providers', () => {
  const registry = createProviderRegistry();
  registry.registerProvider('cj', createFakeSupplierAdapter());
  registry.registerProvider('supplierx', createFakeSupplierAdapter());

  assert.equal(registry.unregisterProvider('cj'), true);
  assert.equal(registry.unregisterProvider('cj'), false);
  assert.deepEqual(registry.listProviders().map(item => item.providerKey), ['supplierx']);
});

test('clear removes registrations from an isolated registry', () => {
  const registry = createProviderRegistry();
  registry.registerProvider('cj', createFakeSupplierAdapter());
  registry.clear();
  assert.deepEqual(registry.listProviders(), []);
});

test('rejects malformed adapter response envelopes', async () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', {
    getCapabilities() { return ['checkStock']; },
    async healthCheck() { return { ok: true, data: {} }; },
    async checkStock() { return { available: true }; },
  });

  const result = await registry.callProvider('supplierx', 'checkStock');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ADAPTER_RESPONSE');
  assert.equal(result.data, null);
});

test('unknown adapter lookup throws a typed registry error', () => {
  const registry = createProviderRegistry();
  assert.throws(
    () => registry.getProvider('missing'),
    error => error instanceof ProviderRegistryError && error.code === 'PROVIDER_NOT_REGISTERED'
  );
});

test('sanitizes credential-like fragments in successful response messages', async () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', {
    getCapabilities() { return ['checkStock']; },
    async healthCheck() { return { ok: true, data: {} }; },
    async checkStock() {
      return { ok: true, message: 'Connected accessToken=private-value', data: { available: true } };
    },
  });

  const result = await registry.callProvider('supplierx', 'checkStock');

  assert.equal(result.ok, true);
  assert.equal(result.message.includes('private-value'), false);
});

test('sanitizes credential-like fragments in normalized provider messages', async () => {
  const registry = createProviderRegistry();
  registry.registerProvider('supplierx', {
    getCapabilities() { return ['checkStock']; },
    async healthCheck() { return { ok: true, data: {} }; },
    async checkStock() {
      return { ok: false, code: 'AUTH_FAILED', message: 'accessToken=private-value' };
    },
  });

  const result = await registry.callProvider('supplierx', 'checkStock');

  assert.equal(result.ok, false);
  assert.equal(result.message.includes('private-value'), false);
});