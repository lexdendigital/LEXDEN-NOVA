// /api/paystack-webhook.js
//
// Paystack -> NOVA server-to-server confirmation. Makes a payment confirm
// even when the buyer's browser never calls /api/verify-paystack (tab closed,
// signal dropped right after the Paystack popup, phone locked). Same
// fulfilment code path as the browser call, so the outcome is identical, and
// it is idempotent: browser + webhook racing yields ONE order.
//
// SETUP (one time): Paystack Dashboard -> Settings -> API Keys & Webhooks ->
//   Webhook URL (live AND test):  https://lexden-nova.onrender.com/api/paystack-webhook
//
// SECURITY: the body is accepted only if its x-paystack-signature equals
// HMAC-SHA512(rawBody, <one of our configured Paystack secret keys>)
// (constant-time compare). Even then nothing in the payload is trusted for
// money: verify-paystack.js re-asks Paystack for the transaction itself.
const crypto = require('crypto');
const { paystackKeyCandidates } = require('./_paystackMode');

function readRaw(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureValid(raw, signature, keys) {
  if (!signature || typeof signature !== 'string') return false;
  const sig = Buffer.from(signature, 'utf8');
  return keys.some((k) => {
    const mac = Buffer.from(crypto.createHmac('sha512', k).update(raw).digest('hex'), 'utf8');
    return mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
  });
}

// Runs verify-paystack's handler in-process (same trick as cj-order).
async function confirm(body, deps = {}) {
  const handler = deps.verifyHandler || require('./verify-paystack');
  const req = { method: 'POST', headers: {}, body, query: {} };
  let out = { status: 200, body: null };
  const res = {
    setHeader() { return this; },
    status(c) { out.status = c; return this; },
    json(p) { out.body = p; return this; },
    end() { return this; },
  };
  await handler(req, res);
  return out;
}

function bodyFromEvent(evt) {
  const d = (evt && evt.data) || {};
  const m = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
  if (!d.reference || !m.productId) return null; // not a NOVA checkout
  return {
    reference: String(d.reference),
    uid: m.uid && m.uid !== 'guest' ? String(m.uid) : null,
    email: (d.customer && d.customer.email) || null,
    productId: String(m.productId),
    productName: m.productName || null,
    ...(m.variantId ? { variantId: String(m.variantId) } : {}),
    ...(m.delivery && typeof m.delivery === 'object' ? { delivery: m.delivery } : {}),
  };
}

async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let raw;
  try { raw = await readRaw(req); } catch { return res.status(400).json({ ok: false }); }
  const keys = await (deps.keys ? deps.keys() : paystackKeyCandidates());
  if (!keys.length || !signatureValid(raw, req.headers && req.headers['x-paystack-signature'], keys)) {
    return res.status(401).json({ ok: false });
  }
  let evt;
  try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ ok: false }); }

  // Acknowledge FAST (Paystack retries on slow/non-2xx), then work.
  res.status(200).json({ ok: true });
  if (!evt || evt.event !== 'charge.success') return;
  const body = bodyFromEvent(evt);
  if (!body) return;
  try {
    const r = await confirm(body, deps);
    if (!r.body || r.body.ok !== true) console.warn(`paystack-webhook: ${body.reference} not confirmed:`, r.body && r.body.error);
    else console.log(`paystack-webhook: ${body.reference} confirmed`);
  } catch (e) {
    console.error('paystack-webhook processing failed:', e.message);
  }
}

module.exports = handler;
module.exports.signatureValid = signatureValid;
module.exports.bodyFromEvent = bodyFromEvent;
