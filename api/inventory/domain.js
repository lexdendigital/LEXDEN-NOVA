// api/inventory/domain.js
//
// PURE inventory rules (no Firestore, no clock, no network) so the invariants that
// stop overselling can be tested exhaustively. The Firestore service in ./service.js
// only ever applies these functions inside a transaction.
//
// One canonical stock pool = creator + product + variant + location (+ source).
//   onHand        physical units actually held
//   reserved      units promised to valid, not-yet-fulfilled orders
//   unavailable   damaged / quarantined / otherwise not sellable
//   safetyStock   units NOT to be sold (buffer)
//   availableToSell = max(0, onHand - reserved - unavailable - safetyStock)
//
// Invariants (assertInvariants): every field is a non-negative integer and
// reserved + unavailable <= onHand. A "derived total" is never stored as truth: it is
// always recomputed with availableToSell().

class InventoryError extends Error {
  constructor(message, code, status) { super(message); this.name = 'InventoryError'; this.code = code || 'INVENTORY_ERROR'; this.status = status || 409; }
}

const MOVEMENT_TYPES = Object.freeze({
  INITIAL_IMPORT: 'INITIAL_IMPORT', RESTOCK: 'RESTOCK', EXTERNAL_SALE: 'EXTERNAL_SALE', COUNT_CORRECTION: 'COUNT_CORRECTION',
  MARK_UNAVAILABLE: 'MARK_UNAVAILABLE', RESTORE_AVAILABLE: 'RESTORE_AVAILABLE', RETURN_TO_STOCK: 'RETURN_TO_STOCK',
  TRANSFER_OUT: 'TRANSFER_OUT', TRANSFER_IN: 'TRANSFER_IN', RESERVE: 'RESERVE', RELEASE: 'RELEASE', CONSUME: 'CONSUME',
  SAFETY_STOCK_CHANGE: 'SAFETY_STOCK_CHANGE',
});

// Reasons a creator may record (free text note is separate and optional).
const UNAVAILABLE_REASONS = Object.freeze(['DAMAGED', 'LOST', 'QUARANTINED', 'EXPIRED', 'OTHER']);

const isCount = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isPositive = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function availableToSell(item) {
  return Math.max(0, (item.onHand | 0) - (item.reserved | 0) - (item.unavailable | 0) - (item.safetyStock | 0));
}

function assertInvariants(item) {
  for (const k of ['onHand', 'reserved', 'unavailable', 'safetyStock']) {
    if (!isCount(item[k])) throw new InventoryError(`${k} must be a whole number of units, zero or more.`, 'BAD_QUANTITY', 422);
  }
  if (item.reserved + item.unavailable > item.onHand) throw new InventoryError('Reserved plus unavailable units cannot exceed units on hand.', 'INVARIANT_VIOLATION', 409);
  return item;
}

function newItem({ creatorId, productId, variantKey = 'default', locationId = 'main', sourceType = 'CREATOR_HELD', sku = null, gtin = null, onHand = 0, safetyStock = 0 }) {
  return assertInvariants({
    creatorId, productId, variantKey, locationId, sourceType, sku, gtin,
    onHand, reserved: 0, unavailable: 0, safetyStock, version: 0,
  });
}

/** Stable, path-safe document id for a stock pool. */
function itemId({ creatorId, productId, variantKey = 'default', locationId = 'main' }) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 60);
  return `${safe(creatorId)}__${safe(productId)}__${safe(variantKey)}__${safe(locationId)}`;
}

/**
 * Applies ONE movement to an item and returns { item, movement } (a new object; the input is
 * untouched). Throws InventoryError when the movement would break an invariant. The returned
 * movement carries before/after so history is self-explanatory and auditable.
 */
function applyMovement(item, m) {
  const t = m.type;
  const before = { onHand: item.onHand, reserved: item.reserved, unavailable: item.unavailable, safetyStock: item.safetyStock, availableToSell: availableToSell(item) };
  const next = { ...item };
  const q = m.quantity;
  const needQty = () => { if (!isPositive(q)) throw new InventoryError('Quantity must be a whole number greater than zero.', 'BAD_QUANTITY', 422); };
  const free = item.onHand - item.reserved - item.unavailable;      // units not committed or broken

  switch (t) {
    case MOVEMENT_TYPES.INITIAL_IMPORT: if (!isCount(q)) throw new InventoryError('Opening quantity must be zero or more.', 'BAD_QUANTITY', 422); next.onHand = q; break;
    case MOVEMENT_TYPES.RESTOCK: needQty(); next.onHand += q; break;
    case MOVEMENT_TYPES.EXTERNAL_SALE:
      needQty();
      if (q > free) throw new InventoryError(`Only ${free} unreserved unit(s) are on hand; the rest are reserved for open orders or marked unavailable.`, 'INSUFFICIENT_UNRESERVED_STOCK');
      next.onHand -= q; break;
    case MOVEMENT_TYPES.COUNT_CORRECTION: {
      if (!isCount(m.countedOnHand)) throw new InventoryError('The counted quantity must be zero or more.', 'BAD_QUANTITY', 422);
      if (m.countedOnHand < item.reserved + item.unavailable) throw new InventoryError(`You counted ${m.countedOnHand}, but ${item.reserved} are reserved for open orders and ${item.unavailable} are marked unavailable. Resolve those first.`, 'COUNT_BELOW_COMMITTED');
      next.onHand = m.countedOnHand; break;
    }
    case MOVEMENT_TYPES.MARK_UNAVAILABLE:
      needQty();
      if (!UNAVAILABLE_REASONS.includes(m.reason)) throw new InventoryError(`Reason must be one of ${UNAVAILABLE_REASONS.join(', ')}.`, 'BAD_REASON', 422);
      if (q > free) throw new InventoryError(`Only ${free} unreserved unit(s) can be marked unavailable.`, 'INSUFFICIENT_UNRESERVED_STOCK');
      next.unavailable += q; break;
    case MOVEMENT_TYPES.RESTORE_AVAILABLE:
      needQty();
      if (q > item.unavailable) throw new InventoryError(`Only ${item.unavailable} unit(s) are marked unavailable.`, 'NOT_ENOUGH_UNAVAILABLE');
      next.unavailable -= q; break;
    case MOVEMENT_TYPES.RETURN_TO_STOCK:
      needQty();
      // A returned item goes back on the shelf ONLY when someone has confirmed it is resellable.
      if (m.resellableConfirmed !== true) throw new InventoryError('Confirm the returned item is in resellable condition before returning it to stock.', 'RESELLABLE_CONFIRMATION_REQUIRED', 422);
      next.onHand += q; break;
    case MOVEMENT_TYPES.TRANSFER_OUT:
      needQty();
      if (q > free) throw new InventoryError(`Only ${free} unreserved unit(s) can be transferred out.`, 'INSUFFICIENT_UNRESERVED_STOCK');
      next.onHand -= q; break;
    case MOVEMENT_TYPES.TRANSFER_IN: needQty(); next.onHand += q; break;
    case MOVEMENT_TYPES.RESERVE:
      needQty();
      if (q > availableToSell(item)) throw new InventoryError(availableToSell(item) === 0 ? 'This item is out of stock.' : `Only ${availableToSell(item)} left in stock.`, 'INSUFFICIENT_STOCK');
      next.reserved += q; break;
    case MOVEMENT_TYPES.RELEASE:
      needQty();
      if (q > item.reserved) throw new InventoryError('Cannot release more than is reserved.', 'RELEASE_EXCEEDS_RESERVED');
      next.reserved -= q; break;
    case MOVEMENT_TYPES.CONSUME:
      needQty();
      if (q > item.reserved) throw new InventoryError('Cannot consume more than is reserved.', 'CONSUME_EXCEEDS_RESERVED');
      next.reserved -= q; next.onHand -= q; break;
    case MOVEMENT_TYPES.SAFETY_STOCK_CHANGE:
      if (!isCount(m.safetyStock)) throw new InventoryError('Safety stock must be zero or more.', 'BAD_QUANTITY', 422);
      next.safetyStock = m.safetyStock; break;
    default: throw new InventoryError(`Unknown movement type "${t}".`, 'UNKNOWN_MOVEMENT', 422);
  }
  assertInvariants(next);
  next.version = (item.version | 0) + 1;
  const after = { onHand: next.onHand, reserved: next.reserved, unavailable: next.unavailable, safetyStock: next.safetyStock, availableToSell: availableToSell(next) };
  return { item: next, movement: { type: t, quantity: q == null ? null : q, reason: m.reason || null, before, after } };
}

// ---------------------------------------------------------------- availability model
/**
 * What "in stock" means depends on what is being sold. Only UNIT_STOCK uses the quantity
 * ledger above; the rest must NOT be forced into a physical quantity.
 */
function availabilityModelFor(offeringType, fulfillmentMode) {
  if (offeringType === 'PHYSICAL_PRODUCT') {
    if (fulfillmentMode === 'CJ_DROPSHIP') return { model: 'SUPPLIER_AVAILABILITY', note: 'Supplier availability plus a checkout funding check; never mixed with creator-held stock.' };
    if (fulfillmentMode === 'MADE_TO_ORDER') return { model: 'MADE_TO_ORDER_CAPACITY', note: 'Declared production capacity and lead time.' };
    return { model: 'UNIT_STOCK', note: 'Per-variant, per-location quantity.' };
  }
  if (offeringType === 'APPOINTMENT' || offeringType === 'BOOKING') return { model: 'TIME_SLOTS', note: 'Time slots with capacity.' };
  if (offeringType === 'COMMISSION' || offeringType === 'CUSTOM_WORK' || offeringType === 'SERVICE') return { model: 'OPEN_CLOSED_SLOTS', note: 'Open/closed commission slots.' };
  return { model: 'ENTITLEMENT', note: 'Digital files use entitlement/access controls and need no physical quantity.' };
}

// ---------------------------------------------------------------- channel mapping
/**
 * Links an EXTERNAL listing to a canonical stock pool. Matching is ONLY by stable
 * identifiers (SKU, GTIN/barcode, or a previously confirmed external id). A similar-looking
 * title is NEVER enough. Anything uncertain needs a human to confirm.
 */
function matchListing(listing, items) {
  const norm = (v) => (v == null ? '' : String(v).trim().toUpperCase());
  const sku = norm(listing.sku); const gtin = norm(listing.gtin);
  const matches = new Map();
  for (const it of items) {
    if (sku && norm(it.sku) === sku) matches.set(it.id, { id: it.id, by: 'SKU' });
    if (gtin && norm(it.gtin) === gtin) matches.set(it.id, { id: it.id, by: matches.has(it.id) ? 'SKU+GTIN' : 'GTIN' });
    if (listing.confirmedItemId && it.id === listing.confirmedItemId) matches.set(it.id, { id: it.id, by: 'CONFIRMED' });
  }
  const found = [...matches.values()];
  if (found.length === 0) return { status: 'UNMAPPED', itemId: null, reason: 'No SKU, barcode or confirmed id matches. Choose the product manually.' };
  if (found.length > 1) return { status: 'NEEDS_REVIEW', itemId: null, candidates: found, reason: 'More than one stock pool matches. Confirm which one this listing is.' };
  const only = found[0];
  // A lone identifier match is only auto-accepted when it is exact on SKU or confirmed; a barcode-only match
  // on a pool that has a different SKU is flagged.
  return { status: only.by === 'CONFIRMED' || only.by === 'SKU' || only.by === 'SKU+GTIN' ? 'MAPPED' : 'NEEDS_REVIEW', itemId: only.id, matchedBy: only.by };
}

const SYNC_MODES = Object.freeze({ NOVA_ONLY: 'NOVA_ONLY', MANUAL_OR_BATCH: 'MANUAL_OR_BATCH', CONNECTED: 'CONNECTED' });

/** Health shown to the seller. Never says "connected" without a real, recent, error-free sync. */
function syncHealth({ mode, adapterAvailable = false, enabled = false, lastSuccessAtMs = null, lastError = null, nowMs, staleAfterMs = 6 * 60 * 60 * 1000 }) {
  if (mode === SYNC_MODES.NOVA_ONLY) return { status: 'NOT_APPLICABLE', message: 'Stock is managed in LEXDEN NOVA only.' };
  if (mode === SYNC_MODES.MANUAL_OR_BATCH) return { status: 'MANUAL', message: 'Automatic sync is not on for this channel. Record external sales or import them so NOVA stock stays correct.' };
  if (!adapterAvailable) return { status: 'UNAVAILABLE', message: 'This channel has no verified connection yet, so nothing is being synced automatically. Record external sales manually.' };
  if (!enabled) return { status: 'DISABLED', message: 'Sync is switched off for this channel.' };
  if (lastError) return { status: 'ERROR', message: `The last sync failed: ${String(lastError).slice(0, 200)}. Changes are queued for retry.` };
  if (lastSuccessAtMs == null) return { status: 'NEVER_SYNCED', message: 'No successful sync yet.' };
  if (nowMs - lastSuccessAtMs > staleAfterMs) return { status: 'STALE', message: 'The last successful sync is out of date. Stock shown here may differ from the channel.' };
  return { status: 'HEALTHY', message: 'Synced recently.' };
}

// ---------------------------------------------------------------- CSV import
const CSV_HEADERS = ['sku', 'quantity', 'mode'];
/** Minimal CSV: header row, comma separated, double-quote aware. Returns rows with line numbers. */
function parseCsv(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out.map((x) => x.trim());
  };
  const headers = split(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((l, i) => { const cells = split(l); const row = { line: i + 2 }; headers.forEach((h, j) => { row[h] = cells[j] === undefined ? '' : cells[j]; }); return row; });
  return { headers, rows };
}

/**
 * Validates a stock CSV against the creator's pools. mode per row: SET (physical count) or ADD (restock).
 * Returns per-row verdicts; the commit step applies only valid rows (idempotently) and returns a report.
 */
function validateImport(csvText, items) {
  const { headers, rows } = parseCsv(csvText);
  const problems = [];
  for (const h of ['sku', 'quantity']) if (!headers.includes(h)) problems.push(`Missing required column "${h}".`);
  if (problems.length) return { ok: false, fileProblems: problems, rows: [] };
  if (rows.length > 500) return { ok: false, fileProblems: ['A file can have at most 500 rows.'], rows: [] };
  const bySku = new Map();
  for (const it of items) if (it.sku) { const k = String(it.sku).toUpperCase(); (bySku.get(k) || bySku.set(k, []).get(k)).push(it); }
  const seen = new Set();
  const verdicts = rows.map((r) => {
    const sku = String(r.sku || '').trim().toUpperCase();
    const mode = String(r.mode || 'SET').trim().toUpperCase();
    const qtyN = Number(r.quantity);
    const errs = [];
    if (!sku) errs.push('SKU is empty.');
    if (r.quantity === '' || !Number.isFinite(qtyN) || !Number.isInteger(qtyN) || qtyN < 0) errs.push('Quantity must be a whole number, zero or more.');
    if (!['SET', 'ADD'].includes(mode)) errs.push('Mode must be SET or ADD.');
    if (mode === 'ADD' && qtyN === 0) errs.push('ADD needs a quantity above zero.');
    if (sku && seen.has(sku)) errs.push('This SKU appears more than once in the file.');
    seen.add(sku);
    const matches = sku ? (bySku.get(sku) || []) : [];
    if (sku && matches.length === 0) errs.push('No product of yours has this SKU (similar names are never matched).');
    if (matches.length > 1) errs.push('More than one stock pool has this SKU; fix the duplicate first.');
    return { line: r.line, sku, mode, quantity: qtyN, itemId: matches.length === 1 ? matches[0].id : null, valid: errs.length === 0, errors: errs };
  });
  return { ok: true, fileProblems: [], rows: verdicts, validCount: verdicts.filter((v) => v.valid).length, invalidCount: verdicts.filter((v) => !v.valid).length };
}

module.exports = {
  InventoryError, MOVEMENT_TYPES, UNAVAILABLE_REASONS, SYNC_MODES, CSV_HEADERS,
  availableToSell, assertInvariants, newItem, itemId, applyMovement, availabilityModelFor,
  matchListing, syncHealth, parseCsv, validateImport,
};
