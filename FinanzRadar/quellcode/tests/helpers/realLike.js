// Originalnahe Test-PDFs mit Textebene (tests/fixtures/real-like): Snapshots des echten pdf.js-Extrakts und Sollwerte.
// Erzeugen: python3 scripts/make-real-like-pdfs.py && node scripts/snapshot-real-like.mjs
import fs from 'node:fs';

const DIR = new URL('../fixtures/real-like/', import.meta.url);

/** Sollwerte aller Vorlagen: { name: { type, subtype, amount, … } } (ohne Metadaten-Schlüssel „_…“). */
export function loadExpected() {
  const all = JSON.parse(fs.readFileSync(new URL('EXPECTED.json', DIR), 'utf8'));
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('_')));
}

/** Extract-Objekt wie aus extract() (Textebene, ohne OCR) – direkt an detectType/parse übergebbar. */
export function loadRealLike(name) {
  const snap = JSON.parse(fs.readFileSync(new URL(`${name}.extract.json`, DIR), 'utf8'));
  return {
    kind: 'pdf', text: snap.text, pages: snap.pages, rows: null, rawText: null, xml: null,
    ocr: false, ocrConfidence: null, thumbnail: null, meta: { pageCount: snap.pages.length, encoding: null, delimiter: null },
  };
}

export const realLikePdf = (name) => new URL(`${name}.pdf`, DIR);
export const realLikeMeta = (name) => ({ name: `${name}.pdf`, ext: 'pdf' });
