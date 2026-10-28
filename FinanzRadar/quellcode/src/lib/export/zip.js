// Exporte: Steuer-ZIP (Ordner je Grund + Liste), Archiv-ZIP (Ordner je Dokumenttyp), Buchungen-CSV.
import { downloadZip } from 'client-zip';
import { fmtDate, safeName, extOf } from '../util/format.js';
import { TYPE_LABELS } from '../parsers/naming.js';
import { TAX_REASONS } from '../classify/taxFlags.js';
import { categoryLabel } from '../classify/categories.js';

const BOM = '﻿';
export const REASON_FOLDER = {
  lohn: 'Lohn', beruf: 'Beruf', versicherung_vorsorge: 'Versicherung_Vorsorge', kapitalertraege: 'Kapitalertraege',
  haushalt_handwerker: 'Haushalt_Handwerker', spenden: 'Spenden', gesundheit: 'Gesundheit', kinder_bildung: 'Kinder_Bildung', sonstiges: 'Sonstiges',
};
const REASON_LABEL = Object.fromEntries(TAX_REASONS.map(r => [r.id, r.label]));

// ---------------------------------------------------------------- CSV-Helfer
const eurText = (cents) => (cents == null ? '' : (cents / 100).toFixed(2).replace('.', ','));
/** Feld für CSV (;) – Anführungszeichen bei Bedarf, Formelstart entschärfen (nur Text) */
function cell(v, { text = false } = {}) {
  let s = v == null ? '' : String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const row = (cols) => cols.join(';');

// ---------------------------------------------------------------- Dateinamen
function uniqueName(used, folder, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let n = 1, candidate = name;
  while (used.has((folder + '/' + candidate).toLowerCase())) { n++; candidate = `${base} (${n})${ext}`; }
  used.add((folder + '/' + candidate).toLowerCase());
  return candidate;
}

function fileNameFor(doc, file) {
  const ext = file?.ext || extOf(file?.name) || '';
  let name = doc.displayName;
  if (!name) {
    const t = TYPE_LABELS[doc.type]?.label || 'Dokument';
    name = [doc.date, t, doc.issuer || doc.institution].filter(Boolean).join('_') + (ext ? '.' + ext : '');
  }
  name = safeName(name.replace(/[\\/]+/g, '-'), 120) || 'Dokument';
  return name;
}

function originOf(file) {
  const o = file?.origins?.length ? file.origins : [{ sourceName: file?.sourceName, path: file?.path || file?.name }];
  return o.map(x => [x.sourceName || x.sourceKind, x.path].filter(Boolean).join(': ')).join(' | ');
}

function modified(doc) {
  const t = doc.date ? Date.parse(doc.date + 'T12:00:00Z') : NaN;
  return Number.isFinite(t) ? new Date(t) : new Date();
}

/** Zuordnung Dokument → Pfad im ZIP (ohne Dateiinhalt) */
export function planZipPaths(documents, files, folderOf) {
  const fileById = new Map((files || []).map(f => [f.id, f]));
  const used = new Set();
  return documents.map(doc => {
    const file = fileById.get(doc.fileId);
    const folder = folderOf(doc);
    const name = uniqueName(used, folder, fileNameFor(doc, file));
    return { doc, file, folder, name, path: `${folder}/${name}` };
  });
}

async function collect({ documents, files, getBlob, folderOf }) {
  const entries = [], list = [];
  for (const p of planZipPaths(documents, files, folderOf)) {
    let blob = null;
    try { blob = p.doc.fileId ? await getBlob(p.doc.fileId) : null; } catch { blob = null; }
    if (blob) entries.push({ name: p.path, lastModified: modified(p.doc), input: blob });
    list.push({ doc: p.doc, file: p.file, path: p.path, missing: !blob });
  }
  return { entries, list };
}

function listCsv(list, reasonCol) {
  const head = row(['Datei', 'Datum', 'Typ', 'Aussteller', 'Betrag', reasonCol, 'Herkunft']);
  const lines = list.map(({ doc, file, path, missing }) => row([
    cell(missing ? path + ' (Datei fehlt)' : path, { text: true }),
    cell(doc.date ? fmtDate(doc.date) : ''),
    cell(TYPE_LABELS[doc.type]?.name || doc.type || '', { text: true }),
    cell(doc.issuer || doc.institution || '', { text: true }),
    cell(doc.amount != null ? eurText(doc.amount) : ''),
    cell(reasonCol === 'Grund' ? (REASON_LABEL[doc.taxReason] || REASON_LABEL.sonstiges) : (TYPE_LABELS[doc.type]?.name || ''), { text: true }),
    cell(originOf(file), { text: true }),
  ]));
  return BOM + [head, ...lines].join('\r\n') + '\r\n';
}

async function zipBlob(entries) {
  const res = downloadZip(entries);
  const blob = await res.blob();
  return blob.type === 'application/zip' ? blob : new Blob([blob], { type: 'application/zip' });
}

/**
 * Steuer-ZIP: ein Ordner je Steuergrund + 00_Liste.csv.
 * @param {{ documents: object[], files: object[], getBlob: (fileId:string)=>Promise<Blob|null>, includeSuggested?: boolean }} o
 */
export async function buildTaxZip({ documents, files, getBlob, includeSuggested = true }) {
  const docs = (documents || []).filter(d => d && d.type !== 'irrelevant' && !!d.taxRelevant && (includeSuggested || d.taxSource === 'user'));
  const reasonOf = (d) => REASON_FOLDER[d.taxReason] || REASON_FOLDER.sonstiges;
  const order = Object.values(REASON_FOLDER);
  docs.sort((a, b) => order.indexOf(reasonOf(a)) - order.indexOf(reasonOf(b)) || (a.date || '').localeCompare(b.date || ''));
  const { entries, list } = await collect({ documents: docs, files, getBlob, folderOf: reasonOf });
  const csv = listCsv(list, 'Grund');
  entries.unshift({ name: '00_Liste.csv', lastModified: new Date(), input: new Blob([csv], { type: 'text/csv;charset=utf-8' }) });
  return zipBlob(entries);
}

/**
 * Archiv-ZIP: alle Dokumente, Ordner je Dokumenttyp (+ Liste).
 */
export async function buildArchiveZip({ documents, files, getBlob }) {
  const docs = (documents || []).filter(d => d && d.type !== 'irrelevant');
  const folderOf = (d) => safeName((TYPE_LABELS[d.type]?.name || 'Sonstiges').replace(/[ /]+/g, '_'), 40) || 'Sonstiges';
  docs.sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || (a.date || '').localeCompare(b.date || ''));
  const { entries, list } = await collect({ documents: docs, files, getBlob, folderOf });
  entries.unshift({ name: '00_Liste.csv', lastModified: new Date(), input: new Blob([listCsv(list, 'Ordner')], { type: 'text/csv;charset=utf-8' }) });
  return zipBlob(entries);
}

/**
 * Buchungen als CSV (UTF-8 mit BOM, Trennzeichen ;).
 * @param {object[]} transactions
 * @param {object[]} accounts
 */
export function buildCsvExport(transactions = [], accounts = []) {
  const acc = new Map(accounts.map(a => [a.id, a]));
  const head = ['Buchungsdatum', 'Wertstellung', 'Konto', 'Gegenpartei', 'Verwendungszweck', 'Betrag', 'Währung', 'Kategorie', 'Umbuchung', 'Steuerrelevant', 'Steuergrund', 'Buchungstext', 'IBAN Gegenpartei'];
  const lines = transactions.map(t => row([
    cell(t.bookingDate ? fmtDate(t.bookingDate) : ''),
    cell(t.valueDate ? fmtDate(t.valueDate) : ''),
    cell(acc.get(t.accountId)?.name || '', { text: true }),
    cell(t.counterparty || t.counterpartyRaw || '', { text: true }),
    cell(t.purpose || '', { text: true }),
    cell(eurText(t.amount)),
    cell(t.currency || 'EUR'),
    cell(t.category ? categoryLabel(t.category, t.subcategory) : '', { text: true }),
    t.isTransfer ? 'ja' : '',
    t.taxRelevant ? 'ja' : '',
    cell(t.taxRelevant ? (REASON_LABEL[t.taxReason] || '') : '', { text: true }),
    cell(t.bookingText || '', { text: true }),
    cell(t.counterpartyIban || ''),
  ]));
  return BOM + [row(head), ...lines].join('\r\n') + '\r\n';
}
