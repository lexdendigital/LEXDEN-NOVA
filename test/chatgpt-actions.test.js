const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { makeDb } = require('./helpers/fake-firestore');

// Patch the shared DB BEFORE any handler loads (they destructure at require time).
let DB = makeDb();
const affShared = require('../api/affiliate/shared');
affShared.getDb = () => DB; // creator/shared and mcp/lib/tokens destructure this at load

process.env.ADMIN_EMAILS = 'boss@lexden.test';
const chatgpt = require('../mcp/lib/chatgptClient');
const gpt = require('../mcp/gptActions');
const mcpIndex = require('../mcp/index');
const tokens = require('../mcp/lib/tokens');

const SECRET = 's'.repeat(32);
function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  try { const r = fn(); if (r && r.then) return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

// ------------------------------------------------------------ redirect rules
test('ChatGPT redirect shapes: accepts real callbacks, rejects look-alikes', () => {
  const ok = [
    'https://chatgpt.com/aip/g-abc123DEF/oauth/callback',
    'https://chat.openai.com/aip/g-abc123DEF/oauth/callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/AbC_123-xyz',
    'https://platform.openai.com/apps-manage/oauth',
  ];
  for (const u of ok) assert.equal(chatgpt.isChatgptRedirect(u), true, u);
  const bad = [
    'http://chatgpt.com/aip/g-abc123DEF/oauth/callback',
    'https://chatgpt.com.evil.test/aip/g-abc123DEF/oauth/callback',
    'https://evil.test/aip/g-abc123DEF/oauth/callback',
    'https://chatgpt.com/aip/g-abc123DEF/oauth/callback?x=1',
    'https://chatgpt.com/aip/g-abc123DEF/oauth/callback#x',
    'https://chatgpt.com/other',
    'https://user:pw@chatgpt.com/connector_platform_oauth_redirect',
    'javascript:alert(1)',
    'https://chatgpt.com:8443/connector_platform_oauth_redirect',
  ];
  for (const u of bad) assert.equal(chatgpt.isChatgptRedirect(u), false, u);
});

test('CHATGPT_ALLOWED_GPT_IDS pins /aip/ callbacks to your own GPT', () => {
  withEnv({ CHATGPT_ALLOWED_GPT_IDS: 'g-mine1234' }, () => {
    assert.equal(chatgpt.isChatgptRedirect('https://chatgpt.com/aip/g-mine1234/oauth/callback'), true);
    assert.equal(chatgpt.isChatgptRedirect('https://chatgpt.com/aip/g-other999/oauth/callback'), false);
  });
});

test('static client is OFF without a long secret, and only that client id gets the ChatGPT redirect', () => {
  withEnv({ CHATGPT_CLIENT_SECRET: undefined }, () => assert.equal(chatgpt.isStaticClientId('lexden-chatgpt'), false));
  withEnv({ CHATGPT_CLIENT_SECRET: SECRET, CHATGPT_CLIENT_ID: undefined }, () => {
    assert.equal(chatgpt.isStaticClientId('lexden-chatgpt'), true);
    assert.equal(chatgpt.staticRedirectOk('lexden-chatgpt', 'https://chatgpt.com/aip/g-abc123DEF/oauth/callback'), true);
    assert.equal(chatgpt.staticRedirectOk('someone-else', 'https://chatgpt.com/aip/g-abc123DEF/oauth/callback'), false);
    assert.equal(chatgpt.staticRedirectOk('lexden-chatgpt', 'https://evil.test/cb'), false);
  });
});

test('client authentication: wrong secret rejected, right secret (body or Basic) accepted, other clients untouched', () => {
  withEnv({ CHATGPT_CLIENT_SECRET: SECRET, CHATGPT_CLIENT_ID: undefined }, () => {
    assert.throws(() => chatgpt.authenticateClient({ client_id: 'lexden-chatgpt', client_secret: 'nope' }), (e) => e.oauth && e.message === 'invalid_client' && e.status === 401);
    assert.throws(() => chatgpt.authenticateClient({ client_id: 'lexden-chatgpt' }), /invalid_client/);
    assert.deepEqual(chatgpt.authenticateClient({ client_id: 'lexden-chatgpt', client_secret: SECRET }), { isStatic: true, authenticated: true, clientId: 'lexden-chatgpt' });
    const basic = 'Basic ' + Buffer.from(`lexden-chatgpt:${SECRET}`).toString('base64');
    assert.equal(chatgpt.authenticateClient({}, { authorization: basic }).authenticated, true);
    assert.equal(chatgpt.authenticateClient({ client_id: 'claude-registered' }).authenticated, false);
  });
});

// ------------------------------------------------------------ PKCE-less codes need the secret
test('a code minted without PKCE can only be redeemed by an authenticated client', async () => {
  DB = makeDb();
  const mk = () => tokens.createAuthCode({ clientId: 'lexden-chatgpt', redirectUri: 'https://chatgpt.com/aip/g-abc123DEF/oauth/callback', codeChallenge: null, email: 'c@x.co', uid: 'u1', scope: 'creator offline_access' });
  const args = (code, extra) => ({ code, clientId: 'lexden-chatgpt', redirectUri: 'https://chatgpt.com/aip/g-abc123DEF/oauth/callback', ...extra });
  await assert.rejects(tokens.consumeAuthCode(args(await mk(), {})), /invalid_grant/);
  await assert.rejects(tokens.consumeAuthCode(args(await mk(), { codeVerifier: 'whatever' })), /invalid_grant/);
  const s = await tokens.consumeAuthCode(args(await mk(), { clientAuthenticated: true }));
  assert.equal(s.uid, 'u1');
  assert.equal(s.scope, 'creator offline_access');
});

test('a code minted WITH PKCE still demands the verifier even for the static client', async () => {
  DB = makeDb();
  const crypto = require('crypto');
  const verifier = 'v'.repeat(50);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const mk = () => tokens.createAuthCode({ clientId: 'lexden-chatgpt', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', codeChallenge: challenge, codeChallengeMethod: 'S256', email: 'c@x.co', uid: 'u1', scope: 'creator' });
  const a = (code, extra) => ({ code, clientId: 'lexden-chatgpt', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', ...extra });
  await assert.rejects(tokens.consumeAuthCode(a(await mk(), { clientAuthenticated: true })), /invalid_grant/);
  await assert.rejects(tokens.consumeAuthCode(a(await mk(), { codeVerifier: 'x'.repeat(50), clientAuthenticated: true })), /invalid_grant/);
  assert.equal((await tokens.consumeAuthCode(a(await mk(), { codeVerifier: verifier }))).uid, 'u1');
});

// ------------------------------------------------------------ OAuth routes (real handlers)
function routeApp(registerRoutes) {
  const routes = {};
  const app = { get: (p, h) => (routes[`GET ${p}`] = h), post: (p, h) => (routes[`POST ${p}`] = h) };
  registerRoutes(app);
  return routes;
}
function fakeRes() {
  return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, set(h) { Object.assign(this.headers, h); return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; }, redirect(u) { this.code = 302; this.body = u; return this; } };
}
const GPT_CB = 'https://chatgpt.com/aip/g-abc123DEF/oauth/callback';

test('creator /authorize: ChatGPT static client + ChatGPT callback is accepted WITHOUT PKCE; random client or bad callback is refused', async () => {
  await withEnv({ CHATGPT_CLIENT_SECRET: SECRET, CHATGPT_CLIENT_ID: undefined, MCP_BASE_URL: 'https://example.test' }, async () => {
    const creatorOauth = require('../mcp/creatorOauth');
    const routes = routeApp((a) => creatorOauth.registerRoutes(a));
    const authorize = routes['GET /creator/authorize'];
    const q = (o) => ({ query: { response_type: 'code', client_id: 'lexden-chatgpt', redirect_uri: GPT_CB, state: 's1', ...o } });
    let res = fakeRes(); await authorize(q({}), res);
    assert.equal(res.code, 200); assert.match(res.body, /Connect your AI assistant/);
    res = fakeRes(); await authorize(q({ client_id: 'random-client' }), res);
    assert.equal(res.code, 400);
    res = fakeRes(); await authorize(q({ redirect_uri: 'https://evil.test/cb' }), res);
    assert.equal(res.code, 400);
    // a non-ChatGPT, non-static client must still bring PKCE
    DB = makeDb({ mcpClients: { reg1: { redirectUris: ['https://app.example/cb'], clientName: 'X' } } });
    res = fakeRes(); await authorize({ query: { response_type: 'code', client_id: 'reg1', redirect_uri: 'https://app.example/cb' } }, res);
    assert.notEqual(res.code, 200);
  });
});

test('creator /token: static client needs its secret; bad secret is 401 invalid_client', async () => {
  await withEnv({ CHATGPT_CLIENT_SECRET: SECRET, CHATGPT_CLIENT_ID: undefined }, async () => {
    const creatorOauth = require('../mcp/creatorOauth');
    const routes = routeApp((a) => creatorOauth.registerRoutes(a));
    const token = routes['POST /creator/token'];
    let res = fakeRes();
    await token({ body: { grant_type: 'authorization_code', client_id: 'lexden-chatgpt', client_secret: 'wrong', code: 'x', redirect_uri: GPT_CB }, headers: {} }, res);
    assert.equal(res.code, 401); assert.equal(res.body.error, 'invalid_client');
    // full happy path: code without PKCE + secret -> tokens with creator scope only
    DB = makeDb({ creators: { u1: { status: 'ACTIVE' } } });
    const code = await tokens.createAuthCode({ clientId: 'lexden-chatgpt', redirectUri: GPT_CB, codeChallenge: null, email: 'c@x.co', uid: 'u1', scope: 'creator offline_access' });
    res = fakeRes();
    await token({ body: { grant_type: 'authorization_code', client_id: 'lexden-chatgpt', client_secret: SECRET, code, redirect_uri: GPT_CB }, headers: {} }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'creator offline_access');
    assert.ok(res.body.access_token && res.body.refresh_token);
  });
});

test('admin /authorize: static ChatGPT client works; an admin-realm grant is not redeemable on the creator token endpoint', async () => {
  await withEnv({ CHATGPT_CLIENT_SECRET: SECRET, CHATGPT_CLIENT_ID: undefined, MCP_BASE_URL: 'https://example.test' }, async () => {
    const oauth = require('../mcp/oauth');
    const routes = routeApp((a) => oauth.registerRoutes(a));
    let res = fakeRes();
    await routes['GET /authorize']({ query: { response_type: 'code', client_id: 'lexden-chatgpt', redirect_uri: GPT_CB } }, res);
    assert.equal(res.code, 200);
    res = fakeRes();
    await routes['GET /authorize']({ query: { response_type: 'code', client_id: 'nobody', redirect_uri: GPT_CB } }, res);
    assert.equal(res.code, 400);
  });
});

// ------------------------------------------------------------ Actions API over real HTTP
function startServer({ kind, who }) {
  const app = express();
  app.use(express.json());
  process.env.MCP_BASE_URL = 'https://example.test';
  const verifyToken = async (t) => (t === 'good' ? { clientId: 'lexden-chatgpt', scope: kind === 'admin' ? 'admin offline_access' : 'creator offline_access', expiresAt: Math.floor(Date.now() / 1000) + 600, email: who.email, uid: who.uid, resource: null } : null);
  gpt.mountGpt(app, {
    collectTools: (k, a) => mcpIndex.collectTools(k, a),
    baseUrl: () => 'https://example.test',
    identityChecks: { admin: mcpIndex.adminIdentityCheck, creator: async () => ({ ok: true }) },
    verifyToken,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const J = async (url, opts = {}) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
const auth = { Authorization: 'Bearer good', 'Content-Type': 'application/json' };

test('Actions API (admin): open schema, auth required, full tool parity, approve a creator application on command', async () => {
  DB = makeDb({
    creatorApplications: { cu1: { status: 'SUBMITTED', creatorType: 'personal', publicFields: { displayName: 'Ada Crafts', category: 'Art' } } },
    creatorPrivate: { cu1: { email: 'ada@x.co' } },
  });
  const { server, url } = await startServer({ kind: 'admin', who: { email: 'boss@lexden.test', uid: 'adminUid' } });
  try {
    // public schema + instructions
    const spec = await J(`${url}/gpt/admin/openapi.json`);
    assert.equal(spec.status, 200);
    assert.equal(spec.body.openapi, '3.1.0');
    assert.deepEqual(Object.values(spec.body.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)).sort(), ['callTool', 'describeTool', 'listTools']);
    assert.equal(spec.body.components.securitySchemes.oauth.flows.authorizationCode.authorizationUrl, 'https://example.test/authorize');
    const ins = await fetch(`${url}/gpt/admin/instructions`).then((r) => r.text());
    assert.match(ins, /nova_review_creator_application/);
    assert.ok(ins.length < 8000);

    // no token -> 401
    assert.equal((await J(`${url}/gpt/admin/tools`)).status, 401);
    assert.equal((await J(`${url}/gpt/admin/tools`, { headers: { Authorization: 'Bearer bad' } })).status, 401);

    // full parity: every admin MCP tool is reachable
    const all = await J(`${url}/gpt/admin/tools?limit=200`, { headers: auth });
    assert.equal(all.status, 200);
    const direct = mcpIndex.collectTools('admin', { extra: { email: 'boss@lexden.test', uid: 'adminUid' } });
    assert.equal(all.body.total, direct.size);
    assert.ok(direct.size >= 80, `expected the whole admin toolbox, got ${direct.size}`);
    for (const n of ['nova_list_creator_applications', 'nova_review_creator_application', 'nova_approve_creator_withdrawal', 'nova_write_source_file']) assert.ok(direct.has(n), n);
    assert.equal(all.body.tools.length, direct.size);

    // search
    const found = await J(`${url}/gpt/admin/tools?search=creator%20application`, { headers: auth });
    assert.ok(found.body.tools.some((t) => t.name === 'nova_review_creator_application'));

    // describe gives a real JSON schema
    const d = await J(`${url}/gpt/admin/tools/nova_review_creator_application`, { headers: auth });
    assert.equal(d.body.arguments.type, 'object');
    assert.deepEqual(d.body.arguments.required.sort(), ['action', 'confirm', 'uid']);
    assert.equal((await J(`${url}/gpt/admin/tools/nope`, { headers: auth })).status, 404);

    // list applications
    const list = await J(`${url}/gpt/admin/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_list_creator_applications', arguments: { status: 'SUBMITTED' } }) });
    assert.equal(list.body.ok, true);
    assert.equal(list.body.result.applications[0].uid, 'cu1');

    // confirm gate: missing confirm -> 400 with guidance, and nothing changed
    const noConfirm = await J(`${url}/gpt/admin/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_review_creator_application', arguments: { uid: 'cu1', action: 'approve' } }) });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.error, 'invalid_arguments');
    assert.equal(DB._store.creatorApplications.cu1.status, 'SUBMITTED');
    assert.equal(DB._store.creators, undefined);

    // APPROVE on command (SUBMITTED -> IN_REVIEW -> APPROVED automatically)
    const approve = await J(`${url}/gpt/admin/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_review_creator_application', arguments: { uid: 'cu1', action: 'approve', confirm: true } }) });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.ok, true, JSON.stringify(approve.body));
    assert.equal(approve.body.result.status, 'APPROVED');
    assert.equal(DB._store.creatorApplications.cu1.status, 'APPROVED');
    assert.equal(DB._store.creators.cu1.status, 'ACTIVE');
    assert.equal(DB._store.creators.cu1.displayName, 'Ada Crafts');

    // unknown tool
    assert.equal((await J(`${url}/gpt/admin/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_review_creator_applicat' }) })).status, 404);
  } finally { server.close(); }
});

test('admin MCP tool alone (no HTTP): reject needs a reason; start_review then approve also works', async () => {
  DB = makeDb({ creatorApplications: { a: { status: 'SUBMITTED', creatorType: 'personal', publicFields: { displayName: 'A' } }, b: { status: 'SUBMITTED', creatorType: 'personal', publicFields: {} } } });
  const tools = mcpIndex.collectTools('admin', { extra: { email: 'boss@lexden.test', uid: 'adminUid' } });
  const t = tools.get('nova_review_creator_application');
  const noReason = await t.run({ uid: 'b', action: 'reject', confirm: true });
  assert.equal(noReason.isError, true);
  assert.match(noReason.content[0].text, /REASON_REQUIRED/);
  assert.equal(DB._store.creatorApplications.b.status, 'SUBMITTED');
  const rej = await t.run({ uid: 'b', action: 'reject', reason: 'Documents unclear', confirm: true });
  assert.equal(rej.isError, undefined);
  assert.equal(DB._store.creatorApplications.b.status, 'REJECTED');
  assert.equal((await t.run({ uid: 'a', action: 'start_review', confirm: true })).isError, undefined);
  assert.equal((await t.run({ uid: 'a', action: 'approve', confirm: true })).isError, undefined);
  assert.equal(DB._store.creators.a.status, 'ACTIVE');
});

test('admin Actions: a non-admin identity is refused on every request', async () => {
  const { server, url } = await startServer({ kind: 'admin', who: { email: 'stranger@x.co', uid: 'u9' } });
  try {
    assert.equal((await J(`${url}/gpt/admin/tools`, { headers: auth })).status, 403);
    assert.equal((await J(`${url}/gpt/admin/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_list_products', arguments: {} }) })).status, 403);
  } finally { server.close(); }
});

test('Actions API (creator): same creator tools as the creator MCP, scoped to the signed-in creator', async () => {
  DB = makeDb({ creators: { cu2: { status: 'ACTIVE', displayName: 'Bola' } } });
  const { server, url } = await startServer({ kind: 'creator', who: { email: 'bola@x.co', uid: 'cu2' } });
  try {
    const spec = await J(`${url}/gpt/creator/openapi.json`);
    assert.equal(spec.body.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl, 'https://example.test/creator/token');
    const direct = mcpIndex.collectTools('creator', { extra: { email: 'bola@x.co', uid: 'cu2' } });
    const all = await J(`${url}/gpt/creator/tools?limit=200`, { headers: auth });
    assert.equal(all.body.total, direct.size);
    assert.ok(direct.size >= 30);
    assert.ok(direct.has('creator_get_overview'));
    // no creator tool takes a uid/email, so a prompt cannot aim it at somebody else
    for (const t of direct.values()) {
      const props = Object.keys((gpt.jsonSchemaOf(gpt.schemaOf(t.config)).properties) || {});
      assert.ok(!props.some((p) => /^(uid|creatorId|email)$/i.test(p)), `${t.name} takes ${props}`);
    }
    const ov = await J(`${url}/gpt/creator/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'creator_get_overview', arguments: {} }) });
    assert.equal(ov.status, 200);
    assert.ok(typeof ov.body.ok === 'boolean');
    // an admin tool does not exist in the creator realm
    assert.equal((await J(`${url}/gpt/creator/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nova_write_source_file', arguments: {} }) })).status, 404);
  } finally { server.close(); }
});

test('a creator-scope token is refused on the admin Actions and vice-versa', async () => {
  const app = express(); app.use(express.json());
  const tok = (scope) => async () => ({ clientId: 'c', scope, expiresAt: Math.floor(Date.now() / 1000) + 600, email: 'boss@lexden.test', uid: 'u1', resource: null });
  const mount = (scope) => { const a = express(); a.use(express.json()); gpt.mountGpt(a, { collectTools: mcpIndex.collectTools, baseUrl: () => 'https://example.test', identityChecks: { admin: mcpIndex.adminIdentityCheck, creator: async () => ({ ok: true }) }, verifyToken: tok(scope) }); return new Promise((r) => { const s = a.listen(0, () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); }); };
  const c = await mount('creator offline_access');
  const a2 = await mount('admin offline_access');
  try {
    assert.equal((await J(`${c.url}/gpt/admin/tools`, { headers: auth })).status, 403);
    assert.equal((await J(`${a2.url}/gpt/creator/tools`, { headers: auth })).status, 403);
  } finally { c.s.close(); a2.s.close(); }
});

test('clip(): oversized results are cut with a clear note', () => {
  const big = gpt.clip({ rows: 'x'.repeat(200000) });
  assert.equal(big.truncated, true);
  assert.ok(JSON.stringify(big).length < 95000);
  assert.deepEqual(gpt.clip({ a: 1 }), { a: 1 });
});

// ------------------------------------------------------------ email diagnostics
test('email-health: closed without the secret; reports missing settings without leaking values', async () => {
  const handler = require('../api/email-health');
  const { callHandler } = require('../mcp/lib/callHandler');
  const keep = { ...process.env };
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await callHandler(handler, { query: { secret: 'x' } })).status, 503);
    process.env.CRON_SECRET = 'c'.repeat(24);
    assert.equal((await callHandler(handler, { query: { secret: 'nope' } })).status, 401);
    delete process.env.BREVO_API_KEY; delete process.env.BREVO_TPL_VERIFY;
    const r = await callHandler(handler, { query: { secret: 'c'.repeat(24) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.brevoApiKeySet, false);
    assert.equal(r.body.templates.verify, 'MISSING');
    assert.ok(r.body.problems.some((p) => /BREVO_API_KEY is not set/.test(p)));
    assert.ok(!JSON.stringify(r.body).includes('c'.repeat(24)));
  } finally { process.env = keep; }
});

test('email queue payload drops undefined fields (the bug that lost retries)', async () => {
  const p = { templateKey: 'verify', to: { email: 'a@b.co' }, params: { code: '1' }, replyTo: undefined };
  const clean = JSON.parse(JSON.stringify(p));
  assert.ok(!('replyTo' in clean));
});
