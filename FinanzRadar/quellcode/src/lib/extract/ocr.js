// OCR mit tesseract.js v7. Ein Worker wird lazy erzeugt und wiederverwendet (nur Browser).
// blocksToLines() ist DOM-frei und wird in Node getestet.

let workerPromise = null;
let progressSink = null;
let chain = Promise.resolve();

/** Lazy erzeugter, wiederverwendeter Worker (Deutsch, LSTM). Pfade aus scripts/vendor.mjs. */
export function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      const root = new URL('./', document.baseURI).href;
      return createWorker('deu', 1, {
        workerPath: root + 'vendor/tesseract/worker.min.js',
        corePath: root + 'vendor/tesseract/core',
        langPath: root + 'vendor/tesseract/lang',
        gzip: true,
        logger: (m) => { if (progressSink && typeof m.progress === 'number') progressSink(m.progress, m.status); },
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

const unionBox = (boxes) => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1)),
});

/**
 * tesseract-Blöcke → Zeilen im pdf.js-Stil: { y, text, items: [{x,w,str}] }.
 * unit = Bildpixel je Ausgabeeinheit (PDF: Skalierung, Bild: 1 bzw. Hochskalierung).
 * y ist von unten gezählt (größer = oben), Zeilen sind top-to-bottom sortiert.
 */
export function blocksToLines(blocks, { unit = 1, height = 0 } = {}) {
  const lines = [];
  for (const b of blocks || []) {
    const ls = b.paragraphs ? b.paragraphs.flatMap((p) => p.lines || []) : (b.lines || []);
    for (const l of ls) {
      const words = (l.words || []).filter((w) => w.text && w.text.trim() && w.bbox);
      if (!words.length) continue;
      const box = l.bbox || unionBox(words.map((w) => w.bbox));
      const h = Math.max(1, (box.y1 - box.y0) / unit);
      const items = words
        .map((w) => ({ x: w.bbox.x0 / unit, w: (w.bbox.x1 - w.bbox.x0) / unit, str: w.text.trim() }))
        .sort((a, b2) => a.x - b2.x);
      let text = '';
      let lastEnd = null;
      for (const it of items) {
        if (lastEnd != null) text += it.x - lastEnd > h * 1.2 ? '   ' : ' ';
        text += it.str;
        lastEnd = it.x + it.w;
      }
      lines.push({ y: height - box.y1 / unit, text, items });
    }
  }
  return lines.sort((a, b) => b.y - a.y);
}

async function doRecognize(canvas, { unit = 1, onProgress } = {}) {
  const worker = await getOcrWorker();
  progressSink = onProgress || null;
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const lines = blocksToLines(data.blocks, { unit, height: canvas.height / unit });
    return {
      text: lines.map((l) => l.text).join('\n'),
      lines,
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
    };
  } finally {
    progressSink = null;
  }
}

/** Erkennt Text auf einem Canvas. Aufrufe laufen nacheinander (ein Worker). */
export function recognizeCanvas(canvas, opts) {
  const run = chain.then(() => doRecognize(canvas, opts));
  chain = run.catch(() => {});
  return run;
}

/** Worker beenden und Ressourcen freigeben. */
export async function terminateOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try { await (await p).terminate(); } catch { /* bereits beendet */ }
}
