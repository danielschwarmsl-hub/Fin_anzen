// Lohn-/Gehaltsabrechnung → payroll (Cent) + Plausibilitätsprüfung brutto - Abzüge ≈ netto.
import { parseGermanDate } from '../../util/format.js';
import {
  getLines, amountOf, sumOf, amountsIn, lastAmount, hasAmount, labelValue, firstDate, baseDoc, baseResult, review,
  issuerFromHeader, monthFromName, lastDayOfMonth, pad2, cleanOcr,
} from './util.js';

const abs = (v) => (v == null ? null : Math.abs(v));

function findPeriod(lines) {
  const cand = labelValue(lines, /(abrechnungs(?:zeitraum|monat)|lohnzeitraum|monat\s*\/\s*jahr|abrechnung\s+f[uü]r|zeitraum)\b/i);
  const sources = [cand, ...lines.slice(0, 6), lines.join('\n')].filter(Boolean);
  for (const s of sources) {
    let m = /\b(0?[1-9]|1[0-2])\s*[\/.]\s*(20\d{2})\b/.exec(s);
    if (m) return { y: Number(m[2]), m: Number(m[1]) };
    m = /\b(20\d{2})[-\/](0[1-9]|1[0-2])\b/.exec(s);
    if (m) return { y: Number(m[1]), m: Number(m[2]) };
    const mo = monthFromName(s);
    const y = /\b(20\d{2})\b/.exec(s);
    if (mo && y) return { y: Number(y[1]), m: mo };
    m = /\b\d{1,2}\.(\d{1,2})\.(20\d{2})\s*[–-]\s*\d{1,2}\.\d{1,2}\.20\d{2}/.exec(s);
    if (m) return { y: Number(m[2]), m: Number(m[1]) };
  }
  return null;
}

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const doc = baseDoc(detection, { type: 'lohn' });
  const NOT_AG = /(arbeitgeber|ag-anteil|summe|gesamt)/i;

  const gross = abs(amountOf(lines, /^\W*(gesamtbrutto|gesamt-?brutto)\b/i)
    ?? amountOf(lines, /^\W*(brutto(?:gehalt|lohn|entgelt|bezug|verdienst)?|steuerbrutto|gesamtbezüge)\b/i)
    ?? amountOf(lines, /\bbrutto\b/i, { not: /(netto|sv-|steuer-?brutto)/i }));
  const lohnsteuer = abs(amountOf(lines, /^\W*(lohnsteuer|lst)\b/i, { not: /(kirchen|bescheinigung|klasse\s*$)/i }));
  const soli = abs(amountOf(lines, /^\W*(solidarit[aä]ts(?:zuschlag)?|solz|soli)\b/i));
  const kist = abs(amountOf(lines, /^\W*(kirchensteuer|kist)\b/i));
  const kv = sumOf(lines, /(krankenversicherung|kv[- ]beitrag|zusatzbeitrag|krankenkasse.*beitrag)/i, { not: new RegExp(NOT_AG.source + '|pflege|krankenkasse\\s', 'i') });
  const pv = sumOf(lines, /pflegeversicherung/i, { not: NOT_AG });
  const rv = sumOf(lines, /rentenversicherung/i, { not: NOT_AG });
  const av = sumOf(lines, /arbeitslosenversicherung/i, { not: NOT_AG });
  const netExplicit = abs(amountOf(lines, /^\W*(nettoentgelt|nettobezug|nettolohn|nettogehalt|nettoverdienst|netto)\b/i));
  const payoutExplicit = abs(amountOf(lines, /^\W*(auszahlungsbetrag|auszahlung|[uü]berweisung)\b/i)
    ?? amountOf(lines, /(auszahlungsbetrag)/i));
  const net = netExplicit ?? payoutExplicit;
  const payout = payoutExplicit ?? netExplicit;

  // Zeitraum
  const p = findPeriod(lines);
  const period = p ? `${p.y}-${pad2(p.m)}` : null;
  if (p) { doc.periodFrom = `${p.y}-${pad2(p.m)}-01`; doc.periodTo = `${p.y}-${pad2(p.m)}-${pad2(lastDayOfMonth(p.y, p.m))}`; }
  const payLine = lines.find((l) => /(auszahlung|[uü]berweisung)/i.test(l) && /\d{1,2}\.\d{1,2}\.\d{4}/.test(l));
  const payDate = payLine ? firstDate(payLine.replace(/^.*?(?=(?:am|zum)\s+\d)/i, '')) : null;

  const employer = labelValue(lines, /^\W*arbeitgeber\b/i) || issuerFromHeader(lines);
  doc.issuer = employer;
  doc.institution = employer;
  doc.date = payDate || doc.periodTo || firstDate(lines.join('\n'));
  doc.amount = payout;
  doc.title = `Lohnabrechnung ${p ? pad2(p.m) + '/' + p.y : ''} ${employer || ''}`.replace(/\s+/g, ' ').trim();

  const payroll = { gross, net, payout, lohnsteuer, soli: soli ?? 0, kirchensteuer: kist ?? 0, kv, pv, rv, av, period };
  doc.fields = {
    employer, steuerklasse: /steuerklasse[^\n]*?\s{2,}([IVX]{1,3}|[1-6])\b/i.exec(lines.join('\n'))?.[1] || null,
    personalnummer: /personal(?:nummer|nr\.?)\s*[:.]?\s*(\w+)/i.exec(lines.join('\n'))?.[1] || null,
    iban: null, payDate,
  };

  if (gross == null) review(doc, 'Brutto nicht erkannt');
  if (net == null) review(doc, 'Netto nicht erkannt');
  if (!period) review(doc, 'Abrechnungszeitraum nicht erkannt');
  if (gross != null && net != null) {
    const deductions = (lohnsteuer || 0) + (soli || 0) + (kist || 0) + (kv || 0) + (pv || 0) + (rv || 0) + (av || 0);
    const diff = gross - deductions - net;
    doc.fields.checkDiff = diff;
    if (Math.abs(diff) > 100) review(doc, `Brutto − Abzüge ≠ Netto (Differenz ${(diff / 100).toFixed(2).replace('.', ',')} €)`);
  }
  if (extracted?.ocr && typeof extracted.ocrConfidence === 'number' && extracted.ocrConfidence < 55) review(doc, 'OCR-Qualität niedrig');
  return baseResult(doc, { payroll });
}
