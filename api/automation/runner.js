// api/automation/runner.js
//
// LEXDEN NOVA CREATOR — Stage I: runs jobs safely.
//   * LOCK per job (automationLocks/{job}, transactional, 5-minute lease) so two
//     overlapping triggers (cron pinger + in-process timer + an admin click)
//     never run the same sweep twice at once.
//   * MIN INTERVAL per job so an over-eager pinger can't hammer CJ / link hosts;
//     `force` (admin "run now") skips it but never the lock.
//   * Every run is recorded in automationRuns (admin-readable): what ran, how
//     long, the summary, or the error.
// A job that throws is recorded as an error and the other jobs still run.
const { FieldValue } = require('../creator/shared');
const { JOBS } = require('./jobs');

const LEASE_MS = 5 * 60 * 1000;

async function acquire(db, name, nowMs, minIntervalMs, force) {
  const ref = db.collection('automationLocks').doc(name);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    if (cur.lockedUntilMs && cur.lockedUntilMs > nowMs) return { ok: false, reason: 'LOCKED' };
    if (!force && cur.lastFinishedAtMs && nowMs - cur.lastFinishedAtMs < minIntervalMs) return { ok: false, reason: 'TOO_SOON' };
    tx.set(ref, { lockedUntilMs: nowMs + LEASE_MS, lastStartedAtMs: nowMs }, { merge: true });
    return { ok: true };
  });
}

async function runJob(db, name, { force = false, deps = {}, now = Date.now, limit, trigger = 'cron' } = {}) {
  const job = JOBS[name];
  if (!job) return { job: name, status: 'UNKNOWN_JOB' };
  const startedAtMs = now();
  const lock = await acquire(db, name, startedAtMs, job.minIntervalMs, force);
  if (!lock.ok) return { job: name, status: 'SKIPPED', reason: lock.reason };
  let status = 'OK', summary = null, error = null;
  try {
    summary = await job.run(db, { nowMs: startedAtMs, deps, limit });
  } catch (e) {
    status = 'ERROR'; error = String(e && e.message || e).slice(0, 400);
    console.error(`automation job ${name} failed:`, error);
  }
  const finishedAtMs = now();
  await db.collection('automationLocks').doc(name).set({ lockedUntilMs: 0, lastFinishedAtMs: finishedAtMs, lastStatus: status }, { merge: true });
  try {
    await db.collection('automationRuns').add({
      job: name, status, trigger, startedAtMs, finishedAtMs, durationMs: finishedAtMs - startedAtMs,
      summary: summary || null, error, createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('could not record automation run:', e.message); }
  return { job: name, status, summary, error, durationMs: finishedAtMs - startedAtMs };
}

async function runJobs(db, names, opts = {}) {
  const list = (names && names.length ? names : Object.keys(JOBS)).filter((n, i, a) => a.indexOf(n) === i);
  const results = [];
  for (const n of list) results.push(await runJob(db, n, opts));
  return results;
}

module.exports = { runJob, runJobs, LEASE_MS, JOB_NAMES: Object.keys(JOBS) };
