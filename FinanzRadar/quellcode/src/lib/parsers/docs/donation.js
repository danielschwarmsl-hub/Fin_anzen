// Zuwendungsbestätigung / Spendenquittung.
import {
  getLines, amountOf, amountsIn, labelValue, firstDate, allDates, baseDoc, baseResult, review, issuerFromHeader, cleanOcr,
} from './util.js';

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const joined = lines.join('\n');
  const doc = baseDoc(detection, { type: 'spende' });

  const org = issuerFromHeader(lines) || labelValue(lines, /^\W*(organisation|verein|empf[aä]nger)\b/i);
  let amount = amountOf(lines, /^\W*(betrag|spendenbetrag|zuwendungsbetrag|summe|zuwendung)\b/i)
    ?? amountOf(lines, /(betrag der zuwendung|spende(?:nbetrag)?)/i);
  if (amount == null) {
    const all = lines.flatMap((l) => amountsIn(l));
    if (all.length) amount = Math.max(...all);
  }
  const dl = lines.find((l) => /(zuwendungsdatum|datum der zuwendung|spendendatum|tag der zuwendung|zahlungsdatum)/i.test(l) && firstDate(l));
  const il = lines.find((l) => /(ausstellungsdatum|ausgestellt|datum der bescheinigung)/i.test(l) && firstDate(l));
  const issued = il ? firstDate(il) : null;
  const date = (dl && firstDate(dl)) || issued || firstDate(joined);
  const sammel = /sammelbest[aä]tigung/i.test(joined);

  doc.issuer = org; doc.institution = org;
  doc.date = date;
  doc.amount = amount != null ? Math.abs(amount) : null;
  doc.fields = {
    organisation: org, issuedDate: issued, purpose: labelValue(lines, /^\W*zweck\b/i),
    paymentMethod: labelValue(lines, /^\W*zahlungsweg\b/i), year: date ? Number(date.slice(0, 4)) : null,
    sammelbestaetigung: sammel, steuernummerVerein: /steuernummer[^\n]*?([\d]{2,3}\/[\d/]+)/i.exec(joined)?.[1] || null,
  };
  doc.title = `Spende ${org || ''}`.trim();
  if (doc.amount == null) review(doc, 'Spendenbetrag nicht erkannt');
  if (!date) review(doc, 'Datum nicht erkannt');
  if (!org) review(doc, 'Organisation nicht erkannt');
  if (sammel) review(doc, 'Sammelbestätigung: Einzelspenden prüfen');
  return baseResult(doc);
}
