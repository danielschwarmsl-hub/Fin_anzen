import { describe, it, expect, vi } from 'vitest';
import { planReceipts, matchReceipts, applyReceipts, suggestSplit, docRefs } from '../src/lib/analyze/receipts.js';
import { detectRecurring, linkContractDocs } from '../src/lib/analyze/recurring.js';

vi.mock('../src/lib/store/db.js', () => ({ db: {} }));
const { mergeContracts } = await import('../src/lib/store/postprocess.js');

let seq = 0;
const tx = (o = {}) => ({
  id: 'tx' + ++seq, accountId: 'a1', bookingDate: '2026-04-10', amount: -1000, currency: 'EUR',
  counterparty: '', counterpartyRaw: '', purpose: '', bookingText: null, category: null, subcategory: null, isTransfer: false, ...o,
});
const doc = (o = {}) => ({ id: 'd' + ++seq, type: 'kassenbon', date: '2026-04-10', amount: 1000, issuer: 'REWE', fields: {}, ...o });
const byId = (list) => Object.fromEntries(list.map(t => [t.id, t]));

// ---------------------------------------------------------------- Sperre & Lernen
describe('Belege: Nutzerentscheidungen und Auto-Links', () => {
  it('Auto-Link setzt receiptSource/receiptScore, eindeutige Treffer ohne Prüfpunkt', () => {
    const d = doc({ id: 'da' });
    const t = tx({ id: 'ta', counterparty: 'REWE Markt' });
    const [out] = applyReceipts([t], [d]);
    expect(out).toMatchObject({ receiptDocId: 'da', receiptDocIds: ['da'], receiptSource: 'auto' });
    expect(out.receiptScore).toBeGreaterThan(100);
    expect(out.checks).toBeUndefined();
  });
  it('bestätigter Beleg bleibt, auch wenn ein besserer auftaucht; der Beleg wird nicht anderweitig vergeben', () => {
    const d1 = doc({ id: 'du1' }), d2 = doc({ id: 'du2' });
    const t = tx({ id: 'tu', counterparty: 'REWE', receiptDocId: 'du1', receiptDocIds: ['du1'], receiptSource: 'user' });
    const t2 = tx({ id: 'tu2', counterparty: 'REWE', bookingDate: '2026-04-11' });
    const out = byId(applyReceipts([t, t2], [d1, d2]));
    expect(out.tu).toBe(t);
    expect(out.tu2.receiptDocId).toBe('du2');
  });
  it('gelöster Beleg kommt nie wieder (weder als Link noch als Vorschlag)', () => {
    const d = doc({ id: 'dr' });
    const t = tx({ id: 'tr', counterparty: 'REWE', receiptDocId: null, receiptDocIds: [], receiptSource: 'user', receiptRejected: ['dr'] });
    const [out] = applyReceipts([t], [d]);
    expect(out.receiptDocId).toBeNull();
    expect(out.receiptSource).toBe('user');
    expect(out.checks).toBeUndefined();
  });
  it('nach dem Lösen: ein anderer passender Beleg wird verknüpft, aber immer zur Prüfung', () => {
    const d = doc({ id: 'dn' });
    const t = tx({ id: 'tn', counterparty: 'REWE', receiptSource: 'user', receiptRejected: ['dalt'] });
    const [out] = applyReceipts([t], [d]);
    expect(out).toMatchObject({ receiptDocId: 'dn', receiptSource: 'auto' });
    expect(out.checks).toEqual([{ kind: 'receipt', reason: expect.stringMatching(/gelöst/), refId: 'dn' }]);
  });
  it('verwaiste Auto-Links (auch Altbestand ohne receiptSource) werden entfernt', () => {
    const t1 = tx({ id: 'to1', receiptDocId: 'weg', receiptSource: 'auto', receiptScore: 90 });
    const t2 = tx({ id: 'to2', receiptDocId: 'weg2' });
    const out = applyReceipts([t1, t2], [doc({ id: 'dz', date: '2025-01-01' })]);
    expect(out[0]).toMatchObject({ receiptDocId: null, receiptDocIds: [], receiptSource: null, receiptScore: null });
    expect(out[1].receiptDocId).toBeNull();
  });
  it('idempotent: zweiter Lauf ändert nichts; fremde checks bleiben erhalten', () => {
    const txs = [tx({ counterparty: 'REWE', checks: [{ kind: 'transfer', reason: 'x' }] }), tx({ amount: -777 })];
    const docs = [doc({ amount: 1000 }), doc({ amount: 777, issuer: 'Laden' })];
    const once = applyReceipts(txs, docs);
    const twice = applyReceipts(once, docs);
    expect(twice).toEqual(once);
    twice.forEach((t, i) => expect(t).toBe(once[i]));
    expect(once[0].checks).toEqual([{ kind: 'transfer', reason: 'x' }]);
  });
  it('KI-Felder bleiben erhalten (Buchung und gleicher Prüfpunkt)', () => {
    const t = tx({ id: 'ai1', aiHint: 'h', aiReason: 'r', aiAt: 1, aiSuggestion: { x: 1 }, checks: [{ kind: 'receipt', refId: 'dai', reason: 'alt', aiHint: 'passt' }] });
    const [out] = applyReceipts([t], [doc({ id: 'dai', issuer: 'X' })]);
    expect(out).toMatchObject({ aiHint: 'h', aiReason: 'r', aiAt: 1, aiSuggestion: { x: 1 }, receiptDocId: 'dai' });
    expect(out.checks).toEqual([{ kind: 'receipt', refId: 'dai', reason: expect.stringMatching(/Betrag und Datum/), aiHint: 'passt' }]);
  });
});

// ---------------------------------------------------------------- Unsicherheit
describe('Belege: Score und Abstand', () => {
  it('nur Betrag+Datum, eindeutig → Link + Prüfpunkt; mehrdeutig → nur Vorschlag ohne Link', () => {
    const [one] = applyReceipts([tx({ id: 'w1' })], [doc({ id: 'dw1', issuer: 'X' })]);
    expect(one).toMatchObject({ receiptDocId: 'dw1', checks: [{ kind: 'receipt', refId: 'dw1' }] });
    const many = applyReceipts([tx({ id: 'w2' }), tx({ id: 'w3', bookingDate: '2026-04-12' })], [doc({ id: 'dw2', issuer: 'Irgendwas' })]);
    expect(many.every(t => !t.receiptDocId)).toBe(true);
    const sug = many.filter(t => t.checks?.length);
    expect(sug).toHaveLength(1);
    expect(sug[0].id).toBe('w2'); // näher am Belegdatum
    expect(sug[0].checks[0]).toMatchObject({ kind: 'receipt', refId: 'dw2', reason: expect.stringMatching(/Möglicher Beleg/) });
  });
  it('knapper Abstand zum Zweitbesten → Prüfpunkt; deutlicher Abstand → still', () => {
    const d = doc({ id: 'dk' });
    const close = planReceipts([d], [tx({ id: 'k1', counterparty: 'REWE' }), tx({ id: 'k2', counterparty: 'REWE', bookingDate: '2026-04-11' })]).links;
    expect(close).toMatchObject([{ txId: 'k1', level: 'check' }]);
    expect(close[0].margin).toBeLessThan(15);
    const clear = planReceipts([d], [tx({ id: 'k3', counterparty: 'REWE' }), tx({ id: 'k4', counterparty: 'Fremd', bookingDate: '2026-04-11' })]).links;
    expect(clear).toMatchObject([{ txId: 'k3', level: 'sure' }]);
  });
  it('globale Konfliktlösung: zwei Belege konkurrieren um eine Buchung – beide finden ihren Platz', () => {
    const d1 = doc({ id: 'g1', issuer: 'Hornbach', date: '2026-04-10', amount: 4999 });
    const d2 = doc({ id: 'g2', issuer: 'Hornbach', date: '2026-04-01', amount: 4999 });
    const t1 = tx({ id: 'gt1', counterparty: 'Hornbach', bookingDate: '2026-04-10', amount: -4999 });
    const t2 = tx({ id: 'gt2', counterparty: 'Hornbach', bookingDate: '2026-04-14', amount: -4999 });
    const links = matchReceipts([d1, d2], [t1, t2]);
    expect(Object.fromEntries(links.map(l => [l.docId, l.txId]))).toEqual({ g1: 'gt2', g2: 'gt1' });
    expect(links.every(l => l.level === 'check')).toBe(true); // Konflikt → prüfen lassen
  });
});

// ---------------------------------------------------------------- Zahlungskette & Referenzen
describe('Belege: Zahlungskette und Referenzen', () => {
  it('PayPal: Beleg hängt an der PayPal-Zeile, nicht am Bankeinzug', () => {
    const d = doc({ id: 'pp', type: 'rechnung', issuer: 'Thalia Bücher GmbH', amount: 2399 });
    const ppRow = tx({ id: 'ppRow', accountId: 'paypal', counterparty: 'Thalia', amount: -2399, bookingDate: '2026-04-11' });
    const bank = tx({ id: 'bank', counterparty: 'PayPal', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', amount: -2399, bookingDate: '2026-04-12' });
    expect(matchReceipts([d], [bank, ppRow])).toMatchObject([{ txId: 'ppRow' }]);
    expect(matchReceipts([d], [{ ...bank, isTransfer: true }, ppRow])).toMatchObject([{ txId: 'ppRow' }]);
  });
  it('Amazon-Bestellnummer aus dem Belegtext verbindet auch spät gebuchte Zahlungen', () => {
    const d = doc({ id: 'amz', type: 'rechnung', issuer: 'Amazon EU S.à r.l.', amount: 3498, date: '2026-03-01', text: 'Rechnung\nBestellnr. 302-1234567-7654321\nSumme 34,98 €' });
    expect(docRefs(d).strong).toContain('302 1234567 7654321');
    const t = tx({ id: 'amzT', counterparty: 'AMAZON PAYMENTS', purpose: '302-1234567-7654321 Amazon.de 2QW3ER', amount: -3498, bookingDate: '2026-03-25' });
    expect(matchReceipts([d], [t])).toMatchObject([{ txId: 'amzT', level: 'sure' }]);
    // Nummer darf nicht als Teil einer längeren Zahl treffen
    expect(matchReceipts([d], [{ ...t, purpose: '302-1234567-76543219' }])).toHaveLength(0);
  });
  it('Bestell-Nr. aus Feldern, Transaktionscode gegen End-to-End-ID, Kundennummer als Namensersatz', () => {
    const d = doc({ id: 'ord', type: 'rechnung', issuer: 'Shop', amount: 5000, date: '2026-02-01', fields: { orderNumber: 'B-778899' } });
    expect(matchReceipts([d], [tx({ purpose: 'Bestellung B-778899', amount: -5000, bookingDate: '2026-03-10' })])).toHaveLength(1);
    const p = doc({ id: 'tc', type: 'rechnung', issuer: 'Händler', amount: 1500, date: '2026-01-01', text: 'Transaktionscode: 9AB12345CD678901E' });
    expect(matchReceipts([p], [tx({ endToEndId: '9AB12345CD678901E', amount: -1500, bookingDate: '2026-02-15' })])).toHaveLength(1);
    const k = doc({ id: 'kn', type: 'rechnung', issuer: 'Stadtwerke', amount: 8000, text: 'Kundennummer: 4711-0815' });
    const [l] = planReceipts([k], [tx({ purpose: 'KD 4711-0815 Abschlag', counterparty: 'SW Nord', amount: -8000 }), tx({ amount: -8000, bookingDate: '2026-04-11' })]).links;
    expect(l.level).toBe('sure');
  });
});

// ---------------------------------------------------------------- n:1 und 1:n
describe('Belege: Sammelbuchung und Teilzahlung', () => {
  it('n:1: mehrere Belege desselben Händlers ergeben die Buchung → receiptDocIds + Prüfpunkt', () => {
    const docs = [doc({ id: 's1', issuer: 'Amazon', amount: 1999, date: '2026-04-08' }), doc({ id: 's2', issuer: 'Amazon', amount: 2500, date: '2026-04-09' }), doc({ id: 's3', issuer: 'Amazon', amount: 1001, date: '2026-04-09' }), doc({ id: 's4', issuer: 'Amazon', amount: 700, date: '2026-04-09' })];
    const t = tx({ id: 'st', counterparty: 'Amazon', amount: -5500, bookingDate: '2026-04-11' });
    const [out] = applyReceipts([t], docs);
    expect(out.receiptDocIds.sort()).toEqual(['s1', 's2', 's3']);
    expect(out.receiptDocId).toBe(out.receiptDocIds[0]);
    expect(out.checks[0]).toMatchObject({ kind: 'receipt', reason: expect.stringMatching(/Sammelbuchung: 3 Belege/) });
    // fremder Händler zählt nicht, mehrdeutige Kombinationen → nichts
    expect(applyReceipts([t], docs.map(d => ({ ...d, issuer: 'Anderer' })))[0].receiptDocId).toBeFalsy();
    const amb = [doc({ issuer: 'Amazon', amount: 300 }), doc({ issuer: 'Amazon', amount: 200 }), doc({ issuer: 'Amazon', amount: 100 }), doc({ issuer: 'Amazon', amount: 400 })];
    expect(applyReceipts([tx({ counterparty: 'Amazon', amount: -500 })], amb)[0].receiptDocId).toBeFalsy();
  });
  it('1:n: dieselbe Rechnungsnummer in mehreren Buchungen, Summe passt → alle verknüpft, zur Prüfung', () => {
    const d = doc({ id: 'inv', type: 'rechnung', issuer: 'Zahnarzt Dr. Weiß', amount: 120000, date: '2026-01-15', fields: { invoiceNumber: 'R-2026-0042' } });
    const a = tx({ id: 'ra', purpose: 'R-2026-0042 Rate 1', amount: -60000, bookingDate: '2026-02-01' });
    const b = tx({ id: 'rb', purpose: 'R-2026-0042 Rate 2', amount: -60000, bookingDate: '2026-03-01' });
    const out = applyReceipts([a, b], [d]);
    expect(out.map(t => t.receiptDocId)).toEqual(['inv', 'inv']);
    expect(out[1].checks[0].reason).toMatch(/Teilzahlung 2 von 2/);
    // Summe passt nicht → nichts
    expect(applyReceipts([a], [d])[0].receiptDocId).toBeFalsy();
  });
});

// ---------------------------------------------------------------- Aufteilung
describe('Belege: Aufteilungs-Vorschlag aus Positionen', () => {
  const items = (docId, list) => list.map(([text, total], i) => ({ id: `${docId}_${i}`, documentId: docId, text, qty: 1, unitPrice: total, total }));
  it('Lebensmittel + Drogerie, Summe exakt → splitSuggestion + Prüfpunkt, splits bleiben leer', () => {
    const d = doc({ id: 'sp', amount: 1500 });
    const t = tx({ id: 'spt', counterparty: 'REWE', amount: -1500, category: 'lebensmittel', subcategory: 'supermarkt' });
    const li = items('sp', [['BIO VOLLMILCH 3,8%', 300], ['Pfand', 25], ['Vollkornbrot', 475], ['Zahnpasta Sensitiv', 400], ['Shampoo', 300]]);
    const [out] = applyReceipts([t], [d], li);
    expect(out.splitSuggestion).toEqual([
      { amount: -800, category: 'lebensmittel', subcategory: 'supermarkt' },
      { amount: -700, category: 'lebensmittel', subcategory: 'drogerie' },
    ]);
    expect(out.checks).toEqual([{ kind: 'split', reason: expect.stringMatching(/2 Kategorien/), refId: 'sp' }]);
    expect(out.splits).toBeUndefined();
  });
  it('kein Vorschlag: Summe weicht ab, nur eine Gruppe, bereits aufgeteilt', () => {
    const t = tx({ amount: -1000, category: 'lebensmittel', subcategory: 'supermarkt' });
    expect(suggestSplit(t, items('x', [['Milch', 500], ['Shampoo', 499]]))).toBeNull();
    expect(suggestSplit(t, items('x', [['Milch', 500], ['Brot', 500]]))).toBeNull();
    expect(suggestSplit({ ...t, splits: [{ amount: -1000 }] }, items('x', [['Milch', 500], ['Shampoo', 500]]))).toBeNull();
    expect(suggestSplit(t, items('x', [['Milch', 500], ['Shampoo', 500]]))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- Verträge
describe('Verträge: Zusammenführen und Vertragsdokumente', () => {
  const series = (n, o, start = '2026-01-05') => Array.from({ length: n }, (_, i) => {
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return tx({ ...o, bookingDate: d.toISOString().slice(0, 10) });
  });
  it('mergeContracts: Fallback wählt den nächstliegenden Betrag statt des ersten Treffers', () => {
    const detected = [{ id: 'n1', provider: 'Amazon', accountId: 'a', interval: 'monthly', amount: -899 }, { id: 'n2', provider: 'Amazon', accountId: 'a', interval: 'monthly', amount: -1299 }];
    const old = [{ id: 'oBig', provider: 'Amazon', accountId: 'a', interval: 'monthly', amount: -1299, note: 'Musik' }, { id: 'oSmall', provider: 'Amazon', accountId: 'a', interval: 'monthly', amount: -899, note: 'Prime' }];
    const out = mergeContracts(detected, old);
    expect(out.map(c => [c.id, c.note])).toEqual([['oSmall', 'Prime'], ['oBig', 'Musik']]);
  });
  it('mergeContracts übernimmt ID und vom Nutzer gesetzte Art (früher im toten Lookup von detectRecurring)', () => {
    const t = series(6, { counterparty: 'Netflix', amount: -1399, category: 'abos_medien', subcategory: 'streaming' });
    const first = detectRecurring(t)[0];
    const [kept] = mergeContracts(detectRecurring(t), [{ ...first, id: 'ct_alt', kind: 'sonstiges', kindUser: true }]);
    expect(kept).toMatchObject({ id: 'ct_alt', kind: 'sonstiges' });
  });
  it('Vertragsnummer im Verwendungszweck verbindet Dokument und Serie; Kündigungsfrist/Beginn werden übernommen', () => {
    const t = series(4, { counterparty: 'Fitness First', purpose: 'Mitgliedsbeitrag Vertrag 88-1234', amount: -2990, category: 'abos_medien', subcategory: 'fitness' });
    const contracts = detectRecurring(t);
    const vd = { id: 'vd1', type: 'vertrag', date: '2025-12-01', issuer: 'FitX', fields: { provider: 'FitX', price: 3990, interval: 'monthly', contractNumber: '88-1234', cancellationPeriod: '3 Monate', startDate: '2025-12-01', term: '12 Monate' } };
    const [c] = linkContractDocs(contracts, [vd], t);
    expect(c).toMatchObject({ docId: 'vd1', docIds: ['vd1'], docMatch: 'nummer', contractNumber: '88-1234', cancellationPeriod: '3 Monate', startDate: '2025-12-01', term: '12 Monate' });
    expect(c.noPayments).toBeUndefined();
  });
  it('sonst Anbieter + Betrag (±2 %) + Rhythmus; ohne Treffer → Vertrag mit noPayments (zählt nicht in Fixkosten)', () => {
    const t = series(4, { counterparty: 'Spotify', amount: -1199, category: 'abos_medien', subcategory: 'musik' });
    const contracts = detectRecurring(t);
    const ok = { id: 'vs', type: 'vertrag', date: '2025-11-01', issuer: 'Spotify AB', fields: { provider: 'Spotify AB', price: 1190, interval: 'monthly', cancellationPeriod: 'jederzeit kündbar' } };
    const off = { id: 'vo', type: 'vertrag', date: '2025-11-01', issuer: 'Spotify AB', fields: { provider: 'Spotify AB', price: 1799, interval: 'monthly' } };
    const yearly = { id: 'vy', type: 'vertrag', date: '2025-11-01', issuer: 'Spotify AB', fields: { provider: 'Spotify AB', price: 1199, interval: 'yearly' } };
    expect(linkContractDocs(contracts, [ok], t)[0]).toMatchObject({ docId: 'vs', docMatch: 'anbieter', cancellationPeriod: 'jederzeit kündbar' });
    const out = linkContractDocs(contracts, [off, yearly], t);
    expect(out[0].docId).toBeUndefined();
    expect(out).toHaveLength(3);
    const np = out.find(c => c.id === 'ctd_vo');
    expect(np).toMatchObject({ source: 'doc', noPayments: true, active: false, provider: 'Spotify AB', amount: -1799, interval: 'monthly', monthly: 1799, yearlyCost: 21588, txIds: [], docId: 'vo' });
  });
  it('Dokument-Vertrag behält Notiz/ausgeblendet/Art aus dem Vorlauf; mergeContracts lässt ihn außen vor', () => {
    const vd = { id: 'v9', type: 'vertrag', date: '2026-01-01', issuer: 'Hanse Versicherung', fields: { provider: 'Hanse Versicherung', price: 4500, interval: 'yearly' } };
    const prev = [{ id: 'ctd_v9', source: 'doc', provider: 'Hanse Versicherung', note: 'Hausrat', hidden: true, kind: 'versicherung', kindUser: true, interval: 'yearly' }];
    const [c] = linkContractDocs([], [vd], [], prev);
    expect(c).toMatchObject({ id: 'ctd_v9', note: 'Hausrat', hidden: true, kind: 'versicherung', yearlyCost: 4500, monthly: 375 });
    expect(mergeContracts([{ id: 'x', provider: 'Hanse Versicherung', accountId: undefined, interval: 'yearly' }], prev)[0].id).toBe('x');
  });
});
