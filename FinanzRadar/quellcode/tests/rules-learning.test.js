// Regeln: Wortgrenzen, automatisches Lernen, Trefferzahl, Depot/Sparplan und Währungsumrechnung
import { describe, it, expect } from 'vitest';
import { classifyTransactions, containsWord, learnRuleFromCorrection, ruleHits, matchingRule, suggestRuleFromCorrection } from '../src/lib/classify/rules.js';

let n = 0;
const tx = (o) => ({ id: 'tx' + (++n), accountId: 'a1', bookingDate: '2026-03-01', amount: -1000, counterparty: '', counterpartyRaw: '', purpose: '', ...o });
const rule = (value, category, field = 'counterparty') => ({ id: 'r_' + value, match: { field, op: 'contains', value }, set: { category } });

describe('Regel-„enthält“ mit Wortgrenzen', () => {
  it('trifft nur am Wortanfang', () => {
    expect(containsWord('ing diba ag', 'ing')).toBe(true);
    expect(containsWord('rewemarkt', 'rewe')).toBe(true);
    expect(containsWord('shopping center', 'ing')).toBe(false);
    expect(containsWord('foo', '')).toBe(false);
  });
  it('„ING“ trifft „Shopping“ nicht mehr', () => {
    const r = [rule('ING', 'finanzen', 'any')];
    const [shop, ing] = classifyTransactions([tx({ counterparty: 'Shopping Mall' }), tx({ counterparty: 'ING-DiBa AG' })], { rules: r });
    expect(shop.categorySource).not.toBe('rule');
    expect(ing).toMatchObject({ categorySource: 'rule', category: 'finanzen', ruleId: 'r_ING' });
  });
  it('mehrere Wörter und Umlaute', () => {
    const r = [rule('Bäckerei Müller', 'lebensmittel')];
    expect(classifyTransactions([tx({ counterparty: 'BAECKEREI MUELLER GMBH' })], { rules: r })[0].categorySource).toBe('rule');
    expect(classifyTransactions([tx({ counterparty: 'Grossbaeckerei Mueller' })], { rules: r })[0].categorySource).not.toBe('rule');
  });
});

describe('Automatisches Lernen', () => {
  const user = (o) => tx({ categorySource: 'user', confidence: 1, ...o });
  it('erste Korrektur lernt nichts, zweite gleiche Korrektur erzeugt eine Regel', () => {
    const t1 = user({ counterparty: 'Hofladen Sonnenschein', category: 'lebensmittel' });
    const t2 = tx({ counterparty: 'Hofladen Sonnenschein', category: 'sonstiges' });
    expect(learnRuleFromCorrection(t1, 'lebensmittel', null, [t1], [])).toBeNull();
    const r = learnRuleFromCorrection(t2, 'lebensmittel', 'baeckerei', [t1, t2], []);
    expect(r).toMatchObject({ auto: true, match: { field: 'counterparty', op: 'contains', value: 'Hofladen Sonnenschein' }, set: { category: 'lebensmittel', subcategory: 'baeckerei' } });
  });
  it('andere Kategorie, andere Gegenpartei oder vorhandene Regel → keine neue Regel', () => {
    const t1 = user({ counterparty: 'Hofladen Sonnenschein', category: 'freizeit_reisen' });
    const t2 = tx({ counterparty: 'Hofladen Sonnenschein' });
    expect(learnRuleFromCorrection(t2, 'lebensmittel', null, [t1, t2], [])).toBeNull();
    const t3 = user({ counterparty: 'Anderer Laden', category: 'lebensmittel' });
    expect(learnRuleFromCorrection(t2, 'lebensmittel', null, [t3, t2], [])).toBeNull();
    const t4 = user({ counterparty: 'Hofladen Sonnenschein', category: 'lebensmittel' });
    expect(learnRuleFromCorrection(t2, 'lebensmittel', null, [t4, t2], [rule('Hofladen', 'lebensmittel')])).toBeNull();
    expect(learnRuleFromCorrection(t2, 'umbuchung', null, [t4, t2], [])).toBeNull();
    expect(learnRuleFromCorrection(t2, 'gibtsnicht', null, [t4, t2], [])).toBeNull();
  });
  it('Trefferzahl zählt nur Buchungen ohne Nutzerentscheidung', () => {
    const txs = [tx({ counterparty: 'Kiosk Eck' }), tx({ counterparty: 'Kiosk Eck 2' }), tx({ counterparty: 'Kiosk Eck', categorySource: 'user' }), tx({ counterparty: 'Megakiosk Eck' }), tx({ counterparty: 'Am Kiosk Eck' })];
    const r = suggestRuleFromCorrection(txs[0], 'lebensmittel.kiosk');
    expect(ruleHits(r, txs).map(t => t.counterparty)).toEqual(['Kiosk Eck', 'Kiosk Eck 2', 'Am Kiosk Eck']);
    expect(matchingRule(txs[1], [r])).toBe(r);
    expect(matchingRule(txs[1], [{ ...r, enabled: false }])).toBeNull();
  });
});

describe('Depot/Sparplan und Währungsumrechnung', () => {
  it('Wertpapierkauf über die Bank → Vorsorge & Sparen › Sparplan & Depot', () => {
    const [a, b] = classifyTransactions([
      tx({ counterparty: 'comdirect bank', purpose: 'Wertpapierkauf iShares Core MSCI World', amount: -15000 }),
      tx({ counterparty: 'ING', purpose: 'Sparplanausführung ETF', amount: -5000 }),
    ]);
    expect(a).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'sparplan_depot' });
    expect(b).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'sparplan_depot' });
  });
  it('Kauf im Depotkonto → Sparen; Bausparplan bleibt Bausparen', () => {
    const accounts = [{ id: 'dep', kind: 'depot' }];
    expect(classifyTransactions([tx({ accountId: 'dep', counterparty: 'Vanguard FTSE All-World', bookingText: 'Kauf', amount: -10000 })], { accounts })[0]).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'sparplan_depot' });
    expect(classifyTransactions([tx({ counterparty: 'LBS', purpose: 'Bausparplan Rate', amount: -5000 })])[0].subcategory).toBe('bausparen');
  });
  it('PayPal-Währungsumrechnung ist Finanzen, nicht die Händlerkategorie', () => {
    const t = classifyTransactions([tx({ counterparty: 'Netflix', counterpartyRaw: 'Netflix', bookingText: 'Währungsumrechnung', purpose: 'Allgemeine Währungsumrechnung', amount: -1299 })])[0];
    expect(t).toMatchObject({ category: 'finanzen', categorySource: 'keyword' });
  });
  it('mittel sicheres, unbestätigtes Paar behält seine Kategorie', () => {
    const t = classifyTransactions([tx({ counterparty: 'REWE', amount: -2000, isTransfer: true, transferConfidence: 'medium', transferSource: 'auto' })])[0];
    expect(t.category).toBe('lebensmittel');
    const u = classifyTransactions([tx({ counterparty: 'REWE', amount: -2000, isTransfer: true, transferConfidence: 'medium', transferSource: 'user' })])[0];
    expect(u.category).toBe('umbuchung');
  });
});
