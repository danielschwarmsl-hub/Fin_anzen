// Paket E – Kontoauszüge auf Textebene: DKB altes Layout („Belastung/Gutschrift in EUR“, Datum ohne Jahr, Kontostand mit
// S/H), DKB neues Layout (Absicherung), comdirect Finanzreport (IBAN/Kartenendung aus der Kontoübersicht, mehrzeilige
// Vorgänge) und Konto-Zusammenführung PDF ↔ CSV im Importer (Datenbank gemockt).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- In-Memory-Ersatz für die benutzten Dexie-Tabellen (wie tests/detection-import.test.js) ----
function makeTable() {
  const rows = new Map();
  return {
    rows,
    async get(k) { return rows.get(k); },
    async put(r) { rows.set(r.id, structuredClone(r)); },
    async bulkPut(a) { for (const r of a) rows.set(r.id, structuredClone(r)); },
    async bulkUpdate(a) { for (const { key, changes } of a) { const r = rows.get(key); if (r) Object.assign(r, structuredClone(changes)); } },
    async update(k, patch) { const r = rows.get(k); if (r) Object.assign(r, structuredClone(patch)); },
    async toArray() { return [...rows.values()].map(r => structuredClone(r)); },
    where(field) {
      const list = (v) => [...rows.values()].filter(r => r[field] === v);
      return { equals: (v) => ({ toArray: async () => list(v).map(r => structuredClone(r)) }) };
    },
  };
}
const fakeDb = {};
for (const n of ['documents', 'accounts', 'transactions', 'lineItems', 'holdings', 'valuations']) fakeDb[n] = makeTable();
vi.mock('../src/lib/store/db.js', () => ({ db: fakeDb }));
vi.mock('../src/lib/store/state.svelte.js', () => ({
  app: { progress: { counts: {}, errors: [], log: [], newDocs: 0, newTx: 0, dupTx: 0, enrichedTx: 0 } },
  reload: vi.fn(async () => {}),
}));
vi.mock('../src/lib/store/postprocess.js', () => ({ postProcess: vi.fn(async () => {}) }));
vi.mock('../src/lib/extract/index.js', () => ({ extract: vi.fn(), terminateOcr: vi.fn(async () => {}) }));

const { detectType } = await import('../src/lib/detect/index.js');
const { parse } = await import('../src/lib/parsers/index.js');
const { saveResult } = await import('../src/lib/store/importer.js');
const { app } = await import('../src/lib/store/state.svelte.js');
const { decodeText, parseCsv } = await import('../src/lib/extract/decode.js');
const { detectStatementFormat, parseStatementAll } = await import('../src/lib/parsers/statements/index.js');
const { loadRealLike, realLikeMeta } = await import('./helpers/realLike.js');

async function run(ex, meta = { name: 'auszug.pdf', ext: 'pdf' }) {
  const det = detectType(ex, meta);
  const res = await parse(det, ex, meta);
  return { det, res, all: [res, ...(res.additional || [])] };
}
const runRealLike = (name) => run(loadRealLike(name), realLikeMeta(name));

// Zeilen wie extract/pdf.js sie liefert: Text aus Items, Lücke > 12 → drei Leerzeichen
const mkLine = (y, parts) => {
  const items = parts.map(([x, str, w]) => ({ x, w: w ?? str.length * 5, str }));
  let text = '', end = null;
  for (const it of items) {
    if (end != null) text += it.x - end > 12 ? '   ' : ' ';
    text += it.str; end = it.x + it.w;
  }
  return { y, text, items };
};
const toExtract = (pages) => ({ kind: 'pdf', ocr: false, pages, text: pages.map((p) => p.text).join('\n\f\n'), meta: { pageCount: pages.length } });

// ------------------------------------------------------------------ DKB altes Layout
describe('DKB Kontoauszug, altes Layout (Belastung/Gutschrift in EUR)', () => {
  it('Vorlage: Vorzeichen aus der Spalte, Kontostand mit H erst auf Seite 2, Saldo geht auf', async () => {
    const { res } = await runRealLike('dkb_kontoauszug_alt');
    expect(res.transactions.map((t) => t.amount)).toEqual([-8500, -4237, -20000, 15000, -95000, 312845]);
    expect(res.balance).toMatchObject({ opening: 123480, closing: 323588, check: true });
    expect(res.document.fields.diagnostics.sollHaben).toMatchObject({ columns: true, signFromKind: 0, signUnknown: 0 });
    expect(res.document.needsReview).toBe(false);
    expect(res.account.iban).toBe('DE91120300001084470523');
  });

  it('SEPA-Tags SVWZ+/EREF+/MREF+/CRED+ werden in Zweck und Referenzen zerlegt', async () => {
    const { res } = await runRealLike('dkb_kontoauszug_alt');
    const [strom, rewe, , trade, , lohn] = res.transactions;
    expect(strom).toMatchObject({
      counterparty: 'STADTWERKE WEDEL GMBH', purpose: 'Abschlag Strom 03/2023', bookingText: 'Lastschrift',
      endToEndId: 'SW-2023-0303-4471', mandateId: 'SWW00471', creditorId: 'DE77ZZZ00000231187',
    });
    expect(rewe).toMatchObject({ counterparty: 'REWE MARKT GMBH-ZW', bookingText: 'Kartenzahlung' });
    expect(trade).toMatchObject({ purpose: 'Auszahlung Depot', endToEndId: 'TRB-2023-0315-1' });
    expect(lohn).toMatchObject({ bookingText: 'Gehalt/Lohn', endToEndId: '2023033000174456' });
    expect(res.transactions.some((t) => /(?:EREF|SVWZ|MREF|CRED)\+/.test(t.purpose))).toBe(false);
  });

  it('Jahreswechsel: Datum ohne Jahr aus dem Zeitraum, Soll-Kontostand (S) negativ', async () => {
    const SOLL = 468, HABEN = 564; // rechte Kanten der Spalten
    const amt = (right, s) => [right - s.length * 5, s];
    const pages = [];
    const page = (n, fill) => {
      const lines = [];
      let y = 800;
      fill((parts) => { lines.push(mkLine(y, parts)); y -= 12; });
      pages.push({ n, text: lines.map((l) => l.text).join('\n'), lines });
    };
    page(1, (L) => {
      L([[69, 'Deutsche Kreditbank, Taubenstr. 7-9, 10117 Berlin']]);
      L([[69, 'Kontoauszug Nummer 001 / 2024 vom 15.12.2023 bis 15.01.2024']]);
      L([[69, 'Kontonummer 1084470523 / IBAN DE91 1203 0000 1084 4705 23']]);
      L([[69, 'Bu.Tag Wert', 52], [135, 'Wir haben für Sie gebucht', 112], [392, 'Belastung in EUR', 76], [489, 'Gutschrift in EUR', 75]]);
      L([[69, '28.12.', 26], [101, '29.12.', 26], [135, 'Lastschrift'], amt(SOLL, '500,00')]);
      L([[135, 'STADTWERKE MUSTERSTADT']]);
      L([[135, 'EREF+X1 SVWZ+Abschlag Januar']]);
      L([[69, '02.01.', 26], [101, '02.01.', 26], [135, 'Überweisung'], amt(HABEN, '100,00')]);
      L([[135, 'Erika Beispiel']]);
      L([[69, 'DEUTSCHE KREDITBANK AG'], [520, 'Seite 1 von 2']]);
    });
    page(2, (L) => {
      L([[69, 'ALTER KONTOSTAND'], [487, '100,00 H EUR', 75]]);
      L([[69, 'NEUER KONTOSTAND'], [487, '300,00 S EUR', 75]]);
    });
    const { res } = await run(toExtract(pages));
    // „Überweisung“ in der Gutschrift-Spalte: die Spalte entscheidet, nicht die Buchungsart
    expect(res.transactions.map((t) => [t.bookingDate, t.valueDate, t.amount])).toEqual([
      ['2023-12-28', '2023-12-29', -50000], ['2024-01-02', '2024-01-02', 10000],
    ]);
    expect(res.balance).toMatchObject({ opening: 10000, closing: -30000, check: true });
    expect(res.transactions[0]).toMatchObject({ purpose: 'Abschlag Januar', endToEndId: 'X1' });
  });
});

// ------------------------------------------------------------------ DKB neues Layout (Absicherung)
describe('DKB Kontoauszug, neues Layout (Betrag Soll/Haben EUR)', () => {
  it('54 Buchungen = 51 Soll + 3 Haben, Kontrollsummen und Saldo gehen auf, keine Prüfhinweise', async () => {
    const { res } = await runRealLike('dkb_kontoauszug');
    const f = res.document.fields;
    expect(f).toMatchObject({ expectedCount: 54, readCount: 54 });
    expect(f.controlTotals).toMatchObject({ sollCount: 51, habenCount: 3, sollSum: -241675, habenSum: 348368 });
    expect(f.diagnostics.problems).toEqual([]);
    expect(res.balance.check).toBe(true);
    expect(res.document.needsReview).toBe(false);
  });
});

// ------------------------------------------------------------------ comdirect Finanzreport
describe('comdirect Finanzreport (Textebene)', () => {
  it('IBAN je Konto und Kartenendung aus der Kontoübersicht, Saldo der Übersicht als Kontrollwert', async () => {
    const { all } = await runRealLike('comdirect_finanzreport');
    const [giro, tg, visa] = all;
    expect(giro.account).toMatchObject({ kind: 'giro', iban: 'DE25200411330007340061', name: 'comdirect Girokonto' });
    expect(tg.account).toMatchObject({ kind: 'tagesgeld', iban: 'DE95200411330007340062' });
    expect(visa.account).toMatchObject({ kind: 'kreditkarte', iban: null, number: '4871', name: 'comdirect Visa-Karte' });
    expect(giro.document.fields.overviewBalance).toBe(282372);
    expect(all.every((r) => !r.document.needsReview)).toBe(true);
  });

  it('weicht die Kontoübersicht vom Neuen Saldo ab → Prüfhinweis mit beiden Werten', async () => {
    const ex = structuredClone(loadRealLike('comdirect_finanzreport'));
    const l = ex.pages[1].lines.find((x) => /^Girokonto\s+DE25/.test(x.text));
    l.text = l.text.replace('+2.823,72', '+2.800,00');
    l.items = l.items.map((it) => ({ ...it, str: it.str.replace('+2.823,72', '+2.800,00') }));
    const { res } = await run(ex, realLikeMeta('comdirect_finanzreport'));
    expect(res.document.reviewReason).toMatch(/Kontoübersicht/);
    expect(res.document.fields.diagnostics.problems.join(' ')).toContain('Saldo laut Kontoübersicht 2800,00 €, Neuer Saldo im Abschnitt 2823,72 €.');
  });

  it('Vorgang über zwei Zeilen wird ein Buchungstext; Referenzen unter „Vorgang“ gehören nicht dazu', async () => {
    const { all } = await runRealLike('comdirect_finanzreport');
    const [giro, , visa] = all;
    const [kupon, wp, ueb, last, entgelt] = giro.transactions;
    expect([kupon, wp, ueb, last, entgelt].map((t) => t.bookingText)).toEqual(['Kupon', 'Wertpapiere', 'Überweisung', 'Lastschrift', 'Gebühr']);
    expect(ueb).toMatchObject({ counterparty: 'Gerichtskasse Hamburg', counterpartyIban: 'DE81200505501234567890', endToEndId: null });
    expect(entgelt.counterparty).toBe('comdirect');
    expect(kupon.counterparty).not.toMatch(/\d{5}/);
    expect(visa.transactions[2]).toMatchObject({ amount: 3470, purpose: 'SUMME MONATSABRECHNUNG VISA' });
  });
});

// ------------------------------------------------------------------ Konto-Zusammenführung
describe('Konto-Zusammenführung PDF ↔ bestehende Konten', () => {
  const opts = (fileId) => ({ fileId, meta: { ext: 'pdf' }, extracted: { text: '' }, existingKeys: new Set() });
  const save = (result, fileId = 'f1') => saveResult({ document: { type: 'kontoauszug', title: 'K' }, transactions: [], ...result }, opts(fileId));
  const accounts = () => fakeDb.accounts.toArray();
  const docs = () => fakeDb.documents.toArray();
  beforeEach(() => {
    for (const t of Object.values(fakeDb)) t.rows.clear();
    Object.assign(app.progress, { newDocs: 0, newTx: 0, dupTx: 0, enrichedTx: 0 });
  });

  it('comdirect-CSV vorher, dann Finanzreport: Giro, Tagesgeld und Visa landen im selben Konto, IBAN/Kartenendung ergänzt', async () => {
    const csv = [
      '"Umsätze Girokonto";"Zeitraum: 01.11.2024 - 30.11.2024";', '"Neuer Kontostand";"2.857,42 EUR";', '',
      '"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";',
      '"18.11.2024";"18.11.2024";"Übertrag / Überweisung";"Empfänger: Gerichtskasse Hamburg Buchungstext: Kassenzeichen 220241118735";"-28,00";',
      '',
      '"Umsätze Tagesgeld PLUS-Konto";"Zeitraum: 01.11.2024 - 30.11.2024";', '"Neuer Kontostand";"0,00 EUR";', '',
      '"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";',
      '',
      '"Umsätze Visa-Karte (Kreditkarte)";"Zeitraum: 01.11.2024 - 30.11.2024";', '"Neuer Kontostand";"-34,70 EUR";', '',
      '"Buchungstag";"Umsatztag";"Vorgang";"Referenz";"Buchungstext";"Umsatz in EUR";',
      '"12.11.2024";"11.11.2024";"Visa-Umsatz";"74420114316003391";"HEROKU 1BC77Q2";"-4,70";',
    ].join('\n');
    const { text } = decodeText(Buffer.from(csv, 'utf8'));
    const p = parseCsv(text);
    const ex = { kind: 'csv', text, rawText: text, rows: p.rows, meta: { delimiter: p.delimiter } };
    const csvResults = await parseStatementAll(detectStatementFormat(ex, {}), ex, {});
    for (const r of csvResults) await saveResult(r, opts('csv'));
    const before = await accounts();
    expect(before.map((a) => [a.kind, a.name, a.iban])).toEqual([
      ['giro', 'comdirect Girokonto', null], ['tagesgeld', 'comdirect Tagesgeld PLUS-Konto', null],
      ['kreditkarte', 'comdirect Visa-Karte (Kreditkarte)', null],
    ]);

    const { all } = await runRealLike('comdirect_finanzreport');
    for (const r of all) await saveResult(r, opts('fr'));
    const after = await accounts();
    expect(after).toHaveLength(3);
    expect(after.map((a) => [a.kind, a.iban, a.number ?? null])).toEqual([
      ['giro', 'DE25200411330007340061', null], ['tagesgeld', 'DE95200411330007340062', null], ['kreditkarte', null, '4871'],
    ]);
    expect((await docs()).every((d) => !d.needsReview)).toBe(true);
    // Buchungen aus CSV und Finanzreport nicht doppelt (gleiches Konto, Datum, Betrag)
    const txs = await fakeDb.transactions.toArray();
    const giroId = after[0].id, visaId = after[2].id;
    expect(txs.filter((t) => t.accountId === giroId)).toHaveLength(5);
    expect(txs.filter((t) => t.accountId === visaId)).toHaveLength(3);
  });

  it('Finanzreport vorher, dann CSV ohne IBAN: Zuordnung über Bank, Kontoart und Name ohne Klammerzusatz', async () => {
    await save({ account: { kind: 'kreditkarte', institution: 'comdirect', name: 'comdirect Visa-Karte', iban: null, number: '4871' } });
    await save({ account: { kind: 'kreditkarte', institution: 'comdirect', name: 'comdirect Visa-Karte (Kreditkarte)', iban: null, number: null } });
    expect(await accounts()).toHaveLength(1);
    expect((await docs()).map((d) => !!d.needsReview)).toEqual([false, false]);
  });

  it('andere Kartenendung derselben Bank → eigenes Konto mit Prüfhinweis; gleiche Endung → dasselbe Konto', async () => {
    await save({ account: { kind: 'kreditkarte', institution: 'comdirect', name: 'comdirect Visa-Karte', iban: null, number: '4871' } });
    await save({ account: { kind: 'kreditkarte', institution: 'comdirect', name: 'comdirect Visa-Karte', iban: null, number: '1234' } });
    expect(await accounts()).toHaveLength(2);
    expect((await docs())[1].reviewReason).toBe('Konto zugeordnet? bitte prüfen');
    await save({ account: { kind: 'kreditkarte', institution: 'comdirect', name: 'Visa', iban: null, number: 'XXXX XXXX 4871' } });
    expect(await accounts()).toHaveLength(2);
  });

  it('Kontonummer ohne IBAN ↔ bestehendes Konto mit IBAN derselben Bank (IBAN endet auf die Kontonummer)', async () => {
    await save({ account: { kind: 'giro', institution: 'DKB', name: 'DKB Girokonto', iban: 'DE91120300001084470523', number: null } });
    await save({ account: { kind: 'giro', institution: 'DKB', name: 'DKB-Cash', iban: null, number: '1084470523' } });
    expect(await accounts()).toHaveLength(1);
    await save({ account: { kind: 'giro', institution: 'DKB', name: 'DKB-Cash', iban: null, number: '1084470999' } });
    expect(await accounts()).toHaveLength(2);
  });
});
