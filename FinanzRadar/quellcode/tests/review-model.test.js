// Prüfliste: Kriterium, Sortierung nach Geldwirkung, Bestätigungs-Patches (beide Seiten), Sammelaktion, „Warum?“
import { describe, it, expect } from 'vitest';
import {
  isPendingTx, isPendingDoc, openChecks, reviewCount, txAspects, buildQueue, confirmPatches, rejectPatches, confirmAllPatches,
  mergePatches, prevFor, similarOpen, paymentChain, findTransferCounterpart, linkTransferPatches, categoryWhy, splitsFromSuggestion,
  isReceiptSuggestion, docReason,
} from '../src/lib/views/reviewModel.js';

const tx = (o) => ({ accountId: 'giro', bookingDate: '2026-03-01', amount: -1000, counterparty: 'X', ...o });
const byId = (...l) => new Map(l.map(t => [t.id, t]));
const patchOf = (list, id) => list.find(p => p.id === id)?.patch;

describe('Kriterium', () => {
  it('Kategorie unsicher oder offene checks', () => {
    expect(isPendingTx(tx({ id: 'a' }))).toBe(false);
    expect(isPendingTx(tx({ id: 'a', checks: [] }))).toBe(false);
    expect(isPendingTx(tx({ id: 'a', needsReview: true }))).toBe(true);
    expect(isPendingTx(tx({ id: 'a', needsReview: true, reviewed: true }))).toBe(false);
    expect(isPendingTx(tx({ id: 'a', reviewed: true, checks: [{ kind: 'receipt', reason: 'x' }] }))).toBe(true);
  });
  it('erledigte checks (checksAck) zählen nicht mehr', () => {
    const t = tx({ id: 'a', checks: [{ kind: 'storno', refId: 'b' }], checksAck: ['storno:b'] });
    expect(openChecks(t)).toEqual([]);
    expect(isPendingTx(t)).toBe(false);
  });
  it('Dokumente und Zähler', () => {
    expect(isPendingDoc({ needsReview: true, type: 'rechnung' })).toBe(true);
    expect(isPendingDoc({ needsReview: true, type: 'irrelevant' })).toBe(false);
    expect(reviewCount([tx({ id: 'a', needsReview: true }), tx({ id: 'b' })], [{ needsReview: true, type: 'kassenbon' }])).toBe(2);
    expect(docReason({ subtype: 'unlesbar' })).toMatch(/nicht lesbar/);
  });
  it('Aspekte mit Grund (reviewReason, aiReason, checks.reason)', () => {
    const a = txAspects(tx({ id: 'a', needsReview: true, categorySource: 'ai', aiReason: 'Tierbedarf', checks: [{ kind: 'transfer', reason: 'Gleicher Betrag auf Tagesgeld', refId: 'b' }] }));
    expect(a.map(x => x.kind)).toEqual(['category', 'transfer']);
    expect(a[0].reason).toBe('KI: Tierbedarf');
    expect(a[1]).toMatchObject({ reason: 'Gleicher Betrag auf Tagesgeld', refId: 'b' });
  });
});

describe('Sortierung nach Geldwirkung', () => {
  it('größter Betrag zuerst, Dokumente gemischt, Filter', () => {
    const transactions = [tx({ id: 's', amount: -500, needsReview: true }), tx({ id: 'b', amount: 90000, checks: [{ kind: 'transfer' }] }), tx({ id: 'n', amount: -99999 })];
    const documents = [{ id: 'd', amount: 2000, needsReview: true, type: 'rechnung' }];
    expect(buildQueue({ transactions, documents })).toEqual(['t:b', 'd:d', 't:s']);
    expect(buildQueue({ transactions, documents }, 'tx')).toEqual(['t:b', 't:s']);
    expect(buildQueue({ transactions, documents }, 'docs')).toEqual(['d:d']);
  });
  it('Gleichstand: unsicherste zuerst', () => {
    const transactions = [tx({ id: 'a', needsReview: true, confidence: 0.5 }), tx({ id: 'b', needsReview: true, confidence: 0.3 })];
    expect(buildQueue({ transactions })).toEqual(['t:b', 't:a']);
  });
});

describe('Bestätigungs-Patches', () => {
  it('Kategorie bestätigen ist immer Nutzerentscheidung', () => {
    const t = tx({ id: 'a', category: 'shopping', subcategory: 'online', needsReview: true, confidence: 0.5 });
    expect(patchOf(confirmPatches(t, { kind: 'category' }), 'a')).toEqual({ needsReview: false, reviewed: true, categorySource: 'user', confidence: 1, category: 'shopping', subcategory: 'online' });
    expect(patchOf(confirmPatches(t, { kind: 'category' }, { choice: { category: 'wohnen', subcategory: null } }), 'a')).toMatchObject({ category: 'wohnen', subcategory: null, categorySource: 'user' });
  });
  it('Umbuchung: beide Seiten bestätigen/ablehnen', () => {
    const a = tx({ id: 'a', isTransfer: true, transferPairId: 'b', checks: [{ kind: 'transfer', refId: 'b' }] });
    const b = tx({ id: 'b', accountId: 'tg', amount: 1000, isTransfer: true, transferPairId: 'a', checks: [{ kind: 'transfer', refId: 'a' }] });
    const ok = confirmPatches(a, { kind: 'transfer', refId: 'b' }, { txById: byId(a, b) });
    expect(ok).toHaveLength(2);
    expect(patchOf(ok, 'a')).toMatchObject({ transferSource: 'user', isTransfer: true, checksAck: ['transfer:b'] });
    expect(patchOf(ok, 'b')).toMatchObject({ transferSource: 'user', isTransfer: true, checksAck: ['transfer:a'] });
    const no = rejectPatches(a, { kind: 'transfer', refId: 'b' }, { txById: byId(a, b) });
    for (const id of ['a', 'b']) expect(patchOf(no, id)).toMatchObject({ transferSource: 'user', isTransfer: false, transferPairId: null, transferAccountId: null });
  });
  it('PayPal: Bankseite bestätigt per reviewed, PayPal-Zeile wird keine Umbuchung', () => {
    const bank = tx({ id: 'bank', isTransfer: true, transferPairId: 'pp', checks: [{ kind: 'paypal', refId: 'pp' }] });
    const pp = tx({ id: 'pp', accountId: 'paypal', counterparty: 'Shop' });
    const ok = confirmPatches(bank, { kind: 'paypal', refId: 'pp' }, { txById: byId(bank, pp) });
    expect(ok).toHaveLength(1);
    expect(patchOf(ok, 'bank')).toMatchObject({ transferSource: 'user', reviewed: true });
    const no = rejectPatches(bank, { kind: 'paypal', refId: 'pp' }, { txById: byId(bank, pp) });
    expect(no).toHaveLength(1);
    expect(patchOf(no, 'bank')).toMatchObject({ isTransfer: false, transferPairId: null });
  });
  it('Beleg: bestehende Verknüpfung bestätigen/lösen, Vorschlag verknüpfen/ablehnen', () => {
    const t = tx({ id: 'a', receiptDocId: 'd1', receiptRejected: ['d0'], checks: [{ kind: 'receipt', refId: 'd1' }] });
    expect(patchOf(confirmPatches(t, { kind: 'receipt', refId: 'd1' }), 'a')).toMatchObject({ receiptSource: 'user' });
    expect(patchOf(rejectPatches(t, { kind: 'receipt', refId: 'd1' }), 'a')).toMatchObject({ receiptDocId: null, receiptDocIds: [], receiptSource: 'user', receiptRejected: ['d0', 'd1'] });
    const s = tx({ id: 's', checks: [{ kind: 'receipt', refId: 'd9' }] });
    expect(isReceiptSuggestion(s, { refId: 'd9' })).toBe(true);
    expect(patchOf(confirmPatches(s, { kind: 'receipt', refId: 'd9' }), 's')).toMatchObject({ receiptDocId: 'd9', receiptDocIds: ['d9'], receiptSource: 'user' });
    const rj = patchOf(rejectPatches(s, { kind: 'receipt', refId: 'd9' }), 's');
    expect(rj).toMatchObject({ receiptSource: 'user', receiptRejected: ['d9'] });
    expect('receiptDocId' in rj).toBe(false);
  });
  it('Storno: beide Seiten; Lösen setzt stornoPairId null', () => {
    const a = tx({ id: 'a', checks: [{ kind: 'storno', refId: 'b' }] }), b = tx({ id: 'b', amount: 1000, checks: [{ kind: 'storno', refId: 'a' }] });
    expect(confirmPatches(a, { kind: 'storno', refId: 'b' }, { txById: byId(a, b) }).map(p => p.patch.stornoSource)).toEqual(['user', 'user']);
    expect(patchOf(rejectPatches(a, { kind: 'storno', refId: 'b' }, { txById: byId(a, b) }), 'b')).toMatchObject({ stornoSource: 'user', stornoPairId: null });
  });
  it('Aufteilung nur übernehmen, wenn die Summe passt', () => {
    const t = tx({ id: 'a', amount: -3000, splitSuggestion: [{ amount: -2000, category: 'lebensmittel' }, { amount: -1000, category: 'lebensmittel', subcategory: 'drogerie' }], checks: [{ kind: 'split' }] });
    expect(splitsFromSuggestion(t)).toEqual([{ amount: -2000, category: 'lebensmittel', subcategory: null }, { amount: -1000, category: 'lebensmittel', subcategory: 'drogerie' }]);
    expect(patchOf(confirmPatches(t, { kind: 'split' }), 'a')).toMatchObject({ categorySource: 'user', splits: splitsFromSuggestion(t) });
    const bad = { ...t, amount: -3100 };
    expect(patchOf(confirmPatches(bad, { kind: 'split' }), 'a').splits).toBeUndefined();
  });
  it('„Alles passt“ führt Kategorie und checks zusammen', () => {
    const t = tx({ id: 'a', needsReview: true, category: 'shopping', checks: [{ kind: 'receipt', refId: 'd' }, { kind: 'storno', refId: 'x' }], receiptDocId: 'd' });
    const all = confirmAllPatches(t);
    expect(all).toHaveLength(1);
    expect(all[0].patch).toMatchObject({ categorySource: 'user', receiptSource: 'user', stornoSource: 'user' });
    expect(all[0].patch.checksAck.sort()).toEqual(['receipt:d', 'storno:x']);
    expect(isPendingTx({ ...t, ...all[0].patch })).toBe(false);
  });
  it('mergePatches und prevFor', () => {
    expect(mergePatches([{ id: 'a', patch: { x: 1, checksAck: ['p'] } }, { id: 'a', patch: { y: 2, checksAck: ['q'] } }])).toEqual([{ id: 'a', patch: { x: 1, y: 2, checksAck: ['p', 'q'] } }]);
    expect(prevFor({ x: 1, arr: [1] }, { x: 2, arr: [], z: 3 })).toEqual({ x: 1, arr: [1], z: null });
  });
});

describe('Sammelaktion und „Warum?“', () => {
  it('ähnliche: gleiche Gegenpartei und gleiche Art', () => {
    const cur = tx({ id: 'a', counterparty: 'Café Mond', needsReview: true });
    const list = [cur, tx({ id: 'b', counterparty: 'CAFE MOND', needsReview: true }), tx({ id: 'c', counterparty: 'Café Mond', checks: [{ kind: 'receipt' }] }), tx({ id: 'd', counterparty: 'Anders', needsReview: true })];
    expect(similarOpen(cur, 'category', list).map(s => s.tx.id)).toEqual(['b']);
    expect(similarOpen(cur, 'receipt', list).map(s => s.tx.id)).toEqual(['c']);
  });
  it('Gegenbuchung für einseitige Umbuchung (±5 Tage, anderes Konto, nächstes Datum)', () => {
    const t = tx({ id: 'a', amount: -50000, bookingDate: '2026-03-10' });
    const list = [t, tx({ id: 'far', accountId: 'tg', amount: 50000, bookingDate: '2026-03-20' }), tx({ id: 'same', amount: 50000, bookingDate: '2026-03-10' }),
      tx({ id: 'ok2', accountId: 'tg', amount: 50000, bookingDate: '2026-03-13' }), tx({ id: 'ok1', accountId: 'tg', amount: 50000, bookingDate: '2026-03-11' })];
    expect(findTransferCounterpart(t, list)?.id).toBe('ok1');
    const both = linkTransferPatches(t, list[4]);
    expect(patchOf(both, 'a')).toMatchObject({ isTransfer: true, transferSource: 'user', transferPairId: 'ok1', transferAccountId: 'tg', category: 'umbuchung' });
    expect(patchOf(both, 'ok1')).toMatchObject({ transferPairId: 'a', transferAccountId: 'giro' });
  });
  it('Zahlungskette Beleg → PayPal → Bank (auch über Rückverweis)', () => {
    const pp = tx({ id: 'pp', accountId: 'paypal', receiptDocId: 'doc' });
    const bank = tx({ id: 'bank', transferPairId: 'pp' });
    const ctx = { txById: byId(pp, bank), accountById: new Map([['paypal', { kind: 'paypal' }], ['giro', { kind: 'giro' }]]), docById: new Map([['doc', { id: 'doc' }]]) };
    expect(paymentChain(bank, ctx).map(c => c.kind)).toEqual(['doc', 'paypal', 'bank']);
    expect(paymentChain(pp, ctx).map(c => c.id)).toEqual(['doc', 'pp', 'bank']);
    expect(paymentChain(tx({ id: 'solo' }), ctx)).toEqual([]);
  });
  it('Kategorie-Herkunft in einem Satz', () => {
    expect(categoryWhy({ categorySource: 'rule', ruleId: 'r' }, [{ id: 'r', match: { value: 'Rewe' } }])).toBe('Deine Regel „Rewe“.');
    expect(categoryWhy({ categorySource: 'merchant', merchant: 'REWE' })).toBe('Händlerliste: REWE.');
    expect(categoryWhy({ categorySource: 'ai', aiReason: 'Futter' })).toBe('KI: Futter');
    expect(categoryWhy({ categorySource: 'user' })).toBe('Von dir festgelegt.');
  });
});
