import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractPdfText } from '../src/lib/extract/pdf.js';
import { detectType, detectDocumentType, normalize } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { displayName, TYPE_LABELS, asciiPart } from '../src/lib/parsers/naming.js';
import { parseEInvoiceXml } from '../src/lib/parsers/docs/invoice.js';
import { amountsIn, cleanOcr } from '../src/lib/parsers/docs/util.js';
import { hasStatements } from '../src/lib/parsers/docs/_statements.js';
import { decodeText, parseCsv } from '../src/lib/extract/decode.js';

const OUT = path.resolve(__dirname, '../samples/out');
const FIX = path.resolve(__dirname, 'fixtures');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(OUT, 'EXPECTED.json'), 'utf8')).files;

const metaOf = (rel) => ({ name: path.basename(rel), path: rel, ext: path.extname(rel).slice(1).toLowerCase(), mime: '', size: 1 });

async function pdf(rel) {
  const r = await extractPdfText(fs.readFileSync(path.join(OUT, rel)));
  return { kind: 'pdf', text: r.pages.map((p) => p.text).join('\n\f\n'), pages: r.pages, rows: null, rawText: null, xml: null, ocr: false, ocrConfidence: null, meta: {} };
}
function ocrText(text, { confidence = 80 } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((t, i) => ({ y: 1000 - i * 10, text: t, items: [] }));
  return { kind: 'image', text: lines.map((l) => l.text).join('\n'), pages: [{ n: 1, text: lines.map((l) => l.text).join('\n'), lines }], rows: null, rawText: null, xml: null, ocr: true, ocrConfidence: confidence, meta: {} };
}
const fixture = (n) => ocrText(fs.readFileSync(path.join(FIX, n), 'utf8'));
function plainText(rel) {
  const t = fs.readFileSync(path.join(OUT, rel), 'utf8');
  return { kind: 'text', text: t, rawText: t, pages: [], rows: null, xml: null, ocr: false, ocrConfidence: null, meta: {} };
}

// Beispieldatei → Extracted
const SAMPLES = {
  'Belege/lohnabrechnung_2026-03.pdf': () => pdf('Belege/lohnabrechnung_2026-03.pdf'),
  'Belege/rechnung_elektro_meyer_2026-02.pdf': () => pdf('Belege/rechnung_elektro_meyer_2026-02.pdf'),
  'Belege/rechnung_amazon_monitor_2026-04.pdf': () => pdf('Belege/rechnung_amazon_monitor_2026-04.pdf'),
  'Belege/kassenbon_rewe_2026-04-12.png': () => fixture('rewe.ocr.txt'),
  'Belege/kassenbon_edeka_2026-05-03.jpg': () => fixture('edeka.ocr.txt'),
  'Belege/vertrag_netflix_bestaetigung.pdf': () => pdf('Belege/vertrag_netflix_bestaetigung.pdf'),
  'Belege/scan_rechnung_optiker.png': () => fixture('optiker.ocr.txt'),
  'Versicherungen/allianz_privatrente_standmitteilung_2025.pdf': () => pdf('Versicherungen/allianz_privatrente_standmitteilung_2025.pdf'),
  'Versicherungen/bu_beitragsbescheinigung_2025.pdf': () => pdf('Versicherungen/bu_beitragsbescheinigung_2025.pdf'),
  'Steuer/lohnsteuerbescheinigung_2025.pdf': () => pdf('Steuer/lohnsteuerbescheinigung_2025.pdf'),
  'Steuer/comdirect_jahressteuerbescheinigung_2025.pdf': () => pdf('Steuer/comdirect_jahressteuerbescheinigung_2025.pdf'),
  'Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf': () => pdf('Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf'),
  'einkaufszettel_handschrift.txt': async () => plainText('einkaufszettel_handschrift.txt'),
  'Privat/irrelevant_rezept.txt': async () => plainText('Privat/irrelevant_rezept.txt'),
  'Privat/irrelevant_urlaubsfoto.jpg': async () => fixture('urlaubsfoto.ocr.txt'),
};
const EXPECTED_TYPE = {
  'Belege/lohnabrechnung_2026-03.pdf': 'lohn',
  'Belege/rechnung_elektro_meyer_2026-02.pdf': 'rechnung',
  'Belege/rechnung_amazon_monitor_2026-04.pdf': 'rechnung',
  'Belege/kassenbon_rewe_2026-04-12.png': 'kassenbon',
  'Belege/kassenbon_edeka_2026-05-03.jpg': 'kassenbon',
  'Belege/vertrag_netflix_bestaetigung.pdf': 'vertrag',
  'Belege/scan_rechnung_optiker.png': 'rechnung',
  'Versicherungen/allianz_privatrente_standmitteilung_2025.pdf': 'rente',
  'Versicherungen/bu_beitragsbescheinigung_2025.pdf': 'versicherung',
  'Steuer/lohnsteuerbescheinigung_2025.pdf': 'lohnsteuerbescheinigung',
  'Steuer/comdirect_jahressteuerbescheinigung_2025.pdf': 'steuerbescheinigung',
  'Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf': 'spende',
  'einkaufszettel_handschrift.txt': 'einkaufszettel',
  'Privat/irrelevant_rezept.txt': 'irrelevant',
  'Privat/irrelevant_urlaubsfoto.jpg': 'irrelevant',
};

const cache = {};
async function run(rel) {
  if (!cache[rel]) {
    const extracted = await SAMPLES[rel]();
    const meta = metaOf(rel);
    const detection = detectType(extracted, meta);
    const result = parse(detection, extracted, meta);
    cache[rel] = { extracted, meta, detection, result, doc: result.document };
  }
  return cache[rel];
}

describe('Hilfsfunktionen', () => {
  it('Beträge ignorieren Datum, Prozent und OCR-Rauschen', () => {
    expect(amountsIn('Zusatzbeitrag Krankenversicherung 1,25 %   -65,00')).toEqual([-6500]);
    expect(amountsIn('Datum 12.04.2026 Zeit 10:24')).toEqual([]);
    expect(amountsIn('SUMME EUR 6O,84')).toEqual([6084]);
    expect(amountsIn('Zahnpasta 75ml 2.19 B')).toEqual([219]);
    expect(amountsIn('Fondsguthaben am 31.12.2025   16.482,37 EUR')).toEqual([1648237]);
    expect(cleanOcr('Summe l2,5O')).toBe('Summe 12,50');
  });
  it('normalize', () => { expect(normalize('Rückkaufswert Größe')).toBe('rueckkaufswert groesse'); });
});

describe('Erkennung aller Beispieldateien', () => {
  for (const rel of Object.keys(SAMPLES)) {
    it(`${rel} → ${EXPECTED_TYPE[rel]}`, async () => {
      const { detection } = await run(rel);
      expect(detection.type, JSON.stringify(detection)).toBe(EXPECTED_TYPE[rel]);
      expect(detection.confidence).toBeGreaterThan(0);
      expect(detection.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(detection.signals)).toBe(true);
    });
  }
  it('jede Nicht-Statement-Datei aus EXPECTED.json ist abgedeckt', () => {
    const covered = new Set(Object.keys(SAMPLES));
    const missing = Object.entries(EXPECTED).filter(([, v]) => !/^(bank_csv|depot_csv|paypal_csv|savings_statement_pdf|bank_statement_pdf|camt053)$/.test(v.type)).map(([k]) => k).filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });
  it('Bild ohne Text ist ein unlesbarer Beleg (nicht still ignoriert), E-Rechnung-XML ist Rechnung', () => {
    // Bewusst geändert: früher „irrelevant“ – unlesbare Belege sollen in die Prüfliste statt still zu verschwinden
    expect(detectDocumentType({ kind: 'image', text: '', pages: [], xml: null }, { name: 'IMG_1.jpg' })).toMatchObject({ type: 'finanz_sonstiges', subtype: 'unlesbar' });
    const d = detectDocumentType({ kind: 'xml', text: '<x/>', xml: '<rsm:CrossIndustryInvoice xmlns:rsm="x"></rsm:CrossIndustryInvoice>' }, { name: 'a.xml' });
    expect(d.type).toBe('rechnung');
    expect(d.subtype).toBe('zugferd');
  });
  it('Dateiname hilft bei dünnem Text', () => {
    const d = detectDocumentType({ kind: 'text', text: 'Milch\nEier\nBrot\nButter', pages: [] }, { name: 'einkauf_samstag.txt' });
    expect(d.type).toBe('einkaufszettel');
  });
});

describe('Lohnabrechnung', () => {
  it('Brutto 5.200,00 / Netto 3.290,98', async () => {
    const { doc, result } = await run('Belege/lohnabrechnung_2026-03.pdf');
    const p = result.payroll;
    expect(p.gross).toBe(520000);
    expect(p.net).toBe(329098);
    expect(p.payout).toBe(329098);
    expect(p.lohnsteuer).toBe(72332);
    expect(p.soli).toBe(0);
    expect(p.kirchensteuer).toBe(6510);
    expect(p.kv).toBe(37960 + 6500);
    expect(p.pv).toBe(12480);
    expect(p.rv).toBe(48360);
    expect(p.av).toBe(6760);
    expect(p.period).toBe('2026-03');
    expect(doc.amount).toBe(329098);
    expect(doc.issuer).toBe('Frigotechnik GmbH');
    expect(doc.date).toBe('2026-03-27');
    expect(doc.periodFrom).toBe('2026-03-01');
    expect(doc.periodTo).toBe('2026-03-31');
    expect(doc.needsReview).toBe(false);
    expect(doc.displayName).toBe('2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf');
  });
  it('Abweichung brutto - abzüge ≠ netto → needsReview', async () => {
    const { extracted, meta, detection } = await run('Belege/lohnabrechnung_2026-03.pdf');
    const broken = { ...extracted, pages: [], text: extracted.text.replace('3.290,98', '3.000,00') };
    const r = parse(detection, broken, meta);
    expect(r.document.needsReview).toBe(true);
    expect(r.document.reviewReason).toMatch(/Netto/);
  });
});

describe('Rechnungen', () => {
  it('Elektro Meyer 412,30', async () => {
    const { doc, result } = await run('Belege/rechnung_elektro_meyer_2026-02.pdf');
    expect(doc.amount).toBe(41230);
    expect(doc.issuer).toBe('Elektro Meyer GmbH');
    expect(doc.date).toBe('2026-02-20');
    expect(doc.fields.invoiceNumber).toBe('RE-2026-0213');
    expect(doc.fields.net).toBe(34647);
    expect(doc.fields.tax).toBe(6583);
    expect(doc.fields.laborCost).toBe(23000);
    expect(doc.fields.materialCost).toBe(11647);
    expect(doc.fields.isCraftsman).toBe(true);
    expect(doc.fields.dueDate).toBe('2026-03-06');
    expect(doc.fields.iban).toMatch(/^DE00500100000000000014$/);
    expect(result.vat).toEqual([{ rate: 19, net: 34647, tax: 6583, gross: 41230 }]);
    expect(result.lineItems.length).toBe(2);
    expect(doc.needsReview).toBe(false);
  });
  it('Amazon 249,00', async () => {
    const { doc, result } = await run('Belege/rechnung_amazon_monitor_2026-04.pdf');
    expect(doc.amount).toBe(24900);
    expect(doc.issuer).toBe('Amazon EU S.à r.l.');
    expect(doc.date).toBe('2026-04-07');
    expect(doc.fields.invoiceNumber).toBe('RE-AMZ-2026-0407-7781');
    expect(doc.fields.net).toBe(20924);
    expect(doc.fields.tax).toBe(3976);
    expect(doc.fields.isCraftsman).toBe(false);
    expect(doc.fields.laborCost).toBe(null);
    expect(result.vat[0]).toMatchObject({ rate: 19, tax: 3976 });
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]).toMatchObject({ qty: 1, total: 24900, vatRate: 19 });
    expect(doc.displayName).toBe('2026-04-07_Rechnung_Amazon-EU-S.a-r.l_249,00.pdf');
  });
  it('Optiker-Scan (OCR) 389,00', async () => {
    const { doc, result } = await run('Belege/scan_rechnung_optiker.png');
    expect(doc.amount).toBe(38900);
    expect(doc.issuer).toBe('Optik Muster GmbH');
    expect(doc.date).toBe('2026-03-27');
    expect(doc.fields.invoiceNumber).toBe('OPT-2026-0327');
    expect(doc.fields.net).toBe(32689);
    expect(result.lineItems.map((i) => i.total)).toEqual([21000, 8200, 3489]);
    expect(doc.needsReview).toBe(false);
  });
  it('ZUGFeRD/CII und XRechnung/UBL: XML-Werte', () => {
    const cii = `<?xml version="1.0"?><rsm:CrossIndustryInvoice xmlns:rsm="r" xmlns:ram="a" xmlns:udt="u">
      <rsm:ExchangedDocument><ram:ID>R-1</ram:ID><ram:IssueDateTime><udt:DateTimeString format="102">20260115</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
      <rsm:SupplyChainTradeTransaction>
        <ram:IncludedSupplyChainTradeLineItem><ram:SpecifiedTradeProduct><ram:Name>Beratung</ram:Name></ram:SpecifiedTradeProduct>
          <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>100.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
          <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
          <ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>
            <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>200.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>
        </ram:IncludedSupplyChainTradeLineItem>
        <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Muster Beratung GmbH</ram:Name></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement>
        <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
          <ram:SpecifiedTradeSettlementPaymentMeans><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02 1203 0000 0000 2020 51</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>
          <ram:ApplicableTradeTax><ram:CalculatedAmount>38.00</ram:CalculatedAmount><ram:BasisAmount>200.00</ram:BasisAmount><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>
          <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>200.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount><ram:GrandTotalAmount>238.00</ram:GrandTotalAmount><ram:DuePayableAmount>238.00</ram:DuePayableAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        </ram:ApplicableHeaderTradeSettlement>
      </rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`;
    const ext = { kind: 'pdf', text: 'Rechnung R-1\nBeratung', pages: [], xml: cii };
    const det = detectType(ext, { name: 'r.pdf' });
    expect(det.type).toBe('rechnung');
    const r = parse(det, ext, { name: 'r.pdf', ext: 'pdf' });
    expect(r.document).toMatchObject({ amount: 23800, issuer: 'Muster Beratung GmbH', date: '2026-01-15', subtype: 'zugferd' });
    expect(r.document.fields).toMatchObject({ invoiceNumber: 'R-1', net: 20000, tax: 3800, iban: 'DE02120300000000202051' });
    expect(r.vat).toEqual([{ rate: 19, net: 20000, tax: 3800, gross: 23800 }]);
    expect(r.lineItems[0]).toMatchObject({ text: 'Beratung', qty: 2, unitPrice: 10000, total: 20000, vatRate: 19 });

    const ubl = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="c" xmlns:cac="a"><cbc:ID>X-9</cbc:ID><cbc:IssueDate>2026-02-01</cbc:IssueDate><cbc:DueDate>2026-02-15</cbc:DueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
      <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Beispiel AG</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
      <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">7.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount>100.00</cbc:TaxableAmount><cbc:TaxAmount>7.00</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>7</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
      <cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount>100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount>107.00</cbc:TaxInclusiveAmount><cbc:PayableAmount>107.00</cbc:PayableAmount></cac:LegalMonetaryTotal></Invoice>`;
    const u = parseEInvoiceXml(ubl);
    expect(u).toMatchObject({ format: 'ubl', issuer: 'Beispiel AG', number: 'X-9', date: '2026-02-01', due: '2026-02-15', net: 10000, tax: 700, gross: 10700, payable: 10700 });
  });
});

describe('Kassenbons (OCR)', () => {
  it('REWE 67,84', async () => {
    const { doc, result } = await run('Belege/kassenbon_rewe_2026-04-12.png');
    expect(doc.issuer).toBe('REWE');
    expect(doc.date).toBe('2026-04-12');
    expect(doc.amount).toBe(6784);
    expect(doc.fields.time).toBe('10:24');
    expect(doc.fields.paymentMethod).toBe('Karte');
    expect(doc.fields.cardBrand).toBe('VISA');
    expect(result.lineItems).toHaveLength(13);
    expect(doc.fields.itemsSumOk).toBe(true);
    expect(result.vat).toEqual([
      { rate: 7, net: 4185, tax: 293, gross: 4478 },
      { rate: 19, net: 1938, tax: 368, gross: 2306 },
    ]);
    expect(doc.needsReview).toBe(false);
    expect(doc.displayName).toBe('2026-04-12_Kassenbon_REWE_67,84.png');
  });
  it('EDEKA 47,38', async () => {
    const { doc, result } = await run('Belege/kassenbon_edeka_2026-05-03.jpg');
    expect(doc.issuer).toBe('EDEKA');
    expect(doc.date).toBe('2026-05-03');
    expect(doc.amount).toBe(4738);
    expect(result.lineItems).toHaveLength(12);
    expect(doc.fields.itemsSumOk).toBe(true);
    expect(result.vat.map((v) => v.rate)).toEqual([7, 19]);
    expect(doc.needsReview).toBe(false);
  });
  it('EDEKA mit schlechter OCR (Zeilen zerrissen): Summe aus Zahlungszeile, kein Absturz', () => {
    const ext = fixture('edeka_psm3.ocr.txt');
    const meta = metaOf('Belege/kassenbon_edeka_2026-05-03.jpg');
    const det = detectType(ext, meta);
    expect(det.type).toBe('kassenbon');
    const r = parse(det, ext, meta);
    expect(r.document.amount).toBe(4738);
    expect(r.document.issuer).toBe('EDEKA');
    expect(r.document.date).toBe('2026-05-03');
    expect(r.vat.map((v) => v.rate)).toEqual([7, 19]);
  });
  it('OCR-Rauschen: O statt 0, Leerzeichen im Betrag', () => {
    const txt = 'LIDL\nDatum: 01.06.2026 09:15\nBrot 1,99 B\nMilch O,95 B\nSUMME EUR 2,94\nBar 5,00\n';
    const ext = ocrText(txt);
    const meta = { name: 'bon.jpg', ext: 'jpg' };
    const det = detectType(ext, meta);
    const r = parse(det, ext, meta);
    expect(r.document.issuer).toBe('LIDL');
    expect(r.document.amount).toBe(294);
    expect(r.document.fields.paymentMethod).toBe('Bar');
    expect(r.lineItems).toHaveLength(2);
    expect(r.document.fields.itemsSumOk).toBe(true);
  });
});

describe('Versicherung, Rente, Steuer, Spende, Vertrag, Einkaufszettel', () => {
  it('Allianz Fondsguthaben als Bewertung', async () => {
    const { doc, result } = await run('Versicherungen/allianz_privatrente_standmitteilung_2025.pdf');
    expect(doc.type).toBe('rente');
    expect(result.valuations).toEqual([{ date: '2025-12-31', value: 1648237, label: 'Fondsguthaben' }]);
    expect(result.account).toMatchObject({ kind: 'rente', institution: 'Allianz', number: '4711-0815' });
    expect(result.account.name).toContain('4711-0815');
    expect(doc.institution).toBe('Allianz');
    expect(doc.issuer).toBe('Allianz Lebensversicherungs-AG');
    expect(doc.date).toBe('2025-12-31');
    expect(doc.fields).toMatchObject({ rueckkaufswert: 1491000, fondsguthaben: 1648237, garantierteRente: 41200, garantierteRenteAb: '2056-03-01', premiumMonthly: 15000, premiumYearly: 180000, beitraegeGezahlt: 1230000, startDate: '2019-03-01' });
    expect(doc.amount).toBe(1648237);
    expect(doc.displayName).toBe('2025-12-31_Rente_Allianz-Lebensversicherungs-AG_16482,37.pdf');
  });
  it('BU Jahresbeitrag 747,60', async () => {
    const { doc, result } = await run('Versicherungen/bu_beitragsbescheinigung_2025.pdf');
    expect(doc.type).toBe('versicherung');
    expect(doc.subtype).toBe('bu');
    expect(doc.amount).toBe(74760);
    expect(doc.fields).toMatchObject({ premiumYearly: 74760, premiumMonthly: 6230, contractNumber: '55-778899', buRente: 150000, year: 2025, productKind: 'bu' });
    expect(doc.institution).toBe('Alte Leipziger');
    expect(result.account).toMatchObject({ kind: 'bu', institution: 'Alte Leipziger', number: '55-778899' });
    expect(doc.periodFrom).toBe('2025-01-01');
    expect(doc.periodTo).toBe('2025-12-31');
  });
  it('Lohnsteuerbescheinigung', async () => {
    const { doc, result } = await run('Steuer/lohnsteuerbescheinigung_2025.pdf');
    expect(result.payroll).toMatchObject({ gross: 6000000, lohnsteuer: 834600, soli: 0, kirchensteuer: 75114, rv: 558000, av: 78000, kv: 438000 + 75000, pv: 144000, period: '2025' });
    expect(result.payroll.net).toBe(6000000 - 834600 - 75114 - 1293000);
    expect(doc.fields.svTotal).toBe(1293000);
    expect(doc.issuer).toBe('Frigotechnik GmbH');
    expect(doc.date).toBe('2025-12-31');
    expect(doc.needsReview).toBe(false);
  });
  it('Jahressteuerbescheinigung', async () => {
    const { doc } = await run('Steuer/comdirect_jahressteuerbescheinigung_2025.pdf');
    expect(doc.fields).toMatchObject({ year: 2025, kapitalertraege: 124055, freistellungsauftrag: 100000, freistellungGenutzt: 100000, steuerpflichtigeErtraege: 24055, kapitalertragsteuer: 6014, soli: 331, kirchensteuer: 541, steuernGesamt: 6886 });
    expect(doc.issuer).toBe('comdirect');
    expect(doc.needsReview).toBe(false);
  });
  it('Spende 50,00', async () => {
    const { doc } = await run('Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf');
    expect(doc.amount).toBe(5000);
    expect(doc.issuer).toBe('Ärzte ohne Grenzen e.V.');
    expect(doc.date).toBe('2026-05-14');
    expect(doc.fields.issuedDate).toBe('2026-06-15');
    expect(doc.displayName).toBe('2026-05-14_Spende_Aerzte-ohne-Grenzen-e.V_50,00.pdf');
  });
  it('Netflix-Vertrag 13,99/Monat', async () => {
    const { doc } = await run('Belege/vertrag_netflix_bestaetigung.pdf');
    expect(doc.issuer).toBe('Netflix');
    expect(doc.amount).toBe(1399);
    expect(doc.fields).toMatchObject({ interval: 'monthly', priceMonthly: 1399, priceYearly: 16788, startDate: '2026-06-09', product: 'Standard (HD)', paymentMethod: 'Lastschrift' });
    expect(doc.fields.cancellationPeriod).toBe('jederzeit kündbar');
    expect(doc.date).toBe('2026-06-09');
  });
  it('Einkaufszettel ohne Preise', async () => {
    const { doc, result } = await run('einkaufszettel_handschrift.txt');
    expect(doc.type).toBe('einkaufszettel');
    expect(result.lineItems.map((i) => i.text)).toEqual(['Milch', 'Brot', 'Eier (10er)', 'Kaffee', 'Bananen', 'Zahnpasta']);
    expect(result.lineItems.every((i) => i.total === null)).toBe(true);
  });
  it('Irrelevantes bleibt irrelevant', async () => {
    for (const rel of ['Privat/irrelevant_rezept.txt', 'Privat/irrelevant_urlaubsfoto.jpg']) {
      const { doc } = await run(rel);
      expect(doc.type).toBe('irrelevant');
      expect(doc.displayName).toBeTruthy();
    }
  });
});

describe('Dispatcher', () => {
  it('Parser-Fehler → generisches Prüf-Dokument', () => {
    const det = { type: 'rechnung', confidence: 0.9, signals: [] };
    const boom = { get text() { throw new Error('kaputt'); }, get pages() { throw new Error('kaputt'); } };
    const r = parse(det, boom, { name: 'x.pdf', ext: 'pdf' });
    expect(r.document.needsReview).toBe(true);
    expect(r.document.reviewReason).toMatch(/Parser-Fehler/);
    expect(r.document.displayName).toMatch(/\.pdf$/);
  });
  it('finanz_sonstiges: Generic-Parser findet Datum und größten Summenbetrag', () => {
    const ext = { kind: 'text', text: 'Mahnung der Muster GmbH\nStand 02.03.2026\nOffener Betrag 120,00\nGesamtbetrag inkl. Gebühren 135,50 EUR\n', pages: [] };
    const det = detectType(ext, { name: 'mahnung.txt' });
    expect(det.type).toBe('finanz_sonstiges');
    const r = parse(det, ext, { name: 'mahnung.txt', ext: 'txt' });
    expect(r.document).toMatchObject({ type: 'finanz_sonstiges', date: '2026-03-02', amount: 13550 });
  });
  it('Statement-Typen: Promise; Fehler im statements-Modul → Prüf-Dokument statt Absturz', async () => {
    const r = await parse({ type: 'kontoauszug', format: 'ing_csv', confidence: 0.9 }, { text: '' }, { name: 'a.csv', ext: 'csv' });
    expect(r.document.needsReview).toBe(true);
    expect(r.document.type).toBe('kontoauszug');
    expect(r.document.displayName).toMatch(/\.csv$/);
  });
});

describe('Naming', () => {
  it('Format YYYY-MM-DD_Typ_Aussteller_Betrag.ext, leere Teile entfallen', () => {
    expect(displayName({ type: 'rechnung', date: '2026-02-20', issuer: 'Elektro Meyer GmbH', amount: 41230 }, 'pdf')).toBe('2026-02-20_Rechnung_Elektro-Meyer-GmbH_412,30.pdf');
    expect(displayName({ type: 'vertrag', issuer: 'Müller & Söhne', amount: null }, '.PDF')).toBe('Vertrag_Mueller-&-Soehne.pdf');
    expect(displayName({ type: 'kontoauszug', date: '2026-03-31', issuer: 'ING', fields: { format: 'ing_csv' } }, 'csv')).toBe('2026-03-31_Umsaetze_ING.csv');
    expect(displayName({ type: 'kontoauszug', date: '2026-03-31', issuer: 'ING', fields: { format: 'pdf_statement' } }, 'pdf')).toBe('2026-03-31_Kontoauszug_ING.pdf');
    expect(displayName({ type: 'irrelevant' }, 'jpg')).toBe('Dokument.jpg');
    expect(displayName({ type: 'rechnung', date: '2026-01-01', amount: -500 }, '')).toBe('2026-01-01_Rechnung_5,00');
  });
  it('TYPE_LABELS decken alle Typen mit Icon ab', () => {
    const icons = new Set(['bank', 'receipt', 'invoice', 'payslip', 'tax', 'shield', 'piggy', 'heart', 'contract', 'list', 'file', 'ban']);
    for (const t of ['kontoauszug', 'kreditkarte', 'paypal', 'depot', 'lohn', 'lohnsteuerbescheinigung', 'rechnung', 'kassenbon', 'versicherung', 'rente', 'steuerbescheinigung', 'spende', 'vertrag', 'einkaufszettel', 'finanz_sonstiges', 'irrelevant']) {
      expect(icons.has(TYPE_LABELS[t].icon), t).toBe(true);
      expect(TYPE_LABELS[t].label).toMatch(/^[A-Za-z]+$/);
    }
    expect(asciiPart('Äpfel & Öl/Straße')).toBe('Aepfel-&-Oel-Strasse');
  });
});

describe('Integration mit statements-Modul (falls vorhanden)', () => {
  const FILES = {
    'Banken/ING/ing_girokonto_2026H1.csv': 'kontoauszug',
    'Banken/comdirect/comdirect_girokonto_2026H1.csv': 'kontoauszug',
    'Banken/comdirect/comdirect_depot_2026-06-30.csv': 'depot',
    'Banken/PayPal/paypal_aktivitaeten_2026H1.csv': 'paypal',
    'Banken/ING/camt053_ing_2026-05.xml': 'kontoauszug',
    'Banken/ING/ing_kontoauszug_2026-03.pdf': 'kontoauszug',
    'Banken/Renault/renaultbank_tagesgeld_2026-06.pdf': 'kontoauszug',
  };
  for (const [rel, type] of Object.entries(FILES)) {
    it.skipIf(!hasStatements)(`${rel} → ${type}`, async () => {
      const ext = path.extname(rel).slice(1);
      let e;
      if (ext === 'pdf') e = await pdf(rel);
      else {
        const { text } = decodeText(fs.readFileSync(path.join(OUT, rel)));
        const parsed = ext === 'csv' ? parseCsv(text) : null;
        e = { kind: ext, text, rawText: text, rows: parsed?.rows || null, pages: [], xml: ext === 'xml' ? text : null, meta: { delimiter: parsed?.delimiter || null } };
      }
      const meta = metaOf(rel);
      const det = detectType(e, meta);
      expect(det.type).toBe(type);
      const r = await parse(det, e, meta);
      expect(r.document.type).toBe(type);
      expect(r.document.title).toBeTruthy();
      expect(r.document.displayName).toMatch(new RegExp(`\\.${ext}$`));
    });
  }
});
