const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../api/gemini-shared');

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => '' });
const bad = (status, body = '') => ({ ok: false, status, json: async () => ({}), text: async () => body });
const LIST = { models: ['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) };

function fakeFetch(retired, calls) {
  return async (url, opts) => {
    calls.push(url);
    if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => LIST, text: async () => '' };
    const model = /models\/([^:]+):/.exec(url)[1];
    if (retired.includes(model)) return bad(404, `This model models/${model} is no longer available.`);
    return ok(`hello from ${model}`);
  };
}

test('discovers the live model list and uses the newest flash (retired 2.x models are skipped)', async () => {
  g._resetModelState();
  delete process.env.GEMINI_MODEL;
  const calls = [];
  const r = await g.callGeminiWithRotation(['k1', 'k2'], { contents: [] }, { fetchImpl: fakeFetch(['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], calls) });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'gemini-3.8-flash');
});

test('falls through retired models and remembers dead ones (no repeat 404s)', async () => {
  g._resetModelState();
  const calls = [];
  const f = fakeFetch(['gemini-3.8-flash', 'gemini-2.5-flash'], calls);
  const first = await g.callGeminiWithRotation(['k1'], { contents: [] }, { fetchImpl: f });
  assert.equal(first.model, 'gemini-3.8-flash-lite');
  calls.length = 0;
  const second = await g.callGeminiWithRotation(['k1'], { contents: [] }, { fetchImpl: f });
  assert.equal(second.model, 'gemini-3.8-flash-lite');
  assert.ok(!calls.some((u) => u.includes('gemini-3.8-flash:')), 'dead model not retried');
});

test('still works when model discovery itself fails (static fallbacks)', async () => {
  g._resetModelState();
  const f = async (url) => (/\/models\?/.test(url) ? bad(500) : ok('hi'));
  const r = await g.callGeminiWithRotation(['k1'], { contents: [] }, { fetchImpl: f });
  assert.equal(r.ok, true);
});

test('bad first key rotates to the second key', async () => {
  g._resetModelState();
  let n = 0;
  const f = async (url, opts) => {
    if (/\/models\?/.test(url)) return { ok: true, status: 200, json: async () => LIST, text: async () => '' };
    return opts.headers['x-goog-api-key'] === 'bad' ? bad(400, 'API key not valid') : ok('fine' + (++n));
  };
  const r = await g.callGeminiWithRotation(['bad', 'good'], { contents: [] }, { fetchImpl: f });
  assert.equal(r.ok, true);
});
