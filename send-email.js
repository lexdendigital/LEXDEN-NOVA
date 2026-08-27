// Generic Brevo transactional-email sender for LEXDEN NOVA.
//
// WHY THIS EXISTS: Brevo's send API requires BREVO_API_KEY on every call.
// That key must never reach the browser — a key visible in client JS can
// be copied out of dev tools in seconds and used to send mail as you from
// anywhere. So this one small serverless endpoint is the only thing that
// ever talks to Brevo; the client (index.html) and the other serverless
// functions (verify-paystack.js) just POST here with a template key + the
// dynamic values, exactly the same "server holds the secret" pattern
// verify-paystack.js already uses for the Paystack secret key.
//
// SETUP (Vercel → this project → Settings → Environment Variables):
//   BREVO_API_KEY              your Brevo transactional API key (starts "xkeysib-")
//   BREVO_SENDER_EMAIL         a sender verified in Brevo, e.g. no-reply@yourdomain
//   BREVO_SENDER_NAME          optional, defaults to "LEXDEN NOVA"
//   BREVO_TPL_WELCOME          numeric Brevo template ID for 01-welcome.html
//   BREVO_TPL_VERIFY           numeric Brevo template ID for 02-email-verification.html
//                              (now sent by send-otp.js with a {{ params.code }} —
//                              a 6-digit sign-up code, not a link)
//   BREVO_TPL_RESET            numeric Brevo template ID for 03-password-reset.html
//   BREVO_TPL_CONTACT          numeric Brevo template ID for 04-contact-confirmation.html
//   BREVO_TPL_ORDER            numeric Brevo template ID for 05-order-confirmation.html
//   BREVO_TPL_ORDER_UPDATE     numeric Brevo template ID for 06-order-update.html
//   BREVO_TPL_SECURITY         numeric Brevo template ID for 07-security-alert.html
//   BREVO_TPL_ADMIN            numeric Brevo template ID for 08-admin-notification.html
// You get each numeric ID after uploading that template's HTML into Brevo
// (Campaigns/Templates → Transactional → Create a template → HTML editor →
// paste the file's contents → Save & activate). Putting the IDs in env
// vars — not hardcoded here — means re-creating a template in Brevo never
// needs a code change or redeploy, just an env var update.

const ALLOWED_ORIGINS = [
  "https://lexdendigital.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const TEMPLATE_ENV_KEY = {
  welcome: "BREVO_TPL_WELCOME",
  verify: "BREVO_TPL_VERIFY",
  reset: "BREVO_TPL_RESET",
  contact: "BREVO_TPL_CONTACT",
  order: "BREVO_TPL_ORDER",
  order_update: "BREVO_TPL_ORDER_UPDATE",
  security: "BREVO_TPL_SECURITY",
  admin: "BREVO_TPL_ADMIN",
};

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { templateKey, to, params, replyTo } = req.body || {};

  if (!templateKey || !TEMPLATE_ENV_KEY[templateKey]) {
    return res.status(400).json({ error: "Unknown or missing templateKey. Expected one of: " + Object.keys(TEMPLATE_ENV_KEY).join(", ") });
  }
  if (!to || !to.email) {
    return res.status(400).json({ error: "Missing to.email" });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error("BREVO_API_KEY is not set on this Vercel project");
    return res.status(500).json({ error: "Email service is not configured yet" });
  }

  const templateId = Number(process.env[TEMPLATE_ENV_KEY[templateKey]]);
  if (!templateId) {
    console.error(`${TEMPLATE_ENV_KEY[templateKey]} is not set on this Vercel project`);
    return res.status(500).json({ error: `Template "${templateKey}" has no Brevo template ID configured yet` });
  }

  const payload = {
    templateId,
    to: [{ email: to.email, name: to.name || undefined }],
    params: params || {},
    sender: {
      email: process.env.BREVO_SENDER_EMAIL || "lexdendigital@gmail.com",
      name: process.env.BREVO_SENDER_NAME || "LEXDEN NOVA",
    },
  };
  if (replyTo) payload.replyTo = { email: replyTo };

  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Brevo send failed", r.status, data);
      return res.status(502).json({ error: "Brevo rejected the send", detail: data });
    }
    return res.status(200).json({ ok: true, messageId: data.messageId });
  } catch (e) {
    console.error("Brevo send threw", e);
    return res.status(500).json({ error: "Could not reach Brevo" });
  }
};
