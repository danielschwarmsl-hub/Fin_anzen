// Text-Snapshots der originalnahen Test-PDFs (tests/fixtures/real-like/*.pdf) über den ECHTEN Extraktionsweg der App:
// extract() aus src/lib/extract/index.js → extractPdfText (pdf.js, in Node der Legacy-Build) → itemsToLines.
// Ergebnis je PDF: tests/fixtures/real-like/<name>.extract.json = { kind, pages:[{ n, text, lines:[{ y, text, items:[{ x, w, str }] }] }], text }
// Das ist die Form, die beim Nutzer im Browser ankommt (gleicher Code, nur ohne OCR/Vorschau).
//
// Aufruf (im Ordner quellcode):  node scripts/snapshot-real-like.mjs [name …]
// Vorher ggf. die PDFs neu bauen:  python3 scripts/make-real-like-pdfs.py
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extract } from '../src/lib/extract/index.js';

const DIR = fileURLToPath(new URL('../tests/fixtures/real-like/', import.meta.url));
const round = (v) => Math.round(v * 100) / 100;

/** Extract-Objekt → kompaktes, stabiles JSON (Koordinaten auf 0,01 pt gerundet). */
export function toSnapshot(ex) {
  return {
    kind: ex.kind,
    pages: ex.pages.map((p) => ({
      n: p.n,
      text: p.text,
      lines: p.lines.map((l) => ({ y: round(l.y), text: l.text, items: l.items.map((it) => ({ x: round(it.x), w: round(it.w), str: it.str })) })),
    })),
    text: ex.text,
  };
}

export async function extractFile(name) {
  const bytes = readFileSync(`${DIR}${name}.pdf`);
  const meta = { name: `${name}.pdf`, path: `real-like/${name}.pdf`, ext: 'pdf', mime: 'application/pdf', size: bytes.length };
  return extract(meta, new Blob([bytes]), { ocr: false });
}

async function main() {
  const wanted = process.argv.slice(2);
  const names = readdirSync(DIR).filter((f) => f.endsWith('.pdf')).map((f) => f.slice(0, -4))
    .filter((n) => !wanted.length || wanted.includes(n)).sort();
  for (const name of names) {
    const snap = toSnapshot(await extractFile(name));
    writeFileSync(`${DIR}${name}.extract.json`, JSON.stringify(snap) + '\n');
    const lines = snap.pages.reduce((a, p) => a + p.lines.length, 0);
    console.log(`${name}.extract.json  ${snap.pages.length} S., ${lines} Zeilen`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
