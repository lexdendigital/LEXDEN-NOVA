// api/delivery/proof.js
//
// Delivery proof by one-time code. The code is the BUYER's secret:
//   * 6 characters, alphabet without O/0/I/1, generated with crypto.randomInt.
//   * Stored ONLY as an HMAC (DELIVERY_CODE_SECRET). Shown once, to the buyer, in the response that
//     issues it. It is never written to a fulfilment, sale, log, creator/rider/MCP payload.
//   * ~10 minute expiry, single use, 5 wrong attempts then LOCKED (re-issue by the buyer or an admin).
//   * A rider enters the code the recipient reads out. The rider holds a task-bound token (rider
//     vault): valid for ONE order, expiring, revocable; it carries no code and no buyer data. The
//     vault is OFF until RIDER_VAULT_ENABLED=true.
//   * A recipient the buyer explicitly authorised produces RECIPIENT_CODE evidence, never BUYER_CODE.
//   * A correct code records delivery evidence + moves SHIPPED -> DELIVERED, which starts the
//     dispute/earning clock. A wrong guess never does.
//   * If a code cannot be used (no phone, lost, dispute), report a problem: this opens an order
//     exception and holds earnings. Nothing is auto-released.
const crypto = require('crypto');
const cfg = require('../core/config');
const checkout = require('../creator/checkout');
const F = require('../creator/fulfillment');
const { FULFILLMENT_STATES, assertFulfillmentTransition } = require('../creator/fulfillment-state-machine');

const { ALPHABET, LENGTH, TTL_MS, MAX_FAILED_ATTEMPTS } = cfg.DELIVERY_CODE;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120);

function secretOf(env = process.env) {
  const s = env.DELIVERY_CODE_SECRET;
  if (!s || String(s).length < 24) throw err(503, 'DELIVERY_CODE_NOT_CONFIGURED', 'Delivery codes are not configured on the server (DELIVERY_CODE_SECRET).');
  return String(s);
}
function generateCode(rand = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[rand(0, ALPHABET.length)];
  return out;
}
const normalise = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '');
const hashCode = (orderId, code, secret) => crypto.createHmac('sha256', secret).update(`${orderId}:${normalise(code)}`).digest('hex');
const hashToken = (t, secret) => crypto.createHmac('sha256', secret).update(`task:${t}`).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Buyer-side: only the buyer on the order can get a code, and only while the parcel is in transit. */
async function issueCode(db, { orderId, buyerUid, ttlMs = TTL_MS, nowMs = Date.now(), env = process.env, rand }) {
  const secret = secretOf(env);
  const f = await db.collection('fulfillments').doc(orderId).get();
  if (!f.exists || !buyerUid || f.data().buyerUid !== buyerUid) throw err(404, 'NOT_FOUND', 'Order not found.');
  if (f.data().status !== FULFILLMENT_STATES.SHIPPED) throw err(409, 'NOT_IN_TRANSIT', 'A delivery code is available once your order has been shipped.');
  const code = generateCode(rand);
  const ref = db.collection('deliveryCodes').doc(safeId(orderId));
  const prev = await ref.get();
  const keep = prev.exists ? { recipient: prev.data().recipient || null } : { recipient: null };
  await ref.set({ orderId, buyerUid, codeHash: hashCode(orderId, code, secret), state: 'ACTIVE', failedAttempts: 0, issuedAtMs: nowMs, expiresAtMs: nowMs + ttlMs, usedAtMs: null, ...keep, issueCount: ((prev.exists && prev.data().issueCount) || 0) + 1 });
  return { code, expiresAtMs: nowMs + ttlMs, length: LENGTH };
}

/** Buyer names a person allowed to receive the parcel. Their code entry = RECIPIENT_CODE evidence. */
async function authoriseRecipient(db, { orderId, buyerUid, name, phone = null, nowMs = Date.now() }) {
  const f = await db.collection('fulfillments').doc(orderId).get();
  if (!f.exists || !buyerUid || f.data().buyerUid !== buyerUid) throw err(404, 'NOT_FOUND', 'Order not found.');
  const n = String(name || '').trim();
  if (n.length < 2) throw err(422, 'NAME_REQUIRED', 'Enter the name of the person authorised to receive this order.');
  await db.collection('deliveryCodes').doc(safeId(orderId)).set({ orderId, buyerUid, recipient: { authorised: true, name: n.slice(0, 80), phoneLast4: phone ? String(phone).replace(/\D/g, '').slice(-4) : null, authorisedAtMs: nowMs } }, { merge: true });
  return { authorised: true, name: n.slice(0, 80) };
}

/** Admin creates a task-bound token for a rider. Shown once; only its hash is stored. */
async function issueRiderTask(db, { orderId, riderId, ttlMs = 6 * 3600 * 1000, nowMs = Date.now(), env = process.env, issuedBy }) {
  const secret = secretOf(env);
  if (!riderId) throw err(422, 'RIDER_REQUIRED', 'riderId is required.');
  const f = await db.collection('fulfillments').doc(orderId).get();
  if (!f.exists) throw err(404, 'NOT_FOUND', 'Order not found.');
  const token = crypto.randomBytes(24).toString('base64url');
  const id = `${safeId(orderId)}__${safeId(riderId)}`;
  await db.collection('riderTasks').doc(id).set({ orderId, riderId, tokenHash: hashToken(token, secret), state: 'ACTIVE', createdAtMs: nowMs, expiresAtMs: nowMs + ttlMs, issuedBy: issuedBy || null, attempts: 0 });
  return { taskId: id, token, expiresAtMs: nowMs + ttlMs };
}
async function revokeRiderTask(db, { taskId, by, nowMs = Date.now() }) {
  await db.collection('riderTasks').doc(taskId).set({ state: 'REVOKED', revokedBy: by || null, revokedAtMs: nowMs }, { merge: true });
  return { revoked: true };
}

/**
 * Checks a code. Failure outcomes are RETURNED (and the attempt counter persisted), never thrown, so a
 * wrong guess is always counted. On success: delivery evidence + SHIPPED -> DELIVERED.
 * enteredBy: { type: 'RIDER'|'RECIPIENT', taskId?, taskToken? }
 */
async function verifyCode(db, { orderId, code, enteredBy = {}, asRecipient = false, nowMs = Date.now(), env = process.env }) {
  const secret = secretOf(env);
  if (enteredBy.type === 'RIDER') {
    if (!cfg.flags(env).riderVaultEnabled) throw err(503, 'RIDER_VAULT_DISABLED', 'Rider code entry is not enabled yet.');
    const tRef = db.collection('riderTasks').doc(String(enteredBy.taskId || '_'));
    const t = await tRef.get();
    const td = t.exists ? t.data() : null;
    if (!td || td.orderId !== orderId || td.state !== 'ACTIVE' || td.expiresAtMs <= nowMs || !safeEq(td.tokenHash, hashToken(String(enteredBy.taskToken || ''), secret))) {
      throw err(403, 'TASK_NOT_VALID', 'This delivery task is not valid for this order.');
    }
  }
  const pre = await db.collection('fulfillments').doc(orderId).get();
  if (!pre.exists || ![FULFILLMENT_STATES.SHIPPED, FULFILLMENT_STATES.DELIVERED].includes(pre.data().status)) return { ok: false, code: 'ORDER_NOT_IN_TRANSIT' };
  const ref = db.collection('deliveryCodes').doc(safeId(orderId));
  const outcome = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (!d || !d.codeHash) return { ok: false, code: 'NO_ACTIVE_CODE' };
    if (d.state === 'USED') return { ok: false, code: 'ALREADY_USED' };
    if (d.state === 'LOCKED') return { ok: false, code: 'LOCKED' };
    if (d.state !== 'ACTIVE') return { ok: false, code: 'NO_ACTIVE_CODE' };
    if (d.expiresAtMs <= nowMs) { tx.set(ref, { state: 'EXPIRED' }, { merge: true }); return { ok: false, code: 'EXPIRED' }; }
    if (asRecipient && !(d.recipient && d.recipient.authorised)) return { ok: false, code: 'RECIPIENT_NOT_AUTHORISED' };
    if (!safeEq(d.codeHash, hashCode(orderId, code, secret))) {
      const n = (d.failedAttempts || 0) + 1;
      const locked = n >= MAX_FAILED_ATTEMPTS;
      tx.set(ref, { failedAttempts: n, ...(locked ? { state: 'LOCKED', lockedAtMs: nowMs } : {}) }, { merge: true });
      return { ok: false, code: locked ? 'LOCKED' : 'WRONG_CODE', attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - n) };
    }
    tx.set(ref, { state: 'USED', usedAtMs: nowMs, usedBy: enteredBy.type || 'UNKNOWN', usedViaTask: enteredBy.taskId || null }, { merge: true });
    return { ok: true, source: asRecipient ? cfg.EVIDENCE_SOURCES.RECIPIENT_CODE : cfg.EVIDENCE_SOURCES.BUYER_CODE };
  });
  if (!outcome.ok) return outcome;
  const f = await db.collection('fulfillments').doc(orderId).get();
  if (f.exists && f.data().status === FULFILLMENT_STATES.SHIPPED) {
    assertFulfillmentTransition(FULFILLMENT_STATES.SHIPPED, FULFILLMENT_STATES.DELIVERED);
    await F.applyFulfillmentPatch(db, orderId, FULFILLMENT_STATES.DELIVERED, { deliveryEvidenceSource: outcome.source, deliveryConfirmedBy: 'buyer' });
  } else {
    await F.recordDeliveryEvidence(db, orderId, { source: outcome.source, atMs: nowMs, reference: `code:${safeId(orderId)}` });
  }
  return { ok: true, source: outcome.source };
}

/** "My code does not work / nobody came / wrong person": opens an exception and holds earnings. */
async function reportProblem(db, { orderId, reportedBy, role = 'BUYER', reason, nowMs = Date.now() }) {
  const f = await db.collection('fulfillments').doc(orderId).get();
  if (!f.exists) throw err(404, 'NOT_FOUND', 'Order not found.');
  if (role === 'BUYER' && f.data().buyerUid !== reportedBy) throw err(404, 'NOT_FOUND', 'Order not found.');
  const r = String(reason || '').trim();
  if (r.length < 5) throw err(422, 'REASON_REQUIRED', 'Please describe what went wrong.');
  const ex = await checkout.openException(db, { orderId, code: 'DELIVERY_PROOF_PROBLEM', creatorId: f.data().creatorId, productId: f.data().productId, buyerUid: f.data().buyerUid, details: { role, reason: r.slice(0, 500) }, nowMs });
  await db.collection('fulfillments').doc(orderId).update({ exceptionOpen: true });
  await db.collection('creatorSales').doc(orderId).update({ exceptionOpen: true }).catch(() => {});
  return { opened: ex.created, exceptionId: ex.id };
}

module.exports = { generateCode, hashCode, normalise, issueCode, authoriseRecipient, issueRiderTask, revokeRiderTask, verifyCode, reportProblem, MAX_FAILED_ATTEMPTS, TTL_MS };
