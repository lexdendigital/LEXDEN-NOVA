// /api/creator-seller.js
//
// LEXDEN NOVA CREATOR — Stage K: PUBLIC seller page data.
//
//   GET /api/creator-seller?u=<username>     (or ?id=<creator uid>)
//     -> { seller: {username, displayName, verified, image, bio, tagline, listingCount}, listings: [...] }
//
// Only ACTIVE creators have a page, and only their PUBLISHED listings are
// returned, through the same sanitising mapper as /api/creator-listings
// (no private delivery details, no supplier data, no balances, no emails).
const { getDb, setCors } = require('./creator/shared');
const { toPublicListing } = require('./creator-listings');

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  res.setHeader('Cache-Control', 'public, max-age=30');
  const notFound = () => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Seller not found.' } });
  try {
    const db = getDb();
    const q = req.query || {};
    let uid = null;
    if (q.u) {
      const name = String(q.u).replace(/^@/, '').toLowerCase();
      if (!USERNAME_RE.test(name)) return notFound();
      const s = await db.collection('creatorUsernames').doc(name).get();
      uid = s.exists ? s.data().uid : null;
    } else if (q.id && typeof q.id === 'string' && !q.id.includes('/') && q.id.length <= 128) {
      uid = q.id;
    }
    if (!uid) return notFound();
    const cs = await db.collection('creators').doc(uid).get();
    if (!cs.exists || cs.data().status !== 'ACTIVE') return notFound();
    const c = cs.data();
    const snap = await db.collection('products').where('creatorId', '==', uid).where('status', '==', 'PUBLISHED').limit(200).get();
    const listings = snap.docs.map((d) => toPublicListing({ id: d.id, ...d.data() }, c)).filter(Boolean);
    return res.status(200).json({ ok: true, data: {
      seller: {
        id: uid, username: c.username || null, displayName: c.displayName || 'Creator', verified: !!c.verifiedBusiness,
        image: typeof c.profileImageUrl === 'string' && /^https:\/\//i.test(c.profileImageUrl) ? c.profileImageUrl : null,
        bio: String(c.bio || '').slice(0, 500), tagline: String(c.tagline || '').slice(0, 100), listingCount: listings.length,
      },
      listings,
    } });
  } catch (e) {
    console.error('creator-seller failed:', e && e.message);
    return res.status(503).json({ ok: false, error: { code: 'SELLER_UNAVAILABLE', message: 'Could not load this seller right now.' } });
  }
};
