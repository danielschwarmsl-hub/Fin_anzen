// Einkaufszettel: Positionen ohne Preise.
import { getLines, baseDoc, baseResult, review } from './util.js';

const SKIP_RE = /(einkaufszettel|einkaufsliste|testdokument|^\W*muster\b|abgetippt|handschrift)/i;

export function parse(extracted, fileMeta, detection) {
  const doc = baseDoc(detection, { type: 'einkaufszettel' });
  const lineItems = [];
  for (const raw of getLines(extracted)) {
    if (SKIP_RE.test(raw)) continue;
    let t = raw.replace(/^\s*(?:[-*•·–]|\[[ x]?\]|☐|☑|\d+[.)])\s*/i, '').trim();
    if (!t || t.length > 80) continue;
    let qty = null;
    const q = /^(\d+(?:[.,]\d+)?)\s*[x×]\s+(.+)$/i.exec(t) || /^(.+?)\s+(\d+)\s*[x×]$/i.exec(t);
    if (q) { if (/^\d/.test(q[1])) { qty = Number(q[1].replace(',', '.')); t = q[2]; } else { qty = Number(q[2]); t = q[1]; } }
    lineItems.push({ text: t, qty, unitPrice: null, total: null, vatRate: null });
  }
  doc.title = `Einkaufszettel (${lineItems.length} Positionen)`;
  doc.fields = { itemCount: lineItems.length };
  if (!lineItems.length) review(doc, 'Keine Positionen erkannt');
  return baseResult(doc, { lineItems });
}
