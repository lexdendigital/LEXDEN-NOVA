// Flips Firebase Auth's emailVerified flag to true on a brand-new account,
// using the signed token verify-otp.js issued when the shopper proved
// ownership of the address BEFORE the account existed. Called once, right
// after createUserWithEmailAndPassword succeeds in the sign-up wizard
// (finishSignup(), index.html).
//
// SETUP: same FIREBASE_* vars as the other endpoints, PLUS the exact same
// OTP_SIGNING_SECRET as verify-otp.js.

const admin = require("firebase-admin");
const crypto = require("crypto");

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

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

// Verifies the token's signature (constant-time compare — never a plain
// ===, which would leak timing information about how much of the guess
// was right), that it hasn't expired, and that it names the SAME email
// the caller is claiming to confirm (so token for a@x.com can't be reused
// to verify b@x.com).
function verifyToken(token, expectedEmail) {
  const secret = process.env.OTP_SIGNING_SECRET;
  if (!secret) throw new Error("Missing OTP_SIGNING_SECRET");
  let decoded;
  try { decoded = Buffer.from(String(token), "base64url").toString("utf8"); } catch (e) { return false; }
  const parts = decoded.split("|");
  if (parts.length !== 3) return false;
  const [email, expiresAt, sig] = parts;
  const payload = `${email}|${expiresAt}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(sig, "utf8"), expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  if (Date.now() > Number(expiresAt)) return false;
  if (email !== expectedEmail) return false;
  return true;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { uid, email, verifiedToken } = req.body || {};
  if (!uid || !email || !verifiedToken) {
    return res.status(400).json({ error: "Missing uid, email, or verifiedToken." });
  }
  const cleanEmail = String(email).trim().toLowerCase();

  let tokenOk;
  try {
    tokenOk = verifyToken(verifiedToken, cleanEmail);
  } catch (e) {
    console.error("confirm-email-verified: token check failed —", e.message);
    return res.status(500).json({ error: "Server is missing configuration — contact support." });
  }
  if (!tokenOk) return res.status(400).json({ error: "Verification token is invalid or expired." });

  try {
    initAdmin();
  } catch (e) {
    console.error("Firebase Admin init failed:", e.message);
    return res.status(500).json({ error: "Server could not connect." });
  }

  // SECURITY FIX (roadmap 3.2 — UID/email binding): verifyToken() above only
  // proves the CODE was for cleanEmail. It says nothing about whether the
  // Firebase account named by `uid` is actually the account that email
  // belongs to — without this check, a caller could pass their own uid
  // alongside someone else's email + that email's valid OTP token and get
  // their own account flipped to emailVerified:true without ever proving
  // they control an address matching THAT account. Confirming the account's
  // own email matches before touching it is what closes that gap.
  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUser(uid);
  } catch (e) {
    console.error("confirm-email-verified: getUser failed", e);
    return res.status(400).json({ error: "No such account." });
  }
  if (String(firebaseUser.email || "").trim().toLowerCase() !== cleanEmail) {
    console.error("confirm-email-verified: UID/email mismatch", { uid, cleanEmail });
    return res.status(400).json({ error: "This verification code does not match this account." });
  }

  try {
    await admin.auth().updateUser(uid, { emailVerified: true });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("confirm-email-verified failed", e);
    return res.status(500).json({ error: "Could not mark email verified." });
  }
};
