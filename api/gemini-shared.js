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
const PER_ATTEMPT_TIMEOUT_MS = 8000;   // gemini-2.5-flash with images can take >4s; 4s aborted healthy calls
const OVERALL_DEADLINE_MS = 16000;     // client gives up at 20s (index.html callRealNovaAPI)

// Primary model first, then cheaper/older ones: if a model is retired,
// renamed or not enabled for a key (404/400 "model not found"), NOVA keeps
// answering instead of silently falling back to the offline brain.
function modelChain() {
  // gemini-2.0-flash was retired by Google ("This model ... is no longer
  // available") — replaced with gemini-3.8-flash, the model Google's own
  // 404 response recommends. gemini-2.5-flash / gemini-2.5-flash-lite are
  // still served (not deprecated as of this writing) so they stay as
  // earlier-choice fallbacks ahead of it.
  const chain = [GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.8-flash'];
  return [...new Set(chain.filter(Boolean))];
}

// 2.5 models "think" before answering and the thinking tokens count against
// maxOutputTokens — with a small cap the reply can come back EMPTY. Turn
// thinking off for chat (fast + never starves the answer). 2.0 models reject
// the field, so only add it where supported.
function bodyForModel(model, requestBody) {
  if (!/^gemini-2\.5/.test(model)) return requestBody;
  const gc = { ...(requestBody.generationConfig || {}) };
  gc.thinkingConfig = { thinkingBudget: 0 };
  return { ...requestBody, generationConfig: gc };
}

const textOf = (data) => {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return Array.isArray(parts) ? parts.map(p => p && p.text || '').join('').trim() : '';
};

// 'key'   -> this key is the problem (rate limit, bad/expired/blocked key, server error, timeout): try the next key
// 'model' -> this model is the problem: try the next model
// 'stop'  -> the request itself is wrong; retrying elsewhere won't help
function classify(status, bodyText) {
  const t = String(bodyText || '');
  if (status === 429 || status === 403 || status === 401 || status >= 500 || status === 0) return 'key';
  if (status === 404) return 'model';
  if (status === 400) {
    if (/API_KEY_INVALID|API key not valid|API key expired|invalid api key/i.test(t)) return 'key';
    if (/model|not found|not supported/i.test(t)) return 'model';
    return 'stop';
  }
  return 'stop';
}

async function callGeminiWithRotation(keys, requestBody, opts = {}) {
  if (keys.length === 0) {
    return { ok: false, status: 500, error: "no_keys" };
  }
  const doFetch = opts.fetchImpl || fetch;
  const models = opts.models || modelChain();
  const startIdx = rotateCursor % keys.length;
  rotateCursor = (rotateCursor + 1) % keys.length;
  const deadlineAt = Date.now() + (opts.deadlineMs || OVERALL_DEADLINE_MS);

  let lastErr = null;
  for (const model of models) {
    let keyAttempts = 0;
    for (let i = 0; i < keys.length && keyAttempts < MAX_KEY_ATTEMPTS; i++) {
      const timeLeft = deadlineAt - Date.now();
      if (timeLeft <= 250) return { ok: false, status: 504, error: lastErr || { status: 504, body: "overall_deadline_exceeded" } };
      keyAttempts++;
      const key = keys[(startIdx + i) % keys.length];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(opts.perAttemptMs || PER_ATTEMPT_TIMEOUT_MS, timeLeft));
      let verdict;
      try {
        const res = await doFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            // Key in a header, not the URL, so it never lands in access logs.
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify(bodyForModel(model, requestBody)),
            signal: controller.signal,
          }
        );
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          if (textOf(data)) return { ok: true, data, model };
          // 200 but no text (safety block / empty): treat as this model's miss.
          lastErr = { status: 200, model, body: "empty_response:" + JSON.stringify((data && data.promptFeedback) || (data && data.candidates && data.candidates[0] && data.candidates[0].finishReason) || "") };
          verdict = 'model';
        } else {
          const body = await res.text().catch(() => "");
          lastErr = { status: res.status, model, body: body.slice(0, 300) };
          verdict = classify(res.status, body);
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = { status: 0, model, body: String(err) };
        verdict = 'key';
      }
      if (verdict === 'stop') return { ok: false, status: lastErr.status || 500, error: lastErr };
      if (verdict === 'model') break; // next model
      // 'key' -> next key
    }
  }
  return { ok: false, status: (lastErr && lastErr.status) || 500, error: lastErr };
}

module.exports = { GEMINI_MODEL, getApiKeys, callGeminiWithRotation, modelChain, classify, textOf };
