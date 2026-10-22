// /api/pickup-stations.js   (needs PICKUP_STATIONS_ENABLED=true; otherwise 503 / empty list)
//   GET                                   PUBLIC  -> approved stations only (no phone, no owner, never residential)
//   POST {action:"submit", details}       SIGNED-IN business owner -> SUBMITTED for review
//   GET  ?mine=1                          SIGNED-IN -> the caller's own submissions (status + review note)
//   GET  ?admin=1&state=                  ADMIN   -> stations in a state (default SUBMITTED)
//   POST {action:"review", id, to, checks, note}   ADMIN -> UNDER_REVIEW | APPROVED | REJECTED | NEEDS_CHANGES | SUSPENDED
const { getDb, requireAuth, requireAdminAuth, ok, fail, setCors, writeCreatorAuditLog } = require('./creator/shared');
const S = require('./delivery/stations');

const E = (status, code, message) => Object.assign(new Error(message), { status, code });
const FIELDS = ['name', 'address', 'city', 'state', 'openingHours', 'contactPhone', 'managerName', 'businessType', 'isResidential'];
const clean = (d) => { const o = {}; for (const k of FIELDS) if (d && d[k] !== undefined) o[k] = typeof d[k] === 'string' ? d[k].trim().slice(0, 200) : d[k]; return o; };

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const db = deps.db || getDb();
      const env = deps.env || process.env;
      const q = req.query || {};
      if (req.method === 'GET' && !q.mine && !q.admin) {
        if (!S.enabled(env)) return ok(res, { enabled: false, stations: [] });
        const snap = await db.collection('pickupStations').where('state', '==', 'APPROVED').limit(300).get();
        return ok(res, { enabled: true, stations: snap.docs.map((d) => S.publicView(d.data(), env)).filter(Boolean) });
      }
      if (req.method === 'GET' && q.mine) {
        const u = await (deps.auth || requireAuth)(req);
        const snap = await db.collection('pickupStations').where('ownerUid', '==', u.uid).limit(20).get();
        return ok(res, { enabled: S.enabled(env), stations: snap.docs.map((d) => { const s = d.data(); return { id: s.id, name: s.name, state: s.state, reviewNote: s.reviewNote || null }; }) });
      }
      if (req.method === 'GET' && q.admin) {
        await (deps.adminAuth || requireAdminAuth)(req);
        const state = S.STATES[String(q.state || 'SUBMITTED').toUpperCase()] || 'SUBMITTED';
        const snap = await db.collection('pickupStations').where('state', '==', state).limit(200).get();
        return ok(res, { enabled: S.enabled(env), reviewChecks: S.REVIEW_CHECKS, stations: snap.docs.map((d) => d.data()) });
      }
      if (req.method !== 'POST') throw E(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST.');
      const b = req.body || {};
      if (b.action === 'submit') {
        const u = await (deps.auth || requireAuth)(req);
        const mine = await db.collection('pickupStations').where('ownerUid', '==', u.uid).limit(10).get();
        if (mine.size >= 5) throw E(429, 'TOO_MANY_STATIONS', 'You already have 5 stations submitted.');
        return ok(res, await S.submit(db, { ownerUid: u.uid, details: clean(b.details), env }));
      }
      if (b.action === 'review') {
        const admin = await (deps.adminAuth || requireAdminAuth)(req);
        if (!S.enabled(env)) throw E(503, 'PICKUP_STATIONS_DISABLED', 'Pickup stations are not enabled yet.');
        const id = String(b.id || ''); if (!id || id.includes('/')) throw E(422, 'MISSING_ID', 'id is required.');
        const ref = db.collection('pickupStations').doc(id);
        const snap = await ref.get(); if (!snap.exists) throw E(404, 'NOT_FOUND', 'Station not found.');
        let cur = snap.data();
        // A reviewer can approve straight from "submitted": opening it for review is implied and recorded.
        if (cur.state === 'SUBMITTED' && b.to !== 'UNDER_REVIEW') cur = S.review(cur, { to: 'UNDER_REVIEW', reviewer: admin.uid });
        const next = S.review(cur, { to: String(b.to), checks: b.checks || {}, reviewer: admin.uid, note: b.note });
        await ref.set(next);
        writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `pickupStation.${next.state}`, targetType: 'pickupStation', targetId: id, reason: b.note || null }).catch(() => {});
        return ok(res, { station: next });
      }
      throw E(400, 'INVALID_ACTION', 'Unknown action.');
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
