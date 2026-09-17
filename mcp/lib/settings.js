// mcp/lib/settings.js
//
// index.html's own admin screens always resave catalog/settings as one
// giant setDoc() of { content, services, feed, management, faqs,
// suppliers } together (see pushSettingsToCloud() around line ~2412) —
// fine for a human editing in a browser tab where the whole document is
// already loaded in memory, but wrong for a tool call that only touches
// one field: two admin tabs saved seconds apart could clobber each
// other's change. Every helper here instead does a *targeted* write —
// either a transaction that only replaces one named array, or a native
// Firestore dot-path update() that only touches the specific leaf keys
// changed — so an MCP write can never wipe out an unrelated setting.

const SECTIONS = new Set(['services', 'feed', 'faqs', 'suppliers', 'management']);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getSettingsDoc(db) {
  const snap = await db.doc('catalog/settings').get();
  return snap.exists ? snap.data() : {};
}

async function getContent(db) {
  const data = await getSettingsDoc(db);
  return data.content || {};
}

// Only touches the keys present in `patch` — e.g. { heroTitle: 'x' }
// leaves paystackPublicKey, novaMode, every other content.* key untouched.
async function updateContent(db, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw httpError(400, 'patch must be an object of content field -> new value.');
  }
  const entries = Object.entries(patch);
  if (!entries.length) throw httpError(400, 'patch is empty — nothing to update.');
  const dotted = {};
  for (const [k, v] of entries) dotted[`content.${k}`] = v;
  await db.doc('catalog/settings').set({}, { merge: true }); // ensures the doc exists before update()
  await db.doc('catalog/settings').update(dotted);
  return getContent(db);
}

function assertSection(section) {
  if (!SECTIONS.has(section)) {
    throw httpError(400, `Unknown section "${section}". Must be one of: ${[...SECTIONS].join(', ')}.`);
  }
}

async function listSection(db, section) {
  assertSection(section);
  const data = await getSettingsDoc(db);
  return Array.isArray(data[section]) ? data[section] : [];
}

// isNew=true rejects a duplicate id (create); isNew=false requires the id
// to already exist (update, shallow-merged into the existing item).
async function upsertSectionItem(db, section, item, { isNew }) {
  assertSection(section);
  if (!item || !item.id) throw httpError(400, 'item.id is required.');
  const ref = db.doc('catalog/settings');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const list = Array.isArray(data[section]) ? data[section].slice() : [];
    const idx = list.findIndex((x) => x.id === item.id);
    if (isNew) {
      if (idx !== -1) throw httpError(409, `An item with id "${item.id}" already exists in ${section}.`);
      list.push(item);
    } else {
      if (idx === -1) throw httpError(404, `No item with id "${item.id}" in ${section}.`);
      list[idx] = { ...list[idx], ...item };
    }
    tx.set(ref, { [section]: list }, { merge: true });
    return list.find((x) => x.id === item.id);
  });
}

async function deleteSectionItem(db, section, id) {
  assertSection(section);
  const ref = db.doc('catalog/settings');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const list = Array.isArray(data[section]) ? data[section] : [];
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) throw httpError(404, `No item with id "${id}" in ${section}.`);
    tx.set(ref, { [section]: next }, { merge: true });
    return { ok: true };
  });
}

// ---- catalog/products and catalog/categories: same "list inside one doc"
// shape as the settings sections above, just their own top-level docs.
async function listCatalogDoc(db, docName) {
  const snap = await db.doc(`catalog/${docName}`).get();
  const data = snap.exists ? snap.data() : {};
  return Array.isArray(data.list) ? data.list : [];
}

async function upsertCatalogItem(db, docName, item, { isNew }) {
  if (!item || !item.id) throw httpError(400, 'item.id is required.');
  const ref = db.doc(`catalog/${docName}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const list = Array.isArray(data.list) ? data.list.slice() : [];
    const idx = list.findIndex((x) => x.id === item.id);
    if (isNew) {
      if (idx !== -1) throw httpError(409, `An item with id "${item.id}" already exists.`);
      list.push(item);
    } else {
      if (idx === -1) throw httpError(404, `No item with id "${item.id}".`);
      list[idx] = { ...list[idx], ...item };
    }
    tx.set(ref, { list }, { merge: true });
    return list.find((x) => x.id === item.id);
  });
}

async function deleteCatalogItem(db, docName, id) {
  const ref = db.doc(`catalog/${docName}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const list = Array.isArray(data.list) ? data.list : [];
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) throw httpError(404, `No item with id "${id}".`);
    tx.set(ref, { list: next }, { merge: true });
    return { ok: true };
  });
}

module.exports = {
  httpError,
  getSettingsDoc, getContent, updateContent,
  listSection, upsertSectionItem, deleteSectionItem,
  listCatalogDoc, upsertCatalogItem, deleteCatalogItem,
};
