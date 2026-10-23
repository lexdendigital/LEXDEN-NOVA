// /api/policy-internal.js  (ADMIN ONLY)
// Internal procedures (retention, breach response, moderation, refund operations, AI governance) and the
// publication-blockers register. They are NOT in the static site; they are only served here, after an admin check.
//   GET            -> list
//   GET ?id=<id>   -> {markdown}
const fs = require('fs');
const path = require('path');
const { requireAdminAuth, ok, fail, setCors } = require('./creator/shared');

const ROOT = path.join(__dirname, '..');
function docs() {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'policies', 'registry.json'), 'utf8')).documents.filter((d) => d.audience === 'internal');
  return [...reg, { id: 'publication-blockers', title: 'Publication blockers & readiness gates', audience: 'internal', source: 'implementation/28_PUBLICATION_BLOCKERS.md', version: '1', status: 'OPEN' },
    { id: 'source-register', title: 'Research & source register', audience: 'internal', source: 'implementation/RESEARCH_AND_SOURCE_REGISTER.md', version: '1', status: 'OPEN' }];
}
function makeHandler(deps = {}) {
  return async function handler(req, res) {
    setCors(res);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
      await (deps.adminAuth || requireAdminAuth)(req);
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
      const list = docs();
      const id = req.query && req.query.id;
      if (!id) return ok(res, { documents: list.map(({ id: i, title, version, status }) => ({ id: i, title, version, status })) });
      const d = list.find((x) => x.id === String(id));
      if (!d) { const e = new Error('Not found.'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
      return ok(res, { id: d.id, title: d.title, markdown: fs.readFileSync(path.join(ROOT, 'policies', 'src', d.source), 'utf8') });
    } catch (e) { return fail(res, e); }
  };
}
module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
module.exports.docs = docs;
