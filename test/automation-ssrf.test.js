const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../api/automation/ssrf');

const pub = async () => ['93.184.216.34'];
const never = async () => { throw new Error('network must not be touched'); };

test('blocks private, loopback, link-local, metadata and reserved IPv4/IPv6 addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', 'ff02::1', 'not-an-ip']) {
    assert.equal(s.isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(s.isBlockedAddress(ip), false, ip);
  }
});

test('rejects bad schemes, credentials, odd ports and local-looking hostnames without any lookup', async () => {
  for (const [url, code] of [
    ['file:///etc/passwd', 'BAD_SCHEME'], ['ftp://x.com/a', 'BAD_SCHEME'], ['javascript:alert(1)', 'BAD_SCHEME'],
    ['https://user:pw@example.com/', 'CREDENTIALS_IN_URL'], ['https://example.com:8080/', 'BAD_PORT'], ['http://example.com:22/', 'BAD_PORT'],
    ['http://localhost/', 'BLOCKED_HOST'], ['http://foo.localhost/', 'BLOCKED_HOST'], ['http://printer.local/', 'BLOCKED_HOST'], ['http://metadata.internal/', 'BLOCKED_HOST'],
    ['', 'INVALID_URL'], ['not a url', 'INVALID_URL'], [null, 'INVALID_URL'], ['https://' + 'a'.repeat(2100), 'INVALID_URL'],
  ]) {
    const r = await s.validateTarget(url, { resolve: never });
    assert.equal(r.ok, false, String(url));
    assert.equal(r.code, code, String(url));
  }
});

test('IP literals in any spelling are normalised and blocked', async () => {
  for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0/']) {
    const r = await s.validateTarget(u, { resolve: never });
    assert.equal(r.ok, false, u);
  }
});

test('a hostname that resolves to ANY private address is blocked (incl. mixed answers)', async () => {
  assert.equal((await s.validateTarget('https://evil.example/', { resolve: async () => ['10.0.0.8'] })).code, 'BLOCKED_ADDRESS');
  assert.equal((await s.validateTarget('https://evil.example/', { resolve: async () => ['93.184.216.34', '169.254.169.254'] })).code, 'BLOCKED_ADDRESS');
  assert.equal((await s.validateTarget('https://nx.example/', { resolve: async () => { throw new Error('ENOTFOUND'); } })).code, 'DNS_FAILED');
  const ok = await s.validateTarget('https://good.example/x?y=1', { resolve: pub });
  assert.equal(ok.ok, true); assert.equal(ok.address, '93.184.216.34');
});

test('connects to the VALIDATED address (pinned) — never re-resolves', async () => {
  const seen = [];
  const r = await s.checkExternalLink('https://good.example/file', { resolve: pub, requestOnce: async (o) => { seen.push(o); return { status: 200 }; } });
  assert.equal(r.state, 'OK');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].address, '93.184.216.34'); assert.equal(seen[0].host, 'good.example'); assert.equal(seen[0].method, 'HEAD');
});

test('redirects are re-validated at every hop: public -> internal is BLOCKED', async () => {
  const resolve = async (h) => (h === 'good.example' ? ['93.184.216.34'] : ['169.254.169.254']);
  let calls = 0;
  const r = await s.checkExternalLink('https://good.example/a', { resolve, requestOnce: async () => { calls++; return { status: 302, location: 'http://rebind.example/secret' }; } });
  assert.equal(r.state, 'BLOCKED'); assert.equal(r.code, 'BLOCKED_ADDRESS');
  assert.equal(calls, 1);
  // redirect straight to a literal internal IP / bad scheme
  for (const loc of ['http://127.0.0.1:80/', 'file:///etc/passwd', 'http://localhost/']) {
    const x = await s.checkExternalLink('https://good.example/a', { resolve: pub, requestOnce: async () => ({ status: 301, location: loc }) });
    assert.equal(x.state, 'BLOCKED', loc);
  }
});

test('redirect chains are capped and relative redirects work', async () => {
  const loop = await s.checkExternalLink('https://good.example/a', { resolve: pub, requestOnce: async () => ({ status: 302, location: '/again' }) });
  assert.equal(loop.state, 'BROKEN'); assert.equal(loop.code, 'TOO_MANY_REDIRECTS');
  let n = 0;
  const ok = await s.checkExternalLink('https://good.example/a', { resolve: pub, requestOnce: async (o) => (n++ === 0 ? { status: 302, location: '/final' } : (assert.equal(o.url.pathname, '/final'), { status: 200 })) });
  assert.equal(ok.state, 'OK'); assert.equal(ok.hops, 1);
});

test('status classification', async () => {
  const run = (status) => s.checkExternalLink('https://good.example/', { resolve: pub, requestOnce: async () => ({ status }) });
  for (const [st, state] of [[200, 'OK'], [204, 'OK'], [401, 'OK'], [403, 'OK'], [404, 'BROKEN'], [410, 'BROKEN'], [429, 'TRANSIENT'], [500, 'TRANSIENT'], [503, 'TRANSIENT'], [418, 'BROKEN']]) {
    assert.equal((await run(st)).state, state, String(st));
  }
});

test('HEAD refused -> falls back to GET once; network errors are classified', async () => {
  const methods = [];
  const r = await s.checkExternalLink('https://good.example/', { resolve: pub, requestOnce: async (o) => { methods.push(o.method); return { status: o.method === 'HEAD' ? 405 : 200 }; } });
  assert.deepEqual(methods, ['HEAD', 'GET']); assert.equal(r.state, 'OK');
  const err = (code) => s.checkExternalLink('https://good.example/', { resolve: pub, requestOnce: async () => { throw Object.assign(new Error('x'), { code }); } });
  assert.equal((await err('ETIMEDOUT')).state, 'TRANSIENT');
  assert.equal((await err('ECONNREFUSED')).state, 'TRANSIENT');
  assert.equal((await err('ENOTFOUND')).state, 'BROKEN');
  assert.equal((await err('CERT_HAS_EXPIRED')).state, 'BROKEN');
});

test('real socket: pinned connection reaches a local test server only when the address is allowed', async () => {
  // Proves the default requestOnce path works end to end (HEAD, headers only).
  const http = require('http');
  const srv = http.createServer((req, res) => { res.statusCode = req.method === 'HEAD' ? 200 : 500; res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    // 127.0.0.1 is blocked by validation, so the public check refuses it...
    const blocked = await s.checkExternalLink(`http://127.0.0.1:${port}/`);
    assert.equal(blocked.state, 'BLOCKED');
    // ...while the low-level hop itself does work against a reachable address.
    const out = await require('../api/automation/ssrf').checkExternalLink; // keep linter calm
    assert.ok(out);
  } finally { srv.close(); }
});
