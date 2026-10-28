// Szenarien gegen Doppelzählung (tests/fixtures/scenarios): echte Parser, echter Importer (saveResult, Konten, Dubletten)
// und echte Nachverarbeitung (Umbuchungen, Kategorien, Belege) auf einer In-Memory-Datenbank; Summen aus computeInsights.
// Erwartungen, die der Code heute noch nicht erfüllt, stehen in OPEN und laufen als it.fails: Wird eine davon erfüllt,
// schlägt der Test fehl – dann den Eintrag aus OPEN entfernen (die Verbesserung ist damit festgeschrieben).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SCENARIOS, runScenario, describeTx } from './helpers/run-scenario.js';

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
const { computeInsights } = await import('../src/lib/analyze/insights.js');

/** Stand Messbasis (Okt. 2026): diese Erwartungen erfüllt der Code noch nicht */
const OPEN = {
  // Einzugsverfahren-Paar markiert beide Seiten als Umbuchung → Händlerzahlung 19,99 fehlt in den Ausgaben (75,90 statt 95,89)
  paypal_einzug: ['expense'],
  // Lastschrift 30,00 bleibt ungepaart und zählt zusätzlich zur PayPal-Zahlung 40,00 (70,00 statt 40,00) – Befund 16
  paypal_mischzahlung_ohne_gutschrift: ['expense'],
  // Giro-Wertpapierkauf und Depot-Umsatz zählen beide als Sparen (2.000,00 statt 1.000,00)
  depot_kauf: ['saving'],
  // Konto ohne IBAN wird mit dem einzigen ING-Konto zusammengeführt; die gleiche Mietbuchung fällt als „Dublette“ weg – Befund 13
  konto_ohne_iban: ['expense', 'transactions', 'accounts'],
};

const LABEL = { expense: 'Ausgaben gesamt', income: 'Einnahmen', saving: 'Sparen', transactions: 'Anzahl Buchungen (keine Doppelzählung)', accounts: 'Anzahl Konten', transferPairs: 'Umbuchungspaare' };

for (const [id, sc] of Object.entries(SCENARIOS)) {
  describe(`Szenario ${id}: ${sc.title}`, () => {
    let r;
    beforeAll(async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      r = await runScenario(id, { db, app, runImport, ensureSource, computeInsights });
    });
    it('Import ohne Fehler', () => { expect(r.errors).toEqual([]); });
    for (const [key, want] of Object.entries(sc.expect)) {
      const test = OPEN[id]?.includes(key) ? it.fails : it;
      test(`${LABEL[key] || key} = ${want}`, () => {
        expect(r[key], `${sc.why}\n${describeTx(r.data)}`).toBe(want);
      });
    }
  });
}
