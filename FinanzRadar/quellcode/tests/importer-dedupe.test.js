// Dubletten über Dateien hinweg – gegen den echten Importer (runImport → saveResult → upsertAccount), nicht gegen eine Kopie der Logik.
// Echte Extraktion, Erkennung und Parser; nur Datenbank und App-Zustand sind In-Memory-Ersatz (tests/helpers/fake-db.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileItem } from './helpers/fake-db.js';

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

const SAMPLES = path.resolve(import.meta.dirname, '../samples/out');
const SCEN = path.resolve(import.meta.dirname, 'fixtures/scenarios');
const sample = rel => fileItem(rel, fs.readFileSync(path.join(SAMPLES, rel)));
const scen = rel => fileItem(rel, fs.readFileSync(path.join(SCEN, rel)));
const ING_CSV = 'Banken/ING/ing_girokonto_2026H1.csv', ING_PDF = 'Banken/ING/ing_kontoauszug_2026-03.pdf', ING_CAMT = 'Banken/ING/camt053_ing_2026-05.xml';

async function importAll(items, concurrency = 1) {
  db.reset();
  app.progress.running = false;
  const s = await ensureSource({ kind: 'local', name: 'T', root: 'T' });
  await runImport(items, s, { concurrency });
  expect(app.progress.errors).toEqual([]);
  return db.snapshot();
}
const amounts = snap => snap.transactions.map(t => `${t.bookingDate}|${t.amount}`).sort();

const ingCsv = (rows, { iban = 'DE02 5001 0517 0000 0471 10', name = 'Girokonto' } = {}) => [
  'Umsatzanzeige;Datei erstellt am: 31.03.2026 10:00', '',
  ...(iban ? [`IBAN;${iban}`] : []), `Kontoname;${name}`, 'Bank;ING', 'Kunde;Erika Beispiel', 'Zeitraum;01.03.2026 - 31.03.2026', '',
  'Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;Betrag;Währung',
  ...rows.map(([d, who, bt, purpose, amt]) => `${d};${d};${who};${bt};${purpose};;EUR;${amt};EUR`),
].join('\r\n') + '\r\n';

describe('Importer: CSV + PDF/camt desselben Kontos', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('CSV zuerst: PDF (März) und camt (Mai) fügen keine Buchung hinzu, ein Konto', async () => {
    const snap = await importAll([sample(ING_CSV), sample(ING_PDF), sample(ING_CAMT)]);
    expect(snap.accounts).toHaveLength(1);
    expect(snap.transactions).toHaveLength(125);
    expect(app.progress.newTx).toBe(125);
  });

  // Lücke in saveResult: Bei gleichem dedupeKey (gleiche Schreibweise) wird die camt-Buchung übersprungen, BEVOR fehlende
  // Felder (Mandat, Gläubiger-ID, IBAN) ergänzt werden – ergänzt wird nur im Datum+Betrag-Zweig.
  it.fails('camt nach CSV ergänzt Mandatsreferenz auch bei gleichem dedupeKey', async () => {
    const snap = await importAll([sample(ING_CSV), sample(ING_CAMT)]);
    const may = snap.transactions.filter(t => t.bookingDate.startsWith('2026-05') && /Vattenfall/.test(t.counterpartyRaw || t.counterparty));
    expect(may).toHaveLength(1);
    expect(may[0].mandateId).toBe('VATT-MM-4711');
  });

  it('PDF und camt zuerst, CSV danach: gleiche Buchungsmenge wie umgekehrt', async () => {
    const a = amounts(await importAll([sample(ING_CSV), sample(ING_PDF), sample(ING_CAMT)]));
    const b = amounts(await importAll([sample(ING_PDF), sample(ING_CAMT), sample(ING_CSV)]));
    expect(b).toHaveLength(125);
    expect(b).toEqual(a);
  });

  it('abweichende Schreibweise (Gegenpartei/Zweck) ist trotzdem Dublette; echte gleiche Buchungen am selben Tag bleiben', async () => {
    const one = ingCsv([
      ['05.03.2026', 'Bäckerei Beispiel', 'Kartenzahlung', 'VISA Debitkarte KAUFUMSATZ 05.03', '-5,00'],
      ['05.03.2026', 'Bäckerei Beispiel', 'Kartenzahlung', 'VISA Debitkarte KAUFUMSATZ 05.03', '-5,00'],
      ['14.03.2026', 'EDEKA Markt', 'Kartenzahlung', 'VISA Debitkarte KAUFUMSATZ 14.03', '-42,10'],
    ]);
    const two = ingCsv([
      ['05.03.2026', 'BAECKEREI BEISPIEL FIL. 3', 'Lastschrift', 'Debitkarte Kauf 08:12', '-5,00'],
      ['05.03.2026', 'BAECKEREI BEISPIEL FIL. 3', 'Lastschrift', 'Debitkarte Kauf 16:40', '-5,00'],
      ['14.03.2026', 'Edeka Markt Eimsbuettel', 'Lastschrift', 'Debitkarte Kauf', '-42,10'],
      ['20.03.2026', 'Stadtwerke Beispiel', 'Lastschrift', 'Abschlag Strom 03/2026', '-60,00'],
    ]);
    const snap = await importAll([fileItem('a/umsatz.csv', one), fileItem('b/umsatz_neu.csv', two)]);
    expect(snap.accounts).toHaveLength(1);
    expect(amounts(snap)).toEqual(['2026-03-05|-500', '2026-03-05|-500', '2026-03-14|-4210', '2026-03-20|-6000']);
  });

  it('Kontostand-Dubletten über verschiedene Konten werden NICHT entfernt (gleiche Miete auf zwei Konten mit IBAN)', async () => {
    const rent = [['02.03.2026', 'Hausverwaltung Beispiel', 'Dauerauftrag', 'Mietanteil 03/2026', '-500,00']];
    const snap = await importAll([fileItem('a.csv', ingCsv(rent)), fileItem('b.csv', ingCsv(rent, { iban: 'DE02 5001 0517 0000 0999 99', name: 'Gemeinschaftskonto' }))]);
    expect(snap.accounts).toHaveLength(2);
    expect(snap.transactions).toHaveLength(2);
  });

  // Befund 13: Konto ohne IBAN darf nicht mit dem einzigen Konto derselben Bank/Art zusammengeführt werden,
  // sonst entfernt der Datum+Betrag-Abgleich die gleiche Mietbuchung des anderen Kontos.
  it('Konto ohne IBAN wird nicht mit einem anderen Konto derselben Bank zusammengeführt (Befund 13)', async () => {
    const rent = [['02.03.2026', 'Hausverwaltung Beispiel', 'Dauerauftrag', 'Mietanteil 03/2026', '-500,00']];
    const snap = await importAll([fileItem('a.csv', ingCsv(rent)), fileItem('b.csv', ingCsv(rent, { iban: null, name: 'Gemeinschaftskonto' }))]);
    expect(snap.accounts).toHaveLength(2);
    expect(snap.transactions).toHaveLength(2);
  });
});

describe('Importer: zwei überlappende Dateien parallel (concurrency 2)', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('CSV + PDF desselben Kontos parallel: 125 Buchungen', async () => {
    const snap = await importAll([sample(ING_CSV), sample(ING_PDF)], 2);
    expect(snap.accounts).toHaveLength(1);
    expect(snap.transactions).toHaveLength(125);
  });

  it('gleiche Schreibweise parallel: Dubletten über den gemeinsamen dedupeKey-Satz erkannt', async () => {
    const rows = [['05.03.2026', 'Bäckerei Beispiel', 'Kartenzahlung', 'VISA Debitkarte', '-5,00'], ['14.03.2026', 'EDEKA Markt', 'Kartenzahlung', 'VISA Debitkarte', '-42,10']];
    const snap = await importAll([fileItem('a/u.csv', ingCsv(rows)), fileItem('b/u.csv', ingCsv(rows) + '\r\n')], 2);
    expect(snap.transactions).toHaveLength(2);
  });

  it('CSV + camt mit anderer Schreibweise parallel: 8 Buchungen (Szenario ueberlappung_csv_camt)', async () => {
    const snap = await importAll([scen('ueberlappung_csv_camt/ing_girokonto_2026-01_02.csv'), scen('ueberlappung_csv_camt/camt053_ing_2026-02_03.xml')], 2);
    expect(snap.accounts).toHaveLength(1);
    expect(snap.transactions).toHaveLength(8);
  });
});

describe('Importbericht-Zähler (Datenvertrag: app.progress.dupTx / enrichedTx)', () => {
  it('zählt übersprungene Dubletten und ergänzte Buchungen (jede camt-Buchung genau einmal)', async () => {
    await importAll([sample(ING_CSV), sample(ING_CAMT)]);
    expect(app.progress.dupTx + app.progress.enrichedTx).toBe(21);
    expect(app.progress.newTx).toBe(125);
  });
});
