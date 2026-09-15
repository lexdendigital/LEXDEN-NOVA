// /api/gemini-shared.js
//
// Extracted from nova-ai.js so the new Affiliate Assistant (api/affiliate/ai.js)
// can reuse the exact same multi-key rotation logic instead of duplicating
// it. nova-ai.js now requires this file too — same behavior as before,
// just shared instead of copy-pasted.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/* ============================================================
   MULTI-KEY ROTATION — supports THREE ways of configuring keys:
     1) GEMINI_API_KEYS = "key1,key2,key3,..."  (comma/newline separated)
     2) GEMINI_API_KEY_1 ... GEMINI_API_KEY_30  (one env var per key)
     3) GEMINI_API_KEY  (single legacy key)
   On a rate-limit (429) or server error (5xx), automatically retries
   with the NEXT key. The rotating cursor persists across requests on
   this instance so load spreads across the whole key pool over time.
   ============================================================ */
function getApiKeys() {
  const keys = [];
  const bulk = process.env.GEMINI_API_KEYS;
  if (bulk) {
    bulk.split(/[,\n]/).map(s => s.trim()).filter(Boolean).forEach(k => keys.push(k));
  }
  for (let i = 1; i <= 30; i++) {
    const v = process.env[`GEMINI_API_KEY_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return [...new Set(keys)]; // de-dupe in case the same key appears twice
}

let rotateCursor = 0;
const MAX_KEY_ATTEMPTS = 4;
const PER_ATTEMPT_TIMEOUT_MS = 4000;
const OVERALL_DEADLINE_MS = 12000;

async function callGeminiWithRotation(keys, requestBody) {
  if (keys.length === 0) {
    return { ok: false, status: 500, error: "no_keys" };
  }
  const attempts = Math.min(MAX_KEY_ATTEMPTS, keys.length);
  const startIdx = rotateCursor % keys.length;
  rotateCursor = (rotateCursor + 1) % keys.length;
  const deadlineAt = Date.now() + OVERALL_DEADLINE_MS;

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const timeLeft = deadlineAt - Date.now();
    if (timeLeft <= 250) {
      lastErr = lastErr || { status: 504, body: "overall_deadline_exceeded" };
      break;
    }
    const key = keys[(startIdx + i) % keys.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PER_ATTEMPT_TIMEOUT_MS, timeLeft));
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }
      );
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return { ok: true, data };
      }
      if (res.status === 429 || res.status >= 500 || res.status === 403) {
        lastErr = { status: res.status, body: await res.text().catch(() => "") };
        continue;
      }
      lastErr = { status: res.status, body: await res.text().catch(() => "") };
      break;
    } catch (err) {
      clearTimeout(timer);
      lastErr = { status: 0, body: String(err) };
      continue;
    }
  }
  return { ok: false, status: lastErr?.status || 500, error: lastErr };
}

module.exports = { GEMINI_MODEL, getApiKeys, callGeminiWithRotation };
