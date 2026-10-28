// Messbasis: Trefferquote je Bereich über alle Beispieldateien (samples/out) gegen samples/out/EXPECTED.json.
// Läuft DOM-frei in Node. Pro Datei: echte Extraktion (Bilder: OCR-Fixtures aus tests/fixtures) → detectType → parse.
// Über den Gesamtbestand: der echte Importer (runImport → saveResult) und die echte Nachverarbeitung (postProcess)
// auf einer In-Memory-Datenbank (tests/helpers/fake-db.js); Dexie und der Svelte-Zustand werden per Loader-Hook ersetzt.
//   npm run score                 Tabelle
//   npm run score -- --json       Ergebnis als JSON (für Vergleiche zwischen Ständen)
//   npm run score -- --details    zusätzlich jede Abweichung
//   npm run score -- --concurrency 2   Importer mit parallelen Workern (Standard 1 = reproduzierbar)
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb, makeFakeApp, fileItem } from '../tests/helpers/fake-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLES = path.join(ROOT, 'samples/out');
const FIX = path.join(ROOT, 'tests/fixtures');
const LIB = pathToFileURL(path.join(ROOT, 'src/lib')).href;

const args = process.argv.slice(2);
const opt = { json: args.includes('--json'), details: args.includes('--details'), concurrency: args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) || 1 : 1 };

// ---------------------------------------------------------------- Loader-Hook: db.js, state.svelte.js, extract/index.js ersetzen
const SCORE = (globalThis.__finanzradarScore = { db: makeFakeDb(), app: makeFakeApp(), extractOverride: null });
const hooks = `
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const LIB = ${JSON.stringify(LIB)};
const TARGETS = { [LIB + '/store/db.js']: 'db', [LIB + '/store/state.svelte.js']: 'state', [LIB + '/extract/index.js']: 'extract' };
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  const kind = TARGETS[r.url];
  return kind ? { url: 'finanzradar-score:' + kind + '?' + encodeURIComponent(r.url), shortCircuit: true } : r;
}
function exportNames(file) {
  const src = fs.readFileSync(fileURLToPath(file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+([A-Za-z_$][\\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\\s*\\{([^}]*)\\}/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\\s+as\\s+/).pop(); if (n) names.add(n); }
  return [...names];
}
export async function load(url, ctx, next) {
  if (url.startsWith(LIB) && url.endsWith('.js')) {
    // Vite-Eigenheit import.meta.glob('<fester Pfad>', { eager: true }) → statischer Import (wie Vite es bündelt)
    const src = fs.readFileSync(fileURLToPath(url), 'utf8');
    if (src.includes('import.meta.glob(')) {
      const imports = [];
      const source = src.replace(/import\\.meta\\.glob\\(\\s*(['"])([^'"*]+)\\1\\s*,\\s*\\{\\s*eager:\\s*true\\s*\\}\\s*\\)/g, (all, q, p) => {
        const name = '__glob' + imports.length;
        imports.push('import * as ' + name + ' from ' + JSON.stringify(p) + ';');
        return '{ ' + JSON.stringify(p) + ': ' + name + ' }';
      });
      return { format: 'module', source: imports.join('\\n') + '\\n' + source, shortCircuit: true };
    }
  }
  if (!url.startsWith('finanzradar-score:')) return next(url, ctx);
  const [kind, q] = url.slice('finanzradar-score:'.length).split('?');
  const real = decodeURIComponent(q);
  let source;
  if (kind === 'extract') {
    // Echte Extraktion, nur Bilder (OCR) über Fixtures; terminateOcr ohne Tesseract
    source = 'import * as real from ' + JSON.stringify(real + '?real') + ';\\n'
      + 'export * from ' + JSON.stringify(real + '?real') + ';\\n'
      + 'export async function terminateOcr() {}\\n'
      + 'export async function extract(meta, blob, opts) { const o = globalThis.__finanzradarScore.extractOverride; const r = o && await o(meta, blob, opts); return r || real.extract(meta, blob, opts); }\\n';
  } else {
    // Alle Exporte des Originals: aus dem Score-Kontext oder als No-op
    const S = 'globalThis.__finanzradarScore';
    source = exportNames(real).map(n => {
      if (kind === 'db' && n === 'db') return 'export const db = ' + S + '.db;';
      if (kind === 'db' && n === 'TABLES') return "export const TABLES = ['sources','files','documents','accounts','transactions','lineItems','contracts','holdings','valuations','assets','rules'];";
      if (kind === 'state' && n === 'app') return 'export const app = ' + S + '.app;';
      if (kind === 'state' && n === 'live') return 'export const live = {};';
      return 'export function ' + n + '() { return undefined; }';
    }).join('\\n');
  }
  return { format: 'module', source, shortCircuit: true };
}`;
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);

const { extract } = await import('../src/lib/extract/index.js');
const { detectType } = await import('../src/lib/detect/index.js');
const { parse } = await import('../src/lib/parsers/index.js');
const { runImport, ensureSource } = await import('../src/lib/store/importer.js');
const { computeInsights } = await import('../src/lib/analyze/insights.js');
const { getCategory } = await import('../src/lib/classify/categories.js');

const EXP = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'EXPECTED.json'), 'utf8'));
const FILES = EXP.files;

// ---------------------------------------------------------------- Extraktion (Bilder per OCR-Fixture wie in tests/documents.test.js)
function ocrExtracted(text, confidence = 80) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).map((t, i) => ({ y: 1000 - i * 10, text: t, items: [] }));
  const joined = lines.map(l => l.text).join('\n');
  return { kind: 'image', text: joined, pages: [{ n: 1, text: joined, lines }], rows: null, rawText: null, xml: null, ocr: true, ocrConfidence: confidence, thumbnail: null, meta: { pageCount: 1 } };
}
const fixtureByName = new Map(Object.entries(FILES).filter(([, v]) => v.ocrFixture).map(([rel, v]) => [path.basename(rel), v.ocrFixture]));
SCORE.extractOverride = async (meta) => {
  const fx = fixtureByName.get(meta.name);
  return fx ? ocrExtracted(fs.readFileSync(path.join(FIX, fx), 'utf8')) : null;
};

function listSamples() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== 'EXPECTED.json') out.push(path.relative(SAMPLES, p).split(path.sep).join('/')); } };
  walk(SAMPLES);
  return out.sort();
}
const metaOf = rel => ({ name: path.basename(rel), path: rel, ext: path.extname(rel).slice(1).toLowerCase(), mime: '', size: fs.statSync(path.join(SAMPLES, rel)).size });

// ---------------------------------------------------------------- Bewertung
const areas = new Map();
function area(name) { if (!areas.has(name)) areas.set(name, { name, hit: 0, total: 0, misses: [], note: '' }); return areas.get(name); }
function check(name, ok, what) { const a = area(name); a.total++; if (ok) a.hit++; else a.misses.push(what); return ok; }
const eur = c => (c == null ? '–' : (c / 100).toFixed(2));

// 1–3: je Datei (Typ, Beträge, Positionen) direkt über detect + parse
const perFile = {};
for (const rel of listSamples()) {
  const exp = FILES[rel];
  if (!exp?.appType) continue;
  const meta = metaOf(rel);
  const blob = new Blob([fs.readFileSync(path.join(SAMPLES, rel))]);
  let det, res;
  try {
    const ex = await extract(meta, blob, {});
    det = detectType(ex, meta);
    res = det.type === 'irrelevant' ? null : await parse(det, ex, meta);
  } catch (e) {
    check('Dokumenttyp', false, `${rel}: Fehler ${e?.message || e}`);
    continue;
  }
  perFile[rel] = { det, res };
  check('Dokumenttyp', det.type === exp.appType, `${rel}: ${det.type} statt ${exp.appType}`);
  if (exp.appFormat) check('Format', det.format === exp.appFormat, `${rel}: Format ${det.format} statt ${exp.appFormat}`);
  const e = exp.expect || {};
  const doc = res?.document || {};
  const txs = res ? [res, ...(res.additional || [])].flatMap(r => r.transactions || []) : [];
  const B = 'Beträge';
  if (e.transactions != null) check(B, txs.length === e.transactions, `${rel}: ${txs.length} statt ${e.transactions} Buchungen`);
  if (e.openingCents != null) check(B, res?.balance?.opening === e.openingCents, `${rel}: Anfangssaldo ${eur(res?.balance?.opening)} statt ${eur(e.openingCents)}`);
  if (e.closingCents != null) check(B, res?.balance?.closing === e.closingCents, `${rel}: Endsaldo ${eur(res?.balance?.closing)} statt ${eur(e.closingCents)}`);
  if (e.sumCents != null) { const s = txs.reduce((a, t) => a + t.amount, 0); check(B, s === e.sumCents, `${rel}: Summe ${eur(s)} statt ${eur(e.sumCents)}`); }
  if (e.holdings != null) check(B, (res?.holdings || []).length === e.holdings, `${rel}: ${(res?.holdings || []).length} statt ${e.holdings} Positionen im Depot`);
  if (e.holdingsValueCents != null) { const v = (res?.holdings || []).reduce((a, h) => a + (h.value || 0), 0); check(B, v === e.holdingsValueCents, `${rel}: Depotwert ${eur(v)} statt ${eur(e.holdingsValueCents)}`); }
  if (e.amountCents != null) check(B, doc.amount === e.amountCents, `${rel}: Betrag ${eur(doc.amount)} statt ${eur(e.amountCents)}`);
  if (e.grossCents != null) check(B, res?.payroll?.gross === e.grossCents, `${rel}: Brutto ${eur(res?.payroll?.gross)} statt ${eur(e.grossCents)}`);
  if (e.vatCents != null) { const v = (res?.vat || []).reduce((a, x) => a + (x.tax || 0), 0); check(B, v === e.vatCents, `${rel}: MwSt ${eur(v)} statt ${eur(e.vatCents)}`); }
  if (e.date != null) check(B, doc.date === e.date, `${rel}: Datum ${doc.date} statt ${e.date}`);
  const P = 'Positionen';
  const items = res?.lineItems || [];
  if (e.lineItems != null) check(P, items.length === e.lineItems, `${rel}: ${items.length} statt ${e.lineItems} Positionen`);
  if (e.lineItemsSumCents != null) { const s = items.reduce((a, i) => a + (Number.isFinite(i.total) ? i.total : 0), 0); check(P, s === e.lineItemsSumCents, `${rel}: Positionssumme ${eur(s)} statt ${eur(e.lineItemsSumCents)} (${e.lineItemsBasis})`); }
}

// 4–7: Gesamtbestand über den echten Importer + Nachverarbeitung
const { db, app } = SCORE;
const source = await ensureSource({ kind: 'local', name: 'Beispiele', root: 'samples/out' });
const items = listSamples().map(rel => fileItem(rel, fs.readFileSync(path.join(SAMPLES, rel)), { mtime: '2026-07-01T00:00:00.000Z' }));
const origError = console.error, origWarn = console.warn;
console.error = () => {}; console.warn = () => {};
try { await runImport(items, source, { concurrency: opt.concurrency }); } finally { console.error = origError; console.warn = origWarn; }
const importErrors = [...(app.progress.errors || [])];
const snap = db.snapshot();
const fileByPath = new Map(snap.files.map(f => [f.path, f]));
const docsOfFile = rel => { const f = fileByPath.get(rel); return f ? snap.documents.filter(d => d.fileId === f.id) : []; };
const txByAcc = new Map();
for (const t of snap.transactions) { if (!txByAcc.has(t.accountId)) txByAcc.set(t.accountId, []); txByAcc.get(t.accountId).push(t); }
const txById = new Map(snap.transactions.map(t => [t.id, t]));

// Erwartete Buchungen → gespeicherte Buchungen (Konto des Dokuments, Datum + Betrag, Vielfachheit)
const expById = new Map();
const matched = new Map(); // erwartete ID → tx
const accountOfKey = new Map();
for (const [rel, exp] of Object.entries(FILES)) {
  if (!exp.bookingsExpected) continue;
  const accId = docsOfFile(rel).find(d => d.accountId)?.accountId || null;
  if (accId) accountOfKey.set(exp.accountKey, accId);
  const pool = new Map();
  for (const t of txByAcc.get(accId) || []) { const k = t.bookingDate + '|' + t.amount; if (!pool.has(k)) pool.set(k, []); pool.get(k).push(t); }
  for (const b of exp.bookingsExpected) {
    expById.set(b.id, b);
    const t = pool.get(b.date + '|' + b.amount)?.shift();
    if (t) matched.set(b.id, t);
  }
}

// Kategorie
for (const b of expById.values()) {
  if (!b.category) continue;
  const t = matched.get(b.id);
  check('Kategorie', t && t.category === b.category, `${b.id} (${b.payee}): ${t ? `${t.category}/${t.subcategory || '–'}` : 'Buchung fehlt'} statt ${b.category}/${b.subcategory || '–'}`);
  if (b.subcategory) check('Unterkategorie', t && t.category === b.category && t.subcategory === b.subcategory, `${b.id} (${b.payee}): ${t ? `${t.category}/${t.subcategory || '–'}` : 'Buchung fehlt'} statt ${b.category}/${b.subcategory}`);
}

// Vollständigkeit und Dubletten
const X = EXP.crossChecks || {};
for (const b of expById.values()) check('Vollständigkeit', matched.has(b.id), `${b.id} (${b.payee}) fehlt`);
// Je Konto: gespeicherte Buchungen ohne erwartetes Gegenstück sind Doppelzählungen (bzw. Fehlparsings).
// N = Buchungen, die in mehreren Dateien vorkommen (duplicateOf); jede überzählige Buchung kostet einen Treffer.
const matchedIds = new Set([...matched.values()].map(t => t.id));
const dupByKey = new Map();
for (const [, v] of Object.entries(FILES)) if (v.duplicateOf) { const k = FILES[v.duplicateOf.file].accountKey; dupByKey.set(k, (dupByKey.get(k) || 0) + v.duplicateOf.count); }
for (const [key, n] of Object.entries(X.uniqueTransactions || {})) {
  const accId = accountOfKey.get(key);
  const stored = txByAcc.get(accId) || [];
  const surplus = stored.filter(t => !matchedIds.has(t.id));
  const N = dupByKey.get(key) || 0;
  for (let i = 0; i < N; i++) check('Dubletten', i >= surplus.length, `Konto ${key}: Buchung doppelt gespeichert`);
  if (stored.length !== n) area('Dubletten').misses.push(`Konto ${key}: ${stored.length} statt ${n} Buchungen gespeichert`);
  for (const t of surplus) area('Dubletten').misses.push(`Konto ${key}: überzählig ${t.bookingDate} ${eur(t.amount)} ${t.counterparty || t.counterpartyRaw}`);
}
const accCount = snap.accounts.length;
check('Konten', accCount === (X.accounts || []).length, `${accCount} statt ${(X.accounts || []).length} Konten angelegt: ${snap.accounts.map(a => `${a.kind}/${a.name}`).join(', ')}`);

// Umbuchungen
for (const p of X.transferPairs || []) {
  const a = matched.get(p.a), b = matched.get(p.b);
  check('Umbuchungen', a && b && a.transferPairId === b.id && b.transferPairId === a.id && a.isTransfer && b.isTransfer, `${p.a} ↔ ${p.b}: ${!a || !b ? 'Buchung fehlt' : `Paar ${a.transferPairId ? (a.transferPairId === b.id ? 'ok' : 'falsch') : 'fehlt'}`}`);
}
for (const id of X.oneSidedTransfers || []) {
  const t = matched.get(id);
  check('Umbuchungen', t && t.isTransfer, `${id}: ${t ? 'nicht als Umbuchung markiert' : 'Buchung fehlt'}`);
}
const falseTransfers = [...matched].filter(([id, t]) => t.isTransfer && !expById.get(id).transfer).map(([id]) => id);
if (falseTransfers.length) area('Umbuchungen').note = `${falseTransfers.length} fälschlich als Umbuchung`;
for (const id of falseTransfers) area('Umbuchungen').misses.push(`${id}: fälschlich Umbuchung`);

// Belegzuordnung
const expectedLinks = new Set();
for (const r of X.receiptLinks || []) {
  const t = matched.get(r.tx);
  const docIds = docsOfFile(r.doc).map(d => d.id);
  const linked = t && (docIds.includes(t.receiptDocId) || (t.receiptDocIds || []).some(id => docIds.includes(id)));
  if (t) expectedLinks.add(t.id);
  check('Belegzuordnung', linked, `${r.doc} → ${r.tx}: ${!t ? 'Buchung fehlt' : t.receiptDocId ? 'anderer Beleg verknüpft' : 'nicht verknüpft'}`);
}
const wrongLinks = snap.transactions.filter(t => t.receiptDocId && !expectedLinks.has(t.id));
if (wrongLinks.length) area('Belegzuordnung').note = `${wrongLinks.length} unerwartete Verknüpfung(en)`;
for (const t of wrongLinks) area('Belegzuordnung').misses.push(`unerwartet: ${t.bookingDate} ${eur(t.amount)} ${t.counterparty} → ${snap.documents.find(d => d.id === t.receiptDocId)?.displayName || t.receiptDocId}`);

// Summen (keine Doppelzählung): Soll aus den erwarteten Buchungen, Ist aus computeInsights
const range = { from: '2026-01-01', to: '2026-06-30' };
let sIncome = 0, sExpense = 0, sSaving = 0;
for (const b of expById.values()) {
  if (b.date < range.from || b.date > range.to) continue;
  const kind = getCategory(b.category)?.kind || 'expense';
  if (b.transfer || b.category === 'umbuchung') {
    if (b.kind === 'tagesgeld') sSaving += -b.amount; // Überweisung auf eigenes Sparkonto
    continue;
  }
  if (kind === 'income') sIncome += b.amount;
  else if (kind === 'saving') sSaving += -b.amount;
  else sExpense += -b.amount;
}
const data = { accounts: snap.accounts, transactions: snap.transactions, documents: snap.documents, contracts: snap.contracts, holdings: snap.holdings, valuations: snap.valuations, assets: snap.assets };
const ins = computeInsights(data, range);
check('Summen', ins.totals.income === sIncome, `Einnahmen ${eur(ins.totals.income)} statt ${eur(sIncome)}`);
check('Summen', ins.totals.expense === sExpense, `Ausgaben ${eur(ins.totals.expense)} statt ${eur(sExpense)}`);
check('Summen', ins.totals.saving === sSaving, `Sparen ${eur(ins.totals.saving)} statt ${eur(sSaving)}`);

// Prüfliste (Information, keine Quote): offene Fälle nach dem Standard-Import
const openReview = snap.transactions.filter(t => (t.needsReview && !t.reviewed) || (t.checks?.length > 0)).length;
const openDocs = snap.documents.filter(d => d.needsReview).length;

// ---------------------------------------------------------------- Ausgabe
const ORDER = ['Dokumenttyp', 'Format', 'Beträge', 'Positionen', 'Kategorie', 'Unterkategorie', 'Vollständigkeit', 'Dubletten', 'Konten', 'Umbuchungen', 'Belegzuordnung', 'Summen'];
const rows = ORDER.filter(n => areas.has(n)).map(n => areas.get(n)).map(a => ({ ...a, rate: a.total ? a.hit / a.total : 1 }));
const result = {
  date: new Date().toISOString(), concurrency: opt.concurrency,
  areas: Object.fromEntries(rows.map(r => [r.name, { hit: r.hit, total: r.total, rate: Math.round(r.rate * 1000) / 1000, note: r.note || undefined, misses: r.misses }])),
  review: { openTransactions: openReview, openDocuments: openDocs },
  totals: { income: ins.totals.income, expense: ins.totals.expense, saving: ins.totals.saving, expected: { income: sIncome, expense: sExpense, saving: sSaving } },
  importErrors,
};
if (opt.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
  const lines = [`FinanzRadar Messbasis – ${Object.keys(perFile).length} Dateien, Importer mit ${opt.concurrency} Worker(n)`, ''];
  lines.push(`${pad('Bereich', 16)} ${lpad('n/N', 9)} ${lpad('Quote', 7)}  Hinweis`);
  lines.push('-'.repeat(60));
  for (const r of rows) lines.push(`${pad(r.name, 16)} ${lpad(`${r.hit}/${r.total}`, 9)} ${lpad((r.rate * 100).toFixed(1) + ' %', 7)}  ${r.note || (r.misses.length ? r.misses.length + ' Abweichung(en)' : '')}`);
  lines.push('-'.repeat(60));
  lines.push(`Prüfliste nach Import: ${openReview} Buchungen, ${openDocs} Dokumente`);
  lines.push(`Summen 01–06/2026: Einnahmen ${eur(ins.totals.income)} (Soll ${eur(sIncome)}), Ausgaben ${eur(ins.totals.expense)} (Soll ${eur(sExpense)}), Sparen ${eur(ins.totals.saving)} (Soll ${eur(sSaving)})`);
  if (importErrors.length) lines.push(`Importfehler: ${importErrors.map(e => `${e.name}: ${e.error}`).join('; ')}`);
  if (opt.details) {
    for (const r of rows) if (r.misses.length) { lines.push('', `${r.name}:`); for (const m of r.misses) lines.push('  - ' + m); }
  } else lines.push('', 'Abweichungen einzeln: npm run score -- --details');
  process.stdout.write(lines.join('\n') + '\n');
}
