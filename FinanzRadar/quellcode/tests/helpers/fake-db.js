// In-Memory-Ersatz für die Dexie-Datenbank (store/db.js) und den App-Zustand (store/state.svelte.js).
// Genutzt von tests/importer-dedupe.test.js, tests/scenarios.test.js und scripts/score.mjs:
// so laufen der echte Importer (runImport → saveResult) und die echte Nachverarbeitung (postProcess) ohne Browser.

export const TABLE_NAMES = ['sources', 'files', 'blobs', 'documents', 'accounts', 'transactions', 'lineItems', 'contracts', 'holdings', 'valuations', 'assets', 'rules', 'settings'];

const clone = (v) => structuredClone(v);

function collection(rows, key, list) {
  const self = {
    toArray: async () => list().map(clone),
    primaryKeys: async () => list().map(r => r[key]),
    keys: async () => list().map(r => r[key]),
    count: async () => list().length,
    first: async () => (list()[0] ? clone(list()[0]) : undefined),
    each: async (fn) => { for (const r of list()) fn(clone(r)); },
    delete: async () => { const l = list(); for (const r of l) rows.delete(r[key]); return l.length; },
    modify: async (patch) => { const l = list(); for (const r of l) { if (typeof patch === 'function') patch(r); else Object.assign(r, clone(patch)); } return l.length; },
    filter: (fn) => collection(rows, key, () => list().filter(fn)),
    and: (fn) => collection(rows, key, () => list().filter(fn)),
    limit: (n) => collection(rows, key, () => list().slice(0, n)),
    sortBy: async (f) => list().map(clone).sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0)),
  };
  return self;
}

export function makeTable(key = 'id') {
  const rows = new Map();
  const all = () => [...rows.values()];
  const t = {
    rows,
    async get(k) { const r = rows.get(typeof k === 'object' && k ? k[key] : k); return r ? clone(r) : undefined; },
    async bulkGet(ks) { return ks.map(k => (rows.has(k) ? clone(rows.get(k)) : undefined)); },
    async put(r) { rows.set(r[key], clone(r)); return r[key]; },
    async add(r) { if (rows.has(r[key])) throw Object.assign(new Error('Key already exists'), { name: 'ConstraintError' }); rows.set(r[key], clone(r)); return r[key]; },
    async bulkPut(a) { for (const r of a) rows.set(r[key], clone(r)); },
    async bulkAdd(a) { for (const r of a) rows.set(r[key], clone(r)); },
    async delete(k) { rows.delete(k); },
    async bulkDelete(ids) { for (const i of ids) rows.delete(i); },
    async update(k, patch) { const r = rows.get(k); if (!r) return 0; Object.assign(r, clone(patch)); return 1; },
    async bulkUpdate(list) { let n = 0; for (const { key: k, changes } of list) { const r = rows.get(k); if (r) { Object.assign(r, clone(changes)); n++; } } return n; },
    async toArray() { return all().map(clone); },
    async count() { return rows.size; },
    async each(fn) { for (const r of all()) fn(clone(r)); },
    async clear() { rows.clear(); },
    toCollection() { return collection(rows, key, all); },
    filter(fn) { return collection(rows, key, () => all().filter(fn)); },
    orderBy(f) { return collection(rows, key, () => all().sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0))); },
    where(field) {
      const pick = (pred) => collection(rows, key, () => all().filter(r => pred(r[field])));
      return {
        equals: (v) => pick(x => x === v),
        notEqual: (v) => pick(x => x !== v),
        anyOf: (...vs) => { const s = new Set(vs.length === 1 && Array.isArray(vs[0]) ? vs[0] : vs); return pick(x => s.has(x)); },
        noneOf: (vs) => { const s = new Set(vs); return pick(x => !s.has(x)); },
        above: (v) => pick(x => x > v),
        below: (v) => pick(x => x < v),
        between: (a, b, incA = true, incB = false) => pick(x => (incA ? x >= a : x > a) && (incB ? x <= b : x < b)),
        startsWith: (p) => pick(x => typeof x === 'string' && x.startsWith(p)),
      };
    },
  };
  return t;
}

/** Fake-Datenbank mit allen Tabellen; transaction() führt die Funktion direkt aus (kein Rollback). */
export function makeFakeDb() {
  const db = {};
  for (const n of TABLE_NAMES) db[n] = makeTable(n === 'settings' ? 'key' : 'id');
  db.transaction = async (...args) => { const fn = args[args.length - 1]; return fn(); };
  db.tables = TABLE_NAMES.map(n => db[n]);
  db.reset = () => { for (const n of TABLE_NAMES) db[n].rows.clear(); };
  db.snapshot = () => Object.fromEntries(TABLE_NAMES.map(n => [n, [...db[n].rows.values()].map(clone)]));
  return db;
}

/** Ersatz für `app` aus state.svelte.js (nur was Importer/Nachverarbeitung anfassen) */
export function makeFakeApp() {
  return {
    ready: true, view: 'overview', data: {}, filter: {}, settings: {},
    progress: { running: false, paused: false, total: 0, done: 0, current: '', phase: '', errors: [], counts: {}, startedAt: 0, log: [], skipped: 0, newDocs: 0, newTx: 0 },
  };
}

/** Import-Item wie es die Quellen liefern */
export function fileItem(path, content, extra = {}) {
  const name = path.split('/').pop();
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { path, name, size: bytes.byteLength, mtime: extra.mtime ?? '2026-07-01T00:00:00.000Z', ext: name.split('.').pop().toLowerCase(), getFile: async () => new File([bytes], name) };
}
