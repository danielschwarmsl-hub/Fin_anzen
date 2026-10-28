// Kassenbon (Foto/Scan, meist OCR): Händler, Datum, Positionen, Summe, Zahlart, MwSt-Block.
import { parseGermanDate } from '../../util/format.js';
import { STORES, matchFirst } from './known.js';
import { amountsIn, lastAmount, getLines, baseDoc, baseResult, review, snapRate, cleanOcr, hasAmount } from './util.js';

const TOTAL_RE = /^\W*(summe|gesamt(?:summe|betrag)?|zu zahlen|total|endbetrag)\b(?!\s*netto)/i;
const PAY_RE = /(kartenzahlung|girocard|ec[- ]?(?:karte|cash)|visa|mastercard|maestro|barzahlung|\bbar\b|gegeben|kreditkarte|contactless)/i;
const STOP_RE = /^\W*(code\s+satz|kartenzahlung|girocard|ec[- ]?karte|barzahlung|bar\b|gegeben|r[uü]ckgeld|tse|steuer|mwst|ust)/i;
const META_RE = /\b(datum|zeit|kasse|bon[- ]?nr|ust-?id\w*|tel|fax|www|beleg-?nr|filiale|kassierer|bediener)\b/i;
const ITEM_RE = /^(.+?)\s+(-?\d{1,4}[.,]\d{2})\d?\s*[^\w\s]?\s*([A-D])?\s*$/;

function parseVat(lines) {
  const vat = [];
  for (const raw of lines) {
    const line = cleanOcr(raw);
    const m = /^\W*([A-D])\s+([0-9TtOo]{1,2})\s?[%x]\s+(.*)$/.exec(line) || /^\W*([A-D])\s+(\S{1,4})\s?%\s+(.*)$/.exec(line);
    if (!m) continue;
    const a = amountsIn(m[3]);
    if (a.length < 3) continue;
    const [net, tax, gross] = a.slice(-3);
    let rate = Number(String(m[2]).replace(/[Tt]/, '7').replace(/[Oo]/g, '0'));
    rate = snapRate(Number.isFinite(rate) ? rate : NaN, net, tax);
    vat.push({ flag: m[1], rate, net, tax, gross });
  }
  return vat;
}

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted);
  const doc = baseDoc(detection, { type: 'kassenbon' });

  // Händler: bekannte Kette in den ersten Zeilen, sonst erste Textzeile
  const head = lines.slice(0, 8);
  let issuer = matchFirst(STORES, head.join('\n'));
  if (!issuer) issuer = head.find((l) => /[A-Za-zÄÖÜäöü]{3,}/.test(l) && !hasAmount(l) && !/\d{2}\.\d{2}\.\d{2,4}/.test(l))?.replace(/\s{2,}.*/, '').trim() || null;
  doc.issuer = issuer;
  doc.institution = issuer;

  // Datum + Uhrzeit
  const dateLine = lines.slice(0, 20).find((l) => /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(l) && /datum|\bzeit\b|^\W*\d/i.test(l)) || lines.find((l) => /\d{1,2}\.\d{1,2}\.\d{4}/.test(l));
  const dm = dateLine && /(\d{1,2}\.\d{1,2}\.\d{2,4})/.exec(dateLine);
  doc.date = dm ? parseGermanDate(dm[1]) : null;
  const tm = /\b([01]?\d|2[0-3]):([0-5]\d)(?::\d{2})?\b/.exec(lines.slice(0, 20).join('\n'));
  const time = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;

  // MwSt-Block
  const vat = parseVat(lines);
  const flagRate = Object.fromEntries(vat.map((v) => [v.flag, v.rate]));

  // Summe
  const totalIdx = lines.findIndex((l) => TOTAL_RE.test(l) && hasAmount(l));
  let total = totalIdx >= 0 ? lastAmount(lines[totalIdx]) : null;
  let totalSource = 'summe';
  const payLine = lines.find((l) => PAY_RE.test(l) && hasAmount(l) && !/code\s+satz/i.test(l));
  if (total == null && payLine) { total = lastAmount(payLine); totalSource = 'zahlung'; }
  const vatGross = vat.length ? vat.reduce((s, v) => s + v.gross, 0) : null;
  if (total == null && vatGross != null) { total = vatGross; totalSource = 'mwst'; }

  // Positionen: Zeilen vor der Summenzeile (bzw. vor dem MwSt-/Zahlungsblock)
  let end = totalIdx;
  if (end < 0) end = lines.findIndex((l) => STOP_RE.test(l));
  if (end < 0) end = lines.length;
  const items = [];
  for (const raw of lines.slice(0, end)) {
    const line = cleanOcr(raw);
    const q = /^\s*(\d+(?:[.,]\d+)?)\s*(?:stk\.?|kg|x)?\s*[x×]\s*(\d+[.,]\d{2})/i.exec(line);
    if (q && items.length) {
      const prev = items[items.length - 1];
      prev.qty = Number(q[1].replace(',', '.'));
      prev.unitPrice = amountsIn(q[2])[0];
      continue;
    }
    if (META_RE.test(line) || /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(line)) continue;
    const m = ITEM_RE.exec(line);
    if (!m || !/[A-Za-zÄÖÜäöü]{2}/.test(m[1])) continue;
    const price = amountsIn(m[2])[0];
    if (price == null) continue;
    items.push({ text: m[1].trim(), qty: 1, unitPrice: price, total: price, vatRate: m[3] ? (flagRate[m[3]] ?? null) : null, _flag: m[3] || null });
  }
  const lineItems = items.map(({ _flag, ...rest }) => rest);
  const itemsSum = lineItems.reduce((s, i) => s + i.total, 0);

  // Zahlart
  const payText = lines.filter((l) => PAY_RE.test(l)).join(' ');
  const card = /(visa|mastercard|maestro|girocard|ec[- ]?(?:karte|cash)|amex)/i.exec(payText);
  const paymentMethod = card || /kartenzahlung|kreditkarte|contactless/i.test(payText) ? 'Karte' : /\bbar(?:zahlung)?\b|gegeben/i.test(payText) ? 'Bar' : null;

  doc.amount = total;
  doc.fields = {
    time, paymentMethod, cardBrand: card ? card[1].toUpperCase() : null,
    billNo: /bon[- ]?nr\.?:?\s*(\d+)/i.exec(lines.join('\n'))?.[1] || null,
    itemCount: lineItems.length, itemsSum: lineItems.length ? itemsSum : null,
    totalSource, ustId: /ust-?id\w*\.?:?\s*(DE\s?\d{9})/i.exec(lines.join('\n'))?.[1]?.replace(/\s/g, '') || null,
  };
  doc.title = `Kassenbon ${issuer || ''}${doc.date ? ' ' + doc.date : ''}`.trim();

  // Plausibilität
  const itemsOk = lineItems.length ? Math.abs(itemsSum - (total ?? 0)) <= 2 : null;
  const vatOk = vatGross != null && total != null ? Math.abs(vatGross - total) <= 2 : null;
  doc.fields.itemsSumOk = itemsOk;
  doc.fields.vatSumOk = vatOk;
  if (total == null) review(doc, 'Gesamtbetrag nicht erkannt');
  if (!doc.date) review(doc, 'Datum nicht erkannt');
  if (itemsOk === false) review(doc, 'Summe der Positionen weicht vom Gesamtbetrag ab');
  if (vatOk === false) review(doc, 'MwSt-Block passt nicht zum Gesamtbetrag');
  if (!issuer) review(doc, 'Händler nicht erkannt');
  if (extracted?.ocr && typeof extracted.ocrConfidence === 'number' && extracted.ocrConfidence < 55) review(doc, 'OCR-Qualität niedrig');

  return baseResult(doc, { lineItems, vat: vat.length ? vat.map(({ flag, ...v }) => v) : null });
}
