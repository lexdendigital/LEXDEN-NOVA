const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../api/supplier/mapping');

const opt = (n, p) => ({ logisticName: n, logisticPrice: p });
const good = { variant: { vid: 'VID123', sellPrice: 5 }, stockTotal: 10, stockThreshold: 1, freightByCountry: { NG: [opt('CJPacket', 9), opt('DHL', 20)] }, declaredCostUsd: 5 };

test('validateMappingInput: defaults and normalisation', () => {
  const r = m.validateMappingInput({ cjVariantId: ' VID12345 ' });
  assert.ok(r.ok);
  assert.deepEqual(r.value.destinationCountries, ['NG']);
  assert.equal(r.value.stockThreshold, 1);
  assert.equal(r.value.cjVariantId, 'VID12345');
  const r2 = m.validateMappingInput({ cjVariantId: 'VID12345', destinationCountries: ['ng', 'NG', 'gh'] });
  assert.deepEqual(r2.value.destinationCountries, ['NG', 'GH']);
});

test('validateMappingInput: rejects bad input', () => {
  assert.equal(m.validateMappingInput({}).ok, false);
  assert.equal(m.validateMappingInput({ cjVariantId: 'a/b' }).ok, false);
  const bad = m.validateMappingInput({ cjVariantId: 'VID12345', declaredCostUsd: -1, destinationCountries: ['NGA'], stockThreshold: 1.5, sku: 'a b' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.field).sort(), ['declaredCostUsd', 'destinationCountries', 'sku', 'stockThreshold']);
  assert.equal(m.validateMappingInput({ cjVariantId: 'VID12345', destinationCountries: ['NG', 'GH', 'KE', 'ZA', 'US', 'GB'] }).ok, false);
});

test('summarizeStockRows adds up warehouses', () => {
  assert.equal(m.summarizeStockRows([{ storageNum: 3 }, { storageNum: 4 }]).total, 7);
  assert.equal(m.summarizeStockRows([]).inStock, false);
  assert.equal(m.summarizeStockRows(null).total, 0);
});

test('normalizeFreightOptions drops malformed options', () => {
  const o = m.normalizeFreightOptions([{ logisticName: 'A', logisticPrice: '3.5' }, { logisticPrice: 1 }, { logisticName: 'B', logisticPrice: 'x' }]);
  assert.deepEqual(o, [{ logisticName: 'A', logisticPrice: 3.5, aging: null }]);
});

test('evaluateMapping: VALID picks the cheapest method per country', () => {
  const e = m.evaluateMapping(good);
  assert.equal(e.status, 'VALID');
  assert.equal(e.chosenLogistic, 'CJPacket');
  assert.deepEqual(e.logisticByCountry, { NG: 'CJPacket' });
  assert.equal(e.costDriftPct, 0);
});

test('evaluateMapping: unknown variant, no stock, no shipping all fail', () => {
  assert.equal(m.evaluateMapping({ ...good, variant: null }).status, 'INVALID');
  const oos = m.evaluateMapping({ ...good, stockTotal: 0 });
  assert.equal(oos.status, 'INVALID'); assert.equal(oos.checks.stockOk, false);
  const noShip = m.evaluateMapping({ ...good, freightByCountry: { NG: [] } });
  assert.equal(noShip.status, 'INVALID'); assert.equal(noShip.checks.shippingOk, false);
  // threshold 0 does not make an empty shelf sellable
  assert.equal(m.evaluateMapping({ ...good, stockTotal: 0, stockThreshold: 0 }).status, 'INVALID');
});

test('evaluateMapping: preferred method honoured per country, never silently swapped', () => {
  const ok = m.evaluateMapping({ ...good, preferredLogistic: 'dhl' });
  assert.equal(ok.logisticByCountry.NG, 'DHL');
  const bad = m.evaluateMapping({ ...good, preferredLogistic: 'FedEx' });
  assert.equal(bad.status, 'INVALID');
  const multi = m.evaluateMapping({ ...good, freightByCountry: { NG: [opt('A', 1)], GH: [opt('B', 2)] } });
  assert.deepEqual(multi.logisticByCountry, { NG: 'A', GH: 'B' });
  const oneMissing = m.evaluateMapping({ ...good, freightByCountry: { NG: [opt('A', 1)], GH: [] } });
  assert.equal(oneMissing.status, 'INVALID');
});

test('evaluateMapping: cost drift percentage', () => {
  assert.equal(m.evaluateMapping({ ...good, variant: { vid: 'V1', sellPrice: 6.5 } }).costDriftPct, 30);
});

test('deriveHealth: states', () => {
  const valid = m.evaluateMapping(good);
  assert.equal(m.deriveHealth({ connectionStatus: 'CONNECTED', evaluation: valid }).health, 'HEALTHY');
  const notConnected = m.deriveHealth({ connectionStatus: 'REVOKED', evaluation: valid });
  assert.equal(notConnected.pause, true);
  const drift = m.deriveHealth({ connectionStatus: 'CONNECTED', evaluation: m.evaluateMapping({ ...good, variant: { vid: 'V1', sellPrice: 7 } }) });
  assert.equal(drift.health, 'WARNING'); assert.equal(drift.pause, false);
  const invalid = m.deriveHealth({ connectionStatus: 'CONNECTED', evaluation: m.evaluateMapping({ ...good, stockTotal: 0 }) });
  assert.equal(invalid.health, 'DEGRADED'); assert.equal(invalid.pause, true);
});

test('deriveHealth: auth failure pauses at once; outages only after 3 in a row', () => {
  assert.equal(m.deriveHealth({ connectionStatus: 'CONNECTED', probeError: { code: 'AUTH_FAILED' } }).pause, true);
  let n = 0; const outcomes = [];
  for (let i = 0; i < 3; i++) { const h = m.deriveHealth({ connectionStatus: 'CONNECTED', probeError: { code: 'TIMEOUT' }, consecutiveFailures: n }); n = h.consecutiveFailures; outcomes.push(h.pause); }
  assert.deepEqual(outcomes, [false, false, true]);
  const other = m.deriveHealth({ connectionStatus: 'CONNECTED', probeError: { code: 'WEIRD', message: 'x' } });
  assert.equal(other.pause, false);
});

test('assertDropshipReady: first problem is reported, in order', () => {
  const conn = { status: 'CONNECTED' };
  const map = { status: 'VALID', testedAtMs: 1000 };
  const code = (args) => { try { m.assertDropshipReady(args); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(code({ creatorStatus: 'SUSPENDED', connection: conn, mapping: map }), 'CREATOR_NOT_ELIGIBLE');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: null, mapping: map }), 'SUPPLIER_NOT_CONNECTED');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: { status: 'REVOKED' }, mapping: map }), 'SUPPLIER_NOT_CONNECTED');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: null }), 'MAPPING_MISSING');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: { status: 'INVALID', reasons: ['x'] } }), 'MAPPING_INVALID');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: map }), 'OK');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: map, nowMs: 1000 + m.MAPPING_MAX_AGE_MS + 1, maxAgeMs: m.MAPPING_MAX_AGE_MS }), 'MAPPING_STALE');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: map, nowMs: 2000, maxAgeMs: m.MAPPING_MAX_AGE_MS }), 'OK');
  assert.equal(code({ creatorStatus: 'ACTIVE', connection: conn, mapping: { status: 'VALID' }, nowMs: Date.now(), maxAgeMs: m.MAPPING_MAX_AGE_MS }), 'MAPPING_STALE');
});

test('planFulfillmentUpdate: SHIPPED needs tracking; DELIVERED is only evidence', () => {
  const noTrack = m.planFulfillmentUpdate('PENDING', { orderStatus: 'SHIPPED' });
  assert.deepEqual(noTrack.transitions, []);
  const ship = m.planFulfillmentUpdate('PENDING', { orderStatus: 'SHIPPED', trackNumber: 'TRK1', logisticName: 'CJPacket' });
  assert.deepEqual(ship.transitions.map((t) => t.to), ['PACKED', 'SHIPPED']);
  assert.equal(ship.transitions[1].trackingNumber, 'TRK1');
  assert.deepEqual(m.planFulfillmentUpdate('PACKED', { orderStatus: 'SHIPPED', trackNumber: 'T' }).transitions.map((t) => t.to), ['SHIPPED']);
  assert.deepEqual(m.planFulfillmentUpdate('SHIPPED', { orderStatus: 'SHIPPED', trackNumber: 'T' }).transitions, []);
  const del = m.planFulfillmentUpdate('SHIPPED', { orderStatus: 'DELIVERED', trackNumber: 'T' });
  assert.deepEqual(del.transitions, []);
  assert.equal(del.supplierPatch.carrierDelivered, true);
  const canc = m.planFulfillmentUpdate('PENDING', { orderStatus: 'CANCELLED' });
  assert.deepEqual(canc.transitions, []); assert.equal(canc.supplierPatch.status, 'CJ_CANCELLED');
  assert.equal(m.planFulfillmentUpdate('PENDING', { orderStatus: 'CREATED' }).supplierPatch.status, 'AWAITING_PAYMENT');
  assert.equal(m.planFulfillmentUpdate('PENDING', { orderStatus: 'MARTIAN' }).supplierPatch.status, 'UNKNOWN_STATUS');
});

test('resolveCountry never guesses unknown free text', () => {
  assert.deepEqual(m.resolveCountry('nigeria'), { code: 'NG', name: 'Nigeria' });
  assert.equal(m.resolveCountry('gh').code, 'GH');
  assert.equal(m.resolveCountry('Atlantis').code, null);
  assert.equal(m.resolveCountry('').code, 'NG');
});

test('connect throttle: 5 failures in 10 minutes', () => {
  const now = 1_000_000_000;
  const fresh = [1, 2, 3, 4, 5].map((i) => now - i * 1000);
  assert.equal(m.isConnectRateLimited(fresh, now), true);
  assert.equal(m.isConnectRateLimited(fresh.slice(0, 4), now), false);
  assert.equal(m.isConnectRateLimited(fresh, now + m.CONNECT_ATTEMPT_WINDOW_MS + 10_000), false);
  assert.equal(m.isConnectRateLimited(undefined, now), false);
});

test('fulfillment modes: SELLER_STOCK, CJ_DROPSHIP and MANUAL_SUPPLIER are supported; old listings default to seller stock', () => {
  assert.deepEqual([...m.SUPPORTED_FULFILLMENT_MODES], ['SELLER_STOCK', 'CJ_DROPSHIP', 'MANUAL_SUPPLIER']);
  assert.equal(m.normalizeFulfillmentMode(undefined), 'SELLER_STOCK');
  assert.equal(m.normalizeFulfillmentMode('CJ_DROPSHIP'), 'CJ_DROPSHIP');
});

test('assertDropshipReady: a test recorded just after "now" (re-test during approval) is not stale', () => {
  const now = Date.now();
  assert.equal(m.assertDropshipReady({ creatorStatus: 'ACTIVE', connection: { status: 'CONNECTED' }, mapping: { status: 'VALID', testedAtMs: now + 40 }, nowMs: now, maxAgeMs: m.MAPPING_MAX_AGE_MS }), true);
});
