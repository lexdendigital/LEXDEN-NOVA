// /api/creator-admin-automation.js
//
// LEXDEN NOVA CREATOR — Stage I. Admin control of the automation.
//
// GET  ?view=alerts[&status=open|resolved]   adminAlerts, newest first
// GET  ?view=runs                            recent scheduler runs
// GET  ?view=settings                        { autoRestrictSla, cronConfigured }
// POST { action: "resolve_alert", alertId, note? }
//      { action: "run_job", job }            run one job now (respects the lock)
//      { action: "set_auto_restrict", enabled }   switch automatic SLA pausing ON/OFF (default OFF)
//      { action: "lift_pause", scope: "sla"|"link"|"supplier", creatorId?, productId?, reason }
//            re-opens listings that AUTOMATION paused (never a creator's own pause,
//            never a suspension). Link/supplier pauses are re-checked first.
const { requireAdminAuth, getDb, FieldValue, ok, fail, setCors } = require('./creator/shared');
const { resolveAlert } = require('./automation/alerts');
const { runJob, JOB_NAMES } = require('./automation/runner');
const { checkProductLink } = require('./automation/jobs');
const supplier = require('./supplier/service');
const store = require('./supplier/store');
const { assertProductTransition, PRODUCT_STATES } = require('./creator/product-state-machine');

const FLAG_BY_SCOPE = { sla: 'pausedBySla', link: 'pausedByLink', supplier: 'pausedBySupplier' };

async function liftPause(db, admin, { scope, creatorId, productId, reason }) {
  const flag = FLAG_BY_SCOPE[scope];
  if (!flag) throw Object.assign(new Error('scope must be sla, link or supplier.'), { status: 422, code: 'INVALID_SCOPE' });
  if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error('A reason is required.'), { status: 422, code: 'REASON_REQUIRED' });
  if (!creatorId && !productId) throw Object.assign(new Error('Give a creatorId or a productId.'), { status: 422, code: 'TARGET_REQUIRED' });
  let q = db.collection('products').where('status', '==', PRODUCT_STATES.PAUSED);
  q = productId ? q : q.where('creatorId', '==', creatorId);
  const snap = await q.limit(200).get();
  const result = { lifted: 0, blocked: [] };
  for (const d of snap.docs) {
    const p = { id: d.id, ...d.data() };
    if (productId && p.id !== productId) continue;
    if (!p[flag]) continue; // only what this automation paused
    if (scope === 'link') {
      const { verdict } = await checkProductLink(db, p, { nowMs: Date.now(), deps: {} });
      if (verdict.state !== 'HEALTHY') { result.blocked.push({ productId: p.id, reason: verdict.reason }); continue; }
    }
    if (scope === 'supplier') {
      const v = await supplier.checkMappingHealth(db, { productId: p.id, minGapMs: 0 }).catch((e) => ({ health: 'DEGRADED', reasons: [e.message] }));
      if (v.health === 'DEGRADED') { result.blocked.push({ productId: p.id, reason: (v.reasons || [])[0] }); continue; }
      if ((await store.getProduct(db, p.id)).status !== PRODUCT_STATES.PAUSED) continue;
    }
    assertProductTransition(PRODUCT_STATES.PAUSED, PRODUCT_STATES.PUBLISHED);
    await db.collection('products').doc(p.id).set({ status: PRODUCT_STATES.PUBLISHED, [flag]: false, pauseReason: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await store.writeProductAudit(db, { actorUid: admin.uid, actorRole: 'admin', action: `product.lift_auto_pause_${scope}`, productId: p.id, reason: reason.trim() });
    result.lifted += 1;
  }
  return result;
}

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let admin;
  try { admin = await requireAdminAuth(req); } catch (e) { return fail(res, e); }
  const db = getDb();
  try {
    if (req.method === 'GET') {
      const view = (req.query && req.query.view) || 'alerts';
      if (view === 'alerts') {
        const snap = await db.collection('adminAlerts').orderBy('lastSeenAtMs', 'desc').limit(200).get();
        let alerts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (req.query.status) alerts = alerts.filter((a) => a.status === req.query.status);
        return ok(res, { alerts: alerts.map(({ createdAt, updatedAt, ...a }) => a) });
      }
      if (view === 'runs') {
        const snap = await db.collection('automationRuns').orderBy('startedAtMs', 'desc').limit(60).get();
        return ok(res, { runs: snap.docs.map((d) => { const { createdAt, ...r } = d.data(); return { id: d.id, ...r }; }) });
      }
      if (view === 'settings') {
        const s = await db.collection('automationSettings').doc('config').get();
        const c = (s.exists && s.data()) || {};
        return ok(res, { autoRestrictSla: c.autoRestrictSla === true, cronConfigured: !!(process.env.CRON_SECRET && process.env.CRON_SECRET.length >= 16), jobs: JOB_NAMES });
      }
      return fail(res, { status: 400, code: 'INVALID_VIEW', message: `Unknown view "${view}".` });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    const b = req.body || {};
    if (b.action === 'resolve_alert') {
      if (typeof b.alertId !== 'string' || !b.alertId || b.alertId.includes('/')) return fail(res, { status: 422, code: 'MISSING_ALERT_ID', message: 'alertId is required.' });
      return ok(res, await resolveAlert(db, b.alertId, { by: admin.uid, note: b.note }));
    }
    if (b.action === 'run_job') {
      if (!JOB_NAMES.includes(b.job)) return fail(res, { status: 422, code: 'UNKNOWN_JOB', message: `job must be one of: ${JOB_NAMES.join(', ')}.` });
      return ok(res, await runJob(db, b.job, { force: true, trigger: 'admin' }));
    }
    if (b.action === 'set_auto_restrict') {
      if (typeof b.enabled !== 'boolean') return fail(res, { status: 422, code: 'INVALID_VALUE', message: 'enabled must be true or false.' });
      await db.collection('automationSettings').doc('config').set({ autoRestrictSla: b.enabled, updatedBy: admin.uid, updatedAtMs: Date.now() }, { merge: true });
      await store.writeCreatorAudit(db, { actorUid: admin.uid, actorRole: 'admin', action: b.enabled ? 'automation.auto_restrict_on' : 'automation.auto_restrict_off', targetType: 'setting', targetId: 'creatorAutoRestrictSla' });
      return ok(res, { autoRestrictSla: b.enabled });
    }
    if (b.action === 'lift_pause') return ok(res, await liftPause(db, admin, b));
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${b.action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
module.exports.liftPause = liftPause;
