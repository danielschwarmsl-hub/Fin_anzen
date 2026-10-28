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

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/plain', xml: 'application/xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', sta: 'text/plain', mt940: 'text/plain' };

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
  Object.assign(p, { running: true, paused: false, total: 0, done: 0, current: 'Dateien werden gesammelt …', phase: 'collect', errors: [], counts: {}, startedAt: Date.now(), log: [], skipped: 0, newDocs: 0, newTx: 0 });
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
      if (f.status !== 'done' && f.status !== 'ignored') return;
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
  if (dup && (dup.status === 'done' || dup.status === 'ignored')) {
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

async function readAndSave(meta, blob, hash, { signal, existingKeys }) {
  const extracted = await extract(meta, blob, {
    signal,
    onProgress: (v, label) => { app.progress.current = `${meta.name} – ${label || ''} ${v ? Math.round(v * 100) + ' %' : ''}`; },
  });
  if (extracted.thumbnail) await db.blobs.put({ id: 'thumb:' + hash, blob: extracted.thumbnail });

  let detection = detectType(extracted, meta);
  if (aiHooks.detect && detection.confidence < 0.55 && extracted.text?.length > 40) {
    detection = (await aiHooks.detect(extracted, meta, detection, { signal })) || detection;
  }
  if (detection.type === 'irrelevant') {
    await db.files.update(hash, { status: 'ignored', detection });
    count('irrelevant');
    return;
  }
  let result = await parse(detection, extracted, meta);
  if (aiHooks.parse && result.document?.needsReview) {
    result = (await aiHooks.parse(detection, extracted, meta, result, { signal })) || result;
  }
  signal.throwIfAborted();
  await saveResult(result, { fileId: hash, meta, extracted, detection, existingKeys });
  // Mehrere Konten/Abschnitte in einer Datei (z. B. comdirect Giro + Visa, mehrere camt-Statements)
  for (const extra of result.additional || []) await saveResult(extra, { fileId: hash, meta, extracted, detection, existingKeys });
  await db.files.update(hash, { status: 'done', error: null, detection: { type: detection.type, format: detection.format, institution: detection.institution, confidence: detection.confidence } });
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
async function upsertAccountUnsafe(acc) {
  if (!acc) return null;
  const all = await db.accounts.toArray();
  const iban = normalizeIban(acc.iban);
  let found = iban ? all.find(a => normalizeIban(a.iban) === iban) : null;
  if (!found && acc.number) found = all.find(a => a.number && a.number === acc.number && a.institution === acc.institution);
  const sameBank = all.filter(a => a.kind === acc.kind && a.institution && a.institution === acc.institution);
  // Kein IBAN im neuen Dokument (z. B. PDF): eindeutiges Konto derselben Bank und Art übernehmen
  if (!found && !iban) found = sameBank.length === 1 ? sameBank[0] : sameBank.find(a => (a.name || '') === (acc.name || '') && !a.iban) || null;
  // Neues Dokument hat IBAN, bisher genau ein Konto derselben Bank/Art ohne IBAN → zusammenführen
  if (!found && iban) { const noIban = sameBank.filter(a => !a.iban); if (noIban.length === 1 && sameBank.length === 1) found = noIban[0]; }
  if (found) {
    const patch = {};
    for (const k of ['iban', 'name', 'number', 'currency', 'owner']) if (!found[k] && acc[k]) patch[k] = acc[k];
    if (Object.keys(patch).length) await db.accounts.update(found.id, patch);
    return found.id;
  }
  const id = uid('acc_');
  await db.accounts.put({ id, own: true, currency: 'EUR', ...acc, iban: iban || null, createdAt: new Date().toISOString() });
  return id;
}

const OWNER_RE = /(?:Kontoinhaber(?:in)?|Kunde|Inhaber(?:in)?|Depotinhaber)\s*[:;]\s*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{2,40}?)(?=\s*(?:[,;\n]|$))/m;

async function saveResult(result, { fileId, meta, extracted, existingKeys }) {
  if (result.account && !result.account.owner) {
    const m = OWNER_RE.exec((extracted.rawText || extracted.text || '').slice(0, 4000));
    if (m) result.account.owner = m[1].trim();
  }
  const accountId = await upsertAccount(result.account);
  const docId = uid('doc_');
  const d = result.document || {};
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
    if (key && existingKeys.has(key)) continue;
    const dk = t.bookingDate + '|' + t.amount;
    if ((existingCount.get(dk) || 0) > 0) {
      existingCount.set(dk, existingCount.get(dk) - 1);
      const ex = existingByKey.get(dk)?.shift();
      if (ex) { const patch = {}; for (const f of ENRICH) if (!ex[f] && t[f]) patch[f] = t[f]; if (Object.keys(patch).length) enrich.push({ key: ex.id, changes: patch }); }
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
