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
const crypto = require("crypto");

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const CODE_TTL_MS = 10 * 60 * 1000;   // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60s between sends to the same email
// SECURITY FIX (roadmap 3.4): a lightweight per-IP send cap, on top of the
// existing per-email cooldown above. Firestore-based rather than in-memory
// because Vercel functions are stateless between invocations — an
// in-memory counter would reset on every cold start and give no real
// protection. Deliberately simple (fixed window, not sliding) since this
// is meant to blunt casual abuse/enumeration, not replace a dedicated
// WAF/rate-limiter.
const IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_MAX_SENDS = 8;              // per IP per hour, across all emails

function hashCode(code, email) {
  const secret = process.env.OTP_SIGNING_SECRET;
  if (!secret) throw new Error("Missing OTP_SIGNING_SECRET");
  return crypto.createHmac("sha256", secret).update(`${email}|${code}`).digest("hex");
}

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

  // SECURITY FIX (roadmap 3.4 — per-IP rate limiting): a fixed-window
  // counter keyed by the caller's IP, checked before we even look at the
  // per-email cooldown. Behind Vercel, the real client IP is the FIRST
  // entry in x-forwarded-for (Vercel's edge appends its own hops after
  // it) — falling back to the raw socket address covers local/dev runs
  // where that header is absent.
  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "unknown").trim();
  const ipRef = db.collection("otp_ip_limits").doc(ip.replace(/[^a-zA-Z0-9.:_-]/g, "_") || "unknown");
  try {
    const ipSnap = await ipRef.get();
    const now = Date.now();
    if (ipSnap.exists) {
      const d = ipSnap.data();
      if (now - (d.windowStart || 0) < IP_WINDOW_MS) {
        if ((d.count || 0) >= IP_MAX_SENDS) {
          return res.status(429).json({ error: "Too many code requests from this connection — try again later." });
        }
        await ipRef.set({ windowStart: d.windowStart, count: (d.count || 0) + 1 }, { merge: true });
      } else {
        await ipRef.set({ windowStart: now, count: 1 });
      }
    } else {
      await ipRef.set({ windowStart: now, count: 1 });
    }
  } catch (e) {
    // Rate-limit bookkeeping failing should never be the reason a real
    // signup can't get a code — log it and continue rather than blocking.
    console.warn("send-otp: IP rate-limit check failed (continuing)", e);
  }

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

    // SECURITY FIX (roadmap 3.4 — crypto-secure OTP): Math.random() is not
    // a cryptographically secure generator — its internal state can, in
    // principle, be inferred from enough output, which matters for
    // anything used as a security code. crypto.randomInt() draws from the
    // OS's CSPRNG instead. Range is exclusive of the upper bound, so
    // 1000000 (not 999999) keeps it a genuine 100000–999999 spread.
    const code = String(crypto.randomInt(100000, 1000000));
    // SECURITY FIX (roadmap 3.4 — don't store the code in plaintext): only
    // an HMAC of the code is written to Firestore now; the raw code exists
    // only in memory here and in the email itself. Anyone with read access
    // to this collection (a misconfigured rule, a leaked export, an admin
    // SDK credential in the wrong hands) still can't read out a live code.
    const codeHash = hashCode(code, email);
    await ref.set({ codeHash, createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });

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
