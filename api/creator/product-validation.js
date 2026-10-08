// api/creator/product-validation.js
//
// Field requirements per offeringType (blueprint §8/§9 — "only display
// fields relevant to the chosen offering type... never represent all of
// these as a single generic deliveryLink field").
//
// Scope note: every type gets real validation, but the depth varies on
// purpose. PHYSICAL_PRODUCT, DIGITAL_DOWNLOAD, EBOOK, SOFTWARE, TEMPLATE,
// COURSE, and SERVICE — the types this platform's actual catalog uses
// today (see the "doorways" categories from the homepage redesign) — each
// have their own bespoke required-field set. EXTERNAL_ACCESS, LIVE_PROGRAM,
// SUBSCRIPTION, and BUNDLE share a common "access-based" field set for now
// rather than four more bespoke schemas; they're real and enforced, just
// not yet differentiated from each other. Splitting those further is a
// small, isolated follow-up whenever the platform actually needs to tell
// them apart.
const OFFERING_TYPES = Object.freeze([
  'PHYSICAL_PRODUCT', 'DIGITAL_DOWNLOAD', 'EBOOK', 'TEMPLATE', 'SOFTWARE',
  'COURSE', 'EXTERNAL_ACCESS', 'SERVICE', 'LIVE_PROGRAM', 'SUBSCRIPTION', 'BUNDLE',
]);
const ACCESS_LIKE_TYPES = ['EXTERNAL_ACCESS', 'LIVE_PROGRAM', 'SUBSCRIPTION', 'BUNDLE'];

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && (!max || v.trim().length <= max);
}
function isValidUrl(v) {
  if (!isNonEmptyString(v, 2048)) return false;
  try { const u = new URL(v.trim()); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}
function isPositiveNumber(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }

/** Lenient — only checks offeringType is valid. Used for DRAFT saves. */
function validateProductDraft(body) {
  const errors = [];
  if (!OFFERING_TYPES.includes(body && body.offeringType)) {
    errors.push({ field: 'offeringType', message: `offeringType must be one of: ${OFFERING_TYPES.join(', ')}.` });
  }
  return { ok: errors.length === 0, errors };
}

/** Strict — everything required to submit a version for review. */
function validateProductForSubmit(fields) {
  const errors = [];
  const f = fields || {};
  const type = f.offeringType;

  if (!OFFERING_TYPES.includes(type)) {
    errors.push({ field: 'offeringType', message: `offeringType must be one of: ${OFFERING_TYPES.join(', ')}.` });
    return { ok: false, errors };
  }

  // ---- Common to every type ----
  if (!isNonEmptyString(f.title, 140)) errors.push({ field: 'title', message: 'A title is required (140 characters max).' });
  if (!isNonEmptyString(f.description, 5000)) errors.push({ field: 'description', message: 'A description is required.' });
  if (!isNonEmptyString(f.category)) errors.push({ field: 'category', message: 'A category is required.' });
  if (!Array.isArray(f.images) || !f.images.some(isValidUrl)) errors.push({ field: 'images', message: 'At least one image is required.' });
  if (!(f.isFree === true)) {
    if (!isPositiveNumber(f.price) || f.price <= 0) errors.push({ field: 'price', message: 'A price greater than 0 is required (or mark this listing as free).' });
    if (!isNonEmptyString(f.currency)) errors.push({ field: 'currency', message: 'A currency is required.' });
  }
  if (!isNonEmptyString(f.refundPolicy)) errors.push({ field: 'refundPolicy', message: 'A refund/return policy statement is required.' });

  // ---- Type-specific ----
  if (type === 'PHYSICAL_PRODUCT') {
    if (!isPositiveNumber(f.stock)) errors.push({ field: 'stock', message: 'Stock quantity is required.' });
    if (!isPositiveNumber(f.weightGrams)) errors.push({ field: 'weightGrams', message: 'Package weight (grams) is required for shipping calculation.' });
    if (!isNonEmptyString(f.shippingOrigin)) errors.push({ field: 'shippingOrigin', message: 'A shipping origin is required.' });
  }

  if (type === 'DIGITAL_DOWNLOAD' || type === 'SOFTWARE' || type === 'EBOOK' || type === 'TEMPLATE') {
    // Either an uploaded private file OR an external delivery link —
    // never both silently conflated into one field (blueprint §8).
    if (!isNonEmptyString(f.fileAssetId) && !isValidUrl(f.externalUrl)) {
      errors.push({ field: 'fileAssetId', message: 'Upload a file, or provide an external delivery URL.' });
    }
    if (type === 'SOFTWARE' && !isNonEmptyString(f.systemRequirements)) {
      errors.push({ field: 'systemRequirements', message: 'System requirements are required for software.' });
    }
    if (type === 'EBOOK' && !isPositiveNumber(f.pageCount)) {
      errors.push({ field: 'pageCount', message: 'Page count is required for eBooks.' });
    }
    if (type === 'TEMPLATE' && !isNonEmptyString(f.compatibility)) {
      errors.push({ field: 'compatibility', message: 'Compatibility (e.g. Figma, Notion, Word) is required for templates.' });
    }
  }

  if (type === 'COURSE') {
    if (!Array.isArray(f.modules) || f.modules.length < 1) {
      errors.push({ field: 'modules', message: 'At least one module is required.' });
    } else if (f.modules.some(m => !isNonEmptyString(m && m.title))) {
      errors.push({ field: 'modules', message: 'Every module needs a title.' });
    }
    if (!isNonEmptyString(f.level)) errors.push({ field: 'level', message: 'A skill level is required.' });
  }

  if (type === 'SERVICE') {
    if (!isNonEmptyString(f.turnaround)) errors.push({ field: 'turnaround', message: 'An estimated turnaround time is required.' });
    if (!isNonEmptyString(f.deliverables)) errors.push({ field: 'deliverables', message: 'A description of what\'s delivered is required.' });
  }

  if (ACCESS_LIKE_TYPES.includes(type)) {
    if (!isValidUrl(f.externalUrl) && !isNonEmptyString(f.fileAssetId)) {
      errors.push({ field: 'externalUrl', message: 'An access URL (or uploaded file, for a bundle) is required.' });
    }
    if (type === 'SUBSCRIPTION' && !isNonEmptyString(f.billingInterval)) {
      errors.push({ field: 'billingInterval', message: 'A billing interval (e.g. monthly) is required for subscriptions.' });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { OFFERING_TYPES, ACCESS_LIKE_TYPES, validateProductDraft, validateProductForSubmit };
