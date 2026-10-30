'use strict';
const crypto = require('crypto');
const { getDb, getAuthAdmin } = require('./affiliate/shared');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EVENT_DELAYS = Object.freeze({ product_view: HOUR_MS, checkout_started: 2 * HOUR_MS, signup_started: 6 * HOUR_MS });
const EVENT_TYPES = new Set(Object.keys(EVENT_DELAYS));
const DEFAULT_LIMITS = Object.freeze({ uidHourly: 12, ipHourly: 60, recipientDaily: 3, duplicateDaily: 1 });
function positiveLimit(envName, fallback) {
  const value = Number(process.env[envName]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100000) : fallback;
}
function limits() {
  return {
    uidHourly: positiveLimit('LIFECYCLE_UID_HOURLY_LIMIT', DEFAULT_LIMITS.uidHourly),
    ipHourly: positiveLimit('LIFECYCLE_IP_HOURLY_LIMIT', DEFAULT_LIMITS.ipHourly),
    recipientDaily: positiveLimit('LIFECYCLE_RECIPIENT_DAILY_LIMIT', DEFAULT_LIMITS.recipientDaily),
    duplicateDaily: positiveLimit('LIFECYCLE_DUPLICATE_DAILY_LIMIT', DEFAULT_LIMITS.duplicateDaily),
  };
}
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function cleanName(value) {
  if (value == null) return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || null;
}
function cleanVariant(value) {
  if (value == null || value === '') return null;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (result.length > 120) throw Object.assign(new Error('Variant is too long.'), { status: 400, code: 'INVALID_VARIANT' });
  return result || null;
}
function canonicalStoreUrl() {
  const raw = String(process.env.STORE_URL || 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('HTTPS required');
    return parsed.origin + parsed.pathname;
  } catch (e) {
    if (process.env.STORE_URL) throw new Error('STORE_URL is invalid.');
    return 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
  }
}
function productUrl(productId) { return canonicalStoreUrl() + '#product/' + encodeURIComponent(productId); }
async function resolveProduct(db, productId) {
  const catalogSnap = await db.collection('catalog').doc('products').get();
  const catalog = catalogSnap.exists ? catalogSnap.data() || {} : {};
  const list = Array.isArray(catalog.list) ? catalog.list : [];
  const match = list.find((p) => p && String(p.id) === productId && p.status !== 'draft');
  if (match) return { id: productId, name: String(match.name || 'Selected item').slice(0, 180), variants: match.variants || [] };
  // Only resolve a published public creator snapshot with an active seller.
  const creatorProduct = await db.collection('products').doc(productId).get();
  if (!creatorProduct.exists) return null;
  const raw = creatorProduct.data() || {};
  if (raw.status !== 'PUBLISHED' || !raw.creatorId || !raw.publishedSnapshot) return null;
  const creator = await db.collection('creators').doc(raw.creatorId).get();
  if (!creator.exists || creator.data().status !== 'ACTIVE') return null;
  const title = String(raw.publishedSnapshot.title || '').trim();
  return title ? { id: productId, name: title.slice(0, 180), variants: raw.publishedSnapshot.variants || [] } : null;
}
function authoritativeVariant(product, requested) {
  if (!requested || !product || !Array.isArray(product.variants)) return null;
  const match = product.variants.find((v) => v && [v.id, v.title, v.name].some((x) => String(x || '') === requested));
  return match ? String(match.title || match.name || match.id || '').slice(0, 120) : null;
}
function rateRef(db, kind, value, bucketStart) {
  return db.collection('lifecycleRateLimits').doc(digest(kind + '|' + value + '|' + bucketStart));
}
function makeRateControls(db, input, nowMs, configured) {
  const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const dedupeKey = [input.email, input.eventType, input.productId || ''].join('|');
  const eventId = digest('lifecycle-event|' + dedupeKey + '|' + dayStart);
  return {
    eventId,
    eventRef: db.collection('productViewEvents').doc(eventId),
    controls: [
      { ref: rateRef(db, 'uid-hour', input.uid, hourStart), bucketStart: hourStart, max: configured.uidHourly },
      { ref: rateRef(db, 'ip-hour', input.ip, hourStart), bucketStart: hourStart, max: configured.ipHourly },
      { ref: rateRef(db, 'recipient-day', input.email, dayStart), bucketStart: dayStart, max: configured.recipientDaily },
      { ref: rateRef(db, 'recipient-type-product-day', dedupeKey, dayStart), bucketStart: dayStart, max: configured.duplicateDaily },
    ],
  };
}
function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(String((req.headers || {}).authorization || ''));
  return match ? match[1].trim() : '';
}
function createLifecycleHandler(deps = {}) {
  const dbProvider = deps.getDb || getDb;
  const authProvider = deps.getAuth || getAuthAdmin;
  const now = deps.now || Date.now;
  const configuredLimits = deps.limits || limits();
  return async function lifecycleEventHandler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'A valid sign-in session is required.' } });
    let db, decoded;
    try {
      db = dbProvider();
      decoded = await authProvider().verifyIdToken(token);
    } catch (e) {
      const code = String(e && (e.code || (e.errorInfo && e.errorInfo.code)) || '');
      const tokenError = /^auth\/(argument-error|id-token-expired|id-token-revoked|invalid-id-token|user-disabled|user-not-found)/.test(code) ||
        /expired|invalid.*token|decoding firebase id token/i.test(String(e && e.message || ''));
      return res.status(tokenError ? 401 : 503).json({ ok: false, error: {
        code: tokenError ? 'INVALID_SESSION' : 'AUTH_UNAVAILABLE',
        message: tokenError ? 'Your session is invalid or expired. Please refresh and try again.' : 'The sign-in service is temporarily unavailable.',
      } });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const eventType = body.eventType;
    if (!EVENT_TYPES.has(eventType)) return res.status(400).json({ ok: false, error: { code: 'INVALID_EVENT_TYPE', message: 'Unsupported lifecycle event type.' } });
    const isAnonymous = decoded.firebase && decoded.firebase.sign_in_provider === 'anonymous';
    let email, recipientVerification;
    if (eventType === 'product_view') {
      if (isAnonymous === true || decoded.email_verified !== true || !decoded.email) {
        return res.status(403).json({ ok: false, error: { code: 'VERIFIED_SHOPPER_REQUIRED', message: 'Product-view recovery is available only to signed-in shoppers with a verified email.' } });
      }
      email = normalizeEmail(decoded.email);
      if (!email) return res.status(403).json({ ok: false, error: { code: 'VERIFIED_EMAIL_REQUIRED', message: 'A verified account email is required.' } });
      recipientVerification = 'verified';
    } else {
      email = normalizeEmail(body.email);
      if (!email) return res.status(400).json({ ok: false, error: { code: 'INVALID_EMAIL', message: 'Enter a valid email address.' } });
      recipientVerification = decoded.email_verified === true && normalizeEmail(decoded.email) === email ? 'verified' : 'unverified';
    }
    let productId = null, product = null, variant = null;
    if (body.productId != null && body.productId !== '') {
      productId = String(body.productId).trim();
      if (productId.length > 100 || !/^[A-Za-z0-9_-]{1,100}$/.test(productId)) {
        return res.status(400).json({ ok: false, error: { code: 'INVALID_PRODUCT_ID', message: 'The selected product is invalid.' } });
      }
      try { product = await resolveProduct(db, productId); }
      catch (e) {
        console.error('lifecycle-event catalog lookup failed:', e && e.message);
        return res.status(503).json({ ok: false, error: { code: 'CATALOG_UNAVAILABLE', message: 'The selected item could not be validated right now.' } });
      }
      if (!product) return res.status(400).json({ ok: false, error: { code: 'PRODUCT_NOT_FOUND', message: 'The selected item is not available for recovery.' } });
      try { variant = authoritativeVariant(product, cleanVariant(body.variant)); }
      catch (e) { return res.status(400).json({ ok: false, error: { code: e.code, message: e.message } }); }
    } else if (eventType === 'product_view') {
      return res.status(400).json({ ok: false, error: { code: 'PRODUCT_REQUIRED', message: 'A product is required for this event.' } });
    }
    const name = cleanName(body.name || decoded.name);
    const uid = String(decoded.uid || '');
    if (!uid || uid.length > 128) return res.status(401).json({ ok: false, error: { code: 'INVALID_SESSION', message: 'Your session is invalid. Please refresh and try again.' } });
    const trustedIp = String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 128);
    const nowMs = now();
    const input = { uid, ip: trustedIp, email, eventType, productId };
    const { eventId, eventRef, controls } = makeRateControls(db, input, nowMs, configuredLimits);
    const storeUrl = canonicalStoreUrl();
    const event = {
      schemaVersion: 1, source: 'lifecycle-event-api', uid, email, recipientVerification, eventType,
      productId, productName: product ? product.name : null,
      productUrl: product ? productUrl(productId) : null,
      checkoutUrl: eventType === 'checkout_started' ? (product ? productUrl(productId) : storeUrl + '#products') : null,
      signupUrl: eventType === 'signup_started' ? storeUrl + '#signup' : null,
      name, variant, createdAt: new Date(nowMs),
      nextAttemptAt: new Date(nowMs + EVENT_DELAYS[eventType]),
      lifecycleState: 'pending', stage: 0, attempts: 0,
      lastProcessedAt: null, lastQueueMessageId: null, suppressionReason: null,
    };
    try {
      const result = await db.runTransaction(async (tx) => {
        const refs = [eventRef, ...controls.map((x) => x.ref)];
        const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
        if (snaps[0].exists) return { duplicate: true };
        for (let i = 0; i < controls.length; i++) {
          const current = snaps[i + 1].exists ? snaps[i + 1].data() || {} : {};
          if ((Number(current.count) || 0) >= controls[i].max) {
            const err = new Error('Lifecycle request limit reached.');
            err.status = 429; err.code = 'RATE_LIMITED'; throw err;
          }
        }
        for (let i = 0; i < controls.length; i++) {
          const current = snaps[i + 1].exists ? snaps[i + 1].data() || {} : {};
          tx.set(controls[i].ref, { count: (Number(current.count) || 0) + 1, windowStart: controls[i].bucketStart, updatedAt: new Date(nowMs) }, { merge: true });
        }
        tx.set(eventRef, event);
        return { duplicate: false };
      });
      return res.status(result.duplicate ? 200 : 201).json({
        ok: true, eventId, deduplicated: result.duplicate, recipientVerification,
        state: result.duplicate ? 'existing' : 'pending',
      });
    } catch (e) {
      if (e && e.status === 429) return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many recovery requests. Please try again later.' } });
      console.error('lifecycle-event transaction failed:', e && e.message);
      return res.status(503).json({ ok: false, error: { code: 'LIFECYCLE_UNAVAILABLE', message: 'Recovery could not be recorded right now.' } });
    }
  };
}
module.exports = createLifecycleHandler();
module.exports.createLifecycleHandler = createLifecycleHandler;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.EVENT_DELAYS = EVENT_DELAYS;
module.exports.normalizeEmail = normalizeEmail;
module.exports.digest = digest;
module.exports.resolveProduct = resolveProduct;
module.exports.limits = limits;
