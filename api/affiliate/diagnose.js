// /api/affiliate/diagnose.js
//
// FIX (mega-fix batch, see fix notes at repo root): powers the "Diagnose
// this for me" popup that affiliate/index.html now shows automatically
// after 3 consecutive failures of the SAME action (loading banks,
// verifying an account, submitting onboarding, requesting a withdrawal,
// loading the dashboard, etc.).
//
// WHY THIS EXISTS: a plain "check your connection" message is actively
// wrong most of the time on this app — the real cause is almost always
// one of a short list of KNOWN failure modes specific to this codebase
// (listed in KNOWN_CAUSES below). This endpoint asks Gemini to diagnose
// the failure using (a) the actual error code/message the client saw,
// (b) a short log of what the person actually did right before it broke
// (their "local activity"), and (c) that fixed list of known causes —
// so the answer is a specific, testable next step, not a generic guess.
// If Gemini is unavailable for any reason, GENERIC_FALLBACK below still
// picks the most likely cause from the known list by simple keyword
// matching on the error code, rather than showing nothing useful.
//
// POST { errorCode, errorMessage, action, recentActivity: [{action,ts,ok}] }
// No auth required — nothing sensitive is read or written here.

const { getApiKeys, callGeminiWithRotation } = require('../gemini-shared');

// Kept in sync with the actual bugs found and fixed in this codebase —
// update this list whenever a new recurring failure mode is diagnosed,
// so the AI (and the fallback matcher) keeps improving over time instead
// of staying static.
const KNOWN_CAUSES = `
1. RENDER_COLD_START — This backend runs on Render's free plan, which
   fully SLEEPS after ~15 minutes with no traffic and takes 30-60+
   seconds to wake back up on the next request. This is the single most
   common cause of "it takes forever" or a request that eventually
   times out. Symptom: the FIRST request after a period of inactivity is
   slow/fails; a retry seconds later works fine. Fix: keep the server
   awake with a free uptime pinger (e.g. UptimeRobot or cron-job.org
   hitting GET /health every 5-10 minutes), or upgrade off the free plan.
2. FIRESTORE_RULES_MISMATCH — affiliate signup writes a document with
   status:'active' directly (no approval step). If the firestore.rules
   actually PUBLISHED in the Firebase Console still require a different
   status (e.g. 'pending') on create, every single signup is rejected
   with a permission-denied error, forever, regardless of connection
   quality. Firestore rules are published separately from a code
   deploy — pushing new code to Render/GitHub never updates them. Fix:
   Firebase Console → Firestore Database → Rules → paste the current
   firestore.rules → Publish.
3. PAYSTACK_TEST_MODE — if PAYSTACK_SECRET_KEY on the server starts with
   sk_test_ instead of sk_live_, Paystack enforces a small daily quota on
   bank-list and account-resolve calls in test mode and will start
   returning errors like "test limit reached" after a few calls, and the
   bank list itself may be truncated. Fix: Render dashboard → Environment
   → replace PAYSTACK_SECRET_KEY with the LIVE secret key from the
   Paystack dashboard (Settings → API Keys & Webhooks).
4. MISSING_ENV_VAR — an endpoint returns a 500 with a message like
   "... not set on the server" when a required environment variable
   (PAYSTACK_SECRET_KEY, FIREBASE_*, GEMINI_API_KEY(S), BREVO_*) is
   missing on Render. Fix: Render dashboard → Environment → add it.
5. OFFLINE_OR_DNS — the browser itself has no working internet
   connection, or a carrier/DNS block is preventing lexden-nova.onrender.com
   from resolving. Only genuinely a connection issue in this case —
   check navigator.onLine and whether other sites load.
6. CORS_ORIGIN_BLOCKED — request blocked before it even reached the
   handler because the calling origin isn't in CORS_ALLOWED_ORIGINS.
   Symptom: a browser console CORS error, not a JSON error body. Fix:
   add the origin to CORS_ALLOWED_ORIGINS on Render, or confirm it's
   *.github.io / *.onrender.com / localhost (auto-allowed already).
`.trim();

function keywordFallback(errorCode, errorMessage) {
  const hay = `${errorCode || ''} ${errorMessage || ''}`.toLowerCase();
  if (/permission-denied|permission_denied|rules/.test(hay)) {
    return { cause: 'FIRESTORE_RULES_MISMATCH', advice: 'This looks like a Firestore rules mismatch — the rules published in the Firebase Console likely still require the old pending-approval flow. Publish the current firestore.rules in Firebase Console → Firestore → Rules.' };
  }
  if (/test limit|test mode|sk_test/.test(hay)) {
    return { cause: 'PAYSTACK_TEST_MODE', advice: 'Paystack is in test mode. Swap PAYSTACK_SECRET_KEY on Render for your LIVE secret key (starts with sk_live_) from the Paystack dashboard.' };
  }
  if (/not set on the server/.test(hay)) {
    return { cause: 'MISSING_ENV_VAR', advice: 'A required environment variable is missing on Render. Check the exact variable named in the error message under Render → Environment.' };
  }
  if (/timed out|timeout|took too long/.test(hay)) {
    return { cause: 'RENDER_COLD_START', advice: 'This is almost certainly the free-hosting server waking up from sleep (can take 30-60s the first time). Wait a moment and retry — and set up a free uptime pinger so this stops happening.' };
  }
  return { cause: 'UNKNOWN', advice: 'Could not pin this to a known cause automatically — please retry once, and if it keeps failing, check Render → Logs for the exact error at the time of the attempt.' };
}

function buildDiagnosisPrompt({ errorCode, errorMessage, action, recentActivity }) {
  const activityLines = (Array.isArray(recentActivity) ? recentActivity : [])
    .slice(-12)
    .map(a => `- ${a.ts || ''} ${a.action || 'unknown action'} → ${a.ok ? 'succeeded' : 'FAILED'}${a.errorCode ? ' (' + a.errorCode + ')' : ''}`)
    .join('\n') || '(no recent activity log provided)';

  return `You are a diagnostic assistant embedded in the LEXDEN NOVA affiliate program web app. A user just hit the SAME
error 3+ times in a row while trying to: ${action || 'an unspecified action'}.

Your job: give ONE specific, plain-language diagnosis and ONE concrete next step. Do NOT give a generic
"check your internet connection" answer unless the evidence genuinely points to that being the actual cause — most of
the time it is not. Ground your answer in the KNOWN CAUSES list below (these are real, confirmed failure modes of
THIS specific app) and in the person's own recent activity log. If the pattern doesn't match anything on the list,
say so honestly and suggest the single most useful next diagnostic step instead of guessing.

KNOWN CAUSES FOR THIS APP:
${KNOWN_CAUSES}

THE ERROR THAT KEPT REPEATING:
Code: ${errorCode || '(none provided)'}
Message: ${errorMessage || '(none provided)'}

THIS USER'S RECENT ACTIVITY (their own device, most recent last):
${activityLines}

Reply as clean HTML using only <p>, <strong>, <em>, <ul>, <li>, <br> — no markdown, no code fences. Keep it under
120 words. Lead with the diagnosis in one sentence, then the fix.`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed — use POST.' });

  const { errorCode, errorMessage, action, recentActivity } = req.body || {};
  const fallback = keywordFallback(errorCode, errorMessage);

  const keys = getApiKeys();
  if (keys.length === 0) {
    // No Gemini configured — still return the keyword-matched diagnosis
    // rather than a bare 500, so the popup is never empty.
    return res.status(200).json({ ok: true, cause: fallback.cause, html: `<p>${fallback.advice}</p>`, aiPowered: false });
  }

  try {
    const requestBody = {
      contents: [{ role: 'user', parts: [{ text: 'Diagnose this failure.' }] }],
      systemInstruction: { parts: [{ text: buildDiagnosisPrompt({ errorCode, errorMessage, action, recentActivity }) }] },
      generationConfig: { maxOutputTokens: 300 },
    };
    const result = await callGeminiWithRotation(keys, requestBody);
    if (!result.ok) {
      console.error('affiliate-diagnose Gemini call failed:', result.status, result.error);
      return res.status(200).json({ ok: true, cause: fallback.cause, html: `<p>${fallback.advice}</p>`, aiPowered: false });
    }
    const html = result.data.candidates?.[0]?.content?.parts?.[0]?.text
      || `<p>${fallback.advice}</p>`;
    return res.status(200).json({ ok: true, cause: fallback.cause, html, aiPowered: true });
  } catch (err) {
    console.error('affiliate-diagnose handler error:', err);
    return res.status(200).json({ ok: true, cause: fallback.cause, html: `<p>${fallback.advice}</p>`, aiPowered: false });
  }
};
