// Datenkorrektheit Ende-zu-Ende: reale Exportformate (Fixtures in tests/fixtures), Quellen-Mix ohne Doppelzählung,
// Nettovermögen, Serien, Sankey-Bilanz. Der Mini-Importer spiegelt store/importer.js (Konto-Zuordnung + Dedupe nach Konto/Datum/Betrag).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeText, parseCsv } from '../src/lib/extract/decode.js';
import { extractPdfText } from '../src/lib/extract/pdf.js';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { detectStatementFormat, parseStatement, parseStatementAll } from '../src/lib/parsers/statements/index.js';
import { displayName } from '../src/lib/parsers/naming.js';
import { normalizeCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions } from '../src/lib/classify/rules.js';
import { detectTransfers } from '../src/lib/analyze/transfers.js';
import { detectRecurring, linkContracts } from '../src/lib/analyze/recurring.js';
import { computeInsights } from '../src/lib/analyze/insights.js';
import { computeNetWorth } from '../src/lib/analyze/networth.js';
import { layoutSankey } from '../src/lib/charts/sankeyLayout.js';
import { normalizeIban } from '../src/lib/util/format.js';

const HERE = import.meta.dirname;
const FIX = path.join(HERE, 'fixtures');
const SAMPLES = path.resolve(HERE, '../samples/out');

// ---------------------------------------------------------------- Helfer
function csvExtracted(buf) {
  const { text } = decodeText(buf);
  const p = parseCsv(text);
  return { kind: 'csv', text, rawText: text, rows: p.rows, meta: { delimiter: p.delimiter } };
}
const csvFromString = s => csvExtracted(Buffer.from(s, 'utf8'));

async function loadFile(file) {
  const buf = fs.readFileSync(file);
  const meta = { name: path.basename(file), path: file, ext: path.extname(file).slice(1).toLowerCase() };
  if (meta.ext === 'pdf') { const r = await extractPdfText(new Uint8Array(buf)); return { ex: { kind: 'pdf', pages: r.pages, text: r.text, meta: { pageCount: r.pages.length } }, meta }; }
  if (meta.ext === 'xml') { const { text } = decodeText(buf); return { ex: { kind: 'xml', rawText: text, xml: text, text }, meta }; }
  return { ex: csvExtracted(buf), meta };
}
async function parseFile(file) {
  const { ex, meta } = await loadFile(file);
  const det = detectType(ex, meta);
  return { det, res: await parse(det, ex, meta), ex, meta };
}

/** Importer-Spiegel: Konto per IBAN/Nummer/Art zusammenführen, Dubletten über Formate (Konto|Datum|Betrag mit Vielfachheit) */
async function importFiles(files) {
  const D = { accounts: [], documents: [], txs: [], valuations: [], holdings: [] };
  const keys = new Set();
  let n = 0;
  const id = p => p + ++n;
  for (const f of files) {
    const { ex, meta } = await loadFile(f);
    const det = detectType(ex, meta);
    if (det.type === 'irrelevant') continue;
    const res = await parse(det, ex, meta);
    for (const r of [res, ...(res.additional || [])]) {
      let accId = null;
      if (r.account) {
        const a = r.account, iban = normalizeIban(a.iban);
        let found = iban ? D.accounts.find(x => normalizeIban(x.iban) === iban) : null;
        if (!found && a.number) found = D.accounts.find(x => x.number && x.number === a.number && x.institution === a.institution);
        if (!found && !iban) found = D.accounts.find(x => x.kind === a.kind && x.institution === a.institution && (x.name || '') === (a.name || '') && !x.iban);
        if (!found) D.accounts.push(found = { id: id('acc_'), own: true, ...a, iban });
        accId = found.id;
      }
      const docId = id('doc_');
      D.documents.push({ ...r.document, id: docId, accountId: accId, payroll: r.payroll || null, vat: r.vat || null, text: (ex.text || '').slice(0, 20000) });
      const seen = new Map();
      if (accId) for (const t of D.txs.filter(t => t.accountId === accId)) seen.set(t.bookingDate + '|' + t.amount, (seen.get(t.bookingDate + '|' + t.amount) || 0) + 1);
      for (const t of r.transactions || []) {
        if (t.dedupeKey && keys.has(t.dedupeKey)) continue;
        const dk = t.bookingDate + '|' + t.amount;
        if ((seen.get(dk) || 0) > 0) { seen.set(dk, seen.get(dk) - 1); continue; }
        if (t.dedupeKey) keys.add(t.dedupeKey);
        D.txs.push({ ...t, id: id('tx_'), accountId: accId, documentId: docId });
      }
      for (const v of r.valuations || []) if (accId) D.valuations.push({ ...v, id: id('v_'), accountId: accId, documentId: docId });
      for (const h of r.holdings || []) D.holdings.push({ ...h, id: id('h_'), accountId: accId, documentId: docId, date: h.date || r.document.date });
    }
  }
  return D;
}
/** postProcess() ohne Datenbank */
function analyze(D, range = {}) {
  let txs = D.txs.map(t => ({ ...t, counterparty: normalizeCounterparty(t) || t.counterparty }));
  txs = detectTransfers(txs, D.accounts);
  txs = classifyTransactions(txs, { rules: [], accounts: D.accounts });
  const contracts = detectRecurring(txs, []);
  txs = linkContracts(txs, contracts);
  const data = { accounts: D.accounts, transactions: txs, documents: D.documents, contracts, holdings: D.holdings, valuations: D.valuations, assets: [] };
  return { data, ins: computeInsights(data, range), txs, contracts };
}

// ---------------------------------------------------------------- Reale Exporte
describe('ING CSV (real: Valuta, Kategorie, absteigend, Sonderzeichen)', () => {
  it('parst Kopfzeile mit Kategorie-Spalte, Salden stimmen, Beträge mit Vorzeichen/Plus', async () => {
    const { det, res } = await parseFile(path.join(FIX, 'ing_real_valuta_kategorie.csv'));
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'ing_csv' });
    expect(res.transactions).toHaveLength(10);
    expect(res.account.iban).toBe('DE12500105175407324931');
    expect(res.balance).toMatchObject({ closing: 451230, check: true });
    expect(res.document.needsReview).toBe(false);
    const by = re => res.transactions.find(t => re.test(t.purpose));
    expect(by(/Steuerrückerstattung/).amount).toBe(42000);
    expect(by(/RETOURE/).amount).toBe(1999);
    expect(by(/Miete/)).toMatchObject({ amount: -115000, bookingText: 'Dauerauftrag' });
    // zwei gleiche PayPal-Lastschriften am selben Tag bleiben getrennt
    const pp = res.transactions.filter(t => t.amount === -5995);
    expect(pp).toHaveLength(2);
    expect(new Set(pp.map(t => t.dedupeKey)).size).toBe(2);
    // chronologisch
    const dates = res.transactions.map(t => t.bookingDate);
    expect([...dates].sort()).toEqual(dates);
  });
  it('Auswertung: Gehalt, Erstattung, Retoure mindert Ausgaben, Sparüberweisung zählt als Sparen', async () => {
    const D = await importFiles([path.join(FIX, 'ing_real_valuta_kategorie.csv')]);
    const { ins } = analyze(D, {});
    expect(ins.incomeBySource.find(s => s.id === 'gehalt').amount).toBe(329098);
    expect(ins.totals.saving).toBe(30000);
    expect(ins.totals.income).toBe(329098 + 42000);
    expect(ins.byCategory.find(c => c.id === 'shopping').amount).toBe(5995 * 2 - 1999);
  });
});

describe('comdirect Giro + Visa in einer Datei (real: Auftraggeber/Empfänger-Text, offen, Visa-Ausgleich)', () => {
  const file = path.join(FIX, 'comdirect_giro_visa_real.csv');
  it('zwei Abschnitte, offene Posten übersprungen, Salden stimmen', async () => {
    const { ex, meta } = await loadFile(file);
    const det = detectStatementFormat(ex, meta);
    const [giro, visa] = await parseStatementAll(det, ex, meta);
    expect(giro.transactions).toHaveLength(7);
    expect(giro.document.fields.pendingSkipped).toBe(1);
    expect(giro.balance).toMatchObject({ opening: 200000, closing: 406969, check: true });
    expect(visa.account.kind).toBe('kreditkarte');
    expect(visa.balance).toMatchObject({ opening: -15540, closing: -4700, check: true });
    const pp = giro.transactions.find(t => /Spotify/.test(t.purpose));
    expect(pp).toMatchObject({ counterparty: 'PayPal Europe S.a.r.l. et Cie S.C.A.', mandateId: '5KR123', creditorId: 'LU96ZZZ0000000000000000058' });
    const rent = giro.transactions.find(t => /Miete/.test(t.purpose));
    expect(rent).toMatchObject({ counterparty: 'Hausverwaltung Elbblick', counterpartyIban: 'DE02120300000000202051', bookingText: 'Dauerauftrag' });
  });
  it('Visa-Abrechnung auf dem Giro ist Umbuchung, nicht Ausgabe; Karte zählt als Verbindlichkeit', async () => {
    const D = await importFiles([file]);
    const { ins, txs } = analyze(D, {});
    const settle = txs.filter(t => Math.abs(t.amount) === 15540);
    expect(settle).toHaveLength(2);
    expect(settle.every(t => t.isTransfer && t.category === 'umbuchung')).toBe(true);
    // Ausgaben: Visa-Käufe (30 + 17) zählen, die Abrechnung nicht
    expect(ins.byCategory.find(c => c.id === 'freizeit_reisen').amount).toBe(1700);
    expect(ins.byCategory.find(c => c.id === 'shopping').amount).toBe(3000);
    const visa = ins.netWorth.byAccount.find(a => a.kind === 'kreditkarte');
    expect(visa.value).toBe(-4700);
    expect(ins.netWorth.byAccount.find(a => a.name === 'comdirect Girokonto').value).toBe(406969);
  });
});

describe('PayPal englisch (DD/MM, Fremdwährung mit Umrechnung)', () => {
  it('Fremdwährungszahlung zählt einmal in EUR, Händlername aus der Referenz, Aufladungen sind Umbuchungen', async () => {
    const { res } = await parseFile(path.join(FIX, 'paypal_en_conversion.csv'));
    expect(res.transactions.map(t => [t.bookingDate, t.amount])).toEqual([['2026-01-14', 8990], ['2026-01-14', -8990], ['2026-02-03', 1840], ['2026-02-03', -1840]]);
    expect(res.transactions[3]).toMatchObject({ counterparty: 'US Seller Inc', bookingText: 'Währungsumrechnung' });
    expect(res.transactions.filter(t => t.isTransfer)).toHaveLength(2);
    expect(res.document.fields.skippedForeign).toBe(2);
  });
  it('Datumsreihenfolge gilt pro Datei: eindeutiges 14/01 → alle Zeilen Tag/Monat; Zeitzone PST → Monat/Tag', async () => {
    const mk = (tz, d1, d2) => csvFromString([
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Balance"',
      `"${d1}","10:00:00","${tz}","Shop","Express Checkout Payment","Completed","EUR","-10.00","0.00","-10.00","me@x.com","s@x.com","A1","90.00"`,
      `"${d2}","10:00:00","${tz}","Shop","Express Checkout Payment","Completed","EUR","-10.00","0.00","-10.00","me@x.com","s@x.com","A2","80.00"`,
    ].join('\n'));
    const dm = await parseStatement(null, mk('CET', '03/05/2026', '14/05/2026'), {});
    expect(dm.transactions.map(t => t.bookingDate)).toEqual(['2026-05-03', '2026-05-14']);
    const md = await parseStatement(null, mk('PST', '03/05/2026', '04/05/2026'), {});
    expect(md.transactions.map(t => t.bookingDate)).toEqual(['2026-03-05', '2026-04-05']);
  });
  it('deutsche Neuformat-Spalten: Entgelt wird gelesen, "Auswirkung auf Guthaben: Memo" bewegt kein Geld', async () => {
    const ex = csvFromString([
      '"Datum","Uhrzeit","Zeitzone","Beschreibung","Währung","Brutto","Entgelt","Netto","Guthaben","Transaktionscode","Absender E-Mail-Adresse","Name","Auswirkung auf Guthaben"',
      '"05.03.2026","10:00:00","CET","Allgemeine Zahlung","EUR","-50,00","0,00","-50,00","100,00","T1","me@x.com","Shop A","Soll"',
      '"06.03.2026","10:00:00","CET","Allgemeine Zahlung","EUR","1.000,00","-35,10","964,90","1.064,90","T2","k@x.com","Kunde B","Haben"',
      '"07.03.2026","10:00:00","CET","Zahlungsautorisierung","EUR","-20,00","0,00","-20,00","1.064,90","T3","me@x.com","Shop C","Memo"',
    ].join('\n'));
    const det = detectStatementFormat(ex, {});
    expect(det.format).toBe('paypal_csv');
    const res = await parseStatement(det, ex, {});
    expect(res.transactions.map(t => t.amount)).toEqual([-5000, 96490]);
    expect(res.transactions[1].fee).toBe(3510);
  });
});

describe('Weitere Bank-CSV-Formate (generischer Parser)', () => {
  async function run(csv, name = 'x.csv') {
    const ex = csvFromString(csv);
    const det = detectType(ex, { name, ext: 'csv' });
    return { det, res: await parse(det, ex, { name, ext: 'csv' }) };
  }
  it('Commerzbank: "Buchungstext" ist der Freitext, "Umsatzart" die Buchungsart', async () => {
    const { det, res } = await run([
      'Buchungstag;Wertstellung;Umsatzart;Buchungstext;Betrag;Währung;IBAN Kontoinhaber;Kategorie',
      '15.10.2026;15.10.2026;Gutschrift;Frigotechnik GmbH Gehalt 10/2026;3.290,98;EUR;DE89370400440532013000;Einnahmen',
      '14.10.2026;14.10.2026;Lastschrift;REWE Markt Hamburg Kartenzahlung;-45,67;EUR;DE89370400440532013000;Lebensmittel',
    ].join('\n'));
    expect(det.format).toBe('generic_csv');
    expect(res.account).toMatchObject({ institution: 'Commerzbank', iban: 'DE89370400440532013000' });
    expect(res.transactions.map(t => t.purpose)).toEqual(['REWE Markt Hamburg Kartenzahlung', 'Frigotechnik GmbH Gehalt 10/2026']);
    expect(res.transactions.map(t => t.bookingText)).toEqual(['Lastschrift', 'Gutschrift']);
  });
  it('Postbank: Buchungsdetails = Zweck, Gegenpartei je Richtung aus Auftraggeber/Empfänger', async () => {
    const { res } = await run([
      'Buchungsdatum;Wertstellung;Umsatzart;Buchungsdetails;Auftraggeber;Empfänger;Betrag (€);Saldo (€)',
      '14.10.2026;14.10.2026;Lastschrift;Kartenzahlung Einkauf;Max Mustermann;REWE Markt;-45,67;709,02',
      '15.10.2026;15.10.2026;Gutschrift;Gehalt 10/2026;Frigotechnik GmbH;Max Mustermann;3.290,98;4.000,00',
    ].join('\n'));
    expect(res.account.institution).toBe('Postbank');
    expect(res.transactions.map(t => [t.counterparty, t.purpose, t.amount])).toEqual([['REWE Markt', 'Kartenzahlung Einkauf', -4567], ['Frigotechnik GmbH', 'Gehalt 10/2026', 329098]]);
    expect(res.balance).toMatchObject({ opening: 75469, closing: 400000, check: true });
  });
  it('Volksbank: eigene IBAN (Auftragskonto) ≠ Gegenkonto-IBAN', async () => {
    const { res } = await run([
      'Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;BIC (SWIFT-Code) Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung;Bemerkung;Kategorie;Steuerrelevant;Bemerkung zur Steuerrelevanz',
      'Girokonto;DE02120300000000202051;BYLADEM1001;Volksbank Hamburg;14.10.2026;14.10.2026;REWE;DE22222222222222222222;ABCDEF;Lastschrift;Einkauf;-45,67;EUR;709,02;;;;',
    ].join('\n'));
    expect(res.account.iban).toBe('DE02120300000000202051');
    expect(res.transactions[0]).toMatchObject({ counterparty: 'REWE', counterpartyIban: 'DE22222222222222222222', bookingText: 'Lastschrift' });
  });
  it('Revolut: ausstehende Zahlungen (State=PENDING) werden übersprungen, Balance-Spalte liefert Salden', async () => {
    const { res } = await run([
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2026-10-14 10:12:11,2026-10-15 08:00:00,REWE Markt,-45.67,0.00,EUR,COMPLETED,709.02',
      'CARD_PAYMENT,Current,2026-10-17 10:12:11,,Pending Shop,-5.00,0.00,EUR,PENDING,709.02',
    ].join('\n'));
    expect(res.transactions).toHaveLength(1);
    expect(res.balance).toMatchObject({ closing: 70902, opening: 75469, check: true });
  });
});

describe('PDF-Kontoauszug: Zeilen mit "Muster" im Namen bleiben erhalten', () => {
  it('ING-Beispiel: Optik Muster GmbH und Buchhandlung Muster stehen in Gegenpartei/Zweck wie im CSV', async () => {
    const pdf = (await parseFile(path.join(SAMPLES, 'Banken/ING/ing_kontoauszug_2026-03.pdf'))).res;
    const csv = (await parseFile(path.join(SAMPLES, 'Banken/ING/ing_girokonto_2026H1.csv'))).res;
    expect(pdf.transactions.find(t => t.amount === -38900)).toMatchObject({ counterparty: 'Optik Muster GmbH', purpose: 'VISA Debitkarte Rechnung OPT-2026-0327' });
    expect(pdf.transactions.find(t => t.amount === -2240).purpose).toContain('Buchhandlung Muster');
    const keys = new Set(csv.transactions.map(t => t.dedupeKey));
    expect(pdf.transactions.filter(t => !keys.has(t.dedupeKey))).toHaveLength(0);
  });
  it('Fußzeile "MUSTER – Testdokument" und Übertragszeilen werden weiterhin ignoriert, "Kontoübertrag" im Zweck nicht', async () => {
    const mk = (y, parts) => ({ y, text: parts.map(p => p[1]).join('   '), items: parts.map(([x, str]) => ({ x, w: str.length * 5, str })) });
    const lines = [
      mk(800, [[50, 'ING-DiBa AG – Kontoauszug Girokonto']]), mk(780, [[50, 'IBAN: DE12 5001 0517 0000 0000 01']]), mk(770, [[50, 'Zeitraum   01.03.2026 – 31.03.2026']]),
      mk(760, [[50, 'Alter Saldo (01.03.2026)'], [400, '1.000,00 EUR']]),
      mk(720, [[50, '02.03.2026'], [100, '02.03.2026'], [150, 'Überweisung'], [400, '-100,00']]),
      mk(710, [[150, 'Erika Muster']]), mk(700, [[150, 'Kontoübertrag Taschengeld']]),
      mk(690, [[50, 'Übertrag auf Seite 2'], [400, '900,00']]),
      mk(680, [[50, 'MUSTER – Testdokument · Fiktive Daten   Seite 1']]),
      mk(660, [[50, '05.03.2026'], [100, '05.03.2026'], [150, 'Gutschrift'], [400, '50,00']]),
      mk(650, [[150, 'Anna Beispiel']]),
      mk(620, [[50, 'Neuer Saldo (31.03.2026)'], [400, '950,00 EUR']]),
    ];
    const ex = { kind: 'pdf', pages: [{ n: 1, text: lines.map(l => l.text).join('\n'), lines }], text: lines.map(l => l.text).join('\n') };
    const res = await parseStatement(detectStatementFormat(ex, {}), ex, {});
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions[0]).toMatchObject({ counterparty: 'Erika Muster', purpose: 'Kontoübertrag Taschengeld', amount: -10000 });
    expect(res.balance.check).toBe(true);
  });
});

// ---------------------------------------------------------------- Quellen-Mix
describe('Dieselbe Ansicht aus CSV, PDF und camt: reihenfolgeunabhängig, keine Doppelzählung', () => {
  const B = p => path.join(SAMPLES, 'Banken', p);
  const orders = [
    [B('ING/ing_girokonto_2026H1.csv'), B('ING/ing_kontoauszug_2026-03.pdf'), B('ING/camt053_ing_2026-05.xml')],
    [B('ING/ing_kontoauszug_2026-03.pdf'), B('ING/camt053_ing_2026-05.xml'), B('ING/ing_girokonto_2026H1.csv')],
    [B('ING/camt053_ing_2026-05.xml'), B('ING/ing_girokonto_2026H1.csv'), B('ING/ing_kontoauszug_2026-03.pdf')],
  ];
  const results = [];
  it('125 Buchungen, ein Konto, identische Summen und Kategorien in jeder Reihenfolge', async () => {
    for (const o of orders) {
      const D = await importFiles(o);
      const { ins, txs } = analyze(D, { from: '2026-01-01', to: '2026-06-30' });
      expect(D.accounts).toHaveLength(1);
      expect(txs).toHaveLength(125);
      results.push({ totals: ins.totals, cats: ins.byCategory.map(c => [c.id, c.amount]), by: ins.incomeBySource });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

describe('Beispielhaushalt komplett', () => {
  let R;
  const all = () => {
    const out = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(csv|pdf|xml)$/i.test(e.name)) out.push(p); } };
    walk(SAMPLES);
    return out.sort();
  };
  const get = async () => R || (R = analyze(await importFiles(all()), { from: '2026-01-01', to: '2026-06-30' }));

  it('Gehalt 6 × 3.290,98; Miete 6 × 1.150; Sparen = Tagesgeld + Allianz + Sparplan', async () => {
    const { ins, txs } = await get();
    expect(ins.incomeBySource.find(s => s.id === 'gehalt').amount).toBe(6 * 329098);
    expect(txs.filter(t => /Hausverwaltung/.test(t.counterparty)).reduce((s, t) => s + t.amount, 0)).toBe(-6 * 115000);
    expect(ins.byCategory.find(c => c.id === 'wohnen').subs.find(s => s.id === 'miete').amount).toBe(6 * 115000);
    expect(ins.totals.saving).toBe(6 * (50000 + 15000 + 30000));
    expect(ins.totals.income).toBe(6 * 329098 + 873);
  });
  it('alle monatlichen Verträge haben 6 Zahlungen, auch wenn ein Monat aus camt (mit Mandat) stammt', async () => {
    const { contracts } = await get();
    for (const re of [/Netflix/, /Spotify/, /Hausverwaltung/, /Alte Leipziger/, /Allianz/, /Vattenfall/, /Telekom/, /Urban Sports/, /Adobe/, /OpenAI/, /Verkehrsgesellschaft/]) {
      expect(contracts.find(c => re.test(c.provider)), String(re)).toMatchObject({ interval: 'monthly', count: 6, active: true });
    }
  });
  it('Nettovermögen: jedes Konto genau einmal, auch ohne Zeitraumfilter (Voreinstellung "Alles")', async () => {
    const { data } = await get();
    const ins = computeInsights(data, {});
    const names = ins.netWorth.byAccount.map(a => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(['ING Girokonto', 'PayPal', 'Renault Bank Tagesgeld', 'comdirect Depot', 'comdirect Girokonto', 'Fondsgebundene Privatrente (Testtarif) 4711-0815'].sort());
    expect(ins.netWorth.total).toBe(611620 + 3370 + 632873 + 735251 + 40992 + 1648237);
  });
  it('Sankey ohne Zyklen, Bilanz pro Knoten, Layout möglich', async () => {
    const { ins } = await get();
    expect(sankeyIssues(ins.sankey)).toEqual([]);
    expect(hasCycle(ins.sankey)).toBe(false);
    expect(layoutSankey(ins.sankey, { width: 1000, height: 520 })).toBeTruthy();
  });
});

// ---------------------------------------------------------------- Einzelfälle
function sankeyIssues(sk) {
  const issues = [];
  const ids = new Set(sk.nodes.map(n => n.id));
  const inn = new Map(), out = new Map();
  for (const l of sk.links) {
    if (!(l.value > 0) || !Number.isInteger(l.value)) issues.push(`Wert ${l.source}->${l.target}: ${l.value}`);
    if (!ids.has(l.source) || !ids.has(l.target)) issues.push(`Knoten fehlt ${l.source}->${l.target}`);
    out.set(l.source, (out.get(l.source) || 0) + l.value);
    inn.set(l.target, (inn.get(l.target) || 0) + l.value);
  }
  for (const n of sk.nodes) {
    if (inn.has(n.id) && out.has(n.id) && Math.abs(inn.get(n.id) - out.get(n.id)) > 1) issues.push(`Bilanz ${n.id}: in ${inn.get(n.id)} out ${out.get(n.id)}`);
    if (!inn.has(n.id) && !out.has(n.id)) issues.push(`Knoten ohne Link ${n.id}`);
  }
  return issues;
}
function hasCycle(sk) {
  const adj = new Map();
  for (const l of sk.links) { if (!adj.has(l.source)) adj.set(l.source, []); adj.get(l.source).push(l.target); }
  const st = new Map();
  let found = false;
  const dfs = u => { st.set(u, 1); for (const v of adj.get(u) || []) { if (st.get(v) === 1) found = true; else if (!st.get(v)) dfs(v); } st.set(u, 2); };
  for (const u of adj.keys()) if (!st.get(u)) dfs(u);
  return found;
}

let seq = 0;
const tx = (o = {}) => ({
  id: 'x' + ++seq, accountId: 'a1', bookingDate: '2026-03-01', amount: -1000, currency: 'EUR', counterparty: '', counterpartyRaw: '', counterpartyIban: null,
  purpose: '', bookingText: null, mandateId: null, creditorId: null, category: null, subcategory: null, isTransfer: false, ...o,
});

describe('Nettovermögen mit Stichtagen hinter der letzten Buchung', () => {
  const accounts = [{ id: 'a1', kind: 'giro', name: 'ING Girokonto' }, { id: 'd1', kind: 'depot', name: 'Depot' }];
  const data = {
    accounts,
    transactions: [tx({ amount: -5000, bookingDate: '2026-10-10', category: 'lebensmittel' }), tx({ amount: 300000, bookingDate: '2026-10-15', category: 'einkommen', subcategory: 'gehalt' })],
    valuations: [{ id: 'v1', accountId: 'a1', date: '2026-10-17', value: 451230 }, { id: 'v2', accountId: 'd1', date: '2026-10-17', value: 100000 }],
    holdings: [], documents: [], contracts: [], assets: [],
  };
  it('Auszugsende nach der letzten Buchung: Zeitraum "Alles" zeigt den Kontostand', () => {
    const ins = computeInsights(data, {});
    expect(ins.netWorth.byAccount.map(a => a.value).sort()).toEqual([100000, 451230]);
    expect(ins.netWorth.total).toBe(551230);
  });
  it('Zeitraum bis Monatsende: ebenfalls (Zeitraum reicht über die letzte Buchung)', () => {
    expect(computeInsights(data, { from: '2026-10-01', to: '2026-10-31' }).netWorth.total).toBe(551230);
  });
  it('historischer Zeitraum nimmt keine späteren Stände', () => {
    expect(computeInsights(data, { from: '2026-09-01', to: '2026-10-12' }).netWorth.total).toBe(0);
  });
  it('Depot: derselbe Bestand zweimal importiert zählt einmal; älterer Bestand wird ersetzt', () => {
    const h = (docId, date, isin, value) => ({ id: docId + isin + date, accountId: 'd1', documentId: docId, date, isin, value, name: isin });
    const nw = computeNetWorth([accounts[1]], [], [h('doc1', '2026-06-30', 'A', 300000), h('doc1', '2026-06-30', 'B', 100000), h('doc2', '2026-06-30', 'A', 300000), h('doc2', '2026-06-30', 'B', 100000), h('doc0', '2026-03-31', 'A', 50000)], [], []);
    expect(nw.total).toBe(400000);
  });
});

describe('Serien aus gemischten Quellen', () => {
  const series = (n, o, start = '2026-01-12') => Array.from({ length: n }, (_, i) => {
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return tx({ amount: -8450, counterparty: 'Vattenfall', category: 'wohnen', subcategory: 'strom_gas', ...o, bookingDate: d.toISOString().slice(0, 10) });
  });
  it('Mandat nur bei einem Teil der Buchungen (camt/PDF-Mix): eine Serie', () => {
    const t = series(6, {});
    t[4] = { ...t[4], mandateId: 'M-77', creditorId: 'DE98ZZZ09999999999' };
    const c = detectRecurring(t);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ count: 6, interval: 'monthly' });
  });
  it('zwei Mandate beim selben Anbieter bleiben zwei Verträge', () => {
    const a = series(6, { mandateId: 'M-1', amount: -1000 }), b = series(6, { mandateId: 'M-2', amount: -2500 }, '2026-01-20');
    const c = detectRecurring([...a, ...b]);
    expect(c.map(x => x.amount).sort((p, q) => p - q)).toEqual([-2500, -1000]);
    expect(c.every(x => x.count === 6)).toBe(true);
  });
  it('14-täglich wird erkannt und überall mit Intervall-Faktor 26/Jahr gerechnet', () => {
    const t = Array.from({ length: 8 }, (_, i) => tx({ amount: -2000, counterparty: 'Putzhilfe', bookingDate: new Date(Date.UTC(2026, 0, 2 + i * 14)).toISOString().slice(0, 10) }));
    const [c] = detectRecurring(t);
    expect(c).toMatchObject({ interval: 'biweekly', yearlyCost: 52000, monthly: Math.round(52000 / 12) });
    expect(c.nextDate).toBe(new Date(Date.UTC(2026, 0, 2 + 7 * 14 + 14)).toISOString().slice(0, 10));
    const ins = computeInsights({ accounts: [], transactions: t, contracts: [c], documents: [], valuations: [], holdings: [] }, {});
    expect(ins.recurring.yearlyTotal).toBe(52000);
  });
});

describe('Sankey-Sonderfälle', () => {
  const accounts = [{ id: 'g1', kind: 'giro', name: 'Giro 1' }, { id: 'g2', kind: 'giro', name: 'Giro 2' }, { id: 'g3', kind: 'giro', name: 'Giro 3' }];
  const pair = (a, b, v, day) => {
    const x = tx({ accountId: a, amount: -v, bookingDate: day, category: 'umbuchung', isTransfer: true, transferAccountId: b });
    const y = tx({ accountId: b, amount: v, bookingDate: day, category: 'umbuchung', isTransfer: true, transferAccountId: a, transferPairId: x.id });
    x.transferPairId = y.id;
    return [x, y];
  };
  it('Kreisüberweisungen g1→g2→g3→g1 heben sich auf: keine Zyklen, Bilanz stimmt', () => {
    const t = [
      tx({ accountId: 'g1', amount: 500000, category: 'einkommen', subcategory: 'sonstiges' }), tx({ accountId: 'g2', amount: -20000, category: 'lebensmittel' }), tx({ accountId: 'g3', amount: -10000, category: 'wohnen' }),
      ...pair('g1', 'g2', 100000, '2026-03-02'), ...pair('g2', 'g3', 60000, '2026-03-03'), ...pair('g3', 'g1', 30000, '2026-03-04'),
    ];
    const ins = computeInsights({ accounts, transactions: t, documents: [], contracts: [], valuations: [], holdings: [] }, { from: '2026-03-01', to: '2026-03-31' });
    expect(hasCycle(ins.sankey)).toBe(false);
    expect(sankeyIssues(ins.sankey)).toEqual([]);
  });
  it('negative Gehalts-Buchung (Rückzahlung) bricht die Bilanz des Netto-Knotens nicht', () => {
    const t = [
      tx({ accountId: 'g1', amount: 330000, category: 'einkommen', subcategory: 'gehalt' }), tx({ accountId: 'g2', amount: -50000, category: 'einkommen', subcategory: 'gehalt' }),
      tx({ accountId: 'g1', amount: -10000, category: 'lebensmittel' }),
    ];
    const documents = [{ id: 'd1', type: 'lohn', date: '2026-03-27', payroll: { gross: 520000, net: 330000, lohnsteuer: 80000, soli: 0, kirchensteuer: 10000, kv: 40000, pv: 10000, rv: 40000, av: 10000, period: '2026-03' } }];
    const ins = computeInsights({ accounts, transactions: t, documents, contracts: [], valuations: [], holdings: [] }, { from: '2026-03-01', to: '2026-03-31' });
    expect(sankeyIssues(ins.sankey)).toEqual([]);
  });
});

describe('Klassifizierung eigener Überweisungen und Dateinamen', () => {
  it('Überweisung an sich selbst ohne erkennbares Ziel: Umbuchung statt Ausgabe; mit Spar-Stichwort bleibt Sparen', () => {
    const [plain, saving] = classifyTransactions([
      tx({ amount: -20000, counterparty: 'Eigenes Konto', purpose: 'Überweisung', ownTransfer: true }),
      tx({ amount: -50000, counterparty: 'Eigenes Konto · Tagesgeld', purpose: 'Tagesgeld Sparen 05/2026', ownTransfer: true }),
    ]);
    expect(plain).toMatchObject({ category: 'umbuchung', subcategory: 'eigene_konten' });
    expect(saving.category).toBe('vorsorge_sparen');
    const ins = computeInsights({ accounts: [], transactions: [plain], contracts: [], documents: [], valuations: [], holdings: [] }, {});
    expect(ins.totals.expense).toBe(0);
  });
  it('Zufluss vom eigenen Konto ("Umbuchung Sparplan") ist weder Einnahme noch Entnahme aus Sparen', () => {
    const [inc] = classifyTransactions([tx({ amount: 30000, counterparty: 'Eigenes Konto', purpose: 'Umbuchung Verrechnungskonto Sparplan', ownTransfer: true })]);
    expect(inc.category).toBe('umbuchung');
    const ins = computeInsights({ accounts: [], transactions: [inc], contracts: [], documents: [], valuations: [], holdings: [] }, {});
    expect(ins.totals).toMatchObject({ income: 0, expense: 0, saving: 0 });
    // Gehalt vom eigenen Namen (z. B. Selbstständige) bleibt Einkommen
    expect(classifyTransactions([tx({ amount: 250000, counterparty: 'Eigenes Konto', purpose: 'Gehalt 10/2026', bookingText: 'Gehalt/Lohn', ownTransfer: true })])[0].category).toBe('einkommen');
  });
  it('Kartenzahlung bei comdirect/Sparkasse: Händlername ohne Karten-, Datums- und Kursrauschen', () => {
    const n = (cp) => normalizeCounterparty({ counterparty: cp, counterpartyRaw: cp, purpose: '', bookingText: 'Kartenzahlung' });
    expect(n('REWE SAGT DANKE. 1234 HAMBURG KARTE 4999 2026-10-14 KURS 1,0000')).toBe('Rewe');
    expect(n('LIDL SAGT DANKE 5678 BERLIN')).toBe('Lidl');
    expect(n('EDEKA Nord 2026-10-14T10:11:12 Debitk.2 VISA')).toBe('EDEKA Nord');
    expect(n('SPARKASSE HAMBURG 12345678 KARTE 4999 2026-10-05 Geldautomat')).toBe('Sparkasse');
  });
  it('Auszüge mehrerer Konten derselben Bank unterscheiden sich im Dateinamen', () => {
    const base = { type: 'kontoauszug', date: '2026-06-30', issuer: 'ING', institution: 'ING', fields: { format: 'ing_csv' } };
    expect(displayName({ ...base, fields: { ...base.fields, accountName: 'ING Girokonto' } }, 'csv')).toBe('2026-06-30_Umsaetze_ING_Girokonto.csv');
    expect(displayName({ ...base, fields: { ...base.fields, accountName: 'ING Extra-Konto' } }, 'csv')).toBe('2026-06-30_Umsaetze_ING_Extra-Konto.csv');
    expect(displayName({ type: 'paypal', date: '2026-06-12', issuer: 'PayPal', fields: { accountName: 'PayPal' } }, 'csv')).toBe('2026-06-12_Umsaetze_PayPal.csv');
    expect(displayName({ type: 'rechnung', date: '2026-02-20', issuer: 'Elektro Meyer GmbH', amount: 41230, fields: { accountName: 'Egal' } }, 'pdf')).toBe('2026-02-20_Rechnung_Elektro-Meyer-GmbH_412,30.pdf');
  });
});
