// Minimal in-memory Firestore double: collection/doc get/set(merge)/add,
// common where operators, limit/orderBy, runTransaction (serialised).
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
  const snapOf = (id, data, ref) => ({ id, exists: data !== undefined, data: () => clone(data), ref });
  const docRef = (c, id) => ({
    id,
    async get() { return snapOf(id, store[c] && store[c][id], docRef(c, id)); },
    async set(data, opts) {
      store[c] = store[c] || {};
      store[c][id] = opts && opts.merge ? merge(store[c][id] || {}, clone(data)) : clone(data);
    },
    async update(data) { store[c][id] = merge(store[c][id] || {}, clone(data)); },
    async delete() { if (store[c]) delete store[c][id]; },
    // create(): fails like Firestore if the doc already exists (gRPC code 6)
    async create(data) {
      if (store[c] && store[c][id] !== undefined) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      store[c] = store[c] || {}; store[c][id] = clone(data);
    },
  });
  function scalar(v) {
    if (v && typeof v.toMillis === 'function') return v.toMillis();
    if (v instanceof Date) return v.getTime();
    return v;
  }
  function matches(actual, op, expected) {
    const a = scalar(actual), b = scalar(expected);
    if (op === '==') return a === b;
    if (op === '<=') return a <= b;
    if (op === '<') return a < b;
    if (op === '>=') return a >= b;
    if (op === '>') return a > b;
    if (op === 'in') return Array.isArray(expected) && expected.map(scalar).includes(a);
    throw new Error('fake-firestore unsupported operator: ' + op);
  }
  const query = (c, filters = [], orders = [], max = null) => ({
    where(f, op, v) { return query(c, [...filters, [f, op, v]], orders, max); },
    orderBy(f, direction = 'asc') { return query(c, filters, [...orders, [f, direction]], max); },
    limit(n) { return query(c, filters, orders, n); },
    async get() {
      let rows = Object.entries(store[c] || {}).filter(([, d]) => filters.every(([f, op, v]) => matches(d[f], op, v)));
      if (orders.length) rows.sort(([, a], [, b]) => {
        for (const [f, direction] of orders) {
          const av = scalar(a[f]), bv = scalar(b[f]);
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return String(direction).toLowerCase() === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
      if (max != null) rows = rows.slice(0, max);
      const docs = rows.map(([id, d]) => snapOf(id, d, docRef(c, id)));
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
