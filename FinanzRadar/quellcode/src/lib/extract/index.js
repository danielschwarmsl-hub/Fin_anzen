// Inhaltsextraktion: liefert pro Datei das Objekt `Extracted` (siehe SPEC.md).
// Parsen, Tabellen und XML laufen in Node (Vitest). Rendern, OCR und Vorschauen nur im Browser.
import { extOf } from '../util/format.js';
import { decodeText, parseCsv } from './decode.js';
import { extractPdfText, closePdf, releasePdfWorker, restartPdfWorker, pdfWorkerSlot, guardPdf } from './pdf.js';
import { withWorkerRetry, isPdfWorkerFailure } from './pdf-reader.js';
import { recognizeCanvas, terminateOcr as stopOcr } from './ocr.js';
import { makeCanvas, canvasToBlob, enhanceCanvas, imageToOcrCanvas, thumbnailBlob, releaseCanvas, THUMB_WIDTH } from './canvas.js';

export { isPdfWorkerFailure } from './pdf-reader.js';

/**
 * Hintergrund-Worker nach dem Import freigeben: OCR sofort, den gemeinsamen PDF-Leser, sobald kein Dokument mehr offen
 * ist (eine geöffnete Vorschau bleibt nutzbar).
 */
export async function terminateOcr() {
  releasePdfWorker();
  await stopOcr();
}

const isBrowser = typeof window !== 'undefined';
const OCR_SCALE = 2;          // Render-Skalierung für Scan-Seiten (Pixel je pt)
const OCR_BOOST_SCALE = 3;    // zweiter Versuch bei unlesbaren Scans: höhere Auflösung
const BOOST_MIN_WIDTH = 2000; // Bilder: Mindestbreite im zweiten Versuch (statt 1000)
const BOOST_MAX_SIDE = 4800;  // Bilder: Obergrenze lange Kante im zweiten Versuch (statt 3200)
const MAX_PLAIN_TEXT = 1_000_000; // Zeichen
const SCAN_MIN_ITEMS = 5;     // weniger Textitems je Seite → Scan
const RENDER_TIMEOUT = 120_000; // ms je gerenderter Seite (OCR/Vorschaubild); danach gilt der PDF-Leser als hängend
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif']);
const HEIC_EXT = new Set(['heic', 'heif']);
const STATEMENT_TEXT_EXT = new Set(['sta', 'mt940', '940']);
const ATTACHMENT_RE = /factur-x|zugferd|xrechnung|\.xml$/i;
const PREFERRED_ATTACHMENT_RE = /factur-x|zugferd|xrechnung/i;
const FINANCE_WORDS = ['betrag', 'summe', 'iban', 'rechnung', 'mwst', 'konto', 'saldo', 'beitrag', 'versicherung',
  'gehalt', 'brutto', 'netto', 'steuer', 'umsatz', 'buchung', 'kontoauszug', 'lohn', 'depot', 'zahlung', 'gesamtbetrag'];

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Vorgang abgebrochen', 'AbortError');
}

function emptyResult(kind, patch = {}) {
  return {
    kind, text: '', pages: [], rows: null, rawText: null, xml: null,
    ocr: false, ocrConfidence: null, thumbnail: null,
    meta: { pageCount: null, encoding: null, delimiter: null },
    ...patch,
  };
}

/** Tabellarisch? Mind. 3 Zeilen, Trennzeichen in fast allen Zeilen gleich häufig. */
export function looksTabular(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  if (lines.length < 3) return false;
  for (const d of [';', '\t', '|', ',']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const counter = new Map();
    for (const c of counts) counter.set(c, (counter.get(c) || 0) + 1);
    const [mode, freq] = [...counter.entries()].sort((a, b) => b[1] - a[1])[0];
    const minCols = d === ',' ? 2 : 1;
    if (mode >= minCols && freq / lines.length >= 0.8) return true;
  }
  return false;
}

/** Magic-Bytes für Dateien ohne bekannte Endung. */
function sniffKind(u8) {
  const s4 = String.fromCharCode(...u8.subarray(0, 4));
  if (s4 === '%PDF') return 'pdf';
  if (u8[0] === 0x89 && s4.slice(1) === 'PNG') return 'image';
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image';
  if ((u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 0x2a) || (u8[0] === 0x4d && u8[1] === 0x4d && u8[2] === 0x2a)) return 'image';
  if (s4 === 'RIFF' && String.fromCharCode(...u8.subarray(8, 12)) === 'WEBP') return 'image';
  if (u8[0] === 0x50 && u8[1] === 0x4b) return 'unsupported'; // ZIP-Container ohne bekannte Endung
  return null;
}

/** Art der Datei: pdf | image | xlsx | csv | xml | text | auto (Text, Art wird am Inhalt entschieden) | unsupported */
function resolveKind(fileMeta, u8) {
  const ext = String(fileMeta.ext || extOf(fileMeta.name) || '').toLowerCase().replace(/^\./, '');
  const mime = String(fileMeta.mime || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image';
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return 'xlsx';
  if (ext === 'csv' || ext === 'tsv' || mime === 'text/csv') return 'csv';
  if (ext === 'xml' || mime === 'application/xml' || mime === 'text/xml') return 'xml';
  if (STATEMENT_TEXT_EXT.has(ext) || ext === 'md') return 'text';
  if (ext === 'txt' || ext === 'text') return 'auto';
  return sniffKind(u8) || 'auto';
}

function decodeTable(bytes, delimiter) {
  const { text, encoding } = decodeText(bytes);
  const parsed = parseCsv(text, delimiter);
  return { text, encoding, delimiter: parsed.delimiter, rows: parsed.rows.filter((r) => r.some((c) => c !== '')) };
}

async function extractXlsx(bytes) {
  const mod = await import('xlsx');
  const XLSX = mod.default ?? mod;
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const rows = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    // Datumszellen einheitlich als dd.mm.yyyy (sheet_to_json übernimmt dateNF nur bei raw:true)
    for (const addr of Object.keys(ws)) {
      const c = ws[addr];
      if (addr[0] !== '!' && c && c.t === 'd' && c.v instanceof Date && !Number.isNaN(c.v.getTime())) {
        const v = c.v;
        c.w = `${String(v.getUTCDate()).padStart(2, '0')}.${String(v.getUTCMonth() + 1).padStart(2, '0')}.${v.getUTCFullYear()}`;
      }
    }
    const sheetRows = XLSX.utils.sheet_to_json(ws, {
      header: 1, raw: false, defval: '', dateNF: 'dd.mm.yyyy',
    });
    if (i > 0 && rows.length) rows.push([]); // Leerzeile zwischen Blättern
    for (const r of sheetRows) {
      const cells = r.map((c) => String(c ?? '').trim());
      if (cells.some((c) => c !== '')) rows.push(cells);
    }
  });
  return emptyResult('xlsx', { text: rows.map((r) => r.join('\t')).join('\n'), rows });
}

async function heicToJpeg(blob) {
  const mod = await import('heic2any');
  const heic2any = mod.default ?? mod;
  const res = await heic2any({ blob, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(res) ? res[0] : res;
}

async function safely(fn) {
  try { return await fn(); } catch (e) { console.warn('extract:', e?.message || e); return null; }
}

/** OCR einer Scan-Seite: rendern (Skalierung OCR_SCALE), aufhellen, erkennen. */
async function ocrPdfPage(doc, n, progressFor, scale = OCR_SCALE) {
  const page = await guardPdf(doc, doc.getPage(n), RENDER_TIMEOUT, `Seite ${n}`);
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  try {
    await renderPage(doc, page, canvas, viewport, `OCR Seite ${n}`);
  } catch (e) { releaseCanvas(canvas); throw e; }
  page.cleanup?.();
  enhanceCanvas(canvas);
  try { return await recognizeCanvas(canvas, { unit: scale, onProgress: progressFor }); } finally { releaseCanvas(canvas); }
}

/** Seite rendern mit Zeitlimit – ein hängender/abgestürzter Worker antwortet sonst nie. */
async function renderPage(doc, page, canvas, viewport, label) {
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
  await guardPdf(doc, task.promise, RENDER_TIMEOUT, label, () => task.cancel?.());
}

async function pdfThumbnail(doc) {
  const page = await guardPdf(doc, doc.getPage(1), RENDER_TIMEOUT, 'Vorschaubild');
  const scale = THUMB_WIDTH / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = makeCanvas(viewport.width, viewport.height);
  try {
    await renderPage(doc, page, canvas, viewport, 'Vorschaubild');
    page.cleanup?.();
    return await canvasToBlob(canvas, 'image/jpeg', 0.75);
  } catch (e) {
    if (isPdfWorkerFailure(e)) restartPdfWorker(pdfWorkerSlot(doc)); // Vorschaubild ist optional, der Leser aber kaputt
    throw e;
  } finally { releaseCanvas(canvas); }
}

/**
 * PDF lesen (Text, OCR für Scan-Seiten, E-Rechnungs-Anhang, Vorschaubild). Fällt der PDF-Leser unterwegs aus,
 * wird er neu gestartet und die Datei einmal komplett neu gelesen; erst dann kommt ein Klartext-Fehler.
 */
async function extractPdf(bytes, opts, progress) {
  let slot = null;
  return withWorkerRetry((attempt) => extractPdfOnce(bytes, opts, attempt ? (p, label) => progress(p, `neuer Versuch: ${label || ''}`) : progress, (s) => { slot = s; }), {
    restart: () => restartPdfWorker(slot),
    onRetry: (e) => console.warn('PDF-Leser ausgefallen – neuer Versuch:', e?.message || e),
  });
}

async function extractPdfOnce(bytes, opts, progress, onSlot) {
  progress(0.02, 'PDF lesen');
  const { doc, pages, pageCount, attachments } = await extractPdfText(bytes);
  onSlot(pdfWorkerSlot(doc));
  try {
    const canOcr = isBrowser && opts.ocr !== false;
    const outPages = [];
    const confidences = [];
    let ocrUsed = false;
    for (let idx = 0; idx < pages.length; idx++) {
      checkAbort(opts.signal);
      const p = pages[idx];
      let { text, lines } = p;
      const itemCount = lines.reduce((n, l) => n + l.items.length, 0);
      if (canOcr && itemCount < SCAN_MIN_ITEMS) {
        const progressFor = (f, label) => progress(0.05 + 0.9 * ((idx + f) / pages.length), `OCR Seite ${p.n}: ${label || ''}`);
        const r = await ocrPdfPage(doc, p.n, progressFor, opts.ocrBoost ? OCR_BOOST_SCALE : OCR_SCALE);
        if (r.text.trim()) {
          text = r.text;
          lines = r.lines;
          ocrUsed = true;
          if (r.confidence != null) confidences.push(r.confidence);
        }
      }
      outPages.push({ n: p.n, text, lines });
    }
    checkAbort(opts.signal);

    // Eingebettete E-Rechnung (ZUGFeRD/Factur-X/XRechnung) bevorzugen
    const candidates = attachments
      .filter((a) => ATTACHMENT_RE.test(a.name || '') && a.content?.length)
      .sort((a, b) => Number(!PREFERRED_ATTACHMENT_RE.test(a.name)) - Number(!PREFERRED_ATTACHMENT_RE.test(b.name)));
    let xml = null;
    for (const a of candidates) {
      const t = decodeText(a.content).text;
      if (t.trim()) { xml = t; break; }
    }

    const thumbnail = isBrowser ? await safely(() => pdfThumbnail(doc)) : null;
    progress(1, 'fertig');
    return emptyResult('pdf', {
      text: outPages.map((p) => p.text).join('\n\f\n'),
      pages: outPages,
      xml,
      ocr: ocrUsed,
      ocrConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
      thumbnail,
      meta: { pageCount, encoding: null, delimiter: null },
    });
  } finally {
    await closePdf(doc);
  }
}

async function extractImage(blob, fileMeta, opts, progress) {
  const out = emptyResult('image', { meta: { pageCount: 1, encoding: null, delimiter: null } });
  if (!isBrowser) return out; // Node: keine Bilddekodierung

  const ext = String(fileMeta.ext || extOf(fileMeta.name) || '').toLowerCase();
  let source = blob;
  if (HEIC_EXT.has(ext) || /heic|heif/.test(fileMeta.mime || '')) {
    progress(0.03, 'HEIC umwandeln');
    source = await heicToJpeg(blob);
  }
  let bmp;
  try {
    bmp = await createImageBitmap(source);
  } catch {
    return out; // Format im Browser nicht dekodierbar (z. B. TIFF)
  }
  try {
    out.thumbnail = await safely(() => thumbnailBlob(bmp));
    if (opts.ocr !== false) {
      checkAbort(opts.signal);
      progress(0.1, 'Bild aufbereiten');
      const { canvas, unit } = opts.ocrBoost ? imageToOcrCanvas(bmp, BOOST_MIN_WIDTH, BOOST_MAX_SIDE) : imageToOcrCanvas(bmp);
      let r;
      try { r = await recognizeCanvas(canvas, { unit, onProgress: (f, label) => progress(0.1 + 0.85 * f, label) }); } finally { releaseCanvas(canvas); }
      out.text = r.text;
      out.pages = [{ n: 1, text: r.text, lines: r.lines }];
      out.ocr = true;
      out.ocrConfidence = r.confidence;
    }
  } finally {
    bmp.close?.();
  }
  progress(1, 'fertig');
  return out;
}

/** Text-Varianten (xml, sta/mt940, txt/md, unbekannt) ohne Bild/PDF. */
function extractText(bytes, kind, ext) {
  if (kind === 'csv') {
    const t = decodeTable(bytes, ext === 'tsv' ? '\t' : undefined);
    return emptyResult('csv', {
      text: t.text, rawText: t.text, rows: t.rows,
      meta: { pageCount: null, encoding: t.encoding, delimiter: t.delimiter },
    });
  }
  let { text, encoding } = decodeText(bytes);
  // Reiner Fließtext (Notizen, Logs …) wird nur begrenzt gelesen; Kontoauszüge (xml, sta/mt940) und Tabellen bleiben vollständig
  if (kind === 'text' && !STATEMENT_TEXT_EXT.has(ext) && text.length > MAX_PLAIN_TEXT) text = text.slice(0, MAX_PLAIN_TEXT);
  return emptyResult(kind, {
    text, rawText: text, xml: kind === 'xml' ? text : null,
    meta: { pageCount: null, encoding, delimiter: null },
  });
}

/**
 * Extrahiert Inhalt einer Datei.
 * @param fileMeta { name, path, ext, mime, size }
 * @param blob Blob/File mit dem Dateiinhalt
 * @param opts { onProgress?(p0to1, label), signal?, ocr?, ocrBoost? } – ocrBoost: zweiter OCR-Versuch mit höherer Auflösung
 * @returns Extracted (SPEC.md)
 */
export async function extract(fileMeta = {}, blob, opts = {}) {
  const progress = (p, label) => opts.onProgress?.(Math.max(0, Math.min(1, p)), label);
  checkAbort(opts.signal);
  progress(0, 'Lesen');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkAbort(opts.signal);
  const ext = String(fileMeta.ext || extOf(fileMeta.name) || '').toLowerCase().replace(/^\./, '');

  let kind = resolveKind(fileMeta, bytes);
  if (kind === 'auto') {
    const probe = bytes.subarray(0, 4096);
    if (probe.includes(0)) kind = 'unsupported';
    else {
      const { text } = decodeText(bytes);
      if (/^\s*<\?xml|^\s*<[A-Za-z]/.test(text)) kind = 'xml';
      else kind = looksTabular(text) ? 'csv' : 'text';
    }
  }

  switch (kind) {
    case 'pdf': return extractPdf(bytes, opts, progress);
    case 'image': return extractImage(blob, fileMeta, opts, progress);
    case 'xlsx': return extractXlsx(bytes);
    case 'csv': return extractText(bytes, 'csv', ext);
    case 'xml': return extractText(bytes, 'xml', ext);
    case 'text': return extractText(bytes, 'text', ext);
    default: return emptyResult('unsupported');
  }
}

/** Schnelle Heuristik: wie wahrscheinlich ist der Text ein Finanzdokument? 0..1 */
export function isLikelyFinanceText(text) {
  if (!text) return 0;
  const t = String(text);
  const low = t.toLowerCase();
  let hits = FINANCE_WORDS.filter((w) => low.includes(w)).length;
  if (/\bEUR\b|€/.test(t)) hits++;
  if (/\d{1,3}(?:\.\d{3})*,\d{2}\b/.test(t)) hits++;
  return Math.min(1, hits / 4);
}
