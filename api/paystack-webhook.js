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

// Maps a refund.* event onto OUR refund record(s) for that transaction. Replays and
// out-of-order events are safe (api/core/refunds.js ignores a stale/earlier status).
async function handleRefundEvent(evt, deps = {}) {
  const d = (evt && evt.data) || {};
  const txRef = d.transaction_reference || (d.transaction && d.transaction.reference) || null;
  const status = d.status || String(evt.event).slice('refund.'.length);
  if (!txRef) return { handled: false, reason: 'NO_TRANSACTION_REFERENCE' };
  const R = require('./core/refunds');
  const db = deps.db || require('./creator/shared').getDb();
  const snap = await db.collection('refunds').where('paymentReference', '==', String(txRef)).limit(20).get();
  let applied = 0;
  // Only refunds NOVA has actually SENT to the provider can be advanced by a provider event (never
  // APPROVED / AWAITING_MANUAL_STEP / COMPLETED), and the event must be matched to ONE refund:
  // by the provider's refund id when we hold it, otherwise by exact amount. Ambiguous => do nothing.
  const sent = snap.docs.filter((d) => [R.STATES.PROVIDER_INITIATED, R.STATES.PROCESSING, R.STATES.REQUIRES_REVIEW, R.STATES.FAILED].includes(d.data().state));
  const evtIds = [d.id, d.refund_reference, d.reference].filter((x) => x != null).map(String);
  let matched = sent.filter((x) => x.data().providerRefundId && evtIds.includes(String(x.data().providerRefundId)));
  if (!matched.length && Number.isFinite(Number(d.amount))) matched = sent.filter((x) => x.data().amountMinor === Number(d.amount));
  // An event that identifies nothing (no id, no amount) can only be applied when exactly one refund is in flight.
  if (!matched.length && !evtIds.length && !Number.isFinite(Number(d.amount)) && sent.length === 1) matched = sent;
  if (matched.length !== 1) { console.warn(`paystack refund event for ${txRef} matched ${matched.length} refund(s); ignored`); return { handled: false, reason: matched.length ? 'AMBIGUOUS_MATCH' : 'NO_MATCHING_REFUND' }; }
  for (const doc of matched) {
    const out = await R.applyProviderStatus(db, doc.id, status, { by: 'paystack-webhook' });
    if (out.changed) applied += 1;
    if (out.refund && out.refund.disputeId) {
      const patch = { refundState: out.refund.state };
      if (out.refund.state === R.STATES.COMPLETED) { patch.buyerRefundPaid = true; patch.refundCompletedAtMs = out.refund.providerConfirmedAtMs; }
      await db.collection('creatorDisputes').doc(out.refund.disputeId).set(patch, { merge: true }).catch(() => {});
    }
  }
  return { handled: true, applied };
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
  // Refund lifecycle events (refund.pending | processing | needs-attention | failed | processed).
  if (evt && typeof evt.event === 'string' && evt.event.startsWith('refund.')) {
    try { await handleRefundEvent(evt, deps); } catch (e) { console.error('paystack-webhook refund event failed:', e.message); }
    return;
  }
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
module.exports.handleRefundEvent = handleRefundEvent;
