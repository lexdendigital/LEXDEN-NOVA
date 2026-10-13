// api/automation/ssrf.js
//
// LEXDEN NOVA CREATOR — Stage I: a server-side link checker that is safe to
// point at creator-supplied URLs (blueprint §33). A server that fetches
// attacker-chosen addresses is an SSRF machine unless it:
//   * accepts only http/https, no embedded credentials, no odd ports
//   * blocks private / loopback / link-local / metadata / reserved addresses
//     (IPv4 AND IPv6, including IPv4-mapped IPv6)
//   * validates EVERY redirect hop again (max 3)
//   * resolves DNS itself and CONNECTS TO THE VALIDATED ADDRESS — the socket
//     is pinned, so a hostname that re-resolves to 169.254.169.254 between
//     "check" and "connect" (DNS rebinding) cannot get through
//   * uses short timeouts and never reads the response body (headers only)
// The network pieces (resolve, requestOnce) are injectable so every rule is
// unit tested without touching the network.
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const ALLOWED_PORTS = new Set(['', '80', '443']);
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;

// --- address classification -------------------------------------------------
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some((r) => ((n & r.mask) >>> 0) === ((r.base & r.mask) >>> 0));
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  // embedded IPv4 tail (::ffff:1.2.3.4 or 64:ff9b::1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const n = ipv4ToInt(m[2]);
    s = `${m[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const fill = t === null ? 0 : 8 - h.length - t.length;
  const groups = t === null ? h : [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t];
  return groups.map((g) => parseInt(g || '0', 16));
}

function isBlockedV6(ip) {
  const g = expandV6(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return true; // unparsable => refuse
  const allZeroUpTo = (k) => g.slice(0, k).every((x) => x === 0);
  if (allZeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true;           // :: and ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return true;                                          // IPv4-compatible ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true;   // fec0::/10 site local
  if ((g[0] & 0xff00) === 0xff00) return true;   // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true;              // 6to4 (embeds arbitrary v4)
  return false;
}

/** true when the address must never be contacted. Non-IPs are blocked. */
function isBlockedAddress(ip) {
  const v = net.isIP(String(ip));
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

// --- URL + DNS validation -----------------------------------------------------
function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return { ok: false, code: 'INVALID_URL' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { ok: false, code: 'INVALID_URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, code: 'BAD_SCHEME' };
  if (u.username || u.password) return { ok: false, code: 'CREDENTIALS_IN_URL' };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, code: 'BAD_PORT' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, code: 'BLOCKED_HOST' };
  return { ok: true, url: u, host };
}

async function defaultResolve(host) {
  const list = await dns.lookup(host, { all: true, verbatim: true });
  return list.map((x) => x.address);
}

/** Parse + resolve + reject if ANY resolved address is non-public. */
async function validateTarget(raw, { resolve = defaultResolve } = {}) {
  const p = parseUrl(raw);
  if (!p.ok) return p;
  let addresses;
  if (net.isIP(p.host)) addresses = [p.host];
  else {
    try { addresses = await resolve(p.host); } catch { return { ok: false, code: 'DNS_FAILED' }; }
  }
  if (!addresses || !addresses.length) return { ok: false, code: 'DNS_FAILED' };
  if (addresses.some(isBlockedAddress)) return { ok: false, code: 'BLOCKED_ADDRESS' };
  return { ok: true, url: p.url, host: p.host, address: addresses[0] };
}

// --- one network hop (default implementation) --------------------------------
// Connects to `address` directly (pinned), but keeps Host/SNI as the hostname.
function defaultRequestOnce({ url, host, address, method, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const family = net.isIP(address);
    const req = lib.request({
      method, host, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`, servername: net.isIP(host) ? undefined : host,
      headers: { Host: url.host, 'User-Agent': 'LEXDEN-NOVA-LinkCheck/1.0', Accept: '*/*', Connection: 'close' },
      lookup: (_h, _o, cb) => cb(null, address, family),   // <- the pin
      timeout: timeoutMs,
    }, (res) => {
      const out = { status: res.statusCode, location: res.headers.location || null };
      res.destroy();                                       // headers only; never read the body
      resolve(out);
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

function classifyNetworkError(e) {
  const c = e && e.code;
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') return 'TIMEOUT';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'DNS_FAILED';
  if (c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'CONNECT_FAILED';
  if (c && String(c).startsWith('ERR_TLS') || c === 'CERT_HAS_EXPIRED' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || c === 'ERR_SSL_WRONG_VERSION_NUMBER') return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}

/**
 * Checks one external link, safely.
 * Returns { state, code, status?, finalHost?, hops }
 *   state: OK | BROKEN | TRANSIENT | BLOCKED
 *     OK        reachable (2xx/3xx final, or 401/403 — the page exists but wants a login)
 *     BROKEN    the content is gone (404/410/DNS name does not exist/TLS broken)
 *     TRANSIENT slow/5xx/429/connection trouble — may recover, needs repeats before action
 *     BLOCKED   points somewhere NOVA refuses to contact (internal address etc.)
 */
async function checkExternalLink(raw, { resolve = defaultResolve, requestOnce = defaultRequestOnce, timeoutMs = TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const t = await validateTarget(current, { resolve });
    if (!t.ok) {
      if (t.code === 'DNS_FAILED') return { state: hop === 0 ? 'BROKEN' : 'BROKEN', code: 'DNS_FAILED', hops: hop };
      return { state: 'BLOCKED', code: t.code, hops: hop };
    }
    let r;
    try {
      r = await requestOnce({ url: t.url, host: t.host, address: t.address, method: 'HEAD', timeoutMs });
      // Many hosts refuse HEAD; ask once more with GET (still headers only).
      if (r.status === 405 || r.status === 501 || r.status === 400) r = await requestOnce({ url: t.url, host: t.host, address: t.address, method: 'GET', timeoutMs });
    } catch (e) {
      const code = classifyNetworkError(e);
      return { state: code === 'DNS_FAILED' || code === 'TLS_ERROR' ? 'BROKEN' : 'TRANSIENT', code, hops: hop };
    }
    const s = r.status;
    if (s >= 300 && s < 400 && r.location) {
      let next;
      try { next = new URL(r.location, t.url).toString(); } catch { return { state: 'BROKEN', code: 'BAD_REDIRECT', status: s, hops: hop }; }
      current = next;
      continue;
    }
    const base = { status: s, finalHost: t.host, hops: hop };
    if (s >= 200 && s < 400) return { state: 'OK', code: 'OK', ...base };
    if (s === 401 || s === 403) return { state: 'OK', code: 'AUTH_WALL', ...base };
    if (s === 404 || s === 410) return { state: 'BROKEN', code: `HTTP_${s}`, ...base };
    if (s === 408 || s === 425 || s === 429 || s >= 500) return { state: 'TRANSIENT', code: `HTTP_${s}`, ...base };
    return { state: 'BROKEN', code: `HTTP_${s}`, ...base };
  }
  return { state: 'BROKEN', code: 'TOO_MANY_REDIRECTS', hops: maxRedirects + 1 };
}

module.exports = { isBlockedAddress, parseUrl, validateTarget, checkExternalLink, classifyNetworkError, MAX_REDIRECTS, TIMEOUT_MS };
