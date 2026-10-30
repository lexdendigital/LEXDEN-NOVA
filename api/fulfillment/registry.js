'use strict';

const {
  OPERATIONS,
  ProviderContractError,
  assertProviderKey,
  validateAdapter,
  normalizeAdapterResponse,
  failureResponse,
} = require('./adapter-contract');

class ProviderRegistryError extends Error {
  constructor(message, code = 'PROVIDER_REGISTRY_ERROR') {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
  }
}

function createProviderRegistry(options = {}) {
  const providers = new Map();
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function registerProvider(providerKey, adapter, registerOptions = {}) {
    assertProviderKey(providerKey);
    if (providers.has(providerKey) && registerOptions.replace !== true) {
      throw new ProviderRegistryError(
        'Provider is already registered: ' + providerKey,
        'PROVIDER_ALREADY_REGISTERED'
      );
    }

    const descriptor = validateAdapter(providerKey, adapter);
    const registeredAt = now();
    providers.set(providerKey, {
      adapter,
      capabilities: [...descriptor.capabilities],
      registeredAt: (registeredAt instanceof Date ? registeredAt : new Date(registeredAt)).toISOString(),
    });

    // Registration means only that an adapter is loaded and structurally valid.
    // It must never be displayed as connected or verified without a health check.
    return Object.freeze({
      providerKey,
      registrationState: 'REGISTERED',
      capabilities: [...descriptor.capabilities],
    });
  }

  function unregisterProvider(providerKey) {
    assertProviderKey(providerKey);
    return providers.delete(providerKey);
  }

  function getProvider(providerKey) {
    assertProviderKey(providerKey);
    const entry = providers.get(providerKey);
    if (!entry) {
      throw new ProviderRegistryError(
        'No provider adapter is registered for ' + providerKey + '.',
        'PROVIDER_NOT_REGISTERED'
      );
    }
    return entry.adapter;
  }

  function listProviders() {
    return [...providers.entries()].map(([providerKey, entry]) => ({
      providerKey,
      registrationState: 'REGISTERED',
      healthState: 'UNKNOWN',
      capabilities: [...entry.capabilities],
      registeredAt: entry.registeredAt,
    }));
  }

  function getProviderCapabilities(providerKey) {
    assertProviderKey(providerKey);
    const entry = providers.get(providerKey);
    if (!entry) {
      throw new ProviderRegistryError(
        'No provider adapter is registered for ' + providerKey + '.',
        'PROVIDER_NOT_REGISTERED'
      );
    }
    return [...entry.capabilities];
  }

  function hasProviderCapability(providerKey, operation) {
    if (!OPERATIONS.includes(operation)) return false;
    const entry = providers.get(providerKey);
    return !!entry && entry.capabilities.includes(operation);
  }

  async function run(providerKey, method, input = {}, context = {}, options = {}) {
    let entry;
    try {
      assertProviderKey(providerKey);
      entry = providers.get(providerKey);
    } catch (error) {
      const code = error instanceof ProviderContractError ? error.code : 'INVALID_PROVIDER_KEY';
      return failureResponse(providerKey || null, code, error.message, now);
    }

    if (!entry) {
      return failureResponse(
        providerKey,
        'PROVIDER_NOT_REGISTERED',
        'No operational adapter is registered for this supplier.',
        now
      );
    }

    if (method !== 'healthCheck' && !OPERATIONS.includes(method)) {
      return failureResponse(providerKey, 'UNKNOWN_PROVIDER_OPERATION', 'Unknown supplier operation.', now);
    }

    if (method !== 'healthCheck' && !entry.capabilities.includes(method)) {
      return failureResponse(
        providerKey,
        'UNSUPPORTED_OPERATION',
        'This supplier adapter does not support ' + method + '.',
        now
      );
    }

    const handler = entry.adapter[method];
    if (typeof handler !== 'function') {
      return failureResponse(
        providerKey,
        'UNSUPPORTED_OPERATION',
        'This supplier adapter does not implement ' + method + '.',
        now
      );
    }

    try {
      const result = await handler.call(entry.adapter, input, context);
      const normalized = normalizeAdapterResponse(providerKey, result, now);
      if (options.healthCheck === true && normalized.ok !== true) {
        // A failed health check remains a failed health check. Registration
        // state and declared capabilities are not promoted by this result.
        return normalized;
      }
      return normalized;
    } catch (error) {
      // Do not forward arbitrary thrown messages: provider libraries sometimes
      // include request headers or credential fragments in exception text.
      return failureResponse(
        providerKey,
        safeErrorCode(error),
        'The supplier adapter operation failed. Review the private server diagnostics.',
        now
      );
    }
  }

  function safeErrorCode(error) {
    const value = error && error.code;
    if (typeof value === 'string' && /^[A-Z0-9_]{2,80}$/.test(value)) return value;
    return 'PROVIDER_OPERATION_FAILED';
  }

  async function checkProviderHealth(providerKey, context = {}) {
    return run(providerKey, 'healthCheck', {}, context, { healthCheck: true });
  }

  async function callProvider(providerKey, operation, input = {}, context = {}) {
    return run(providerKey, operation, input, context);
  }

  function clear() {
    providers.clear();
  }

  return Object.freeze({
    registerProvider,
    unregisterProvider,
    getProvider,
    listProviders,
    getProviderCapabilities,
    hasProviderCapability,
    checkProviderHealth,
    callProvider,
    clear,
  });
}

const defaultRegistry = createProviderRegistry();

module.exports = {
  ProviderRegistryError,
  createProviderRegistry,
  registerProvider: defaultRegistry.registerProvider,
  unregisterProvider: defaultRegistry.unregisterProvider,
  getProvider: defaultRegistry.getProvider,
  listProviders: defaultRegistry.listProviders,
  getProviderCapabilities: defaultRegistry.getProviderCapabilities,
  hasProviderCapability: defaultRegistry.hasProviderCapability,
  checkProviderHealth: defaultRegistry.checkProviderHealth,
  callProvider: defaultRegistry.callProvider,
};