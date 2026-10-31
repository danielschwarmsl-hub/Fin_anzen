import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';

// Kontoauszüge mit Sonderlayouts: DKB „Betrag Soll EUR | Betrag Haben EUR“ (Beträge ohne Vorzeichen) und comdirect Finanzreport
// (mehrere Konten in einem PDF). Zeilen wie extract/pdf.js sie liefert: Text aus Items, Lücke > 12 → drei Leerzeichen.

const mkLine = (y, parts) => {
  const items = parts.map(([x, str, w]) => ({ x, w: w ?? str.length * 5, str }));
  let text = '', end = null;
  for (const it of items) {
    if (end != null) text += it.x - end > 12 ? '   ' : ' ';
    text += it.str; end = it.x + it.w;
  }
  return { y, text, items };
};
const fmt = (c, sign = false) => {
  const s = (Math.abs(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (c < 0 ? '-' : sign ? '+' : '') + s;
};
const FILE = { name: 'auszug.pdf', ext: 'pdf' };
const toExtract = (pages, ocr = false) => ({
  kind: 'pdf', ocr, ...(ocr ? { ocrConfidence: 75 } : {}), pages,
  text: pages.map((p) => p.text).join(ocr ? '\n' : '\n\f\n'), meta: { pageCount: pages.length },
});
const loadReal = (name) => {
  const { pages } = JSON.parse(readFileSync(new URL(`./fixtures/real-ocr/${name}.json`, import.meta.url), 'utf8'));
  return { kind: 'pdf', ocr: true, ocrConfidence: 75, pages, text: pages.map((p) => p.text).join('\n') };
};
async function run(ex) {
  const det = detectType(ex, FILE);
  const res = await parse(det, ex, FILE);
  return { det, res, all: [res, ...(res.additional || [])] };
}

// ------------------------------------------------------------------ DKB Soll/Haben
const SOLL_R = 420, HABEN_R = 545; // rechte Kanten der Betragsspalten
const HEADERS = {
  // je Spalte ein Textstück „Betrag Soll EUR“
  pieces: [[50, 'Datum'], [110, 'Erläuterung'], [SOLL_R - 75, 'Betrag Soll EUR'], [HABEN_R - 80, 'Betrag Haben EUR']],
  // einzelne Wörter, „EUR“ als eigenes Stück
  words: [[50, 'Datum'], [110, 'Erläuterung'], [345, 'Betrag'], [378, 'Soll'], [SOLL_R - 15, 'EUR'], [455, 'Betrag'], [488, 'Haben'], [HABEN_R - 15, 'EUR']],
  // ganze Kopfzeile als ein Stück
  single: [[50, 'Datum Erläuterung Betrag Soll EUR Betrag Haben EUR', HABEN_R - 50]],
};
// [Datum|null, Buchungsart, Gegenpartei, Zweck, Betrag in Cent (− = Soll)]
const DKB_BOOKINGS = [
  ['05.02.2026', 'Basislastschrift', 'Telefonica Germany GmbH + Co. OHG', 'Ihre Tarifrechnung', -3999],
  [null, 'Kartenzahlung FW', 'GITHUB INC', 'Original USD 13,50 VISA Debit', -1234],
  ['10.02.2026', 'Kartenzahlung onl', 'STEAM PURCHASE', 'VISA Debit', -2345],
  ['23.02.2026', 'Lohn, Gehalt, Rente', 'Arbeitgeber GmbH', 'Gehalt Februar', 250000],
  ['26.02.2026', 'Zahlungseingang', 'PayPal Europe S.a.r.l. et Cie S.C.A', 'ABBUCHUNG VOM PAYPAL-KONTO', 1500],
  ['27.02.2026', 'Dauerauftrag', 'Hausverwaltung Elbblick', 'Miete für den nächsten Monat', -80000],
  ['27.02.2026', 'Überweisung', 'Max Mustermann', 'Geschenk', -5000],
  ['02.03.2026', 'Gutschrift', 'Erika Muster', 'Rückzahlung', 10000],
];

function buildDkbSollHaben({ header = 'pieces', opening = 100000 } = {}) {
  const pages = [];
  let closing = opening, soll = 0, haben = 0, nSoll = 0, nHaben = 0;
  const amt = (y, c) => { const s = fmt(Math.abs(c)); const right = c < 0 ? SOLL_R : HABEN_R; return [right - s.length * 5, s]; };
  const half = Math.ceil(DKB_BOOKINGS.length / 2);
  [DKB_BOOKINGS.slice(0, half), DKB_BOOKINGS.slice(half)].forEach((list, pi) => {
    const lines = [];
    let y = 800;
    const L = (parts) => { lines.push(mkLine(y, parts)); y -= 12; };
    L([[50, 'Deutsche Kreditbank AG']]);
    L([[50, 'Kontoauszug 3/2026'], [470, `Seite ${pi + 1} von 2`]]);
    L([[50, 'Girokonto'], [130, 'DE02 1203 0000 0000 2020 51']]);
    L(HEADERS[header]);
    if (pi === 0) L([[110, 'Kontostand am 04.02.2026, Auszug Nr. 2'], amt(y, opening)]);
    for (const [date, kind, party, purpose, c] of list) {
      L([...(date ? [[50, date]] : []), [110, kind], amt(y, c)]);
      L([[110, party]]);
      L([[110, purpose]]);
      closing += c;
      if (c < 0) { soll += -c; nSoll++; } else { haben += c; nHaben++; }
    }
    if (pi === 1) {
      L([[110, 'Kontostand am 04.03.2026 um 18:05 Uhr'], amt(y, closing)]);
      L([[50, 'Gesamtumsatzsummen'], [200, 'Summe Soll EUR'], [300, 'Anzahl'], [380, 'Summe Haben EUR'], [500, 'Anzahl']]);
      L([[200, fmt(soll)], [300, String(nSoll)], [380, fmt(haben)], [500, String(nHaben)]]);
    }
    L([[50, 'Deutsche Kreditbank AG'], [200, 'Vorsitzender des Aufsichtsrats'], [400, 'Telefon'], [480, 'BIC:']]);
    L([[50, 'Ein Unternehmen der Bayerischen Landesbank'], [400, 'Handelsregister']]);
    pages.push({ n: pi + 1, text: lines.map((l) => l.text).join('\n'), lines });
  });
  return { ex: toExtract(pages), opening, closing, soll, haben, nSoll, nHaben };
}

describe('DKB Kontoauszug mit Spalten „Betrag Soll EUR | Betrag Haben EUR“', () => {
  for (const header of Object.keys(HEADERS)) {
    it(`Vorzeichen aus der Spalte (Kopf: ${header})`, async () => {
      const { ex, opening, closing } = buildDkbSollHaben({ header });
      const { det, res } = await run(ex);
      expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' });
      expect(res.transactions.map((t) => t.amount)).toEqual(DKB_BOOKINGS.map((b) => b[4]));
      expect(res.balance).toMatchObject({ opening, closing, check: true });
      expect(res.document.needsReview).toBe(false);
    });
  }

  it('Kontostand in der Soll-Spalte ist negativ', async () => {
    const { ex, closing } = buildDkbSollHaben({ opening: -50000 });
    const { res } = await run(ex);
    expect(res.balance).toMatchObject({ opening: -50000, closing, check: true });
  });

  it('„Kontostand am …, Auszug Nr.“ = Anfang, „Gesamtumsatzsummen“ = Anzahl und Kontrollsummen', async () => {
    const { ex, soll, haben, nSoll, nHaben } = buildDkbSollHaben();
    const { res } = await run(ex);
    const f = res.document.fields;
    expect(f.expectedCount).toBe(nSoll + nHaben);
    expect(f.readCount).toBe(nSoll + nHaben);
    expect(f.controlTotals).toEqual({ sollCount: nSoll, habenCount: nHaben, sollSum: -soll, habenSum: haben });
    expect(f.diagnostics.problems).toEqual(['1 Buchung ohne lesbares Datum – Datum der vorherigen Buchung übernommen.']);
    expect(res.document.periodFrom).toBe('2026-02-04');
    expect(res.document.periodTo).toBe('2026-03-04');
  });

  it('Buchung ohne Datum (zweite Buchungsart im Block) übernimmt das Datum der Vorbuchung; Seitenfuß nicht im Zweck', async () => {
    const { ex } = buildDkbSollHaben();
    const { res } = await run(ex);
    const fw = res.transactions.find((t) => t.amount === -1234);
    expect(fw.bookingDate).toBe('2026-02-05');
    expect(fw.bookingText).toBe('Kartenzahlung');
    const lastP1 = res.transactions.find((t) => t.amount === 250000);
    expect(lastP1.purpose).not.toMatch(/Aufsichtsrat|Handelsregister|Landesbank/);
    expect(res.transactions.every((t) => !/Kreditbank|Aufsichtsrat/.test(t.purpose))).toBe(true);
  });
});

describe('DKB Soll/Haben als OCR-Text (ohne Positionen)', () => {
  const page = [
    'Deutsche Kreditbank AG',
    'Kontoauszug 3/2026 Seite 1 von 1',
    'Girokonto',
    '[Datum Erläuterung Betrag Soll EUR Betrag Haben EUR',
    'Kontostand am 04.02.2026, Auszug Nr. 2 1.000,00',
    '05.02.2026/Basislastschrift 39,99',
    'Telefonica Germany GmbH + Co. OHG Kd-Nr.:',
    'Ihre Tarifrechnung',
    'Kartenzahlung FW 12,34',
    '2026-02-04T23:25 Original USD 1',
    '23.02.2026/Lohn, Gehalt, Rente 2.500,00',
    'ARBEITGEBER GMBH',
    '27.02.2026/Dauerauftrag 800,00',
    'Miete für den nächsten Monat',
    '02.03.2026/Sonderposten 5,00',
    'Kontostand am 04.03.2026 um 18:05 Uhr 2.652,67',
    'Deutsche Kreditbank AG Vorsitzender des Aufsichtsrats Telefon BIC:',
    'Ein Unternehmen der Bayerischen Landesbank Handelsregister',
    'Gesamtumsatzsummen Summe Soll EUR Anzahl Summe Haben EUR Anzahl',
    '852,33 3 2.505,00 2',
  ].join('\n');

  it('Vorzeichen aus der Buchungsart, unklare Fälle in Diagnose und Prüfhinweis', async () => {
    const { det, res } = await run(toExtract([{ n: 1, text: page }], true));
    expect(det).toMatchObject({ type: 'kontoauszug', institution: 'DKB' });
    expect(res.transactions.map((t) => [t.bookingDate, t.amount])).toEqual([
      ['2026-02-05', -3999], ['2026-02-05', -1234], ['2026-02-23', 250000], ['2026-02-27', -80000], ['2026-03-02', 500],
    ]);
    expect(res.balance).toMatchObject({ opening: 100000, closing: 265267, check: true });
    const d = res.document.fields.diagnostics;
    expect(d.sollHaben).toMatchObject({ columns: false, signFromKind: 4, signUnknown: 1 });
    expect(d.problems.join(' ')).toMatch(/Bei 1 Buchung ist unklar, ob Soll oder Haben/);
    expect(d.problems.join(' ')).toMatch(/1 Buchung ohne lesbares Datum/);
    expect(res.document.reviewReason).toMatch(/Vorzeichen bei 1 Buchung unklar/);
    expect(res.document.fields.expectedCount).toBe(5);
    expect(res.document.fields.controlTotals).toMatchObject({ sollSum: -85233, habenSum: 250500 });
  });
});

describe('Echte Vorlage: DKB-Auszug mit geschwärzten Beträgen (OCR)', () => {
  it('bleibt Kontoauszug, 0 Buchungen, klare Diagnose und erwartete Anzahl 54', async () => {
    const { det, res, all } = await run(loadReal('dkb_soll_haben'));
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'DKB' });
    expect(all).toHaveLength(1);
    expect(res.document.type).toBe('kontoauszug');
    expect(res.transactions).toHaveLength(0);
    const d = res.document.fields.diagnostics;
    expect(d.problems[0]).toMatch(/^Datumszeilen\/Buchungsarten erkannt \(\d+\), aber keine Beträge lesbar – Beträge geschwärzt oder Scan zu unscharf/);
    expect(d.expectedCount).toBe(54);
    expect(res.document.fields.expectedCount).toBe(54);
    expect(res.document.needsReview).toBe(true);
    expect(res.document.reviewReason).toMatch(/keine Beträge lesbar/);
    expect(res.account).toMatchObject({ kind: 'giro', institution: 'DKB' });
  });
});

// ------------------------------------------------------------------ comdirect Finanzreport
const COL = { date: 50, vorgang: 110, party: 190, text: 300, amount: 500 };
/** Buchung: zwei Datumszeilen (Buchungstag mit Betrag, Valuta) + Folgezeilen. */
function frBooking(L, { day, valuta, vorgang, vorgang2 = '', party = '', party2 = '', text = '', text2 = '', amount, cont = [] }) {
  const cells = (d, v, p, t) => [[COL.date, d], ...(v ? [[COL.vorgang, v]] : []), ...(p ? [[COL.party, p]] : []), ...(t ? [[COL.text, t]] : [])];
  const a = fmt(amount, true);
  L([...cells(day, vorgang, party, text), [COL.amount + 40 - a.length * 5, a]]);
  L(cells(valuta, vorgang2, party2, text2));
  for (const c of cont) L([[COL.text, c]]);
}
function buildFinanzreport() {
  const pages = [];
  const page = (n, fill) => {
    const lines = [];
    let y = 800;
    const L = (parts) => { lines.push(mkLine(y, parts)); y -= 12; };
    L([[50, `Finanzreport Nr. 11 per 02.12.2024${n > 1 ? ` - Seite ${n}` : ''}`], [420, 'comdirect']]);
    if (n > 1) L([[50, 'Kundennummer 1234567']]);
    fill(L);
    L([[50, 'comdirect - eine Marke der Commerzbank AG'], [420, 'USt-ID: DE123456789']]);
    pages.push({ n, text: lines.map((l) => l.text).join('\n'), lines });
  };
  const sal = (L, label, date, c) => L([[COL.date, label], [COL.vorgang, date], [COL.amount + 40 - fmt(c, true).length * 5, fmt(c, true)]]);
  page(1, (L) => {
    L([[50, 'Sehr geehrter Herr Mustermann,']]);
    L([[50, 'in Ihrem aktuellen Finanzreport finden Sie alle Informationen rund um Ihre Kundenverbindung.']]);
  });
  page(2, (L) => {
    L([[50, 'Kontoübersicht']]);
    L([[50, 'Ihre aktuellen Salden'], [250, 'IBAN'], [500, 'Saldo in EUR']]);
    L([[50, 'Girokonto'], [250, 'DE12 2004 1155 0123 4567 00'], [500, '+747,05']]);
    L([[50, 'Tagesgeld PLUS-Konto'], [250, 'DE34 2004 1155 0123 4567 01'], [500, '+500,00']]);
    L([[50, 'Depot'], [500, '+4.382,47']]);
    L([[50, 'Visa-Karte 1234'], [500, '+0,00']]);
    L([[50, 'Gesamtsaldo 02.12.2024'], [500, '+5.629,52']]);
    L([[50, 'Girokonto'], [420, 'Dispositionskredit 1.000 EUR']]);
    L([[COL.date, 'Buchungstag'], [COL.vorgang, 'Vorgang'], [COL.party, 'Auftraggeber/Empfänger'], [COL.text, 'Buchungstext'], [COL.amount, 'Ausgang']]);
    L([[COL.date, 'Valuta'], [COL.vorgang, 'Referenz'], [COL.party, 'IBAN/BIC'], [COL.amount, 'Eingang']]);
    sal(L, 'Alter Saldo', '01.11.2024', 183322);
    frBooking(L, { day: '04.11.2024', valuta: '05.11.2024', vorgang: 'Kupon', vorgang2: '4A1B2C3D', text: 'ERTRAEGNISGUTSCHRIFT VOM 01.11.24', text2: 'DEPOTBESTAND: 19,000', amount: 873,
      cont: ['MUSTER INC. DL-,10', 'USD 0,6775', 'Abr.Betrag Brutto 10,04 EUR', 'Steuerabzug 1,31- EUR'] });
    frBooking(L, { day: '12.11.2024', valuta: '14.11.2024', vorgang: 'Wertpapiere', vorgang2: '7X8Y9Z', text: 'MUSTER AG', text2: 'WPKNR: 123456 ISIN: DE0001234567', amount: -107730 });
    frBooking(L, { day: '18.11.2024', valuta: '18.11.2024', vorgang: 'Übertrag /', vorgang2: 'Überweisung', party: 'Gerichtskasse Musterstadt', party2: 'DE02100500000024290661 BELADEBEXXX',
      text: 'Kassenzeichen 4711', text2: 'End-to-End-Ref.:', amount: -300, cont: ['nicht angegeben'] });
    frBooking(L, { day: '02.12.2024', valuta: '02.12.2024', vorgang: 'Lastschrift /', vorgang2: 'Belastung', party: 'comdirect', party2: 'Visa-Monatsabrechnung',
      text: 'VISA-KARTE NR. 1234', text2: 'SUMME MONATSABRECHNUNG VISA', amount: -970 });
    frBooking(L, { day: '02.12.2024', valuta: '29.11.2024', vorgang: 'Kontoführungse', vorgang2: 'ntgelt', text: 'Entgelt', text2: 'Visa-Kreditkarte', amount: -490,
      cont: ['Zeitraum: 01.11.2024', 'bis 30.11.2024'] });
    sal(L, 'Neuer Saldo', '02.12.2024', 74705);
    L([[50, 'Tagesgeld PLUS-Konto']]);
    L([[COL.date, 'Buchungstag'], [COL.vorgang, 'Vorgang'], [COL.party, 'Auftraggeber/Empfänger'], [COL.text, 'Buchungstext'], [COL.amount, 'Ausgang']]);
    L([[COL.date, 'Valuta'], [COL.vorgang, 'Referenz'], [COL.party, 'IBAN/BIC'], [COL.amount, 'Eingang']]);
    sal(L, 'Alter Saldo', '01.11.2024', 50000);
    sal(L, 'Neuer Saldo', '02.12.2024', 50000);
  });
  page(3, (L) => {
    L([[50, 'Visa-Karte 1234'], [330, 'Visa Limit 1.500 EUR/Monat'], [440, 'Verfügungslimit 600 EUR/Tag']]);
    L([[COL.date, 'Buchungstag'], [COL.vorgang, 'Vorgang'], [COL.party, 'Buchungstext'], [COL.amount, 'Ausgang']]);
    L([[COL.date, 'Valuta'], [COL.vorgang, 'Referenz'], [COL.amount, 'Eingang']]);
    sal(L, 'Alter Saldo', '01.11.2024', 0);
    // Visa: Buchungstext steht in der dritten Spalte (kein Auftraggeber)
    const visa = (day, valuta, vorgang, text, amount, text2 = '') => {
      const a = fmt(amount, true);
      L([[COL.date, day], ...(vorgang ? [[COL.vorgang, vorgang]] : []), [COL.party, text], [COL.amount + 40 - a.length * 5, a]]);
      L([[COL.date, valuta], [COL.vorgang, 'R' + day.replace(/\./g, '')], ...(text2 ? [[COL.party, text2]] : [])]);
    };
    visa('12.11.2024', '11.11.2024', 'Visa-Umsatz', 'HEROKU   WWW.HEROKU.COM Betrag: -7,00 USD', -670, 'USD Kurs: 1,0632');
    visa('18.11.2024', '16.11.2024', 'Visa-Umsatz', 'LGC UBER GIFTCARD SCHIPHOL 003', -300);
    visa('29.11.2024', '29.11.2024', '', 'AUSGLEICH MONATSABRECHNUNG', 970);
    sal(L, 'Neuer Saldo', '02.12.2024', 0);
    L([[50, 'Depot']]);
    L([[50, 'Depotbestand'], [400, 'EUR'], [450, 'EUR'], [500, 'EUR']]);
    L([[50, 'WKN / Verwahrart'], [150, 'Anzahl / Nominal'], [250, 'Währung'], [400, 'Kurswert'], [450, 'Kaufwert'], [500, 'Gewinn / Verlust']]);
    L([[50, 'A0B1C2 / Wertpapierrechnung'], [150, '19,000'], [250, 'EUR'], [400, '1.234,56'], [450, '1.000,00'], [500, '+234,56']]);
    L([[50, '02.12.2024 Bewertung'], [500, '+1,00']]);
  });
  page(4, (L) => {
    L([[50, 'Steuerübersicht*']]);
    L([[50, 'Gewinne/Verluste Aktien (Saldo)'], [500, '-12,26']]);
    L([[50, 'Zinsübersicht']]);
    L([[50, 'Girokonto']]);
    L([[50, 'Zinssatz für die Inanspruchnahme des Dispositionskredites: 9,90 % p. a.']]);
  });
  return pages;
}

describe('comdirect Finanzreport', () => {
  const check = ({ det, res, all }) => {
    expect(det).toMatchObject({ type: 'kontoauszug', format: 'pdf_statement', institution: 'comdirect', variant: 'finanzreport' });
    expect(all.map((r) => [r.document.type, r.account.kind, r.account.name])).toEqual([
      ['kontoauszug', 'giro', 'comdirect Girokonto'],
      ['kontoauszug', 'tagesgeld', 'comdirect Tagesgeld PLUS-Konto'],
      ['kreditkarte', 'kreditkarte', 'comdirect Visa-Karte'],
    ]);
    const [giro, tg, visa] = all;
    expect(giro.transactions.map((t) => [t.bookingDate, t.valueDate, t.amount])).toEqual([
      ['2024-11-04', '2024-11-05', 873], ['2024-11-12', '2024-11-14', -107730], ['2024-11-18', '2024-11-18', -300],
      ['2024-12-02', '2024-12-02', -970], ['2024-12-02', '2024-11-29', -490],
    ]);
    expect(giro.balance).toMatchObject({ opening: 183322, closing: 74705, check: true });
    expect(tg.transactions).toHaveLength(0);
    expect(tg.balance).toMatchObject({ opening: 50000, closing: 50000, check: true });
    expect(visa.transactions.map((t) => t.amount)).toEqual([-670, -300, 970]);
    expect(visa.balance).toMatchObject({ opening: 0, closing: 0, check: true });
    // Depot-, Steuer- und Zinsteil sind keine Buchungen
    expect(all.flatMap((r) => r.transactions).some((t) => [23456, 100, -1226].includes(t.amount))).toBe(false);
    expect(giro.document.fields.infoSections).toEqual(['Depot', 'Steuerübersicht', 'Zinsübersicht']);
    expect(all.every((r) => !r.document.needsReview)).toBe(true);
    return { giro, visa };
  };

  it('Textebene mit Positionen: alle Buchungen je Konto mit Vorzeichen, Alter/Neuer Saldo', async () => {
    const out = await run(toExtract(buildFinanzreport()));
    const { giro, visa } = check(out);
    const [kupon, wp, ger, , entgelt] = giro.transactions;
    expect(kupon).toMatchObject({ bookingText: 'Kupon' });
    expect(kupon.purpose).toMatch(/ERTRAEGNISGUTSCHRIFT/);
    expect(wp.purpose).toMatch(/WPKNR: 123456/);
    expect(ger).toMatchObject({ counterparty: 'Gerichtskasse Musterstadt', bookingText: 'Überweisung', counterpartyIban: 'DE02100500000024290661' });
    expect(entgelt.bookingText).toBe('Gebühr');
    expect(visa.transactions[0]).toMatchObject({ counterparty: 'HEROKU', bookingDate: '2024-11-12', valueDate: '2024-11-11' });
  });

  it('nur Text (ohne Positionen): gleiche Buchungen und Salden', async () => {
    const pages = buildFinanzreport().map(({ n, text }) => ({ n, text }));
    check(await run(toExtract(pages)));
  });

  it('echte Vorlage (OCR, geschwärzt): Finanzreport erkannt, Konten-Abschnitte, lesbare Buchung, Rest in der Diagnose', async () => {
    const { det, all } = await run(loadReal('comdirect_finanzreport'));
    expect(det).toMatchObject({ type: 'kontoauszug', institution: 'comdirect', variant: 'finanzreport' });
    expect(all.map((r) => r.account.name)).toEqual(['comdirect Girokonto', 'comdirect Visa-Karte']);
    const [giro, visa] = all;
    // „18.11.2024 Übertrag / Gerichtskasse … 3,00“: Vorzeichen geschwärzt → aus dem Vorgang (Überweisung = Ausgang)
    expect(giro.transactions.map((t) => [t.bookingDate, t.amount])).toEqual([['2024-11-18', -300]]);
    expect(giro.document.fields).toMatchObject({ expectedCount: 5, readCount: 1, variant: 'finanzreport' });
    expect(giro.document.reviewReason).toMatch(/4 von 5 Buchungen ohne lesbaren Betrag/);
    expect(visa.transactions).toHaveLength(0);
    expect(visa.document.fields.diagnostics.problems[0]).toMatch(/ohne lesbaren Betrag – Beträge geschwärzt oder Scan zu unscharf/);
    expect(giro.document.periodTo).toBe('2024-12-02');
  });
});
