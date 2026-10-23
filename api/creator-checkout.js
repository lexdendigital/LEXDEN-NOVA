// /api/creator-checkout.js  (PUBLIC, guests allowed, rate-limited)
//   POST {action:"reserve", productId, checkoutId, quantity?, variantKey?}  -> holds stock BEFORE Paystack opens
//   POST {action:"release", productId, checkoutId}                          -> buyer closed the payment window
// The browser then sends reservationId to /api/verify-paystack. The hold expires on its own
// (api/core/config.js RESERVATION_TTL_MS) so an abandoned checkout can never lock stock forever.
// Price is NOT decided here: verify-paystack re-checks the exact amount from the server catalogue.
const { getDb, setCors, ok, fail } = require('./creator/shared');
const inv = require('./inventory/service');

const hits = new Map();
function limited(ip, max = 30, windowMs = 60000, now = Date.now()) {
  const h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return h.length > max;
}
const safe = (s) => String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
    const ip = (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.ip) || 'unknown';
    if (limited(ip)) return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a minute.' } });
    try {
      const db = deps.db || getDb();
      const b = req.body || {};
      const productId = String(b.productId || '');
      if (!productId || productId.includes('/')) { const e = new Error('productId is required.'); e.status = 422; e.code = 'MISSING_PRODUCT'; throw e; }
      if (b.action === 'reserve') {
        const r = await inv.reserveForCheckout(db, { productId, checkoutId: b.checkoutId, quantity: b.quantity == null ? 1 : Number(b.quantity), variantKey: b.variantKey ? safe(b.variantKey) : 'default' });
        return ok(res, r);
      }
      if (b.action === 'release') {
        const id = `${safe(productId)}__${safe(b.checkoutId || '')}`;
        return ok(res, await inv.releaseReservation(db, { reservationId: id, reason: 'RELEASED' }));
      }
      const e = new Error('action must be reserve or release.'); e.status = 400; e.code = 'INVALID_ACTION'; throw e;
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.limited = limited;
