// mcp/tools/content.js
//
// Confirmed by reading adminBranding(), adminAI(), adminPayments(), and
// adminSocial() in index.html: all four of those admin tabs, plus "App
// Content", read and write the SAME catalog/settings.content map — just
// different subsets of its keys. There is no separate document per tab.
// So this is one get/update tool pair, not four — nova_update_content
// only ever touches the specific keys you pass it (see updateContent()
// in mcp/lib/settings.js), so using it for a Branding change can't
// accidentally disturb a Payments field sitting in the same object.
//
// Secrets (PAYSTACK_SECRET_KEY, Gemini/NOVA AI API keys) live in server
// env vars, never in this document — nothing here can read or leak them.

const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { getContent, updateContent } = require('../lib/settings');

function register(server) {
  server.registerTool('nova_get_content', {
    title: 'Get app content settings',
    description: 'Reads catalog/settings.content — covers App Content, Branding & Currency, Social & Contact, NOVA AI Setup, and Payments (public key / verify endpoint only, never the secret key). Pass no filter to get everything, or a list of keys to get just those.',
    inputSchema: { keys: z.array(z.string()).optional().describe('e.g. ["heroTitle","paystackPublicKey"] — omit for the full content object.') },
  }, async ({ keys }) => {
    const db = getDb();
    const content = await getContent(db);
    const result = keys && keys.length ? Object.fromEntries(keys.map((k) => [k, content[k]])) : content;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('nova_update_content', {
    title: 'Update app content settings',
    description: 'Merges the given key/value pairs into catalog/settings.content — only the keys you send are changed, everything else is left exactly as it was. Use this for App Content (hero text, about page), Branding & Currency, Social & Contact links, NOVA AI Setup (e.g. novaMode), and Payments (paystackPublicKey, paymentVerifyEndpoint — never send a secret key here, this field is public-facing).',
    inputSchema: { patch: z.record(z.any()).describe('e.g. {"heroTitle": "New headline", "instagramUrl": "https://instagram.com/..."}') },
  }, async ({ patch }) => {
    if (Object.keys(patch).some((k) => /secret/i.test(k))) {
      throw Object.assign(new Error('Refusing to write a field containing "secret" — those belong in server environment variables, not this public settings document.'), { status: 400 });
    }
    const db = getDb();
    const updated = await updateContent(db, patch);
    return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
  });
}

module.exports = { register };
