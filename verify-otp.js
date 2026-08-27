// Checks a 6-digit code (from send-otp.js) against Firestore, and — on a
// match — issues a short-lived signed token proving "this email address
// was verified at this moment". The sign-up wizard hands that token to
// confirm-email-verified.js right after the Firebase account is created,
// to flip emailVerified=true on the brand-new user without a SECOND email
// round-trip.
//
// SETUP: same FIREBASE_* vars as send-otp.js, PLUS one new one:
//   OTP_SIGNING_SECRET   any long random string you make up yourself —
//                        e.g. run `openssl rand -hex 32` on any computer
//                        (or on Termux on your phone), or just mash the
//                        keyboard for 40+ random characters. Set the exact
//                        same value here AND on confirm-email-verified.js's
//                        Vercel env vars — if they don't match byte-for-
//                        byte, every verification will be rejected.

const admin = require("firebase-admin");
const crypto = require("crypto");

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const MAX_ATTEMPTS = 5;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let rawKey = (process.env.FIREBASE_PRIVATE_KEY || "").trim();
  if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
    rawKey = rawKey.slice(1, -1);
  }
  const privateKey = rawKey.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) throw new Error("Missing Firebase admin env vars");
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

// Token shape: base64url("<email>|<expiresAtMs>|<hmacSignature>"). Nothing
// secret lives IN the token besides the signature — the point is only that
// it can't be forged or altered without knowing OTP_SIGNING_SECRET, and it
// naturally expires (15 min is plenty to finish the rest of the wizard).
function makeVerifiedToken(email) {
  const secret = process.env.OTP_SIGNING_SECRET;
  if (!secret) throw new Error("Missing OTP_SIGNING_SECRET");
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const payload = `${email}|${expiresAt}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const code = String((req.body || {}).code || "").trim();
  if (!email || !code) return res.status(400).json({ error: "Missing email or code." });

  try {
    initAdmin();
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    return res.status(500).json({ error: "Server could not connect." });
  }

  const db = admin.firestore();
  const ref = db.collection("email_otps").doc(email);

  try {
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(400).json({ error: "Request a new code — this one expired or was never sent." });
    }
    const data = snap.data();

    if (Date.now() > data.expiresAt) {
      await ref.delete();
      return res.status(400).json({ error: "That code expired — request a new one." });
    }
    if ((data.attempts || 0) >= MAX_ATTEMPTS) {
      await ref.delete();
      return res.status(429).json({ error: "Too many wrong attempts — request a new code." });
    }
    if (data.code !== code) {
      await ref.update({ attempts: (data.attempts || 0) + 1 });
      return res.status(400).json({ error: "That code is incorrect." });
    }

    await ref.delete(); // one-time use, whether it succeeds or the shopper abandons sign-up
    let verifiedToken;
    try {
      verifiedToken = makeVerifiedToken(email);
    } catch (e) {
      console.error("verify-otp: could not sign token —", e.message);
      return res.status(500).json({ error: "Server is missing configuration — contact support." });
    }
    return res.status(200).json({ ok: true, verifiedToken });
  } catch (e) {
    console.error("verify-otp failed", e);
    return res.status(500).json({ error: "Could not verify the code." });
  }
};
