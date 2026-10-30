'use strict';

// Provider-neutral adapter contract for the main LEXDEN NOVA storefront.
// Registration validates the adapter shape; it does NOT prove API connectivity,
// supplier verification, fulfillment readiness, or production readiness.

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

const OPERATIONS = Object.freeze([
  'getCategories',
  'searchProducts',
  'getProduct',
  'getVariants',
  'checkStock',
  'quoteShipping',
  'createOrder',
  'getOrder',
  'getTracking',
  'cancelOrder',
  'updateOrder',
  'processReturns',
  'processRefunds',
  'receiveWebhook',
  'getWarehouseInventory',
  'getFundingRequirements',
]);

const REQUIRED_METHODS = Object.freeze(['getCapabilities', 'healthCheck']);
const DEFAULT_FAILURE_MESSAGE = 'The supplier operation could not be completed.';

class ProviderContractError extends Error {
  constructor(message, code = 'INVALID_PROVIDER_ADAPTER') {
    super(message);
    this.name = 'ProviderContractError';
    this.code = code;
  }
}

function assertProviderKey(providerKey) {
  if (typeof providerKey !== 'string' || !PROVIDER_KEY_PATTERN.test(providerKey)) {
    throw new ProviderContractError(
      'providerKey must be a stable lowercase identifier containing 2 to 64 letters, numbers, underscores or hyphens.',
      'INVALID_PROVIDER_KEY'
    );
  }
  return providerKey;
}

function getDeclaredCapabilities(adapter) {
  if (!adapter || typeof adapter.getCapabilities !== 'function') {
    throw new ProviderContractError('Adapter must implement getCapabilities().');
  }

  let declared;
  try {
    declared = adapter.getCapabilities();
  } catch {
    throw new ProviderContractError('Adapter getCapabilities() failed.');
  }

  if (declared && typeof declared.then === 'function') {
    throw new ProviderContractError('getCapabilities() must be synchronous and side-effect free.');
  }
  if (!Array.isArray(declared)) {
    throw new ProviderContractError('getCapabilities() must return an array of supported operation names.');
  }

  const seen = new Set();
  for (const operation of declared) {
    if (typeof operation !== 'string' || !OPERATIONS.includes(operation)) {
      throw new ProviderContractError('Adapter declared an unknown capability.');
    }
    if (seen.has(operation)) {
      throw new ProviderContractError('Adapter declared a duplicate capability.');
    }
    seen.add(operation);
  }
  return [...seen].sort();
}

function validateAdapter(providerKey, adapter) {
  assertProviderKey(providerKey);
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new ProviderContractError('Adapter must be an object.');
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new ProviderContractError('Adapter must implement ' + method + '().');
    }
  }

  const capabilities = getDeclaredCapabilities(adapter);
  for (const operation of capabilities) {
    if (typeof adapter[operation] !== 'function') {
      throw new ProviderContractError(
        'Adapter declared ' + operation + ' but does not implement it.'
      );
    }
  }

  return Object.freeze({ providerKey, capabilities: Object.freeze(capabilities) });
}

function safeString(value, maxLength = 160) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const out = String(value).trim();
  return out ? out.slice(0, maxLength) : null;
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_FAILURE_MESSAGE;
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function validTimestamp(value, now) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  const fallback = now();
  return (fallback instanceof Date ? fallback : new Date(fallback)).toISOString();
}

function normalizeAdapterResponse(providerKey, result, now = () => new Date()) {
  const timestamp = validTimestamp(result && result.timestamp, now);
  const requestId = safeString(result && result.requestId);
  const code = safeString(result && result.code, 80);

  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return {
      ok: false,
      providerKey,
      requestId,
      code: 'INVALID_ADAPTER_RESPONSE',
      message: 'Supplier adapter returned an invalid response.',
      data: null,
      timestamp,
    };
  }

  if (result.ok) {
    return {
      ok: true,
      providerKey,
      requestId,
      code: null,
      message: result.message ? safeMessage(result.message) : 'Success',
      data: result.data === undefined ? null : result.data,
      timestamp,
    };
  }

  return {
    ok: false,
    providerKey,
    requestId,
    code: code || 'PROVIDER_OPERATION_FAILED',
    message: safeMessage(result.message),
    data: null,
    timestamp,
  };
}

function failureResponse(providerKey, code, message, now = () => new Date()) {
  return normalizeAdapterResponse(providerKey, {
    ok: false,
    code,
    message,
  }, now);
}

module.exports = {
  PROVIDER_KEY_PATTERN,
  OPERATIONS,
  REQUIRED_METHODS,
  DEFAULT_FAILURE_MESSAGE,
  ProviderContractError,
  assertProviderKey,
  getDeclaredCapabilities,
  validateAdapter,
  normalizeAdapterResponse,
  failureResponse,
};