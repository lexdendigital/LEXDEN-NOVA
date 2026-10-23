const test = require('node:test');
const assert = require('node:assert/strict');
const fake = require('./helpers/fake-db');
const S = require('../api/delivery/stations');
const good = { businessType: 'PHARMACY', name: 'Ada Pharmacy', address: '5 Allen Ave', city: 'Ikeja', state: 'Lagos', openingHours: 'Mon-Sat 8-6', contactPhone: '0803', managerName: 'Ada' };
const checks = Object.fromEntries(S.REVIEW_CHECKS.map((c) => [c, true]));

test('residential and unknown business types are never eligible', () => {
  assert.equal(S.checkEligibility({ ...good, isResidential: true }).eligible, false);
  assert.equal(S.checkEligibility({ ...good, businessType: 'MY_HOUSE' }).eligible, false);
  assert.equal(S.checkEligibility({ ...good, address: '' }).eligible, false);
  assert.equal(S.checkEligibility(good).eligible, true);
});
test('flag off: cannot submit, nothing public', async () => {
  const db = fake.makeDb();
  await assert.rejects(S.submit(db, { ownerUid: 'u', details: good, env: {} }), (e) => e.code === 'PICKUP_STATIONS_DISABLED');
  assert.equal(S.publicView({ ...good, id: 's', state: 'APPROVED' }, {}), null);
});
test('review state machine: needs every check, reviewer, and notes for negative decisions', () => {
  const s = { ...good, state: 'UNDER_REVIEW' };
  assert.throws(() => S.review(s, { to: 'APPROVED', checks: { identityVerified: true }, reviewer: 'a' }), (e) => e.code === 'CHECKS_INCOMPLETE');
  assert.throws(() => S.review(s, { to: 'APPROVED', checks, reviewer: null }), (e) => e.code === 'REVIEWER_REQUIRED');
  assert.throws(() => S.review(s, { to: 'REJECTED', reviewer: 'a' }), (e) => e.code === 'NOTE_REQUIRED');
  assert.throws(() => S.review({ ...good, state: 'DRAFT' }, { to: 'APPROVED', checks, reviewer: 'a' }), (e) => e.code === 'INVALID_TRANSITION');
  assert.throws(() => S.review({ ...s, isResidential: true }, { to: 'APPROVED', checks, reviewer: 'a' }), (e) => e.code === 'NOT_ELIGIBLE');
  assert.equal(S.review(s, { to: 'APPROVED', checks, reviewer: 'a' }).state, 'APPROVED');
  assert.equal(S.canTransition('REJECTED', 'APPROVED'), false);
});
test('only approved stations are public, when the flag is on', async () => {
  const env = { PICKUP_STATIONS_ENABLED: 'true' };
  const db = fake.makeDb();
  const rec = await S.submit(db, { ownerUid: 'u', details: good, env });
  assert.equal(S.publicView(rec, env), null);
  const ok = S.review({ ...rec, state: 'UNDER_REVIEW' }, { to: 'APPROVED', checks, reviewer: 'a' });
  assert.equal(S.publicView(ok, env).name, 'Ada Pharmacy');
  assert.equal(JSON.stringify(S.publicView(ok, env)).includes('0803'), false);
});
