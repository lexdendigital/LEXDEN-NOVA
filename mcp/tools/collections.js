// mcp/tools/collections.js — Messages, Newsletter, Users, Reviews tabs.
// Each of these is a plain Firestore collection (not nested inside
// catalog/settings), confirmed by reading their admin*() functions in
// index.html. Users is intentionally read-only here — there is no admin
// action to edit or delete a shopper account anywhere in the existing
// app, so this doesn't invent one.

const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');

async function listCollection(db, name, { limit = 50, orderByField } = {}) {
  let q = db.collection(name);
  if (orderByField) q = q.orderBy(orderByField, 'desc');
  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function register(server) {
  // ---- Messages ("Contact Us" submissions -> `leads`) ----
  server.registerTool('nova_list_messages', {
    title: 'List contact messages',
    description: 'Lists shopper messages sent through "Contact Us" (the `leads` collection).',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
  }, async ({ limit }) => {
    const list = await listCollection(getDb(), 'leads', { limit });
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  });

  server.registerTool('nova_set_message_note', {
    title: 'Set a private admin note on a message',
    description: 'Sets (overwrites) the private admin note on one contact message — same field the "Messages" tab\'s note box saves.',
    inputSchema: { id: z.string(), note: z.string() },
  }, async ({ id, note }) => {
    await getDb().collection('leads').doc(id).set({ note }, { merge: true });
    return { content: [{ type: 'text', text: 'Saved.' }] };
  });

  server.registerTool('nova_delete_message', {
    title: 'Delete a contact message',
    description: 'Permanently deletes one message from the `leads` collection. Requires confirm: true.',
    inputSchema: { id: z.string(), confirm: z.literal(true) },
  }, async ({ id }) => {
    await getDb().collection('leads').doc(id).delete();
    return { content: [{ type: 'text', text: `Deleted message ${id}.` }] };
  });

  // ---- Newsletter subscribers ----
  server.registerTool('nova_list_newsletter_subscribers', {
    title: 'List newsletter subscribers',
    description: 'Lists everyone who joined through the "Stay in the loop" popup (the `newsletterSubs` collection).',
    inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
  }, async ({ limit }) => {
    const list = await listCollection(getDb(), 'newsletterSubs', { limit });
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
  });

  server.registerTool('nova_delete_newsletter_subscriber', {
    title: 'Delete a newsletter subscriber',
    description: 'Permanently removes one subscriber from `newsletterSubs`. Requires confirm: true.',
    inputSchema: { id: z.string(), confirm: z.literal(true) },
  }, async ({ id }) => {
    await getDb().collection('newsletterSubs').doc(id).delete();
    return { content: [{ type: 'text', text: `Deleted subscriber ${id}.` }] };
  });

  // ---- Users (read-only — no admin edit/delete action exists in the app) ----
  server.registerTool('nova_list_users', {
    title: 'List shopper accounts',
    description: 'Lists shopper accounts from the `users` collection (email, name, sign-up provider, createdAt). Read-only — the admin portal has no user-edit or delete action, so this tool doesn\'t add one. Never exposes passwords (Firebase never stores or exposes them to anyone, including here).',
    inputSchema: { limit: z.number().int().min(1).max(500).default(100), search: z.string().optional().describe('Matches against email or name.') },
  }, async ({ limit, search }) => {
    let list = await listCollection(getDb(), 'users', { limit: 500 });
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) => (u.email || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q));
    }
    return { content: [{ type: 'text', text: JSON.stringify(list.slice(0, limit), null, 2) }] };
  });

  // ---- Reviews (shopper-submitted product reviews) ----
  server.registerTool('nova_list_reviews', {
    title: 'List product reviews',
    description: 'Lists shopper-submitted reviews from the `reviews` collection, optionally filtered to one product.',
    inputSchema: { productId: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  }, async ({ productId, limit }) => {
    let list = await listCollection(getDb(), 'reviews', { limit: 500 });
    if (productId) list = list.filter((r) => r.productId === productId);
    return { content: [{ type: 'text', text: JSON.stringify(list.slice(0, limit), null, 2) }] };
  });

  server.registerTool('nova_delete_review', {
    title: 'Delete a review',
    description: 'Permanently deletes one review. This is the only moderation action the admin portal itself offers for reviews (there is no approve/hide status field). Requires confirm: true.',
    inputSchema: { id: z.string(), confirm: z.literal(true) },
  }, async ({ id }) => {
    await getDb().collection('reviews').doc(id).delete();
    return { content: [{ type: 'text', text: `Deleted review ${id}.` }] };
  });
}

module.exports = { register };
