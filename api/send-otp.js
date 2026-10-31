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
function hashIdentifier(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function rateLimitError(message, retryAfterMs) {
  const error = new Error(message);
  error.rateLimited = true;
  error.retryAfterMs = retryAfterMs || 0;
  return error;
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
    // Express trust proxy is configured to one trusted proxy in server.js.
    // Never parse X-Forwarded-For here: arbitrary client-supplied values are not
    // rate-limit identities. All limit-document IDs are irreversible hashes.
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").trim().slice(0, 128);
    const emailKey = hashIdentifier("otp-email|" + email);
    const ipKey = hashIdentifier("otp-ip|" + ip);
    const ref = db.collection("email_otps").doc(emailKey);
    const legacyRef = db.collection("email_otps").doc(email); // read-only cooldown bridge for pre-v3.0.2 OTP records
    const emailLimitRef = db.collection("otp_email_limits").doc(emailKey);
    const ipRef = db.collection("otp_ip_limits").doc(ipKey);
    const reservationId = crypto.randomUUID();
    const now = Date.now();

    stage("atomic limits reservation");
    try {
      await db.runTransaction(async (tx) => {
        const snaps = await Promise.all([tx.get(ipRef), tx.get(emailLimitRef), tx.get(ref), tx.get(legacyRef)]);
        const ipData = snaps[0].exists ? snaps[0].data() || {} : {};
        const emailData = snaps[1].exists ? snaps[1].data() || {} : {};
        const currentOtp = snaps[2].exists ? snaps[2].data() || {} : {};
        const legacyOtp = snaps[3].exists ? snaps[3].data() || {} : {};
        const lastSendAt = Math.max(Number(emailData.lastSendAt) || 0, Number(currentOtp.createdAt) || 0, Number(legacyOtp.createdAt) || 0);
        const emailAge = lastSendAt ? now - lastSendAt : RESEND_COOLDOWN_MS;
        if (emailAge < RESEND_COOLDOWN_MS) {
          throw rateLimitError("Email cooldown active.", RESEND_COOLDOWN_MS - emailAge);
        }
        const inWindow = ipData.windowStart && now - Number(ipData.windowStart) < IP_WINDOW_MS;
        const count = inWindow ? Number(ipData.count) || 0 : 0;
        if (count >= IP_MAX_SENDS) throw rateLimitError("IP send limit reached.", IP_WINDOW_MS - (now - Number(ipData.windowStart)));
        tx.set(emailLimitRef, { lastSendAt: now, reservationId, updatedAt: now });
        tx.set(ipRef, { windowStart: inWindow ? ipData.windowStart : now, count: count + 1, updatedAt: now });
      });
    } catch (e) {
      if (e && e.rateLimited) {
        const seconds = Math.max(1, Math.ceil((e.retryAfterMs || 1000) / 1000));
        const message = /Email cooldown/.test(e.message)
          ? "Wait " + seconds + "s before requesting another code."
          : "Too many code requests from this connection — try again later.";
        return done(429, { error: message });
      }
      console.error("send-otp: atomic rate-limit reservation failed:", e && e.message);
      return done(503, { error: "Code delivery is temporarily unavailable. Please try again." });
    }

    // crypto.randomInt = OS CSPRNG; only an HMAC of the code is stored.
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashCode(code, email);
    const { sendEmailFast } = require("./email-shared");
    try {
      await ref.set({ codeHash, createdAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 });
    } catch (e) {
      console.error("send-otp: could not store code:", e && e.message);
      return done(503, { error: "Code delivery is temporarily unavailable. Please try again." });
    }
    stage("code stored");

    const result = await sendEmailFast({ templateKey: "verify", to: { email }, params: { code } });
    stage(result.ok ? "email sent" : "email FAILED");
    if (!result.ok) {
      console.error("send-otp: Brevo send failed:", result.error);
      await ref.delete().catch(() => {});
      // Release only this request's email cooldown reservation. Keep the IP
      // attempt counted so a failed provider call cannot be used for free
      // high-volume retries.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(emailLimitRef);
        if (snap.exists && (snap.data() || {}).reservationId === reservationId) {
          tx.set(emailLimitRef, { lastSendAt: 0, reservationId: null, updatedAt: Date.now() }, { merge: true });
        }
      }).catch((e) => console.warn("send-otp: could not release email cooldown:", e && e.message));
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
