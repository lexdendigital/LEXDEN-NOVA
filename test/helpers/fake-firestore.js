// Minimal in-memory Firestore double: collection/doc get/set(merge)/add,
// where(==), limit, orderBy (ignored), runTransaction (serialised).
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v, (k, x) => (x && x._sentinel ? undefined : x))); }
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !v._methodName && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) && false) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}
function makeDb(seed = {}) {
  const store = {};
  for (const [c, docs] of Object.entries(seed)) for (const [id, d] of Object.entries(docs)) (store[c] = store[c] || {})[id] = clone(d);
  let auto = 0;
  const snapOf = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data) });
  const docRef = (c, id) => ({
    id,
    async get() { return snapOf(id, store[c] && store[c][id]); },
    async set(data, opts) {
      store[c] = store[c] || {};
      store[c][id] = opts && opts.merge ? merge(store[c][id] || {}, clone(data)) : clone(data);
    },
    async update(data) { store[c][id] = merge(store[c][id] || {}, clone(data)); },
    // create(): fails like Firestore if the doc already exists (gRPC code 6)
    async create(data) {
      if (store[c] && store[c][id] !== undefined) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      store[c] = store[c] || {}; store[c][id] = clone(data);
    },
  });
  const query = (c, filters = []) => ({
    where(f, op, v) { return query(c, [...filters, [f, v]]); },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      const docs = Object.entries(store[c] || {}).filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id, d]) => snapOf(id, d));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  return {
    _store: store,
    collection(c) {
      return { ...query(c), doc: (id) => docRef(c, id), async add(data) { const id = `auto${++auto}`; store[c] = store[c] || {}; store[c][id] = clone(data); return { id }; } };
    },
    // Firestore retries a contended transaction, so the net effect is serial
    // execution; model that with a queue.
    runTransaction(fn) {
      const run = async () => this._runTx(fn);
      const p = this._chain.then(run, run);
      this._chain = p.catch(() => {});
      return p;
    },
    // write batch: queued, applied in order on commit()
    batch() {
      const w = [];
      return {
        set: (ref, data, opts) => { w.push(() => ref.set(data, opts)); },
        update: (ref, data) => { w.push(() => ref.update(data)); },
        async commit() { for (const f of w) await f(); },
      };
    },
    _chain: Promise.resolve(),
    async _runTx(fn) {
      const tx = {
        get: (ref) => ref.get(),
        set: (ref, data, opts) => { tx._w.push(() => ref.set(data, opts)); },
        update: (ref, data) => { tx._w.push(() => ref.update(data)); },
        _w: [],
      };
      const r = await fn(tx);
      for (const w of tx._w) await w();
      return r;
    },
  };
}
module.exports = { makeDb };
