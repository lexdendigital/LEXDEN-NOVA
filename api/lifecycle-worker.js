'use strict';
const crypto = require('crypto');
const { getAuthAdmin } = require('./affiliate/shared');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TRUSTED_SOURCE = 'lifecycle-event-api';
const ALLOWED = new Set(['product_view', 'checkout_started', 'signup_started']);
const BATCH_LIMIT = 100;
function toMs(value) {
  if (value == null) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const result = Number(value);
  if (Number.isFinite(result)) return result;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeRecipient(event) {
  const email = String(event.email || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validTrustedEvent(event) {
  return !!event && event.schemaVersion === 1 && event.source === TRUSTED_SOURCE &&
    ALLOWED.has(event.eventType) && safeRecipient(event) &&
    ['verified', 'unverified'].includes(event.recipientVerification) &&
    typeof event.uid === 'string' && !!event.uid &&
    Number.isInteger(Number(event.stage)) && Number(event.stage) >= 0;
}
async function hasBought(db, event) {
  let query = db.collection('orders').where('email', '==', event.email);
  if (event.productId) query = query.where('productId', '==', event.productId);
  const snap = await query.limit(1).get();
  return !snap.empty;
}
async function accountExists(email, deps) {
  if (deps && typeof deps.accountExists === 'function') return deps.accountExists(email);
  try { await getAuthAdmin().getUserByEmail(email); return true; }
  catch (e) { if (e && e.code === 'auth/user-not-found') return false; throw e; }
}
function buildPayload(event, stage) {
  const firstName = String(event.name || '').trim().split(/\s+/)[0] || undefined;
  if (event.eventType === 'checkout_started') return {
    templateKey: stage === 0 ? 'checkout_recovery_1' : 'checkout_recovery_2',
    to: { email: event.email, name: event.name || undefined },
    params: {
      FIRSTNAME: firstName, product_name: event.productName || 'your selected item',
      product_url: event.productUrl || undefined, checkout_url: event.checkoutUrl || event.productUrl || undefined,
      variant: event.variant || undefined,
    },
  };
  if (event.eventType === 'signup_started') return {
    templateKey: 'signup_recovery', to: { email: event.email, name: event.name || undefined },
    params: { FIRSTNAME: firstName, signup_url: event.signupUrl || undefined },
  };
  return {
    templateKey: 'abandoned_product', to: { email: event.email, name: event.name || undefined },
    params: { product_name: event.productName || 'that product', product_url: event.productUrl || undefined },
  };
}
async function suppressEvent(db, eventId, reason, nowMs) {
  await db.collection('productViewEvents').doc(eventId).set({
    lifecycleState: 'suppressed', suppressionReason: reason, lastProcessedAt: new Date(nowMs),
  }, { merge: true });
}
async function suppressionReasonForEvent(db, event, deps) {
  if (!validTrustedEvent(event)) return 'invalid_server_schema';
  if (event.eventType === 'signup_started') {
    return await accountExists(event.email, deps) ? 'account_created' : null;
  }
  return await hasBought(db, event) ? 'order_completed' : null;
}
async function enqueueStage(db, eventId, event, nowMs) {
  const eventRef = db.collection('productViewEvents').doc(eventId);
  const stage = Number(event.stage || 0);
  const messageId = 'lifecycle_' + hash(eventId + '|' + stage).slice(0, 48);
  const messageRef = db.collection('emailQueue').doc(messageId);
  const dayStart = Math.floor(nowMs / DAY) * DAY;
  const countRef = db.collection('lifecycleMessageLimits').doc(hash(event.email + '|' + dayStart));
  const payload = buildPayload(event, stage);
  return db.runTransaction(async (tx) => {
    const [currentSnap, messageSnap, countSnap] = await Promise.all([tx.get(eventRef), tx.get(messageRef), tx.get(countRef)]);
    if (!currentSnap.exists) return { status: 'MISSING' };
    const current = currentSnap.data() || {};
    if (!validTrustedEvent(current) || current.lifecycleState !== 'pending' ||
        Number(current.stage || 0) !== stage || toMs(current.nextAttemptAt) > nowMs) return { status: 'STALE' };
    if (messageSnap.exists) return { status: 'ALREADY_QUEUED' };
    const count = countSnap.exists ? Number((countSnap.data() || {}).count) || 0 : 0;
    if (count >= 3) {
      tx.set(eventRef, { lifecycleState: 'suppressed', suppressionReason: 'recipient_message_limit', lastProcessedAt: new Date(nowMs) }, { merge: true });
      return { status: 'SUPPRESSED' };
    }
    tx.set(messageRef, {
      payload, attempts: 1, status: 'pending', createdAt: nowMs, nextAttemptAt: nowMs,
      lifecycleEventId: eventId, lifecycleStage: stage,
    });
    const checkoutFirst = current.eventType === 'checkout_started' && stage === 0;
    tx.set(eventRef, {
      lifecycleState: checkoutFirst ? 'pending' : 'completed',
      stage: checkoutFirst ? 1 : stage + 1,
      nextAttemptAt: checkoutFirst ? new Date(nowMs + 22 * HOUR) : null,
      lastProcessedAt: new Date(nowMs), lastQueueMessageId: messageId, suppressionReason: null,
    }, { merge: true });
    tx.set(countRef, { count: count + 1, windowStart: dayStart, updatedAt: new Date(nowMs) }, { merge: true });
    return { status: 'QUEUED', messageId };
  });
}
async function runLifecycleEmails(db, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const limit = Math.max(1, Math.min(BATCH_LIMIT, Number(options.limit) || BATCH_LIMIT));
  const deps = options.deps || {};
  const snap = await db.collection('productViewEvents')
    .where('source', '==', TRUSTED_SOURCE)
    .where('lifecycleState', '==', 'pending')
    .where('nextAttemptAt', '<=', new Date(nowMs))
    .orderBy('nextAttemptAt', 'asc').limit(limit).get();
  const out = { checked: snap.size, queued: 0, suppressed: 0, ignored: 0, errors: 0 };
  for (const doc of snap.docs) {
    const event = doc.data() || {};
    try {
      const suppression = await suppressionReasonForEvent(db, event, deps);
      if (suppression) {
        await suppressEvent(db, doc.id, suppression, nowMs);
        if (suppression === 'invalid_server_schema') out.ignored += 1;
        else out.suppressed += 1;
        continue;
      }
      const result = await enqueueStage(db, doc.id, event, nowMs);
      if (result.status === 'QUEUED') out.queued += 1;
      else if (result.status === 'SUPPRESSED') out.suppressed += 1;
      else out.ignored += 1;
    } catch (e) {
      out.errors += 1;
      console.error('lifecycle worker failed for event ' + doc.id + ':', e && e.message);
    }
  }
  return out;
}
module.exports = { runLifecycleEmails, validTrustedEvent, buildPayload, hasBought, accountExists, suppressionReasonForEvent, suppressEvent, BATCH_LIMIT, TRUSTED_SOURCE };
