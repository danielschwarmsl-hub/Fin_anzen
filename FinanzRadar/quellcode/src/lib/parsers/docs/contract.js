// Verträge/Abos (Bestätigungen, Mitgliedschaften).
import { PROVIDERS } from './known.js';
import {
  getLines, amountOf, amountsIn, labelValue, firstDate, firstIban, baseDoc, baseResult, review, issuerFromHeader, cleanOcr, LEGAL_RE,
} from './util.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const joined = lines.join('\n');
  const doc = baseDoc(detection, { type: 'vertrag' });

  let provider = PROVIDERS.find((p) => new RegExp(`(?<![A-Za-z])${esc(p)}(?![A-Za-z])`).test(joined)) || null;
  const legal = lines.find((l) => LEGAL_RE.test(l) && l.length < 80 && !/^(empf|kunde|versicherungsnehmer)/i.test(l));
  const header = issuerFromHeader(lines);
  if (!provider) provider = (legal && issuerFromHeader([legal])) || header;
  const product = labelValue(lines, /^\W*(tarif|produkt|paket|leistung|vertragsart|abo|plan)\b/i);

  // Preis + Intervall
  const priceRe = /^\W*(preis|monatlicher preis|monatspreis|beitrag|kosten|geb[uü]hr|betrag|monatlich|j[aä]hrlich)\b/i;
  let line = lines.find((l) => priceRe.test(l) && amountsIn(l).length);
  if (!line) line = lines.find((l) => /(pro monat|monatlich|\/\s*monat|pro jahr|j[aä]hrlich|\/\s*jahr)/i.test(l) && amountsIn(l).length);
  const price = line ? amountsIn(line).slice(-1)[0] : null;
  const yearly = line ? /(pro jahr|j[aä]hrlich|\/\s*jahr|p\.\s?a\.)/i.test(line) : false;
  const quarterly = line ? /(quartal|viertelj)/i.test(line) : false;
  const interval = yearly ? 'yearly' : quarterly ? 'quarterly' : 'monthly';
  const monthly = price == null ? null : interval === 'yearly' ? Math.round(price / 12) : interval === 'quarterly' ? Math.round(price / 3) : price;

  const startLine = lines.find((l) => /(vertragsbeginn|laufzeitbeginn|beginn|g[uü]ltig ab|start|^\W*datum\b)/i.test(l) && firstDate(l));
  const startDate = startLine ? firstDate(startLine) : firstDate(joined);
  const cancel = labelValue(lines, /k[uü]ndigungsfrist\s*[:.]?/i)
    || (/jederzeit[\s\S]{0,120}k[uü]ndig/i.test(joined) ? 'jederzeit kündbar' : null);
  const term = labelValue(lines, /(mindest)?(?:vertrags)?laufzeit\s*[:.]?/i);
  const pay = (labelValue(lines, /^\W*zahlungsart\b/i) || '').split(',')[0].trim() || null;

  doc.issuer = provider; doc.institution = provider;
  doc.date = startDate;
  doc.amount = price;
  doc.fields = {
    provider, product, price, interval, priceMonthly: monthly, priceYearly: monthly != null ? (interval === 'yearly' ? price : monthly * 12) : null,
    startDate, cancellationPeriod: cancel, term, paymentMethod: pay, iban: firstIban(joined),
    contractNumber: /(?:vertrags|kunden|mitglieds)(?:nummer|nr\.?)\s*[:.]?\s*([A-Z0-9\-\/]+)/i.exec(joined)?.[1] || null,
  };
  doc.title = `Vertrag ${provider || ''}${product ? ' ' + product : ''}`.replace(/\s+/g, ' ').trim();
  if (!provider) review(doc, 'Anbieter nicht erkannt');
  if (price == null) review(doc, 'Preis nicht erkannt');
  return baseResult(doc);
}
