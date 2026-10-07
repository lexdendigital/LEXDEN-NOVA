// api/_paystackMode.js
//
// Single source of truth for "which Paystack secret key should this
// request use right now." Used by verify-paystack.js, affiliate/admin.js
// (payouts), affiliate/banks.js, and affiliate/resolve-account.js — ALL
// FOUR, not just checkout — a live/test toggle that only flipped checkout
// while payouts kept using a different key would be worse than no toggle
// at all.
//
// Mode lives in catalog/settings.content.paymentMode ('live' | 'test'),
// the exact same Firestore doc/field index.html's admin portal already
// edits every other setting through — see api/admin-payment-mode.js for
// the endpoint that changes it. A Firestore flag rather than swapping the
// Render env var itself: flipping it is instant (no redeploy), and the
// app never needs a RENDER_API_KEY secret of its own.
// Same hardcoded fallback verify-paystack.js and cj-order.js already use —
// catalog/settings is publicly readable (firestore.rules), so this is a
// plain REST GET with no credential needed, and doesn't actually depend on
// FIREBASE_PROJECT_ID being set in Render at all.
const FIRESTORE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'lexden-nova';

function fsFields(fields) {
  const out = {};
  for (const k in fields) {
    const v = fields[k];
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue, 10);
    else if (v.doubleValue !== undefined) out[k] = v.doubleValue;
    else if (v.mapValue) out[k] = fsFields(v.mapValue.fields || {});
    else out[k] = null;
  }
  return out;
}

async function getPaymentMode() {
  if (!FIRESTORE_PROJECT) return null;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents/catalog/settings`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.fields) return null;
    const content = fsFields(data.fields).content;
    const mode = content && content.paymentMode;
    return mode === 'live' || mode === 'test' ? mode : null;
  } catch {
    return null;
  }
}

/** Resolves the Paystack SECRET key to use right now. Legacy-safe: if no
 * mode has ever been set in Firestore, behaves exactly like the old
 * single-PAYSTACK_SECRET_KEY code did. */
async function resolvePaystackSecretKey() {
  const mode = await getPaymentMode();
  if (mode === 'live') return process.env.PAYSTACK_SECRET_KEY_LIVE || process.env.PAYSTACK_SECRET_KEY || null;
  if (mode === 'test') return process.env.PAYSTACK_SECRET_KEY_TEST || process.env.PAYSTACK_SECRET_KEY || null;
  return process.env.PAYSTACK_SECRET_KEY || null;
}

module.exports = { getPaymentMode, resolvePaystackSecretKey };
