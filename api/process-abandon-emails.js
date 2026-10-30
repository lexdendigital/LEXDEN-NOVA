'use strict';
const { getDb } = require('./affiliate/shared');
const { authorizeCronRequest } = require('./cron-auth');
const { runJob } = require('./automation/runner');
module.exports = async function processAbandonEmailsRoute(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!authorizeCronRequest(req, res)) return;
  try {
    const result = await runJob(getDb(), 'lifecycleEmails', { trigger: 'authenticated-http' });
    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    console.error('process-abandon-emails route failed:', e && e.message);
    return res.status(500).json({ ok: false, error: 'Lifecycle processing failed.' });
  }
};
