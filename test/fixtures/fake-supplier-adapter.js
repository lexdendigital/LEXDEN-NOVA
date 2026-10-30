'use strict';

// TEST-ONLY adapter fixture. Never import this from production API routes.
function createFakeSupplierAdapter(options = {}) {
  const capabilities = options.capabilities || [
    'searchProducts',
    'getProduct',
    'getVariants',
    'checkStock',
    'quoteShipping',
    'createOrder',
    'getOrder',
    'getTracking',
  ];
  const calls = [];
  const health = options.health || { ok: true, message: 'Fake adapter healthy', data: { reachable: true } };

  function success(operation, input, data) {
    calls.push({ operation, input });
    return {
      ok: true,
      requestId: 'fake-' + operation + '-' + calls.length,
      message: 'Fake ' + operation + ' completed.',
      data,
    };
  }

  const adapter = {
    calls,
    getCapabilities() {
      return [...capabilities];
    },
    async healthCheck() {
      calls.push({ operation: 'healthCheck', input: {} });
      return { ...health };
    },
  };

  for (const operation of capabilities) {
    if (operation === 'searchProducts') adapter.searchProducts = async input => success(operation, input, { products: [] });
    if (operation === 'getProduct') adapter.getProduct = async input => success(operation, input, { product: null });
    if (operation === 'getVariants') adapter.getVariants = async input => success(operation, input, { variants: [] });
    if (operation === 'checkStock') adapter.checkStock = async input => success(operation, input, { available: 0 });
    if (operation === 'quoteShipping') adapter.quoteShipping = async input => success(operation, input, { quotes: [] });
    if (operation === 'createOrder') adapter.createOrder = async input => success(operation, input, { externalOrderId: 'FAKE-ORDER-1' });
    if (operation === 'getOrder') adapter.getOrder = async input => success(operation, input, { order: null });
    if (operation === 'getTracking') adapter.getTracking = async input => success(operation, input, { tracking: null });
    if (operation === 'cancelOrder') adapter.cancelOrder = async input => success(operation, input, { cancelled: true });
    if (operation === 'updateOrder') adapter.updateOrder = async input => success(operation, input, { updated: true });
    if (operation === 'processReturns') adapter.processReturns = async input => success(operation, input, { accepted: false });
    if (operation === 'processRefunds') adapter.processRefunds = async input => success(operation, input, { accepted: false });
    if (operation === 'receiveWebhook') adapter.receiveWebhook = async input => success(operation, input, { accepted: false });
    if (operation === 'getWarehouseInventory') adapter.getWarehouseInventory = async input => success(operation, input, { warehouses: [] });
    if (operation === 'getFundingRequirements') adapter.getFundingRequirements = async input => success(operation, input, { funding: null });
  }

  return adapter;
}

module.exports = { createFakeSupplierAdapter };