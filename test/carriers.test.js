const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../api/creator/carriers');

test('known carriers get a generated tracking link; unknown carriers get none (never guessed)', () => {
  const dhl = c.resolveShipment({ carrier: 'DHL Express', trackingNumber: '1234 5678 90' });
  assert.equal(dhl.ok, true); assert.equal(dhl.trackingNumber, '1234567890'); assert.equal(dhl.knownCarrier, 'DHL');
  assert.match(dhl.trackingUrl, /^https:\/\/www\.dhl\.com\/.*tracking-id=1234567890$/);
  assert.match(c.resolveShipment({ carrier: 'fedex', trackingNumber: 'ABC12345' }).trackingUrl, /fedex\.com.*ABC12345/);
  assert.match(c.resolveShipment({ carrier: 'CJPacket', trackingNumber: 'CJ123456789US' }).trackingUrl, /17track\.net/);
  const local = c.resolveShipment({ carrier: 'Local Dispatch Rider', trackingNumber: 'LOCAL-001' });
  assert.equal(local.ok, true); assert.equal(local.trackingUrl, null); assert.equal(local.knownCarrier, null);
});

test('a seller-supplied link wins; only http(s) links are ever accepted', () => {
  const r = c.resolveShipment({ carrier: 'DHL', trackingNumber: 'ABC12345', trackingUrl: 'https://track.example.com/x?id=1' });
  assert.equal(r.trackingUrl, 'https://track.example.com/x?id=1');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x.com/a', 'not a url', 'https://user:pw@evil.com/', 'vbscript:x']) {
    const x = c.resolveShipment({ carrier: 'DHL', trackingNumber: 'ABC12345', trackingUrl: bad });
    assert.equal(x.ok, false, bad); assert.equal(x.errors[0].field, 'trackingUrl');
  }
  assert.equal(c.resolveShipment({ carrier: 'DHL', trackingNumber: 'ABC12345', trackingUrl: 'x'.repeat(600) }).ok, false);
});

test('tracking numbers are cleaned and weird input is refused', () => {
  assert.equal(c.normalizeTrackingNumber('  ab 12-34/5  '), 'ab12-34/5');
  for (const bad of ['', 'abc', '<script>', 'a'.repeat(51), 'x y;z', null, 12345]) assert.equal(c.normalizeTrackingNumber(bad), null, String(bad));
  const r = c.resolveShipment({ carrier: '', trackingNumber: '' });
  assert.equal(r.ok, false); assert.deepEqual(r.errors.map((e) => e.field).sort(), ['carrier', 'trackingNumber']);
});

test('tracking number is URL-encoded inside generated links', () => {
  const r = c.resolveShipment({ carrier: 'UPS', trackingNumber: 'AB/12.3' });
  assert.ok(r.trackingUrl.endsWith('tracknum=AB%2F12.3'));
  assert.equal(c.resolveShipment({ carrier: 'UPS', trackingNumber: 'AB12&x=1' }).ok, false); // '&' and '=' never pass
});
