// Sends a 6-digit one-time email-verification code through Brevo, for
// LEXDEN NOVA's sign-up wizard (verify email BEFORE the account exists).
//
// WHY A CODE INSTEAD OF A LINK: send-auth-email.js's link-based flow only
// works AFTER a Firebase account already exists (generateEmailVerificationLink
// needs a real user record). Here we're verifying an email on step 4 of
// sign-up, before createUserWithEmailAndPassword has even run — there's no
// Firebase user yet to attach a link to. A code sidesteps that: it's just a
// short-lived value in Firestore, tied to the email string alone.
//
// SETUP: same BREVO_* vars send-email.js uses, PLUS the same
// FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
// send-auth-email.js already needs (this file uses firebase-admin's
// Firestore, not just Auth, to stash the code — no new dependency, it's
// part of the firebase-admin package already in package.json).

const admin = require("firebase-admin");

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const CODE_TTL_MS = 10 * 60 * 1000;   // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60s between sends to the same email

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
  // Same quote-stripping fix as verify-paystack.js / send-auth-email.js — a
  // Vercel env var pasted with a wrapping pair of quotes left in from the
  // source JSON otherwise fails PEM parsing even though the key is correct.
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

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const email = String((req.body || {}).email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  try {
    initAdmin();
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    return res.status(500).json({ error: "Server could not connect." });
  }

  const db = admin.firestore();
  const ref = db.collection("email_otps").doc(email);

  try {
    const existing = await ref.get();
    if (existing.exists) {
      const age = Date.now() - (existing.data().createdAt || 0);
      if (age < RESEND_COOLDOWN_MS) {
        return res.status(429).json({
          error: `Wait ${Math.ceil((RESEND_COOLDOWN_MS - age) / 1000)}s before requesting another code.`,
        });
      }
    }

    // 6 digits, always — Math.floor(100000 + rand*900000) never produces a
    // value with fewer than 6 digits (no leading-zero truncation to worry
    // about, unlike padStart on a plain random int).
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await ref.set({ code, createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });

    // Reuses send-email.js's Brevo call in-process (same pattern
    // send-auth-email.js already uses) rather than an HTTP round trip to
    // itself. templateKey "verify" → BREVO_TPL_VERIFY, now carrying a
    // {{ params.code }} instead of a link — see the updated
    // 02-email-verification.html template.
    const sendEmail = require("./send-email.js");
    const fakeReq = { method: "POST", headers: req.headers, body: {
      templateKey: "verify", to: { email }, params: { code },
    }};
    let statusCode = 200, body = null;
    const fakeRes = {
      setHeader() {},
      status(c) { statusCode = c; return this; },
      json(p) { body = p; return this; },
      end() { return this; },
    };
    await sendEmail(fakeReq, fakeRes);
    if (statusCode >= 400) {
      console.error("send-otp: Brevo send failed", body);
      return res.status(500).json({ error: "Could not send the code email." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("send-otp failed", e);
    return res.status(500).json({ error: "Could not send the code." });
  }
};
