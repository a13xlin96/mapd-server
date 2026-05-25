// In-process Firestore stand-in for tests that need a live(-ish) firestore —
// covers the surface used by enrich.js + lib/enrichmentSweeper.js: collection
// + doc + where (==, <, >) + get + set/update + runTransaction, plus the
// FieldValue and Timestamp helpers from the admin SDK.

const SENTINEL = Symbol('FakeFieldValue');

class FakeTimestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  static now() { return new FakeTimestamp(Date.now()); }
}

const FieldValue = {
  serverTimestamp: () => ({ [SENTINEL]: 'serverTimestamp' }),
  increment: (n) => ({ [SENTINEL]: 'increment', n }),
  arrayUnion: (...items) => ({ [SENTINEL]: 'arrayUnion', items }),
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

function resolveValue(v, nowMs, currentValue) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof FakeTimestamp) return v;
  if (v[SENTINEL] === 'serverTimestamp') return new FakeTimestamp(nowMs);
  if (v[SENTINEL] === 'increment') {
    const prev = typeof currentValue === 'number' ? currentValue : 0;
    return prev + v.n;
  }
  if (v[SENTINEL] === 'arrayUnion') {
    const prev = Array.isArray(currentValue) ? currentValue : [];
    const next = [...prev];
    for (const item of v.items) {
      if (!next.some((x) => deepEqual(x, item))) next.push(item);
    }
    return next;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, nowMs, undefined));
  // Plain nested object — recurse so a serverTimestamp sentinel inside (e.g.
  // pushDelivery.lastAttemptAt) resolves to a real FakeTimestamp.
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = resolveValue(val, nowMs, currentValue && currentValue[k]);
  }
  return out;
}

function applyMergeOps(current, update, nowMs) {
  const merged = current ? { ...current } : {};
  for (const [k, v] of Object.entries(update)) {
    merged[k] = resolveValue(v, nowMs, merged[k]);
  }
  return merged;
}

function compareNumeric(v, op, value) {
  if (v === undefined || v === null) return false;
  const left = typeof v.toMillis === 'function' ? v.toMillis() : v;
  const right = typeof value.toMillis === 'function' ? value.toMillis() : value;
  if (op === '<') return left < right;
  if (op === '>') return left > right;
  if (op === '<=') return left <= right;
  if (op === '>=') return left >= right;
  throw new Error(`compareNumeric: unsupported op ${op}`);
}

function valuesMatch(v, op, value) {
  if (op === '==') return v === value;
  return compareNumeric(v, op, value);
}

class FakeDocRef {
  constructor(store, collection, id) {
    this.store = store;
    this.collection = collection;
    this.id = id;
  }
  async set(data, options = {}) { return this._setSync(data, options); }
  async update(data) { return this._setSync(data, { merge: true }); }
  _setSync(data, options = {}) {
    const failure = this.store.shouldFailWrite(this.collection, this.id);
    if (failure) throw failure;
    if (!this.store.collections.has(this.collection)) {
      this.store.collections.set(this.collection, new Map());
    }
    const map = this.store.collections.get(this.collection);
    const current = options.merge ? map.get(this.id) : undefined;
    map.set(this.id, applyMergeOps(current, data, this.store.now()));
  }
  async get() {
    const map = this.store.collections.get(this.collection) || new Map();
    const data = map.get(this.id);
    return makeDocSnap(this.store, this.collection, this.id, data);
  }
}

function makeDocSnap(store, collection, id, data) {
  return {
    id,
    exists: data !== undefined,
    data: () => data,
    ref: new FakeDocRef(store, collection, id),
  };
}

class FakeCollection {
  constructor(store, name, opts = {}) {
    this.store = store;
    this.name = name;
    this.filters = opts.filters || [];
    this.orderField = opts.orderField || null;  // '__name__' = sort by doc id
    this.orderDir = opts.orderDir || 'asc';
    this.limitN = opts.limitN || null;
    this.startAfterId = opts.startAfterId || null;
  }
  _clone(overrides) {
    return new FakeCollection(this.store, this.name, {
      filters: this.filters,
      orderField: this.orderField,
      orderDir: this.orderDir,
      limitN: this.limitN,
      startAfterId: this.startAfterId,
      ...overrides,
    });
  }
  doc(id) {
    const docId = id === undefined ? this.store.nextDocId() : id;
    return new FakeDocRef(this.store, this.name, docId);
  }
  where(field, op, value) {
    return this._clone({ filters: [...this.filters, { field, op, value }] });
  }
  orderBy(field, direction = 'asc') {
    return this._clone({ orderField: field, orderDir: direction });
  }
  limit(n) {
    return this._clone({ limitN: n });
  }
  startAfter(snapOrValue) {
    // Backfill calls startAfter(docSnap). If the caller passes a snapshot we
    // pick up its id; if they pass a raw value, fall back to that as the id.
    const id = snapOrValue && typeof snapOrValue === 'object' && snapOrValue.id
      ? snapOrValue.id
      : snapOrValue;
    return this._clone({ startAfterId: id });
  }
  async get() {
    const map = this.store.collections.get(this.name) || new Map();
    let entries = [...map.entries()]
      .filter(([, data]) => this.filters.every((f) => valuesMatch(data[f.field], f.op, f.value)));

    if (this.orderField) {
      entries.sort(([idA, a], [idB, b]) => {
        const av = this.orderField === '__name__' ? idA : a[this.orderField];
        const bv = this.orderField === '__name__' ? idB : b[this.orderField];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderDir === 'desc' ? -cmp : cmp;
      });
    }

    if (this.startAfterId !== null) {
      // Real Firestore's startAfter is a lexicographic (or value-based)
      // boundary — it doesn't require the cursor doc to exist. Filter by
      // strict-greater so a deleted cursor still advances pagination
      // correctly. Only ordered queries can have a cursor.
      entries = entries.filter(([id, data]) => {
        const fieldVal = this.orderField === '__name__' ? id : data && data[this.orderField];
        return fieldVal > this.startAfterId;
      });
    }

    if (this.limitN !== null) entries = entries.slice(0, this.limitN);

    const docs = entries.map(([id, data]) => makeDocSnap(this.store, this.name, id, data));
    return { empty: docs.length === 0, docs, size: docs.length };
  }
}

class FakeFirestore {
  constructor() {
    this.collections = new Map();
    this.nowFn = () => Date.now();
    this._txnReadHook = null;
    this._writeFailure = null;
    this._txnQueue = Promise.resolve();
    this._docIdCounter = 0;
  }
  reset() {
    this.collections = new Map();
    this.nowFn = () => Date.now();
    this._txnReadHook = null;
    this._writeFailure = null;
    this._txnQueue = Promise.resolve();
    this._docIdCounter = 0;
  }
  // Generates monotonic IDs for `.doc()` calls without an explicit id,
  // mirroring Firestore's auto-id behavior just well enough for tests.
  nextDocId() {
    this._docIdCounter += 1;
    return `auto_${this._docIdCounter}_${this.nowFn()}`;
  }
  // Predicate-based write failure injection: tests pass a fn
  // (collection, id) => Error|null and any matching write throws.
  setWriteFailure(predicate) { this._writeFailure = predicate; }
  shouldFailWrite(collection, id) {
    return this._writeFailure ? this._writeFailure(collection, id) : null;
  }
  setNow(fn) { this.nowFn = fn; }
  now() { return this.nowFn(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return new FakeCollection(this, name);
  }
  seed(collection, id, data) {
    if (!this.collections.has(collection)) this.collections.set(collection, new Map());
    this.collections.get(collection).set(id, { ...data });
  }
  read(collection, id) {
    const map = this.collections.get(collection);
    return map ? map.get(id) : undefined;
  }
  async runTransaction(fn) {
    // Serialize transactions to simulate Firestore's atomicity guarantee.
    // Real Firestore uses optimistic concurrency with retries; the
    // observable end-state for tests is identical: concurrent calls
    // converge to one winner.
    const prev = this._txnQueue;
    let release;
    this._txnQueue = new Promise((r) => { release = r; });
    await prev;
    try {
      const txn = {
        get: async (ref) => {
          if (this._txnReadHook) await this._txnReadHook(ref);
          return ref.get();
        },
        set: (ref, data, options) => ref._setSync(data, options || {}),
        update: (ref, data) => ref._setSync(data, { merge: true }),
      };
      return await fn(txn);
    } finally {
      release();
    }
  }
  setTxnReadHook(hook) { this._txnReadHook = hook; }
}

let shared = null;
function getSharedFirestore() {
  if (!shared) shared = new FakeFirestore();
  return shared;
}

function makeAdmin() {
  return {
    firestore: {
      FieldValue,
      Timestamp: FakeTimestamp,
    },
  };
}

module.exports = {
  FakeFirestore,
  FakeTimestamp,
  FieldValue,
  makeAdmin,
  getSharedFirestore,
};
