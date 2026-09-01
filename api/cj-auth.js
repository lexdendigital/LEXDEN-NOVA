// /api/cj-auth.js
//
// LEXDEN NOVA × CJ — connection/auth test + manual refresh.
// Never returns a token/secret to the browser (see README §7/§34) — only
// a plain status the Admin → CJ Dropshipping screen can render.
//
// CONTRACT
// POST { action: 'test' | 'refresh' | 'logout' }  (default action: 'test')
// Response 200:
//   { ok:true, connected:true,  status:'Connected',              openId }
//   { ok:true, connected:false, status:'Not configured' }
//   { ok:false, connected:false, status:'Authentication failed', error }
//   { ok:false, connected:false, status:'Rate limited', error }

const { setCors, cjFetch, getValidToken, writeSyncLog, db } = require('./cj-shared');

function friendlyStatus(code) {
  if (code === 'NOT_CONFIGURED') return 'Not configured';
  if (code === 'RATE_LIMITED') return 'Rate limited';
  if (code === 'TIMEOUT') return 'CJ API unavailable (timeout)';
  if (code === 'NETWORK_ERROR') return 'CJ API unavailable';
  if (code === 'AUTH_FAILED' || code === 'REFRESH_FAILED') return 'Authentication failed';
  return 'Authentication failed';
}

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const action = String((req.body && req.body.action) || req.query.action || 'test');
  const started = Date.now();

  try {
    if (action === 'logout') {
      // CJ's logout endpoint invalidates the token CJ-side; we clear our
      // cache regardless of whether that call itself succeeds, since the
      // point is "stop using this token."
      const r = await cjFetch('/authentication/logout', { method: 'POST' });
      await db().collection('cjAuth').doc('token').delete().catch(() => {});
      await writeSyncLog({ event: 'auth.logout', success: !!r.ok, message: r.ok ? 'Logged out' : r.message, tookMs: Date.now() - started });
      return res.status(200).json({ ok: true, connected: false, status: 'Disconnected' });
    }

    const token = await getValidToken({ forceRefresh: action === 'refresh' });

    // Cheap, safe "is this token actually good" probe — categories is a
    // lightweight, side-effect-free CJ endpoint.
    const probe = await cjFetch('/product/getCategory');
    const tookMs = Date.now() - started;

    if (!probe.ok) {
      await writeSyncLog({ event: 'auth.test', success: false, message: probe.message, tookMs, detail: { code: probe.code } });
      return res.status(200).json({
        ok: false, connected: false,
        status: friendlyStatus(probe.code),
        error: probe.message,
      });
    }

    const snap = await db().collection('cjAuth').doc('token').get();
    const openId = (snap.exists && snap.data().openId) || null;

    await writeSyncLog({ event: 'auth.test', success: true, message: 'Connected', tookMs });
    return res.status(200).json({
      ok: true, connected: true,
      status: 'Connected',
      openId,
      tokenPresent: !!token, // boolean only — never the value itself
    });
  } catch (e) {
    const tookMs = Date.now() - started;
    await writeSyncLog({ event: 'auth.test', success: false, message: e.message, tookMs });
    return res.status(200).json({
      ok: false, connected: false,
      status: friendlyStatus(e.code),
      error: e.message,
    });
  }
};
