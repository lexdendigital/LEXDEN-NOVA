'use strict';

function createRateLimiter(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || 60_000);
  const max = Math.max(1, Math.floor(Number(options.max) || 60));
  const label = String(options.name || 'requests');
  const keyFn = typeof options.key === 'function' ? options.key : null;
  const buckets = new Map();
  let operations = 0;

  return function rateLimit(req, res, next) {
    if (!req || !res || typeof next !== 'function') return next && next();
    if (String(req.method || '').toUpperCase() === 'OPTIONS') return next();

    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 100);
    let identity = ip;
    if (keyFn) {
      try { identity = String(keyFn(req) || ip).slice(0, 200); }
      catch { identity = ip; }
    }
    const key = label + ':' + identity;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };

    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: 'Too many requests. Please wait before trying again.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: retryAfter,
      });
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    operations += 1;

    // Bound memory use under high-cardinality or spoofed-source traffic.
    if (buckets.size > 5000 || operations % 500 === 0) {
      for (const [k, value] of buckets) {
        if (now >= value.resetAt) buckets.delete(k);
        if (buckets.size <= 4000) break;
      }
      while (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
    }
    return next();
  };
}

module.exports = { createRateLimiter };
