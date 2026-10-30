'use strict';
const crypto = require('crypto');
const { sendEmailFast } = require('./email-shared');
const MAX_ATTEMPTS = 6;
const BATCH_LIMIT = 25;
const LEASE_MS = 2 * 60 * 1000;
function backoffMs(attempts) { return Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(3, attempts - 1)); }
async function claimItem(db, ref, nowMs) {
  const leaseToken = crypto.randomUUID();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const item = snap.data() || {};
    const duePending = item.status === 'pending' && Number(item.nextAttemptAt || 0) <= nowMs;
    const expiredLease = item.status === 'processing' && Number(item.leaseUntil || 0) <= nowMs;
    if (!duePending && !expiredLease) return null;
    tx.set(ref, { status: 'processing', leaseToken, leaseUntil: nowMs + LEASE_MS, processingStartedAt: nowMs }, { merge: true });
    return { item, leaseToken };
  });
}
async function updateIfLeaseMatches(db, ref, leaseToken, values) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const item = snap.data() || {};
    if (item.status !== 'processing' || item.leaseToken !== leaseToken) return false;
    tx.set(ref, values, { merge: true });
    return true;
  });
}
async function processEmailQueue(db, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : now();
  const limit = Math.max(1, Math.min(BATCH_LIMIT, Number(options.limit) || BATCH_LIMIT));
  const send = options.sendEmailFast || sendEmailFast;
  const [pending, expired] = await Promise.all([
    db.collection('emailQueue').where('status', '==', 'pending').where('nextAttemptAt', '<=', nowMs).orderBy('nextAttemptAt', 'asc').limit(limit).get(),
    db.collection('emailQueue').where('status', '==', 'processing').where('leaseUntil', '<=', nowMs).orderBy('leaseUntil', 'asc').limit(limit).get(),
  ]);
  const docs = new Map();
  for (const doc of pending.docs) docs.set(doc.id, doc);
  for (const doc of expired.docs) docs.set(doc.id, doc);
  const out = { checked: docs.size, sent: 0, retrying: 0, deadLettered: 0, claimed: 0, skipped: 0, errors: 0 };
  for (const doc of docs.values()) {
    try {
      const ref = db.collection('emailQueue').doc(doc.id);
      const claim = await claimItem(db, ref, now());
      if (!claim) { out.skipped += 1; continue; }
      out.claimed += 1;
      const result = await send(claim.item.payload);
      if (result && result.ok) {
        const saved = await updateIfLeaseMatches(db, ref, claim.leaseToken, { status: 'sent', sentAt: now(), leaseToken: null, leaseUntil: 0 });
        if (saved) out.sent += 1; else out.skipped += 1;
        continue;
      }
      const attempts = (claim.item.attempts || 1) + 1;
      const message = String((result && result.error) || 'Email send failed').slice(0, 300);
      const values = attempts > MAX_ATTEMPTS
        ? { status: 'failed', attempts, lastError: message, leaseToken: null, leaseUntil: 0 }
        : { status: 'pending', attempts, lastError: message, nextAttemptAt: now() + backoffMs(attempts), leaseToken: null, leaseUntil: 0 };
      const saved = await updateIfLeaseMatches(db, ref, claim.leaseToken, values);
      if (!saved) { out.skipped += 1; continue; }
      if (attempts > MAX_ATTEMPTS) out.deadLettered += 1; else out.retrying += 1;
    } catch (e) {
      out.errors += 1;
      console.error('email queue worker failed for ' + doc.id + ':', e && e.message);
      // Do not clear a claim after an uncertain provider result. Its lease
      // expires and a later sweep can recover it without concurrent sends.
    }
  }
  return out;
}
module.exports = { processEmailQueue, backoffMs, claimItem, updateIfLeaseMatches, MAX_ATTEMPTS, BATCH_LIMIT, LEASE_MS };
