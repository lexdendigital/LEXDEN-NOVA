// A fuller in-memory Firestore double than fake-firestore.js, built for the
// money / inventory tests:
//   * FieldValue.increment / serverTimestamp / delete are understood (install()).
//   * where() supports ==, !=, <, <=, >, >=, in, array-contains; limit() is honoured.
//   * Transactions are serialised (Firestore retries contended transactions, so the
//     net effect is serial execution) and writes are applied only on success, so a
//     thrown error inside a transaction leaves NO partial write.
//   * create() / tx.create() fail with gRPC code 6 when the doc exists.
const { FieldValue } = require('firebase-admin/firestore');

const orig = { increment: FieldValue.increment, serverTimestamp: FieldValue.serverTimestamp, delete: FieldValue.delete };
function install() {
  FieldValue.increment = (n) => ({ __inc: n });
  FieldValue.serverTimestamp = () => ({ __ts: true });
  FieldValue.delete = () => ({ __del: true });
}
function restore() { Object.assign(FieldValue, orig); }

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function applyData(prev, data, merge) {
  const base = merge ? { ...(prev || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && v.__inc !== undefined) base[k] = (Number(base[k]) || 0) + v.__inc;
    else if (v && typeof v === 'object' && v.__ts) base[k] = Date.now();
    else if (v && typeof v === 'object' && v.__del) delete base[k];
    else if (merge && v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && !('__inc' in v)) base[k] = applyData(base[k], v, true);
    else base[k] = clone(v);
  }
  return base;
}

function makeDb(seed = {}) {
  const store = {};
  for (const [c, docs] of Object.entries(seed)) for (const [id, d] of Object.entries(docs)) (store[c] = store[c] || {})[id] = clone(d);
  let auto = 0;
  const snapOf = (c, id) => { const d = store[c] && store[c][id]; return { id, exists: d !== undefined, data: () => clone(d), ref: refOf(c, id) }; };
  const refOf = (c, id) => ({
    id, path: `${c}/${id}`, _c: c,
    async get() { return snapOf(c, id); },
    async set(data, opts) { store[c] = store[c] || {}; store[c][id] = applyData(store[c][id], data, !!(opts && opts.merge)); },
    async update(data) {
      if (!store[c] || store[c][id] === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      store[c][id] = applyData(store[c][id], data, true);
    },
    async create(data) {
      if (store[c] && store[c][id] !== undefined) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      store[c] = store[c] || {}; store[c][id] = applyData({}, data, false);
    },
    async delete() { if (store[c]) delete store[c][id]; },
  });
  const ops = {
    '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
    '>': (a, b) => a > b, '>=': (a, b) => a >= b, in: (a, b) => b.includes(a),
    'array-contains': (a, b) => Array.isArray(a) && a.includes(b),
  };
  const query = (c, filters = [], lim = Infinity, order = null) => ({
    where(f, op, v) { return query(c, [...filters, [f, op, v]], lim, order); },
    orderBy(f, dir) { return query(c, filters, lim, [f, dir || 'asc']); },
    limit(n) { return query(c, filters, n, order); },
    async get() {
      let docs = Object.entries(store[c] || {}).filter(([, d]) => filters.every(([f, op, v]) => ops[op](d[f], v)));
      if (order) docs = docs.sort((a, b) => { const x = a[1][order[0]], y = b[1][order[0]]; return (x > y ? 1 : x < y ? -1 : 0) * (order[1] === 'desc' ? -1 : 1); });
      docs = docs.slice(0, lim).map(([id]) => snapOf(c, id));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db = {
    _store: store,
    collection(c) {
      return { ...query(c), doc: (id) => refOf(c, id || `auto${++auto}`), async add(data) { const id = `auto${++auto}`; store[c] = store[c] || {}; store[c][id] = applyData({}, data, false); return { id }; } };
    },
    _chain: Promise.resolve(),
    runTransaction(fn) {
      const run = async () => {
        const writes = [];
        const tx = {
          get: async (refOrQuery) => (refOrQuery.get ? refOrQuery.get() : refOrQuery),
          set: (ref, data, opts) => { writes.push(() => ref.set(data, opts)); },
          update: (ref, data) => { writes.push(() => ref.update(data)); },
          create: (ref, data) => { writes.push(() => ref.create(data)); },
          delete: (ref) => { writes.push(() => ref.delete()); },
        };
        const r = await fn(tx);
        for (const w of writes) await w();
        return r;
      };
      const p = db._chain.then(run, run);
      db._chain = p.catch(() => {});
      return p;
    },
    batch() {
      const w = [];
      return {
        set: (ref, data, opts) => { w.push(() => ref.set(data, opts)); },
        update: (ref, data) => { w.push(() => ref.update(data)); },
        create: (ref, data) => { w.push(() => ref.create(data)); },
        delete: (ref) => { w.push(() => ref.delete()); },
        async commit() { for (const f of w) await f(); },
      };
    },
  };
  return db;
}

module.exports = { makeDb, install, restore };
