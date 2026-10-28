// Lohnsteuerbescheinigung (→ payroll, Jahr) und Steuerbescheinigung der Bank/Depotbank (→ fields).
import {
  getLines, amountOf, sumOf, amountsIn, lastAmount, hasAmount, labelValue, allDates, baseDoc, baseResult, review,
  issuerFromHeader, cleanOcr,
} from './util.js';

const abs = (v) => (v == null ? null : Math.abs(v));

function yearOf(lines) {
  const head = lines.slice(0, 3).join(' ');
  const m = /\b(20\d{2})\b/.exec(head) || /\b(?:jahr|zeitraum|kalenderjahr|steuerjahr)\D{0,40}(20\d{2})/i.exec(lines.join('\n'));
  if (m) return Number(m[1]);
  const d = allDates(lines.join('\n'));
  return d.length ? Number(d[0].slice(0, 4)) : null;
}

function periodOf(lines, year) {
  const l = lines.find((x) => /zeitraum/i.test(x) && allDates(x).length >= 2);
  if (l) { const d = allDates(l); return [d[0], d[d.length - 1]]; }
  return year ? [`${year}-01-01`, `${year}-12-31`] : [null, null];
}

export function parseLohnsteuerbescheinigung(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const doc = baseDoc(detection, { type: 'lohnsteuerbescheinigung' });
  const year = yearOf(lines);
  const [from, to] = periodOf(lines, year);
  // Label zählt, Zeilennummern sind nur Beiwerk (echtes Formular und vereinfachte Fassung weichen ab)
  const gross = abs(amountOf(lines, /bruttoarbeitslohn/i));
  const lohnsteuer = abs(amountOf(lines, /(einbehaltene\s+)?lohnsteuer(?!bescheinigung)/i, { not: /(bescheinigung|kirchen|brutto)/i }));
  const soli = abs(amountOf(lines, /solidarit[aä]ts/i));
  const kist = abs(amountOf(lines, /kirchensteuer(?!.*ehegatte)/i));
  const skip = /(arbeitgeber|zusch|summe|gesamt|insgesamt)/i;
  const rv = sumOf(lines, /rentenversicherung/i, { not: skip });
  const kv = sumOf(lines, /krankenversicherung/i, { not: skip });
  const pv = sumOf(lines, /pflegeversicherung/i, { not: skip });
  const av = sumOf(lines, /arbeitslosenversicherung/i, { not: skip });
  const sv = (rv || 0) + (kv || 0) + (pv || 0) + (av || 0);
  const svTotal = abs(amountOf(lines, /^\W*(\d+[a-z]?\s+)?(summe\s+sozialversicherung|sozialversicherungsbeitr)/i));
  const net = gross != null ? gross - (lohnsteuer || 0) - (soli || 0) - (kist || 0) - sv : null;
  const employer = labelValue(lines, /^\W*arbeitgeber\b/i) || issuerFromHeader(lines.filter((l) => !/bescheinigung/i.test(l)));

  const payroll = { gross, net, payout: net, lohnsteuer, soli: soli ?? 0, kirchensteuer: kist ?? 0, kv, pv, rv, av, period: year ? String(year) : null };
  doc.issuer = employer; doc.institution = employer;
  doc.periodFrom = from; doc.periodTo = to; doc.date = to;
  doc.amount = gross;
  doc.fields = { year, employer, svTotal: svTotal ?? (sv || null), steuerklasse: /steuerklasse\s+([IVX1-6]{1,3})\b/i.exec(lines.join('\n'))?.[1] || null };
  doc.title = `Lohnsteuerbescheinigung ${year || ''} ${employer || ''}`.replace(/\s+/g, ' ').trim();
  if (gross == null) review(doc, 'Bruttoarbeitslohn nicht erkannt');
  if (lohnsteuer == null) review(doc, 'Lohnsteuer nicht erkannt');
  if (!year) review(doc, 'Jahr nicht erkannt');
  if (svTotal != null && sv && Math.abs(svTotal - sv) > 100) review(doc, 'Summe Sozialversicherung weicht von Einzelzeilen ab');
  return baseResult(doc, { payroll });
}

export function parseSteuerbescheinigung(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const doc = baseDoc(detection, { type: 'steuerbescheinigung' });
  const year = yearOf(lines);
  const [from, to] = periodOf(lines, year);
  const kapital = abs(amountOf(lines, /kapitalertr[aä]ge/i, { not: /steuerpflichtig/i }));
  const steuerpflichtig = abs(amountOf(lines, /steuerpflichtige\s+kapitalertr/i));
  const fsaUsed = abs(amountOf(lines, /freistellungsauftrag.*(genutzt|anspruch|verbraucht)|in anspruch genommen/i));
  const fsa = abs(amountOf(lines, /freistellungsauftrag/i, { not: /(genutzt|anspruch)/i }));
  const kapest = abs(amountOf(lines, /(kapitalertragsteuer|abgeltungs?steuer)/i));
  const soli = abs(amountOf(lines, /solidarit[aä]ts/i));
  const kist = abs(amountOf(lines, /kirchensteuer/i));
  const gesamt = abs(amountOf(lines, /(einbehaltene\s+steuern|steuern\s+gesamt|summe\s+steuern)/i));
  const verlust = abs(amountOf(lines, /verlust(?:bescheinigung|verrechnungstopf|saldo)?/i, { not: /bescheinigung\s*$/i }));
  const issuer = issuerFromHeader(lines);
  doc.issuer = issuer; doc.institution = issuer;
  doc.periodFrom = from; doc.periodTo = to; doc.date = to;
  doc.amount = kapital;
  doc.fields = {
    year, kapitalertraege: kapital, steuerpflichtigeErtraege: steuerpflichtig, freistellungsauftrag: fsa,
    freistellungGenutzt: fsaUsed, kapitalertragsteuer: kapest, soli, kirchensteuer: kist,
    steuernGesamt: gesamt ?? ((kapest || 0) + (soli || 0) + (kist || 0) || null), verlust,
  };
  doc.title = `Steuerbescheinigung ${year || ''} ${issuer || ''}`.replace(/\s+/g, ' ').trim();
  if (kapital == null && verlust == null) review(doc, 'Kapitalerträge nicht erkannt');
  if (!year) review(doc, 'Jahr nicht erkannt');
  if (gesamt != null && kapest != null && Math.abs(gesamt - ((kapest || 0) + (soli || 0) + (kist || 0))) > 2) review(doc, 'Steuern gesamt weichen von Einzelsteuern ab');
  return baseResult(doc);
}

/** Dispatcher nach detection.type */
export function parse(extracted, fileMeta, detection) {
  return detection?.type === 'steuerbescheinigung'
    ? parseSteuerbescheinigung(extracted, fileMeta, detection)
    : parseLohnsteuerbescheinigung(extracted, fileMeta, detection);
}
