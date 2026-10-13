const test = require('node:test');
const assert = require('node:assert/strict');
const { McpServer, InMemoryTransport } = require('@modelcontextprotocol/server');

const { bearerAuthMiddleware, splitScope } = require('../mcp/lib/authMiddleware');
const creatorOauth = require('../mcp/creatorOauth');
const creatorTools = require('../mcp/creatorTools');
const { callHandler } = require('../mcp/lib/callHandler');
const { redact } = require('../mcp/lib/audit');

const base = () => 'https://example.test';

// ---------------------------------------------------------------- gates
function makeReq() {
  return { method: 'POST', originalUrl: '/mcp', headers: { authorization: 'Bearer tok' } };
}
function makeRes() {
  return {
    code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function run(gate) {
  const req = makeReq(); const res = makeRes(); let nexted = false;
  await gate(req, res, () => { nexted = true; });
  return { req, res, nexted };
}
const tokenInfo = (o) => ({ clientId: 'c', scope: 'admin offline_access', expiresAt: Math.floor(Date.now() / 1000) + 600, email: 'a@x.com', uid: 'u1', resource: null, ...o });

test('splitScope splits the stored space-separated scope', () => {
  assert.deepEqual(splitScope('admin offline_access'), ['admin', 'offline_access']);
  assert.deepEqual(splitScope(''), []);
});

test('admin gate: existing admin token still passes', async () => {
  const gate = bearerAuthMiddleware(base, { requiredScope: 'admin', verifyToken: async () => tokenInfo(), checkIdentity: async () => ({ ok: true }) });
  const { nexted, req } = await run(gate);
  assert.equal(nexted, true);
  assert.equal(req.auth.extra.email, 'a@x.com');
});

test('admin gate: creator token is refused with 403', async () => {
  const gate = bearerAuthMiddleware(base, { requiredScope: 'admin', verifyToken: async () => tokenInfo({ scope: 'creator offline_access' }) });
  const { nexted, res } = await run(gate);
  assert.equal(nexted, false);
  assert.equal(res.code, 403);
});

test('admin gate: admin scope but non-admin identity is refused', async () => {
  const gate = bearerAuthMiddleware(base, { requiredScope: 'admin', verifyToken: async () => tokenInfo(), checkIdentity: async () => ({ ok: false }) });
  const { nexted, res } = await run(gate);
  assert.equal(nexted, false);
  assert.equal(res.code, 403);
});

const creatorGate = (over = {}) => bearerAuthMiddleware(base, {
  requiredScope: 'creator', resourcePath: '/mcp/creator',
  metadataPath: '/.well-known/oauth-protected-resource/mcp/creator',
  verifyToken: async () => tokenInfo({ scope: 'creator offline_access' }),
  checkIdentity: async () => ({ ok: true }), ...over,
});

test('creator gate: valid token passes and sets req.auth', async () => {
  const { nexted, req } = await run(creatorGate());
  assert.equal(nexted, true);
  assert.equal(req.auth.extra.uid, 'u1');
});

test('creator gate: admin token is refused', async () => {
  const { nexted, res } = await run(creatorGate({ verifyToken: async () => tokenInfo({ scope: 'admin offline_access' }) }));
  assert.equal(nexted, false);
  assert.equal(res.code, 403);
});

test('creator gate: suspended creator is refused immediately', async () => {
  const { nexted, res } = await run(creatorGate({ checkIdentity: async () => ({ ok: false, message: 'suspended' }) }));
  assert.equal(nexted, false);
  assert.equal(res.code, 403);
});

test('creator gate: wrong audience is refused 401; matching audience passes', async () => {
  const bad = await run(creatorGate({ verifyToken: async () => tokenInfo({ scope: 'creator', resource: 'https://example.test/mcp' }) }));
  assert.equal(bad.res.code, 401);
  const good = await run(creatorGate({ verifyToken: async () => tokenInfo({ scope: 'creator', resource: 'https://example.test/mcp/creator/' }) }));
  assert.equal(good.nexted, true);
});

test('creator gate: identity lookup error gives 503, not access', async () => {
  const { nexted, res } = await run(creatorGate({ checkIdentity: async () => { throw new Error('db down'); } }));
  assert.equal(nexted, false);
  assert.equal(res.code, 503);
});

test('creator gate: missing/invalid token is 401', async () => {
  const { nexted, res } = await run(creatorGate({ verifyToken: async () => null }));
  assert.equal(nexted, false);
  assert.equal(res.code, 401);
});

// ---------------------------------------------------------------- oauth helpers
test('normalizeCreatorScope can never yield admin', () => {
  assert.equal(creatorOauth.normalizeCreatorScope('admin'), 'creator offline_access');
  assert.ok(!creatorOauth.hasScope(creatorOauth.normalizeCreatorScope('admin creator'), 'admin'));
});

test('redirect URI rules', () => {
  const ok = creatorOauth.isAcceptableRedirectUri;
  assert.ok(ok('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(ok('http://localhost:7777/oauth/callback'));
  assert.ok(ok('http://127.0.0.1:1234/cb'));
  assert.ok(!ok('http://evil.com/cb'));
  assert.ok(!ok('javascript:alert(1)'));
  assert.ok(!ok('myapp://cb'));
  assert.ok(!ok('https://user:pw@evil.com/cb'));
  assert.ok(!ok('not a url'));
});

test('describeRedirect labels known hosts and flags unknown ones', () => {
  const d = creatorOauth.describeRedirect;
  assert.equal(d('https://claude.ai/x').kind, 'known');
  assert.equal(d('https://chatgpt.com/connector/oauth/abc').label, 'ChatGPT');
  assert.equal(d('https://claude.ai.evil.com/x').kind, 'unknown');
  assert.equal(d('http://localhost:1/x').kind, 'local');
});

test('jsonForScript neutralises script-breaking characters', () => {
  const out = creatorOauth.jsonForScript({ n: '</script><b>& ' });
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('&') && !out.includes(' '));
  assert.equal(JSON.parse(out).n, '</script><b>& ');
});

test('sign-in page never interpolates attacker text as HTML', () => {
  const html = creatorOauth.creatorSignInHtml({ clientName: '<img src=x onerror=alert(1)>', redirectHost: 'x' , redirectLabel: 'x', redirectKind: 'unknown', params: {} });
  assert.ok(!html.includes('<img src=x'));
});

test('evaluateCreatorAccess', () => {
  assert.equal(creatorOauth.evaluateCreatorAccess(null).ok, false);
  assert.equal(creatorOauth.evaluateCreatorAccess({ status: 'ACTIVE' }).ok, true);
  assert.equal(creatorOauth.evaluateCreatorAccess({ status: 'SUSPENDED' }).ok, false);
  assert.equal(creatorOauth.evaluateCreatorAccess({ status: 'REVOKED' }).ok, false);
});

// ---------------------------------------------------------------- tools
function fakeDb(data = {}) {
  const q = (rows) => ({
    where() { return q(rows); }, orderBy() { return q(rows); }, limit() { return q(rows); },
    async get() { return { size: rows.length, docs: rows.map((r, i) => ({ id: r.id || String(i), data: () => r })) }; },
  });
  return {
    collection(name) {
      return {
        doc: (id) => ({ async get() { const v = (data[name] || {})[id]; return { exists: !!v, data: () => v }; } }),
        ...q(data[`${name}:rows`] || []),
      };
    },
  };
}

function buildTestServer(uid, deps) {
  const server = new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {} }, instructions: 'hello' });
  creatorTools.register(server, { uid, email: 'e@x.com', deps });
  return server;
}

async function rpc(server, calls) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const pending = new Map(); let id = 0;
  clientT.onmessage = (m) => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  await clientT.start();
  const send = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); clientT.send({ jsonrpc: '2.0', id: i, method, params }); });
  const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const out = await calls(send, init);
  await clientT.close();
  return out;
}

const TRUSTED = Symbol('t');
function recordingDeps(extra = {}) {
  const seen = [];
  const handler = async (req, res) => { seen.push({ method: req.method, body: req.body, query: req.query, trusted: req[TRUSTED] }); res.status(200).json({ ok: true, data: { echoed: req.body || req.query } }); };
  return {
    seen,
    deps: { callHandler, getDb: () => fakeDb(extra.data), TRUSTED_CREATOR: TRUSTED, handlers: { products: handler, fulfillments: handler, withdraw: handler, supplierConnection: handler, supplierProducts: handler, supplierOrders: handler, notifications: handler } },
  };
}

test('register refuses to run without a uid', () => {
  assert.throws(() => creatorTools.register(new McpServer({ name: 't', version: '1' }, { capabilities: { tools: {} } }), { uid: '' }));
});

test('tool registry invariants', async () => {
  const { deps } = recordingDeps();
  const tools = await rpc(buildTestServer('u1', deps), async (send) => (await send('tools/list', {})).result.tools);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...creatorTools.TOOL_NAMES].sort());
  for (const t of tools) {
    assert.ok(t.name.startsWith('creator_'), t.name);
    assert.ok(!t.name.startsWith('nova_'));
    const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
    for (const forbidden of ['uid', 'creatorId', 'email', 'bankCode', 'accountNumber']) assert.ok(!props.includes(forbidden), `${t.name} accepts ${forbidden}`);
    assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name} missing annotations`);
    if (/^creator_(get|list)_/.test(t.name)) assert.equal(t.annotations.readOnlyHint, true, t.name);
    else assert.equal(t.annotations.readOnlyHint, false, t.name);
  }
  for (const n of ['creator_submit_product_for_review', 'creator_set_product_state', 'creator_cancel_order', 'creator_request_withdrawal']) {
    assert.ok(tools.find((t) => t.name === n).inputSchema.required.includes('confirm'), n);
  }
  // nothing can change the payout account or upload files
  assert.ok(!tools.some((t) => /payout_account/.test(t.name) && !/get_/.test(t.name)));
});

test('initialize returns instructions', async () => {
  const { deps } = recordingDeps();
  const init = await rpc(buildTestServer('u1', deps), async (send, i) => i);
  assert.equal(init.result.instructions, 'hello');
});

test('writes carry the trusted uid and ignore attempts to override it', async () => {
  const { deps, seen } = recordingDeps();
  await rpc(buildTestServer('u1', deps), async (send) => {
    await send('tools/call', { name: 'creator_mark_order_shipped', arguments: { orderId: 'o1', carrier: 'DHL', trackingNumber: 'T1', uid: 'victim', creatorId: 'victim' } });
    await send('tools/call', { name: 'creator_create_product_draft', arguments: { offeringType: 'EBOOK', title: 'T', creatorId: 'victim', status: 'PUBLISHED' } });
  });
  assert.equal(seen.length, 2);
  for (const s of seen) assert.deepEqual(s.trusted, { uid: 'u1', email: 'e@x.com' });
  assert.deepEqual(seen[0].body, { orderId: 'o1', action: 'mark_shipped', carrier: 'DHL', trackingNumber: 'T1' });
  assert.deepEqual(seen[1].body, { action: 'create_draft', offeringType: 'EBOOK', title: 'T' });
});

test('confirm:false is rejected before any handler runs', async () => {
  const { deps, seen } = recordingDeps();
  const res = await rpc(buildTestServer('u1', deps), async (send) => send('tools/call', { name: 'creator_request_withdrawal', arguments: { amount: 5000, confirm: false } }));
  assert.equal(seen.length, 0);
  assert.ok(res.error || (res.result && res.result.isError));
});

test('handler errors surface as tool errors with the code', async () => {
  const failing = async (req, res) => res.status(422).json({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'bad', errors: [{ field: 'title', message: 'x' }] } });
  const deps = { callHandler, getDb: () => fakeDb(), TRUSTED_CREATOR: TRUSTED, handlers: { products: failing, fulfillments: failing, withdraw: failing } };
  const res = await rpc(buildTestServer('u1', deps), async (send) => send('tools/call', { name: 'creator_submit_product_for_review', arguments: { productId: 'p', confirm: true } }));
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /VALIDATION_FAILED/);
});

test('payout account is masked', async () => {
  const { deps } = recordingDeps({ data: { creatorPrivate: { u1: { payoutAccount: { bankName: 'GTB', accountName: 'A B', accountNumber: '0123456789', bankCode: '058' } } } } });
  const res = await rpc(buildTestServer('u1', deps), async (send) => send('tools/call', { name: 'creator_get_payout_account', arguments: {} }));
  const text = res.result.content[0].text;
  assert.ok(text.includes('******6789'));
  assert.ok(!text.includes('0123456789'));
  assert.ok(!text.includes('058'));
});

test('listing requirements reflect the offering type', async () => {
  const { deps } = recordingDeps();
  const res = await rpc(buildTestServer('u1', deps), async (send) => send('tools/call', { name: 'creator_get_listing_requirements', arguments: { offeringType: 'PHYSICAL_PRODUCT' } }));
  const fields = JSON.parse(res.result.content[0].text).required.map((r) => r.field);
  for (const f of ['title', 'stock', 'weightGrams', 'shippingOrigin']) assert.ok(fields.includes(f), f);
});

test('audit redaction strips secret-looking keys', () => {
  assert.equal(redact({ accessToken: 'x', ok: 1 }).accessToken, '[redacted]');
});

// ---------------------------------------------------------------- trusted seam
test('TRUSTED_CREATOR seam: symbol works, string forgeries do not', async () => {
  const shared = require('../api/creator/shared');
  const affPath = require.resolve('../api/affiliate/shared');
  const real = require.cache[affPath].exports;
  const origDoc = shared.requireActiveCreator;
  assert.equal(typeof shared.TRUSTED_CREATOR, 'symbol');
  // A request with no token and only string-keyed forgeries must fail auth.
  await assert.rejects(() => origDoc({ headers: {}, body: { TRUSTED_CREATOR: { uid: 'x' }, uid: 'x' }, query: { uid: 'x' } }));
  void real;
});

test('Stage G: supplier tools route to the supplier handlers with the trusted creator', async () => {
  const { deps, seen } = recordingDeps();
  await rpc(buildTestServer('u1', deps), async (send) => {
    await send('tools/call', { name: 'creator_get_supplier_status', arguments: {} });
    await send('tools/call', { name: 'creator_test_dropship_mapping', arguments: { productId: 'p1', cjVariantId: 'V1', declaredCostUsd: 4.5 } });
    await send('tools/call', { name: 'creator_check_supplier_health', arguments: { productId: 'p1' } });
    await send('tools/call', { name: 'creator_sync_dropship_order', arguments: { orderId: 'o1', action: 'sync' } });
  });
  assert.equal(seen.length, 4);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[1].body.action, 'test_mapping');
  assert.equal(seen[1].body.cjVariantId, 'V1');
  assert.equal(seen[2].body.action, 'check_health');
  assert.deepEqual(seen[3].body, { orderId: 'o1', action: 'sync' });
  assert.ok(seen.every((x) => x.trusted && x.trusted.uid === 'u1'));
});

test('Stage G: no tool can connect/disconnect a supplier or carry credentials', () => {
  for (const n of creatorTools.TOOL_NAMES) assert.ok(!/connect|disconnect|credential|auto_?pay|api_?key/i.test(n.replace('creator_get_supplier_status', '')), n);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'mcp', 'creatorTools.js'), 'utf8');
  assert.ok(!/action:\s*'(connect|set_auto_pay|disconnect)'/.test(src));
  assert.ok(!/apiKey/.test(src));
});

test('Stage G: fulfillmentMode is accepted on drafts and bad values are rejected', async () => {
  const { deps, seen } = recordingDeps();
  await rpc(buildTestServer('u1', deps), async (send) => {
    await send('tools/call', { name: 'creator_update_product_draft', arguments: { productId: 'p1', fulfillmentMode: 'CJ_DROPSHIP' } });
    const bad = await send('tools/call', { name: 'creator_update_product_draft', arguments: { productId: 'p1', fulfillmentMode: 'AMAZON' } });
    assert.ok(bad.error || (bad.result && bad.result.isError));
  });
  assert.equal(seen.length, 1);
});

test('Stage H: acknowledge tool posts the acknowledge action; supplier fields accepted', async () => {
  const { deps, seen } = recordingDeps();
  await rpc(buildTestServer('u1', deps), async (send) => {
    await send('tools/call', { name: 'creator_acknowledge_order', arguments: { orderId: 'o1' } });
    await send('tools/call', { name: 'creator_update_product_draft', arguments: { productId: 'p1', fulfillmentMode: 'MANUAL_SUPPLIER', supplierName: 'Alaba Wholesale', processingDays: 3 } });
    const bad = await send('tools/call', { name: 'creator_update_product_draft', arguments: { productId: 'p1', processingDays: 90 } });
    assert.ok(bad.error || (bad.result && bad.result.isError));
  });
  assert.deepEqual(seen[0].body, { orderId: 'o1', action: 'acknowledge' });
  assert.equal(seen[1].body.fields ? seen[1].body.fields.supplierName : seen[1].body.supplierName, 'Alaba Wholesale');
  assert.equal(seen.length, 2);
});
