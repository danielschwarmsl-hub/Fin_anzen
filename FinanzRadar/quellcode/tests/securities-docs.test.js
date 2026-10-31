// Wertpapier-Dokumente: Erkennung (Typ 'wertpapier' + Untertyp) und Parser (Betrag mit Vorzeichen, Valuta, Kennungen).
// Echte, geschwärzte comdirect-/MLP-Dokumente (OCR je Seite) und synthetische saubere Texte anderer Banken.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractPdfText } from '../src/lib/extract/pdf.js';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { TYPE_LABELS } from '../src/lib/parsers/naming.js';
import { securitySubtype } from '../src/lib/parsers/docs/securities.js';

const REAL = path.resolve(__dirname, 'fixtures/real-ocr');
const OUT = path.resolve(__dirname, '../samples/out');

function real(name) {
  const { pages } = JSON.parse(fs.readFileSync(path.join(REAL, `${name}.json`), 'utf8'));
  return { kind: 'pdf', ocr: true, ocrConfidence: 75, pages, text: pages.map((p) => p.text).join('\n') };
}
const textDoc = (text) => ({ kind: 'pdf', ocr: false, ocrConfidence: null, pages: [{ n: 1, text }], text });

async function run(ex, name = 'dokument.pdf') {
  const meta = { name, ext: 'pdf' };
  const det = detectType(ex, meta);
  const r = await parse(det, ex, meta);
  return { det, doc: r.document, r };
}

describe('Wertpapier – Typ registriert', () => {
  it('TYPE_LABELS kennt wertpapier (Dateiname, Anzeigename, Icon)', () => {
    expect(TYPE_LABELS.wertpapier).toEqual({ label: 'Wertpapier', name: 'Wertpapier / Depot', icon: 'piggy' });
  });
});

describe('Wertpapier – echte comdirect-/MLP-Dokumente (OCR)', () => {
  it('Geschäftsabrechnung Wertpapierkauf: kein Steuerbescheinigung trotz „KEINE STEUERBESCHEINIGUNG“', async () => {
    const { det, doc } = await run(real('comdirect_wertpapierkauf'), 'scan.pdf');
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kauf');
    expect(det.confidence).toBeGreaterThanOrEqual(0.85);
    expect(det.uncertain).toBeFalsy();
    expect(doc.type).toBe('wertpapier');
    expect(doc.subtype).toBe('kauf');
    expect(doc.institution).toBe('comdirect');
    expect(doc.date).toBe('2026-08-19');
    expect(doc.fields.valuta).toBe('2026-08-21');
    expect(doc.amount).toBe(-107730);
    expect(doc.fields.venue).toBe('TRADEGATE');
    // Geschwärzte Ziffern („N.H62,00“, „MH, 50“) ergeben keine Fantasiebeträge
    expect(doc.fields.marketValue).toBeNull();
    expect(doc.fields.fees).toBeNull();
    expect(doc.fields.orderNo).toBeNull();
    expect(doc.fields.infoOnly).toBeUndefined();
    expect(doc.title).toBe('Wertpapierkauf comdirect 1.077,30 €');
    expect(doc.displayName).toBe('2026-08-19_Wertpapier_comdirect_1077,30.pdf');
    expect(doc.needsReview).toBe(false);
  });

  it('Dividendengutschrift Microsoft: Wertpapier › Dividende, +3,32 €, Valuta 14.09.2026, keine Rechnung', async () => {
    const { det, doc } = await run(real('comdirect_dividende'), 'scan.pdf');
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('dividende');
    expect(det.alternatives.map((a) => a.type)).not.toContain('rechnung');
    expect(doc.amount).toBe(332);
    expect(doc.date).toBe('2026-09-10');
    expect(doc.institution).toBe('comdirect');
    expect(doc.fields).toMatchObject({
      security: 'Microsoft Corp.', quantity: 5, valuta: '2026-09-14', currency: 'USD', grossForeign: 455,
      withholdingTax: 68, fxRate: 1.1659, perShare: 0.91, capitalIncome: true,
    });
    expect(doc.title).toBe('Dividende Microsoft Corp. 3,32 €');
    expect(doc.needsReview).toBe(false);
  });

  it.each([
    ['comdirect_kosteninfo_1', '2025-11-20', { quantity: 30, price: 3916, venue: 'gettex' }],
    ['comdirect_kosteninfo_2', '2026-10-15', { quantity: 3, venue: null }],
  ])('%s: Kosteninformation (MiFID) ist nur Info – kein Betrag', async (name, date, extra) => {
    const { det, doc } = await run(real(name), 'scan.pdf');
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kosteninfo');
    expect(doc.amount).toBeNull();
    expect(doc.date).toBe(date);
    expect(doc.institution).toBe('comdirect');
    expect(doc.fields).toMatchObject({ infoOnly: true, side: 'kauf', ...extra });
    expect(doc.title).toBe('Kosteninformation Wertpapierkauf');
    expect(doc.needsReview).toBe(false);
  });

  it('MLP Reporting Konten & Depots: Depot-Reporting Q1 2025 (Info, kein Betrag, kein „Typ unsicher“)', async () => {
    const { det, doc } = await run(real('mlp_depotreport'), 'scan.pdf');
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('depotreport');
    expect(det.uncertain).toBeFalsy();
    expect(doc.institution).toBe('MLP');
    expect(doc.amount).toBeNull();
    expect(doc.periodFrom).toBe('2025-01-01');
    expect(doc.periodTo).toBe('2025-03-31');
    expect(doc.date).toBe('2025-03-31');
    expect(doc.fields).toMatchObject({ infoOnly: true, period: 'Q1 2025', depot: 'Vermögensdepot' });
    expect(doc.title).toBe('Depot-Reporting Q1 2025 MLP');
    expect(doc.needsReview).toBe(false);
  });

  it('comdirect Finanzreport mit Ertragsgutschrift-Buchungszeile wird kein Wertpapier-Dokument', async () => {
    const { det } = await run(real('comdirect_finanzreport'), 'scan.pdf');
    expect(det.type).not.toBe('wertpapier');
  });
});

const VERKAUF = `comdirect bank AG · 25449 Quickborn
Wertpapierabrechnung Verkauf
GESCHÄFTSABRECHNUNG VOM 03.03.2026
Wertpapierverkauf
Geschäftsnummer   : 72-1234567          Ordernummer : 123456789012
Geschäftstag      : 03.03.2026          Ausführungsplatz : XETRA
Wertpapier-Bezeichnung                                  WPKNR/ISIN
Deutsche Bank AG Namens-Aktien o.N.                     514000 / DE0005140008
St. 100            Kurs   EUR 18,50
Kurswert                         : EUR       1.850,00
Provision                        : EUR           4,90
Börsenplatzabhäng. Entgelt       : EUR           1,50
Summe Entgelte                   : EUR           6,40
IBAN                         Valuta       Zu Ihren Gunsten vor Steuern
DE12 3456 7890 1234 5678 90  05.03.2026   EUR 1.843,60
Steuerliche Behandlung: Wertpapierverkauf Nr. 72-1234567 vom 03.03.2026
Kapitalertragsteuer EUR -50,00
Solidaritätszuschlag EUR -2,75
abgeführte Steuern EUR -52,75
Zu Ihren Gunsten nach Steuern: EUR 1.790,85
Dies ist keine Steuerbescheinigung.`;

const ERTRAG_FONDS = `DKB AG · Deutsche Kreditbank AG
Ertragsgutschrift
Ausschüttung Investmentfonds
Datum: 15.05.2026
Wertpapier-Bezeichnung                          WKN / ISIN
iShares Core MSCI World UCITS ETF               A0RPWH / IE00B4L5Y983
Stück 120,000
Ausschüttung pro Stück EUR 0,35
Bruttobetrag EUR 42,00
Kapitalertragsteuer EUR 7,35
Solidaritätszuschlag EUR 0,40
Ausmachender Betrag EUR 34,25
Valuta 15.05.2026   Zu Ihren Gunsten nach Steuern   EUR 34,25
Dieses ist keine Steuerbescheinigung.`;

const TRADE_REPUBLIC = `TRADE REPUBLIC BANK GMBH
WERTPAPIERABRECHNUNG
DATUM 12.02.2026
ÜBERSICHT
Market-Order Kauf am 12.02.2026, um 10:15 Uhr an der Lang & Schwarz Exchange.
Der Auftrag wurde am 12.02.2026 erteilt. Order 9a8b-1234
POSITION ANZAHL PREIS BETRAG
Apple Inc. 10 Stk. 150,00 EUR 1.500,00 EUR
ISIN: US0378331005
ABRECHNUNG
Fremdkostenzuschlag -1,00 EUR
GESAMT -1.501,00 EUR
BUCHUNG
VERRECHNUNGSKONTO VALUTA BETRAG
DE00 1001 1001 2620 0000 00 14.02.2026 -1.501,00 EUR`;

describe('Wertpapier – synthetische Abrechnungen anderer Banken', () => {
  it('Verkauf: positiver Endbetrag nach Steuern, Kennungen, Entgelte, Steuern', async () => {
    const { det, doc } = await run(textDoc(VERKAUF));
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('verkauf');
    expect(doc.amount).toBe(179085);
    expect(doc.date).toBe('2026-03-03');
    expect(doc.institution).toBe('comdirect');
    expect(doc.fields).toMatchObject({
      security: 'Deutsche Bank AG Namens-Aktien o.N.', wkn: '514000', isin: 'DE0005140008', quantity: 100, price: 1850,
      venue: 'XETRA', orderNo: '123456789012', valuta: '2026-03-05', marketValue: 185000, fees: 640, taxPaid: 5275,
    });
    expect(doc.title).toBe('Wertpapierverkauf Deutsche Bank AG Namens-Aktien o.N. 1.790,85 €');
  });

  it('Ertragsgutschrift eines Fonds (Ausschüttung) = Dividende/Kapitalertrag', async () => {
    const { det, doc } = await run(textDoc(ERTRAG_FONDS));
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('dividende');
    expect(doc.institution).toBe('DKB');
    expect(doc.amount).toBe(3425);
    expect(doc.date).toBe('2026-05-15');
    expect(doc.fields).toMatchObject({
      security: 'iShares Core MSCI World UCITS ETF', wkn: 'A0RPWH', isin: 'IE00B4L5Y983', quantity: 120,
      currency: 'EUR', gross: 4200, grossForeign: null, valuta: '2026-05-15', capitalIncome: true, taxPaid: 735,
    });
  });

  it('Trade-Republic-Abrechnung (Kauf): Belastung negativ, Valuta, Fremdkosten', async () => {
    const { det, doc } = await run(textDoc(TRADE_REPUBLIC));
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kauf');
    expect(doc.institution).toBe('Trade Republic');
    expect(doc.amount).toBe(-150100);
    expect(doc.date).toBe('2026-02-12');
    expect(doc.fields).toMatchObject({
      security: 'Apple Inc.', isin: 'US0378331005', quantity: 10, price: 15000, venue: 'Lang & Schwarz', valuta: '2026-02-14', fees: 100,
    });
  });

  it('Untertyp-Regeln', () => {
    expect(securitySubtype('Kosteninformation zum Wertpapiergeschäft Kauf: 3 Stück')).toBe('kosteninfo');
    expect(securitySubtype('Depotauszug per 31.12.2025')).toBe('depotreport');
    expect(securitySubtype('Zinsgutschrift Anleihe Kupon')).toBe('dividende');
    expect(securitySubtype('Wertpapierkauf Zu Ihren Lasten')).toBe('kauf');
    expect(securitySubtype('Wertpapierverkauf Zu Ihren Gunsten')).toBe('verkauf');
  });
});

describe('Wertpapier – bestehende Erkennung bleibt', () => {
  it('echte Jahressteuerbescheinigung bleibt Steuerbescheinigung', async () => {
    const r = await extractPdfText(fs.readFileSync(path.join(OUT, 'Steuer/comdirect_jahressteuerbescheinigung_2025.pdf')));
    const ex = { kind: 'pdf', text: r.pages.map((p) => p.text).join('\n\f\n'), pages: r.pages, ocr: false };
    const { det, doc } = await run(ex, 'comdirect_jahressteuerbescheinigung_2025.pdf');
    expect(det.type).toBe('steuerbescheinigung');
    expect(doc.type).toBe('steuerbescheinigung');
  });

  it('Jahressteuerbescheinigung mit Dividenden/Ausschüttungen bleibt Steuerbescheinigung', async () => {
    const text = `Musterbank AG
Jahressteuerbescheinigung 2025
Steuerbescheinigung für Privatkunden nach § 45a EStG
Kapitalerträge (Dividenden, Ausschüttungen, Zinsen) EUR 1.240,55
Kapitalertragsteuer EUR 210,00
Solidaritätszuschlag EUR 11,55
Freistellungsauftrag in Anspruch genommen EUR 400,00
Depot 1234567`;
    const { det } = await run(textDoc(text));
    expect(det.type).toBe('steuerbescheinigung');
  });

  it('echte Steuerbescheinigung mit dem Wort „Steuerbescheinigung“ zählt weiter', async () => {
    const { det } = await run(textDoc('Bank AG\nSteuerbescheinigung 2025\nKapitalerträge EUR 300,00\nKapitalertragsteuer EUR 75,00'));
    expect(det.type).toBe('steuerbescheinigung');
  });

  it('normale Rechnung bleibt Rechnung', async () => {
    const r = await extractPdfText(fs.readFileSync(path.join(OUT, 'Belege/rechnung_elektro_meyer_2026-02.pdf')));
    const ex = { kind: 'pdf', text: r.pages.map((p) => p.text).join('\n\f\n'), pages: r.pages, ocr: false };
    const { det } = await run(ex, 'rechnung_elektro_meyer_2026-02.pdf');
    expect(det.type).toBe('rechnung');
  });

  it('Rechnung mit „zahlbar“ und Kurswort bleibt Rechnung', async () => {
    const text = `Musterfirma GmbH\nRechnung\nRechnungsnummer: RE-2026-001\nRechnungsdatum: 02.03.2026\nKurs Excel für Einsteiger 1 Stück 199,00\nNettobetrag 199,00\nzzgl. 19 % MwSt 37,81\nGesamtbetrag 236,81\nZahlbar innerhalb von 14 Tagen`;
    const { det } = await run(textDoc(text));
    expect(det.type).toBe('rechnung');
  });
});
