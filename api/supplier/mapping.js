// api/supplier/mapping.js
//
// LEXDEN NOVA CREATOR — Stage G: pure decision logic for per-creator CJ
// dropshipping. No I/O, no Firestore, no network — every function here is
// unit tested (test/supplier-mapping.test.js) and every rule that decides
// "may this listing go on sale / must it be paused / what does a CJ status
// mean for the buyer's fulfillment" lives in this one file.
//
// Blueprint sections implemented here:
//   §16  fulfillment modes
//   §20  CJ mapping: product, variant, SKU, supplier cost, shipping method,
//        destination, stock threshold — "NOVA should test the mapping before
//        approval"
//   §86  supplier health: connection / stock / price / shipping / last sync /
//        last order error; a broken critical mapping PAUSES the listing
//   §87  approval-time supplier validation checklist
const FULFILLMENT_MODES = Object.freeze({
  SELLER_STOCK: 'SELLER_STOCK',
  CJ_DROPSHIP: 'CJ_DROPSHIP',
  VERIFIED_SUPPLIER_API: 'VERIFIED_SUPPLIER_API',
  MANUAL_SUPPLIER: 'MANUAL_SUPPLIER',
  PREORDER: 'PREORDER',
});

// Modes the platform can actually fulfil today. VERIFIED_SUPPLIER_API and
// PREORDER are real names in the blueprint (§16) but nothing implements them
// yet, so accepting them would let a creator list something NOVA cannot
// deliver. (Blueprint §20: other suppliers start as MANUAL_SUPPLIER until an
// integration is explicitly verified.)
const SUPPORTED_FULFILLMENT_MODES = Object.freeze([
  FULFILLMENT_MODES.SELLER_STOCK,
  FULFILLMENT_MODES.CJ_DROPSHIP,
  FULFILLMENT_MODES.MANUAL_SUPPLIER, // Stage H: creator orders from their own supplier by hand
]);

// A listing saved before Stage G has no fulfillmentMode; it was seller stock.
function normalizeFulfillmentMode(value) {
  return value === undefined || value === null || value === '' ? FULFILLMENT_MODES.SELLER_STOCK : value;
}

const MAPPING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a mapping test older than this is re-run before approval
const COST_DRIFT_WARN_PCT = 20;                  // supplier price moved >20% from what the creator declared
const TRANSIENT_FAILURES_BEFORE_PAUSE = 3;       // consecutive CJ outages before a listing is paused
const CONNECT_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const CONNECT_MAX_FAILED_ATTEMPTS = 5;

const TRANSIENT_CODES = Object.freeze(['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED']);
const AUTH_CODES = Object.freeze(['AUTH_FAILED', 'REFRESH_FAILED', 'NOT_CONFIGURED', 'AUTH_ERROR']);
const isTransientCode = (c) => TRANSIENT_CODES.includes(c);
const isAuthCode = (c) => AUTH_CODES.includes(c);

function coded(message, code, status, errors) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  if (errors) e.errors = errors;
  return e;
}

// ------------------------------------------------------------------ input
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const SKU_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Validates what a creator submits when mapping a listing to a CJ variant. */
function validateMappingInput(body) {
  const b = body || {};
  const errors = [];
  const value = {};

  if (typeof b.cjVariantId !== 'string' || !ID_RE.test(b.cjVariantId.trim())) {
    errors.push({ field: 'cjVariantId', message: 'The CJ variant ID (vid) is required — copy it from the variant in your CJ account.' });
  } else value.cjVariantId = b.cjVariantId.trim();

  if (b.cjProductId !== undefined && b.cjProductId !== null && b.cjProductId !== '') {
    if (typeof b.cjProductId !== 'string' || !ID_RE.test(b.cjProductId.trim())) errors.push({ field: 'cjProductId', message: 'The CJ product ID (pid) looks invalid.' });
    else value.cjProductId = b.cjProductId.trim();
  } else value.cjProductId = null;

  if (b.sku !== undefined && b.sku !== null && b.sku !== '') {
    if (typeof b.sku !== 'string' || !SKU_RE.test(b.sku.trim())) errors.push({ field: 'sku', message: 'SKU may only contain letters, numbers, dot, dash and underscore (64 max).' });
    else value.sku = b.sku.trim();
  } else value.sku = null;

  if (b.declaredCostUsd !== undefined && b.declaredCostUsd !== null && b.declaredCostUsd !== '') {
    if (typeof b.declaredCostUsd !== 'number' || !Number.isFinite(b.declaredCostUsd) || b.declaredCostUsd <= 0 || b.declaredCostUsd > 100000) {
      errors.push({ field: 'declaredCostUsd', message: 'Supplier cost must be a positive number in USD.' });
    } else value.declaredCostUsd = b.declaredCostUsd;
  } else value.declaredCostUsd = null;

  if (b.logisticName !== undefined && b.logisticName !== null && b.logisticName !== '') {
    if (typeof b.logisticName !== 'string' || b.logisticName.trim().length > 100) errors.push({ field: 'logisticName', message: 'Shipping method name is too long.' });
    else value.logisticName = b.logisticName.trim();
  } else value.logisticName = null;

  let countries = ['NG'];
  if (b.destinationCountries !== undefined && b.destinationCountries !== null) {
    countries = Array.isArray(b.destinationCountries) ? b.destinationCountries.map((c) => String(c).trim().toUpperCase()) : null;
  }
  if (!countries || countries.length < 1 || countries.length > 5 || countries.some((c) => !/^[A-Z]{2}$/.test(c))) {
    errors.push({ field: 'destinationCountries', message: 'Give 1 to 5 two-letter country codes, e.g. ["NG"].' });
  } else value.destinationCountries = [...new Set(countries)];

  let threshold = 1;
  if (b.stockThreshold !== undefined && b.stockThreshold !== null) threshold = b.stockThreshold;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000) {
    errors.push({ field: 'stockThreshold', message: 'Stock threshold must be a whole number from 0 to 100000.' });
  } else value.stockThreshold = threshold;

  return { ok: errors.length === 0, errors, value };
}

// ------------------------------------------------------- CJ response shaping
// CJ returns one or more warehouse rows per variant — never a single number.
function summarizeStockRows(rows) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  let total = 0;
  for (const row of list) {
    total += Number(row && (row.storageNum ?? row.stockNum ?? row.num ?? row.availableQty)) || 0;
  }
  return { total, inStock: total > 0 };
}

function normalizeVariant(v) {
  if (!v || typeof v !== 'object') return null;
  const vid = v.vid || v.variantId || null;
  if (!vid) return null;
  const price = v.variantSellPrice != null ? Number(v.variantSellPrice) : (v.sellPrice != null ? Number(v.sellPrice) : null);
  return { vid: String(vid), sku: v.variantSku || v.sku || null, sellPrice: Number.isFinite(price) ? price : null, name: v.variantNameEn || v.variantKey || v.name || '' };
}

function normalizeFreightOptions(data) {
  const raw = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
  return raw
    .map((o) => ({
      logisticName: (o && (o.logisticName || o.logisticNameEn)) || null,
      logisticPrice: o && o.logisticPrice != null ? Number(o.logisticPrice) : null,
      aging: (o && (o.logisticAging || o.aging)) || null,
    }))
    .filter((o) => o.logisticName && Number.isFinite(o.logisticPrice));
}

// ------------------------------------------------------------- evaluation
/**
 * Turns raw CJ answers into a verdict on a mapping (blueprint §87 checklist:
 * variant valid? stock available? shipping route available for every
 * destination the creator serves?).
 *
 * @param input.variant            normalized variant or null
 * @param input.stockTotal         number
 * @param input.stockThreshold     number
 * @param input.freightByCountry   { NG: [options], ... }
 * @param input.declaredCostUsd    number|null
 * @param input.preferredLogistic  string|null
 */
function evaluateMapping({ variant, stockTotal, stockThreshold = 1, freightByCountry = {}, declaredCostUsd = null, preferredLogistic = null }) {
  const reasons = [];
  const countries = Object.keys(freightByCountry);

  const variantValid = !!(variant && variant.vid);
  if (!variantValid) reasons.push('CJ does not recognise this variant ID for your account.');

  // A mapping that is out of stock is not sellable even if the creator set
  // the threshold to 0, hence the floor of 1 for the *validity* check.
  const needed = Math.max(1, stockThreshold);
  const stockOk = variantValid && stockTotal >= needed;
  if (variantValid && !stockOk) reasons.push(`Supplier stock is ${stockTotal}; at least ${needed} is required.`);

  let shippingOk = countries.length > 0;
  for (const c of countries) {
    if (!Array.isArray(freightByCountry[c]) || freightByCountry[c].length === 0) {
      shippingOk = false;
      reasons.push(`CJ has no shipping method to ${c} for this variant.`);
    }
  }

  // Chosen method PER destination: the creator's preference if CJ really
  // offers it there, else the cheapest. CJ requires a shipping method name on
  // every order (logisticName), and a method that exists for Nigeria may not
  // exist for Ghana, so the choice is recorded per country. A stated
  // preference CJ does not offer is a failed check, not a silent substitution.
  const logisticByCountry = {};
  for (const c of countries) {
    const options = freightByCountry[c] || [];
    if (!options.length) continue;
    if (preferredLogistic) {
      const hit = options.find((o) => o.logisticName.toLowerCase() === preferredLogistic.toLowerCase());
      if (hit) logisticByCountry[c] = hit.logisticName;
      else { shippingOk = false; reasons.push(`CJ does not offer "${preferredLogistic}" to ${c}.`); }
    } else {
      logisticByCountry[c] = [...options].sort((a, b) => a.logisticPrice - b.logisticPrice)[0].logisticName;
    }
  }
  const chosenLogistic = countries.length ? logisticByCountry[countries[0]] || null : null;

  const actualCostUsd = variantValid ? variant.sellPrice : null;
  let costDriftPct = null;
  if (declaredCostUsd && actualCostUsd != null) costDriftPct = Math.round(((actualCostUsd - declaredCostUsd) / declaredCostUsd) * 1000) / 10;

  const checks = { variantValid, stockOk, shippingOk };
  return {
    status: variantValid && stockOk && shippingOk ? 'VALID' : 'INVALID',
    checks, reasons, chosenLogistic, logisticByCountry, actualCostUsd, costDriftPct, stockTotal,
  };
}

/**
 * Health verdict for a PUBLISHED dropship listing (blueprint §86).
 *
 *   HEALTHY  everything checks out
 *   WARNING  something to look at, listing stays on sale
 *   DEGRADED a critical supplier dependency is broken -> pause = true
 *
 * A single CJ outage must not pause every dropship listing on the platform,
 * so transient failures only pause after TRANSIENT_FAILURES_BEFORE_PAUSE in a
 * row. Auth failures and a genuinely invalid mapping pause immediately,
 * because accepting orders the creator cannot fulfil is the exact harm the
 * blueprint says to prevent.
 */
function deriveHealth({ connectionStatus, probeError = null, evaluation = null, consecutiveFailures = 0 }) {
  if (connectionStatus !== 'CONNECTED') {
    return { health: 'DEGRADED', pause: true, consecutiveFailures, reasons: ['The supplier connection is not active.'] };
  }
  if (probeError) {
    if (isAuthCode(probeError.code)) {
      return { health: 'DEGRADED', pause: true, consecutiveFailures, reasons: ['CJ rejected the stored credentials. Reconnect your CJ account.'] };
    }
    if (isTransientCode(probeError.code)) {
      const n = consecutiveFailures + 1;
      const pause = n >= TRANSIENT_FAILURES_BEFORE_PAUSE;
      return { health: pause ? 'DEGRADED' : 'WARNING', pause, consecutiveFailures: n, reasons: [`CJ was unreachable (${n} check${n === 1 ? '' : 's'} in a row).`] };
    }
    return { health: 'WARNING', pause: false, consecutiveFailures, reasons: [`CJ returned an error: ${String(probeError.message || probeError.code).slice(0, 200)}`] };
  }
  if (!evaluation) return { health: 'WARNING', pause: false, consecutiveFailures: 0, reasons: ['No supplier data was available.'] };
  if (evaluation.status !== 'VALID') {
    return { health: 'DEGRADED', pause: true, consecutiveFailures: 0, reasons: evaluation.reasons.length ? evaluation.reasons : ['The supplier mapping is no longer valid.'] };
  }
  if (evaluation.costDriftPct != null && evaluation.costDriftPct > COST_DRIFT_WARN_PCT) {
    return { health: 'WARNING', pause: false, consecutiveFailures: 0, reasons: [`Supplier cost is ${evaluation.costDriftPct}% above what you declared.`] };
  }
  return { health: 'HEALTHY', pause: false, consecutiveFailures: 0, reasons: [] };
}

/**
 * The gate a CJ_DROPSHIP version must pass to be submitted or approved.
 * Throws a coded error naming the FIRST thing that is wrong, so the creator
 * (or admin) is told exactly what to fix.
 */
function assertDropshipReady({ creatorStatus, connection, mapping, nowMs = Date.now(), maxAgeMs = null }) {
  if (creatorStatus !== 'ACTIVE') {
    throw coded('CJ dropshipping is available once your creator account is fully active (not restricted).', 'CREATOR_NOT_ELIGIBLE', 403);
  }
  if (!connection || connection.status !== 'CONNECTED') {
    throw coded('Connect your CJ account before listing a dropship product.', 'SUPPLIER_NOT_CONNECTED', 409);
  }
  if (!mapping) throw coded('Map this listing to a CJ variant and run the mapping test first.', 'MAPPING_MISSING', 409);
  if (mapping.status !== 'VALID') {
    throw coded(`The supplier mapping did not pass its test${mapping.reasons && mapping.reasons.length ? `: ${mapping.reasons[0]}` : '.'}`, 'MAPPING_INVALID', 409);
  }
  if (maxAgeMs != null) {
    const age = nowMs - (mapping.testedAtMs || 0);
    // A test recorded a moment AFTER nowMs was read (re-test during approval) or clock skew is not stale.
    if (!(age >= -5 * 60 * 1000 && age <= maxAgeMs)) throw coded('The supplier mapping test is out of date — run it again.', 'MAPPING_STALE', 409);
  }
  return true;
}

// ------------------------------------------------- CJ order -> fulfillment
/**
 * What a CJ order's current state means for the buyer-facing fulfillment.
 * Deliberately conservative:
 *   * SHIPPED needs a tracking number — "a SHIPPED record with no tracking
 *     number is a claim, not proof" (Stage E rule).
 *   * CJ reporting DELIVERED is recorded as carrier EVIDENCE only; the
 *     buyer/admin confirmation rule from Stage E still decides DELIVERED
 *     (automatic release after a silent dispute window is Stage I).
 *   * CJ CANCELLED never auto-cancels the fulfillment — a cancelled supplier
 *     order on a paid buyer order is a human decision (refund/replace).
 *
 * Returns { supplierPatch, transitions: [{to, carrier?, trackingNumber?, trackingUrl?}] }
 */
function planFulfillmentUpdate(fulfillmentStatus, cj) {
  const status = String((cj && cj.orderStatus) || '').toUpperCase();
  const trackNumber = cj && typeof cj.trackNumber === 'string' ? cj.trackNumber.trim() : '';
  const carrier = (cj && cj.logisticName) || 'CJ Dropshipping';
  const supplierPatch = { cjStatus: status || null };
  const transitions = [];

  if (status === 'CREATED' || status === 'IN_CART' || status === 'UNPAID') {
    supplierPatch.status = 'AWAITING_PAYMENT';
    supplierPatch.note = 'The CJ order exists but is not paid yet. Pay it from your CJ balance so it can ship.';
  } else if (status === 'UNSHIPPED' || status === 'PENDING' || status === 'PROCESSING') {
    supplierPatch.status = 'PROCESSING';
  } else if (status === 'SHIPPED' || status === 'DELIVERED') {
    supplierPatch.status = status === 'DELIVERED' ? 'CARRIER_DELIVERED' : 'SHIPPED';
    if (trackNumber) {
      supplierPatch.trackingNumber = trackNumber;
      if (fulfillmentStatus === 'PENDING') transitions.push({ to: 'PACKED' });
      if (fulfillmentStatus === 'PENDING' || fulfillmentStatus === 'PACKED') {
        transitions.push({ to: 'SHIPPED', carrier, trackingNumber: trackNumber, trackingUrl: (cj && cj.trackingUrl) || null });
      }
    } else if (fulfillmentStatus === 'PENDING' || fulfillmentStatus === 'PACKED') {
      supplierPatch.note = 'CJ reports this shipped but has not issued a tracking number yet.';
    }
    if (status === 'DELIVERED') supplierPatch.carrierDelivered = true;
  } else if (status === 'CANCELLED') {
    supplierPatch.status = 'CJ_CANCELLED';
    supplierPatch.note = 'CJ cancelled this order. Contact the buyer or LEXDEN NOVA support to refund or replace it.';
  } else if (status) {
    supplierPatch.status = 'UNKNOWN_STATUS';
  }
  return { supplierPatch, transitions };
}

// ---------------------------------------------------------- shipping address
const COUNTRY_NAMES = Object.freeze({
  NG: 'Nigeria', GH: 'Ghana', KE: 'Kenya', ZA: 'South Africa', US: 'United States', GB: 'United Kingdom',
  CA: 'Canada', AE: 'United Arab Emirates', CM: 'Cameroon', BJ: 'Benin', TG: 'Togo', SN: 'Senegal', CI: "Cote d'Ivoire",
});
const COUNTRY_CODES_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(COUNTRY_NAMES).map(([c, n]) => [n.toLowerCase(), c])));

/** Free text or ISO-2 -> { code, name }. Unknown free text is NOT guessed. */
function resolveCountry(input) {
  const s = String(input || '').trim();
  if (!s) return { code: 'NG', name: 'Nigeria' };
  if (/^[A-Za-z]{2}$/.test(s)) {
    const code = s.toUpperCase();
    return { code, name: COUNTRY_NAMES[code] || code };
  }
  const code = COUNTRY_CODES_BY_NAME[s.toLowerCase()];
  return code ? { code, name: COUNTRY_NAMES[code] } : { code: null, name: s };
}

// ------------------------------------------------------- connect throttling
/** Keeps only failures inside the window and says whether another try is allowed. */
function pruneAttempts(attempts, nowMs) {
  return (Array.isArray(attempts) ? attempts : []).filter((t) => typeof t === 'number' && nowMs - t < CONNECT_ATTEMPT_WINDOW_MS);
}
function isConnectRateLimited(attempts, nowMs) {
  return pruneAttempts(attempts, nowMs).length >= CONNECT_MAX_FAILED_ATTEMPTS;
}

module.exports = {
  FULFILLMENT_MODES, SUPPORTED_FULFILLMENT_MODES, normalizeFulfillmentMode,
  MAPPING_MAX_AGE_MS, COST_DRIFT_WARN_PCT, TRANSIENT_FAILURES_BEFORE_PAUSE,
  CONNECT_ATTEMPT_WINDOW_MS, CONNECT_MAX_FAILED_ATTEMPTS,
  isTransientCode, isAuthCode,
  validateMappingInput, summarizeStockRows, normalizeVariant, normalizeFreightOptions,
  evaluateMapping, deriveHealth, assertDropshipReady, planFulfillmentUpdate,
  resolveCountry, pruneAttempts, isConnectRateLimited, coded,
};
