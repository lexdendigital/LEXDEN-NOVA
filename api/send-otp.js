const { applyCors } = require('./cors');
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
  applyCors(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' });
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
  const t0 = Date.now();
  const stage = (name) => console.log(`send-otp [${email.replace(/(^.).*(@.*$)/, "$1***$2")}] ${name} +${Date.now() - t0}ms`);

  // HARD DEADLINE: whatever stalls (Firestore, Brevo, a cold network), the
  // browser gets an answer in 15 seconds instead of "Sending…" forever.
  let finished = false;
  const done = (status, payload) => { if (finished) return; finished = true; clearTimeout(deadline); res.status(status).json(payload); };
  const deadline = setTimeout(() => {
    console.error(`send-otp: DEADLINE hit after ${Date.now() - t0}ms`);
    done(504, { error: "The email service took too long. Please try again in a moment." });
  }, 8000);

  try {
    const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "unknown").trim();
    const ipRef = db.collection("otp_ip_limits").doc(ip.replace(/[^a-zA-Z0-9.:_-]/g, "_") || "unknown");
    const ref = db.collection("email_otps").doc(email);

    stage("reading limits");
    const [ipSnap, existing] = await Promise.all([
      ipRef.get().catch(e => { console.warn("send-otp: IP rate-limit read failed (continuing)", e.message); return null; }),
      ref.get(),
    ]);
    stage("limits read");

    const now = Date.now();
    try {
      if (ipSnap && ipSnap.exists) {
        const d = ipSnap.data();
        if (now - (d.windowStart || 0) < IP_WINDOW_MS) {
          if ((d.count || 0) >= IP_MAX_SENDS) return done(429, { error: "Too many code requests from this connection — try again later." });
          ipRef.set({ windowStart: d.windowStart, count: (d.count || 0) + 1 }, { merge: true }).catch(() => {}); // background: don't make the person wait
        } else {
          ipRef.set({ windowStart: now, count: 1 }).catch(() => {});
        }
      } else if (ipSnap) {
        ipRef.set({ windowStart: now, count: 1 }).catch(() => {});
      }
    } catch (e) {
      console.warn("send-otp: IP rate-limit bookkeeping failed (continuing)", e.message);
    }

    if (existing.exists) {
      const age = Date.now() - (existing.data().createdAt || 0);
      if (age < RESEND_COOLDOWN_MS) {
        return done(429, { error: `Wait ${Math.ceil((RESEND_COOLDOWN_MS - age) / 1000)}s before requesting another code.` });
      }
    }

    // crypto.randomInt = OS CSPRNG; only an HMAC of the code is stored.
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashCode(code, email);
    // Store the code and send the email AT THE SAME TIME (not one after the other).
    // The code is always stored before the person can read the email and type it in.

    // Send DIRECTLY (not via send-email.js): that route reports success even
    // when Brevo rejected the mail and only queued it — fine for a receipt,
    // wrong for a sign-up code the person is staring at the screen waiting
    // for. Here a failed send is reported honestly, with a reason.
    const { sendEmailFast } = require("./email-shared");
    const [stored, result] = await Promise.all([
      ref.set({ codeHash, createdAt: Date.now(), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 }).then(() => true, (e) => { console.error("send-otp: could not store code:", e.message); return false; }),
      sendEmailFast({ templateKey: "verify", to: { email }, params: { code } }),
    ]);
    stage("code stored=" + stored);
    if (!stored) return done(500, { error: "Could not send the code. Please try again." });
    stage(result.ok ? "email sent" : "email FAILED");
    if (!result.ok) {
      console.error("send-otp: Brevo send failed:", result.error);
      await ref.delete().catch(() => {}); // don't make them wait out the cooldown for a code that never left
      const msg = String(result.error || "");
      let friendly = "Could not send the code email. Please try again.";
      if (/BREVO_API_KEY not set|BREVO_TPL_VERIFY not set/.test(msg)) friendly = "Email service is not fully set up yet. Please contact support.";
      else if (/Brevo 401|Brevo 403/.test(msg)) friendly = "The email service rejected our request. Please contact support.";
      else if (/Brevo 400/.test(msg)) friendly = "That email address was refused. Check it and try again.";
      else if (/abort/i.test(msg)) friendly = "The email service is slow right now. Please try again.";
      return done(502, { error: friendly });
    }
    return done(200, { ok: true });
  } catch (e) {
    console.error("send-otp failed:", e && e.message);
    return done(500, { error: "Could not send the code." });
  }
};
