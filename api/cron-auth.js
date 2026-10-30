'use strict';
const crypto = require('crypto');
function secretMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}
function presentedSecret(req) {
  const headers = req && req.headers || {};
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || headers.Authorization || ''));
  return (match && match[1].trim()) || String(headers['x-cron-secret'] || '');
}
function authorizeCronRequest(req, res, options = {}) {
  const methods = options.methods || ['GET', 'POST'];
  res.setHeader('Cache-Control', 'no-store');
  if (!methods.includes(req.method)) {
    res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    return false;
  }
  const expected = String(process.env.CRON_SECRET || '');
  if (expected.length < 16) {
    res.status(503).json({ ok: false, error: { code: 'CRON_NOT_CONFIGURED', message: 'The scheduler is not configured.' } });
    return false;
  }
  if (!secretMatches(presentedSecret(req), expected)) {
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid cron authorization.' } });
    return false;
  }
  return true;
}
module.exports = { secretMatches, presentedSecret, authorizeCronRequest };
