// mcp/lib/audit.js
//
// Every MCP tool call gets one row in `mcpAuditLog` — who (admin email,
// since there's only ever one caller), what tool, what arguments (with
// obvious secrets stripped), whether it succeeded, and how long it took.
// This is the thing that lets you (or Claude, via nova_get_audit_log)
// answer "wait, did the MCP connection actually change anything?" after
// the fact — nothing in the original app logged admin actions this way.

const { getDb, FieldValue } = require('../../api/affiliate/shared');

const SECRET_KEY_PATTERN = /(secret|password|token|key|paystack|apikey)/i;

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function writeAuditEntry({ email, tool, args, ok, error, tookMs }) {
  try {
    const db = getDb();
    await db.collection('mcpAuditLog').add({
      email: email || null,
      tool,
      args: redact(args || {}),
      ok: !!ok,
      error: error || null,
      tookMs: tookMs || null,
      at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // Audit logging must never break the actual tool call — this is a
    // best-effort record, not a transaction guard.
    console.error('mcp audit log write failed:', e.message);
  }
}

async function listAuditEntries({ limit = 50 } = {}) {
  const db = getDb();
  const snap = await db.collection('mcpAuditLog').orderBy('at', 'desc').limit(Math.min(limit, 200)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

module.exports = { writeAuditEntry, listAuditEntries };
