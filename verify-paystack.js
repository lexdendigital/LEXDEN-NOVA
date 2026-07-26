// /api/verify-paystack.js
//
// Vercel serverless function (Node.js runtime — NOT edge, because the
// Firebase Admin SDK needs Node APIs that aren't available on the edge
// runtime nova-ai.js uses).
//
// What this does, and why it's structured this way:
//   1. The browser NEVER gets to say "the payment succeeded" on its own —
//      it only ever sends us a Paystack transaction reference. This
//      function calls Paystack's own /transaction/verify endpoint with
//      the SECRET key (which only ever lives here, as an environment
//      variable) to find out what actually happened.
//   2. It re-derives the expected price from Firestore's live catalog
//      (the same `catalog/products` and `catalog/settings` documents the
//      admin panel already writes to) instead of trusting any amount the
//      client sent. If someone tampered with the client-side JS to open
//      a cheaper Paystack popup, the amount Paystack actually verifies
//      won't match the catalog price, and the order is rejected.
//
//   3. Only after both checks pass does it write the order to Firestore,
//      using the Admin SDK, which bypasses Firestore security rules —
//      this is *the* place orders get created; the client's own Firestore
//      rules (see firestore.rules) deny client writes to /orders
//      entirely, so this function is the only path to a real order.
//
// PHASE 3 — multi-currency: this function no longer assumes NGN. It reads
// the currency Paystack itself says was actually charged
// (verifyData.data.currency — never a currency the client claims), and
// converts the catalog's USD price into THAT currency using the live
// exchangeRates map in catalog/settings, the same way index.html's
// fmtPrice()/startPaystackCheckout() do. PAYSTACK_CHARGEABLE_CURRENCIES
// below must be kept in sync with the identical array in index.html — it's
// the account-level allowlist of currencies Paystack can actually settle
// for a Nigeria-registered business (see the long comment next to that
// array in index.html for the reasoning and how to extend it once Lexden
// confirms more currencies are enabled on the dashboard).
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   PAYSTACK_SECRET_KEY     — from your Paystack dashboard (sk_live_... / sk_test_...)
//   FIREBASE_PROJECT_ID     — from your Firebase service account JSON
//   FIREBASE_CLIENT_EMAIL   — from your Firebase service account JSON
//   FIREBASE_PRIVATE_KEY    — from your Firebase service account JSON
//                             (paste with literal \n's — this file un-escapes them)
//
// Get the service account JSON from:
//   Firebase console → Project settings → Service accounts → Generate new private key

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAppCheck } from "firebase-admin/app-check";

// PHASE 3: keep this identical to PAYSTACK_CHARGEABLE_CURRENCIES in
// index.html. Any currency Paystack reports that ISN'T in this list gets
// rejected outright below — defense in depth in case the account, popup,
// or Paystack's own config ever allows something this app isn't prepared
// to verify a price in.
const PAYSTACK_CHARGEABLE_CURRENCIES = ['NGN', 'USD'];

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "https://lexden-nova.vercel.app",
];
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host.startsWith("lexden-nova-") && host.endsWith("-lexdendigitals-projects.vercel.app");
  } catch {
    return false;
  }
}
function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Firebase-AppCheck",
  };
}

function getAdminApp() {
  if (!getApps().length) {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }
  return getApps()[0];
}
function getDb() {
  getAdminApp();
  return getFirestore();
}

// PHASE 1 SECURITY: confirms the request carried a valid Firebase App
// Check token — i.e. it came from a real loaded instance of the app, not a
// server-to-server call hitting this URL directly. The Origin header check
// above does nothing against that case (Origin is a browser convention;
// nothing stops a script from just not sending one, or sending a fake
// one), so this is the actual gate. Uses firebase-admin (this function
// already runs on the Node runtime for the Admin SDK, unlike nova-ai.js's
// edge runtime, which verifies the same tokens a different way).
async function verifyAppCheck(token) {
  if (!token) return false;
  try {
    getAdminApp();
    await getAppCheck().verifyToken(token);
    return true;
  } catch (e) {
    console.warn("App Check verification failed:", e?.message || e);
    return false;
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const appCheckToken = req.headers["x-firebase-appcheck"];
  if (!(await verifyAppCheck(Array.isArray(appCheckToken) ? appCheckToken[0] : appCheckToken))) {
    return res.status(401).json({ ok: false, error: "Request could not be verified." });
  }

  const { reference, uid, email, productId, productName } = req.body || {};
  if (!reference || !productId) {
    return res.status(400).json({ ok: false, error: "Missing reference or productId" });
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    console.error("Missing PAYSTACK_SECRET_KEY env var");
    return res.status(500).json({ ok: false, error: "Server is missing its Paystack secret key." });
  }

  let db;
  try {
    db = getDb();
  } catch (e) {
    console.error("Firebase Admin init failed", e);
    return res.status(500).json({ ok: false, error: "Server is missing its Firebase Admin credentials." });
  }

  // 1) Ask Paystack directly what actually happened with this reference.
  let verifyData;
  try {
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    verifyData = await verifyRes.json();
  } catch (e) {
    console.error("Paystack verify request failed", e);
    return res.status(502).json({ ok: false, error: "Could not reach Paystack to verify this payment." });
  }

  if (!verifyData || verifyData.status !== true || !verifyData.data || verifyData.data.status !== "success") {
    return res.status(400).json({ ok: false, error: "Payment was not successful according to Paystack." });
  }

  const paidSubunit = verifyData.data.amount; // amount actually charged, in the smallest unit of paidCurrency
  const paidCurrency = verifyData.data.currency; // the ONLY source of truth for what currency was charged

  // Reject immediately if Paystack charged in a currency this account
  // isn't confirmed to support (see the allowlist comment above) — before
  // doing any catalog lookup or price math in a currency we don't have
  // vetted rates/behavior for.
  if (!PAYSTACK_CHARGEABLE_CURRENCIES.includes(paidCurrency)) {
    console.warn(`Rejected ${reference}: charged in unsupported currency ${paidCurrency}`);
    return res.status(400).json({ ok: false, error: `Payments in ${paidCurrency} aren't supported yet — order not created.` });
  }

  // 2) Re-derive the expected price from the live catalog — never trust
  // a price OR currency the client sent us. Converts the catalog's USD
  // price into whatever currency Paystack says was actually charged.
  let expectedSubunit, rate;
  try {
    const [productsSnap, settingsSnap] = await Promise.all([
      db.collection("catalog").doc("products").get(),
      db.collection("catalog").doc("settings").get(),
    ]);
    const products = productsSnap.exists ? productsSnap.data().list || [] : [];
    const product = products.find(p => p.id === productId);
    if (!product) {
      return res.status(400).json({ ok: false, error: "Product not found in catalog." });
    }
    const content = settingsSnap.exists ? settingsSnap.data().content || {} : {};
    rate = content.exchangeRates && content.exchangeRates[paidCurrency];
    if (!rate) {
      // No rate on file for this currency — can't verify the price was
      // right, so refuse rather than guess.
      console.error(`No exchange rate on file for ${paidCurrency}`);
      return res.status(500).json({ ok: false, error: "Could not verify catalog price in this currency." });
    }
    const priceUSD = (product.salePrice && product.salePrice > 0) ? product.salePrice : product.price;
    const expectedMajor = Math.round(priceUSD * rate);
    // Every Paystack currency (NGN kobo, USD cents, etc.) uses base*100 for
    // its subunit — see Paystack's "Supported currency" docs.
    expectedSubunit = expectedMajor * 100;
  } catch (e) {
    console.error("Catalog lookup failed", e);
    return res.status(500).json({ ok: false, error: "Could not verify catalog price." });
  }

  // Allow a small rounding tolerance — the admin-set rate and the rate at
  // the moment of charge can drift slightly — but reject anything
  // meaningfully off. Scales with the transaction size instead of a fixed
  // NGN-sized number, since a flat tolerance means something very
  // different in USD cents vs. NGN kobo.
  const tolerance = Math.max(200, Math.round(expectedSubunit * 0.005));
  if (Math.abs(paidSubunit - expectedSubunit) > tolerance) {
    console.warn(`Amount mismatch for ${reference}: paid ${paidSubunit} (${paidCurrency}), expected ~${expectedSubunit} (${paidCurrency})`);
    return res.status(400).json({ ok: false, error: "Paid amount did not match the catalog price — order not created." });
  }

  // 3) Write the order. Using the Paystack reference as the document ID
  // makes this idempotent — if this function is ever called twice for
  // the same reference (e.g. a retry), it just overwrites with the same
  // data instead of creating a duplicate order.
  const order = {
    uid: uid || null,
    email: email || verifyData.data.customer?.email || null,
    items: [{ productId, name: productName || productId, qty: 1, price: expectedSubunit / 100 }],
    totalAmount: expectedSubunit / 100,
    currency: paidCurrency,
    paystackReference: reference,
    status: "success",
    timestamp: new Date().toISOString(),
  };

  try {
    await db.collection("orders").doc(reference).set(order, { merge: true });
  } catch (e) {
    console.error("Order write failed", e);
    return res.status(500).json({ ok: false, error: "Payment verified but the order could not be saved — contact support with this reference." });
  }

  return res.status(200).json({ ok: true, order });
}
