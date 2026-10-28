import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeText, parseCsv } from '../src/lib/extract/decode.js';
import { extractPdfText } from '../src/lib/extract/pdf.js';
import {
  detectStatementFormat, parseStatement, parseStatementAll, guessCsvMapping, parseCsvWithMapping, parseSepaTokens, normalizeBookingText,
} from '../src/lib/parsers/statements/index.js';

const ROOT = path.resolve(import.meta.dirname, '../samples/out');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'EXPECTED.json'), 'utf8')).files;
const cents = s => Math.round(Number(s) * 100);

function csvExtracted(buf) {
  const { text } = decodeText(buf);
  const p = parseCsv(text);
  return { kind: 'csv', text, rawText: text, rows: p.rows, meta: { delimiter: p.delimiter } };
}
const csvFromString = s => csvExtracted(Buffer.from(s, 'utf8'));
async function load(rel) {
  const f = path.join(ROOT, rel);
  const buf = fs.readFileSync(f);
  const meta = { name: path.basename(f), ext: path.extname(f).slice(1) };
  if (meta.ext === 'pdf') {
    const r = await extractPdfText(new Uint8Array(buf));
    return { ex: { kind: 'pdf', pages: r.pages, text: r.text }, meta };
  }
  if (meta.ext === 'xml') { const { text } = decodeText(buf); return { ex: { kind: 'xml', rawText: text, xml: text, text }, meta }; }
  return { ex: csvExtracted(buf), meta };
}
async function run(rel) {
  const { ex, meta } = await load(rel);
  const det = detectStatementFormat(ex, meta);
  const res = det ? await parseStatement(det, ex, meta) : null;
  return { det, res, ex, meta };
}
const sum = r => r.transactions.reduce((a, t) => a + t.amount, 0);

describe('ING CSV', () => {
  let r;
  beforeAll(async () => { r = await run('Banken/ING/ing_girokonto_2026H1.csv'); });
  it('Erkennung', () => {
    expect(r.det).toMatchObject({ type: 'kontoauszug', format: 'ing_csv', institution: 'ING' });
    expect(r.det.confidence).toBeGreaterThan(0.9);
  });
  it('Buchungen und Salden laut EXPECTED', () => {
    const exp = EXPECTED['Banken/ING/ing_girokonto_2026H1.csv'];
    expect(r.res.transactions).toHaveLength(exp.bookings);
    expect(r.res.balance).toMatchObject({ opening: cents(exp.opening_eur), closing: cents(exp.closing_eur), check: true });
    expect(r.res.valuations[0].value).toBe(cents(exp.closing_eur));
  });
  it('Konto, Titel, Zeitraum', () => {
    expect(r.res.account).toMatchObject({ kind: 'giro', institution: 'ING', iban: 'DE12500105170000000001' });
    expect(r.res.document.title).toBe('Umsätze ING Girokonto 01.01.–30.06.2026');
    expect(r.res.document).toMatchObject({ periodFrom: '2026-01-01', periodTo: '2026-06-30', date: '2026-06-30', needsReview: false });
  });
  it('Gehaltsbuchungen und Buchungstexte', () => {
    const exp = EXPECTED['Banken/ING/ing_girokonto_2026H1.csv'];
    const sal = r.res.transactions.filter(t => t.bookingText === 'Gehalt/Lohn');
    expect(sal).toHaveLength(exp.salary_bookings);
    expect(sal[0].amount).toBe(cents(exp.salary_eur_monthly));
    const rent = r.res.transactions.find(t => /Miete 03/.test(t.purpose));
    expect(rent).toMatchObject({ bookingText: 'Dauerauftrag', amount: -115000, counterparty: 'Hausverwaltung Elbblick' });
    expect(r.res.transactions.some(t => t.bookingText === 'Kartenzahlung')).toBe(true);
    expect(r.res.transactions.some(t => t.bookingText === 'Bargeld')).toBe(true);
  });
  it('chronologisch, dedupeKey eindeutig', () => {
    const d = r.res.transactions.map(t => t.bookingDate);
    expect([...d].sort()).toEqual(d);
    const keys = r.res.transactions.map(t => t.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toMatch(/^DE12500105170000000001\|2026-01-02\|-?\d+\|/);
  });
  it('acht PayPal-Lastschriften', () => {
    expect(r.res.transactions.filter(t => /PayPal/.test(t.counterparty))).toHaveLength(EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'].ing_paypal_debits);
  });
});

describe('ING CSV mit Kategorie-Spalte und Valuta-Kopf', () => {
  it('parst Variante', async () => {
    const csv = [
      'Umsatzanzeige;Datei erstellt am: 01.03.2026 10:00', '', 'IBAN;DE12 5001 0517 0000 0000 01', 'Kontoname;Extra-Konto', 'Bank;ING', 'Kunde;Max', 'Zeitraum;01.02.2026 - 28.02.2026', 'Sortierung;Datum absteigend', 'Saldo;1.100,00;EUR', '',
      'Buchung;Valuta;Auftraggeber/Empfänger;Buchungstext;Kategorie;Verwendungszweck;Saldo;Währung;Betrag;Währung',
      '10.02.2026;10.02.2026;Zinsen;Zinsen;Sonstiges;Zinsgutschrift;1.100,00;EUR;100,00;EUR',
      '02.02.2026;02.02.2026;Max;Gutschrift;Sonstiges;Einzahlung;1.000,00;EUR;1.000,00;EUR',
    ].join('\r\n');
    const ex = csvFromString(csv);
    const det = detectStatementFormat(ex, { name: 'x.csv' });
    expect(det.format).toBe('ing_csv');
    const res = await parseStatement(det, ex, {});
    expect(res.account).toMatchObject({ kind: 'tagesgeld', name: 'ING Extra-Konto' });
    expect(res.transactions.map(t => t.amount)).toEqual([100000, 10000]);
    expect(res.transactions[1].bookingText).toBe('Zinsen');
    expect(res.balance).toMatchObject({ opening: 0, closing: 110000, check: true });
  });
});

describe('comdirect Girokonto CSV', () => {
  let r;
  beforeAll(async () => { r = await run('Banken/comdirect/comdirect_girokonto_2026H1.csv'); });
  it('Erkennung + Zahlen', () => {
    const exp = EXPECTED['Banken/comdirect/comdirect_girokonto_2026H1.csv'];
    expect(r.det).toMatchObject({ format: 'comdirect_csv', institution: 'comdirect', type: 'kontoauszug' });
    expect(r.res.transactions).toHaveLength(exp.bookings);
    expect(r.res.balance).toMatchObject({ opening: cents(exp.opening_eur), closing: cents(exp.closing_eur), check: true });
    expect(r.res.account).toMatchObject({ kind: 'giro', institution: 'comdirect' });
  });
  it('Gegenpartei und Zweck aus freiem Text', () => {
    const t = r.res.transactions.find(x => /REWE/.test(x.counterparty));
    expect(t.counterparty).toBe('REWE Markt Hamburg-Eimsbüttel');
    expect(t.bookingText).toBe('Kartenzahlung');
    const amz = r.res.transactions.find(x => /RE-AMZ/.test(x.purpose));
    expect(amz.amount).toBe(-24900);
    expect(amz.counterparty).toMatch(/^Amazon Payments Europe/);
  });
});

describe('comdirect CSV: reale Texte, mehrere Abschnitte, offene Posten', () => {
  const csv = [
    '"Umsätze Girokonto";"Zeitraum: 01.03.2026 - 31.03.2026";', '"Alter Kontostand";"1.000,00 EUR";', '"Neuer Kontostand";"1.650,00 EUR";', '',
    '"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";',
    '"offen";"";"Kartenzahlung";"Kiosk VISA Debitkarte";"-3,00";',
    '"10.03.2026";"10.03.2026";"Lastschrift / Belastung";"Empfänger: Stadtwerke Hamburg AG Kto/IBAN: DE02120300000000202051 BLZ/BIC: BYLADEM1001 Buchungstext: Abschlag Strom 03/2026 Ref. ABC123XYZ/45";"-50,00";',
    '"05.03.2026";"05.03.2026";"Übertrag / Überweisung";"Auftraggeber: Frigotechnik GmbH Buchungstext: Gehalt 03/2026 Ref. 9988776655/1";"700,00";',
    '',
    '"Umsätze Visa-Karte";"Zeitraum: 01.03.2026 - 31.03.2026";', '"Neuer Kontostand";"-20,00 EUR";', '',
    '"Buchungstag";"Umsatztag";"Vorgang";"Referenz";"Buchungstext";"Umsatz in EUR";',
    '"12.03.2026";"11.03.2026";"Kartenzahlung";"REF1";"Buchhandlung Muster Hamburg";"-20,00";',
  ].join('\n');
  it('zwei Abschnitte, offen übersprungen', async () => {
    const ex = csvFromString(csv);
    const det = detectStatementFormat(ex, {});
    expect(det.format).toBe('comdirect_csv');
    const all = await parseStatementAll(det, ex, {});
    expect(all).toHaveLength(2);
    const [giro, visa] = all;
    expect(giro.transactions).toHaveLength(2);
    expect(giro.document.fields.pendingSkipped).toBe(1);
    expect(giro.balance).toMatchObject({ opening: 100000, closing: 165000, check: true });
    const strom = giro.transactions.find(t => t.amount === -5000);
    expect(strom).toMatchObject({ counterparty: 'Stadtwerke Hamburg AG', purpose: 'Abschlag Strom 03/2026', counterpartyIban: 'DE02120300000000202051', bookingText: 'Lastschrift' });
    expect(strom.endToEndId).toBe('ABC123XYZ/45');
    expect(giro.transactions.find(t => t.amount === 70000)).toMatchObject({ counterparty: 'Frigotechnik GmbH', bookingText: 'Gehalt/Lohn' });
    expect(visa.account.kind).toBe('kreditkarte');
    expect(visa.document.type).toBe('kreditkarte');
    expect(visa.transactions).toHaveLength(1);
    expect(visa.transactions[0]).toMatchObject({ bookingDate: '2026-03-12', valueDate: '2026-03-11', amount: -2000 });
    const one = await parseStatement(det, ex, {});
    expect(one.additional).toHaveLength(1);
  });
});

describe('comdirect Depot', () => {
  it('Bestand: Holdings + Gesamtwert', async () => {
    const { det, res } = await run('Banken/comdirect/comdirect_depot_2026-06-30.csv');
    const exp = EXPECTED['Banken/comdirect/comdirect_depot_2026-06-30.csv'];
    expect(det).toMatchObject({ type: 'depot', format: 'comdirect_depot_csv' });
    expect(res.holdings).toHaveLength(exp.positions);
    expect(res.holdings.reduce((a, h) => a + h.value, 0)).toBe(cents(exp.total_eur));
    expect(res.valuations).toEqual([{ date: '2026-06-30', value: cents(exp.total_eur), label: expect.stringContaining('Depot') }]);
    expect(res.holdings[0]).toMatchObject({ name: 'Muster MSCI World UCITS ETF', isin: 'DE00MUST0001', wkn: 'MUST01', qty: 42.518, price: 9875, value: 419865, date: '2026-06-30' });
    expect(res.account).toMatchObject({ kind: 'depot', number: '123456789' });
    expect(res.document.needsReview).toBe(false);
  });
  it('Umsätze-Variante', async () => {
    const csv = [
      '"Umsätze Depot ";"Zeitraum: 20 Tage";', '',
      '"Buchungstag";"Geschäftstag";"Stück / Nom.";"Bezeichnung";"WKN";"Währung";"Ausführungskurs";"Umsatz in EUR";',
      '"10.02.2020";"07.02.2020";"2.5";"UBS-ETF-MSCI WLD.S.R.DLAD";"A1JA1R";"EUR";"98,51";"249,96";',
    ].join('\n');
    const ex = csvFromString(csv);
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ type: 'depot', format: 'comdirect_depot_csv' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ bookingDate: '2020-02-10', valueDate: '2020-02-07', amount: -24996, bookingText: 'Wertpapierkauf' });
    expect(res.holdings).toHaveLength(0);
  });
});

describe('PayPal CSV', () => {
  let r;
  beforeAll(async () => { r = await run('Banken/PayPal/paypal_aktivitaeten_2026H1.csv'); });
  it('Anzahl, Salden, Konto', () => {
    const exp = EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'];
    expect(r.det).toMatchObject({ type: 'paypal', format: 'paypal_csv', institution: 'PayPal' });
    expect(r.res.transactions).toHaveLength(exp.rows);
    expect(r.res.account).toMatchObject({ kind: 'paypal', institution: 'PayPal' });
    expect(r.res.balance.closing).toBe(cents(exp.final_balance_eur));
    expect(r.res.balance.check).toBe(true);
  });
  it('Bankaufladungen als Bankeinzug/isTransfer', () => {
    const exp = EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'];
    const bank = r.res.transactions.filter(t => t.bookingText === 'Bankeinzug');
    expect(bank.length).toBeGreaterThan(0);
    expect(bank.every(t => t.counterparty === 'PayPal-Aufladung (Bankkonto)' && t.isTransfer && t.amount > 0)).toBe(true);
    expect(bank.reduce((a, t) => a + t.amount, 0)).toBe(cents(exp.bank_funded_in_eur));
  });
  it('Gebühr = 0 im Sample, Brutto/Netto', () => {
    expect(r.res.transactions.every(t => t.fee === null || t.fee === 0)).toBe(true);
    expect(r.res.transactions.find(t => /Anna Beispiel/.test(t.counterparty)).amount).toBe(-2500);
  });
  it('englisch: Gebühr, übersprungene Zeilen, Fremdwährung', async () => {
    const csv = [
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Balance","Subject"',
      '"03/05/2026","10:00:00","PST","Shop A","Express Checkout Payment","Completed","EUR","1,000.00","-35.10","964.90","buyer@x.com","me@x.com","T1","964.90","Order 1"',
      '"03/06/2026","10:00:00","PST","Shop B","Payment","Pending","EUR","-10.00","0.00","-10.00","me@x.com","b@x.com","T2","964.90",""',
      '"03/06/2026","10:01:00","PST","PayPal","General Authorization","Completed","EUR","-10.00","0.00","-10.00","me@x.com","","T3","964.90",""',
      '"03/07/2026","10:00:00","PST","","Bank Deposit to PP Account","Completed","EUR","100.00","0.00","100.00","","me@x.com","T4","1,064.90",""',
      '"03/08/2026","10:00:00","PST","Seller USD","Payment","Completed","USD","-20.00","0.00","-20.00","me@x.com","s@x.com","T5","",""',
      '"03/08/2026","10:00:00","PST","","General Currency Conversion","Completed","EUR","-18.40","0.00","-18.40","me@x.com","","T6","1,046.50","T5"',
      '"03/09/2026","10:00:00","PST","Me","General Withdrawal","Completed","EUR","-1,046.50","0.00","-1,046.50","me@x.com","","T7","0.00",""',
    ].join('\n');
    const ex = csvFromString(csv);
    const det = detectStatementFormat(ex, {});
    expect(det.format).toBe('paypal_csv');
    const res = await parseStatement(det, ex, {});
    expect(res.transactions.map(t => t.amount)).toEqual([96490, 10000, -1840, -104650]);
    expect(res.transactions[0]).toMatchObject({ fee: 3510, bookingDate: '2026-03-05' });
    expect(res.transactions[1]).toMatchObject({ bookingText: 'Bankeinzug', isTransfer: true });
    expect(res.transactions[3]).toMatchObject({ bookingText: 'Bankeinzug', isTransfer: true });
    expect(res.document.fields).toMatchObject({ skippedPending: 1, skippedMemo: 1, skippedForeign: 1 });
    expect(res.transactions[2].bookingText).toBe('Währungsumrechnung');
  });
});

describe('camt.053 / camt.052', () => {
  it('Sample ING 2026-05', async () => {
    const { det, res } = await run('Banken/ING/camt053_ing_2026-05.xml');
    const exp = EXPECTED['Banken/ING/camt053_ing_2026-05.xml'];
    expect(det).toMatchObject({ format: 'camt053', institution: 'ING', type: 'kontoauszug' });
    expect(res.transactions).toHaveLength(exp.bookings);
    expect(res.balance).toMatchObject({ opening: cents(exp.opening_eur), closing: cents(exp.closing_eur), check: true });
    expect(res.account.iban).toBe('DE12500105170000000001');
    expect(res.document.title).toBe('Kontoauszug ING Girokonto 05/2026');
    const sal = res.transactions.find(t => t.amount === 329098);
    expect(sal).toMatchObject({ counterparty: 'Frigotechnik GmbH', counterpartyIban: 'DE00125459756922270330', bookingText: 'Gehalt/Lohn' });
    const alz = res.transactions[0];
    expect(alz).toMatchObject({ amount: -15000, counterparty: 'Allianz Lebensversicherungs-AG', mandateId: 'ALZ-4711-0815', endToEndId: 'E2E-privatrente-05', creditorId: 'DE98ZZZ09999999999', bookingText: 'Lastschrift' });
    const pp = res.transactions.find(t => /PayPal/.test(t.counterparty));
    expect(pp.creditorId).toBe('LU96ZZZ0000000000000000058');
    expect(res.transactions.find(t => t.amount === -10000)).toMatchObject({ bookingText: 'Bargeld' });
    expect(res.transactions.find(t => t.amount === -4738)).toMatchObject({ bookingText: 'Kartenzahlung' });
  });

  const camt02 = (entries, bals = true) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>1</MsgId></GrpHdr>
<Stmt><Id>S1</Id><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy><Svcr><FinInstnId><BIC>COBADEFFXXX</BIC></FinInstnId></Svcr></Acct>
${bals ? `<Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">25.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>` : ''}
${entries}</Stmt></BkToCstmrStmt></Document>`;
  it('.02-Namespace, ein einzelner Eintrag, negativer Schlusssaldo, Mehrfach-Ustrd, DtTm', async () => {
    const xml = camt02(`<Ntry><Amt Ccy="EUR">125.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>2026-01-15T10:00:00</DtTm></BookgDt><ValDt><Dt>2026-01-16</Dt></ValDt>
      <BkTxCd><Prtry><Cd>NMSC+105+9310</Cd></Prtry></BkTxCd>
      <NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>Shop GmbH</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Rechnung 1</Ustrd><Ustrd>Kunde 7</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`);
    const ex = { kind: 'xml', rawText: xml, xml, text: xml };
    const det = detectStatementFormat(ex, { name: 'a.xml' });
    expect(det).toMatchObject({ format: 'camt053', institution: 'Commerzbank' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ bookingDate: '2026-01-15', valueDate: '2026-01-16', amount: -12500, purpose: 'Rechnung 1 Kunde 7', counterparty: 'Shop GmbH', endToEndId: null, gvc: '105' });
    expect(res.balance).toMatchObject({ opening: 10000, closing: -2500, check: true });
  });
  it('camt.052 mit CRDT: Gegenpartei ist Dbtr; pending wird übersprungen; Pty/Nm', async () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"><BkToCstmrAcctRpt><Rpt><Id>R</Id><Acct><Id><Othr><Id>12345</Id></Othr></Id></Acct>
      <Ntry><Amt Ccy="EUR">10.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-02-01</Dt></BookgDt><NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>Max Payer</Nm></Pty></Dbtr><Cdtr><Pty><Nm>Ich</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>EREF+E1 SVWZ+Rueckzahlung</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
      <Ntry><Amt Ccy="EUR">99.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts><BookgDt><Dt>2026-02-02</Dt></BookgDt></Ntry>
      </Rpt></BkToCstmrAcctRpt></Document>`;
    const ex = { kind: 'xml', rawText: xml, text: xml };
    const det = detectStatementFormat(ex, {});
    expect(det.format).toBe('camt052');
    const res = await parseStatement(det, ex, {});
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ amount: 1050, counterparty: 'Max Payer', purpose: 'Rueckzahlung', endToEndId: 'E1' });
    expect(res.account.number).toBe('12345');
  });
  it('mehrere Entries in einem Stmt als Array, mehrere Stmt → additional', async () => {
    const one = n => `<Stmt><Id>${n}</Id><Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct><Ntry><Amt Ccy="EUR">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-03-0${n}</Dt></BookgDt></Ntry><Ntry><Amt Ccy="EUR">2.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-03-0${n}</Dt></BookgDt></Ntry></Stmt>`;
    const xml = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>${one(1)}${one(2)}</BkToCstmrStmt></Document>`;
    const ex = { kind: 'xml', rawText: xml, text: xml };
    const res = await parseStatement(null, ex, {});
    expect(res.transactions).toHaveLength(2);
    expect(res.additional).toHaveLength(1);
  });
});

describe('MT940', () => {
  const mt = [
    '{1:F01TESTDEFFAXXX0000000000}{2:O9400000000000TESTDEFFAXXX00000000000000000000N}{4:',
    ':20:STARTUMS', ':25:50010517/0000000001', ':28C:00001/001', ':60F:C260501EUR1000,00',
    ':61:2605020502D12,50NMSCNONREF', ':86:105?00SEPA-LASTSCHRIFT?10931?20EREF+E2E-1 MREF+M-77 CRED+DE98ZZZ0999', '?219999999 SVWZ+Spotify Premium?3050010517?31DE12500105170000000001?32Spotify AB', '?33',
    ':61:2605050505C3000,00NTRFNONREF', ':86:051?00GUTSCHRIFT?20SVWZ+Gehalt 05/2026?32Frigotechnik GmbH',
    ':61:260531D20,00NCHGNONREF', ':86:808?00ENTGELT?20Kontofuehrung 05/2026',
    ':62F:C260531EUR3967,50', '-}',
  ].join('\r\n');
  it('erkennt und parst :61:/:86:', async () => {
    const ex = { kind: 'text', rawText: mt, text: mt };
    const det = detectStatementFormat(ex, { name: 'umsatz.sta' });
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'mt940', institution: 'ING' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions).toHaveLength(3);
    expect(res.balance).toMatchObject({ opening: 100000, closing: 396750, check: true, openingDate: '2026-05-01', closingDate: '2026-05-31' });
    const [a, b, c] = res.transactions;
    expect(a).toMatchObject({ bookingDate: '2026-05-02', valueDate: '2026-05-02', amount: -1250, counterparty: 'Spotify AB', purpose: 'Spotify Premium', bookingText: 'Lastschrift', gvc: '105', endToEndId: 'E2E-1', mandateId: 'M-77', creditorId: 'DE98ZZZ09999999999', counterpartyIban: 'DE12500105170000000001' });
    expect(b).toMatchObject({ amount: 300000, counterparty: 'Frigotechnik GmbH', purpose: 'Gehalt 05/2026', bookingText: 'Gehalt/Lohn' });
    expect(c).toMatchObject({ amount: -2000, bookingText: 'Gebühr', bookingDate: '2026-05-31' });
    expect(res.account).toMatchObject({ institution: 'ING', number: '50010517/0000000001' });
  });
  it('Jahreswechsel zwischen Wert- und Buchungsdatum', async () => {
    const t = [':20:X', ':25:DE89370400440532013000', ':60F:C251230EUR0,00', ':61:2512300102C1,00NTRFNONREF', ':86:051?00GUTSCHRIFT?20Test', ':62F:C260102EUR1,00'].join('\n');
    const res = await parseStatement(null, { kind: 'text', rawText: t, text: t }, {});
    expect(res.transactions[0]).toMatchObject({ valueDate: '2025-12-30', bookingDate: '2026-01-02' });
    expect(res.balance.check).toBe(true);
  });
});

describe('PDF-Kontoauszüge', () => {
  it('ING-PDF (Sample)', async () => {
    const { det, res } = await run('Banken/ING/ing_kontoauszug_2026-03.pdf');
    const exp = EXPECTED['Banken/ING/ing_kontoauszug_2026-03.pdf'];
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'ING' });
    expect(res.transactions).toHaveLength(exp.bookings);
    expect(res.balance).toMatchObject({ opening: cents(exp.opening_eur), closing: cents(exp.closing_eur), check: true });
    expect(res.document.needsReview).toBe(false);
    expect(res.document.title).toBe('Kontoauszug ING Girokonto 03/2026');
    expect(res.account.iban).toBe('DE12500105170000000001');
    const miete = res.transactions.find(t => /Miete/.test(t.purpose));
    expect(miete).toMatchObject({ bookingText: 'Dauerauftrag', counterparty: 'Hausverwaltung Elbblick', amount: -115000, bookingDate: '2026-03-03' });
    const sal = res.transactions.find(t => t.amount === 329098);
    expect(sal).toMatchObject({ counterparty: 'Frigotechnik GmbH', bookingText: 'Gehalt/Lohn' });
    // Seitenumbruch: Buchungen von Seite 2 vollständig
    expect(res.transactions.find(t => t.amount === -38900).purpose).toContain('OPT-2026-0327');
    // Dedupe-Schlüssel stimmt mit dem CSV-Export überein (gleiches Konto, Datum, Betrag)
  });
  it('Renault-PDF (Sample): Tagesgeld, Zinsen', async () => {
    const { det, res } = await run('Banken/Renault/renaultbank_tagesgeld_2026-06.pdf');
    const exp = EXPECTED['Banken/Renault/renaultbank_tagesgeld_2026-06.pdf'];
    expect(det).toMatchObject({ format: 'pdf_statement', institution: 'Renault Bank' });
    expect(res.account).toMatchObject({ kind: 'tagesgeld', institution: 'Renault Bank', iban: 'DE00123400000000000003' });
    expect(res.transactions).toHaveLength(exp.entries);
    expect(res.balance).toMatchObject({ opening: cents(exp.opening_eur), closing: cents(exp.closing_eur), check: true });
    expect(res.transactions[0]).toMatchObject({ amount: cents(exp.credit_from_ing_eur), counterparty: 'ING Girokonto', counterpartyIban: 'DE12500105170000000001', bookingText: 'Gutschrift' });
    expect(res.transactions[1]).toMatchObject({ amount: 873, bookingText: 'Zinsen', counterparty: 'Renault Bank' });
    expect(res.valuations[0]).toMatchObject({ date: '2026-06-30', value: cents(exp.closing_eur) });
  });
  it('CSV und PDF desselben Kontos teilen dedupeKeys für gleiche Buchungen', async () => {
    const pdf = (await run('Banken/ING/ing_kontoauszug_2026-03.pdf')).res;
    const csv = (await run('Banken/ING/ing_girokonto_2026H1.csv')).res;
    const keyOf = t => `${t.bookingDate}|${t.amount}`;
    const csvKeys = new Set(csv.transactions.map(keyOf));
    expect(pdf.transactions.every(t => csvKeys.has(keyOf(t)))).toBe(true);
    const a = new Set(csv.transactions.map(t => t.dedupeKey));
    const overlap = pdf.transactions.filter(t => a.has(t.dedupeKey)).length;
    expect(overlap).toBeGreaterThanOrEqual(pdf.transactions.length - 3);
  });
  it('Nicht-Kontoauszug-PDFs werden nicht erkannt', async () => {
    for (const f of ['Belege/lohnabrechnung_2026-03.pdf', 'Belege/rechnung_amazon_monitor_2026-04.pdf', 'Steuer/lohnsteuerbescheinigung_2025.pdf', 'Versicherungen/allianz_privatrente_standmitteilung_2025.pdf']) {
      const { det } = await run(f);
      expect(det, f).toBeNull();
    }
  });

  // synthetische PDF-Zeilen mit x-Positionen (Soll/Haben-Spalten)
  const mkLine = (y, parts) => {
    const items = parts.map(([x, str, w]) => ({ x, w: w ?? str.length * 5, str }));
    return { y, text: parts.map(p => p[1]).join('   '), items };
  };
  it('Soll/Haben-Spalten, kurze Datumsangaben, Saldo nach "Kontostand am"', async () => {
    const lines = [
      mkLine(800, [[50, 'Sparkasse Musterstadt – Kontoauszug']]),
      mkLine(780, [[50, 'IBAN: DE89 3704 0044 0532 0130 00']]),
      mkLine(760, [[50, 'Kontoauszug vom 01.04.2026 bis 30.04.2026']]),
      mkLine(740, [[50, 'Kontostand am 01.04.2026'], [400, '1.000,00']]),
      mkLine(700, [[50, 'Datum'], [100, 'Erläuterung'], [380, 'Soll', 20], [450, 'Haben', 25]]),
      mkLine(680, [[50, '03.04.'], [100, 'Lastschrift Stadtwerke'], [380, '45,00', 25]]),
      mkLine(670, [[100, 'Strom April']]),
      mkLine(650, [[50, '15.04.'], [100, 'Gutschrift Erika Muster'], [450, '1.234,56', 40]]),
      mkLine(640, [[100, 'Danke fuer alles']]),
      mkLine(620, [[50, '30.04.'], [100, 'Kontoführung'], [380, '5,90+', 30]]),
      mkLine(600, [[50, 'Kontostand am 30.04.2026'], [400, '2.183,66']]),
    ];
    // Schlusszeile oben ist absichtlich ohne Fehler: 1000 - 45 + 1234,56 + 5,90 = 2195,46 → soll Review auslösen
    const ex = { kind: 'pdf', pages: [{ n: 1, text: lines.map(l => l.text).join('\n'), lines }], text: lines.map(l => l.text).join('\n') };
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'Sparkasse' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions.map(t => t.amount)).toEqual([-4500, 123456, 590]);
    expect(res.transactions[0]).toMatchObject({ bookingDate: '2026-04-03', purpose: 'Strom April' });
    expect(res.balance).toMatchObject({ opening: 100000, closing: 218366, check: false });
    expect(res.document.needsReview).toBe(true);
    expect(res.document.reviewReason).toBe('Saldo stimmt nicht');
  });
  it('Saldo-Format "1.150,00-" und S/H, Jahreswechsel', async () => {
    const lines = [
      mkLine(800, [[50, 'Deutsche Bank Kontoauszug']]),
      mkLine(780, [[50, 'Zeitraum 15.12.2025 - 14.01.2026']]),
      mkLine(760, [[50, 'Alter Saldo'], [400, '100,00 H']]),
      mkLine(720, [[50, '20.12.'], [90, '20.12.'], [130, 'Überweisung Miete'], [400, '1.150,00-']]),
      mkLine(700, [[50, '05.01.'], [90, '05.01.'], [130, 'Gehalt'], [400, '2.000,00 H']]),
      mkLine(680, [[50, 'Neuer Saldo'], [400, '950,00 H']]),
    ];
    const ex = { kind: 'pdf', pages: [{ n: 1, text: '', lines }], text: lines.map(l => l.text).join('\n') };
    const res = await parseStatement(null, ex, {});
    expect(res.transactions.map(t => [t.bookingDate, t.amount])).toEqual([['2025-12-20', -115000], ['2026-01-05', 200000]]);
    expect(res.balance).toMatchObject({ opening: 10000, closing: 95000, check: true });
    expect(res.document.needsReview).toBe(false);
  });
  it('Kreditkartenabrechnung wird als kreditkarte erkannt', async () => {
    const lines = [
      mkLine(800, [[50, 'DKB Visa Kreditkartenabrechnung']]),
      mkLine(780, [[50, 'Alter Saldo'], [400, '0,00']]),
      mkLine(740, [[50, '02.05.2026'], [100, '03.05.2026'], [150, 'Restaurant Muster'], [400, '-40,00']]),
      mkLine(720, [[50, '04.05.2026'], [100, '04.05.2026'], [150, 'Buchhandlung'], [400, '-10,00']]),
      mkLine(700, [[50, 'Neuer Saldo'], [400, '-50,00']]),
    ];
    const ex = { kind: 'pdf', pages: [{ n: 1, text: '', lines }], text: lines.map(l => l.text).join('\n') };
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ type: 'kreditkarte', institution: 'DKB' });
    const res = await parseStatement(det, ex, {});
    expect(res.account.kind).toBe('kreditkarte');
    expect(res.balance.check).toBe(true);
  });
});

describe('Generic CSV', () => {
  const sparkasse = [
    'Auftragskonto;Buchungstag;Valutadatum;Buchungstext;Verwendungszweck;Glaeubiger ID;Mandatsreferenz;Kundenreferenz (End-to-End);Sammlerreferenz;Lastschrift Ursprungsbetrag;Auslagenersatz Ruecklastschrift;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;BIC (SWIFT-Code);Betrag;Waehrung;Info',
    'DE89370400440532013000;02.03.26;02.03.26;FOLGELASTSCHRIFT;"EREF+E1 MREF+M9 SVWZ+Strom Maerz";DE98ZZZ09999999999;M9;E1;;;;Stadtwerke Musterstadt;DE02120300000000202051;BYLADEM1001;-85,00;EUR;Umsatz gebucht',
    'DE89370400440532013000;03.03.26;03.03.26;GUTSCHRIFT;Gehalt 03/2026;;;;;;;Frigotechnik GmbH;DE02100500000054540402;BELADEBEXXX;2.500,00;EUR;Umsatz gebucht',
  ].join('\n');
  const dkb = [
    '"Konto";"Girokonto DE02120300000000202051";', '"Von";"01.03.2026";', '"Bis";"31.03.2026";', '"Kontostand vom 31.03.2026:";"1.234,56 €";', '',
    '"Buchungsdatum";"Wertstellung";"Status";"Zahlungspflichtige*r";"Zahlungsempfänger*in";"Verwendungszweck";"Umsatztyp";"IBAN";"Betrag (€)";"Gläubiger-ID";"Mandatsreferenz";"Kundenreferenz"',
    '"05.03.26";"05.03.26";"Gebucht";"Max Mustermann";"Vattenfall Europe Sales GmbH";"Abschlag";"Ausgang";"DE12500105170000000001";"-84,50";"DE98ZZZ09999999999";"MND1";"KR1"',
    '"06.03.26";"06.03.26";"Vorgemerkt";"Max Mustermann";"Kiosk";"Zeitung";"Ausgang";"";"-2,00";"";"";""',
    '"07.03.26";"07.03.26";"Gebucht";"Frigotechnik GmbH";"Max Mustermann";"Gehalt 03/2026";"Eingang";"DE12500105170000000001";"3.290,98";"";"";""',
  ].join('\n');
  const n26 = [
    '"Booking Date","Value Date","Partner Name","Partner Iban",Type,"Payment Reference","Account Name","Amount (EUR)","Original Amount","Original Currency","Exchange Rate"',
    '2026-03-05,2026-03-05,REWE,,Presentment,,Main,-12.30,,,',
    '2026-03-06,2026-03-06,Max Friend,DE02120300000000202051,Outgoing Transfer,Pizza,Main,-20.00,,,',
  ].join('\n');

  it('guessCsvMapping: Sparkasse CSV-CAMT V2', () => {
    const rows = csvFromString(sparkasse).rows;
    const m = guessCsvMapping(rows);
    expect(m.headerRow).toBe(0);
    expect(m.profile).toMatchObject({ institution: 'Sparkasse' });
    const h = rows[0];
    const name = k => h[m.columns[k]];
    expect(name('date')).toBe('Buchungstag');
    expect(name('valueDate')).toBe('Valutadatum');
    expect(name('amount')).toBe('Betrag');
    expect(name('counterparty')).toBe('Beguenstigter/Zahlungspflichtiger');
    expect(name('purpose')).toBe('Verwendungszweck');
    expect(name('iban')).toBe('Kontonummer/IBAN');
    expect(name('bookingText')).toBe('Buchungstext');
    expect(name('currency')).toBe('Waehrung');
    expect(name('accountIban')).toBe('Auftragskonto');
  });
  it('guessCsvMapping: DKB mit Preamble', () => {
    const rows = csvFromString(dkb).rows;
    const m = guessCsvMapping(rows);
    expect(m.headerRow).toBe(5);
    expect(m.profile.institution).toBe('DKB');
    const h = rows[m.headerRow];
    expect(h[m.columns.date]).toBe('Buchungsdatum');
    expect(h[m.columns.amount]).toBe('Betrag (€)');
    expect(h[m.columns.payer]).toBe('Zahlungspflichtige*r');
    expect(h[m.columns.payee]).toBe('Zahlungsempfänger*in');
    expect(h[m.columns.iban]).toBe('IBAN');
    expect(h[m.columns.bookingText]).toBe('Umsatztyp');
  });
  it('guessCsvMapping ohne Treffer', () => {
    expect(guessCsvMapping([['a', 'b', 'c'], ['1', '2', '3']]).headerRow).toBe(-1);
    expect(guessCsvMapping([]).headerRow).toBe(-1);
  });
  it('Sparkasse: Parsing', async () => {
    const ex = csvFromString(sparkasse);
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'generic_csv', institution: 'Sparkasse' });
    expect(det.confidence).toBeGreaterThan(0.75);
    const res = await parseStatement(det, ex, {});
    expect(res.account).toMatchObject({ iban: 'DE89370400440532013000', institution: 'Sparkasse', kind: 'giro' });
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions[0]).toMatchObject({
      bookingDate: '2026-03-02', amount: -8500, counterparty: 'Stadtwerke Musterstadt', counterpartyIban: 'DE02120300000000202051',
      purpose: 'Strom Maerz', bookingText: 'Lastschrift', mandateId: 'M9', endToEndId: 'E1', creditorId: 'DE98ZZZ09999999999',
    });
    expect(res.transactions[1]).toMatchObject({ amount: 250000, bookingText: 'Gehalt/Lohn' });
  });
  it('DKB: Gegenpartei je Richtung, Vorgemerkt übersprungen, Kontostand', async () => {
    const ex = csvFromString(dkb);
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ format: 'generic_csv', institution: 'DKB' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions[0]).toMatchObject({ counterparty: 'Vattenfall Europe Sales GmbH', amount: -8450, mandateId: 'MND1', endToEndId: 'KR1' });
    expect(res.transactions[1]).toMatchObject({ counterparty: 'Frigotechnik GmbH', amount: 329098, bookingText: 'Gehalt/Lohn' });
    expect(res.account.iban).toBe('DE02120300000000202051');
    expect(res.balance.closing).toBe(123456);
    expect(res.document.fields.pendingSkipped).toBe(1);
  });
  it('N26 (englisch, Dezimalpunkt)', async () => {
    const ex = csvFromString(n26);
    const det = detectStatementFormat(ex, {});
    expect(det).toMatchObject({ format: 'generic_csv', institution: 'N26' });
    const res = await parseStatement(det, ex, {});
    expect(res.transactions.map(t => [t.amount, t.bookingText, t.counterparty])).toEqual([[-1230, 'Kartenzahlung', 'REWE'], [-2000, 'Überweisung', 'Max Friend']]);
    expect(res.transactions[1].purpose).toBe('Pizza');
  });
  it('Soll/Haben-Spalten + Saldo-Spalte, unbekannte Bank', async () => {
    const csv = ['Datum;Text;Soll;Haben;Saldo', '01.04.2026;Einkauf;20,00;;80,00', '02.04.2026;Zahlung Eingang;;50,00;130,00'].join('\n');
    const ex = csvFromString(csv);
    const det = detectStatementFormat(ex, {});
    expect(det.format).toBe('generic_csv');
    expect(det.confidence).toBeLessThan(0.7);
    const res = await parseStatement(det, ex, {});
    expect(res.transactions.map(t => t.amount)).toEqual([-2000, 5000]);
    expect(res.balance).toMatchObject({ opening: 10000, closing: 13000, check: true });
  });
  it('parseCsvWithMapping mit manuellem Mapping und accountInfo', () => {
    const rows = [['Wann', 'Wieviel', 'Wer', 'Was'], ['2026-01-05', '-9,99', 'Netflix', 'Abo'], ['kaputt', 'x', '', '']];
    const mapping = { headerRow: 0, columns: { date: 0, amount: 1, counterparty: 2, purpose: 3 } };
    const res = parseCsvWithMapping(rows, mapping, { institution: 'MeineBank', name: 'Taschengeld', kind: 'giro', iban: 'DE89 3704 0044 0532 0130 00' });
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ bookingDate: '2026-01-05', amount: -999, counterparty: 'Netflix', purpose: 'Abo' });
    expect(res.account).toMatchObject({ institution: 'MeineBank', iban: 'DE89370400440532013000' });
    expect(res.document.reviewReason).toMatch(/1 Zeile/);
  });
});

describe('Hilfsfunktionen', () => {
  it('SEPA-Tokens', () => {
    const t = parseSepaTokens('EREF+ABC123 MREF+MAND-1 CRED+DE98ZZZ09999999999 SVWZ+Rechnung 4711 vom 01.03. ABWA+Max Muster');
    expect(t).toMatchObject({ found: true, eref: 'ABC123', mref: 'MAND-1', cred: 'DE98ZZZ09999999999', svwz: 'Rechnung 4711 vom 01.03.', abwa: 'Max Muster' });
    expect(parseSepaTokens('nur Text').found).toBe(false);
  });
  it('Buchungstext-Normalisierung', () => {
    const n = normalizeBookingText;
    expect(n('FOLGELASTSCHRIFT')).toBe('Lastschrift');
    expect(n('Auszahlung Geldautomat')).toBe('Bargeld');
    expect(n('Zinsgutschrift')).toBe('Zinsen');
    expect(n('Entgeltabschluss')).toBe('Gebühr');
    expect(n('SEPA-Überweisung')).toBe('Überweisung');
    expect(n('Eingang')).toBe('Gutschrift');
    expect(n('Kartenzahlung')).toBe('Kartenzahlung');
    expect(n('Wertpapierkauf ETF')).toBeNull();
  });
  it('identische Buchungen am selben Tag bekommen unterschiedliche dedupeKeys', async () => {
    const csv = ['Datum;Text;Betrag', '01.04.2026;Kaffee;-3,00', '01.04.2026;Kaffee;-3,00'].join('\n');
    const res = await parseStatement(null, csvFromString(csv), {});
    expect(res.transactions[0].dedupeKey).not.toBe(res.transactions[1].dedupeKey);
    expect(res.transactions[1].dedupeKey.endsWith('#2')).toBe(true);
  });
  it('unbekannte Dateien → null', () => {
    expect(detectStatementFormat({ kind: 'text', rawText: 'Hallo Welt', text: 'Hallo Welt' }, {})).toBeNull();
    expect(detectStatementFormat(csvFromString('a;b\n1;2'), {})).toBeNull();
    expect(detectStatementFormat(null, {})).toBeNull();
  });
});
