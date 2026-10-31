// PDF-Textextraktion mit Zeilen-Rekonstruktion. Läuft im Browser (Worker) und in Node (legacy build).
// Browser: EIN gemeinsamer pdf.js-Worker für alle Dokumente (Import, Vorschau, OCR) statt eines neuen je Datei.
// Früher startete pdf.js je Datei einen Worker; scheiterte ein Start (Firefox unter Last), schaltete pdf.js dauerhaft auf
// einen „Fake-Worker“ im Hauptthread um, der an unserem Worker-Einstieg scheiterte („Setting up fake worker failed“) –
// danach war kein PDF mehr lesbar. Jetzt: Worker selbst starten (mit Wiederholung), bei Absturz neu starten, und nur
// wenn gar kein Web-Worker startet, den PDF-Leser im Hauptthread laden (funktionsfähiger Rückfall).
import { createWorkerHolder, withWorkerRetry, withTimeout, raceSlot, isPdfWorkerFailure } from './pdf-reader.js';

let pdfjsPromise = null;
let workerUrl = null;
const isNode = typeof window === 'undefined';

const READY_TIMEOUT = 20_000;  // ms bis der Web-Worker „ready“ meldet
const OPEN_TIMEOUT = 90_000;   // ms für getDocument (auch im Hauptthread-Rückfall großzügig)
const PAGE_TIMEOUT = 60_000;   // ms je Seite für getPage/getTextContent
const CLOSE_TIMEOUT = 5_000;   // ms für loadingTask.destroy – ein toter Worker antwortet nie auf „Terminate“
const START_ATTEMPTS = 2;      // Web-Worker-Startversuche, danach Rückfall im Hauptthread

export async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (isNode) {
        const spec = 'pdfjs-dist/legacy/build/pdf.mjs'; // nur Node/Vitest – nicht ins Browser-Bundle
        const lib = await import(/* @vite-ignore */ spec);
        return lib;
      }
      await import('./pdf-polyfills.js');
      const lib = await import('pdfjs-dist');
      // Eigener Worker-Einstieg (mit Polyfills) statt direkt pdf.worker.min.mjs. workerSrc wird nur gesetzt, damit pdf.js
      // gültig konfiguriert ist – gestartet wird der Worker hier selbst (createSharedWorker), nie von pdf.js.
      workerUrl = (await import('./pdf-worker.js?worker&url')).default;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    })();
  }
  return pdfjsPromise;
}

/** Web-Worker starten und auf die „ready“-Meldung von pdf.js warten (Fehler-Event/Zeitlimit → Ablehnung). */
function startWebWorker(url) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(url, { type: 'module' }); } catch (e) { reject(e); return; }
    const onMsg = (ev) => {
      const d = ev.data;
      if (d && d.sourceName === 'worker' && d.action === 'ready') { cleanup(); resolve(w); }
    };
    const onErr = (ev) => fail(new Error('PDF-Worker konnte nicht starten' + (ev?.message ? `: ${ev.message}` : '')));
    const timer = setTimeout(() => fail(new Error('PDF-Worker startet nicht (Zeitüberschreitung)')), READY_TIMEOUT);
    function cleanup() { clearTimeout(timer); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); }
    function fail(e) { cleanup(); try { w.terminate(); } catch { /* egal */ } reject(e); }
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
  });
}

/**
 * Rückfall: den Worker-Einstieg im Hauptthread laden. pdf.worker setzt dabei globalThis.pdfjsWorker = { WorkerMessageHandler };
 * damit richtet pdf.js seinen Fake-Worker ein, ohne selbst import(workerSrc) zu versuchen (dort fehlt der Export).
 */
async function loadMainThreadWorker() {
  if (!globalThis.pdfjsWorker?.WorkerMessageHandler) {
    const mod = await import(/* @vite-ignore */ workerUrl);
    if (mod?.WorkerMessageHandler && !globalThis.pdfjsWorker?.WorkerMessageHandler) {
      globalThis.pdfjsWorker = { WorkerMessageHandler: mod.WorkerMessageHandler }; // Dev-Server: Export statt Seiteneffekt
    }
  }
  if (!globalThis.pdfjsWorker?.WorkerMessageHandler) throw new Error('PDF-Leser im Hauptthread nicht verfügbar');
}

/** Gemeinsamen Worker erzeugen: Web-Worker (mit Wiederholung), sonst Hauptthread. → { pdfWorker, web, fake } */
async function createSharedWorker(markDead) {
  const pdfjs = await getPdfjs();
  let lastErr = null;
  if (typeof Worker === 'function') {
    for (let i = 0; i < START_ATTEMPTS; i++) {
      try {
        const web = await startWebWorker(workerUrl);
        // Fehler nach dem Start (z. B. Speicher voll) → Worker verwerfen; das nächste Öffnen startet einen neuen
        web.addEventListener('error', () => markDead());
        // Mit port übergibt pdf.js nur die Verbindung – kein eigener Start, kein dauerhafter Fake-Worker-Schalter
        return { pdfWorker: new pdfjs.PDFWorker({ port: web, name: 'finanzradar-pdf' }), web, fake: false };
      } catch (e) {
        lastErr = e;
        console.warn('PDF-Worker-Start fehlgeschlagen', i + 1, e?.message || e);
      }
    }
  }
  try {
    await loadMainThreadWorker();
    const pdfWorker = new pdfjs.PDFWorker({ name: 'finanzradar-pdf-hauptthread' });
    await pdfWorker.promise;
    if (lastErr) console.warn('PDF-Leser läuft im Hauptthread (Rückfall)');
    return { pdfWorker, web: null, fake: true };
  } catch (e) {
    throw lastErr ? new Error(`PDF-Worker startet nicht: ${lastErr.message}; Rückfall: ${e.message}`) : e;
  }
}

function destroySharedWorker(handle) {
  try { handle.pdfWorker?.destroy(); } catch { /* egal */ }
  try { handle.web?.terminate(); } catch { /* egal */ }
}

const holder = isNode ? null : createWorkerHolder({ create: createSharedWorker, destroy: destroySharedWorker });
const slotOf = new WeakMap(); // Dokument → Worker-Slot, in dem es geöffnet wurde

/** Gemeinsamen PDF-Leser beenden, sobald kein Dokument mehr offen ist (Ende des Imports: Speicher freigeben). */
export function releasePdfWorker() { holder?.releaseIdle(); }

/** Den Worker, in dem `doc` geöffnet wurde, als kaputt verwerfen (nächstes Öffnen startet neu). */
export function restartPdfWorker(slot) { if (slot) holder?.restart(slot); }

/** Kennung des Worker-Slots eines Dokuments (für restartPdfWorker nach dem Schließen). */
export function pdfWorkerSlot(doc) { return slotOf.get(doc) || null; }

/**
 * Anfrage an den Worker eines Dokuments absichern: Zeitlimit und sofortiger Abbruch, wenn sein Worker stirbt.
 * onTimeout z. B. zum Abbrechen eines Render-Vorgangs.
 */
export function guardPdf(doc, promise, ms, label, onTimeout) {
  return withTimeout(raceSlot(slotOf.get(doc), promise), ms, label, onTimeout);
}

/** Zustand des gemeinsamen Workers (Diagnose/Browser-Test). */
export function pdfWorkerStats() { return holder?.stats() ?? null; }

// Standardschriften: im Browser fürs Rendern (Vorschau, OCR) nötig. In Node reicht reine Textextraktion,
// deshalb wird dort keine URL gesetzt (Warnungen unterdrückt verbosity: 0).
function standardFontUrl() {
  return isNode ? null : new URL('vendor/pdfjs/standard_fonts/', document.baseURI).href;
}

function pdfParams(src) {
  const data = new Uint8Array(src.byteLength); data.set(src); // je Versuch neu: pdf.js überträgt (leert) den Puffer
  const params = { data, isEvalSupported: false, useSystemFonts: false, disableFontFace: isNode, verbosity: 0 };
  const fonts = standardFontUrl();
  if (fonts) params.standardFontDataUrl = fonts;
  return params;
}

/**
 * PDF öffnen. Browser: im gemeinsamen Worker; fällt der Worker aus, wird er neu gestartet und die Datei einmal neu
 * geöffnet, erst dann kommt ein Klartext-Fehler. Defekte/verschlüsselte Dateien scheitern sofort (ohne Wiederholung).
 */
export async function openPdf(bytes) {
  const pdfjs = await getPdfjs();
  const src = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (isNode) {
    const task = pdfjs.getDocument(pdfParams(src));
    try { return await task.promise; } catch (e) { task.destroy?.(); throw e; } // Speicher bei defekten PDFs freigeben
  }
  let slot = null;
  return withWorkerRetry(async () => {
    slot = await holder.acquire();
    const task = pdfjs.getDocument({ ...pdfParams(src), worker: slot.handle.pdfWorker });
    try {
      const doc = await withTimeout(raceSlot(slot, task.promise), OPEN_TIMEOUT, 'Öffnen');
      slotOf.set(doc, slot);
      return doc;
    } catch (e) {
      withTimeout(task.destroy(), CLOSE_TIMEOUT, 'Schließen').catch(() => {}); // Worker-Speicher freigeben
      holder.release(slot);
      throw e;
    }
  }, { restart: () => holder.restart(slot) });
}

/**
 * PDF-Dokument schließen. pdf.js 6 kennt kein `doc.destroy()` – `loadingTask.destroy()` gibt das Dokument im Worker frei.
 * Der gemeinsame Worker bleibt dabei bestehen (an getDocument übergebene Worker beendet pdf.js nicht).
 */
export async function closePdf(doc) {
  if (!doc) return;
  const slot = slotOf.get(doc);
  slotOf.delete(doc);
  // Ist der Worker tot, kommt keine Antwort auf „Terminate“ – nicht warten (raceSlot bricht sofort ab)
  try { await withTimeout(raceSlot(slot, doc.loadingTask?.destroy?.() ?? doc.destroy?.()), CLOSE_TIMEOUT, 'Schließen'); } catch { /* bereits geschlossen / Worker tot */ }
  if (slot) holder?.release(slot);
}

/** Gruppiert Textitems einer Seite zu Zeilen (y-Toleranz) und sortiert nach x. */
export function itemsToLines(items) {
  const pts = items.filter(it => it.str && it.str.trim() !== '').map(it => ({
    x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 10, str: it.str,
  }));
  pts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of pts) {
    const tol = Math.max(2, p.h * 0.45);
    let line = lines.find(l => Math.abs(l.y - p.y) <= tol);
    if (!line) { line = { y: p.y, items: [] }; lines.push(line); }
    line.items.push({ x: p.x, w: p.w, str: p.str });
  }
  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let text = '', lastEnd = null;
    for (const it of l.items) {
      if (lastEnd != null) {
        const gap = it.x - lastEnd;
        text += gap > 12 ? '   ' : gap > 1.5 ? ' ' : '';
      }
      text += it.str; lastEnd = it.x + it.w;
    }
    l.text = text.replace(/\s+$/, '');
  }
  return lines;
}

/** Liefert { pages, text, pageCount, attachments } – Seiten ohne Text gelten als Scan. */
export async function extractPdfText(bytes, { maxPages = 60 } = {}) {
  const doc = await openPdf(bytes);
  try {
    const pages = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await guardPdf(doc, doc.getPage(i), PAGE_TIMEOUT, `Seite ${i}`);
      const tc = await guardPdf(doc, page.getTextContent(), PAGE_TIMEOUT, `Text Seite ${i}`);
      const lines = itemsToLines(tc.items);
      pages.push({ n: i, text: lines.map(l => l.text).join('\n'), lines, textItems: tc.items.length });
      page.cleanup?.();
    }
    let attachments = [];
    try {
      const att = await guardPdf(doc, doc.getAttachments(), PAGE_TIMEOUT, 'Anhänge');
      if (att) attachments = Object.values(att).map(a => ({ name: a.filename, content: a.content }));
    } catch (e) { if (isPdfWorkerFailure(e)) throw e; /* sonst: Anhänge sind optional */ }
    const pageCount = doc.numPages;
    return { doc, pages, pageCount, attachments, text: pages.map(p => p.text).join('\n\f\n') };
  } catch (e) {
    const slot = slotOf.get(doc);
    await closePdf(doc); // defekte Seite: Dokument nicht im Worker liegen lassen
    if (isPdfWorkerFailure(e)) restartPdfWorker(slot); // Worker hängt/abgestürzt → beim nächsten Versuch neu starten
    throw e;
  }
}
