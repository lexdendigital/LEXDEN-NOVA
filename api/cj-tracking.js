// /api/cj-tracking.js
//
// LEXDEN NOVA × CJ — tracking info for "My Orders → Track Package"
// (README §24). Public-safe: carrier/status/events only, never CJ account
// internals.
//
// CONTRACT
// GET /api/cj-tracking?trackNumber=...
//   -> { ok:true, carrier, status, events:[{ time, description, location }] }

const { setCors, cjFetch, writeSyncLog } = require('./cj-shared');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=120');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const trackNumber = String(req.query.trackNumber || req.query.trackingNumber || '').trim();
  if (!trackNumber) return res.status(200).json({ ok: false, error: 'Provide trackNumber.' });

  const started = Date.now();
  try {
    const r = await cjFetch('/logistic/trackInfo', { query: { trackNumber } });
    const tookMs = Date.now() - started;
    if (!r.ok) {
      await writeSyncLog({ event: 'tracking.query', objectId: trackNumber, success: false, message: r.message, tookMs });
      return res.status(200).json({ ok: false, error: 'Tracking information is not available yet for this shipment.' });
    }

    const d = r.data || {};
    const rawEvents = Array.isArray(d.trackInfoList) ? d.trackInfoList : (Array.isArray(d.events) ? d.events : []);
    const events = rawEvents.map(e => ({
      time: e.trackDate || e.time || null,
      description: e.trackDescription || e.description || '',
      location: e.trackLocation || e.location || null,
    }));

    await writeSyncLog({ event: 'tracking.query', objectId: trackNumber, success: true, message: `${events.length} events`, tookMs });
    return res.status(200).json({
      ok: true,
      carrier: d.logisticName || d.carrier || null,
      status: d.trackingStatus || d.status || 'In transit',
      events,
    });
  } catch (e) {
    await writeSyncLog({ event: 'tracking.query', objectId: trackNumber, success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Tracking lookup failed.' });
  }
};
