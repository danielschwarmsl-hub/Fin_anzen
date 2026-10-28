// Zentraler, reaktiver App-State (Svelte 5 Runes)
import { db, loadAll, getSetting, setSetting, wipeAll } from './db.js';
import { computeInsights } from '../analyze/insights.js';
import { buildIndex } from './search.js';

const today = new Date().toISOString().slice(0, 10);

export const app = $state({
  ready: false,
  view: 'overview',
  params: {},
  data: { sources: [], files: [], documents: [], accounts: [], transactions: [], lineItems: [], contracts: [], holdings: [], valuations: [], assets: [], rules: [] },
  filter: { from: null, to: null, preset: 'all', accountIds: [] },
  progress: { running: false, paused: false, total: 0, done: 0, current: '', phase: '', errors: [], counts: {}, startedAt: 0, log: [] },
  settings: { theme: 'auto', showTaxes: true, onboarded: false, dropboxAppKey: '', gdriveClientId: '', ai: { enabled: false, model: '', visionModel: '', think: false, url: 'http://localhost:11434' } },
  toasts: [],
  searchOpen: false,
  dataVersion: 0,
});

/** Nur die Tabellen, die computeInsights braucht – ohne die (großen) Volltexte der Dokumente */
function insightData() {
  const d = app.data;
  return $state.snapshot({
    accounts: d.accounts, transactions: d.transactions, contracts: d.contracts, holdings: d.holdings, valuations: d.valuations, assets: d.assets,
    documents: d.documents.map(({ text, ...rest }) => rest),
  });
}

let _insights = $derived.by(() => {
  // dataVersion als Abhängigkeit, damit nach reload() neu gerechnet wird
  void app.dataVersion;
  const { from, to } = effectiveRange();
  try {
    return computeInsights(insightData(), { from, to, accountIds: app.filter.accountIds, showTaxes: app.settings.showTaxes });
  } catch (e) {
    console.error('insights', e);
    return null;
  }
});
export const live = {
  get insights() { return _insights; },
};

/** Zeitraum aus Preset oder freiem Bereich */
export function effectiveRange() {
  const f = app.filter;
  if (f.preset === 'custom') return { from: f.from, to: f.to };
  const dates = app.data.transactions.map(t => t.bookingDate).filter(Boolean).sort();
  const last = dates.at(-1) || today;
  const first = dates[0] || last;
  const y = last.slice(0, 4);
  switch (f.preset) {
    case 'month': return { from: last.slice(0, 7) + '-01', to: last };
    case '3m': return { from: shiftMonths(last, -2).slice(0, 7) + '-01', to: last };
    case '12m': return { from: shiftMonths(last, -11).slice(0, 7) + '-01', to: last };
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'lastyear': return { from: `${Number(y) - 1}-01-01`, to: `${Number(y) - 1}-12-31` };
    default: return { from: first, to: last };
  }
}
function shiftMonths(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }

export async function init() {
  const s = await getSetting('settings', null);
  if (s) Object.assign(app.settings, s, { ai: { ...app.settings.ai, ...(s.ai || {}) } });
  applyTheme();
  await reload();
  if (!app.data.files.length) app.view = 'start';
  app.ready = true;
}

export async function reload() {
  const all = await loadAll();
  for (const k of Object.keys(all)) app.data[k] = all[k];
  await buildIndex(all); // in Häppchen, die Oberfläche bleibt bedienbar
  app.dataVersion++;
}

export async function saveSettings() {
  await setSetting('settings', $state.snapshot(app.settings));
  applyTheme();
}

export function applyTheme() {
  if (typeof document === 'undefined') return;
  const t = app.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export function setView(view, params = {}) {
  app.view = view;
  app.params = params;
  if (typeof location !== 'undefined') history.replaceState(null, '', '#' + view);
  if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
}

export async function updateTransaction(id, patch) {
  await db.transactions.update(id, patch);
  const t = app.data.transactions.find(x => x.id === id);
  if (t) Object.assign(t, patch);
  app.dataVersion++;
}
export async function updateTransactions(ids, patch) {
  const set = new Set(ids);
  await db.transactions.where('id').anyOf(ids).modify(patch);
  for (const t of app.data.transactions) if (set.has(t.id)) Object.assign(t, patch);
  app.dataVersion++;
}
export async function updateDocument(id, patch) {
  await db.documents.update(id, patch);
  const d = app.data.documents.find(x => x.id === id);
  if (d) Object.assign(d, patch);
  app.dataVersion++;
}
export async function putRecord(table, rec) {
  await db[table].put($state.snapshot(rec));
  const arr = app.data[table];
  const i = arr.findIndex(x => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  app.dataVersion++;
}
export async function deleteRecord(table, id) {
  await db[table].delete(id);
  app.data[table] = app.data[table].filter(x => x.id !== id);
  app.dataVersion++;
}

let toastId = 0;
export function toast(msg, { tone = 'info', ms = 3200, action = null } = {}) {
  const id = ++toastId;
  app.toasts.push({ id, msg, tone, action });
  setTimeout(() => { app.toasts = app.toasts.filter(t => t.id !== id); }, ms);
}

export async function resetAll() {
  await wipeAll();
  await reload();
  app.view = 'start';
}

export async function getBlob(fileId) {
  const r = await db.blobs.get(fileId);
  return r?.blob || null;
}
export async function getThumb(fileId) {
  const r = await db.blobs.get('thumb:' + fileId);
  return r?.blob || null;
}

// Lookups
export function accountName(id) {
  const a = app.data.accounts.find(x => x.id === id);
  return a ? (a.name || a.institution || 'Konto') : '–';
}
export function sourceOf(fileId) {
  const f = app.data.files.find(x => x.id === fileId);
  if (!f) return null;
  const s = app.data.sources.find(x => x.id === f.sourceId);
  return { file: f, source: s };
}
