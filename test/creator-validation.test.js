const test = require('node:test');
const assert = require('node:assert/strict');
const { validateForSubmit, ageFromDob, MIN_PERSONAL_CREATOR_AGE } = require('../api/creator/validation');

function iso(yearsAgo) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d.toISOString();
}

const validPersonalPrivate = () => ({
  legalName: 'Ada Lovelace',
  dob: iso(25),
  email: 'ada@example.com',
  phone: '+2348012345678',
  acceptedTermsAt: new Date(),
});
const validPersonalPublic = () => ({
  category: 'apps',
  displayName: 'Ada Codes',
  profileImageUrl: 'https://example.com/ada.jpg',
});

const validBusinessPrivate = () => ({
  legalBusinessName: 'Lovelace Software Ltd',
  contactName: 'Ada Lovelace',
  email: 'hello@lovelacesoftware.com',
  whatsapp: '+2348012345678',
  documentIds: ['doc_1'],
  acceptedTermsAt: new Date(),
});
const validBusinessPublic = () => ({
  category: 'software',
  businessDisplayName: 'Lovelace Software',
  profileImageUrl: 'https://example.com/logo.png',
  socialHandles: ['https://instagram.com/lovelacesoftware'],
});

test('a fully-correct personal application passes', () => {
  const { ok, errors } = validateForSubmit({ creatorType: 'personal', publicFields: validPersonalPublic(), privateFields: validPersonalPrivate() });
  assert.equal(ok, true, JSON.stringify(errors));
});

test('a fully-correct business application passes', () => {
  const { ok, errors } = validateForSubmit({ creatorType: 'business', publicFields: validBusinessPublic(), privateFields: validBusinessPrivate() });
  assert.equal(ok, true, JSON.stringify(errors));
});

test('personal application rejects an applicant under the minimum age', () => {
  const priv = { ...validPersonalPrivate(), dob: iso(16) };
  const { ok, errors } = validateForSubmit({ creatorType: 'personal', publicFields: validPersonalPublic(), privateFields: priv });
  assert.equal(ok, false);
  const dobError = errors.find(e => e.field === 'dob');
  assert.ok(dobError, 'expected a dob error');
  assert.equal(dobError.code, 'BELOW_MIN_AGE');
});

test('an applicant exactly at the minimum age passes the age check', () => {
  const priv = { ...validPersonalPrivate(), dob: iso(MIN_PERSONAL_CREATOR_AGE) };
  const { ok } = validateForSubmit({ creatorType: 'personal', publicFields: validPersonalPublic(), privateFields: priv });
  assert.equal(ok, true);
});

test('personal application never requires a legal name on the PUBLIC side', () => {
  // legalName only lives in privateFields — this test guards against a
  // future edit accidentally requiring it in publicFields and leaking it.
  const { ok } = validateForSubmit({ creatorType: 'personal', publicFields: { ...validPersonalPublic(), legalName: undefined }, privateFields: validPersonalPrivate() });
  assert.equal(ok, true);
});

test('business application requires at least one uploaded document', () => {
  const priv = { ...validBusinessPrivate(), documentIds: [] };
  const { ok, errors } = validateForSubmit({ creatorType: 'business', publicFields: validBusinessPublic(), privateFields: priv });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'documentIds'));
});

test('business application requires at least one social handle', () => {
  const pub = { ...validBusinessPublic(), socialHandles: [] };
  const { ok, errors } = validateForSubmit({ creatorType: 'business', publicFields: pub, privateFields: validBusinessPrivate() });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'socialHandles'));
});

test('missing terms acceptance fails regardless of creator type', () => {
  const priv = { ...validPersonalPrivate(), acceptedTermsAt: null };
  const { ok, errors } = validateForSubmit({ creatorType: 'personal', publicFields: validPersonalPublic(), privateFields: priv });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'acceptedTermsAt'));
});

test('physical-selling applicants must provide a delivery operating area', () => {
  const { ok, errors } = validateForSubmit({
    creatorType: 'personal',
    publicFields: validPersonalPublic(),
    privateFields: validPersonalPrivate(),
    willSellPhysical: true,
  });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'deliveryOperatingArea'));
});

test('invalid creator type is rejected immediately', () => {
  const { ok, errors } = validateForSubmit({ creatorType: 'nonprofit', publicFields: {}, privateFields: {} });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'creatorType'));
});

test('ageFromDob handles an invalid date without throwing', () => {
  assert.equal(ageFromDob('not-a-date'), null);
});
