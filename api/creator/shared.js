// api/creator/shared.js
//
// Shared helpers for every Creator backend file. Deliberately does NOT
// re-initialize its own Firebase Admin app — api/affiliate/shared.js
// already owns the one singleton Admin app for this whole server (see its
// own comment), and firebase-admin throws if you call initializeApp() a
// second time. Reusing it is also just correct: there is exactly one
// Render process, one Admin SDK connection pool, one Firestore project.
const { getDb, getAuthAdmin, getFirebaseBucket, FieldValue, requireAffiliateAuth, isAdminEmail, setCors } = require('../affiliate/shared');
const { assertSellerNotBlocked } = require('./state-machine');

// Renamed re-export for readability in creator files — same function,
// same Firebase Admin verifyIdToken() call underneath.
const requireAuth = requireAffiliateAuth;

async function requireAdminAuth(req) {
  const decoded = await requireAuth(req);
  if (!isAdminEmail(decoded.email)) {
    const e = new Error('Not authorized.');
    e.status = 403;
    throw e;
  }
  return decoded;
}

// Loads creators/{uid} (public seller doc). Returns null if the caller
// isn't a creator yet (NOT_APPLIED / still mid-application) rather than
// throwing — "not a creator" is an expected, common case, not an error.
async function getCreatorDoc(uid) {
  const snap = await getDb().collection('creators').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getApplicationDoc(uid) {
  const snap = await getDb().collection('creatorApplications').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function getPrivateDoc(uid) {
  const snap = await getDb().collection('creatorPrivate').doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// ---- Stage C additions (product/version engine) ----
async function getProductDoc(productId) {
  const snap = await getDb().collection('products').doc(productId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function getVersionDoc(versionId) {
  const snap = await getDb().collection('productVersions').doc(versionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
// Separate from writeCreatorAuditLog/application decisions on purpose —
// product review activity is a much higher-volume log than application
// decisions, and keeping them in different collections means neither
// admin screen has to filter the other's noise out.
async function writeProductAuditLog({ actorUid, actorRole, action, productId, versionId, reason, metadata }) {
  await getDb().collection('productAuditLog').add({
    actorUid: actorUid || null,
    actorRole: actorRole || 'unknown',
    action,
    productId: productId || null,
    versionId: versionId || null,
    reason: reason || null,
    metadata: metadata || null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// Full gate for "may this signed-in user perform a creator ACTION right
// now" (as opposed to just reading their own status). Throws a
// well-formed {status, code, message} error the route handlers can catch
// and translate straight into the API's standard error envelope.
async function requireActiveCreator(req) {
  const decoded = await requireAuth(req);
  const creator = await getCreatorDoc(decoded.uid);
  if (!creator) {
    const e = new Error('You are not an approved creator yet.');
    e.code = 'NOT_A_CREATOR';
    e.status = 403;
    throw e;
  }
  assertSellerNotBlocked(creator.status); // throws CREATOR_SUSPENDED / CREATOR_REVOKED
  return { decoded, creator };
}

// Every important Creator-system action writes one of these. Admin-only
// read (firestore.rules), write:false from the client — only this helper,
// running under the Admin SDK, ever touches the collection. Matches the
// blueprint §33 audit-log requirement and the existing mcpAuditLog /
// cjSyncLogs pattern already in this codebase.
async function writeCreatorAuditLog({ actorUid, actorRole, action, targetType, targetId, reason, metadata }) {
  await getDb().collection('creatorAuditLog').add({
    actorUid: actorUid || null,
    actorRole: actorRole || 'unknown', // 'creator' | 'admin' | 'system'
    action, // e.g. 'application.submitted', 'application.approved'
    targetType: targetType || null, // 'application' | 'creator' | 'document'
    targetId: targetId || null,
    reason: reason || null,
    metadata: metadata || null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// Standard response envelope (Implementation README §37 "API CONTRACTS")
// shared by every creator/creator-admin route for consistency.
function ok(res, data, status) {
  res.status(status || 200).json({ ok: true, data: data === undefined ? null : data, requestId: res.req && res.req.id });
}
function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = (err && err.code) || (status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : 'INTERNAL');
  if (status >= 500) console.error('Creator API error:', err);
  res.status(status).json({ ok: false, error: { code, message: (err && err.message) || 'Something went wrong.', ...(err && err.errors ? { errors: err.errors } : {}) } });
}

module.exports = {
  getDb, getAuthAdmin, getFirebaseBucket, FieldValue, setCors,
  requireAuth, requireAdminAuth, isAdminEmail,
  getCreatorDoc, getApplicationDoc, getPrivateDoc, requireActiveCreator,
  writeCreatorAuditLog, ok, fail,
  getProductDoc, getVersionDoc, writeProductAuditLog,
};
