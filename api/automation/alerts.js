// api/automation/alerts.js
//
// LEXDEN NOVA CREATOR — Stage I: the two places automation speaks.
//   adminAlerts/{key}                 -> Admin cockpit "needs attention" (blueprint §84, §76)
//   creatorNotifications/{uid}_{key}  -> Creator notification center (blueprint §75)
// Both are keyed by a deterministic `key`, so a sweep that runs every 15
// minutes raises ONE alert / ONE notification per situation instead of
// hundreds. Writes use the injected `db` (tests pass an in-memory double).
const crypto = require('crypto');
const { FieldValue } = require('../creator/shared');

const safeId = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 140) || crypto.createHash('sha1').update(String(s)).digest('hex');

const SEVERITIES = ['info', 'warning', 'critical'];

/** Raise (or refresh) an admin alert. Re-raising an OPEN alert only bumps its counter. */
async function raiseAlert(db, { key, type, severity = 'warning', title, detail = null, creatorId = null, objectId = null, nowMs = Date.now() }) {
  if (!key || !type || !title) throw new Error('raiseAlert needs key, type and title.');
  const sev = SEVERITIES.includes(severity) ? severity : 'warning';
  const ref = db.collection('adminAlerts').doc(safeId(key));
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : null;
  if (cur && cur.status === 'open') {
    await ref.set({ lastSeenAtMs: nowMs, count: (cur.count || 1) + 1, detail: detail || cur.detail || null, severity: sev, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { created: false, id: ref.id };
  }
  // new, or previously resolved and now back
  await ref.set({
    key, type, severity: sev, title: String(title).slice(0, 200), detail: detail ? String(detail).slice(0, 1000) : null,
    creatorId, objectId, status: 'open', count: 1, firstSeenAtMs: nowMs, lastSeenAtMs: nowMs,
    reopenedFromResolved: !!(cur && cur.status === 'resolved'), resolvedAtMs: null, resolvedBy: null, resolutionNote: null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { created: true, id: ref.id };
}

async function resolveAlert(db, alertId, { by = null, note = null, nowMs = Date.now() } = {}) {
  const ref = db.collection('adminAlerts').doc(alertId);
  const snap = await ref.get();
  if (!snap.exists) { const e = new Error('Alert not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  await ref.set({ status: 'resolved', resolvedAtMs: nowMs, resolvedBy: by, resolutionNote: note ? String(note).slice(0, 500) : null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { id: alertId, status: 'resolved' };
}

/** Auto-resolve when the underlying condition has cleared (e.g. link healthy again). */
async function resolveAlertByKey(db, key, note, nowMs = Date.now()) {
  const ref = db.collection('adminAlerts').doc(safeId(key));
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== 'open') return false;
  await ref.set({ status: 'resolved', resolvedAtMs: nowMs, resolvedBy: 'system', resolutionNote: note || 'Condition cleared.', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return true;
}

/**
 * One notification per (creator, key). Returns false when it already exists
 * (so callers can skip the email as well — no repeated nagging).
 */
async function notifyCreator(db, { creatorId, key, type, title, body, link = null, nowMs = Date.now() }) {
  if (!creatorId || !key || !title) return false;
  const ref = db.collection('creatorNotifications').doc(safeId(`${creatorId}_${key}`));
  const snap = await ref.get();
  if (snap.exists) return false;
  await ref.set({
    creatorId, key, type: type || 'general', title: String(title).slice(0, 160), body: body ? String(body).slice(0, 600) : '',
    link, read: false, createdAtMs: nowMs, createdAt: FieldValue.serverTimestamp(),
  });
  return true;
}

module.exports = { raiseAlert, resolveAlert, resolveAlertByKey, notifyCreator, safeId };
