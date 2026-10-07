// /api/admin-payment-mode.js
//
// GET  -> current Paystack mode + which secret/public keys are actually
//         configured on the server (never returns the secret key values
//         themselves — just whether each is present).
// POST { mode: 'live' | 'test' } -> admin-only. Flips
//         catalog/settings.content.paymentMode, which api/_paystackMode.js
//         (and every file that uses it — verify-paystack.js,
//         affiliate/admin.js, banks.js, resolve-account.js) reads on every
//         request. Also updates content.paystackPublicKey — the field
//         index.html's checkout code already reads directly — to match,
//         from paystackPublicKeyLive/paystackPublicKeyTest if the admin
//         has saved those.
//
// Safety guard: refuses to switch TO live mode if no live secret key is
// configured on the server. A toggle that can be flipped into a state
// where checkout immediately breaks isn't actually safer than no toggle.
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function getFirebaseAdmin() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

const ADMIN_EMAIL = 'ruthanselem2@gmail.com'; // same hardcoded admin this whole app already uses (see firestore.rules isAdmin())

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { const e = new Error('Missing Authorization bearer token.'); e.status = 401; throw e; }
  const { getAuth } = require('firebase-admin/auth');
  getFirebaseAdmin(); // ensures the app is initialized before getAuth() below
  const decoded = await getAuth().verifyIdToken(token);
  if (decoded.email !== ADMIN_EMAIL) { const e = new Error('Not authorized.'); e.status = 403; throw e; }
  return decoded;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try {
    admin = await requireAdmin(req);
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: { message: e.message } });
  }

  const db = getFirebaseAdmin();
  const settingsRef = db.collection('catalog').doc('settings');

  const hasLiveSecret = !!process.env.PAYSTACK_SECRET_KEY_LIVE;
  const hasTestSecret = !!(process.env.PAYSTACK_SECRET_KEY_TEST || process.env.PAYSTACK_SECRET_KEY);

  if (req.method === 'GET') {
    try {
      const snap = await settingsRef.get();
      const content = (snap.exists && snap.data().content) || {};
      return res.status(200).json({
        ok: true,
        data: {
          mode: content.paymentMode || null,
          hasLiveSecret,
          hasTestSecret,
          publicKeyLive: content.paystackPublicKeyLive || null,
          publicKeyTest: content.paystackPublicKeyTest || null,
          currentPublicKey: content.paystackPublicKey || null,
        },
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: { message: e.message } });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { message: 'Use GET or POST.' } });
  }

  const mode = req.body && req.body.mode;
  if (mode !== 'live' && mode !== 'test') {
    return res.status(422).json({ ok: false, error: { message: 'mode must be "live" or "test".' } });
  }
  if (mode === 'live' && !hasLiveSecret) {
    return res.status(409).json({ ok: false, error: { code: 'NO_LIVE_SECRET', message: 'No PAYSTACK_SECRET_KEY_LIVE is configured on the server yet — add it in Render before switching to live mode.' } });
  }
  if (mode === 'test' && !hasTestSecret) {
    return res.status(409).json({ ok: false, error: { code: 'NO_TEST_SECRET', message: 'No PAYSTACK_SECRET_KEY_TEST is configured on the server yet.' } });
  }

  try {
    const snap = await settingsRef.get();
    const content = (snap.exists && snap.data().content) || {};
    const matchingPublicKey = mode === 'live' ? content.paystackPublicKeyLive : content.paystackPublicKeyTest;

    const patch = { paymentMode: mode };
    // Only overwrite the legacy single paystackPublicKey field if we
    // actually have a saved key for the mode being switched to — never
    // blank out a working public key just because the matching one
    // hasn't been saved yet.
    if (matchingPublicKey) patch.paystackPublicKey = matchingPublicKey;

    await settingsRef.set({ content: patch }, { merge: true });
    await db.collection('adminAuditLog').add({
      actorUid: admin.uid,
      actorEmail: admin.email,
      action: 'payment_mode.changed',
      metadata: { mode, publicKeySwitched: !!matchingPublicKey },
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      ok: true,
      data: { mode, publicKeyUpdated: !!matchingPublicKey, warning: matchingPublicKey ? null : `No paystackPublicKey${mode === 'live' ? 'Live' : 'Test'} saved yet — the storefront's public key was left unchanged. Save it on this screen, or checkout will use the wrong pair.` },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: { message: e.message } });
  }
};
