// PDF-Textextraktion mit Zeilen-Rekonstruktion. Läuft im Browser (Worker) und in Node (legacy build).
let pdfjsPromise = null;
const isNode = typeof window === 'undefined';

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
      // Eigener Worker-Einstieg (mit Polyfills) statt direkt pdf.worker.min.mjs
      const workerUrl = (await import('./pdf-worker.js?worker&url')).default;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    })();
  }
  return pdfjsPromise;
}

// Standardschriften: im Browser fürs Rendern (Vorschau, OCR) nötig. In Node reicht reine Textextraktion,
// deshalb wird dort keine URL gesetzt (Warnungen unterdrückt verbosity: 0).
function standardFontUrl() {
  return isNode ? null : new URL('vendor/pdfjs/standard_fonts/', document.baseURI).href;
}

export async function openPdf(bytes) {
  const pdfjs = await getPdfjs();
  const src = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const data = new Uint8Array(src.byteLength); data.set(src);
  const params = { data, isEvalSupported: false, useSystemFonts: false, disableFontFace: isNode, verbosity: 0 };
  const fonts = standardFontUrl();
  if (fonts) params.standardFontDataUrl = fonts;
  const task = pdfjs.getDocument(params);
  try { return await task.promise; } catch (e) { task.destroy?.(); throw e; } // Worker-Speicher bei defekten/verschlüsselten PDFs freigeben
}

/**
 * PDF-Dokument schließen und seinen Web-Worker beenden. pdf.js 6 kennt kein `doc.destroy()` –
 * ohne `loadingTask.destroy()` bleibt pro geöffneter PDF ein Worker samt Speicher am Leben.
 */
export async function closePdf(doc) {
  try { await (doc?.loadingTask?.destroy?.() ?? doc?.destroy?.()); } catch { /* bereits geschlossen */ }
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
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const lines = itemsToLines(tc.items);
      pages.push({ n: i, text: lines.map(l => l.text).join('\n'), lines, textItems: tc.items.length });
      page.cleanup?.();
    }
    let attachments = [];
    try {
      const att = await doc.getAttachments();
      if (att) attachments = Object.values(att).map(a => ({ name: a.filename, content: a.content }));
    } catch { /* ignore */ }
    const pageCount = doc.numPages;
    return { doc, pages, pageCount, attachments, text: pages.map(p => p.text).join('\n\f\n') };
  } catch (e) {
    await closePdf(doc); // defekte Seite: Dokument nicht im Worker liegen lassen
    throw e;
  }
}
