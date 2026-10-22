const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fake = require('./helpers/fake-db');
const { build, applyValues, mdToHtml } = require('../scripts/build-policies');
const acceptApi = require('../api/policy-accept');
const internalApi = require('../api/policy-internal');
const cfg = require('../api/core/config');

test.before(() => fake.install());
test.after(() => fake.restore());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pol-'));

test('draft build: every page carries the DRAFT / REVIEW REQUIRED banner and is noindex', () => {
  const out = tmp(); const r = build({ out, approved: false });
  assert.equal(r.approved, false);
  for (const d of r.documents) { const h = fs.readFileSync(path.join(out, `${d.id}.html`), 'utf8'); assert.match(h, /DRAFT — REVIEW REQUIRED/); assert.match(h, /noindex/); }
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /DRAFT/);
});
test('internal procedures and blockers never reach the public output', () => {
  const out = tmp(); build({ out, approved: false });
  const files = fs.readdirSync(out).join(' ');
  for (const id of ['retention', 'breach-response', 'moderation', 'refund-dispute-operations', 'ai-governance', 'publication-blockers']) assert.equal(files.includes(id), false, id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'registry.json'), 'utf8')).documents.some((d) => d.audience === 'internal'), false);
});
test('values come from config: fee %, window days; no Google search links; no unresolved templates', () => {
  const out = tmp(); build({ out, approved: false });
  const pay = fs.readFileSync(path.join(out, 'creator-payouts.html'), 'utf8');
  assert.match(pay, new RegExp(`Creator commission: ${cfg.CREATOR_COMMISSION_BPS / 100}%`));
  assert.match(pay, new RegExp(`Affiliate withdrawal fee: ${cfg.AFFILIATE_WITHDRAWAL_FEE_BPS / 100}%`));
  assert.match(fs.readFileSync(path.join(out, 'refunds.html'), 'utf8'), new RegExp(`${cfg.DISPUTE_POLICIES.PHYSICAL.windowDays} calendar days after delivery`));
  for (const f of fs.readdirSync(out)) { const h = fs.readFileSync(path.join(out, f), 'utf8'); assert.equal(/google\.com\/search/.test(h), false, f); assert.equal(/\{\{[A-Z_]+\}\}/.test(h), false, f); }
  assert.throws(() => applyValues('x {{NOPE}}', {}), /Unknown template/);
});
test('start-up operator details are filled honestly (no invented company number); seller template stays exempt', () => {
  const out = tmp(); build({ out, approved: false });
  const terms = fs.readFileSync(path.join(out, 'terms.html'), 'utf8');
  assert.match(terms, /unregistered start-up/);
  assert.equal(/CAC|RC\s?\d{5,}/.test(terms), false);
  assert.equal(/\[LEXDEN LEGAL ENTITY NAME\]|\[EFFECTIVE DATE\]|\[REGISTERED ADDRESS\]|\[LEGAL NOTICE EMAIL\]/.test(terms), false);
  const r = build({ out: tmp(), approved: true, check: true });
  assert.equal(r.problems.length, 0);
});
test('the shopper app links to first-party pages only', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'js', 'shopper.js'), 'utf8');
  assert.equal(/google\.com\/search\?q=lexden/.test(js), false);
  assert.match(js, /legal\/privacy\.html/); assert.match(js, /legal\/terms\.html/);
});
test('markdown renderer escapes HTML', () => { assert.equal(mdToHtml('<script>x</script>').includes('<script>'), false); });
test('acceptance records the SERVER version + content id, is append-only and idempotent', async () => {
  const db = fake.makeDb(); const registry = acceptApi.accept.length ? undefined : undefined;
  const a = await acceptApi.accept(db, { uid: 'u1', policyId: 'creator-terms', context: 'CREATOR_ACTIVATION' });
  assert.equal(a.recorded, true); assert.equal(a.version, '1.0-draft');
  const b = await acceptApi.accept(db, { uid: 'u1', policyId: 'creator-terms', context: 'CREATOR_ACTIVATION' });
  assert.equal(b.recorded, false); assert.equal(Object.keys(db._store.policyAcceptances).length, 1);
  await assert.rejects(acceptApi.accept(db, { uid: 'u1', policyId: 'retention', context: 'CREATOR_ACTIVATION' }), (e) => e.code === 'UNKNOWN_POLICY');
  await assert.rejects(acceptApi.accept(db, { uid: 'u1', policyId: 'terms', context: 'WHATEVER' }), (e) => e.code === 'BAD_CONTEXT');
});
test('internal docs need admin auth; public API never lists them', async () => {
  const mk = () => { const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, setHeader() {}, end() { return r; } }; return r; };
  const deny = internalApi.makeHandler({ adminAuth: async () => { const e = new Error('Not authorized.'); e.status = 403; throw e; } });
  const r1 = mk(); await deny({ method: 'GET', query: { id: 'retention' } }, r1); assert.equal(r1.code, 403);
  const allow = internalApi.makeHandler({ adminAuth: async () => ({ uid: 'a' }) });
  const r2 = mk(); await allow({ method: 'GET', query: {} }, r2); assert.ok(r2.body.data.documents.some((d) => d.id === 'retention'));
  const r3 = mk(); await allow({ method: 'GET', query: { id: 'publication-blockers' } }, r3); assert.match(r3.body.data.markdown, /BLOCKER 1/);
});
