const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductForSubmit, validateProductDraft } = require('../api/creator/product-validation');

const baseCommon = () => ({
  title: 'My Great Product',
  description: 'A genuinely useful thing, described well.',
  category: 'software',
  images: ['https://example.com/img.jpg'],
  price: 25,
  currency: 'USD',
  refundPolicy: 'No refunds after download.',
});

test('a complete PHYSICAL_PRODUCT passes', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'PHYSICAL_PRODUCT', stock: 10, weightGrams: 300, shippingOrigin: 'Lagos, NG' });
  assert.equal(ok, true, JSON.stringify(errors));
});

test('PHYSICAL_PRODUCT missing stock/weight/origin fails with specific fields', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'PHYSICAL_PRODUCT' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'stock'));
  assert.ok(errors.some(e => e.field === 'weightGrams'));
  assert.ok(errors.some(e => e.field === 'shippingOrigin'));
});

test('a complete DIGITAL_DOWNLOAD with an uploaded file passes', () => {
  const { ok } = validateProductForSubmit({ ...baseCommon(), offeringType: 'DIGITAL_DOWNLOAD', fileAssetId: 'asset_1' });
  assert.equal(ok, true);
});

test('a DIGITAL_DOWNLOAD with an external URL instead of a file also passes', () => {
  const { ok } = validateProductForSubmit({ ...baseCommon(), offeringType: 'DIGITAL_DOWNLOAD', externalUrl: 'https://example.com/dl' });
  assert.equal(ok, true);
});

test('a DIGITAL_DOWNLOAD with neither a file nor an external URL fails', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'DIGITAL_DOWNLOAD' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'fileAssetId'));
});

test('SOFTWARE additionally requires systemRequirements', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'SOFTWARE', fileAssetId: 'a1' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'systemRequirements'));
  const pass = validateProductForSubmit({ ...baseCommon(), offeringType: 'SOFTWARE', fileAssetId: 'a1', systemRequirements: 'Windows 10+' });
  assert.equal(pass.ok, true);
});

test('EBOOK requires pageCount', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'EBOOK', fileAssetId: 'a1' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'pageCount'));
});

test('TEMPLATE requires compatibility', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'TEMPLATE', fileAssetId: 'a1' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'compatibility'));
});

test('COURSE requires at least one titled module and a level', () => {
  const noModules = validateProductForSubmit({ ...baseCommon(), offeringType: 'COURSE' });
  assert.equal(noModules.ok, false);
  assert.ok(noModules.errors.some(e => e.field === 'modules'));

  const untitledModule = validateProductForSubmit({ ...baseCommon(), offeringType: 'COURSE', modules: [{ title: '' }], level: 'Beginner' });
  assert.equal(untitledModule.ok, false);

  const pass = validateProductForSubmit({ ...baseCommon(), offeringType: 'COURSE', modules: [{ title: 'Intro' }], level: 'Beginner' });
  assert.equal(pass.ok, true);
});

test('SERVICE requires turnaround and deliverables', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'SERVICE' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'turnaround'));
  assert.ok(errors.some(e => e.field === 'deliverables'));
});

test('SUBSCRIPTION requires an access URL and a billing interval', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'SUBSCRIPTION', externalUrl: 'https://example.com' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'billingInterval'));
  const pass = validateProductForSubmit({ ...baseCommon(), offeringType: 'SUBSCRIPTION', externalUrl: 'https://example.com', billingInterval: 'monthly' });
  assert.equal(pass.ok, true);
});

test('a free listing does not require price/currency', () => {
  const f = baseCommon(); delete f.price; delete f.currency;
  const { ok } = validateProductForSubmit({ ...f, offeringType: 'TEMPLATE', fileAssetId: 'a1', compatibility: 'Figma', isFree: true });
  assert.equal(ok, true);
});

test('a non-free listing without a price fails', () => {
  const f = baseCommon(); delete f.price;
  const { ok, errors } = validateProductForSubmit({ ...f, offeringType: 'TEMPLATE', fileAssetId: 'a1', compatibility: 'Figma' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'price'));
});

test('an invalid offeringType is rejected immediately', () => {
  const { ok, errors } = validateProductForSubmit({ ...baseCommon(), offeringType: 'NOT_A_TYPE' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'offeringType'));
});

test('missing title/description/images/refundPolicy are all caught regardless of type', () => {
  const { ok, errors } = validateProductForSubmit({ offeringType: 'SERVICE', price: 10, currency: 'USD', turnaround: '2 days', deliverables: 'a report' });
  assert.equal(ok, false);
  assert.ok(errors.some(e => e.field === 'title'));
  assert.ok(errors.some(e => e.field === 'description'));
  assert.ok(errors.some(e => e.field === 'images'));
  assert.ok(errors.some(e => e.field === 'refundPolicy'));
});

test('validateProductDraft only checks offeringType, nothing else', () => {
  assert.equal(validateProductDraft({ offeringType: 'EBOOK' }).ok, true);
  assert.equal(validateProductDraft({ offeringType: 'NOT_REAL' }).ok, false);
  assert.equal(validateProductDraft({}).ok, false);
});
