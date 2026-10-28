// Fallback für finanz_sonstiges und unbekannte Dokumente: Datum, größter Betrag bei Summen-Stichwörtern, Aussteller.
import { getLines, amountsIn, allDates, baseDoc, baseResult, review, issuerFromHeader, cleanOcr } from './util.js';

const TOTAL_KW = /(gesamt|summe|total|betrag|zu zahlen|brutto|endbetrag|saldo|zahlbetrag)/i;

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const doc = baseDoc(detection, { type: detection?.type && detection.type !== 'irrelevant' ? detection.type : 'finanz_sonstiges' });

  // jüngstes plausibles Datum (nicht weit in der Zukunft)
  const limit = new Date(Date.now() + 366 * 864e5).toISOString().slice(0, 10);
  const dates = allDates(lines.join('\n')).filter((d) => d <= limit).sort();
  const date = dates.length ? dates[dates.length - 1] : null;

  let amounts = lines.filter((l) => TOTAL_KW.test(l)).flatMap((l) => amountsIn(l).map(Math.abs));
  const amount = amounts.length ? Math.max(...amounts) : null;
  const issuer = issuerFromHeader(lines);

  doc.date = date; doc.amount = amount; doc.issuer = issuer; doc.institution = issuer;
  doc.title = (lines[0] || fileMeta?.name || 'Dokument').slice(0, 80);
  doc.fields = { snippet: lines.slice(0, 3).join(' | ').slice(0, 200) };
  if ((doc.confidence ?? 0) < 0.5 || (!date && amount == null)) review(doc, 'Dokumenttyp unsicher');
  return baseResult(doc);
}
