// Rechnung (PDF/Scan/OCR) inkl. ZUGFeRD/XRechnung-XML.
import { XMLParser } from 'fast-xml-parser';
import { parseGermanDate, normalizeIban, addDays } from '../../util/format.js';
import {
  amountsIn, lastAmount, getLines, cols, findIdx, labelValue, baseDoc, baseResult, review, snapRate,
  issuerFromHeader, firstIban, firstDate, hasAmount, cleanOcr,
} from './util.js';

const GROSS_RE = /(rechnungsbetrag|gesamtbetrag|endbetrag|zahlbetrag|zu zahlen|gesamtsumme|amount due|total amount|summe brutto|bruttobetrag|brutto)/i;
const NET_RE = /(nettobetrag|summe netto|netto ?summe|zwischensumme|gesamt netto|^\W*netto\b)/i;
const TAX_RE = /(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:ust|umsatzsteuer|mwst|mehrwertsteuer)|(?:ust|umsatzsteuer|mwst|mehrwertsteuer)\.?\s*(?:von\s*)?(\d{1,2}(?:[.,]\d+)?)\s*%/i;
const LABOR_RE = /(arbeitskosten|arbeitslohn|lohnanteil|lohnkosten|arbeitsleistung|arbeitszeit|montage|stundenlohn)/i;
const CRAFT_RE = /(handwerk|elektro|sanit[aä]r|installat|maler|reinigung|dachdeck|schreiner|tischler|klempner|heizung|schornstein|gartenbau|meisterbetrieb|fliesen|gebäudereinigung|monteur)/i;
const META_RE = /^\W*(rechnungs|rechnung\s*(?:nr|nummer)|datum|kunde|bestell|steuernummer|ust|zahlungs|zahlbar|leistungszeitraum|lieferung|kundennummer|iban|bic|tel|seite|fax|e-?mail|www|empf[aä]nger|zahlart|verwendungszweck)/i;
const HEADER_RE = /^\W*(pos\.?|position|artikel|bezeichnung|leistung|beschreibung|menge)\b/i;
// Summen-/Steuerzeilen beenden die Positionsliste und sind nie Positionen
const SUM_RE = /^\W*(?:gesamt\w*|summe\w*|zwischensumme|netto\w*|nettobetrag|brutto\w*|mwst\.?|ust\.?|umsatzsteuer|mehrwertsteuer|zzgl\.?|inkl\.?|enthaltene|zu zahlen|zahlbetrag|rechnungsbetrag|endbetrag|\d{1,2}(?:[.,]\d+)?\s*%\s*(?:mwst|ust|umsatzsteuer|mehrwertsteuer))\b/i;

const xmlParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const cents = (v) => (v == null || v === '' ? null : Math.round(Number(String(v).replace(',', '.')) * 100));
const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(',', '.')));
const ciDate = (s) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : parseGermanDate(s); };
const textOf = (n) => (n == null ? null : typeof n === 'object' ? (n['#text'] ?? null) : String(n));

/** ZUGFeRD/Factur-X (CII) oder XRechnung (UBL) → Teilergebnis oder null. */
export function parseEInvoiceXml(xml) {
  let root;
  try { root = xmlParser.parse(xml); } catch { return null; }
  if (root.CrossIndustryInvoice) {
    const x = root.CrossIndustryInvoice;
    const tx = x.SupplyChainTradeTransaction || {};
    const ag = tx.ApplicableHeaderTradeAgreement || {};
    const st = tx.ApplicableHeaderTradeSettlement || {};
    const sum = st.SpecifiedTradeSettlementHeaderMonetarySummation || {};
    const vat = arr(st.ApplicableTradeTax).map((t) => ({ rate: num(t.RateApplicablePercent), net: cents(t.BasisAmount), tax: cents(t.CalculatedAmount) }))
      .map((v) => ({ ...v, gross: v.net != null && v.tax != null ? v.net + v.tax : null }));
    const means = arr(st.SpecifiedTradeSettlementPaymentMeans)[0] || {};
    const lineItems = arr(tx.IncludedSupplyChainTradeLineItem).map((li) => {
      const lt = li.SpecifiedLineTradeSettlement || {};
      return {
        text: textOf(li.SpecifiedTradeProduct?.Name) || '', qty: num(textOf(li.SpecifiedLineTradeDelivery?.BilledQuantity)),
        unitPrice: cents(li.SpecifiedLineTradeAgreement?.NetPriceProductTradePrice?.ChargeAmount),
        total: cents(lt.SpecifiedTradeSettlementLineMonetarySummation?.LineTotalAmount),
        vatRate: num(arr(lt.ApplicableTradeTax)[0]?.RateApplicablePercent),
      };
    });
    return {
      format: 'cii', issuer: textOf(ag.SellerTradeParty?.Name), number: textOf(x.ExchangedDocument?.ID),
      date: ciDate(textOf(x.ExchangedDocument?.IssueDateTime?.DateTimeString)),
      due: ciDate(textOf(arr(st.SpecifiedTradePaymentTerms)[0]?.DueDateDateTime?.DateTimeString)),
      net: cents(sum.TaxBasisTotalAmount ?? sum.LineTotalAmount), tax: cents(sum.TaxTotalAmount),
      gross: cents(sum.GrandTotalAmount), payable: cents(sum.DuePayableAmount),
      currency: textOf(st.InvoiceCurrencyCode) || 'EUR', iban: normalizeIban(textOf(means.PayeePartyCreditorFinancialAccount?.IBANID)),
      vat, lineItems,
    };
  }
  if (root.Invoice) {
    const x = root.Invoice;
    const sup = x.AccountingSupplierParty?.Party || {};
    const lm = x.LegalMonetaryTotal || {};
    const taxTotal = arr(x.TaxTotal)[0] || {};
    const vat = arr(taxTotal.TaxSubtotal).map((t) => {
      const net = cents(t.TaxableAmount), tax = cents(t.TaxAmount);
      return { rate: num(t.TaxCategory?.Percent), net, tax, gross: net != null && tax != null ? net + tax : null };
    });
    const lineItems = arr(x.InvoiceLine).map((li) => ({
      text: textOf(li.Item?.Name) || '', qty: num(textOf(li.InvoicedQuantity)), unitPrice: cents(li.Price?.PriceAmount),
      total: cents(li.LineExtensionAmount), vatRate: num(li.Item?.ClassifiedTaxCategory?.Percent),
    }));
    return {
      format: 'ubl', issuer: textOf(sup.PartyLegalEntity?.RegistrationName) || textOf(sup.PartyName?.Name),
      number: textOf(x.ID), date: parseGermanDate(textOf(x.IssueDate)), due: parseGermanDate(textOf(x.DueDate)),
      net: cents(lm.TaxExclusiveAmount ?? lm.LineExtensionAmount), tax: cents(taxTotal.TaxAmount),
      gross: cents(lm.TaxInclusiveAmount), payable: cents(lm.PayableAmount),
      currency: textOf(x.DocumentCurrencyCode) || 'EUR',
      iban: normalizeIban(textOf(arr(x.PaymentMeans)[0]?.PayeeFinancialAccount?.ID)), vat, lineItems,
    };
  }
  return null;
}

/** Summenbetrag: erster Betrag nach dem Label („Rechnungsbetrag 249,00 (inkl. 39,76 MwSt)“ → 249,00). */
function amountAfter(line, re) {
  const m = re.exec(line);
  const after = m ? amountsIn(line.slice(m.index + m[0].length)) : [];
  return after.length ? after[0] : lastAmount(line);
}

function parseText(lines) {
  const joined = lines.join('\n');
  const out = {};
  // Rechnungsnummer
  const numRe = /(?:rechnungs-?\s?(?:nummer|nr\.?)|rechnung\s*(?:nr\.?|nummer)|invoice\s*(?:no\.?|number|nr\.?|#)|belegnummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/_.]{2,})/i;
  const nm = numRe.exec(joined);
  out.number = nm ? nm[1].replace(/[.,]$/, '') : null;

  // Datum
  const dl = lines.find((l) => /rechnungsdatum|invoice date|belegdatum/i.test(l)) || lines.find((l) => /^\W*datum\b/i.test(l));
  out.date = (dl && firstDate(dl)) || null;
  if (!out.date) {
    const noService = lines.filter((l) => !/(leistungszeitraum|lieferung|lieferdatum|belastung|f[aä]llig)/i.test(l));
    out.date = firstDate(noService.join('\n'));
  }
  // Fälligkeit
  const fl = lines.find((l) => /(f[aä]llig|zahlungsziel|zahlbar bis)/i.test(l) && firstDate(l));
  out.due = fl ? firstDate(fl) : null;
  if (!out.due && out.date) {
    const td = /(?:binnen|innerhalb von|innerhalb|zahlbar in)\s*(\d{1,3})\s*tagen/i.exec(joined);
    if (td) out.due = addDays(out.date, Number(td[1]));
  }

  // Beträge
  const grossLines = lines.filter((l) => GROSS_RE.test(l) && hasAmount(l) && !/(netto|zwischensumme)/i.test(l.replace(/brutto/gi, '')));
  const prefer = grossLines.find((l) => /(rechnungsbetrag|gesamtbetrag|endbetrag|zahlbetrag|zu zahlen|gesamtsumme)/i.test(l)) || grossLines[grossLines.length - 1];
  out.gross = prefer ? amountAfter(prefer, GROSS_RE) : null;
  const netLine = lines.find((l) => NET_RE.test(l) && hasAmount(l));
  out.net = netLine ? amountAfter(netLine, NET_RE) : null;

  const vat = [];
  for (const l of lines) {
    const m = TAX_RE.exec(l);
    if (!m || !hasAmount(l)) continue;
    const rate = Number(String(m[1] || m[2]).replace(',', '.'));
    const a = amountsIn(l);
    vat.push({ rate, tax: a[a.length - 1] });
  }
  out.vat = vat;

  // IBAN (Zahlungsempfänger)
  const ibanLine = lines.find((l) => /iban/i.test(l) && firstIban(l)) || lines.find((l) => /(zahl|überweis|ueberweis)/i.test(l) && firstIban(l));
  out.iban = ibanLine ? firstIban(ibanLine) : null;
  return out;
}

// Menge mit Einheit („2 Stk“, „3,5 h“, „1x“ …) – gilt als echte Mengenangabe
const QTY_UNIT_RE = /^(\d+(?:[.,]\d+)?)\s*(?:x|stk\.?|st\.?|st[uü]ck|h|std\.?|stunden?|kg|g|l|m|m[²2]|qm|lfm|psch\.?|pausch\.?|pauschal)$/i;
const QTY_PLAIN_RE = /^\d{1,4}(?:[.,](?:\d|\d{3}))?$/; // „2“, „2,5“, „0,512“ – nicht „34,50“ (Betrag)
const near = (a, b) => Math.abs(a - b) <= 1; // ±1 ct

/**
 * Menge/Einzelpreis einer Position. Menge nur aus echter Mengenspalte (Einheit oder Kopfzeile „Menge“) oder wenn
 * Menge × Einzelpreis = Gesamt; sonst Menge 1 und Einzelpreis = Gesamt (Beträge sind nie Mengen).
 */
function qtyOf(cells, total, hasQtyColumn) {
  const amounts = cells.map((c) => (QTY_PLAIN_RE.test(c) || QTY_UNIT_RE.test(c) ? null : amountsIn(c)[0] ?? null));
  const prices = amounts.filter((v) => v != null);
  const unit = prices.length ? prices[0] : null; // cells ohne Gesamtspalte
  const fits = (q) => unit != null && near(Math.round(q * unit), total);
  for (const c of cells) {
    const mu = QTY_UNIT_RE.exec(c);
    const plain = !mu && QTY_PLAIN_RE.test(c) ? c : null;
    const q = Number(String(mu ? mu[1] : plain || '').replace(',', '.'));
    if (!(q > 0)) continue;
    if (mu || fits(q) || (hasQtyColumn && Number.isInteger(q))) {
      return { qty: q, unitPrice: fits(q) ? unit : Math.round(total / q) };
    }
  }
  // Menge als Betrag geschrieben („2,00   12,50   25,00“): nur bei exakt passendem Produkt
  if (prices.length >= 2) {
    const q = prices[0] / 100;
    if (q > 0 && near(Math.round(q * prices[1]), total)) return { qty: q, unitPrice: prices[1] };
  }
  return { qty: 1, unitPrice: total };
}

function parseItems(lines, stopIdx) {
  // Positionsbereich: nach Kopfzeile (falls vorhanden), sonst ab Beginn bis zur ersten Summenzeile
  const h = findIdx(lines, HEADER_RE);
  const start = h >= 0 && h < stopIdx ? h + 1 : 0;
  const hasQtyColumn = h >= 0 && /\b(menge|anzahl|anz\.?|stk|st[uü]ck)\b/i.test(lines[h]);
  const items = [];
  for (const raw of lines.slice(start, stopIdx)) {
    const line = cleanOcr(raw);
    if (META_RE.test(line) || HEADER_RE.test(line) || SUM_RE.test(line)) continue;
    const c = cols(line);
    let rest = c;
    if (rest.length >= 3 && /^\d{1,3}$/.test(rest[0])) rest = rest.slice(1);
    const text0 = rest[0];
    const amts = amountsIn(rest.slice(1).join('   '));
    let text = text0, total = null, qty = 1, vatRate = null, unitPrice = null;
    if (rest.length === 1) {
      const m = /^(.+?)\s+(-?\d{1,3}(?:\.\d{3})*[.,]\d{2})\s*(?:EUR|€)?$/.exec(line);
      if (!m) continue;
      text = m[1].replace(/,?\s*Pos\.?\s*\d+\s*$/i, '').trim();
      total = amountsIn(m[2])[0];
    } else {
      if (!amts.length) continue;
      total = amts[amts.length - 1];
      const pr = rest.slice(1).find((x) => /^\d{1,2}(?:[.,]\d+)?\s*%$/.test(x));
      if (pr) vatRate = Number(pr.replace('%', '').replace(',', '.'));
      const cells = rest.slice(1, -1).filter((x) => x !== pr);
      ({ qty, unitPrice } = qtyOf(cells, total, hasQtyColumn));
    }
    if (!text || !/[A-Za-zÄÖÜäöü]{2}/.test(text)) continue;
    items.push({ text, qty, unitPrice: unitPrice ?? total, total, vatRate });
  }
  return items;
}

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted);
  const doc = baseDoc(detection, { type: 'rechnung' });
  const xml = extracted?.xml && /CrossIndustryInvoice|<(?:\w+:)?Invoice[\s>]/.test(extracted.xml) ? parseEInvoiceXml(extracted.xml) : null;
  const t = parseText(lines);

  const issuer = xml?.issuer || issuerFromHeader(lines);
  let gross = xml?.payable ?? xml?.gross ?? t.gross;
  if (xml?.gross != null && xml?.payable != null && Math.abs(xml.payable - xml.gross) > 0) gross = xml.gross; // Anzahlung o. Ä. – Gesamtbetrag zählt
  let net = xml?.net ?? t.net;
  let vat = (xml?.vat?.length ? xml.vat : t.vat.map((v) => ({ ...v, net: null, gross: null }))).filter((v) => v.tax != null);
  const taxTotal = xml?.tax ?? (vat.length ? vat.reduce((s, v) => s + v.tax, 0) : null);

  if (net == null && gross != null && taxTotal != null) net = gross - taxTotal;
  if (gross == null && net != null && taxTotal != null) gross = net + taxTotal;
  vat = vat.map((v) => {
    const rate = snapRate(v.rate, vat.length === 1 ? net : v.tax && v.rate ? Math.round(v.tax * 100 / v.rate) : 0, v.tax);
    const vnet = v.net ?? (vat.length === 1 && net != null ? net : v.rate ? Math.round((v.tax * 100) / v.rate) : null);
    return { rate, net: vnet, tax: v.tax, gross: v.gross ?? (vnet != null ? vnet + v.tax : null) };
  });

  // Positionen
  let lineItems = xml?.lineItems?.length ? xml.lineItems : null;
  if (!lineItems) {
    const stop = (() => { const i = lines.findIndex((l) => (SUM_RE.test(l) || NET_RE.test(l)) && hasAmount(l)); return i >= 0 ? i : lines.length; })();
    lineItems = parseItems(lines, stop);
  }

  // Handwerker: Arbeits-/Materialkosten (Netto)
  const joined = lines.join('\n');
  let laborCost = null;
  const lc = lines.find((l) => LABOR_RE.test(l) && /(enthalten|davon|inkl)/i.test(l) && hasAmount(l));
  if (lc) laborCost = amountsIn(lc)[0];
  else {
    const li = lineItems.filter((i) => LABOR_RE.test(i.text));
    if (li.length) laborCost = li.reduce((s, i) => s + (i.total || 0), 0);
  }
  const matItems = lineItems.filter((i) => /material/i.test(i.text));
  let materialCost = matItems.length ? matItems.reduce((s, i) => s + (i.total || 0), 0) : null;
  const isCraftsman = CRAFT_RE.test(`${issuer || ''}\n${joined.slice(0, 600)}`) || laborCost != null;
  if (materialCost == null && laborCost != null && net != null) materialCost = net - laborCost;
  const mainRate = vat.length ? vat[0].rate : 19;
  // Genau ein Steuersatz im Dokument: gilt für alle Positionen ohne eigenen Satz
  if (vat.length === 1 && vat[0].rate != null) lineItems = lineItems.map((i) => (i.vatRate == null ? { ...i, vatRate: vat[0].rate } : i));

  doc.issuer = issuer;
  doc.institution = issuer;
  doc.date = xml?.date || t.date;
  doc.amount = gross;
  doc.currency = xml?.currency || 'EUR';
  doc.fields = {
    invoiceNumber: xml?.number || t.number, dueDate: xml?.due || t.due, net, tax: taxTotal, gross,
    iban: xml?.iban || t.iban, orderNumber: /bestell(?:nummer|nr\.?)\s*[:.]?\s*([A-Z0-9\-]+)/i.exec(joined)?.[1] || null,
    steuernummer: /steuernummer\s*[:.]?\s*([\d/]+)/i.exec(joined)?.[1] || null,
    laborCost, laborCostGross: laborCost != null ? Math.round(laborCost * (1 + mainRate / 100)) : null,
    materialCost, isCraftsman, eInvoice: xml?.format || null,
  };
  if (xml) doc.subtype = xml.format === 'ubl' ? 'xrechnung' : 'zugferd';
  doc.title = `Rechnung ${issuer || ''}${doc.fields.invoiceNumber ? ' ' + doc.fields.invoiceNumber : ''}`.trim();

  // Plausibilität
  if (gross == null) review(doc, 'Rechnungsbetrag nicht erkannt');
  if (!doc.date) review(doc, 'Rechnungsdatum nicht erkannt');
  if (!issuer) review(doc, 'Aussteller nicht erkannt');
  if (net != null && taxTotal != null && gross != null && Math.abs(net + taxTotal - gross) > 2) review(doc, 'Netto + Steuer ≠ Brutto');
  const itemsSum = lineItems.reduce((s, i) => s + (i.total || 0), 0);
  if (lineItems.length && gross != null && net != null && ![net, gross].some((v) => Math.abs(itemsSum - v) <= 2)) review(doc, 'Positionssumme weicht ab');
  if (extracted?.ocr && typeof extracted.ocrConfidence === 'number' && extracted.ocrConfidence < 55) review(doc, 'OCR-Qualität niedrig');

  return baseResult(doc, { lineItems, vat: vat.length ? vat : null });
}
