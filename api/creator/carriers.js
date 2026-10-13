// api/creator/carriers.js
//
// LEXDEN NOVA CREATOR — Stage H: courier handling for physical orders.
// PURE. Never contacts a courier (no credentials, no network); it
//   * validates and normalises tracking numbers,
//   * builds a public tracking link for carriers whose link format is known,
//   * and — most importantly — refuses any tracking URL that is not http(s),
//     because buyers click these links (a javascript: or data: URL typed by a
//     seller would be an attack on every buyer).
// A carrier that is not recognised gets NO generated link — we never guess.
const CARRIERS = Object.freeze([
  { id: 'DHL', names: ['dhl', 'dhl express', 'dhl ecommerce'], url: (n) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${encodeURIComponent(n)}` },
  { id: 'FEDEX', names: ['fedex', 'fed ex', 'federal express'], url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  { id: 'UPS', names: ['ups', 'united parcel service'], url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}` },
  { id: 'USPS', names: ['usps', 'us postal service'], url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}` },
  // China-origin and CJ-served carriers: 17TRACK recognises them and is the
  // aggregator CJ itself points customers to.
  { id: 'CJPACKET', names: ['cjpacket', 'cj packet', 'cj dropshipping', 'cjdropshipping', 'cj'], url: (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}` },
  { id: 'YUNEXPRESS', names: ['yunexpress', 'yun express'], url: (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}` },
  { id: 'YANWEN', names: ['yanwen'], url: (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}` },
  { id: 'CAINIAO', names: ['cainiao', 'aliexpress standard shipping'], url: (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}` },
  { id: 'EMS', names: ['ems', 'china post', 'chinapost'], url: (n) => `https://t.17track.net/en#nums=${encodeURIComponent(n)}` },
]);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function findCarrier(name) {
  const n = norm(name);
  if (!n) return null;
  return CARRIERS.find((c) => c.names.some((x) => norm(x) === n)) || null;
}

/** Spaces/dashes are decoration on many labels; letters, digits and - _ . / are kept. */
function normalizeTrackingNumber(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9._\/-]{4,50}$/.test(s)) return null;
  return s;
}

function sanitizeTrackingUrl(raw) {
  if (raw == null || raw === '') return { ok: true, url: null };
  if (typeof raw !== 'string' || raw.length > 500) return { ok: false, url: null };
  let u;
  try { u = new URL(raw.trim()); } catch { return { ok: false, url: null }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, url: null };
  if (u.username || u.password) return { ok: false, url: null };
  return { ok: true, url: u.toString() };
}

/**
 * Resolves what to store on a SHIPPED fulfillment.
 * Returns { ok, carrier, trackingNumber, trackingUrl, knownCarrier, errors[] }.
 * A seller-supplied URL (if valid) wins over a generated one.
 */
function resolveShipment({ carrier, trackingNumber, trackingUrl }) {
  const errors = [];
  const c = typeof carrier === 'string' ? carrier.trim() : '';
  if (!c || c.length > 100) errors.push({ field: 'carrier', message: 'A carrier name is required (100 characters max).' });
  const number = normalizeTrackingNumber(trackingNumber);
  if (!number) errors.push({ field: 'trackingNumber', message: 'Enter a valid tracking number (4–50 letters, numbers, dash or slash).' });
  const su = sanitizeTrackingUrl(trackingUrl);
  if (!su.ok) errors.push({ field: 'trackingUrl', message: 'The tracking link must be a normal http(s) web address.' });
  if (errors.length) return { ok: false, errors };
  const known = findCarrier(c);
  return {
    ok: true, errors: [],
    carrier: c, trackingNumber: number,
    trackingUrl: su.url || (known ? known.url(number) : null),
    knownCarrier: known ? known.id : null,
  };
}

module.exports = { CARRIERS, findCarrier, normalizeTrackingNumber, sanitizeTrackingUrl, resolveShipment };
