// /api/gemini-shared.js
//
// Extracted from nova-ai.js so the new Affiliate Assistant (api/affiliate/ai.js)
// can reuse the exact same multi-key rotation logic instead of duplicating
// it. nova-ai.js now requires this file too — same behavior as before,
// just shared instead of copy-pasted.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"; // legacy default; see modelChain()

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

// Google retires models (gemini-2.0-flash now answers 404 "no longer available"),
// so a hard-coded list rots. Strategy:
//   1) GEMINI_MODEL (if you set it) is always tried first.
//   2) Then the models Google itself says are available RIGHT NOW to this key
//      (ListModels, cached for an hour), best "flash" version first.
//   3) Then a static fallback list.
// A model that answers 404 is remembered as dead for 6 hours so it is not retried on
// every chat message.
const STATIC_FALLBACKS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MODEL_CACHE_MS = 60 * 60 * 1000;
const DEAD_MODEL_MS = 6 * 60 * 60 * 1000;
let modelCache = { at: 0, models: [] };
const deadModels = new Map();

function markDead(model) { deadModels.set(model, Date.now() + DEAD_MODEL_MS); }
function isDead(model) { const t = deadModels.get(model); if (!t) return false; if (Date.now() > t) { deadModels.delete(model); return false; } return true; }

// Pure: pick usable chat models from a ListModels payload, newest flash first.
function pickChatModels(listPayload) {
  const rows = (listPayload && listPayload.models) || [];
  const scored = [];
  for (const m of rows) {
    const name = String(m.name || '').replace(/^models\//, '');
    const methods = m.supportedGenerationMethods || [];
    if (!/^gemini-/.test(name) || !methods.includes('generateContent')) continue;
    if (!/flash/.test(name)) continue;
    if (/image|tts|live|audio|embedding|robotics|computer|exp|thinking|learnlm|-latest$/i.test(name)) continue;
    const ver = /gemini-(\d+(?:\.\d+)?)/.exec(name);
    const v = ver ? parseFloat(ver[1]) : 0;
    const lite = /lite/.test(name) ? 1 : 0;
    const preview = /preview/.test(name) ? 1 : 0;
    scored.push({ name, v, lite, preview });
  }
  // newest version first; stable before preview; full flash before lite
  scored.sort((a, b) => b.v - a.v || a.preview - b.preview || a.lite - b.lite || a.name.localeCompare(b.name));
  return [...new Set(scored.map(x => x.name))].slice(0, 5);
}

async function discoverModels(keys, doFetch) {
  if (Date.now() - modelCache.at < MODEL_CACHE_MS && modelCache.models.length) return modelCache.models;
  if (Date.now() - modelCache.at < 2 * 60 * 1000 && modelCache.at) return modelCache.models; // recent failure: don't hammer
  for (const key of keys.slice(0, 2)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await doFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const picked = pickChatModels(await res.json());
      if (picked.length) { modelCache = { at: Date.now(), models: picked }; return picked; }
    } catch { clearTimeout(timer); }
  }
  modelCache = { at: Date.now(), models: modelCache.models }; // remember the failure briefly
  return modelCache.models;
}

function modelChain(discovered = []) {
  const chain = [process.env.GEMINI_MODEL, ...discovered, GEMINI_MODEL, ...STATIC_FALLBACKS];
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
  const models = (opts.models || modelChain(opts.skipDiscovery ? [] : await discoverModels(keys, doFetch))).filter(m => !isDead(m) || opts.models);
  if (!models.length) models.push(...modelChain());
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
      if (verdict === 'model') { if (lastErr && lastErr.status === 404) markDead(model); break; } // next model
      // 'key' -> next key
    }
  }
  return { ok: false, status: (lastErr && lastErr.status) || 500, error: lastErr };
}

module.exports = { GEMINI_MODEL, pickChatModels, discoverModels, _resetModelState: () => { modelCache = { at: 0, models: [] }; deadModels.clear(); }, getApiKeys, callGeminiWithRotation, modelChain, classify, textOf };
