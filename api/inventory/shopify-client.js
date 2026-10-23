// api/inventory/shopify-client.js
//
// Thin, dependency-free Shopify Admin GraphQL client for INVENTORY ONLY.
//   * One request = one POST to https://<shop>.myshopify.com/admin/api/<version>/graphql.json
//   * The access token is passed in, used for one call and never logged or returned.
//   * Every failure is a coded error; nothing here touches Firestore.
// Written against Shopify's documented Admin GraphQL (inventorySetQuantities needs write_inventory, an
// idempotency key from API 2026-04 and a changeFromQuantity compare-and-swap value). The queries are
// validated against Shopify's schema in staging (see STAGING-SMOKE-TEST-CHECKLIST.md); the unit tests use a mock.
const REQUIRED_SCOPES = Object.freeze(['read_inventory', 'write_inventory', 'read_locations']);
const API_VERSION = () => process.env.SHOPIFY_API_VERSION || '2026-07';
const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const GID_RE = /^gid:\/\/shopify\/(InventoryItem|Location)\/\d+$/;

class ShopifyError extends Error {
  constructor(message, code, status = 502, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra); }
}

/** "My-Store", "https://my-store.myshopify.com/admin" -> "my-store.myshopify.com". Anything else is refused (SSRF guard). */
function normaliseShop(input) {
  let s = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split('?')[0];
  if (s && !s.includes('.')) s += '.myshopify.com';
  if (!SHOP_RE.test(s)) throw new ShopifyError('Enter your store address like your-store.myshopify.com.', 'BAD_SHOP', 422);
  return s;
}
const isGid = (v) => typeof v === 'string' && GID_RE.test(v);

async function gql({ shop, token, query, variables = {}, fetchImpl = fetch, timeoutMs = 15000 }) {
  const host = normaliseShop(shop);
  if (!token) throw new ShopifyError('No Shopify access token.', 'NO_TOKEN', 409);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res; let body;
  try {
    res = await fetchImpl(`https://${host}/admin/api/${API_VERSION()}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    throw new ShopifyError('Could not reach Shopify. Try again in a few minutes.', 'UNREACHABLE', 503, { unknownOutcome: true });
  } finally { if (timer) clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw new ShopifyError('Shopify rejected the connection. Reconnect your store.', 'AUTH_FAILED', 409);
  if (res.status === 402 || res.status === 404 || res.status === 423) throw new ShopifyError('This Shopify store is unavailable (closed, frozen or not found).', 'STORE_UNAVAILABLE', 409);
  if (res.status === 429) throw new ShopifyError('Shopify asked us to slow down.', 'THROTTLED', 429, { retryable: true });
  if (res.status >= 500) throw new ShopifyError('Shopify had a problem. We will retry.', 'UPSTREAM', 502, { retryable: true, unknownOutcome: true });
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const first = body.errors[0] || {};
    const code = first.extensions && first.extensions.code;
    if (code === 'THROTTLED') throw new ShopifyError('Shopify asked us to slow down.', 'THROTTLED', 429, { retryable: true });
    if (code === 'ACCESS_DENIED') throw new ShopifyError('The connection is missing a permission NOVA needs.', 'MISSING_SCOPE', 409);
    throw new ShopifyError(`Shopify refused the request: ${String(first.message || 'unknown error').slice(0, 160)}`, 'GRAPHQL_ERROR', 502);
  }
  if (!body || !body.data) throw new ShopifyError('Shopify sent an unreadable answer.', 'BAD_RESPONSE', 502, { unknownOutcome: true });
  return body.data;
}

const Q_SHOP = `query { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`;
async function verifyConnection(conn, deps = {}) {
  const d = await gql({ ...conn, query: Q_SHOP, fetchImpl: deps.fetchImpl });
  const scopes = ((d.currentAppInstallation && d.currentAppInstallation.accessScopes) || []).map((s) => s.handle);
  const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s) && !(s === 'read_inventory' && scopes.includes('write_inventory')));
  return { shopName: d.shop && d.shop.name, domain: d.shop && d.shop.myshopifyDomain, scopes, missingScopes: missing };
}

const Q_LOCATIONS = `query { locations(first: 50) { nodes { id name isActive } } }`;
async function listLocations(conn, deps = {}) {
  const d = await gql({ ...conn, query: Q_LOCATIONS, fetchImpl: deps.fetchImpl });
  return ((d.locations && d.locations.nodes) || []).filter((l) => l.isActive !== false).map((l) => ({ id: l.id, name: l.name }));
}

const Q_ITEMS = `query($locationId: ID!, $after: String) {
  inventoryItems(first: 100, after: $after) {
    nodes { id sku tracked variants(first: 1) { nodes { displayName product { title } } } inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } } }
    pageInfo { hasNextPage endCursor }
  } }`;
/** One page of the store's inventory items with their "available" number at one location. */
async function listInventoryItems(conn, { locationId, after = null }, deps = {}) {
  if (!isGid(locationId)) throw new ShopifyError('Pick a location first.', 'BAD_LOCATION', 422);
  const d = await gql({ ...conn, query: Q_ITEMS, variables: { locationId, after }, fetchImpl: deps.fetchImpl });
  const page = d.inventoryItems || { nodes: [], pageInfo: {} };
  return {
    items: page.nodes.map((n) => {
      const v = n.variants && n.variants.nodes && n.variants.nodes[0];
      return {
        id: n.id, sku: n.sku || null, tracked: n.tracked !== false,
        title: v ? (v.displayName || (v.product && v.product.title) || '').slice(0, 140) || null : null,
        available: availableOf(n.inventoryLevel),
      };
    }),
    next: page.pageInfo && page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}
function availableOf(level) {
  if (!level || !Array.isArray(level.quantities)) return null; // not stocked at this location
  const q = level.quantities.find((x) => x.name === 'available');
  return q && Number.isInteger(q.quantity) ? q.quantity : null;
}

const Q_LEVELS = `query($ids: [ID!]!, $locationId: ID!) {
  nodes(ids: $ids) { ... on InventoryItem { id tracked inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } } } } }`;
/** Current "available" for up to 100 items: Map(id -> {available:number|null, tracked, missing}). */
async function readLevels(conn, { ids, locationId }, deps = {}) {
  if (!isGid(locationId)) throw new ShopifyError('Pick a location first.', 'BAD_LOCATION', 422);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).filter(isGid);
    if (!chunk.length) continue;
    const d = await gql({ ...conn, query: Q_LEVELS, variables: { ids: chunk, locationId }, fetchImpl: deps.fetchImpl });
    const nodes = d.nodes || [];
    chunk.forEach((id, k) => {
      const n = nodes[k];
      if (!n || n.id !== id) out.set(id, { available: null, tracked: false, missing: true });
      else out.set(id, { available: availableOf(n.inventoryLevel), tracked: n.tracked !== false, missing: false });
    });
  }
  return out;
}

const M_SET = `mutation($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { code field message }
  } }`;
/**
 * Sets "available" to `quantity`, but ONLY if Shopify still holds `changeFrom` (compare-and-swap), so a
 * sale that happened a moment ago is never overwritten. Retrying with the same idempotencyKey is safe.
 * Returns {ok:true} | {ok:false, code:'STALE'|'REJECTED', message}. Network/5xx errors throw (outcome unknown).
 */
async function setAvailable(conn, { inventoryItemId, locationId, quantity, changeFrom, idempotencyKey, reference }, deps = {}) {
  if (!isGid(inventoryItemId) || !isGid(locationId)) throw new ShopifyError('Bad Shopify id.', 'BAD_ID', 422);
  if (!Number.isInteger(quantity) || quantity < 0) throw new ShopifyError('Quantity must be a whole number, zero or more.', 'BAD_QUANTITY', 422);
  if (!Number.isInteger(changeFrom)) throw new ShopifyError('changeFrom is required.', 'BAD_CHANGE_FROM', 422);
  if (!idempotencyKey) throw new ShopifyError('An idempotency key is required.', 'NO_KEY', 422);
  const d = await gql({
    ...conn, fetchImpl: deps.fetchImpl, query: M_SET,
    variables: {
      idempotencyKey,
      input: { name: 'available', reason: 'correction', referenceDocumentUri: `lexden-nova://channel-sync/${String(reference || 'sync').slice(0, 100)}`, quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: changeFrom }] },
    },
  });
  const r = d.inventorySetQuantities || {};
  const errs = r.userErrors || [];
  if (errs.length) {
    if (errs.some((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE')) return { ok: false, code: 'STALE', message: 'Shopify stock changed while syncing.' };
    return { ok: false, code: 'REJECTED', message: String(errs[0].message || 'Shopify rejected the change.').slice(0, 200) };
  }
  return { ok: true };
}

module.exports = { ShopifyError, REQUIRED_SCOPES, API_VERSION, normaliseShop, isGid, gql, verifyConnection, listLocations, listInventoryItems, readLevels, setAvailable, availableOf };
