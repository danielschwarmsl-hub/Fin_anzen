import { describe, it, expect } from 'vitest';
import { detectType } from '../src/lib/detect/index.js';
import { parseStatement } from '../src/lib/parsers/docs/_statements.js';

// Synthetischer DKB-Kontoauszug: viele Seiten, Spalten „Datum | Erläuterung | Betrag EUR“, Gehalts- und
// Sozialversicherungs-Buchungen im Text (Stichwörter, die sonst nach Lohnabrechnung aussehen).
const mkLine = (y, parts) => {
  const items = parts.map(([x, str]) => ({ x, w: str.length * 5, str }));
  return { y, text: parts.map((p) => p[1]).join('   '), items };
};
const fmt = (c) => {
  const s = (Math.abs(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (c < 0 ? '-' : '') + s;
};

const BOOKINGS = [
  ['Lastschrift', 'Stadtwerke Musterstadt', 'Abschlag Strom Gas', -8500],
  ['Gutschrift', 'Arbeitgeber GmbH', 'LOHN/GEHALT 01/2025 Gehaltsabrechnung Netto Auszahlung', 285000],
  ['Lastschrift', 'Techniker Krankenkasse', 'Krankenversicherung Pflegeversicherung Beitrag', -21000],
  ['Kartenzahlung', 'REWE Markt GmbH', 'Kartenzahlung girocard', -4237],
  ['Lastschrift', 'Finanzamt Musterstadt', 'Lohnsteuer Einkommensteuer Vorauszahlung', -15000],
  ['Dauerauftrag', 'Hausverwaltung Elbblick', 'Miete Wohnung', -95000],
];

function buildDkb({ pages = 6, perPage = 12, title = true, layout = 'inline' } = {}) {
  const outPages = [];
  let balance = 123456;
  const opening = balance;
  let k = 0;
  for (let p = 1; p <= pages; p++) {
    const lines = [];
    let y = 800;
    const L = (parts) => { lines.push(mkLine(y, parts)); y -= 12; };
    L([[50, 'Deutsche Kreditbank AG']]);
    if (title) L([[50, `Kontoauszug 1/2025`], [450, `Seite ${p} von ${pages}`]]);
    else L([[450, `Seite ${p} von ${pages}`]]);
    if (p === 1) {
      L([[50, 'Max Mustermann']]);
      L([[50, 'Girokonto'], [200, 'IBAN DE02 1203 0000 0000 2020 51']]);
      L([[50, 'Kontostand am 31.12.2024'], [450, fmt(opening)]]);
    }
    L([[50, 'Datum'], [120, 'Erläuterung'], [450, 'Betrag EUR']]);
    for (let i = 0; i < perPage; i++, k++) {
      const [bt, cp, purpose, amount] = BOOKINGS[k % BOOKINGS.length];
      const day = String(1 + (k % 28)).padStart(2, '0');
      if (layout === 'amountLast') { L([[50, `${day}.01.2025`], [120, bt]]); L([[120, cp]]); L([[120, purpose], [450, fmt(amount)]]); }
      else if (layout === 'dateOwnLine') { L([[50, `${day}.01.2025`]]); L([[120, bt], [450, fmt(amount)]]); L([[120, cp]]); L([[120, purpose]]); }
      else { L([[50, `${day}.01.2025`], [120, bt], [450, fmt(amount)]]); L([[120, cp]]); L([[120, purpose]]); }
      balance += amount;
    }
    if (p === pages) L([[50, 'Kontostand am 31.01.2025'], [450, fmt(balance)]]);
    outPages.push({ n: p, text: lines.map((l) => l.text).join('\n'), lines });
  }
  const text = outPages.map((p) => p.text).join('\n\f\n');
  return { ex: { kind: 'pdf', text, pages: outPages, ocr: false, meta: { pageCount: pages } }, opening, closing: balance, count: pages * perPage };
}

describe('DKB-Kontoauszug (PDF, viele Seiten)', () => {
  it('wird als Kontoauszug erkannt, nicht als Lohnabrechnung', () => {
    const { ex } = buildDkb();
    const det = detectType(ex, { name: 'Kontoauszug_DKB.pdf', ext: 'pdf' });
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' });
  });

  it('auch ohne Titel „Kontoauszug“ und mit neutralem Dateinamen', () => {
    const { ex } = buildDkb({ title: false });
    const det = detectType(ex, { name: 'scan_0001.pdf', ext: 'pdf' });
    expect(det.type).toBe('kontoauszug');
  });

  it('liest alle Buchungen und den Saldo über alle Seiten', async () => {
    const { ex, opening, closing, count } = buildDkb({ pages: 8, perPage: 15 });
    const det = detectType(ex, { name: 'dkb.pdf', ext: 'pdf' });
    const res = await parseStatement(det, ex, { name: 'dkb.pdf', ext: 'pdf' });
    expect(res.transactions).toHaveLength(count);
    expect(res.balance).toMatchObject({ opening, closing, check: true });
    const sal = res.transactions.find((t) => t.amount === 285000);
    expect(sal).toMatchObject({ counterparty: 'Arbeitgeber GmbH', bookingDate: '2025-01-02' });
    expect(res.document.type).toBe('kontoauszug');
  });

  for (const layout of ['amountLast', 'dateOwnLine']) {
    it(`Betrag in Folgezeile / Datum allein (${layout}): Kontoauszug, alle Buchungen, Saldo stimmt`, async () => {
      const { ex, opening, closing, count } = buildDkb({ layout, pages: 5, perPage: 12 });
      const det = detectType(ex, { name: 'Kontoauszug.pdf', ext: 'pdf' });
      expect(det).toMatchObject({ type: 'kontoauszug', institution: 'DKB' });
      const res = await parseStatement(det, ex, { name: 'Kontoauszug.pdf', ext: 'pdf' });
      expect(res.transactions).toHaveLength(count);
      expect(res.balance).toMatchObject({ opening, closing, check: true });
      const sal = res.transactions.find((t) => t.amount === 285000);
      expect(sal.counterparty).toBe('Arbeitgeber GmbH');
      expect(sal.purpose).toMatch(/LOHN\/GEHALT/);
    });
  }

  it('eine echte Lohnabrechnung bleibt Lohnabrechnung', () => {
    const text = ['Verdienstabrechnung Januar 2025', 'Personalnummer 4711', 'Steuerklasse 1', 'Bruttobezug 4.200,00',
      'Lohnsteuer 620,00', 'Krankenversicherung 340,00', 'Rentenversicherung 390,00', 'Netto 2.850,00', 'Auszahlungsbetrag 2.850,00'].join('\n');
    const lines = text.split('\n').map((t, i) => mkLine(800 - i * 12, [[50, t]]));
    const det = detectType({ kind: 'pdf', text, pages: [{ n: 1, text, lines }], meta: { pageCount: 1 } }, { name: 'abrechnung.pdf', ext: 'pdf' });
    expect(det.type).toBe('lohn');
  });
});
