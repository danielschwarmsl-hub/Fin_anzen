// Versicherungen (Beitragsbescheinigung, Police, BU, Haftpflicht …) und Rentenverträge (Standmitteilung).
import { parseGermanDate } from '../../util/format.js';
import { INSURERS, matchFirst } from './known.js';
import {
  getLines, amountOf, amountsIn, lastAmount, hasAmount, labelValue, firstDate, allDates, baseDoc, baseResult, review,
  issuerFromHeader, cleanOcr,
} from './util.js';

// Produktart: [Schlüssel, Anzeigename, Muster, Kontoart]
const KINDS = [
  ['bu', 'Berufsunfähigkeitsversicherung', /berufsunf[aä]higkeit|\bBU[- ]/i, 'bu'],
  ['riester', 'Riester-Rente', /riester/i, 'rente'],
  ['ruerup', 'Basisrente (Rürup)', /r[uü]rup|basisrente/i, 'rente'],
  ['drv', 'Gesetzliche Rente', /deutsche rentenversicherung|renteninformation/i, 'rente'],
  ['privatrente', 'Privatrente', /privatrente|rentenversicherung|altersvorsorge/i, 'rente'],
  ['haftpflicht', 'Haftpflichtversicherung', /haftpflicht/i, null],
  ['hausrat', 'Hausratversicherung', /hausrat/i, null],
  ['kfz', 'Kfz-Versicherung', /kfz-?versicherung|kasko|fahrzeugversicherung/i, null],
  ['rechtsschutz', 'Rechtsschutzversicherung', /rechtsschutz/i, null],
  ['unfall', 'Unfallversicherung', /unfallversicherung/i, null],
  ['wohngebaeude', 'Wohngebäudeversicherung', /wohngeb[aä]ude/i, null],
  ['leben', 'Lebensversicherung', /lebensversicherung|risikolebens|kapitallebens/i, 'rente'],
  ['kranken', 'Krankenversicherung', /krankenversicherung|krankenzusatz|zahnzusatz/i, null],
];

function detectKind(text, detectionType) {
  for (const k of KINDS) if (k[2].test(text)) return k;
  return detectionType === 'rente' ? ['rente', 'Rentenversicherung', null, 'rente'] : ['sonstige', 'Versicherung', null, null];
}

function dateAfter(lines, re) {
  const l = lines.find((x) => re.test(x) && allDates(x).length);
  return l ? allDates(l.slice(l.search(re)))[0] || allDates(l)[0] : null;
}

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const joined = lines.join('\n');
  const isRente = detection?.type === 'rente';
  const doc = baseDoc(detection, { type: isRente ? 'rente' : 'versicherung' });

  const institution = matchFirst(INSURERS, lines.slice(0, 8).join('\n')) || matchFirst(INSURERS, joined);
  const issuer = issuerFromHeader(lines) || institution;
  const kind = detectKind(joined, detection?.type);

  const vtLabel = /(vertrags?-?\s?(?:nummer|nr\.?)|versicherungsschein-?\s?(?:nummer|nr\.?)|policen?-?\s?(?:nummer|nr\.?)|versicherungsnummer)/i;
  const cnRaw = labelValue(lines, vtLabel);
  const contractNumber = cnRaw ? (/^[A-Z0-9][A-Z0-9\-\/.]*/i.exec(cnRaw)?.[0] || '').replace(/[.]$/, '') || null : null;
  const product = labelValue(lines, /^\W*(tarif|produkt|versicherungsart|bezeichnung)\b/i);

  // Beträge
  const yearly = amountOf(lines, /(jahresbeitrag|jahresbeiträge?|jahrespr[aä]mie|beitr[aä]ge?\s+im\s+kalenderjahr|beitrag\s+(?:pro|je)\s+jahr|j[aä]hrlicher\s+beitrag)/i);
  const monthlyRaw = amountOf(lines, /(monatsbeitrag|monatlicher\s+beitrag|beitrag\s+monatlich|monatsprämie|beitrag\s+(?:pro|je)\s+monat)/i);
  const premiumYearly = yearly ?? (monthlyRaw != null ? monthlyRaw * 12 : null);
  const premiumMonthly = monthlyRaw ?? (yearly != null ? Math.round(yearly / 12) : null);
  const fund = amountOf(lines, /fondsguthaben/i);
  const surrender = amountOf(lines, /r[uü]ckkaufswert/i);
  const deckung = amountOf(lines, /(deckungskapital|vertragsguthaben|vertragswert|aktueller\s+wert|guthaben\b)/i);
  const guaranteed = amountOf(lines, /garantierte[rn]?\s+(?:monatliche\s+)?rente/i);
  const guaranteedFrom = dateAfter(lines, /garantierte[rn]?\s+(?:monatliche\s+)?rente/i);
  const paidTotal = amountOf(lines, /beitr[aä]ge\s+(?:seit\s+vertragsbeginn|insgesamt|gesamt)/i);
  const buRente = amountOf(lines, /(versicherte\s+bu-?rente|bu-?rente|berufsunf[aä]higkeitsrente)/i);

  // Daten
  const stichtag = dateAfter(lines, /stichtag/i) || dateAfter(lines, /fondsguthaben/i) || dateAfter(lines, /r[uü]ckkaufswert/i);
  const beginn = dateAfter(lines, /(versicherungsbeginn|vertragsbeginn|beginn)/i);
  const yearM = /(?:beitragsjahr|steuererkl[aä]rung|kalenderjahr|bescheinigungsjahr)\D{0,20}(20\d{2})/i.exec(joined) || /\bjahresbeitrag\s+(20\d{2})/i.exec(joined);
  const year = yearM ? Number(yearM[1]) : null;
  const issued = dateAfter(lines, /(ausstellungsdatum|ausgestellt am|^\W*datum)/i);

  const value = fund ?? surrender ?? deckung ?? null;
  const valuations = [];
  if (value != null && stichtag) valuations.push({ date: stichtag, value, label: fund != null ? 'Fondsguthaben' : surrender != null ? 'Rückkaufswert' : 'Vertragsguthaben' });

  // Konto (nur für Verträge mit Wert/Rentenbezug)
  let account = null;
  const accKind = kind[3] || (valuations.length ? 'sonstiges' : null);
  if (accKind && (valuations.length || kind[0] === 'bu')) {
    const pname = (kind[0] === 'bu' ? kind[1] : (product || kind[1]));
    account = {
      kind: accKind, institution: institution || issuer, name: [pname, contractNumber].filter(Boolean).join(' '),
      iban: null, currency: 'EUR', number: contractNumber,
    };
  }

  doc.issuer = issuer;
  doc.institution = institution || issuer;
  doc.subtype = kind[0];
  if (year) { doc.periodFrom = `${year}-01-01`; doc.periodTo = `${year}-12-31`; }
  doc.date = stichtag || issued || (year ? `${year}-12-31` : firstDate(joined));
  doc.amount = isRente ? (value ?? premiumYearly) : (premiumYearly ?? value);
  doc.fields = {
    productKind: kind[0], productKindLabel: kind[1], productName: product, contractNumber, stichtag, startDate: beginn, year,
    premiumYearly, premiumMonthly, premiumDerived: yearly == null || monthlyRaw == null,
    fondsguthaben: fund, rueckkaufswert: surrender, garantierteRente: guaranteed, garantierteRenteAb: guaranteedFrom,
    beitraegeGezahlt: paidTotal, buRente,
  };
  doc.title = `${isRente ? 'Standmitteilung' : 'Versicherung'} ${institution || issuer || ''} ${kind[1]}${year ? ' ' + year : stichtag ? ' ' + stichtag.slice(0, 4) : ''}`.replace(/\s+/g, ' ').trim();

  if (!institution && !issuer) review(doc, 'Versicherer nicht erkannt');
  if (isRente && !valuations.length) review(doc, 'Kein Guthaben/Rückkaufswert erkannt');
  if (!isRente && premiumYearly == null && value == null) review(doc, 'Beitrag nicht erkannt');
  if (!contractNumber) review(doc, 'Vertragsnummer nicht erkannt');
  return baseResult(doc, { account, valuations });
}
