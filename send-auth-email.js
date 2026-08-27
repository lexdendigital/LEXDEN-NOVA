// Sends LEXDEN NOVA's own-branded verification / password-reset emails
// through Brevo, instead of Firebase Auth's default (unbranded, "via
// firebaseapp.com") emails.
//
// WHY A SEPARATE ENDPOINT FROM send-email.js: generating a real, working
// verification or reset link requires Firebase's ADMIN sdk (server-side,
// with the service-account key) — firebase-admin/auth's
// generateEmailVerificationLink() / generatePasswordResetLink() are the
// only way to mint one. The regular client SDK's sendEmailVerification()/
// sendPasswordResetEmail() mint a link too, but only inside Firebase's own
// email, which is exactly what we're replacing. So this endpoint does two
// jobs in sequence: (1) ask firebase-admin for the real action link, then
// (2) hand that link to send-email.js's Brevo call.
//
// SETUP (same three env vars verify-paystack.js already uses):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// plus everything send-email.js needs (BREVO_API_KEY, BREVO_TPL_VERIFY,
// BREVO_TPL_RESET, etc — see that file's header comment).

const admin = require("firebase-admin");

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const SITE_URL = "https://lexdendigital.github.io/LEXDEN-NOVA/index.html";

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Same quote-stripping fix as verify-paystack.js — a Vercel env var
  // pasted with a wrapping pair of quotes left in from the source JSON
  // otherwise fails PEM parsing even though the key content is correct.
  let rawKey = (process.env.FIREBASE_PRIVATE_KEY || "").trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY in Vercel env vars");
  }
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

async function sendViaBrevo(req, templateKey, to, params) {
  // Calls send-email.js's own logic directly in-process (same deployment,
  // same Vercel project) rather than an HTTP round trip to itself.
  const sendEmail = require("./send-email.js");
  const fakeReq = { method: "POST", headers: req.headers, body: { templateKey, to, params } };
  let statusCode = 200, body = null;
  const fakeRes = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    end() { return this; },
  };
  await sendEmail(fakeReq, fakeRes);
  return { statusCode, body };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { type, email, name } = req.body || {};
  if (type !== "verify" && type !== "reset") {
    return res.status(400).json({ error: 'type must be "verify" or "reset"' });
  }
  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    initAdmin();
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    return res.status(500).json({ error: "Server could not connect to Firebase Auth" });
  }

  const actionSettings = { url: SITE_URL, handleCodeInApp: false };

  let link;
  try {
    link = type === "verify"
      ? await admin.auth().generateEmailVerificationLink(email, actionSettings)
      : await admin.auth().generatePasswordResetLink(email, actionSettings);
  } catch (e) {
    // Same non-revealing behavior as the client SDK's own reset flow —
    // never confirm/deny whether an address has an account.
    console.warn(`generate${type === "verify" ? "EmailVerification" : "PasswordReset"}Link failed for`, email, e.code || e.message);
    return res.status(200).json({ ok: true });
  }

  const templateKey = type === "verify" ? "verify" : "reset";
  const params = type === "verify"
    ? { verification_url: link }
    : { reset_url: link, request_time: new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos" }) + " WAT" };

  const result = await sendViaBrevo(req, templateKey, { email, name }, params);
  if (result.statusCode >= 400) {
    console.error("send-auth-email: Brevo send failed", result.body);
    return res.status(500).json({ error: "Could not send email" });
  }
  return res.status(200).json({ ok: true });
};
