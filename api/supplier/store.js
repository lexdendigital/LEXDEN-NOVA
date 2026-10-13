// api/supplier/store.js
//
// LEXDEN NOVA CREATOR — Stage G: Firestore access for supplier data.
// Every function takes `db` as its first argument (same convention as
// api/creator/fulfillment.js) so tests can hand in an in-memory double.
//
// COLLECTIONS (all closed to client SDKs — see firestore.rules):
//   supplierConnections/{uid}_cj   one per creator. Holds ENCRYPTED
//                                  credentials + tokens. NOBODY can read it
//                                  from a client, not even its owner; the API
//                                  returns publicConnectionView() instead.
//   supplierProducts/{versionId}   the CJ mapping for ONE product version.
//                                  Keyed by version (not product) so changing
//                                  a supplier mapping is a new version and
//                                  therefore goes through admin review
//                                  (blueprint §11: "supplier" is a HIGH-risk
//                                  change).
//   supplierOrders/{orderId}       the CJ side of a paid order. Kept OFF the
//                                  fulfillments doc on purpose: buyers can
//                                  read their own fulfillment doc, and CJ
//                                  order ids / errors / pay mode are not
//                                  theirs to see.
//   supplierSyncLogs/{auto}        append-only operational log (admin only).
const { FieldValue } = require('../creator/shared');
const { encryptSecret, decryptSecret, maskEmail } = require('./credentials');
const { createCjClient } = require('./cj-client');
const { coded } = require('./mapping');

const connectionId = (uid) => `${uid}_cj`;

// ------------------------------------------------------------- connections
async function getConnection(db, uid) {
  const snap = await db.collection('supplierConnections').doc(connectionId(uid)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

// The ONLY shape of a connection that ever leaves the server.
function publicConnectionView(conn) {
  if (!conn) return { connected: false, status: 'NOT_CONNECTED', provider: 'CJ' };
  return {
    connected: conn.status === 'CONNECTED',
    status: conn.status || 'NOT_CONNECTED',
    provider: 'CJ',
    accountEmail: conn.emailMasked || null,
    autoPay: !!(conn.autoPay && conn.autoPay.enabled),
    autoPayConsentedAtMs: (conn.autoPay && conn.autoPay.consentedAtMs) || null,
    connectedAtMs: conn.connectedAtMs || null,
    lastVerifiedAtMs: conn.lastVerifiedAtMs || null,
    lastSyncAtMs: conn.lastSyncAtMs || null,
    lastError: conn.lastError || null,
    lastOrderError: conn.lastOrderError || null,
  };
}

function encodeTokens(tokens, id) {
  if (!tokens || !tokens.accessToken) return null;
  return {
    accessToken: encryptSecret(tokens.accessToken, id),
    refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken, id) : null,
    accessTokenExpiryDate: tokens.accessTokenExpiryDate || null,
    refreshTokenExpiryDate: tokens.refreshTokenExpiryDate || null,
    openId: tokens.openId || tokens.CJUserId || null,
  };
}

function decodeTokens(stored, id) {
  if (!stored || !stored.accessToken) return null;
  try {
    return {
      accessToken: decryptSecret(stored.accessToken, id),
      refreshToken: stored.refreshToken ? decryptSecret(stored.refreshToken, id) : null,
      accessTokenExpiryDate: stored.accessTokenExpiryDate || null,
      refreshTokenExpiryDate: stored.refreshTokenExpiryDate || null,
      openId: stored.openId || null,
    };
  } catch {
    return null; // undecryptable cache -> caller re-authenticates
  }
}

async function saveCredentials(db, uid, { email, apiKey, tokens, autoPay, nowMs = Date.now() }) {
  const id = connectionId(uid);
  await db.collection('supplierConnections').doc(id).set({
    creatorId: uid,
    provider: 'CJ',
    status: 'CONNECTED',
    emailMasked: maskEmail(email),
    credentials: { email: encryptSecret(email, id), apiKey: encryptSecret(apiKey, id) },
    tokens: encodeTokens(tokens, id),
    autoPay: { enabled: !!autoPay, consentedAtMs: autoPay ? nowMs : null },
    connectedAtMs: nowMs,
    lastVerifiedAtMs: nowMs,
    lastError: null,
    disconnectedAtMs: null,
    disconnectReason: null,
    failedConnectAttempts: [],
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function patchConnection(db, uid, patch) {
  await db.collection('supplierConnections').doc(connectionId(uid)).set({ creatorId: uid, provider: 'CJ', ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

// Wipes secrets. `status` is DISCONNECTED (creator chose it) or REVOKED
// (an admin did). Either way the encrypted material is gone, not hidden.
async function clearCredentials(db, uid, status, reason, nowMs = Date.now()) {
  await patchConnection(db, uid, { status, credentials: null, tokens: null, disconnectedAtMs: nowMs, disconnectReason: reason || null });
}

function tokenStoreFor(db, uid) {
  const id = connectionId(uid);
  return {
    async loadTokens() {
      const c = await getConnection(db, uid);
      return c ? decodeTokens(c.tokens, id) : null;
    },
    async saveTokens(tokens) {
      await db.collection('supplierConnections').doc(id).set({ tokens: encodeTokens(tokens, id), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
    async loadCredentials() {
      const c = await getConnection(db, uid);
      if (!c || !c.credentials) throw coded('Supplier credentials are not stored.', 'SUPPLIER_NOT_CONNECTED', 409);
      return { email: decryptSecret(c.credentials.email, id), apiKey: decryptSecret(c.credentials.apiKey, id) };
    },
  };
}

// A CJ client bound to one creator's own connection. Refuses to build for a
// connection that is not currently CONNECTED.
async function buildClientForCreator(db, uid, deps = {}) {
  const connection = await getConnection(db, uid);
  if (!connection || connection.status !== 'CONNECTED') {
    throw coded('This creator has no active CJ connection.', 'SUPPLIER_NOT_CONNECTED', 409);
  }
  const store = tokenStoreFor(db, uid);
  const client = createCjClient({
    connectionId: connection.id,
    loadCredentials: store.loadCredentials,
    loadTokens: store.loadTokens,
    saveTokens: store.saveTokens,
    fetchImpl: deps.fetchImpl || fetch,
    now: deps.now || Date.now,
    pace: deps.pace,
  });
  return { client, connection };
}

// ------------------------------------------------------- product mappings
async function getMapping(db, versionId) {
  if (!versionId) return null;
  const snap = await db.collection('supplierProducts').doc(versionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function saveMapping(db, versionId, data) {
  await db.collection('supplierProducts').doc(versionId).set({ ...data, updatedAt: FieldValue.serverTimestamp(), updatedAtMs: Date.now() }, { merge: true });
}
async function listMappingsForCreator(db, uid) {
  const snap = await db.collection('supplierProducts').where('creatorId', '==', uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// A new version of a dropship listing starts from the previous mapping so the
// creator doesn't retype it — but UNTESTED, because the new version is a new
// thing an admin must approve and the supplier may have changed since.
async function cloneMappingForNewVersion(db, fromVersionId, toVersionId) {
  const from = await getMapping(db, fromVersionId);
  if (!from) return null;
  const { id, updatedAt, updatedAtMs, ...rest } = from;
  await saveMapping(db, toVersionId, {
    ...rest,
    versionId: toVersionId,
    clonedFromVersionId: fromVersionId,
    status: 'UNTESTED',
    testedAtMs: 0,
    reasons: ['Run the mapping test for this new version.'],
    health: null,
    healthReasons: [],
  });
  return toVersionId;
}

// ------------------------------------------------------------ supplier orders
async function getSupplierOrder(db, orderId) {
  const snap = await db.collection('supplierOrders').doc(orderId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function saveSupplierOrder(db, orderId, data) {
  await db.collection('supplierOrders').doc(orderId).set({ ...data, updatedAt: FieldValue.serverTimestamp(), updatedAtMs: Date.now() }, { merge: true });
}

// -------------------------------------- product reads + audit, via the given db
// Same collections and field shapes as getProductDoc / getVersionDoc /
// writeProductAuditLog / writeCreatorAuditLog in api/creator/shared.js, but
// going through the injected `db` so every supplier flow is testable without
// a real Firestore. (shared.js's versions bind to the global Admin handle.)
async function getProduct(db, productId) {
  if (!productId) return null;
  const snap = await db.collection('products').doc(productId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function getVersion(db, versionId) {
  if (!versionId) return null;
  const snap = await db.collection('productVersions').doc(versionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
async function writeProductAudit(db, { actorUid, actorRole, action, productId, versionId, reason, metadata }) {
  try {
    await db.collection('productAuditLog').add({
      actorUid: actorUid || null, actorRole: actorRole || 'unknown', action,
      productId: productId || null, versionId: versionId || null,
      reason: reason || null, metadata: metadata || null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writeProductAudit failed (non-fatal):', e.message);
  }
}
async function writeCreatorAudit(db, { actorUid, actorRole, action, targetType, targetId, reason, metadata }) {
  try {
    await db.collection('creatorAuditLog').add({
      actorUid: actorUid || null, actorRole: actorRole || 'unknown', action,
      targetType: targetType || null, targetId: targetId || null,
      reason: reason || null, metadata: metadata || null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writeCreatorAudit failed (non-fatal):', e.message);
  }
}

// ----------------------------------------------------------------------- log
async function writeSupplierLog(db, { creatorId, event, objectId = null, success, message = '', detail = null }) {
  try {
    await db.collection('supplierSyncLogs').add({
      creatorId: creatorId || null,
      event,
      objectId,
      success: !!success,
      message: String(message || '').slice(0, 500),
      detail: detail || null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('writeSupplierLog failed (non-fatal):', e.message);
  }
}

module.exports = {
  connectionId, getConnection, publicConnectionView, saveCredentials, patchConnection, clearCredentials,
  tokenStoreFor, buildClientForCreator, encodeTokens, decodeTokens,
  getMapping, saveMapping, listMappingsForCreator, cloneMappingForNewVersion,
  getSupplierOrder, saveSupplierOrder, writeSupplierLog,
  getProduct, getVersion, writeProductAudit, writeCreatorAudit,
};
