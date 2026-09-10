// /api/verify-paystack.js
//
// LEXDEN NOVA — server-side Paystack payment verification.
//
// WHY THIS EXISTS
// The frontend (index.html) can only hold Paystack's PUBLIC key — that's
// safe to expose in a browser. But "was this payment actually paid?" must
// be checked with the SECRET key, which must never reach client code.
// This function is that check: it takes a payment reference from the
// browser, asks Paystack's server directly (using the secret key from an
// environment variable) whether that reference was really paid, and only
// if Paystack confirms it does it write an "orders" document to Firestore
// and hand back a signed delivery link. The browser is never trusted on
// its own say-so.
//
// CONTRACT WITH index.html (do not change without updating both sides)
// Request:  POST { reference, uid, email, productId, productName, delivery? }
//           delivery is OPTIONAL — only sent for PHYSICAL products (see
//           openDeliveryDetailsModal/startPaystackCheckout in index.html):
//           { name, phone, address, city?, state?, country }
// Response: 200 { ok:true }                     — verified, order written
//           200 { ok:false, error:'...' }        — not verified yet / failed
//           (any other status is treated by the client as "pending" too)
//
// ENVIRONMENT VARIABLES REQUIRED (Render → Service → Environment)
//   PAYSTACK_SECRET_KEY     sk_live_xxxx or sk_test_xxxx, from Paystack
//                            Dashboard → Settings → API Keys & Webhooks
//   FIREBASE_PROJECT_ID      "lexden-nova" (from firebaseConfig.projectId
//                            in index.html)
//   FIREBASE_CLIENT_EMAIL    from a Firebase service account JSON
//                            (Firebase Console → Project settings →
//                            Service accounts → Generate new private key)
//   FIREBASE_PRIVATE_KEY     from the same service account JSON. Render's
//                            UI stores newlines as literal "\n" — this file
//                            converts them back automatically, so paste the
//                            key exactly as it appears in the JSON,
//                            including "-----BEGIN PRIVATE KEY-----".
//
// This file uses firebase-admin, which is NOT the same package as the
// firebase/* SDK the browser uses. It must be installed as a dependency
// (see package.json).
//
// CONVERTED FOR RENDER (from the original Vercel version):
//   - ESM `import` → CommonJS `require` (Render runs this file directly
//     with plain `node server.js`, no build step to transpile ESM).
//   - Vercel's `waitUntil()` (from `@vercel/functions`, which kept a
//     serverless function alive briefly after the response to finish
//     background work) is gone — Render's free Web Service is a normal
//     always-on Node process, so a "fire and forget" async call (just
//     invoking the function without awaiting it) keeps running just fine
//     on its own; nothing freezes the process after the response is sent.
//   - The CJ-order background trigger used to build its own URL from
//     Vercel's auto-injected `VERCEL_URL`. Render has no equivalent for a
//     same-process call, so this now calls cj-order.js's handler directly
//     in-process (a plain function call with a fake req/res) instead of
//     making a real HTTP round trip to itself — simpler and one less
//     thing that can fail (no self-networking, no URL to configure).

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { queueEmailBackground } = require('./email-shared');
const cjOrderHandler = require('./cj-order');

// Mirrors PAYSTACK_CHARGEABLE_CURRENCIES in index.html. Keep these two
// lists identical — see the comment above that array in index.html.
const PAYSTACK_CHARGEABLE_CURRENCIES = ['NGN', 'USD'];

// FIX: previously this function only asked "was this reference really
// paid?" — it never checked "...for the right amount." Paystack confirms
// a reference was paid, but the amount charged is chosen client-side
// (index.html's startPaystackCheckout). A tampered client could still
// open a genuine, verifiable Paystack payment for far less than the
// product's real price. This reads the product's real price straight
// from Firestore's public REST API (same trusted pattern used by
// api/_shared.js) and rejects underpayment before writing the order.
const FIRESTORE_PROJECT = 'lexden-nova';

function fsValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsValue);
  if ('mapValue' in v) return fsFields(v.mapValue.fields || {});
  return null;
}
function fsFields(fields) {
  const out = {};
  for (const k in fields) out[k] = fsValue(fields[k]);
  return out;
}

// Fetches `catalog/{docId}` via Firestore's public REST API. Returns null
// (never throws) on any failure — callers must decide what "couldn't
// verify" means for their own logic.
async function getCatalogDoc(docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/catalog/${docId}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.fields) return null;
    return fsFields(data.fields);
  } catch {
    return null;
  }
}

// Returns the amount (in `currency`'s major unit) this product should
// have cost at checkout time, using the same formula as index.html's
// startPaystackCheckout: (salePrice || price) * exchangeRates[currency].
// Returns null if the real price genuinely can't be determined server-
// side (missing catalog/settings, unknown product, etc.) — callers treat
// null as "can't validate" rather than "free", so a lookup failure never
// accidentally lets a payment through.
async function getExpectedAmount(productId, currency) {
  const [productsDoc, settingsDoc] = await Promise.all([
    getCatalogDoc('products'),
    getCatalogDoc('settings'),
  ]);
  const list = productsDoc && Array.isArray(productsDoc.list) ? productsDoc.list : null;
  const product = list && list.find(p => p && String(p.id) === String(productId));
  if (!product) return null;
  if (product.free) return 0;

  const rates = settingsDoc && settingsDoc.exchangeRates;
  const rate = (rates && typeof rates[currency] === 'number') ? rates[currency] : 1;
  const basePrice = (typeof product.salePrice === 'number' ? product.salePrice : product.price);
  if (typeof basePrice !== 'number') return null;
  return Math.round(basePrice * rate);
}

// ---- Firebase Admin init (once per process) ----
function getDb() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Render's env var UI flattens real newlines to the two characters
    // "\" + "n". Firebase Admin needs actual newline bytes in the PEM key,
    // so this restores them before use.
    // Env vars are sometimes pasted with a wrapping pair of quotes left
    // in from copying the JSON field verbatim (e.g. "-----BEGIN...") —
    // strip those before the \n restore, or cert() throws "Invalid PEM
    // formatted message" even though the key content itself is correct.
    let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      rawKey = rawKey.slice(1, -1);
    }
    const privateKey = rawKey.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Missing Firebase Admin env vars. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Render → ' +
        'Service → Environment.'
      );
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getFirestore();
}

// ---- Order/admin emails ----
// UPDATE (email-reliability system): this used to be an inline, unbounded
// Brevo fetch AWAITED before responding to the shopper — meaning a slow
// Brevo call directly delayed the "your payment is verified" response for
// a customer who has already paid. That's backwards: the payment is the
// thing that must be fast and certain; the email is important but
// secondary. This calls email-shared.js's queueEmailBackground(), which
// fires the send in the background (see email-shared.js's own comments —
// it already tries @vercel/functions' waitUntil() and falls back to a
// plain un-awaited call, which is exactly what a normal Node process
// needs) — capped at 4s per attempt with one fast retry, and auto-queued
// to Firestore for background retry (via /api/process-email-queue.js) if
// both attempts fail. Nothing here can delay or fail the payment-
// verification response, and no email is ever silently dropped.
function sendBrevoTemplate(templateEnvKeySuffix, to, params) {
  // templateEnvKeySuffix here is the same "ORDER"/"ADMIN" style suffix the
  // old BREVO_TPL_* env-var name used — email-shared expects the lowercase
  // templateKey (it builds BREVO_TPL_<KEY> itself), so map it down once.
  const templateKey = String(templateEnvKeySuffix).replace(/^BREVO_TPL_/, '').toLowerCase();
  queueEmailBackground({ templateKey, to, params });
}

module.exports = async function handler(req, res) {
  // CORS: index.html is hosted on GitHub Pages and may change host again
  // later, so this allows any origin to POST — the security boundary here
  // is the secret key + Paystack verification, never the origin header,
  // so this is safe to leave open.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed — use POST.' });
  }

  const { reference, uid, email, productId, productName, delivery } = req.body || {};

  if (!reference || typeof reference !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing payment reference.' });
  }
  if (!productId) {
    return res.status(400).json({ ok: false, error: 'Missing productId.' });
  }
  // PHYSICAL-COMMERCE ADDITION: `delivery` is optional and only ever sent
  // by index.html for productType === 'PHYSICAL' items (see
  // openDeliveryDetailsModal / startPaystackCheckout). Digital purchases
  // never send it, so this validation only ever runs for physical orders
  // — nothing here can affect the existing digital checkout path.
  let deliveryDetails = null;
  if (delivery && typeof delivery === 'object') {
    const { name, phone, address, city, state, country } = delivery;
    if (name && phone && address && country) {
      deliveryDetails = {
        name: String(name).slice(0, 200),
        phone: String(phone).slice(0, 40),
        address: String(address).slice(0, 500),
        city: city ? String(city).slice(0, 120) : null,
        state: state ? String(state).slice(0, 120) : null,
        country: String(country).slice(0, 120),
      };
    } else {
      console.warn('verify-paystack: delivery object present but missing required fields — order will be saved without it.');
    }
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error('PAYSTACK_SECRET_KEY is not set in environment variables.');
    return res.status(500).json({ ok: false, error: 'Payment verification is not configured on the server yet.' });
  }

  let db;
  try {
    db = getDb();
  } catch (e) {
    console.error('Firebase Admin init failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Server could not connect to the database.' });
  }

  // ---- Idempotency: if this reference was already verified and an order
  // already exists for it, don't re-charge logic or write a duplicate order
  // — just confirm success again. This makes the endpoint safe to call
  // repeatedly, which matters because the client auto-retries pending
  // payments (see bumpPendingAttempt / removePendingPayment in index.html).
  try {
    const existing = await db.collection('orders').doc(reference).get();
    if (existing.exists) {
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    console.error('Firestore existing-order check failed:', e.message);
    // Not fatal — fall through and let Paystack verification + the write
    // below be the source of truth.
  }

  // ---- Ask Paystack directly whether this reference was really paid.
  // This is the one call in the whole flow that can be trusted — it uses
  // the secret key, which only this server (never the browser) has.
  let paystackData;
  try {
    const psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const psJson = await psRes.json();
    if (!psRes.ok || !psJson.status) {
      return res.status(200).json({
        ok: false,
        error: psJson.message || 'Paystack could not find or verify this transaction.',
      });
    }
    paystackData = psJson.data;
  } catch (e) {
    console.error('Paystack verify request failed:', e.message);
    return res.status(200).json({ ok: false, error: 'Could not reach Paystack right now — this will retry automatically.' });
  }

  // ---- Check the transaction actually succeeded and matches what the
  // client claims it paid for. Never trust amount/currency/reference from
  // the request body alone — everything decisive comes from paystackData.
  if (paystackData.status !== 'success') {
    return res.status(200).json({
      ok: false,
      error: `Payment status is "${paystackData.status}" — not yet successful.`,
    });
  }

  const paidCurrency = paystackData.currency;
  if (!PAYSTACK_CHARGEABLE_CURRENCIES.includes(paidCurrency)) {
    console.warn(`Verified payment in unexpected currency: ${paidCurrency}`);
  }

  const amountMajor = paystackData.amount / 100;

  // ---- Reject underpayment. A verified-paid reference alone isn't proof
  // the shopper paid the RIGHT amount — only that some amount was paid.
  const expectedAmount = await getExpectedAmount(productId, paidCurrency);
  if (expectedAmount !== null) {
    const tolerance = Math.max(1, Math.ceil(expectedAmount * 0.02)); // 2%, min 1 unit
    if (amountMajor < expectedAmount - tolerance) {
      console.warn(
        `Underpayment blocked: ref=${reference} product=${productId} ` +
        `paid=${amountMajor} ${paidCurrency} expected~=${expectedAmount} ${paidCurrency}`
      );
      return res.status(200).json({
        ok: false,
        error: 'Paid amount does not match this product\'s price. This payment was not fulfilled — contact support with your reference.',
      });
    }
  } else {
    console.warn(`Could not validate price for product ${productId} — NOT fulfilling (catalog lookup failed), will retry.`);
    return res.status(200).json({
      ok: false,
      error: 'Could not confirm this product\'s price yet — this will retry automatically. Contact support if it doesn\'t resolve shortly.',
    });
  }

  try {
    await db.collection('orders').doc(reference).set({
      uid: uid || null,
      email: email || paystackData.customer?.email || null,
      productId,
      productName: productName || null,
      paystackReference: reference,
      amount: amountMajor,
      currency: paidCurrency,
      status: 'paid',
      timestamp: FieldValue.serverTimestamp(),
      paystackChannel: paystackData.channel || null,
      paidAt: paystackData.paid_at || null,
      delivery: deliveryDetails,
    });
  } catch (e) {
    console.error('Firestore order write failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Payment verified but the order could not be saved — contact support with this reference.' });
  }

  // ---- Order confirmation (to shopper) + admin notification — fired in
  // the background (not awaited) so a slow/down Brevo can never delay or
  // affect this already-successful payment response.
  const buyerEmail = email || paystackData.customer?.email;
  const orderDate = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) + ' WAT';
  if (buyerEmail) {
    sendBrevoTemplate('BREVO_TPL_ORDER', { email: buyerEmail }, {
      order_id: reference,
      product_name: productName || 'Digital product',
      quantity: '1',
      amount: `${paidCurrency} ${amountMajor.toLocaleString()}`,
      payment_status: 'Paid',
      order_date: orderDate,
    });
  }
  sendBrevoTemplate('BREVO_TPL_ADMIN', { email: process.env.ADMIN_NOTIFY_EMAIL || 'lexdendigital@gmail.com' }, {
    event_type: 'New order',
    reference_id: reference,
    user_email: buyerEmail || 'Unknown',
    event_time: orderDate,
    priority: 'Normal',
    details: `${productName || productId} — ${paidCurrency} ${amountMajor.toLocaleString()}`,
  });

  // ---- PHYSICAL-COMMERCE: hand off to CJ order creation. Deliberately
  // fired the same way as the emails above (not awaited) — the shopper's
  // "payment verified" response must not wait on a CJ API round trip.
  // cj-order.js is idempotent on `reference`, so it is always safe to
  // call here even if the shopper's own browser also calls it directly
  // right after this response comes back.
  if (deliveryDetails) {
    createCjOrderInBackground(reference).catch(e => console.error('cj-order background trigger failed:', e.message));
  }

  return res.status(200).json({ ok: true });
};

// Calls cj-order.js's own handler directly, in-process, with a minimal
// fake req/res — the exact same code path the browser's own direct POST
// to /api/cj-order would run, just invoked as a plain function call
// instead of a real HTTP round trip. (The original Vercel version made a
// real HTTP call to itself via `https://${VERCEL_URL}/api/cj-order`;
// Render has no equivalent auto-injected URL for a same-process call, and
// an in-process call is simpler and one less thing that can fail.)
async function createCjOrderInBackground(reference) {
  const fakeReq = { method: 'POST', headers: {}, body: { reference } };
  const fakeRes = {
    _status: 200,
    status(code) { this._status = code; return this; },
    setHeader() { return this; },
    json(payload) {
      if (this._status >= 400) {
        console.error('cj-order background call failed:', this._status, JSON.stringify(payload));
      }
      return this;
    },
    end() { return this; },
  };
  await cjOrderHandler(fakeReq, fakeRes);
}
