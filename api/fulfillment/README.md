# Main-store supplier fulfillment adapters

This directory defines the provider-neutral adapter boundary for the main LEXDEN NOVA storefront.

## Current scope

The main-store adapter contract, in-memory registry, and global CJ adapter are implemented. The CJ adapter reuses the existing global `cjFetch` token lifecycle and legacy CJ route handlers. It does not import creator-owned credentials. Adapter registration means code is loaded; it does not establish API connectivity, supplier verification, quote eligibility, or generic checkout readiness. Product mapping helpers and a dry-run migration preview are also available; no production catalog migration has run.

The registry is intentionally process-local. A registered adapter means that its code is loaded and structurally valid. It does not mean that credentials exist, that a remote API is reachable, or that a supplier has been verified.

## Adapter shape

Every adapter must implement:

- `getCapabilities()`: synchronous and side-effect-free; returns an array containing only operations actually implemented.
- `healthCheck(input, context)`: performs a real provider connectivity/authentication probe and returns the standard response envelope.

An adapter may declare these operations only when it implements them:

- `getCategories`
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


## Global CJ adapter

The global CJ adapter lives in `api/fulfillment/providers/cj.js` and is registered by `api/fulfillment/bootstrap.js` when the Render Express app starts. It reuses the existing main-store CJ HTTP handlers and `api/cj-shared.js`. It does not import creator-scoped CJ client modules.

The currently implemented capabilities are category search, product search/details, variants, live stock, warehouse inventory, live freight calculation, legacy order creation, order lookup, tracking and CJ-wallet balance inspection. Cancellation, returns, refunds and provider-neutral webhook receipt are not declared because the current main-store CJ implementation does not expose a verified generic operation for them.

The current `createOrder` adapter method delegates to the existing main-store `api/cj-order.js` handler. It therefore retains the existing paid-order, legacy CJ product mapping, reserved legacy quote, live-stock, and CJ-wallet funding checks. Generic supplier mapping and quote dispatch are not yet enabled by this adapter; those are later implementation batches. A CJ funding exception after actual order creation is preserved as a created external order with a funding-required result.

## Product mapping and migration

`api/fulfillment/product-mapping.js` validates stable NOVA supplier IDs, provider keys, provider-specific product IDs and independent variant mappings. It includes a deterministic migration preview for legacy CJ mappings. The preview never writes Firestore and marks legacy candidates for review; it does not approve them for new fulfillment.

The CJ MCP importer now requires exactly one active supplier registry entry with `providerKey: 'cj'`. It writes that NOVA registry ID to `physical.supplierId`, adds a provider-neutral mapping and keeps every new import in Draft with `approvedForFulfillment: false`. It will refuse the import if the registry mapping is missing or ambiguous. The external CJ supplier ID remains distinct and is not used as the NOVA registry ID.


## Provider-neutral shipping quotations

`api/fulfillment/shipping-quotes.js` is the main-store quote service, exposed through `POST /api/fulfillment-shipping-quote`. The public route accepts product, variant, quantity, destination and checkout currency only. Supplier IDs, provider keys, external IDs, stock, warehouse origin, cost and delivery methods are resolved on the server.

The service evaluates the configured primary supplier and then its configured backup before payment. Each candidate must be active, have a registered adapter with stock and shipping capabilities, pass a live health check, have an approved product/variant mapping (or an explicit legacy CJ mapping), have sufficient live stock at a country-identifiable warehouse, and return a real destination freight option.

Each option is saved in `shippingQuotes` with provider-neutral mapping and destination fields as well as compatibility fields `logisticName`, `startCountryCode` and `endCountryCode`. The payment-verification batch must bind and reserve the exact selected quote. This batch does not change payment or order dispatch.

International routes are capped at 15 order-to-door days including processing allowance, and slower Economy routes cannot bypass the limit. Domestic routes have a separate configurable maximum; otherwise they use the existing policy. The existing CJ shipping endpoint and its saved 45-day policy remain unchanged.

Supplier product and freight amounts are converted to USD only when a saved exchange rate exists. The legacy routing `maxCost` is interpreted as USD total supplier cost including freight. `minMargin` uses gross contribution margin on the verified customer item and shipping revenue after supplier item and freight costs. Missing currencies, stock origins, or delivery estimates fail closed.
