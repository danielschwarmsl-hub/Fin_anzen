// Überlappungen im Geldfluss: jede Zahlung zählt genau einmal (PayPal-Ketten, Depot, Karte, Storno, Vorsteuer),
// unsichere Fälle landen als checks in der Prüfliste.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeText, parseCsv } from '../src/lib/extract/decode.js';
import { parseStatement } from '../src/lib/parsers/statements/index.js';
import { normalizeCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions } from '../src/lib/classify/rules.js';
import { detectTransfers, detectStornos, computeFlowChecks, isFirmTransfer, PAYPAL_CREDITOR_ID } from '../src/lib/analyze/transfers.js';
import { estimateVat } from '../src/lib/analyze/vat.js';
import { computeInsights } from '../src/lib/analyze/insights.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
const csvFromString = (s) => { const { text } = decodeText(Buffer.from(s, 'utf8')); const p = parseCsv(text); return { kind: 'csv', text, rawText: text, rows: p.rows, meta: { delimiter: p.delimiter } }; };

let seq = 0;
const tx = (o = {}) => ({
  id: 'o' + ++seq, accountId: 'ing', bookingDate: '2026-03-01', amount: -1000, currency: 'EUR',
  counterparty: '', counterpartyRaw: '', counterpartyIban: null, purpose: '', bookingText: null,
  mandateId: null, creditorId: null, category: null, subcategory: null, isTransfer: false, ...o,
});
const ACC = {
  ing: { id: 'ing', kind: 'giro', institution: 'ING', name: 'ING Girokonto', iban: 'DE12500105170000000001' },
  cd: { id: 'cd', kind: 'giro', institution: 'comdirect', name: 'comdirect Girokonto', iban: null },
  pp: { id: 'pp', kind: 'paypal', institution: 'PayPal', name: 'PayPal' },
  dep: { id: 'dep', kind: 'depot', institution: 'comdirect', name: 'comdirect Depot', iban: null },
  cc: { id: 'cc', kind: 'kreditkarte', institution: 'Barclays', name: 'Barclays Visa', iban: null },
};
const accs = (...ids) => ids.map(i => ACC[i]);

/** postProcess-Schritte 1–3 ohne Datenbank, zweimal ausgeführt (Idempotenz) */
function pipeline(txs, accounts) {
  const once = (list) => {
    let t = list.map(x => ({ ...x, counterparty: normalizeCounterparty(x) || x.counterparty }));
    t = detectTransfers(t, accounts);
    t = detectStornos(t);
    t = computeFlowChecks(t, accounts);
    return classifyTransactions(t, { rules: [], accounts });
  };
  const first = once(txs);
  const second = once(first);
  expect(second.map(t => [t.id, t.isTransfer, t.transferPairId, t.transferConfidence || null, t.stornoPairId || null, JSON.stringify(t.checks || [])]))
    .toEqual(first.map(t => [t.id, t.isTransfer, t.transferPairId, t.transferConfidence || null, t.stornoPairId || null, JSON.stringify(t.checks || [])]));
  return Object.fromEntries(second.map(t => [t.id, t]));
}
const insights = (byId, accounts, documents = []) => computeInsights({ accounts, transactions: Object.values(byId), documents, contracts: [], valuations: [], holdings: [], assets: [] }, { from: '2026-01-01', to: '2026-12-31' });
const kinds = (t) => (t.checks || []).map(c => c.kind);

describe('PayPal-Ketten', () => {
  it('Einzug: Bank-Lastschrift ist Gegenbuchung, die PayPal-Zahlung mit Händler zählt einmal', () => {
    const accounts = accs('ing', 'pp');
    const out = pipeline([
      tx({ id: 'bk', bookingDate: '2026-05-21', amount: -2000, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID, purpose: 'PP.5555.PP . Spielwaren Bunt, Ihr Einkauf bei Spielwaren Bunt' }),
      tx({ id: 'pe', accountId: 'pp', bookingDate: '2026-05-20', amount: -2000, counterparty: 'Spielwaren Bunt', counterpartyRaw: 'Spielwaren Bunt', bookingText: 'Zahlung im Einzugsverfahren mit Zahlungsrechnung' }),
    ], accounts);
    expect(out.bk).toMatchObject({ isTransfer: true, transferPairId: 'pe', transferAccountId: 'pp', transferConfidence: 'high' });
    expect(out.pe.isTransfer).toBe(false);
    expect(insights(out, accounts).totals.expense).toBe(2000);
    expect(kinds(out.bk)).toEqual([]);
  });
  it('Einzugs-Zeile neben eigener Zahlungszeile (Zwilling): nur die Zahlungszeile zählt', () => {
    const accounts = accs('ing', 'pp');
    const out = pipeline([
      tx({ id: 'bk', bookingDate: '2026-05-21', amount: -2000, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID }),
      tx({ id: 'ez', accountId: 'pp', bookingDate: '2026-05-20', amount: -2000, counterparty: 'Spielwaren Bunt', bookingText: 'Zahlung im Einzugsverfahren mit Zahlungsrechnung' }),
      tx({ id: 'pz', accountId: 'pp', bookingDate: '2026-05-20', amount: -2000, counterparty: 'Spielwaren Bunt', bookingText: 'Allgemeine Zahlung' }),
    ], accounts);
    expect(out.pz.isTransfer).toBe(false);
    expect(insights(out, accounts).totals.expense).toBe(2000);
  });
  it('Mischzahlung: Teil-Einzug wird der PayPal-Zahlung zugeordnet, die Zahlung zählt voll und nur einmal', () => {
    const accounts = accs('ing', 'pp');
    const out = pipeline([
      tx({ id: 'pay', accountId: 'pp', bookingDate: '2026-03-10', amount: -10000, counterparty: 'ABC Shop', counterpartyRaw: 'ABC Shop', bookingText: 'Allgemeine Zahlung' }),
      tx({ id: 'bk', bookingDate: '2026-03-11', amount: -7000, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID, purpose: 'PP.1234.PP . ABC Shop, Ihr Einkauf bei ABC Shop' }),
      // Kauf aus Guthaben: keine Bankbuchung erwartet, keine Prüfung
      tx({ id: 'bal', accountId: 'pp', bookingDate: '2026-03-12', amount: -1500, counterparty: 'Kiosk Ecke', bookingText: 'Allgemeine Zahlung' }),
      // PayPal-Lastschrift ohne Partner im abgedeckten Zeitraum → Prüfliste
      tx({ id: 'lost', bookingDate: '2026-03-12', amount: -4321, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID, purpose: 'PP.9999.PP . Unbekannt' }),
    ], accounts);
    expect(out.bk).toMatchObject({ isTransfer: true, transferPairId: 'pay' });
    expect(out.pay.isTransfer).toBe(false);
    expect(kinds(out.bal)).toEqual([]);
    expect(kinds(out.lost)).toEqual(['paypal']);
    expect(insights(out, accounts).totals.expense).toBe(10000 + 1500 + 4321);
    // Einzug größer als die Zahlung wird nicht zugeordnet
    const big = pipeline([
      tx({ id: 'p2', accountId: 'pp', bookingDate: '2026-03-10', amount: -1000, counterparty: 'ABC Shop', bookingText: 'Allgemeine Zahlung' }),
      tx({ id: 'b2', bookingDate: '2026-03-11', amount: -7000, creditorId: PAYPAL_CREDITOR_ID, counterpartyRaw: 'PayPal', purpose: 'ABC Shop' }),
    ], accounts);
    expect(big.b2.isTransfer).toBe(false);
  });
  it('USD-Kauf (PayPal-CSV mit Umrechnung): Zahlung mit Händler in EUR, Umrechnungszeilen zählen nicht', async () => {
    const res = await parseStatement(null, csvFromString(fs.readFileSync(path.join(FIX, 'paypal_en_conversion.csv'), 'utf8')), {});
    const usd = res.transactions.find(t => t.originalCurrency === 'USD');
    expect(usd).toMatchObject({ amount: -1840, currency: 'EUR', originalAmount: -2000, counterparty: 'US Seller Inc' });
    expect(res.transactions.some(t => t.bookingText === 'Währungsumrechnung')).toBe(false);
    // Saldo bleibt stimmig (Endstand 0,00)
    expect(res.transactions.reduce((s, t) => s + t.amount, 0)).toBe(0);
    const accounts = accs('ing', 'pp');
    const ppTx = res.transactions.map((t, i) => ({ ...t, id: 'u' + i, accountId: 'pp' }));
    const bank = [
      tx({ id: 'bk1', bookingDate: '2026-01-14', amount: -8990, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID }),
      tx({ id: 'bk2', bookingDate: '2026-02-04', amount: -1840, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID }),
    ];
    const out = pipeline([...ppTx, ...bank], accounts);
    expect(out.bk1.isTransfer && out.bk2.isTransfer).toBe(true);
    const ins = insights(out, accounts);
    expect(ins.totals.expense).toBe(8990 + 1840);
    expect(ins.topMerchants.some(m => m.name.startsWith('US Seller'))).toBe(true);
    // unbekannte Felder (z. B. KI-Hinweise) bleiben beim Neuberechnen erhalten
    expect(pipeline([{ ...bank[0], aiHint: 'x' }], accounts)[bank[0].id].aiHint).toBe('x');
  });
  it('Fremdwährung ohne Umrechnungszeile wird weiter übersprungen', async () => {
    const res = await parseStatement(null, csvFromString([
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Reference Txn ID","Balance"',
      '"14/01/2026","09:00:00","CET","US Shop","Express Checkout Payment","Completed","USD","-5.00","0.00","-5.00","me@x.com","s@x.com","X1","","0.00"',
      '"15/01/2026","09:00:00","CET","EU Shop","Express Checkout Payment","Completed","EUR","-5.00","0.00","-5.00","me@x.com","s@x.com","X2","","0.00"',
    ].join('\n')), {});
    expect(res.transactions.map(t => t.amount)).toEqual([-500]);
    expect(res.document.fields.skippedForeign).toBe(1);
  });
});

describe('Depot', () => {
  it('Giro-Wertpapierkauf + Depot-Umsatz: Paar, zählt als Sparen, nicht als Ausgabe', () => {
    const accounts = accs('ing', 'dep');
    const out = pipeline([
      tx({ id: 'g', bookingDate: '2026-03-02', amount: -50000, counterparty: 'comdirect bank', purpose: 'Wertpapierkauf Sparplan ETF World', bookingText: 'Lastschrift' }),
      tx({ id: 'd', accountId: 'dep', bookingDate: '2026-03-04', amount: -50000, counterpartyRaw: 'ISHS CORE MSCI WORLD', purpose: '5 Stück ISHS CORE MSCI WORLD (WKN A0RPWH) zu 100 EUR', bookingText: 'Wertpapierkauf' }),
      tx({ id: 'v', accountId: 'dep', bookingDate: '2026-04-10', amount: 30000, counterpartyRaw: 'ISHS CORE MSCI WORLD', bookingText: 'Wertpapierverkauf' }),
    ], accounts);
    expect(out.g).toMatchObject({ isTransfer: true, transferPairId: 'd', transferConfidence: 'high' });
    expect(out.d.isTransfer).toBe(true);
    expect(out.v.isTransfer).toBe(true); // Verkauf ohne Giro-Gegenbuchung: neutral
    const ins = insights(out, accounts);
    expect(ins.totals.expense).toBe(0);
    expect(ins.totals.income).toBe(0);
    expect(ins.totals.saving).toBe(50000);
  });
  it('Giro-Wertpapierkauf ohne importiertes Depot zählt als Sparen', () => {
    const accounts = accs('ing');
    const out = pipeline([tx({ id: 'g', bookingDate: '2026-03-02', amount: -25000, counterparty: 'Broker', purpose: 'Wertpapierkauf', bookingText: 'Wertpapierkauf' })], accounts);
    const ins = insights(out, accounts);
    expect(ins.totals.expense).toBe(0);
    expect(ins.totals.saving).toBe(25000);
  });
});

describe('Kreditkarte', () => {
  it('Kartenabrechnung ohne Namen: genau eine Karte → Umbuchung dorthin, aber zur Prüfung', () => {
    const accounts = accs('ing', 'cc');
    const out = pipeline([tx({ id: 'k', bookingDate: '2026-03-02', amount: -45000, counterparty: 'Visa Service', purpose: 'Kreditkartenabrechnung 02/2026' })], accounts);
    expect(out.k).toMatchObject({ isTransfer: true, transferAccountId: 'cc', transferConfidence: 'medium' });
    expect(kinds(out.k)).toEqual(['transfer']);
    expect(insights(out, accounts).totals.expense).toBe(0);
    // zwei Karten: unklar, wohin → bleibt Ausgabe
    const two = [...accounts, { id: 'cc2', kind: 'kreditkarte', institution: 'Amex', name: 'Amex' }];
    expect(pipeline([tx({ id: 'k2', amount: -45000, counterparty: 'Visa Service', purpose: 'Kreditkartenabrechnung' })], two).k2.isTransfer).toBe(false);
  });
});

describe('Storno/Erstattung', () => {
  it('Zahlung + gleich hohe Gutschrift desselben Händlers heben sich auf', () => {
    const accounts = accs('ing');
    const out = pipeline([
      tx({ id: 'z1', bookingDate: '2026-03-01', amount: -5995, counterparty: 'Zalando SE', counterpartyRaw: 'Zalando SE', purpose: 'Bestellung 4711' }),
      tx({ id: 'z2', bookingDate: '2026-03-20', amount: 5995, counterparty: 'Zalando SE', counterpartyRaw: 'Zalando SE', purpose: 'Retoure Gutschrift 4711' }),
      tx({ id: 'f1', bookingDate: '2026-03-05', amount: -3000, counterparty: 'Max Freund', counterpartyRaw: 'Max Freund', purpose: 'Konzertkarten' }),
      tx({ id: 'f2', bookingDate: '2026-04-01', amount: 3000, counterparty: 'Max Freund', counterpartyRaw: 'Max Freund', purpose: 'Konzert' }),
      tx({ id: 'late1', bookingDate: '2026-01-01', amount: -777, counterparty: 'Shop X', counterpartyRaw: 'Shop X' }),
      tx({ id: 'late2', bookingDate: '2026-05-01', amount: 777, counterparty: 'Shop X', counterpartyRaw: 'Shop X', purpose: 'Erstattung' }),
    ], accounts);
    expect(out.z1).toMatchObject({ stornoPairId: 'z2', stornoConfidence: 'high' });
    expect(kinds(out.z1)).toEqual([]);
    expect(out.f1).toMatchObject({ stornoPairId: 'f2', stornoConfidence: 'medium' });
    expect(kinds(out.f2)).toEqual(['storno']);
    expect(out.late1.stornoPairId).toBeFalsy(); // > 60 Tage
    const { late1, late2, ...pairs } = out;
    void late1; void late2;
    const ins = insights(pairs, accounts);
    expect(ins.totals.expense).toBe(0);
    expect(ins.totals.income).toBe(0);
  });
  it('Nutzerentscheidung (stornoSource user) bleibt', () => {
    const out = pipeline([
      tx({ id: 'a', amount: -5995, counterparty: 'Zalando SE', stornoSource: 'user', stornoPairId: null }),
      tx({ id: 'b', bookingDate: '2026-03-02', amount: 5995, counterparty: 'Zalando SE', purpose: 'Erstattung', stornoSource: 'user', stornoPairId: null }),
    ], accs('ing'));
    expect(out.a.stornoPairId).toBeNull();
  });
});

describe('Vorsteuer ohne Verknüpfung', () => {
  const docs = [
    { id: 'k1', type: 'kassenbon', date: '2026-03-09', amount: 5590, vat: [{ rate: 7, net: 3000, tax: 210, gross: 3210 }, { rate: 19, net: 2000, tax: 380, gross: 2380 }] },
    { id: 'bar', type: 'kassenbon', date: '2026-03-15', amount: 1070, vat: [{ rate: 7, net: 1000, tax: 70, gross: 1070 }] },
  ];
  it('Beleg ersetzt die Schätzung der passenden Buchung (keine Doppelzählung); Barbeleg zählt allein', () => {
    const txs = [tx({ id: 'r', bookingDate: '2026-03-10', amount: -5590, category: 'lebensmittel', subcategory: 'supermarkt' })];
    const v = estimateVat(txs, docs, { from: '2026-03-01', to: '2026-03-31' });
    expect(v.fromReceipts).toBe(210 + 380 + 70);
    expect(v.estimated).toBe(0);
    // abgelehnter Beleg: Buchung wird weiter geschätzt
    const rej = estimateVat([{ ...txs[0], receiptRejected: ['k1'] }], docs, { from: '2026-03-01', to: '2026-03-31' });
    expect(rej.estimated).toBe(Math.round(5590 * 0.07 / 1.07));
  });
  it('Sammelbuchung mit receiptDocIds: alle Belege zählen, Buchung nicht zusätzlich geschätzt', () => {
    const txs = [tx({ id: 's', bookingDate: '2026-03-16', amount: -6660, category: 'lebensmittel', subcategory: 'supermarkt', receiptDocId: 'k1', receiptDocIds: ['k1', 'bar'] })];
    const v = estimateVat(txs, docs, { from: '2026-03-01', to: '2026-03-31' });
    expect(v).toEqual({ fromReceipts: 660, estimated: 0, total: 660 });
  });
});

describe('Umbuchungen: mittel sicher, Nutzerentscheidung', () => {
  const accounts = accs('ing', 'cd');
  it('Paar ohne Hinweis: automatisch, medium, Prüfliste; zählt für USt-Schätzung bis zur Bestätigung', () => {
    const out = pipeline([
      tx({ id: 'm1', bookingDate: '2026-03-04', amount: -12345 }),
      tx({ id: 'm2', accountId: 'cd', bookingDate: '2026-03-04', amount: 12345 }),
    ], accounts);
    expect(out.m1).toMatchObject({ isTransfer: true, transferPairId: 'm2', transferConfidence: 'medium', transferSource: 'auto' });
    expect(kinds(out.m1)).toEqual(['transfer']);
    expect(out.m1.checks[0].refId).toBe('m2');
    expect(isFirmTransfer(out.m1)).toBe(false);
    expect(insights(out, accounts).totals.expense).toBe(0);
    // Mit Hinweis im Text: high, keine Prüfung
    const hi = pipeline([tx({ id: 'h1', amount: -12345, purpose: 'Umbuchung' }), tx({ id: 'h2', accountId: 'cd', amount: 12345 })], accounts);
    expect(hi.h1.transferConfidence).toBe('high');
    expect(kinds(hi.h1)).toEqual([]);
    // Bestätigt (beide Seiten): bleibt, keine Prüfung mehr, zählt als sichere Umbuchung
    const conf = pipeline(Object.values(out).map(t => ({ ...t, transferSource: 'user', isTransfer: true })), accounts);
    expect(conf.m1).toMatchObject({ isTransfer: true, transferPairId: 'm2' });
    expect(kinds(conf.m1)).toEqual([]);
    expect(isFirmTransfer(conf.m1)).toBe(true);
    // Abgelehnt: bleibt abgelehnt
    const rej = pipeline(Object.values(out).map(t => ({ ...t, transferSource: 'user', isTransfer: false, transferPairId: null, transferAccountId: null })), accounts);
    expect(rej.m1.isTransfer || rej.m2.isTransfer).toBe(false);
    expect(kinds(rej.m1)).toEqual([]);
  });
  it('nur eine Seite vom Nutzer markiert: Gegenseite wird mit verknüpft (auch nach erneutem Lauf)', () => {
    const out = pipeline([
      tx({ id: 'u1', bookingDate: '2026-03-04', amount: -5000, isTransfer: true, category: 'umbuchung', categorySource: 'user' }),
      tx({ id: 'u2', accountId: 'cd', bookingDate: '2026-03-07', amount: 5000, counterparty: 'Max Mustermann' }),
    ], accounts);
    expect(out.u2).toMatchObject({ isTransfer: true, transferPairId: 'u1', transferConfidence: 'high' });
    expect(out.u1.transferPairId).toBe('u2');
    expect(insights(out, accounts).totals.income).toBe(0);
  });
  it('fremde checks (receipt) bleiben erhalten, eigene werden neu berechnet', () => {
    const t = tx({ id: 'c1', checks: [{ kind: 'receipt', reason: 'x' }, { kind: 'transfer', reason: 'alt' }] });
    const [r] = computeFlowChecks([t], accounts);
    expect(r.checks).toEqual([{ kind: 'receipt', reason: 'x' }]);
    const plain = tx({ id: 'c2' });
    expect(computeFlowChecks([plain], accounts)[0]).toBe(plain);
  });
});
