// Import-Pipeline: Quelle → Hash/Dedupe/Herkunft → Extraktion → Erkennung → Parser → Speichern → Nachverarbeitung
import { db } from './db.js';
import { app, reload } from './state.svelte.js';
import { sha256Hex, uid, extOf, normalizeIban } from '../util/format.js';
import { extract, terminateOcr } from '../extract/index.js';
import { detectType } from '../detect/index.js';
import { parse } from '../parsers/index.js';
import { displayName } from '../parsers/naming.js';
import { postProcess } from './postprocess.js';
import { aiHooks } from '../ai/hooks.js';
import { detectStatementFormat } from '../parsers/docs/_statements.js';

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/plain', xml: 'application/xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', sta: 'text/plain', mt940: 'text/plain' };

const STATEMENT_TYPES = new Set(['kontoauszug', 'paypal', 'depot', 'kreditkarte']);
const AI_KEEP = ['aiHint', 'aiAt', 'aiReason', 'aiSuggestion']; // KI-Felder, die ein Neu-Lesen überleben
const MAX_LINE_ITEMS = 500; // Obergrenze je Dokument (Schutz vor Textdateien mit Hunderttausenden „Positionen“)

let controller = null;
let pauseWaiters = []; // jeder wartende Worker braucht seinen eigenen Resolver

export function pauseImport() { app.progress.paused = true; }
export function resumeImport() { app.progress.paused = false; for (const r of pauseWaiters.splice(0)) r(); }
export function cancelImport() { controller?.abort(); resumeImport(); }

/** Verständliche Fehlermeldung (pdf.js-, heic2any- und DOM-Fehler haben unterschiedliche Formen) */
export function errorText(e) {
  const name = e?.name || '';
  const msg = typeof e === 'string' ? e : e?.message || '';
  if (name === 'PasswordException') return 'PDF ist passwortgeschützt';
  if (name === 'InvalidPDFException') return 'Keine gültige PDF-Datei';
  if (name === 'NotReadableError' || name === 'NotFoundError') return 'Datei nicht lesbar (Berechtigung oder Datei wurde geändert)';
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return 'Speicher des Browsers voll';
  if (/libheif|heic/i.test(msg)) return 'HEIC-Bild nicht lesbar (Format wird nicht unterstützt)';
  if (msg) return msg;
  if (e && typeof e === 'object') { try { return JSON.stringify(e); } catch { /* weiter */ } }
  return String(e);
}
const isQuota = (e) => e?.name === 'QuotaExceededError' || e?.inner?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');

/** Schlüssel „bekannte Datei“: gleicher Pfad, gleiche Größe, gleicher Zeitstempel (0/null/'' gelten als „unbekannt“) */
const fileKey = (path, size, mtime) => `${path}|${size ?? ''}|${mtime || ''}`;

/** Früher wegen fehlendem/unsicherem OCR-Text ignoriert → beim nächsten Import erneut versuchen */
const ignoredForOcr = (f) => f?.status === 'ignored' && (f.detection?.subtype === 'kein_text' || !!f.detection?.ocrLow);
/** Datei gilt als erledigt (kein erneutes Lesen) */
const isSettled = (f) => f?.status === 'done' || (f?.status === 'ignored' && !ignoredForOcr(f));

/** Quelle anlegen oder vorhandene zurückgeben */
export async function ensureSource({ kind, name, root = '', config = {} }) {
  const existing = (await db.sources.toArray()).find(s => s.kind === kind && s.name === name && s.root === root);
  if (existing) return existing;
  const s = { id: uid('src_'), kind, name, root, config, addedAt: new Date().toISOString(), lastScan: null };
  await db.sources.put(s);
  return s;
}

/**
 * items: Array oder AsyncIterable von { path, name, size, mtime, ext, getFile }
 * source: Datensatz aus ensureSource
 */
export async function runImport(items, source, { concurrency = 2 } = {}) {
  if (app.progress.running) return;
  controller = new AbortController();
  const signal = controller.signal;
  const p = app.progress;
  Object.assign(p, { running: true, paused: false, total: 0, done: 0, current: 'Dateien werden gesammelt …', phase: 'collect', errors: [], counts: {}, startedAt: Date.now(), log: [], skipped: 0, newDocs: 0, newTx: 0, dupTx: 0, enrichedTx: 0 });
  pauseWaiters = [];

  try {
    try { aiHooks.beforeImport?.(); } catch { /* KI optional */ }
    // Items einsammeln (Cloud-Quellen liefern AsyncIterable)
    const list = [];
    try {
      for await (const it of items) { if (signal.aborted) break; list.push(it); p.total = list.length; }
    } catch (e) { if (e?.name !== 'AbortError') p.errors.push({ name: source.name, error: 'Quelle: ' + errorText(e) }); }
    p.phase = 'process';

    // Bekannte Dateien für schnellen Skip: gleicher Pfad + Größe + mtime in gleicher Quelle (auch Pfade von Dubletten)
    const known = new Set();
    await db.files.each(f => {
      if (!isSettled(f)) return;
      if (f.sourceId === source.id) known.add(fileKey(f.path, f.size, f.mtime));
      for (const o of f.origins || []) if (o.sourceId === source.id) known.add(fileKey(o.path, o.size ?? f.size, o.mtime ?? f.mtime));
    });
    const existingKeys = new Set();
    await db.transactions.each(t => { if (t.dedupeKey) existingKeys.add(t.dedupeKey); });
    const ctx = { signal, existingKeys, inflight: new Map() };

    let i = 0;
    async function worker() {
      while (i < list.length && !signal.aborted) {
        while (p.paused && !signal.aborted) await new Promise(r => pauseWaiters.push(r));
        if (signal.aborted || i >= list.length) break;
        const item = list[i++];
        p.current = item.path || item.name;
        try {
          if (known.has(fileKey(item.path || item.name, item.size, item.mtime))) p.skipped++;
          else await processItem(item, source, ctx);
        } catch (e) {
          if (e?.name === 'AbortError' || signal.aborted) break;
          console.error(item.name, e);
          p.errors.push({ name: item.path || item.name, error: errorText(e) });
          if (isQuota(e)) { p.errors.push({ name: 'Speicher', error: 'Speicher des Browsers voll – Import abgebrochen. Bitte Platz schaffen und erneut starten.' }); controller?.abort(); break; }
        }
        p.done++;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    await terminateOcr(); // OCR-Worker belegt viel Speicher – nur während des Imports behalten

    p.phase = 'analyze';
    p.current = 'Kategorisieren, Abos & Umbuchungen erkennen …';
    try { await postProcess(); } catch (e) { console.error(e); p.errors.push({ name: 'Analyse', error: errorText(e) }); }
    if (aiHooks.afterImport && !signal.aborted) {
      p.phase = 'ai';
      try { await aiHooks.afterImport({ signal }); } catch (e) { console.warn('KI', e); }
    }
    await db.sources.update(source.id, { lastScan: new Date().toISOString() });
    await reload();
  } catch (e) {
    console.error(e);
    p.errors.push({ name: 'Import', error: errorText(e) });
  } finally {
    await terminateOcr().catch(() => {});
    p.running = false;
    p.paused = false;
    p.phase = 'done';
    p.current = '';
    controller = null;
  }
}

/** Daten einer früher abgebrochenen/fehlgeschlagenen Verarbeitung entfernen (Dokumente, Buchungen …) */
// Nutzerentscheidungen an Buchungen, die ein Neu-Einlesen überstehen (Zuordnung über dedupeKey bzw. Datum+Betrag+Text)
const USER_TX_FIELDS = {
  category: (t) => t.categorySource === 'user', subcategory: (t) => t.categorySource === 'user', categorySource: (t) => t.categorySource === 'user',
  confidence: (t) => t.categorySource === 'user', ruleId: (t) => t.categorySource === 'user',
  taxRelevant: (t) => t.taxSource === 'user', taxReason: (t) => t.taxSource === 'user', taxSource: (t) => t.taxSource === 'user',
  isTransfer: (t) => t.transferSource === 'user', transferPairId: (t) => t.transferSource === 'user', transferAccountId: (t) => t.transferSource === 'user',
  transferSource: (t) => t.transferSource === 'user',
  receiptDocId: (t) => t.receiptSource === 'user', receiptDocIds: (t) => t.receiptSource === 'user', receiptSource: (t) => t.receiptSource === 'user',
  receiptRejected: () => true, stornoSource: (t) => t.stornoSource === 'user', stornoPairId: (t) => t.stornoSource === 'user',
  counterparty: (t) => !!t.counterpartyUser, counterpartyUser: (t) => !!t.counterpartyUser,
  reviewed: () => true, needsReview: (t) => !!t.reviewed, splits: () => true, note: () => true, tags: () => true, checksAck: () => true,
  aiHint: () => true, aiReason: () => true, aiAt: () => true, aiSuggestion: () => true,
};
const txMatchKey = (t) => `${t.bookingDate}|${t.amount}|${String(t.counterpartyRaw || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
function userDecisions(t) {
  const out = {};
  for (const [k, keep] of Object.entries(USER_TX_FIELDS)) if (t[k] != null && keep(t)) out[k] = t[k];
  return Object.keys(out).length ? out : null;
}

async function purgeFileData(fileId, existingKeys) {
  const docIds = await db.documents.where('fileId').equals(fileId).primaryKeys();
  if (!docIds.length) return;
  const txs = await db.transactions.where('documentId').anyOf(docIds).toArray();
  for (const t of txs) if (t.dedupeKey) existingKeys.delete(t.dedupeKey);
  await db.transactions.where('documentId').anyOf(docIds).delete();
  await db.lineItems.where('documentId').anyOf(docIds).delete();
  await db.holdings.where('documentId').anyOf(docIds).delete();
  const ids = new Set(docIds);
  await db.valuations.filter(v => ids.has(v.documentId)).delete();
  await db.documents.bulkDelete(docIds);
}

async function processItem(item, source, ctx) {
  const { signal, inflight } = ctx;
  const file = await item.getFile();
  const buf = await file.arrayBuffer();
  signal.throwIfAborted();
  const hash = await sha256Hex(buf);
  const ext = item.ext || extOf(item.name);
  const origin = { sourceId: source.id, sourceName: source.name, sourceKind: source.kind, path: item.path || item.name, size: item.size ?? file.size, mtime: item.mtime || null };

  // Gleicher Inhalt, der gerade von einem anderen Worker verarbeitet wird (Dublette in anderem Ordner): abwarten
  while (inflight.has(hash)) await inflight.get(hash);
  let release;
  inflight.set(hash, new Promise(r => { release = r; }));
  try {
    await processContent(item, source, ctx, { file, buf, hash, ext, origin });
  } finally {
    inflight.delete(hash);
    release();
  }
}

async function processContent(item, source, { signal, existingKeys }, { file, buf, hash, ext, origin }) {
  const dup = await db.files.get(hash);
  if (dup && isSettled(dup)) {
    // Gleicher Inhalt schon importiert → nur Herkunft ergänzen (je Quelle und Pfad einmal)
    const origins = dup.origins || [];
    const same = origins.find(o => o.sourceId === origin.sourceId && o.path === origin.path);
    if (!same) { origins.push(origin); await db.files.update(hash, { origins }); }
    else if (same.mtime !== origin.mtime || same.size !== origin.size) { Object.assign(same, { size: origin.size, mtime: origin.mtime }); await db.files.update(hash, { origins }); }
    app.progress.skipped++;
    return;
  }
  const meta = { name: item.name, path: item.path || item.name, ext, mime: file.type || MIME[ext] || 'application/octet-stream', size: item.size ?? file.size };
  // Frühere, unvollständige Verarbeitung (Abbruch, Absturz, Fehler): aufräumen und neu lesen
  if (dup) await purgeFileData(hash, existingKeys);
  const origins = dup ? [...(dup.origins || []).filter(o => !(o.sourceId === origin.sourceId && o.path === origin.path)), origin] : [origin];
  const rec = { id: hash, sourceId: source.id, path: meta.path, name: meta.name, ext, mime: meta.mime, size: meta.size, mtime: item.mtime || null, importedAt: new Date().toISOString(), status: 'processing', origins };
  if (buf.byteLength === 0) {
    // Leere Datei: nichts zu lesen
    await db.files.put({ ...rec, status: 'ignored', detection: { type: 'irrelevant', confidence: 1 } });
    count('irrelevant');
    return;
  }
  const blob = new Blob([buf], { type: meta.mime });
  await db.files.put(rec);
  try {
    await db.blobs.put({ id: hash, blob });
    await readAndSave(meta, blob, hash, { signal, existingKeys });
  } catch (e) {
    // Nicht in „processing“ hängen lassen: beim nächsten Import wird die Datei erneut versucht
    await db.files.update(hash, { status: 'error', error: e?.name === 'AbortError' ? 'Abgebrochen' : errorText(e) }).catch(() => {});
    throw e;
  }
}

/**
 * Eine bereits importierte Datei neu verarbeiten (z. B. „Neu prüfen“ bei unlesbarem Beleg oder Typ korrigieren).
 * Liest den gespeicherten Inhalt aus db.blobs, löscht die alten Daten der Datei, speichert neu und ruft danach die
 * Nachverarbeitung (ohne aiHooks.afterImport). forceType: vom Nutzer gewählter Dokumenttyp (ohne erneute Erkennung);
 * ocrBoost: OCR gleich mit höherer Auflösung. KI-Felder (aiHint, aiAt, aiReason, aiSuggestion) bleiben erhalten.
 */
export async function reprocessFile(fileId, { forceType = null, ocrBoost = false, skipPost = false } = {}) {
  const rec = await db.files.get(fileId);
  if (!rec) throw new Error('Datei nicht gefunden');
  const stored = await db.blobs.get(fileId);
  if (!stored?.blob) throw new Error('Dateiinhalt nicht gespeichert – bitte erneut importieren');
  const existingKeys = new Set();
  await db.transactions.each(t => { if (t.dedupeKey && t.fileId !== fileId) existingKeys.add(t.dedupeKey); });
  // KI-Hinweise der alten Dokumente merken; bei vom Nutzer gewähltem Typ ist ein KI-Typvorschlag/-grund überholt
  const keep = {};
  for (const d of await db.documents.where('fileId').equals(fileId).toArray()) {
    for (const k of AI_KEEP) if (d[k] != null && keep[k] == null && !(forceType && (k === 'aiSuggestion' || k === 'aiReason'))) keep[k] = d[k];
  }
  // Nutzerentscheidungen der Buchungen dieser Datei merken (Kategorie, Steuer, Umbuchung, Beleg, Notizen …)
  const oldDocIds = await db.documents.where('fileId').equals(fileId).primaryKeys();
  const oldTxs = oldDocIds.length ? await db.transactions.where('documentId').anyOf(oldDocIds).toArray() : [];
  const decided = [];
  for (const t of oldTxs) { const d = userDecisions(t); if (d) decided.push({ id: t.id, dedupeKey: t.dedupeKey, mk: txMatchKey(t), d }); }
  const meta = { name: rec.name, path: rec.path, ext: rec.ext || extOf(rec.name), mime: rec.mime || stored.blob.type || MIME[rec.ext] || 'application/octet-stream', size: rec.size };
  const signal = new AbortController().signal;
  // Erst lesen, dann alte Daten löschen: scheitert das Lesen (z. B. PDF-Leser abgestürzt), bleibt der bisherige Stand erhalten
  let pre;
  try { pre = await readFile(meta, stored.blob, signal, ocrBoost); } catch (e) {
    if (rec.status === 'error') await db.files.update(fileId, { error: errorText(e) }).catch(() => {});
    if (!app.progress.running) await terminateOcr().catch(() => {});
    throw e;
  }
  await purgeFileData(fileId, existingKeys);
  await db.files.update(fileId, { status: 'processing', error: null });
  try {
    await readAndSave(meta, stored.blob, fileId, { signal, existingKeys, forceType, ocrBoost, preExtracted: pre });
    if (decided.length) await restoreDecisions(fileId, decided);
    if (Object.keys(keep).length) {
      for (const d of await db.documents.where('fileId').equals(fileId).toArray()) {
        const patch = {};
        for (const [k, v] of Object.entries(keep)) if (d[k] == null) patch[k] = v;
        if (Object.keys(patch).length) await db.documents.update(d.id, patch);
      }
    }
  } catch (e) {
    await db.files.update(fileId, { status: 'error', error: errorText(e) }).catch(() => {});
    throw e;
  } finally {
    if (!app.progress.running) await terminateOcr().catch(() => {});
  }
  if (skipPost) return db.files.get(fileId);
  try { await postProcess(); } catch (e) { console.error(e); }
  await reload();
  return db.files.get(fileId);
}

/** Gemerkte Nutzerentscheidungen auf die neu gelesenen Buchungen übertragen; Verweise anderer Buchungen umhängen. */
async function restoreDecisions(fileId, decided) {
  const docIds = await db.documents.where('fileId').equals(fileId).primaryKeys();
  const fresh = docIds.length ? await db.transactions.where('documentId').anyOf(docIds).toArray() : [];
  const byKey = new Map(), byMk = new Map();
  for (const t of fresh) { if (t.dedupeKey) byKey.set(t.dedupeKey, t); if (!byMk.has(txMatchKey(t))) byMk.set(txMatchKey(t), t); }
  const idMap = new Map();
  const updates = [];
  for (const o of decided) {
    const t = (o.dedupeKey && byKey.get(o.dedupeKey)) || byMk.get(o.mk);
    if (!t || idMap.has(o.id)) continue;
    idMap.set(o.id, t.id);
    updates.push({ key: t.id, changes: o.d });
  }
  if (updates.length) await db.transactions.bulkUpdate(updates);
  // Andere Buchungen, die auf alte IDs zeigten (Umbuchungs-/Storno-Partner), auf die neuen IDs umstellen
  if (idMap.size) {
    const refs = [];
    await db.transactions.each(t => {
      const ch = {};
      if (t.transferPairId && idMap.has(t.transferPairId)) ch.transferPairId = idMap.get(t.transferPairId);
      if (t.stornoPairId && idMap.has(t.stornoPairId)) ch.stornoPairId = idMap.get(t.stornoPairId);
      if (Object.keys(ch).length) refs.push({ key: t.id, changes: ch });
    });
    if (refs.length) await db.transactions.bulkUpdate(refs);
  }
}

/**
 * Stand der Lese-Logik. Erhöhen, wenn Erkennung/Parser sich so ändern, dass alte Importe falsch sein können;
 * beim nächsten Start werden verdächtige Dateien dann automatisch neu gelesen (reprocessStale).
 */
export const PARSER_VERSION = 4;
const STATEMENT_DOC_TYPES = new Set(['kontoauszug', 'kreditkarte', 'paypal', 'depot']);

/** Dateien neu lesen (Nutzerwahl des Typs bleibt erhalten); Fortschritt in app.progress. → { done, failed } */
async function reprocessMany(fileIds, label) {
  let done = 0, failed = 0;
  Object.assign(app.progress, { running: true, phase: 'process', total: fileIds.length, done: 0, current: label });
  try {
    for (const id of fileIds) {
      const f = await db.files.get(id);
      const forceType = f?.detection?.forced ? f.detection.type : null;
      app.progress.current = `${label}: ${f?.name || id}`;
      try { await reprocessFile(id, { forceType, skipPost: true }); done++; } catch (e) { console.warn('Neu lesen', f?.name, e); failed++; }
      app.progress.done++;
    }
    try { await postProcess(); } catch (e) { console.error(e); }
  } finally {
    Object.assign(app.progress, { running: false, phase: 'done', current: '' });
    if (fileIds.length) await terminateOcr().catch(() => {});
    await reload();
  }
  return { done, failed };
}

/** Alle importierten Dateien neu einlesen (Einstellungen → „Alle Dateien neu einlesen“). */
export async function reprocessAll() {
  const ids = (await db.files.toArray()).filter(f => f.status === 'done' || f.status === 'ignored' || f.status === 'error').map(f => f.id);
  return reprocessMany(ids, 'Neu einlesen');
}

/**
 * Nach einem Update: nur verdächtige Altimporte neu lesen – Kontoumsatz-Dokumente ohne Buchungen und lange Dokumente
 * (mehr als 3 Seiten), die nicht als Kontoumsatz erkannt wurden (z. B. 69-seitiger DKB-Auszug als „Lohnabrechnung“),
 * ab Version 3 außerdem alle PDF-Kontoauszüge.
 * Läuft einmal je PARSER_VERSION.
 */
const STALE_V4_TYPES = new Set(['finanz_sonstiges', 'rechnung', 'steuerbescheinigung']);

export async function reprocessStale({ getSetting, setSetting }) {
  const stored = await getSetting('parserVersion', null);
  // Leere Datenbank (erster Start): alles wird ohnehin mit der aktuellen Version eingelesen
  if (stored == null && !(await db.files.count())) { await setSetting('parserVersion', PARSER_VERSION); return { done: 0, failed: 0 }; }
  const seen = stored ?? 1;
  if (seen >= PARSER_VERSION) return { done: 0, failed: 0 };
  const [docs, txs] = await Promise.all([db.documents.toArray(), db.transactions.toArray()]);
  const withTx = new Set(txs.map(t => t.fileId));
  const files = await db.files.toArray();
  const forced = new Set(files.filter(f => f.detection?.forced || f.detection?.typeSource === 'user').map(f => f.id));
  const nameOf = new Map(files.map(f => [f.id, f.name || '']));
  const ids = new Set();
  for (const d of docs) {
    if (!d.fileId) continue;
    if (STATEMENT_DOC_TYPES.has(d.type) && !withTx.has(d.fileId)) ids.add(d.fileId);
    else if (!STATEMENT_DOC_TYPES.has(d.type) && (d.pages || 0) > 3) ids.add(d.fileId);
    // Version 3: PDF-Kontoauszüge (Empfänger/IBAN/Zweck bei DKB & Co.) – Nutzerentscheidungen bleiben erhalten
    else if (seen < 3 && STATEMENT_DOC_TYPES.has(d.type) && (d.fields?.format === 'pdf_statement' || d.format === 'pdf_statement')) ids.add(d.fileId);
    // Version 4: Wertpapier-Dokumente (Abrechnung, Dividende, Kosteninformation, Depot-Reporting), DKB Soll/Haben,
    // comdirect Finanzreport – bisher oft „Sonstiges“, „Rechnung“ oder „Steuerbescheinigung“. Vom Nutzer gesetzte Typen bleiben.
    else if (seen < 4 && STALE_V4_TYPES.has(d.type) && d.typeSource !== 'user' && !forced.has(d.fileId) && d.text
      && detectType({ kind: 'pdf', ocr: !!d.ocr, text: d.text }, { name: nameOf.get(d.fileId) || '' }).type !== d.type) ids.add(d.fileId);
  }
  const res = ids.size ? await reprocessMany([...ids], 'Nach Update neu einlesen') : { done: 0, failed: 0 };
  await setSetting('parserVersion', PARSER_VERSION);
  return res;
}

const readFile = (meta, blob, signal, boost) => extract(meta, blob, {
  signal, ocrBoost: boost,
  onProgress: (v, label) => { app.progress.current = `${meta.name} – ${boost ? 'zweiter Versuch: ' : ''}${label || ''} ${v ? Math.round(v * 100) + ' %' : ''}`; },
});

async function readAndSave(meta, blob, hash, { signal, existingKeys, forceType = null, ocrBoost = false, preExtracted = null }) {
  const read = (boost) => readFile(meta, blob, signal, boost);
  let extracted = preExtracted || await read(ocrBoost);
  if (extracted.thumbnail) await db.blobs.put({ id: 'thumb:' + hash, blob: extracted.thumbnail });

  let detection;
  if (forceType) {
    // Vom Nutzer gewählter Typ: direkt übernehmen, ohne erneute Erkennung und ohne KI. Nur Kontoumsatz-Typen brauchen
    // das erkannte Format (Parser) – das wird übernommen, wenn die Erkennung denselben Typ liefert.
    // Kontoumsatz-Typen: Format direkt aus dem Kontoumsatz-Modul (ohne Abgleich mit Dokument-Stichwörtern); findet es
    // nichts, entscheidet die Dateiart (PDF/Bild → PDF-Auszug, Tabelle → generische CSV).
    let st = null;
    if (STATEMENT_TYPES.has(forceType)) {
      st = detectStatementFormat(extracted, meta) || { format: extracted.rows ? 'generic_csv' : 'pdf_statement', institution: null, lenient: true };
    }
    detection = {
      type: forceType, subtype: null, institution: st?.institution ?? null, format: st?.format ?? null, lenient: !!st?.lenient,
      confidence: 1, signals: ['vom Nutzer gewählt'], alternatives: [], uncertain: false, forced: true, typeSource: 'user',
    };
  } else {
    detection = detectType(extracted, meta);
    // Unlesbarer Beleg: automatisch ein zweiter OCR-Versuch mit höherer Auflösung
    if (detection.unreadable && !ocrBoost) {
      signal.throwIfAborted();
      const again = await read(true);
      const second = detectType(again, meta);
      if (!second.unreadable || (again.ocrConfidence ?? -1) > (extracted.ocrConfidence ?? -1)) { extracted = again; detection = second; }
    }
    if (aiHooks.detect && detection.confidence < 0.55 && extracted.text?.length > 40) {
      detection = (await aiHooks.detect(extracted, meta, detection, { signal })) || detection;
    }
  }
  if (detection.type === 'irrelevant') {
    const ocrLow = !!extracted.ocr && typeof extracted.ocrConfidence === 'number' && extracted.ocrConfidence < 55;
    await db.files.update(hash, { status: 'ignored', detection: { ...detection, ocrLow } });
    count('irrelevant');
    return;
  }
  let result = await parse(detection, extracted, meta);
  if (aiHooks.parse && result.document?.needsReview) {
    result = (await aiHooks.parse(detection, extracted, meta, result, { signal })) || result;
  }
  signal.throwIfAborted();
  if (detection.typeSource === 'ai' && result.document) {
    // Typ von der KI bestimmt: kenntlich machen, Begründung/Alternativen übernehmen
    const doc = result.document;
    doc.typeSource = 'ai';
    doc.aiReason ??= detection.aiReason;
    if (!doc.alternatives?.length) doc.alternatives = detection.alternatives || [];
    if (detection.needsReview) {
      const why = 'KI hat den Dokumenttyp bestimmt – bitte prüfen';
      doc.needsReview = true;
      doc.reviewReason = doc.reviewReason ? `${doc.reviewReason}; ${why}` : why;
    }
  }
  await saveResult(result, { fileId: hash, meta, extracted, detection, existingKeys });
  // Mehrere Konten/Abschnitte in einer Datei (z. B. comdirect Giro + Visa, mehrere camt-Statements)
  for (const extra of result.additional || []) await saveResult(extra, { fileId: hash, meta, extracted, detection, existingKeys });
  await db.files.update(hash, { status: 'done', error: null, detection: { type: detection.type, subtype: detection.subtype ?? null, format: detection.format, institution: detection.institution, confidence: detection.confidence, forced: !!detection.forced, typeSource: detection.typeSource ?? null, variant: detection.variant ?? null } });
  count(detection.type);
}

function count(type) { app.progress.counts[type] = (app.progress.counts[type] || 0) + 1; }

let accountLock = Promise.resolve();
/** Serialisiert: parallele Worker dürfen dasselbe Konto nicht doppelt anlegen */
function upsertAccount(acc) {
  const run = accountLock.then(() => upsertAccountUnsafe(acc));
  accountLock = run.catch(() => null);
  return run;
}
const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const REVIEW_ACCOUNT = 'Konto zugeordnet? bitte prüfen';

/**
 * Konto suchen oder anlegen → { id, review }. IBAN gleich → dasselbe Konto. Ohne IBAN auf einer Seite nur
 * zusammenführen, wenn Kontonummer oder Name passen und kein IBAN-Konflikt besteht; gibt es nur unsichere
 * Kandidaten derselben Bank/Art, wird ein eigenes Konto angelegt und das Dokument zur Prüfung markiert.
 */
async function upsertAccountUnsafe(acc) {
  if (!acc) return { id: null, review: null };
  const all = await db.accounts.toArray();
  const iban = normalizeIban(acc.iban);
  const noConflict = (a) => !iban || !a.iban || normalizeIban(a.iban) === iban;
  const matches = (a) => (acc.number && sameText(a.number, acc.number)) || sameText(a.name, acc.name);
  let found = iban ? all.find(a => normalizeIban(a.iban) === iban) : null;
  if (!found && acc.number) found = all.find(a => a.number && a.number === acc.number && a.institution === acc.institution && noConflict(a));
  const sameBank = all.filter(a => a.kind === acc.kind && a.institution && a.institution === acc.institution);
  let review = null;
  if (!found) {
    // Kein IBAN im neuen Dokument (z. B. PDF) → passendes Konto derselben Bank/Art; neues Dokument mit IBAN → nur Konten ohne IBAN
    const pool = iban ? sameBank.filter(a => !a.iban) : sameBank;
    const hits = pool.filter(a => matches(a) && noConflict(a));
    if (hits.length === 1) found = hits[0];
    else if (hits.length > 1) { found = hits.find(a => !a.iban) || hits[0]; review = REVIEW_ACCOUNT; }
    else if (pool.length) review = REVIEW_ACCOUNT; // Kandidaten ohne Treffer: eigenes Konto, aber nachfragen
  }
  if (found) {
    const patch = {};
    for (const k of ['iban', 'name', 'number', 'currency', 'owner']) if (!found[k] && acc[k]) patch[k] = acc[k];
    if (Object.keys(patch).length) await db.accounts.update(found.id, patch);
    return { id: found.id, review };
  }
  const id = uid('acc_');
  await db.accounts.put({ id, own: true, currency: 'EUR', ...acc, iban: iban || null, createdAt: new Date().toISOString() });
  return { id, review };
}

const OWNER_RE = /(?:Kontoinhaber(?:in)?|Kunde|Inhaber(?:in)?|Depotinhaber)\s*[:;]\s*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}?)(?=\s*(?:[,;\n]|$))/m;

export async function saveResult(result, { fileId, meta, extracted, existingKeys }) {
  if (result.account && !result.account.owner) {
    const m = OWNER_RE.exec((extracted.rawText || extracted.text || '').slice(0, 4000));
    if (m) result.account.owner = m[1].trim();
  }
  const { id: accountId, review: accountReview } = await upsertAccount(result.account);
  const docId = uid('doc_');
  const d = { ...(result.document || {}) };
  if (accountReview) { d.needsReview = true; d.reviewReason = d.reviewReason ? `${d.reviewReason}; ${accountReview}` : accountReview; }
  const doc = {
    ...d,
    id: docId, fileId, accountId,
    currency: d.currency || 'EUR',
    text: (extracted.text || extracted.rawText || '').slice(0, 200000),
    ocr: !!extracted.ocr, ocrConfidence: extracted.ocrConfidence ?? null,
    pages: extracted.meta?.pageCount || extracted.pages?.length || null,
    tags: d.tags || [],
    taxRelevant: d.taxRelevant ?? false,
    taxReason: d.taxReason ?? null,
    needsReview: !!d.needsReview,
    payroll: result.payroll || null,
    vat: result.vat || null,
    balance: result.balance || null,
    createdAt: new Date().toISOString(),
  };
  doc.displayName = d.displayName || displayName(doc, meta.ext);
  await db.documents.put(doc);
  app.progress.newDocs++;

  // Dubletten über Formate hinweg (CSV + PDF + camt desselben Kontos): gleiches Konto, Datum, Betrag – mit Vielfachheit
  const existingCount = new Map();
  const existingByKey = new Map(); // für das Ergänzen fehlender Felder (z. B. IBAN aus camt, wenn CSV zuerst kam)
  if (accountId && result.transactions?.length) {
    for (const t of await db.transactions.where('accountId').equals(accountId).toArray()) {
      const k = t.bookingDate + '|' + t.amount;
      existingCount.set(k, (existingCount.get(k) || 0) + 1);
      if (!existingByKey.has(k)) existingByKey.set(k, []);
      existingByKey.get(k).push(t);
    }
  }
  const ENRICH = ['counterpartyIban', 'mandateId', 'creditorId', 'endToEndId', 'gvc', 'valueDate'];
  const enrich = [];
  const txs = [];
  for (const t of result.transactions || []) {
    const key = t.dedupeKey;
    const dk = t.bookingDate + '|' + t.amount;
    const sameKey = !!key && existingKeys.has(key);
    if (sameKey || (existingCount.get(dk) || 0) > 0) {
      // Gleicher Schlüssel: genau diese Buchung ergänzen; sonst die nächste gleich datierte mit gleichem Betrag
      const list = existingByKey.get(dk) || [];
      const i = sameKey ? list.findIndex(x => x.dedupeKey === key) : 0;
      const ex = i >= 0 ? list.splice(i, 1)[0] : null;
      if (ex) existingCount.set(dk, Math.max(0, (existingCount.get(dk) || 0) - 1));
      const patch = {};
      if (ex) for (const f of ENRICH) if (!ex[f] && t[f]) patch[f] = t[f];
      // Dublette: entweder ergänzt sie eine bestehende Buchung oder sie wird übersprungen
      if (Object.keys(patch).length) { enrich.push({ key: ex.id, changes: patch }); app.progress.enrichedTx++; } else app.progress.dupTx++;
      continue;
    }
    if (key) existingKeys.add(key);
    txs.push({ ...t, id: uid('tx_'), accountId, documentId: docId, fileId, currency: t.currency || 'EUR', taxRelevant: t.taxRelevant ?? false, needsReview: t.needsReview ?? false });
  }
  if (txs.length) await db.transactions.bulkPut(txs);
  if (enrich.length) await db.transactions.bulkUpdate(enrich);
  app.progress.newTx += txs.length;
  if (result.lineItems?.length) await db.lineItems.bulkPut(result.lineItems.slice(0, MAX_LINE_ITEMS).map(l => ({ ...l, id: uid('li_'), documentId: docId })));
  if (result.holdings?.length) await db.holdings.bulkPut(result.holdings.map(h => ({ ...h, id: uid('h_'), accountId, documentId: docId, date: h.date || d.date })));
  if (result.valuations?.length && accountId) await db.valuations.bulkPut(result.valuations.map(v => ({ ...v, id: uid('v_'), accountId, documentId: docId })));
}
