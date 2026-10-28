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


// Exakt das Layout aus dem DKB-Umsatzexport (Screenshot des Nutzers): Dezimalpunkt („-75.00“), absteigend sortiert,
// kein Saldo, aber „Anzahl der Transaktionen“, mehrzeilige Erläuterung, 0.00-Zeilen.
function buildDkbExport({ pages = 4, perPage = 10, thousands = 'plain', countOverride = null } = {}) {
  const ROWS = [
    [['Kartenzahlung', 'REWE Markt GmbH', 'VISA Debitkartenumsatz vom 27.12.2025'], -6876],
    [['Gutschrift', 'Arbeitgeber GmbH', 'LOHN/GEHALT 12/2025 Gehaltsabrechnung'], 285000],
    [['Lastschrift', 'AUDIBLE GMBH', 'Audible Abo 12/2025'], -995],
    [['Dauerauftrag', 'Hausverwaltung Elbblick', 'Miete Januar'], -123456],
    [['Kartenzahlung', 'Hamburger Wasserwerke', 'Wasser Abschlag'], -4500],
    [['Abschluss', 'Rechnungsabschluss'], 0],
  ];
  const fmtDot = (c) => {
    const v = (Math.abs(c) / 100).toFixed(2);
    const [i, d] = v.split('.');
    const ii = thousands === 'comma' ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i;
    return (c < 0 ? '-' : '') + ii + '.' + d;
  };
  const total = pages * perPage;
  const out = [];
  let k = 0;
  for (let p = 1; p <= pages; p++) {
    const lines = [];
    let y = 800;
    const L = (parts) => { lines.push(mkLine(y, parts)); y -= 12; };
    L([[1060, `Seite ${p} von ${pages}`]]);
    if (p === 1) {
      L([[140, 'DKB']]); L([[140, 'Deutsche Kreditbank AG']]);
      L([[140, 'Auszug'], [1060, '05. Juli 2026']]);
      L([[140, 'DE02 1203 0000 0000 2020 31'], [910, `Anzahl der Transaktionen: ${countOverride ?? total}`]]);
      L([[910, 'Zeitraum: 01.01.2025 - 31.12.2025']]);
    }
    L([[160, 'Datum'], [340, 'Erläuterung'], [1050, 'Betrag EUR']]);
    for (let i = 0; i < perPage; i++, k++) {
      const [texts, amount] = ROWS[k % ROWS.length];
      const day = String(28 - (k % 28)).padStart(2, '0');
      const tok = fmtDot(amount);
      L([[160, `${day}.12.2025`], [340, texts[0]], [1140 - tok.length * 5, tok]]);
      for (const t of texts.slice(1)) L([[340, t]]);
    }
    out.push({ n: p, text: lines.map((l) => l.text).join('\n'), lines });
  }
  return { ex: { kind: 'pdf', text: out.map((p) => p.text).join('\n\f\n'), pages: out, ocr: false, meta: { pageCount: pages } }, total };
}

describe('DKB-Umsatzexport mit Dezimalpunkt (Layout wie im Screenshot)', () => {
  it('Kontoauszug mit allen Buchungen, 0.00-Zeilen nicht als Buchung, Anzahl stimmt → kein Prüfhinweis', async () => {
    const { ex, total } = buildDkbExport();
    const det = detectType(ex, { name: 'Umsaetze_2025.pdf', ext: 'pdf' });
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' });
    const res = await parseStatement(det, ex, { name: 'Umsaetze_2025.pdf', ext: 'pdf' });
    const zeros = Math.floor(total / 6) + (total % 6 > 5 ? 1 : 0);
    expect(res.transactions).toHaveLength(total - zeros);
    expect(res.transactions.map((t) => t.amount)).toEqual(expect.arrayContaining([-6876, 285000, -995, -123456, -4500]));
    expect(res.transactions.every((t) => t.amount !== 0)).toBe(true);
    const visa = res.transactions.find((t) => t.amount === -6876);
    expect(visa).toMatchObject({ counterparty: 'REWE Markt GmbH', bookingDate: '2025-12-28' });
    expect(visa.purpose).toMatch(/VISA Debitkartenumsatz vom 27\.12\.2025/);
    expect(res.document.needsReview).toBe(false);
    expect(res.document.periodFrom).toBe('2025-01-01');
    expect(res.document.periodTo).toBe('2025-12-31');
  });

  it('Tausender mit Komma („-1,234.56“)', async () => {
    const { ex } = buildDkbExport({ thousands: 'comma' });
    const res = await parseStatement(detectType(ex, { name: 'x.pdf', ext: 'pdf' }), ex, { name: 'x.pdf', ext: 'pdf' });
    expect(res.transactions.map((t) => t.amount)).toContain(-123456);
  });

  it('Anzahl weicht ab → klarer Prüfhinweis', async () => {
    const { ex } = buildDkbExport({ countOverride: 733 });
    const res = await parseStatement(detectType(ex, { name: 'x.pdf', ext: 'pdf' }), ex, { name: 'x.pdf', ext: 'pdf' });
    expect(res.document.needsReview).toBe(true);
    expect(res.document.reviewReason).toMatch(/40 von 733 Transaktionen gelesen/);
  });
});

describe('Diagnose, wenn das Einlesen hakt', () => {
  it('Anzahl weicht ab: Satz mit Soll/Ist in der Diagnose', async () => {
    const { ex } = buildDkbExport({ countOverride: 733 });
    const res = await parseStatement(detectType(ex, { name: 'x.pdf', ext: 'pdf' }), ex, { name: 'x.pdf', ext: 'pdf' });
    const d = res.document.fields.diagnostics;
    expect(d.problems.join(' ')).toMatch(/Laut Auszug 733 Transaktionen, gelesen 40 \(693 fehlen\)/);
    expect(d).toMatchObject({ numberFormat: 'dot', dateLines: 40, expectedCount: 733, readCount: 40 });
  });

  it('kein Betrag lesbar: sagt, was gefunden wurde, was fehlt und zeigt Beispielzeilen mit Seite', async () => {
    const { ex } = buildDkbExport();
    // Beträge unlesbar machen (z. B. unbekanntes Format „EUR 75“)
    for (const p of ex.pages) for (const l of p.lines) {
      l.items = l.items.map((i) => (/^-?\d+\.\d{2}$/.test(i.str) ? { ...i, str: 'EUR ' + i.str.replace(/\.\d{2}$/, '') } : i));
      l.text = l.items.map((i) => i.str).join('   ');
    }
    ex.text = ex.pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\f\n');
    const res = await parseStatement({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' }, ex, { name: 'x.pdf', ext: 'pdf' });
    expect(res.transactions).toHaveLength(0);
    const d = res.document.fields.diagnostics;
    expect(d.problems[0]).toMatch(/^40 Zeilen mit Datum gefunden, aber zu keiner ein Betrag am Zeilenende/);
    expect(d.unparsed[0]).toMatchObject({ page: 1 });
    expect(d.unparsed[0].text).toMatch(/^28\.12\.2025 Kartenzahlung/);
    expect(res.document.reviewReason).toMatch(/^Keine Buchungen erkannt: 40 Zeilen mit Datum gefunden/);
  });
});

describe('DKB-Erläuterung: Empfänger – IBAN – Verwendungszweck (echte Beispiele des Nutzers)', () => {
  const build = () => {
    const lines = [];
    let y = 800;
    const L = (parts) => { lines.push(mkLine(y, parts)); y -= 12; };
    L([[140, 'DKB']]); L([[140, 'Auszug'], [910, 'Anzahl der Transaktionen: 2']]); L([[910, 'Zeitraum: 01.01.2025 - 31.12.2025']]);
    L([[160, 'Datum'], [340, 'Erläuterung'], [1050, 'Betrag EUR']]);
    L([[160, '29.12.2025'], [340, 'PayPal Europe S.a.r.l. et Cie S.C.A 22-24'], [1110, '-68.76']]);
    L([[340, 'Boulevard Royal, 2449 Luxembourg']]);
    L([[340, 'IBAN LU89 3243 2423 2344 200E']]);
    L([[340, '234087234/PP.1171.PP/. , Ihr Einkauf bei ABC Shop']]);
    L([[160, '27.12.2025'], [340, 'STAR..Hamburg/Hamburg'], [1115, '-8.48']]);
    L([[340, 'IBAN DE96 2332 0000 3034 3423 04']]);
    L([[340, 'VISA Debitkartenumsatz vom 25.12.2025']]);
    const text = lines.map((l) => l.text).join('\n');
    return { kind: 'pdf', text, pages: [{ n: 1, text, lines }], meta: { pageCount: 1 } };
  };
  it('Empfänger, IBAN, Zweck und Buchungsart werden richtig getrennt', async () => {
    const ex = build();
    const res = await parseStatement({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' }, ex, { name: 'x.pdf', ext: 'pdf' });
    const [pp, star] = [res.transactions.find((t) => t.amount === -6876), res.transactions.find((t) => t.amount === -848)];
    expect(pp).toMatchObject({ counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A 22-24', bookingText: 'Lastschrift' });
    expect(pp.purpose).toMatch(/Ihr Einkauf bei ABC Shop/);
    expect(pp.counterpartyIban).toMatch(/^LU89/);
    expect(star).toMatchObject({ counterpartyRaw: 'STAR..Hamburg/Hamburg', bookingText: 'Kartenzahlung', purpose: 'VISA Debitkartenumsatz vom 25.12.2025' });
    expect(res.document.needsReview).toBe(false);
  });
  it('Kategorien: STAR Hamburg → Tanken, PayPal-Einkauf → Händler aus „Ihr Einkauf bei“', async () => {
    const { normalizeCounterparty } = await import('../src/lib/classify/normalize.js');
    const { classifyTransactions } = await import('../src/lib/classify/rules.js');
    const ex = build();
    const res = await parseStatement({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' }, ex, { name: 'x.pdf', ext: 'pdf' });
    const txs = res.transactions.map((t, i) => ({ ...t, id: 't' + i, accountId: 'a', counterparty: normalizeCounterparty(t) || t.counterpartyRaw }));
    const out = classifyTransactions(txs, { rules: [], accounts: [] });
    const star = out.find((t) => t.amount === -848);
    expect(star.category).toBe('mobilitaet');
    expect(out.find((t) => t.amount === -6876).counterparty).toBe('ABC Shop');
  });
});
