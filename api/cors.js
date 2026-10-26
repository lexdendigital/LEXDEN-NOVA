'use strict';

const DEFAULT_ORIGINS = ['https://lexdendigital.github.io'];
function allowedOrigins() {
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_ORIGINS;
}
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (allowedOrigins().includes(origin)) return true;
  if (process.env.NODE_ENV === 'development') {
    try { const host = new URL(origin).hostname; return host === 'localhost' || host === '127.0.0.1'; }
    catch { return false; }
  }
  return false;
}
function applyCors(req, res, options = {}) {
  const origin = req && req.headers && req.headers.origin;
  if (isAllowedOrigin(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  else res.removeHeader('Access-Control-Allow-Origin');
  res.setHeader('Access-Control-Allow-Methods', options.methods || 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', options.headers || 'Content-Type, Authorization, X-Admin-Token, X-Firebase-AppCheck, Idempotency-Key, X-Request-Id');
  return isAllowedOrigin(origin);
}
module.exports = { allowedOrigins, isAllowedOrigin, applyCors };
