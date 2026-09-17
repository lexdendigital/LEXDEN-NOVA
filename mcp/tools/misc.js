// mcp/tools/misc.js — Dashboard, Error Codes, Export, and the MCP audit log.
//
// Two honesty notes (found by actually reading index.html rather than
// trusting the README's tab list at face value):
//
//   - "Error Codes" (adminErrorCodes()) reads a hardcoded ERROR_CODES
//     object baked into the client bundle — it is never stored in
//     Firestore. There is no live source to read here, so ERROR_CODES is
//     mirrored below as a static reference. If you ever add/change a
//     code in index.html, update the copy here too — see MCP-SETUP.md.
//   - "Logs" (adminLogs()) reads a browser localStorage activity log —
//     that data never leaves the admin's own device/browser, so it is
//     structurally impossible for a server-side MCP tool to read it.
//     nova_get_audit_log below is a genuinely server-side substitute (it
//     shows what Claude itself has done through MCP), not a copy of that
//     tab — that distinction is called out in the tool description so it
//     isn't mistaken for the same thing.

const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { listCatalogDoc, getSettingsDoc } = require('../lib/settings');
const { listAuditEntries } = require('../lib/audit');

// Mirrored from index.html's ERROR_CODES constant (~line 4651) as of the
// MCP update — see the file-level note above.
const ERROR_CODES = {
  E01: 'Image upload failed — usually a Cloudinary preset/config issue or the file exceeded the size limit.',
  E02: 'Cloud save failed — Firestore rejected the write (see permission-denied guidance) or the connection dropped mid-save.',
  E03: 'Payment verification failed — Paystack confirmed the charge but the server-side verify call did not match it.',
  E04: 'CJ Dropshipping order creation failed after successful payment — the customer was charged but fulfilment needs manual follow-up.',
};

function register(server) {
  server.registerTool('nova_get_dashboard', {
    title: 'Admin dashboard summary',
    description: 'The server-side numbers behind the Dashboard tab: product/category/review counts, products missing an image or category, and draft product count. (Cloud-sync status and the on-device activity log shown in the app itself are client-only and not reproduced here — see nova_get_audit_log for the MCP-side equivalent of recent activity.)',
    inputSchema: {},
  }, async () => {
    const db = getDb();
    const [products, categories, reviewsSnap, affiliatesSnap, pendingWithdrawalsSnap] = await Promise.all([
      listCatalogDoc(db, 'products'),
      listCatalogDoc(db, 'categories'),
      db.collection('reviews').count().get(),
      db.collection('affiliates').count().get(),
      db.collection('affiliateWithdrawals').where('status', '==', 'pending').count().get(),
    ]);
    const summary = {
      totalProducts: products.length,
      totalCategories: categories.length,
      totalReviews: reviewsSnap.data().count,
      productsMissingImage: products.filter((p) => !p.image && !(Array.isArray(p.images) && p.images.length)).length,
      productsMissingCategory: products.filter((p) => !p.category && !p.categoryId).length,
      draftProducts: products.filter((p) => p.status === 'draft').length,
      totalAffiliates: affiliatesSnap.data().count,
      pendingWithdrawals: pendingWithdrawalsSnap.data().count,
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  });

  server.registerTool('nova_search_error_codes', {
    title: 'Look up an app error code',
    description: 'Looks up what an error code shown in the app (e.g. "E01") actually means, for troubleshooting a support message. This is a static reference mirrored from index.html\'s ERROR_CODES constant, not a live Firestore read — see this tool file\'s header comment if codes are ever added/changed in the app.',
    inputSchema: { code: z.string().optional().describe('e.g. "E01". Omit to list every known code.') },
  }, async ({ code }) => {
    if (!code) return { content: [{ type: 'text', text: JSON.stringify(ERROR_CODES, null, 2) }] };
    const key = code.toUpperCase();
    const message = ERROR_CODES[key];
    return { content: [{ type: 'text', text: message ? `${key}: ${message}` : `No known error code "${code}".` }] };
  });

  server.registerTool('nova_export_data', {
    title: 'Export full store data',
    description: 'A server-side equivalent of the Export tab\'s JSON download: products, categories, and the full settings document (content/services/feed/faqs/suppliers/management) in one snapshot, read fresh from Firestore.',
    inputSchema: {},
  }, async () => {
    const db = getDb();
    const [products, categories, settings] = await Promise.all([
      listCatalogDoc(db, 'products'),
      listCatalogDoc(db, 'categories'),
      getSettingsDoc(db),
    ]);
    const payload = { products, categories, ...settings, exportedAt: new Date().toISOString() };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  });

  server.registerTool('nova_get_audit_log', {
    title: 'MCP audit log',
    description: 'Every action Claude has taken through this MCP connection — tool name, arguments (secrets redacted), success/failure, and timing. This is NOT the same as the admin portal\'s own "Logs" tab, which reads a browser-only activity log that never reaches this server; this is specifically a record of MCP activity.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
  }, async ({ limit }) => {
    const list = await listAuditEntries({ limit });
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  });
}

module.exports = { register };
