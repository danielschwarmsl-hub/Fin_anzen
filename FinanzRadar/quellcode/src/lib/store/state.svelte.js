// Zentraler, reaktiver App-State (Svelte 5 Runes)
import { untrack } from 'svelte';
import { db, loadAll, getSetting, setSetting, wipeAll } from './db.js';
import { computeInsights } from '../analyze/insights.js';
import { buildIndex } from './search.js';
import { postProcess } from './postprocess.js';
import { reviewCount as countReview } from '../views/reviewModel.js';
import { learnRuleFromCorrection } from '../classify/rules.js';

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
// Offene Prüffälle (Kriterium siehe views/reviewModel.js) – für Navigation, Überblick, Quellen
let _reviewCount = $derived.by(() => {
  void app.dataVersion; void app.data.transactions; void app.data.documents;
  return untrack(() => countReview(app.data.transactions, app.data.documents));
});
export const live = {
  get insights() { return _insights; },
  get reviewCount() { return _reviewCount; },
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
  // Nach einem Update verdächtige Altimporte (z. B. falsch erkannte Kontoauszüge) im Hintergrund neu lesen
  if (app.data.files.length) {
    import('./importer.js').then(m => m.reprocessStale?.({ getSetting, setSetting })).then(r => {
      if (r?.done) toast(`Nach dem Update ${r.done} Datei${r.done === 1 ? '' : 'en'} neu eingelesen`, { tone: 'good', ms: 6000 });
    }).catch(e => console.warn('Neu einlesen nach Update', e));
  }
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
  const cur = app.data.documents.find(x => x.id === id) || await db.documents.get(id);
  // Typ vom Nutzer geändert: Datei mit genau diesem Typ neu lesen (anderer Parser, z. B. Kontoauszug statt Lohnabrechnung)
  if (patch.type && cur?.fileId && patch.type !== cur.type && patch.type !== 'irrelevant') {
    const { type, ...rest } = patch;
    const { reprocessFile } = await import('./importer.js');
    const { TYPE_LABELS } = await import('../parsers/naming.js');
    const label = TYPE_LABELS[type]?.name || type;
    toast(`Wird als ${label} neu eingelesen …`, { ms: 2500 });
    try {
      await reprocessFile(cur.fileId, { forceType: type });
    } catch (e) {
      toast(`Neu einlesen fehlgeschlagen: ${e?.message || e}`, { tone: 'bad', ms: 8000 });
      return;
    }
    const docs = await db.documents.where('fileId').equals(cur.fileId).toArray();
    // Sichtbares Ergebnis: bei Kontoumsätzen die Zahl der gelesenen Buchungen, 0 Buchungen deutlich melden
    if (['kontoauszug', 'kreditkarte', 'paypal', 'depot'].includes(type)) {
      const n = await db.transactions.filter(t => t.fileId === cur.fileId).count();
      if (n) toast(`Als ${label} neu eingelesen: ${n} Buchungen`, { tone: 'good', ms: 6000 });
      else toast(`Als ${label} eingelesen, aber keine Buchungen gefunden – das Format dieser Datei wird noch nicht verstanden. Bitte eine Beispielzeile melden.`, { tone: 'bad', ms: 12000 });
    } else toast(`Als ${label} neu eingelesen`, { tone: 'good' });
    // Felder, die der Parser liefert (Titel, Datum, Betrag …), nicht mit Werten des alten Typs überschreiben
    const keep = {};
    for (const k of ['needsReview', 'reviewed', 'tags', 'note']) if (k in rest) keep[k] = rest[k];
    for (const d of docs) await db.documents.update(d.id, { ...keep, typeSource: 'user', userEdited: true });
    await reload();
    return;
  }
  await db.documents.update(id, patch);
  const d = app.data.documents.find(x => x.id === id);
  if (d) Object.assign(d, patch);
  app.dataVersion++;
}
/** Mehrere Buchungs-Patches ([{ id, patch }]) nacheinander speichern */
export async function applyTxPatches(list) {
  for (const { id, patch } of list) if (id && patch && Object.keys(patch).length) await updateTransaction(id, patch);
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

// ---- Regeln anwenden & lernen ----
/** Regel speichern, neu auswerten; gibt die Zahl der dadurch neu zugeordneten Buchungen zurück */
export async function applyRule(rule) {
  const before = new Map(app.data.transactions.map(t => [t.id, `${t.category}|${t.subcategory || ''}`]));
  await putRecord('rules', rule);
  await postProcess();
  await reload();
  let n = 0;
  for (const t of app.data.transactions) if (t.ruleId === rule.id || (t.category === rule.set?.category && before.get(t.id) !== `${t.category}|${t.subcategory || ''}`)) n++;
  return n;
}
/** Regel wieder entfernen und Zuordnungen neu berechnen */
export async function removeRule(id) {
  await deleteRecord('rules', id);
  await postProcess();
  await reload();
}
/**
 * Nach einer Korrektur: zweite gleiche Korrektur derselben Gegenpartei → Regel automatisch anlegen (mit Rückgängig).
 * @returns {Promise<boolean>} true, wenn eine Regel entstanden ist
 */
export async function autoLearn(tx, category, subcategory) {
  const rule = learnRuleFromCorrection($state.snapshot(tx), category, subcategory, app.data.transactions, app.data.rules);
  if (!rule) return false;
  try {
    const n = Math.max(1, await applyRule(rule));
    toast(`Regel gelernt: „${rule.match.value}“ · ${n} ${n === 1 ? 'Buchung' : 'Buchungen'}`, { tone: 'good', ms: 9000, action: { label: 'Rückgängig', fn: () => removeRule(rule.id).then(() => toast('Regel entfernt')) } });
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** Dokument neu einlesen (zweiter OCR-Lauf bzw. erzwungener Typ). Importer-Funktion ist optional. */
export async function reprocessDoc(doc, opts = {}) {
  const fileId = doc?.fileId;
  if (!fileId) return false;
  let fn = null;
  try { fn = (await import('./importer.js'))?.reprocessFile; } catch (e) { console.warn(e); }
  if (typeof fn !== 'function') { toast('Neu prüfen ist noch nicht verfügbar'); return false; }
  try {
    await fn(fileId, opts);
    await reload();
    return true;
  } catch (e) {
    console.error(e);
    toast('Neu prüfen fehlgeschlagen', { tone: 'bad' });
    return false;
  }
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
