// Paket D – Depot-Reporting und Bestände: MLP „Reporting für Ihre Konten und Depots“ und Depotteil des comdirect-Finanzreports.
// Parser gegen die originalnahen Vorlagen (Textebene, tests/fixtures/real-like) und die geschwärzten Scans (real-ocr);
// Ende-zu-Ende über den echten Importer (In-Memory-DB) bis zum Nettovermögen.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileItem } from './helpers/fake-db.js';
import { loadExpected, loadRealLike, realLikeMeta, realLikePdf } from './helpers/realLike.js';

vi.mock('../src/lib/store/db.js', async () => {
  const { makeFakeDb } = await import('./helpers/fake-db.js');
  return { db: makeFakeDb(), TABLES: [], loadAll: async () => ({}), getSetting: async (k, f = null) => f, setSetting: async () => {}, wipeAll: async () => {} };
});
vi.mock('../src/lib/store/state.svelte.js', async () => {
  const { makeFakeApp } = await import('./helpers/fake-db.js');
  return { app: makeFakeApp(), reload: async () => {}, toast: () => {} };
});
vi.mock('../src/lib/extract/index.js', async (orig) => ({ ...(await orig()), terminateOcr: async () => {} }));

const { db } = await import('../src/lib/store/db.js');
const { app } = await import('../src/lib/store/state.svelte.js');
const { runImport, ensureSource } = await import('../src/lib/store/importer.js');
const { detectType } = await import('../src/lib/detect/index.js');
const { parse } = await import('../src/lib/parsers/index.js');
const { computeInsights } = await import('../src/lib/analyze/insights.js');
const { detectTransfers } = await import('../src/lib/analyze/transfers.js');
const { parseComdirectDepot, parseTaxOverview } = await import('../src/lib/parsers/statements/pdf-depotreport.js');

const EXP = loadExpected();
const run = async (ex, meta) => {
  const det = detectType(ex, meta);
  const res = await parse(det, ex, meta);
  return { det, res, all: [res, ...(res.additional || [])] };
};
const realLike = (name) => run(loadRealLike(name), realLikeMeta(name));
const ocr = (name) => {
  const { pages } = JSON.parse(fs.readFileSync(new URL(`./fixtures/real-ocr/${name}.json`, import.meta.url), 'utf8'));
  return run({ kind: 'pdf', ocr: true, ocrConfidence: 75, pages, text: pages.map((p) => p.text).join('\n') }, { name: 'scan.pdf', ext: 'pdf' });
};
const num = (s) => Number(s);

describe('MLP Reporting (Textebene)', () => {
  const E = EXP.mlp_depotreport;

  it('bleibt Wertpapier › Depot-Reporting „Depot-Reporting Q1 2025 MLP“, nur Info, ohne Prüfhinweis', async () => {
    const { det, res } = await realLike('mlp_depotreport');
    expect(det).toMatchObject({ type: 'wertpapier', subtype: 'depotreport', format: 'mlp_reporting', institution: 'MLP' });
    expect(res.document).toMatchObject({
      type: 'wertpapier', subtype: 'depotreport', institution: 'MLP', amount: null, title: 'Depot-Reporting Q1 2025 MLP',
      date: '2025-03-31', periodFrom: '2025-01-01', periodTo: '2025-03-31', needsReview: false,
    });
    expect(res.document.fields).toMatchObject({ infoOnly: true, period: 'Q1 2025', depot: 'Vermögensdepot', depotNumber: E.depot.number });
  });

  it('Depotkonto mit Depotnummer, Bewertung zum Stichtag (Gesamtwert inkl. Liquiditätskonto)', async () => {
    const { res } = await realLike('mlp_depotreport');
    expect(res.account).toEqual({ kind: 'depot', institution: 'MLP', name: E.depot.name, iban: null, currency: 'EUR', number: E.depot.number });
    expect(res.valuations).toEqual([{ date: E.depot.date, value: E.depot.value, label: 'Depotwert MLP Vermögensdepot' }]);
    expect(res.document.fields).toMatchObject({
      depotValue: E.depot.value, securitiesValue: E.depot.securitiesValue, liquidity: E.depot.liquidity, structure: E.depot.structure,
    });
  });

  it('Positionen: Name (mit Folgezeilen), WKN, Schwerpunkt, Anteile, Kurs, Kursdatum, Währung/Devisenkurs, Wert, Anteil %', async () => {
    const { res } = await realLike('mlp_depotreport');
    expect(res.holdings.map((h) => ({
      wkn: h.wkn, name: h.name, focus: h.focus, currency: h.currency, price: h.priceExact, priceDate: h.priceDate,
      fxRate: h.fxRate, units: h.qty, value: h.value, share: h.share,
    }))).toEqual(E.holdings.map((h) => ({
      wkn: h.wkn, name: h.name, focus: h.focus, currency: h.currency, price: num(h.price), priceDate: h.priceDate,
      fxRate: h.fxRate, units: h.units, value: h.value, share: h.share,
    })));
    expect(res.holdings.every((h) => h.date === '2025-03-31' && h.savingsRate === 2000 && h.custody === 'Wertpapierrechnung')).toBe(true);
    // Wertentwicklung je Wertpapier seit erstmaligem Kauf
    expect(res.holdings.find((h) => h.wkn === 'A2QJLA')).toMatchObject({ performancePct: -6.73, result: -2604 });
  });

  it('Kennzahlen „Ihr Vermögensdepot im Überblick“ und Wertentwicklung (zeit-/geldgewichtet)', async () => {
    const { res } = await realLike('mlp_depotreport');
    const f = res.document.fields;
    for (const [k, v] of Object.entries(E.figures)) expect(f[k], k).toEqual(v);
    expect(f).toMatchObject({ deliveriesIn: 0, deliveriesOut: 0, flatTax: 0, valuePrevDate: '2024-12-31', exemption: E.freistellung });
    expect(f.performance).toMatchObject({ twr: E.performance.twr, mwr: E.performance.mwr });
    expect(f.performance.periods.at(-1)).toEqual({ from: '2024-07-01', to: '2025-03-31' });
  });

  it('Transaktionsübersicht: 27 Käufe als Depot-Buchungen (Abfluss im Depot, Wertpapierkauf, Anteile/Preis/Devisenkurs)', async () => {
    const { res } = await realLike('mlp_depotreport');
    expect(res.transactions.map((t) => [t.wkn, t.bookingDate, t.amount, t.units, t.unitPrice, t.priceCurrency, t.fxRate, t.tradeFee]))
      .toEqual(E.transactions.map((t) => [t.wkn, t.date, -t.amount, t.units, num(t.price), t.priceCurrency, t.fxRate, t.fee]));
    expect(res.transactions.every((t) => t.bookingText === 'Wertpapierkauf')).toBe(true);
    expect(new Set(res.transactions.map((t) => t.dedupeKey)).size).toBe(27);
    expect(res.transactions[3].purpose).toMatch(/0,492 Anteile iShares Edge .* \(WKN A2JSDC\) zu 42,118 USD, Devisenkurs 1,0365/);
  });

  it('Liquiditätskonto: eigenes Konto mit IBAN; Stand nur als Saldo, keine zweite Bewertung', async () => {
    const { all } = await realLike('mlp_depotreport');
    expect(all).toHaveLength(2);
    const liq = all[1];
    expect(liq.account).toMatchObject({ kind: 'tagesgeld', institution: 'MLP', name: 'MLP Liquiditätskonto', iban: E.depot.liquidity.iban });
    expect(liq.balance).toMatchObject({ closing: E.depot.liquidity.value, closingDate: '2025-03-31' });
    expect(liq.valuations).toEqual([]);
    expect(liq.transactions).toEqual([]);
    expect(liq.document).toMatchObject({ type: 'kontoauszug', title: 'Kontostand MLP Liquiditätskonto 31.03.2025' });
    expect(liq.document.fields.includedInDepotValue).toBe(true);
  });

  it('Depotkäufe im Depot sind neutral (Umschichtung), nicht Ausgabe', async () => {
    const { res } = await realLike('mlp_depotreport');
    const txs = res.transactions.map((t, i) => ({ ...t, id: 't' + i, accountId: 'dep' }));
    const out = detectTransfers(txs, [{ id: 'dep', kind: 'depot', institution: 'MLP' }]);
    expect(out.every((t) => t.isTransfer)).toBe(true);
  });
});

describe('MLP Reporting (geschwärzter Scan)', () => {
  it('ohne lesbare Werte: bleibt das reine Info-Dokument, kein leeres Depot, kein Absturz', async () => {
    const { det, all } = await ocr('mlp_depotreport');
    expect(det).toMatchObject({ type: 'wertpapier', subtype: 'depotreport' });
    expect(det.format ?? null).toBe(null);
    expect(all).toHaveLength(1);
    expect(all[0].document).toMatchObject({ title: 'Depot-Reporting Q1 2025 MLP', amount: null });
    expect(all[0].holdings).toEqual([]);
  });
});

describe('comdirect Finanzreport: Depotbestand und Steuerübersicht', () => {
  const E = EXP.comdirect_finanzreport;

  it('Konten bleiben vorn (Giro, Tagesgeld, Visa), Depot als eigenes Ergebnis', async () => {
    const { all } = await realLike('comdirect_finanzreport');
    expect(all.map((r) => [r.document.type, r.account.kind, r.account.name])).toEqual([
      ['kontoauszug', 'giro', 'comdirect Girokonto'],
      ['kontoauszug', 'tagesgeld', 'comdirect Tagesgeld PLUS-Konto'],
      ['kreditkarte', 'kreditkarte', 'comdirect Visa-Karte'],
      ['depot', 'depot', 'comdirect Depot'],
    ]);
    const dep = all[3];
    expect(dep.document).toMatchObject({ title: 'Depotbestand comdirect Depot 02.12.2024', date: E.depot.date, needsReview: false });
    expect(dep.valuations).toEqual([{ date: E.depot.date, value: E.depot.value, label: 'Depotwert comdirect' }]);
    expect(dep.document.fields).toMatchObject({ positions: E.depot.count, depotValue: E.depot.value, cost: E.depot.cost, gain: E.depot.gain });
  });

  it('17 Positionen mit Name, Verwahrart, Anzahl, letztem Kurs, Währung, Kurswert, Kaufwert, Gewinn/Verlust', async () => {
    const { all } = await realLike('comdirect_finanzreport');
    const hs = all[3].holdings;
    expect(hs.map((h) => [h.wkn, h.name, h.qty, h.currency, h.value, h.cost, h.gain, h.custody, h.priceExact]))
      .toEqual(E.depot.holdings.map((h) => [h.wkn, h.name, h.qty, h.currency, h.value, h.cost, h.gain, h.verwahrart, num(h.priceText.replace(',', '.'))]));
    expect(hs[0]).toMatchObject({ custodyCountry: 'Kanada/USA über AKV', accruedInterest: 0, date: '2024-12-02' });
  });

  it('Steuerübersicht: Verlustverrechnungstöpfe, Freibetrag, abgeführte Steuern', async () => {
    const { all } = await realLike('comdirect_finanzreport');
    const f = all[3].document.fields;
    expect(f.taxOverview).toEqual(E.taxOverview);
    expect(f).toMatchObject({ lossPotStocks: -31226, lossPotOther: 0, allowanceRemaining: 0, taxPaid: 1040 + 57 + 83 });
  });

  it('geschwärzter Scan: Konten wie bisher, kein Depot aus unlesbaren Zeilen', async () => {
    const { all } = await ocr('comdirect_finanzreport');
    expect(all.map((r) => r.account.name)).toEqual(['comdirect Girokonto', 'comdirect Visa-Karte']);
  });

  it('Bestandszeilen: zwei- und dreizeilige Positionen, Gesamtwert; ohne Kurs-Spalte kein Bestand', () => {
    const lines = [
      'Depotbestand   EUR   EUR   EUR',
      'A2JF4K / Girosammelverwahrung   50,000   21,20   EUR   1.060,00   1.099,35   -39,35',
      'VESTRA GR.HLDG NA 1/8   +0,00',
      'A1W2K5 / Wertpapierrechnung   800,000   3,795   EUR   3.036,00   1.889,38   +1.146,62',
      'Kanada/USA über AKV   +0,00',
      'HARBOR LANE INC. CL.B',
      'Gesamtkurswert   4.096,00   2.988,73   +1.107,27',
      'Steuerübersicht1',
      'Abgeführte Kapitalertragsteuer',
      '10,40',
    ];
    const d = parseComdirectDepot(lines, '2024-12-02');
    expect(d.holdings.map((h) => [h.wkn, h.name, h.value])).toEqual([['A2JF4K', 'VESTRA GR.HLDG NA 1/8', 106000], ['A1W2K5', 'HARBOR LANE INC. CL.B', 303600]]);
    expect(d).toMatchObject({ total: 409600, cost: 298873, gain: 110727 });
    expect(parseTaxOverview(lines)).toMatchObject({ capitalGainsTax: 1040, taxPaid: 1040 });
    expect(parseComdirectDepot(['Depotbestand', 'A0B1C2 / Wertpapierrechnung   19,000   EUR   1.234,56   1.000,00   +234,56'], null)).toBeNull();
  });
});

describe('Import bis Vermögen (echter Importer, PDF mit Textebene)', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const pdf = (name) => fileItem(`Depot/${name}.pdf`, fs.readFileSync(realLikePdf(name)));

  it('MLP + Finanzreport: Depots mit Beständen, Liquiditätskonto, Nettovermögen ohne Doppelzählung', async () => {
    db.reset();
    app.progress.running = false;
    const s = await ensureSource({ kind: 'local', name: 'T', root: 'T' });
    await runImport([pdf('mlp_depotreport'), pdf('comdirect_finanzreport')], s, { concurrency: 1 });
    expect(app.progress.errors).toEqual([]);
    const snap = db.snapshot();
    const acc = (name) => snap.accounts.find((a) => a.name === name);
    const mlp = acc('MLP Vermögensdepot'), liq = acc('MLP Liquiditätskonto'), cd = acc('comdirect Depot');
    expect(mlp).toMatchObject({ kind: 'depot', number: '4711235001' });
    expect(liq).toMatchObject({ kind: 'tagesgeld', iban: 'DE10672300000004711235' });
    expect(snap.holdings.filter((h) => h.accountId === mlp.id)).toHaveLength(9);
    expect(snap.holdings.filter((h) => h.accountId === cd.id)).toHaveLength(17);
    expect(snap.valuations.filter((v) => v.accountId === liq.id)).toEqual([]);
    expect(snap.documents.map((d) => d.title)).toEqual(expect.arrayContaining(['Depot-Reporting Q1 2025 MLP', 'Depotbestand comdirect Depot 02.12.2024']));
    // Depotkäufe: neutral (Umbuchung/Umschichtung), keine Ausgabe
    const trades = snap.transactions.filter((t) => t.accountId === mlp.id);
    expect(trades).toHaveLength(27);
    expect(trades.every((t) => t.isTransfer)).toBe(true);

    const ins = computeInsights({ ...snap, transactions: snap.transactions }, {});
    const by = new Map(ins.netWorth.byAccount.map((x) => [x.accountId, x.value]));
    expect(by.get(mlp.id)).toBe(552941); // Wertpapiere 5.487,23 + Liquiditätskonto 42,18
    expect(by.has(liq.id)).toBe(false); // Liquiditätskonto nicht zusätzlich
    expect(by.get(cd.id)).toBe(1310320);
    // die 27 Käufe (540 €) im Depot zählen weder als Ausgabe noch nochmals als Sparen
    const own = computeInsights(snap, { accountIds: [mlp.id] });
    expect([own.totals.expense, own.totals.saving]).toEqual([0, 0]);
  });

  it('Sparplan-Abbuchung vom Girokonto zählt einmal als Sparen, die Fondskäufe im Depot nicht nochmals', async () => {
    db.reset();
    app.progress.running = false;
    const s = await ensureSource({ kind: 'local', name: 'T', root: 'T' });
    const csv = [
      'Umsatzanzeige;Datei erstellt am: 31.03.2025 10:00', '', 'IBAN;DE02 5001 0517 0000 0471 10', 'Kontoname;Girokonto', 'Bank;ING',
      'Kunde;Jan Beispiel', 'Zeitraum;01.01.2025 - 31.03.2025', '',
      'Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;Betrag;Währung',
      ...['02.01.2025', '03.02.2025', '03.03.2025'].map((d) => `${d};${d};MLP Banking AG;Lastschrift;VERMOEGENSDEPOT SAMMELBUCHUNG SPARPLAN WKN A0NB6T;;EUR;-180,00;EUR`),
    ].join('\r\n') + '\r\n';
    await runImport([fileItem('ing/giro.csv', new TextEncoder().encode(csv)), pdf('mlp_depotreport')], s, { concurrency: 1 });
    expect(app.progress.errors).toEqual([]);
    const snap = db.snapshot();
    const ins = computeInsights(snap, { from: '2025-01-01', to: '2025-03-31' });
    expect(ins.totals.expense).toBe(0);
    expect(ins.totals.saving).toBe(54000); // 3 × 180 €, nicht zusätzlich 27 × 20 € aus dem Depot
  });

  it('Neueinlesen desselben Reports: keine doppelten Käufe', async () => {
    db.reset();
    app.progress.running = false;
    const s = await ensureSource({ kind: 'local', name: 'T', root: 'T' });
    const raw = fs.readFileSync(realLikePdf('mlp_depotreport'));
    await runImport([fileItem('a/mlp.pdf', raw)], s, { concurrency: 1 });
    await runImport([fileItem('b/mlp-kopie.pdf', raw)], s, { concurrency: 1 });
    const snap = db.snapshot();
    expect(snap.transactions).toHaveLength(27);
    expect(snap.accounts.filter((a) => a.kind === 'depot')).toHaveLength(1);
  });
});
