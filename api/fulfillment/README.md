# Main-store supplier fulfillment adapters

This directory defines the provider-neutral adapter boundary for the main LEXDEN NOVA storefront.

## Current scope

The first implementation batch contains only the adapter contract and in-memory registry. It does not connect suppliers, read credentials, change Firestore, quote shipping, create orders, or make any supplier eligible for checkout.

The registry is intentionally process-local. A registered adapter means that its code is loaded and structurally valid. It does not mean that credentials exist, that a remote API is reachable, or that a supplier has been verified.

## Adapter shape

Every adapter must implement:

- `getCapabilities()`: synchronous and side-effect-free; returns an array containing only operations actually implemented.
- `healthCheck(input, context)`: performs a real provider connectivity/authentication probe and returns the standard response envelope.

An adapter may declare these operations only when it implements them:

- `searchProducts`
- `getProduct`
- `getVariants`
- `checkStock`
- `quoteShipping`
- `createOrder`
- `getOrder`
- `getTracking`
- `cancelOrder`
- `updateOrder`
- `processReturns`
- `processRefunds`
- `receiveWebhook`
- `getWarehouseInventory`
- `getFundingRequirements`

All operation methods receive `(input, context)` and must return:

```js
{
  ok: true,                 // false for a real failure
  requestId: null,          // provider request ID, when available
  code: null,               // stable error code on failure
  message: 'Success',
  data: null,               // normalized, sanitized business data
  timestamp: '2026-10-30T12:00:00.000Z'
}
```

The registry adds the registered `providerKey`, validates the envelope, and rejects operations that were not declared. It never fabricates success for an unsupported capability.

## Registration and operational state

- `REGISTERED`: adapter code passed local contract validation.
- `CONNECTED`: must be established by a successful real health check against that provider.
- `VERIFIED`: requires the additional provider-specific checks needed for actual product, shipping and fulfillment operations.
- `NEEDS_ATTENTION` / `DISABLED`: operational states to be implemented by the supplier management service in a later batch.

This registry does not persist or promote any of those operational states. Its list view always reports health as `UNKNOWN` until a later service owns verified health records.

## Security boundary

Adapters and the registry are server-side modules. Do not expose them directly to the browser. Provider credentials belong in backend-only secret storage. Never put access tokens, passwords, funding records, or raw authenticated supplier responses into public catalog product fields.

Adapter response `data` must contain normalized fields suitable for the consuming internal service. Provider adapters must redact credentials from errors and must not copy raw request headers or authentication responses into returned data. The registry deliberately replaces thrown exception messages with a generic error message.

## Test adapter

The only fake adapter is in `test/fixtures/fake-supplier-adapter.js`. It is a test fixture, not a production provider and must never be registered by a runtime service.
