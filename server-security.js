'use strict';

// Small, dependency-free server hardening for the Render API.
//  * securityHeaders: the useful subset of what Helmet sets for a JSON API.
//  * createRateLimiter: per-IP fixed-window limits for the endpoints that cost
//    money or send email (AI, OTP, email). Webhooks and payment verification are
//    deliberately NOT limited so a real payment is never refused.
//  * isAllowedOrigin: browser origins that may call the API with credentials.
//  * cronAuthorized: shared-secret check for sweep endpoints.
const crypto = require('node:crypto');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the storefront on github.io reads these responses
  res.removeHeader('X-Powered-By');
  next();
}

const DEFAULT_LIMITS = {
  '/api/nova-ai': { max: 30, windowMs: 10 * 60 * 1000 },
  '/api/affiliate-ai': { max: 30, windowMs: 10 * 60 * 1000 },
  '/api/catalog': { max: 60, windowMs: 60 * 1000 },
  '/api/send-otp': { max: 6, windowMs: 10 * 60 * 1000 },
  '/api/verify-otp': { max: 20, windowMs: 10 * 60 * 1000 },
  '/api/send-email': { max: 10, windowMs: 10 * 60 * 1000 },
  '/api/send-auth-email': { max: 10, windowMs: 10 * 60 * 1000 },
};

function createRateLimiter(limits, now) {
  const rules = limits || DEFAULT_LIMITS;
  const clock = now || Date.now;
  const hits = new Map(); // key -> { count, resetAt }
  const purge = setInterval(function () {
    const t = clock();
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }, 5 * 60 * 1000);
  if (purge.unref) purge.unref();

  return function rateLimit(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const rule = rules[req.path] || rules[req.path.replace(/^(\/api\/[^/]+)\/.*$/, '$1')];
    if (!rule) return next();
    const key = req.path + '|' + (req.ip || 'unknown');
    const t = clock();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + rule.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > rule.max) {
      const retry = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a little and try again.' });
    }
    next();
  };
}

// Exact app origin(s), this service's own domain, and local development.
function isAllowedOrigin(origin, allowedList) {
  if (!origin) return true; // curl, health checks, server-to-server webhooks
  if ((allowedList || []).includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith('.onrender.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1') return true;
  } catch (e) { /* malformed Origin: reject */ }
  return false;
}

function same(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Returns true when the request carries the CRON_SECRET (Bearer or x-cron-secret).
function cronAuthorized(req, secret) {
  if (!secret || secret.length < 16) return false;
  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const header = String((req.headers && req.headers['x-cron-secret']) || '');
  return Boolean((bearer && same(bearer, secret)) || (header && same(header, secret)));
}

module.exports = { securityHeaders, createRateLimiter, isAllowedOrigin, cronAuthorized, DEFAULT_LIMITS };
