// GET /api/email-health?secret=<CRON_SECRET>[&send=you@example.com][&template=verify]
//
// One link that tells you EXACTLY why emails are not arriving. It never shows
// secret values — only whether each setting exists and what Brevo itself says.
//   * which BREVO_* settings are present / missing
//   * whether Brevo accepts the API key (and its IP-restriction message, if any)
//   * whether the sender address is a verified sender in Brevo
//   * with &send=<email>: really sends a test using that template and returns Brevo's exact answer
// Protected by CRON_SECRET (constant-time compare). Fails closed if it is not set.
const crypto = require('crypto');
const { attemptSend } = require('./email-shared');

const TEMPLATE_KEYS = [
  'welcome', 'verify', 'reset', 'contact', 'order', 'order_update', 'security', 'admin', 'newsletter',
  'creator_application_update', 'creator_account_status', 'creator_sla', 'abandoned_product', 'review_request',
];

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

async function brevoGet(path, apiKey) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.brevo.com/v3${path}`, { headers: { 'api-key': apiKey, Accept: 'application/json' }, signal: ctl.signal });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e && e.message) };
  } finally { clearTimeout(t); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return res.status(503).json({ ok: false, error: 'CRON_SECRET is not set on the server.' });
  const given = (req.query && req.query.secret) || '';
  if (!given || !same(given, expected)) return res.status(401).json({ ok: false, error: 'Wrong secret.' });

  const apiKey = process.env.BREVO_API_KEY || '';
  const out = {
    ok: true,
    brevoApiKeySet: !!apiKey,
    senderEmail: process.env.BREVO_SENDER_EMAIL || 'lexdendigital@gmail.com (default)',
    templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, Number(process.env[`BREVO_TPL_${k.toUpperCase()}`]) > 0 ? 'set' : 'MISSING'])),
    otpSigningSecretSet: !!process.env.OTP_SIGNING_SECRET,
    firebaseSet: !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY),
  };
  const problems = [];
  if (!apiKey) problems.push('BREVO_API_KEY is not set on Render. Add it (Brevo → SMTP & API → API Keys).');
  if (!out.otpSigningSecretSet) problems.push('OTP_SIGNING_SECRET is not set — sign-up codes cannot be created.');
  out.fileStorage = (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) ? 'cloudinary (ready)' : 'NOT READY';
  if (out.fileStorage === 'NOT READY') problems.push('CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set on Render, so creator ID documents, paid files and delivery photos cannot be saved (Cloudinary → Settings → API Keys).');
  if (!out.firebaseSet) problems.push('FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are not all set.');
  for (const [k, v] of Object.entries(out.templates)) if (v === 'MISSING') problems.push(`BREVO_TPL_${k.toUpperCase()} is not set, so the "${k}" email is never sent.`);

  if (apiKey) {
    const acct = await brevoGet('/account', apiKey);
    out.brevoAccount = acct.status === 200 ? { accepted: true, plan: (acct.body.plan || []).map((p) => `${p.type}: ${p.credits ?? ''}`) } : { accepted: false, status: acct.status, message: acct.body && acct.body.message ? acct.body.message : acct.body };
    if (acct.status !== 200) problems.push(`Brevo rejected the API key (HTTP ${acct.status}): ${JSON.stringify(out.brevoAccount.message)}. If it mentions an unrecognised IP, turn off "Authorized IPs" in Brevo → Security.`);
    else {
      const snd = await brevoGet('/senders', apiKey);
      const list = (snd.body && snd.body.senders) || [];
      const want = String(process.env.BREVO_SENDER_EMAIL || 'lexdendigital@gmail.com').toLowerCase();
      const hit = list.find((x) => String(x.email).toLowerCase() === want);
      out.sender = { address: want, found: !!hit, active: !!(hit && hit.active) };
      if (!hit) problems.push(`The sender ${want} is not added in Brevo → Senders. Add and verify it (or set BREVO_SENDER_EMAIL to a verified sender).`);
      else if (!hit.active) problems.push(`The sender ${want} exists but is not verified/active in Brevo. Open the verification email Brevo sent and confirm it.`);
    }
  }

  const to = req.query && req.query.send;
  if (to) {
    const template = String(req.query.template || 'verify');
    try {
      const r = await attemptSend({ templateKey: template, to: { email: String(to) }, params: { code: '123456', name: 'Test' } });
      out.testSend = { sent: true, template, messageId: r && r.messageId };
    } catch (e) {
      out.testSend = { sent: false, template, error: String(e.message).slice(0, 400) };
      problems.push(`Test send failed: ${out.testSend.error}`);
    }
  }
  out.problems = problems;
  out.verdict = problems.length ? 'PROBLEMS FOUND — fix the items in "problems".' : 'All email settings look correct.';
  return res.status(200).json(out);
};
