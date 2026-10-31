// /api/creator-cron.js
//
// LEXDEN NOVA CREATOR — Stage I. The scheduler's front door.
//
//   GET|POST /api/creator-cron[?jobs=sla,links]   Authorization: Bearer <CRON_SECRET>
//     (or header  x-cron-secret: <CRON_SECRET>)
//
// Call it every 10–15 minutes from a Render Cron Job or any free pinger
// (cron-job.org, UptimeRobot "HTTP keyword"…). Jobs have their own minimum
// intervals, so calling it often is harmless: a job that ran recently is
// skipped, not repeated.
//
// SECURITY: fails CLOSED. With no CRON_SECRET configured the endpoint answers
// 503 and does nothing; a wrong/missing secret is 401. The secret is compared
// in constant time and is never echoed. It is a secret of its own — unrelated
// to Paystack, CJ or Firebase keys.
const { getDb, setCors } = require('./creator/shared');
const { runJobs, JOB_NAMES } = require('./automation/runner');
const { secretMatches, authorizeCronRequest } = require('./cron-auth');

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authorizeCronRequest(req, res)) return;

  const raw = (req.query && req.query.jobs) || (req.body && req.body.jobs) || '';
  const names = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !JOB_NAMES.includes(n));
  if (unknown.length) return res.status(400).json({ ok: false, error: { code: 'UNKNOWN_JOB', message: 'Unknown scheduled job.' } });

  try {
    const results = await runJobs(getDb(), names, { trigger: 'cron' });
    return res.status(200).json({ ok: true, data: { results } });
  } catch (e) {
    console.error('creator-cron failed:', e.message);
    return res.status(500).json({ ok: false, error: { code: 'CRON_FAILED', message: 'The scheduler run failed.' } });
  }
};
module.exports.secretMatches = secretMatches;
