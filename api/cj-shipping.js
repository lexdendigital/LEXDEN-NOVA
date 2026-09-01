// /api/cj-shipping.js
//
// LEXDEN NOVA × CJ — freight calculation for checkout (README §19).
// Called from openDeliveryDetailsModal's flow BEFORE Paystack is opened,
// so the customer picks a real shipping method/price instead of a
// hard-coded guess. Never trust a client-supplied shipping price at
// cj-order.js time — this route's job is only to help the browser show
// honest numbers; cj-order.js re-derives the final amount server-side.
//
// CONTRACT
// POST { startCountryCode?: 'CN', endCountryCode: 'NG', products:[{ vid, quantity }] }
// Response: { ok:true, options:[{ logisticName, logisticPrice, currency,
//                                  aging, logisticAging }] }

const { setCors, cjFetch, writeSyncLog } = require('./cj-shared');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const body = req.body || {};
  const endCountryCode = String(body.endCountryCode || body.destinationCountry || 'NG').toUpperCase();
  const startCountryCode = String(body.startCountryCode || 'CN').toUpperCase();
  const products = Array.isArray(body.products) ? body.products.slice(0, 20) : [];

  if (!products.length || products.some(p => !p.vid)) {
    return res.status(200).json({ ok: false, error: 'Provide at least one product with a vid.' });
  }

  const started = Date.now();
  try {
    const r = await cjFetch('/logistic/freightCalculate', {
      method: 'POST',
      body: {
        startCountryCode,
        endCountryCode,
        products: products.map(p => ({ vid: String(p.vid), quantity: Math.max(1, parseInt(p.quantity, 10) || 1) })),
      },
    });
    const tookMs = Date.now() - started;

    if (!r.ok) {
      await writeSyncLog({ event: 'shipping.calc', success: false, message: r.message, tookMs, detail: { endCountryCode, products } });
      return res.status(200).json({
        ok: false,
        error: r.code === 'RATE_LIMITED'
          ? 'Shipping is busy right now — try again in a moment.'
          : 'No valid shipping method was returned for this destination.',
      });
    }

    const raw = Array.isArray(r.data) ? r.data : (r.data && r.data.list) || [];
    const options = raw.map(o => ({
      logisticName: o.logisticName || o.logisticNameEn || 'Standard Shipping',
      logisticPrice: o.logisticPrice != null ? Number(o.logisticPrice) : null,
      currency: 'USD',
      logisticAging: o.logisticAging || o.aging || null,
    })).filter(o => o.logisticPrice != null);

    await writeSyncLog({ event: 'shipping.calc', success: true, message: `${options.length} options`, tookMs, detail: { endCountryCode } });

    if (!options.length) {
      return res.status(200).json({ ok: false, error: 'No valid shipping method was returned for this destination.' });
    }
    return res.status(200).json({ ok: true, options });
  } catch (e) {
    await writeSyncLog({ event: 'shipping.calc', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Shipping calculation failed.' });
  }
};
