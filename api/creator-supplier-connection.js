// /api/creator-supplier-connection.js
//
// LEXDEN NOVA CREATOR — Stage G. A creator connects THEIR OWN CJ Dropshipping
// account so paid orders for their dropship listings are placed in it.
//
// GET  /api/creator-supplier-connection
//        -> { connected, status, accountEmail (masked), autoPay, ... }
// POST /api/creator-supplier-connection { action, ... }
//   connect       { email, apiKey, autoPay?, autoPayConsent? }
//   set_auto_pay  { enabled, consent? }
//   disconnect    {}
//
// SECURITY
//   * The API key is only ever RECEIVED here (HTTPS) and encrypted before it
//     is stored; no response ever contains it, a token, or the full email.
//   * Deliberately NOT available through the Creator MCP: a prompt-injected
//     assistant must never be able to connect, swap or redirect a supplier
//     account, and the key would pass through an AI chat transcript.
//   * connect is throttled (5 failed tries / 10 min) and fails closed when
//     SUPPLIER_CREDENTIALS_KEY is missing.
const { getDb, requireActiveCreator, ok, fail, setCors } = require('./creator/shared');
const supplier = require('./supplier/service');
const store = require('./supplier/store');

module.exports = async function handler(req, res) {
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded, creator;
  try {
    ({ decoded, creator } = await requireActiveCreator(req));
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;
  const db = getDb();

  if (req.method === 'GET') {
    try {
      return ok(res, store.publicConnectionView(await store.getConnection(db, uid)));
    } catch (e) {
      return fail(res, e);
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const body = req.body || {};
  try {
    if (body.action === 'connect') {
      const view = await supplier.connectCj(db, {
        uid, creator, email: body.email, apiKey: body.apiKey,
        autoPay: body.autoPay === true, autoPayConsent: body.autoPayConsent === true,
      });
      return ok(res, view);
    }
    if (body.action === 'set_auto_pay') {
      return ok(res, await supplier.setAutoPay(db, { uid, enabled: body.enabled === true, consent: body.consent === true }));
    }
    if (body.action === 'disconnect') {
      return ok(res, await supplier.disconnectCj(db, { uid, actorRole: 'creator', reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null }));
    }
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${body.action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
