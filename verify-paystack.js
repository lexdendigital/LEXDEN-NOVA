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
// ENVIRONMENT VARIABLES REQUIRED (Vercel → Settings → Environment Variables)
//   PAYSTACK_SECRET_KEY     sk_live_xxxx or sk_test_xxxx, from Paystack
//                            Dashboard → Settings → API Keys & Webhooks
//   FIREBASE_PROJECT_ID      "lexden-nova" (from firebaseConfig.projectId
//                            in index.html)
//   FIREBASE_CLIENT_EMAIL    from a Firebase service account JSON
//                            (Firebase Console → Project settings →
//                            Service accounts → Generate new private key)
//   FIREBASE_PRIVATE_KEY     from the same service account JSON. Vercel's
//                            UI stores newlines as literal "\n" — this file
//                            converts them back automatically, so paste the
//                            key exactly as it appears in the JSON,
//                            including "-----BEGIN PRIVATE KEY-----".
//
// This file uses firebase-admin, which is NOT the same package as the
// firebase/* SDK the browser uses. It must be installed as a dependency
// (see package.json) — Vercel installs it automatically on deploy.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { queueEmailBackground } from './email-shared.js';
import { waitUntil } from '@vercel/functions';

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

// ---- Firebase Admin init (once per warm serverless instance) ----
function getDb() {
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Vercel's env var UI flattens real newlines to the two characters
    // "\" + "n". Firebase Admin needs actual newline bytes in the PEM key,
    // so this restores them before use.
    // Vercel env vars are sometimes pasted with a wrapping pair of quotes
    // left in from copying the JSON field verbatim (e.g. "-----BEGIN...")
    // — strip those before the \n restore, or cert() throws "Invalid PEM
    // formatted message" even though the key content itself is correct.
    let rawKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      rawKey = rawKey.slice(1, -1);
    }
    const privateKey = rawKey.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Missing Firebase Admin env vars. Set FIREBASE_PROJECT_ID, ' +
        'FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in Vercel → ' +
        'Settings → Environment Variables.'
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
// secondary. This now calls email-shared.js's queueEmailBackground(),
// which fires the send through Vercel's waitUntil() AFTER this function
// has already returned its response — capped at 4s per attempt with one
// fast retry, and auto-queued to Firestore for background retry (via
// /api/process-email-queue.js) if both attempts fail. Nothing here can
// delay or fail the payment-verification response, and no email is ever
// silently dropped.
function sendBrevoTemplate(templateEnvKeySuffix, to, params) {
  // templateEnvKeySuffix here is the same "ORDER"/"ADMIN" style suffix the
  // old BREVO_TPL_* env-var name used — email-shared expects the lowercase
  // templateKey (it builds BREVO_TPL_<KEY> itself), so map it down once.
  const templateKey = String(templateEnvKeySuffix).replace(/^BREVO_TPL_/, '').toLowerCase();
  queueEmailBackground({ templateKey, to, params });
}

export default async function handler(req, res) {
  // CORS: index.html can be hosted on GitHub Pages or Vercel, and may
  // change host again later, so this allows any origin to POST — the
  // security boundary here is the secret key + Paystack verification,
  // never the origin header, so this is safe to leave open.
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
  // — nothing here can affect the existing digital checkout path. Kept as
  // a light shape check (not a hard schema) since the automation side
  // (see the "WEBSITE ↔ AUTOMATION HANDOFF" section of the physical-
  // commerce doc) just needs these fields present when they're expected,
  // not a strict contract enforced here.
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
    // below be the source of truth. Worst case we attempt a duplicate
    // write, which the .doc(reference) below turns into a harmless
    // overwrite rather than a second document.
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
      // Paystack itself says this reference doesn't check out (wrong ref,
      // not found, etc.) — NOT the same as "still processing".
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
    // Shouldn't happen if index.html's PAYSTACK_CHARGEABLE_CURRENCIES stays
    // in sync with this file's copy, but guard against a stale deploy.
    console.warn(`Verified payment in unexpected currency: ${paidCurrency}`);
  }

  // ---- Look up the product server-side so delivery info (fileUrl /
  // deliveryLink) can't be spoofed by a tampered client request. Falls
  // back to trusting the client-sent productId/productName for the order
  // record if no server-side product catalog is available; but the
  // delivery link itself should come from your own product source of
  // truth if you keep one in Firestore. If your product catalog for this
  // app lives only in index.html's DB.products (not Firestore), delivery
  // links are resolved client-side already — this function's job here is
  // strictly the payment truth-check + order record, which is the part
  // that must never trust the browser.
  const amountMajor = paystackData.amount / 100;

  // ---- Reject underpayment. A verified-paid reference alone isn't proof
  // the shopper paid the RIGHT amount — only that some amount was paid.
  // Compare what was actually charged against the catalog price computed
  // the same way the checkout button computed it. A small tolerance
  // absorbs legit Math.round() drift and exchange-rate updates between
  // checkout and verification; anything below that is treated as tampering.
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
    // SECURITY FIX (roadmap 3.5 — never fulfill when price validation
    // fails): this used to fulfill anyway here ("continue on lookup
    // hiccup") — exactly the pattern the roadmap calls out as unsafe. A
    // failed catalog lookup means we genuinely don't know the right price,
    // so we can't rule out underpayment; fulfilling on that basis is a
    // real gap, not just a defensive nicety. Returning ok:false instead
    // is safe to do here specifically because: (a) this endpoint is
    // idempotent — see the existing-order check above — so nothing is
    // lost by not writing yet, and (b) the client already auto-retries
    // pending payments (bumpPendingAttempt/removePendingPayment in
    // index.html), so a transient catalog-fetch blip resolves itself on
    // the next automatic retry instead of silently shipping an unpriced
    // order.
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
      // PHYSICAL-COMMERCE ADDITION: null for every existing/digital order —
      // only populated when the shopper actually filled the delivery
      // modal for a PHYSICAL product. This is exactly the shape the
      // automation handoff doc's order-fields section expects, stored
      // right on the order doc rather than only inside Paystack's own
      // metadata, so it's queryable from Firestore for fulfillment.
      delivery: deliveryDetails,
    });
  } catch (e) {
    console.error('Firestore order write failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Payment verified but the order could not be saved — contact support with this reference.' });
  }

  // ---- Order confirmation (to shopper) + admin notification — see the
  // sendBrevoTemplate comment above: these are fired via waitUntil() and
  // deliberately NOT awaited here, so a slow/down Brevo can never delay
  // or affect this already-successful payment response. Delivery is still
  // guaranteed (fast retry + background queue), just decoupled from this
  // response's timing.
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

  // ---- PHYSICAL-COMMERCE: hand off to CJ order creation. This is the
  // "Create CJ order" step of README §20's checkout chain. Deliberately
  // fired the same way as the emails above (waitUntil, not awaited) — the
  // shopper's "payment verified" response must not wait on a CJ API round
  // trip. cj-order.js is idempotent on `reference` (README §21), so it is
  // always safe to call here even if the shopper's own browser also calls
  // it directly right after this response comes back.
  if (deliveryDetails) {
    waitUntil(createCjOrderInBackground(reference).catch(e => console.error('cj-order background trigger failed:', e.message)));
  }

  return res.status(200).json({ ok: true });
}

// Calls this same Vercel deployment's /api/cj-order internally over HTTP
// (rather than importing cj-order.js's handler directly) so the two
// routes stay fully decoupled — cj-order.js can be redeployed, rate-
// limited or maintained independently, and this call is exactly what the
// browser's own direct call to it would be.
async function createCjOrderInBackground(reference) {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
  if (!base) { console.warn('cj-order background trigger skipped — VERCEL_URL not available'); return; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`${base}/api/cj-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
      signal: controller.signal,
    });
    if (!r.ok) console.error('cj-order background call failed:', r.status, await r.text().catch(() => ''));
  } finally {
    clearTimeout(timer);
  }
}
