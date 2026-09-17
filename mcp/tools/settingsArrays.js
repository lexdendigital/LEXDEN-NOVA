// mcp/tools/settingsArrays.js
//
// Services, Feed Posts, FAQs, Suppliers, and the "Meet the Team" list
// (part of App Content) are all the same shape in Firestore: an array of
// objects with an `id`, living under one key on catalog/settings. Rather
// than five near-identical copy-pasted tool sets, this registers one
// generic list/create/update/delete family per section with a name and
// description tailored to what that section actually is, so Claude still
// sees five clearly-labeled tool groups even though the implementation
// is shared.

const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { listSection, upsertSectionItem, deleteSectionItem } = require('../lib/settings');

const itemShape = z.object({ id: z.string() }).catchall(z.any());

const SECTIONS = [
  { key: 'services', label: 'service', tab: 'Services' },
  { key: 'feed', label: 'feed post', tab: 'Feed Posts' },
  { key: 'faqs', label: 'FAQ', tab: 'FAQs' },
  { key: 'suppliers', label: 'supplier', tab: 'Suppliers' },
  { key: 'management', label: 'team member', tab: 'App Content \u2192 Meet the Team' },
];

function register(server) {
  for (const { key, label, tab } of SECTIONS) {
    server.registerTool(`nova_list_${key}`, {
      title: `List ${label}s`,
      description: `Lists every ${label} from the "${tab}" admin tab (catalog/settings.${key}).`,
      inputSchema: {},
    }, async () => {
      const db = getDb();
      const list = await listSection(db, key);
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    });

    server.registerTool(`nova_create_${key.replace(/s$/, '')}`, {
      title: `Create ${label}`,
      description: `Adds a new ${label} to the "${tab}" tab. id must not already exist.`,
      inputSchema: { item: itemShape },
    }, async ({ item }) => {
      const db = getDb();
      const saved = await upsertSectionItem(db, key, item, { isNew: true });
      return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
    });

    server.registerTool(`nova_update_${key.replace(/s$/, '')}`, {
      title: `Update ${label}`,
      description: `Shallow-merges the given fields into an existing ${label} (by id) in the "${tab}" tab.`,
      inputSchema: { item: itemShape },
    }, async ({ item }) => {
      const db = getDb();
      const saved = await upsertSectionItem(db, key, item, { isNew: false });
      return { content: [{ type: 'text', text: JSON.stringify(saved, null, 2) }] };
    });

    server.registerTool(`nova_delete_${key.replace(/s$/, '')}`, {
      title: `Delete ${label}`,
      description: `Permanently removes a ${label} from the "${tab}" tab. Requires confirm: true.`,
      inputSchema: { id: z.string(), confirm: z.literal(true) },
    }, async ({ id }) => {
      const db = getDb();
      await deleteSectionItem(db, key, id);
      return { content: [{ type: 'text', text: `Deleted ${label} ${id}.` }] };
    });
  }
}

module.exports = { register };
