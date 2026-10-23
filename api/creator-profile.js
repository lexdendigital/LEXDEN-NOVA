// /api/creator-profile.js
//
// LEXDEN NOVA CREATOR — Stage K: the creator's public profile + the rules they sell under.
//
//   GET  /api/creator-profile                      -> { profile, policies }
//   POST /api/creator-profile {action:"update", username?, bio?, tagline?}
//
// A username (3–24 letters/numbers/underscore) gives the creator a public page at
// #seller/<username>. It is claimed in a transaction on creatorUsernames/{name}
// so two creators can never hold the same one, and the old name is released.
// Display name, verification and status are NOT editable here (they come from
// the approved application).
const { getDb, requireActiveCreator, FieldValue, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const { getHoldDays } = require('./creator/ledger');

const RESERVED = new Set(['admin', 'administrator', 'lexden', 'lexdennova', 'nova', 'support', 'help', 'official', 'staff', 'team', 'moderator', 'system', 'creator', 'creators', 'seller', 'sellers', 'null', 'undefined', 'api']);
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const err = (status, code, message) => Object.assign(new Error(message), { status, code });
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function normaliseUsername(raw) {
  const u = String(raw == null ? '' : raw).trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(u)) throw err(422, 'INVALID_USERNAME', 'Username must be 3–24 characters: letters, numbers or underscore.');
  if (RESERVED.has(u)) throw err(422, 'USERNAME_RESERVED', 'That username is reserved. Please pick another.');
  return u;
}

async function claimUsername(db, uid, name, previous) {
  const ref = db.collection('creatorUsernames').doc(name);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().uid !== uid) throw err(409, 'USERNAME_TAKEN', 'That username is already taken.');
    tx.set(ref, { uid, claimedAtMs: Date.now() }, { merge: true });
    if (previous && previous !== name) tx.set(db.collection('creatorUsernames').doc(previous), { uid: null, releasedAtMs: Date.now() }, { merge: true });
  });
}

async function policies(db) {
  const snap = await db.collection('catalog').doc('settings').get();
  const c = (snap.exists && snap.data().content) || {};
  return {
    // Server-owned values (api/core/config.js). The older creatorPlatformFeePct setting is ignored on purpose.
    platformFeePct: require('./core/config').resolveCreatorCommissionBps(c) / 100,
    affiliateWithdrawalFeePct: require('./core/config').resolveAffiliateWithdrawalFeeBps(c) / 100,
    protectionDaysAfterDelivery: require('./core/config').resolveProtectionDays(c),
    withdrawalFeePct: c.creatorWithdrawalFeePct != null ? c.creatorWithdrawalFeePct : 2.5,
    minWithdrawalNGN: c.creatorMinWithdrawalNGN || 5000,
    holdDays: await getHoldDays(db),
    disputeWindowDays: require('./core/config').DISPUTE_POLICIES.PHYSICAL.windowDays,
    withdrawalCooldownDays: 7,
  };
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let ctx;
  try { ctx = await requireActiveCreator(req); } catch (e) { return fail(res, e); }
  const uid = ctx.decoded.uid;
  const db = getDb();
  try {
    const view = (c) => ({ displayName: c.displayName || '', username: c.username || null, bio: c.bio || '', tagline: c.tagline || '', category: c.category || null, verified: !!c.verifiedBusiness, status: c.status || null });
    if (req.method === 'GET') return ok(res, { profile: view(ctx.creator), policies: await policies(db) });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    const b = req.body || {};
    if (b.action !== 'update') return fail(res, err(400, 'INVALID_ACTION', 'action must be "update".'));
    const patch = {};
    if (b.bio !== undefined) patch.bio = clean(b.bio, 500);
    if (b.tagline !== undefined) patch.tagline = clean(b.tagline, 100);
    if (b.username !== undefined && b.username !== null && String(b.username).trim() !== '') {
      const name = normaliseUsername(b.username);
      if (name !== ctx.creator.username) { await claimUsername(db, uid, name, ctx.creator.username || null); patch.username = name; }
    }
    if (!Object.keys(patch).length) return fail(res, err(422, 'NOTHING_TO_UPDATE', 'Nothing to update.'));
    await db.collection('creators').doc(uid).set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: 'profile.updated', targetType: 'creator', targetId: uid, metadata: { fields: Object.keys(patch) } }).catch(() => {});
    return ok(res, { profile: view({ ...ctx.creator, ...patch }) });
  } catch (e) { return fail(res, e); }
};
module.exports.normaliseUsername = normaliseUsername;
module.exports.RESERVED = RESERVED;
