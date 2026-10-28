// Prüfung der KI-Antworten (ai/validate.js): nichts Erfundenes übernehmen
import { describe, it, expect } from 'vitest';
import {
  moneyValuesInText, amountInText, validDate, validVatRate, validateVat, validateFields, validateLineItems,
  validateCategory, categoryPatch, validateDocType, taxPatch, receiptHint, confidenceLevel, aiReasonText,
} from '../src/lib/ai/validate.js';
import { isLocalUrl, Ollama } from '../src/lib/ai/ollama.js';
import { flagTaxDocument, flagTaxTransaction } from '../src/lib/classify/taxFlags.js';

describe('Beträge im Text', () => {
  const text = 'Rechnung 2026-01-15\nPos 1  Kabel 2 100,00\nNetto 1.234,56 EUR\nTotal 1,099.90\nTrinkgeld 5,-\nSumme 12.5';
  it('erkennt deutsche, englische und Kurzschreibweisen', () => {
    const v = moneyValuesInText(text);
    for (const c of [123456, 109990, 500, 1250, 10000, 200]) expect(v.has(c)).toBe(true);
  });
  it('Betrag nur, wenn er im Text steht (Vorzeichen egal)', () => {
    expect(amountInText(123456, text)).toBe(true);
    expect(amountInText(-123456, text)).toBe(true);
    expect(amountInText(123457, text)).toBe(false);
    expect(amountInText(null, text)).toBe(false);
  });
});

describe('Datum per Round-Trip', () => {
  it.each([['2026-01-15', true], ['2024-02-29', true], ['2025-02-29', false], ['2026-13-01', false], ['2026-04-31', false], ['15.01.2026', false], ['1899-01-01', false], ['2099-01-01', false], [null, false]])('%s → %s', (s, ok) => {
    expect(validDate(s, { now: new Date('2026-10-28') })).toBe(ok);
  });
});

describe('MwSt', () => {
  it('nur 0/7/19', () => {
    expect([0, 7, 19, '19'].every(validVatRate)).toBe(true);
    expect([16, 5, 20, null, ''].some(validVatRate)).toBe(false);
  });
  it('Steuerbetrag muss im Text stehen', () => {
    const vat = validateVat([{ satz: 19, betrag: 1.9 }, { satz: 16, betrag: 1.6 }, { satz: 7, betrag: 0.77 }], 'MwSt 19 % 1,90');
    expect(vat).toEqual([{ rate: 19, tax: 190, net: null, gross: null }]);
  });
});

describe('Dokumentfelder', () => {
  const text = 'Malermeister Kunz GmbH\nRechnung vom 03.02.2026\nGesamtbetrag 119,00 EUR\nMwSt 19 % 19,00';
  it('ergänzt nur Fehlendes und nur Belegbares', () => {
    const p = validateFields({ datum: '2026-02-03', aussteller: 'Malermeister Kunz GmbH', gesamtbetrag: 119, mwst: [{ satz: 19, betrag: 19 }] }, { text }, text);
    expect(p).toEqual({ date: '2026-02-03', issuer: 'Malermeister Kunz GmbH', amount: 11900, vat: [{ rate: 19, tax: 1900, net: null, gross: null }] });
  });
  it('überschreibt nichts und erfindet nichts', () => {
    const doc = { text, date: '2026-02-01', issuer: 'Kunz', amount: 100 };
    expect(validateFields({ datum: '2026-02-03', aussteller: 'Anderer', gesamtbetrag: 119 }, doc, text)).toEqual({});
    const p = validateFields({ datum: '2026-02-30', aussteller: 'Erfunden AG', gesamtbetrag: 120, mwst: [{ satz: 16, betrag: 19 }] }, { text }, text);
    expect(p).toEqual({});
  });
  it('kaputte Antwort → leerer Patch', () => {
    expect(validateFields(null, {}, text)).toEqual({});
    expect(validateFields('quatsch', {}, text)).toEqual({});
  });
});

describe('Positionen', () => {
  const pos = [{ text: 'Milch', preis: 1.29, mwst_satz: 7 }, { text: 'Brot', preis: 2.5, mwst_satz: 5 }];
  it('Summe passt (±2 ct) → übernehmen, unbekannter Satz → null', () => {
    const v = validateLineItems(pos, { total: 380 });
    expect(v.items).toHaveLength(2);
    expect(v.items[1]).toMatchObject({ text: 'Brot', total: 250, vatRate: null });
    expect(validateLineItems(pos, { total: 381 })).not.toBeNull();
  });
  it('Summe passt nicht → null (vorhandene Positionen bleiben)', () => {
    expect(validateLineItems(pos, { total: 400 })).toBeNull();
  });
  it('ohne bekannte Summe nur, wenn die KI-Summe im Text steht', () => {
    expect(validateLineItems(pos, { aiTotal: 3.79, text: 'SUMME EUR 3,79' })).toMatchObject({ total: 379 });
    expect(validateLineItems(pos, { aiTotal: 3.79, text: 'SUMME EUR 9,99' })).toBeNull();
    expect(validateLineItems(pos, {})).toBeNull();
  });
  it('eine kaputte Position verwirft die ganze Antwort', () => {
    expect(validateLineItems([...pos, { text: '', preis: 1 }], { total: 479 })).toBeNull();
    expect(validateLineItems('viele', { total: 1 })).toBeNull();
  });
});

describe('Kategorien', () => {
  it('nie Umbuchung', () => {
    expect(validateCategory('umbuchung', { amount: -100 })).toBeNull();
    expect(validateCategory('umbuchung.eigene_konten', { amount: 100 })).toBeNull();
  });
  it('Einkommen nur bei Betrag > 0', () => {
    expect(validateCategory('einkommen.gehalt', { amount: 250000 })).toEqual({ category: 'einkommen', subcategory: 'gehalt' });
    expect(validateCategory('einkommen.gehalt', { amount: -250000 })).toBeNull();
  });
  it('Ausgabe nur bei Betrag < 0, Erstattung darf positiv sein', () => {
    expect(validateCategory('lebensmittel', { amount: -500 })).not.toBeNull();
    expect(validateCategory('lebensmittel', { amount: 500, purpose: 'Einkauf' })).toBeNull();
    expect(validateCategory('shopping.online', { amount: 2999, purpose: 'Erstattung Retoure 123' })).not.toBeNull();
    expect(validateCategory('gesundheit', { amount: 4000, bookingText: 'Gutschrift' })).not.toBeNull();
  });
  it('Sparen und Bargeld in beide Richtungen', () => {
    expect(validateCategory('vorsorge_sparen.tagesgeld', { amount: 10000 })).not.toBeNull();
    expect(validateCategory('bargeld.einzahlung', { amount: 5000 })).not.toBeNull();
  });
  it('Sicherheitsstufen: hoch still, mittel Prüfliste, niedrig nur Vorschlag', () => {
    const tx = { amount: -500 };
    expect(categoryPatch({ kategorie: 'lebensmittel', sicherheit: 0.9, begruendung: 'Supermarkt' }, tx)).toMatchObject({ category: 'lebensmittel', categorySource: 'ai', needsReview: false, confidence: 0.85, aiReason: 'KI (90 %): Supermarkt' });
    expect(categoryPatch({ kategorie: 'lebensmittel', sicherheit: 0.65 }, tx)).toMatchObject({ categorySource: 'ai', needsReview: true, aiReason: 'KI (65 %): Lebensmittel' });
    const low = categoryPatch({ kategorie: 'lebensmittel', sicherheit: 0.3 }, tx);
    expect(low.category).toBeUndefined();
    expect(low.aiSuggestion).toMatchObject({ category: 'lebensmittel', confidence: 0.3 });
    expect(categoryPatch({ kategorie: 'lebensmittel', sicherheit: 'hoch' }, tx)).toBeNull();
    expect(categoryPatch({ kategorie: 'einkommen', sicherheit: 0.99 }, tx)).toBeNull();
  });
});

describe('Dokumenttyp, Steuer, Belegabgleich', () => {
  it('Typ nur aus der Liste und mindestens mittel sicher; irrelevant nur hoch', () => {
    expect(validateDocType({ typ: 'rechnung', sicherheit: 0.7 })).toMatchObject({ type: 'rechnung', level: 'medium' });
    expect(validateDocType({ typ: 'rechnung', sicherheit: 0.5 })).toBeNull();
    expect(validateDocType({ typ: 'erfunden', sicherheit: 0.99 })).toBeNull();
    expect(validateDocType({ typ: 'rechnung', sicherheit: 0.9 }, { current: 'rechnung' })).toBeNull();
    expect(validateDocType({ typ: 'irrelevant', sicherheit: 0.7 })).toBeNull();
    expect(validateDocType({ typ: 'kontoauszug', sicherheit: 0.95 }, { allow: ['rechnung'] })).toBeNull();
  });
  it('Steuer-Flag erst ab 0,6; mittel → Prüfliste; darunter nur Hinweis', () => {
    expect(taxPatch({ relevant: true, grund: 'gesundheit', sicherheit: 0.9 })).toMatchObject({ taxRelevant: true, taxSource: 'ai' });
    expect(taxPatch({ relevant: true, grund: 'gesundheit', sicherheit: 0.9 }).needsReview).toBeUndefined();
    expect(taxPatch({ relevant: true, grund: 'gesundheit', sicherheit: 0.7 })).toMatchObject({ taxRelevant: true, needsReview: true });
    const low = taxPatch({ relevant: true, grund: 'gesundheit', sicherheit: 0.4 });
    expect(low.taxRelevant).toBeUndefined();
    expect(low.needsReview).toBe(true);
    expect(taxPatch({ relevant: true, grund: 'erfunden', sicherheit: 0.9 })).toBeNull();
    expect(taxPatch({ relevant: false, grund: 'gesundheit', sicherheit: 0.9 })).toBeNull();
  });
  it('Belegabgleich ergibt nur einen Hinweis', () => {
    const h = receiptHint({ passt: true, sicherheit: 0.8, begruendung: 'Händler und Betrag gleich' }, { docId: 'd1' });
    expect(h).toMatchObject({ kind: 'receipt', docId: 'd1', match: true, confidence: 0.8, reason: 'KI (80 %): Händler und Betrag gleich' });
    expect(h.receiptSource).toBeUndefined();
    expect(receiptHint({ passt: 'ja', sicherheit: 0.8 })).toBeNull();
  });
  it('Hilfsfunktionen', () => {
    expect(confidenceLevel(0.8)).toBe('high');
    expect(confidenceLevel('0.6')).toBe('medium');
    expect(confidenceLevel(null)).toBeNull();
    expect(aiReasonText(0.5, '  sehr\nlang  ')).toBe('KI (50 %): sehr lang');
  });
});

describe('Nur lokale Ollama-Adressen', () => {
  it.each([['http://localhost:11434', true], ['https://127.0.0.1:8443', true], ['http://[::1]:11434', true], ['http://LOCALHOST', true],
    ['http://192.168.1.10:11434', false], ['https://ollama.example.com', false], ['http://localhost.evil.com', false], ['http://user:pw@localhost', false], ['file:///etc/passwd', false], ['', false]])('%s → %s', (u, ok) => {
    expect(isLocalUrl(u)).toBe(ok);
  });
  it('fremde Adresse: kein fetch, klare Meldung', async () => {
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => ({}) }; };
    await expect(new Ollama('http://192.168.1.10:11434').version()).rejects.toThrow(/Nur lokale Ollama-Adressen/);
    expect(called).toBe(0);
  });
});

describe('KI-Steuerflags bleiben bis zur Nutzerentscheidung', () => {
  it('flagTax* überschreibt taxSource "ai" nicht', () => {
    expect(flagTaxDocument({ type: 'rechnung', text: 'Baumarkt', taxRelevant: true, taxReason: 'beruf', taxSource: 'ai' })).toEqual({ taxRelevant: true, taxReason: 'beruf' });
    expect(flagTaxTransaction({ amount: -100, category: 'lebensmittel', taxRelevant: true, taxReason: 'beruf', taxSource: 'ai' })).toEqual({ taxRelevant: true, taxReason: 'beruf' });
  });
});
