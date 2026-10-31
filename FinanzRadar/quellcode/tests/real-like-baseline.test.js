// Messbasis „originalnahe Bankdokumente mit Textebene“ (Paket B, Ursache U2): Die Vorlagen in tests/fixtures/real-like
// sind Nachbauten der Nutzerdokumente MIT Textebene; ihre Snapshots stammen aus dem echten pdf.js-Pfad der App
// (scripts/snapshot-real-like.mjs). Hier wird je Dokument IST (detectType + parse) gegen SOLL (EXPECTED.json) geprüft.
//
// Was heute noch nicht klappt, steht in KNOWN_GAPS und läuft als `it.fails` (Suite bleibt grün). Behebt ein Paket
// (C Wertpapier, D Depot-Reporting, E Kontoauszüge) eine Lücke, schlägt der `it.fails`-Fall fehl → Eintrag löschen.
// Protokoll IST vs. SOLL je Prüfung:  REAL_LIKE_REPORT=1 npx vitest run tests/real-like-baseline.test.js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { flagTaxDocument } from '../src/lib/classify/taxFlags.js';
import { extractPdfText, closePdf } from '../src/lib/extract/pdf.js';
import { loadExpected, loadRealLike, realLikeMeta, realLikePdf } from './helpers/realLike.js';

const EXP = loadExpected();
const NAMES = Object.keys(EXP);
const REPORT = !!process.env.REAL_LIKE_REPORT;

/** Heute bekannte Lücken: „<vorlage>: <prüfung>“ – Arbeitsliste für die Pakete C, D, E (siehe Kommentar oben). */
const KNOWN_GAPS = new Set([
]);

const cache = new Map();
async function run(name) {
  if (!cache.has(name)) {
    cache.set(name, (async () => {
      const ex = loadRealLike(name), meta = realLikeMeta(name);
      const det = detectType(ex, meta);
      const res = await parse(det, ex, meta);
      return { det, res, all: [res, ...(res.additional || [])] };
    })());
  }
  return cache.get(name);
}

const sumAmounts = (txs) => txs.reduce((a, t) => a + (t.amount || 0), 0);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

/** Prüfungen je Vorlage aus den Sollwerten: [{ id, get(r) → IST, soll }] */
function checksFor(name, e) {
  const C = [];
  const add = (id, get, soll) => C.push({ id, get, soll });
  add('Typ', (r) => r.det.type, e.type);
  if (e.institution) add('Institut', (r) => r.res.document.institution ?? r.det.institution ?? null, e.institution);
  if (e.type === 'wertpapier') {
    add('Untertyp', (r) => r.res.document.subtype, e.subtype);
    add('Datum', (r) => r.res.document.date, e.date);
    if (e.infoOnly) {
      add('nur Info (kein Betrag, infoOnly)', (r) => ({ amount: r.res.document.amount ?? null, infoOnly: !!r.res.document.fields?.infoOnly }),
        { amount: null, infoOnly: true });
    } else {
      add('Betrag', (r) => r.res.document.amount ?? null, e.amount);
      add('Valuta', (r) => r.res.document.fields?.valuta ?? null, e.valuta);
      if (e.title) add('Titel', (r) => r.res.document.title, e.title);
    }
    for (const [k, v] of Object.entries(e.fields || {})) {
      if (['valuta', 'infoOnly', 'partialFills', 'costItems'].includes(k)) continue;
      add(`Feld ${k}`, (r) => r.res.document.fields?.[k] ?? null, v);
    }
    if (e.fields?.costItems) {
      add('Kostenpositionen', (r) => (r.res.document.fields?.costItems || []).map((c) => pick(c, ['label', 'amount', 'kind'])),
        e.fields.costItems);
    }
    if (e.fields?.partialFills) add('Teilausführungen', (r) => r.res.document.fields?.partialFills ?? null, e.fields.partialFills);
    if ('taxRelevant' in e) add('steuerrelevant', (r) => !!flagTaxDocument(r.res.document).taxRelevant, e.taxRelevant);
    if (e.subtype === 'depotreport') {
      add('Positionen (WKN)', (r) => r.all.flatMap((x) => x.holdings || []).map((h) => h.wkn), e.holdings.map((h) => h.wkn));
      add('Positionen (Anteile, Wert)', (r) => r.all.flatMap((x) => x.holdings || []).map((h) => [h.wkn, h.qty, h.value]),
        e.holdings.map((h) => [h.wkn, h.units, h.value]));
      add('Depotwert zum Stichtag', (r) => r.all.flatMap((x) => x.valuations || []).map((v) => [v.date, v.value]),
        [[e.depot.date, e.depot.value]]);
      add('Liquiditätskonto', (r) => r.all.map((x) => x.account?.iban).filter(Boolean), [e.depot.liquidity.iban]);
      add('Kennzahlen (Einzahlungen, Sparrate, Ergebnis)', (r) => pick(r.res.document.fields, ['deposits', 'savingsRate', 'result']),
        pick(e.figures, ['deposits', 'savingsRate', 'result']));
      add('Transaktionen (Käufe)', (r) => r.all.flatMap((x) => x.transactions || []).length, e.transactionCount);
    }
    if (e.notTaxCert) add('keine Steuerbescheinigung', (r) => r.det.type !== 'steuerbescheinigung', true);
  }
  if (e.type === 'kontoauszug') {
    add('Format', (r) => r.det.format, e.format);
    // Konten mit Buchungen; ein Depotbestand im selben Dokument ist ein eigenes Ergebnis (geprüft unter e.depot)
    add('Konten', (r) => r.all.filter((x) => x.document?.type !== 'depot').length, e.accounts.length);
    e.accounts.forEach((a, i) => {
      const acc = (r) => r.all[i] || { transactions: [] };
      const p = `Konto ${a.name}`;
      add(`${p}: Anzahl Buchungen`, (r) => acc(r).transactions.length, a.count);
      if (a.debitCount != null) {
        add(`${p}: Soll/Haben-Anzahl`, (r) => [acc(r).transactions.filter((t) => t.amount < 0).length, acc(r).transactions.filter((t) => t.amount > 0).length],
          [a.debitCount, a.creditCount]);
        add(`${p}: Summen Soll/Haben`, (r) => [-sumAmounts(acc(r).transactions.filter((t) => t.amount < 0)), sumAmounts(acc(r).transactions.filter((t) => t.amount > 0))],
          [a.debitSum, a.creditSum]);
      }
      add(`${p}: Anfangs-/Endsaldo`, (r) => [acc(r).balance?.opening ?? null, acc(r).balance?.closing ?? null], [a.opening, a.closing]);
      add(`${p}: Saldo geht auf`, (r) => acc(r).balance?.check ?? null, true);
      add(`${p}: Beträge in Reihenfolge`, (r) => acc(r).transactions.map((t) => t.amount), a.transactions.map((t) => t.amount));
      add(`${p}: Buchungsdaten`, (r) => acc(r).transactions.map((t) => t.bookingDate), a.transactions.map((t) => t.bookingDate));
      if (a.iban) add(`${p}: IBAN`, (r) => acc(r).account?.iban ?? null, a.iban);
      if (a.transactions.some((t) => t.counterparty)) {
        // Gegenpartei (bei PayPal der Händler) muss in Name, Rohname oder Verwendungszweck stehen – Leerzeichen und
        // Groß/Klein egal, weil die Bank Namen beim Umbruch zerteilt („MILES Mo bility“)
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
        add(`${p}: Gegenparteien im Text`, (r) => a.transactions.map((t, k) => {
          const tx = acc(r).transactions[k];
          const hay = norm(`${tx?.counterparty}|${tx?.counterpartyRaw}|${tx?.purpose}`);
          return !t.counterparty || hay.includes(norm(t.counterparty).slice(0, 14)) ? 'ok' : `${t.counterparty} ≠ ${tx?.counterparty ?? '–'}`;
        }).filter((x) => x !== 'ok'), []);
      }
    });
    if (e.depot) {
      add('Depotbestand (WKN)', (r) => r.all.flatMap((x) => x.holdings || []).map((h) => h.wkn), e.depot.holdings.map((h) => h.wkn));
      add('Depotbewertung', (r) => r.all.flatMap((x) => x.valuations || []).filter((v) => /depot/i.test(v.label || '')).map((v) => v.value),
        [e.depot.value]);
    }
  }
  return C;
}

describe('Originalnahe Bankdokumente (Textebene, echter pdf.js-Extrakt)', () => {
  it('Snapshots entsprechen dem aktuellen pdf.js-Extrakt der PDFs', async () => {
    for (const name of NAMES) {
      const { pages, doc } = await extractPdfText(fs.readFileSync(realLikePdf(name)));
      await closePdf(doc);
      const snap = loadRealLike(name);
      expect(pages.length, name).toBe(EXP[name].pages);
      expect(pages.map((p) => p.text), name).toEqual(snap.pages.map((p) => p.text));
    }
  });

  for (const name of NAMES) {
    describe(name, () => {
      for (const c of checksFor(name, EXP[name])) {
        const key = `${name}: ${c.id}`;
        const known = KNOWN_GAPS.has(key);
        (known ? it.fails : it)(`${c.id}${known ? ' (bekannte Lücke)' : ''}`, async () => {
          const ist = c.get(await run(name));
          if (REPORT) console.log(`${JSON.stringify(c.soll) === JSON.stringify(ist) ? 'OK  ' : 'FEHL'} ${key}\n     SOLL ${JSON.stringify(c.soll)}\n     IST  ${JSON.stringify(ist)}`);
          expect(ist).toEqual(c.soll);
        });
      }
    });
  }

  it('KNOWN_GAPS nennt nur existierende Prüfungen', () => {
    const all = new Set(NAMES.flatMap((n) => checksFor(n, EXP[n]).map((c) => `${n}: ${c.id}`)));
    expect([...KNOWN_GAPS].filter((k) => !all.has(k))).toEqual([]);
  });
});
