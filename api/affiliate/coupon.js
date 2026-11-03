// /api/affiliate-coupon
//
// Coupon-code attribution: an affiliate owns ONE short code (e.g. COACH123). A buyer who types
// it at checkout credits that affiliate for that order, even with no tracked link
// (WhatsApp voice notes, word of mouth). Codes live in affiliateCoupons/{CODE}.
//
//   GET  ?check=CODE            public  -> { ok, valid }   (checkout box; reveals nothing else)
//   GET                         auth    -> { ok, code }    (the affiliate's own code, or null)
//   POST { code? }              auth    -> { ok, code }    (claim a chosen code, or get a generated one)

const { getDb, FieldValue, requireAffiliateAuth, setCors } = require('./shared');

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const RESERVED = new Set(['LEXDEN', 'NOVA', 'ADMIN', 'TEST', 'TESTING', 'FREE', 'NONE', 'NULL', 'SALE', 'PROMO', 'OFFER', 'AFFILIATE', 'SUPPORT', 'LEXDENNOVA']);

const normalize = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function suggest(displayName) {
  const letters = normalize(displayName).replace(/[0-9]/g, '').slice(0, 5);
  const base = letters.length >= 3 ? letters : 'NOVA';
  return base + String(Math.floor(100 + Math.random() * 900));
}

/** Atomically gives `code` to affiliate `uid`. Throws 409 if the code or the affiliate is already taken. */
async function claimCode(db, uid, code) {
  const cRef = db.collection('affiliateCoupons').doc(code);
  const aRef = db.collection('affiliates').doc(uid);
  await db.runTransaction(async (tx) => {
    const cs = await tx.get(cRef);
    const as = await tx.get(aRef);
    if (!as.exists || as.data().status !== 'active') throw fail(403, 'NOT_ACTIVE', 'Your affiliate account must be active to create a coupon code.');
    if (as.data().couponCode) throw Object.assign(fail(409, 'ALREADY_HAS_CODE', 'You already have a coupon code.'), { existing: as.data().couponCode });
    if (cs.exists) throw fail(409, 'CODE_TAKEN', 'That code is already taken. Try another.');
    tx.set(cRef, { affiliateId: uid, code, createdAt: FieldValue.serverTimestamp() });
    tx.update(aRef, { couponCode: code });
  });
  return code;
}

async function createForAffiliate(db, uid, requested, displayName) {
  if (requested) {
    const code = normalize(requested);
    if (!CODE_RE.test(code)) throw fail(400, 'BAD_CODE', 'Use 4 to 12 letters or numbers.');
    if (RESERVED.has(code)) throw fail(400, 'RESERVED_CODE', 'That code is reserved. Try another.');
    return claimCode(db, uid, code);
  }
  for (let i = 0; i < 8; i++) {
    const code = suggest(displayName);
    try { return await claimCode(db, uid, code); } catch (e) { if (e.code !== 'CODE_TAKEN') throw e; }
  }
  throw fail(503, 'NO_CODE_AVAILABLE', 'Could not generate a code right now. Please choose your own.');
}

async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  try {
    const db = getDb();
    // Public validity check used by the checkout box.
    if (req.method === 'GET' && req.query && req.query.check !== undefined) {
      const code = normalize(req.query.check);
      if (!CODE_RE.test(code)) return res.status(200).json({ ok: true, valid: false });
      const cs = await db.collection('affiliateCoupons').doc(code).get();
      let valid = false;
      if (cs.exists) {
        const a = await db.collection('affiliates').doc(String(cs.data().affiliateId)).get();
        valid = a.exists && a.data().status === 'active';
      }
      return res.status(200).json({ ok: true, valid });
    }

    const decoded = await requireAffiliateAuth(req);
    const aSnap = await db.collection('affiliates').doc(decoded.uid).get();
    if (req.method === 'GET') return res.status(200).json({ ok: true, code: (aSnap.exists && aSnap.data().couponCode) || null });

    const code = await createForAffiliate(db, decoded.uid, req.body && req.body.code, aSnap.exists ? aSnap.data().displayName : '');
    return res.status(200).json({ ok: true, code });
  } catch (e) {
    if (e.code === 'ALREADY_HAS_CODE') return res.status(200).json({ ok: true, code: e.existing, alreadyHad: true });
    const status = e.status || 500;
    if (status >= 500) console.error('affiliate-coupon failed:', e.message);
    return res.status(status).json({ ok: false, code: e.code, error: e.message || 'Could not complete that.' });
  }
}

module.exports = handler;
module.exports.claimCode = claimCode;
module.exports.createForAffiliate = createForAffiliate;
module.exports.normalize = normalize;
