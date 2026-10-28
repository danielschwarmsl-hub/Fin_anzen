import { describe, it, expect } from 'vitest';
import { isGenericCounterparty } from '../src/lib/classify/normalize.js';
import { suggestRuleFromCorrection, classifyTransactions } from '../src/lib/classify/rules.js';
import { similarOpen } from '../src/lib/views/reviewModel.js';

const tx = (o) => ({ id: Math.random().toString(36).slice(2), accountId: 'a', bookingDate: '2025-04-02', amount: -5000, needsReview: true, ...o });

describe('Sammelaktionen und Regeln nur für echte Händler', () => {
  it('Zahlungsdienste/Kartenarten gelten als generisch, Händler nicht', () => {
    for (const n of ['PayPal', 'PayPal Europe', 'Klarna', 'VISA', 'Amazon', 'Kartenzahlung', 'Eigenes Konto']) expect(isGenericCounterparty(n)).toBe(true);
    for (const n of ['ABC Shop', 'REWE Markt', 'Audible', 'Hausverwaltung Elbblick']) expect(isGenericCounterparty(n)).toBe(false);
  });
  it('„PayPal“ ohne erkannten Shop: keine ähnlichen, keine Regel', () => {
    const a = tx({ counterparty: 'PayPal', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: 'PP.1171.PP Ihr Einkauf bei', creditorId: 'LU96ZZZ0000000000000000058' });
    const b = tx({ counterparty: 'PayPal', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: 'PP.2222.PP' });
    expect(similarOpen(a, 'category', [a, b])).toEqual([]);
    expect(suggestRuleFromCorrection(a, 'shopping.online')).toBeNull();
  });
  it('echter Händler: ähnliche und Regel wie bisher', () => {
    const a = tx({ counterparty: 'ABC Shop', counterpartyRaw: 'ABC Shop' }), b = tx({ counterparty: 'ABC Shop', counterpartyRaw: 'ABC Shop' });
    expect(similarOpen(a, 'category', [a, b])).toHaveLength(1);
    expect(suggestRuleFromCorrection(a, 'shopping.online').match).toMatchObject({ field: 'counterparty', value: 'ABC Shop' });
  });
});

describe('Reiseziel + Unterkunft/Flug im Text = Reise', () => {
  const cls = (o) => classifyTransactions([tx({ categorySource: null, ...o })], { rules: [], accounts: [] })[0];
  it('„Teneriffa April 2024 Wohnung booking“ → Unterkunft & Hotel, auch als Überweisung an eine Person', () => {
    expect(cls({ counterparty: 'Maria Lopez', counterpartyRaw: 'Maria Lopez', purpose: 'Teneriffa April 2024 Wohnung booking' }))
      .toMatchObject({ category: 'freizeit_reisen', subcategory: 'hotel' });
  });
  it('„Miete Ferienwohnung Mallorca“ ist Urlaub, nicht Miete', () => {
    expect(cls({ counterparty: 'Juan Perez', purpose: 'Miete Ferienwohnung Mallorca Juli' }).category).toBe('freizeit_reisen');
  });
  it('„Flug Bangkok“ → Flüge', () => {
    expect(cls({ counterparty: 'Max Muster', purpose: 'Anteil Flug Bangkok Maerz' })).toMatchObject({ category: 'freizeit_reisen', subcategory: 'fluege' });
  });
  it('Reiseziel allein (Restaurant Mykonos in Hamburg) bleibt keine Reise', () => {
    expect(cls({ counterparty: 'Restaurant Mykonos', purpose: 'Kartenzahlung' }).category).not.toBe('freizeit_reisen');
  });
});
