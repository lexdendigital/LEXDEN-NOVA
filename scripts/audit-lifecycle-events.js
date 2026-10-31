'use strict';
// Read-only audit. Never modifies, deletes, queues or sends email.
// Usage: node scripts/audit-lifecycle-events.js [max-records]
const { getDb } = require('../api/affiliate/shared');
const { TRUSTED_SOURCE, validTrustedEvent } = require('../api/lifecycle-worker');
async function main() {
  const cap = Math.max(1, Math.min(50000, Number(process.argv[2]) || 1000));
  const snap = await getDb().collection('productViewEvents').limit(cap).get();
  const result = { scanned: snap.size, trustedV1: 0, legacyOrUntrusted: 0, malformedTrusted: 0, capped: snap.size === cap };
  for (const doc of snap.docs) {
    const value = doc.data() || {};
    if (value.source === TRUSTED_SOURCE && validTrustedEvent(value)) result.trustedV1 += 1;
    else if (value.source === TRUSTED_SOURCE) result.malformedTrusted += 1;
    else result.legacyOrUntrusted += 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch((error) => { console.error('Lifecycle audit failed:', error && error.message); process.exitCode = 1; });
