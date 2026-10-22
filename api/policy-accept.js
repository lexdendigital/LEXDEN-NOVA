// /api/policy-accept.js
//   POST {policyId, context}  (signed-in user)  -> records WHICH version they accepted, when, and a content id
//   GET  ?policyId=            (signed-in user)  -> the caller's own acceptance (if any)
// The version + content hash come from the SERVER copy of policies/registry.json + the built
// legal/registry.json, never from the browser, so a client cannot claim a version that does not exist.
// A record is append-only (create-semantics): re-accepting the same version is a no-op.
const fs = require('fs');
const path = require('path');
const { getDb, requireAuth, ok, fail, setCors } = require('./creator/shared');

const ROOT = path.join(__dirname, '..');
const CONTEXTS = ['ACCOUNT_SIGNUP', 'CREATOR_ACTIVATION', 'AFFILIATE_SIGNUP', 'PRODUCT_SUBMISSION', 'CHECKOUT'];
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

function loadRegistry() {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'registry.json'), 'utf8'));
  let built = {};
  try { for (const d of JSON.parse(fs.readFileSync(path.join(ROOT, 'legal', 'registry.json'), 'utf8')).documents) built[d.id] = d; } catch { /* not built yet */ }
  return { reg, built };
}

async function accept(db, { uid, policyId, context, nowMs = Date.now(), registry = loadRegistry() }) {
  const doc = registry.reg.documents.find((d) => d.id === policyId && d.audience !== 'internal');
  if (!doc) throw err(404, 'UNKNOWN_POLICY', 'That document does not exist.');
  if (!CONTEXTS.includes(context)) throw err(422, 'BAD_CONTEXT', `context must be one of ${CONTEXTS.join(', ')}.`);
  const b = registry.built[policyId];
  const contentHash = b ? b.contentHash : null;
  const id = `${uid}__${policyId}__${doc.version}`.replace(/[^A-Za-z0-9_\-.]/g, '_');
  const rec = { uid, policyId, version: doc.version, contentHash, status: b ? b.status : 'DRAFT', context, acceptedAtMs: nowMs };
  try { await db.collection('policyAcceptances').doc(id).create(rec); return { recorded: true, ...rec }; }
  catch (e) { if (e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message)))) return { recorded: false, already: true, ...(await db.collection('policyAcceptances').doc(id).get()).data() }; throw e; }
}

function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      const u = await (deps.auth || requireAuth)(req);
      const db = deps.db || getDb();
      if (req.method === 'POST') { const b = req.body || {}; return ok(res, await accept(db, { uid: u.uid, policyId: String(b.policyId || ''), context: b.context, registry: deps.registry })); }
      if (req.method === 'GET') {
        const pid = String((req.query && req.query.policyId) || '');
        const snap = await db.collection('policyAcceptances').where('uid', '==', u.uid).limit(100).get();
        return ok(res, { acceptances: snap.docs.map((d) => d.data()).filter((a) => !pid || a.policyId === pid) });
      }
      return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.accept = accept;
