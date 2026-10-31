// Wertpapier-Abrechnungen auf Textebene (Paket C): Formulierungsvarianten, gesperrt gesetzte Überschriften, Abgrenzung
// zur Steuerbescheinigung, Kosteninformation und plausible Titel. Grundlage: originalnahe Vorlagen (tests/fixtures/real-like)
// und daraus abgewandelte Texte.
import { describe, it, expect } from 'vitest';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { securitySubtype, unspace } from '../src/lib/parsers/docs/securities.js';
import { loadRealLike } from './helpers/realLike.js';

const textDoc = (text) => ({ kind: 'pdf', ocr: false, ocrConfidence: null, pages: [{ n: 1, text }], text });
/** Vorlage als reiner Text (ohne Zeilen-Items), Text vorher abgewandelt */
const variant = (name, fn) => {
  const ex = loadRealLike(name);
  const pages = ex.pages.map((p) => ({ n: p.n, text: fn(p.text) }));
  return { ...ex, pages, text: pages.map((p) => p.text).join('\n') };
};

async function run(ex, name = 'dokument.pdf') {
  const meta = { name, ext: 'pdf' };
  const det = detectType(ex, meta);
  const r = await parse(det, ex, meta);
  return { det, doc: r.document };
}

const SPACED = (s) => s.split(' ').map((w) => w.split('').join(' ')).join('  ');

describe('Gesperrt gesetzte Überschriften', () => {
  it('unspace zieht Einzelbuchstaben zusammen, zwei Leerzeichen bleiben Wortgrenze', () => {
    expect(unspace('K E I N E  S T E U E R B E S C H E I N I G U N G')).toBe('KEINE  STEUERBESCHEINIGUNG');
    expect(unspace('G u t s c h r i f t f ä l l i g e r W e r t p a p i e r - E r t r ä g e')).toBe('GutschriftfälligerWertpapier-Erträge');
    // kurze Folgen und Ziffern bleiben (OCR-Fetzen, IBAN)
    expect(unspace('Stk. 3 a N, WKN / ISIN')).toBe('Stk. 3 a N, WKN / ISIN');
    expect(unspace('5 5 5 5 EUR 14.09.2026')).toBe('5 5 5 5 EUR 14.09.2026');
  });

  it('Ertragsgutschrift nur mit gesperrter Überschrift bleibt Dividende', async () => {
    const ex = variant('comdirect_ertragsgutschrift', (t) => t.replace(/^Ertragsgutschrift$/m, '').replace(/Abrechnung Ertragsgutschrift/, 'Abrechnung'));
    expect(ex.text).not.toMatch(/Ertragsgutschrift/);
    expect(securitySubtype(ex.text)).toBe('dividende');
    const { det, doc } = await run(ex);
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('dividende');
    expect(doc.amount).toBe(3484);
  });

  it.each([
    ['zwei Leerzeichen zwischen den Wörtern', (t) => t.replace(/KEINE STEUERBESCHEINIGUNG/g, SPACED('KEINE STEUERBESCHEINIGUNG'))],
    ['ein Leerzeichen zwischen den Wörtern', (t) => t.replace(/KEINE STEUERBESCHEINIGUNG/g, 'KEINE STEUERBESCHEINIGUNG'.split('').join(' ').replace(/ {3}/g, ' '))],
  ])('„K E I N E  S T E U E R B E S C H E I N I G U N G“ (%s) zählt nicht als Steuerbescheinigung', async (_, fn) => {
    const ex = variant('comdirect_wertpapierkauf', fn);
    expect(ex.text).not.toMatch(/KEINE STEUERBESCHEINIGUNG/);
    const { det, doc } = await run(ex);
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kauf');
    expect(det.alternatives.find((a) => a.type === 'steuerbescheinigung')?.confidence ?? 0).toBeLessThan(0.3);
    expect(doc.amount).toBe(-107730);
  });

  it('gesperrte Jahressteuerbescheinigung bleibt Steuerbescheinigung', async () => {
    const text = `Musterbank AG\n${SPACED('JAHRESSTEUERBESCHEINIGUNG')} 2025\nKapitalerträge EUR 300,00\nKapitalertragsteuer EUR 75,00\nFreistellungsauftrag EUR 0,00`;
    const { det } = await run(textDoc(text));
    expect(det.type).toBe('steuerbescheinigung');
  });
});

describe('Abrechnung mit Steuerseite bleibt Wertpapier', () => {
  it('ohne „KEINE STEUERBESCHEINIGUNG“: Steuerliche Behandlung, Kapitalertragsteuer 0,00, Verrechnungssalden, Freistellungsauftrag', async () => {
    const ex = variant('comdirect_wertpapierkauf', (t) => t.replace(/KEINE STEUERBESCHEINIGUNG/g, ''));
    expect(ex.text).toMatch(/Freistellungsauftrag/);
    const { det } = await run(ex);
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kauf');
  });

  it('einzelne Steuerseite (Steuermitteilung) eines Verkaufs: Wertpapier, WKN aus „WKN / ISIN: … / …“', async () => {
    const ex = loadRealLike('comdirect_wertpapierverkauf');
    const page = ex.pages[1];
    const { det, doc } = await run({ ...ex, pages: [page], text: page.text });
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('verkauf');
    expect(doc.amount).toBe(215238);
    expect(doc.fields).toMatchObject({ wkn: '723610', isin: 'DE0007236101', quantity: 12, valuta: '2026-06-10', taxPaid: 8240 });
  });
});

describe('Varianten der Abrechnung', () => {
  it('Teilausführung: Zusammenfassung zählt, Einzelausführungen als partialFills', async () => {
    const { doc } = await run(loadRealLike('comdirect_wertpapierkauf_alt'));
    expect(doc.fields).toMatchObject({
      quantity: 50, price: 4812, marketValue: 240600, fees: 1140, wkn: '555200', security: 'Deutsche Post AG',
      partialFills: [{ nr: '91 228014', quantity: 20 }, { nr: '91 228015', quantity: 30 }],
    });
  });

  it('Fondskauf „Zum Rücknahmepreis von“ mit Bruchstücken', async () => {
    const text = `comdirect bank AG
GESCHÄFTSABRECHNUNG VOM 02.04.2026
Wertpapierkauf
Geschäftstag   : 02.04.2026   Börsenplatz   : Fondsgesellschaft
Wertpapier-Bezeichnung   WPKNR/ISIN
Nordlicht Dividenden-Fonds   A2NL7D
Inhaber-Anteile A   DE000A2NL7D2
Nennwert   Zum Rücknahmepreis von
St.   12,345   EUR   81,0300
Kurswert   : EUR   1.000,32
IBAN   Valuta   Zu Ihren Lasten
DE25 2004 1133 0007 3400 61   EUR   06.04.2026   EUR   1.000,32`;
    const { det, doc } = await run(textDoc(text));
    expect(det.type).toBe('wertpapier');
    expect(det.subtype).toBe('kauf');
    expect(doc.amount).toBe(-100032);
    expect(doc.fields).toMatchObject({ quantity: 12.345, price: 8103, wkn: 'A2NL7D', security: 'Nordlicht Dividenden-Fonds', venue: 'Fondsgesellschaft', valuta: '2026-04-06' });
    expect(doc.title).toBe('Wertpapierkauf Nordlicht Dividenden-Fonds 1.000,32 €');
  });

  it('OCR-Rauschen statt Wertpapiername: Titel mit Bank statt Fetzen', async () => {
    const text = `comdirect
GESCHÄFTSABRECHNUNG VOM 19.08.2026
Wertpapierkauf
Geschäftstag : 19.08.2026 Ausführungsplatz : TRADEGATE
Wertpapier-Bezeichnung WPKNR/ISIN
al a 1 3,32
MEN MM Registered Shares DL
IBAN Valuta Zu Ihren Lasten vor Steuern
a 5 5 5 EN vr 21.08.2026 EUR 1.077,30`;
    const { doc } = await run({ ...textDoc(text), ocr: true, ocrConfidence: 75 });
    expect(doc.fields.security).toBeNull();
    expect(doc.title).toBe('Wertpapierkauf comdirect 1.077,30 €');
  });
});

describe('Kosteninformation', () => {
  it('Kosten je Position, Abschnittssummen, Gesamtkosten, Haltedauer, Renditeminderung', async () => {
    const { doc } = await run(loadRealLike('comdirect_kosteninfo_kauf_spesen'));
    expect(doc.amount).toBeNull();
    expect(doc.fields).toMatchObject({
      security: 'Linde plc Registered Shares EO -,001 DATA 10', wkn: 'A3D7VW', marketValue: 120900, orderCosts: 1532,
      buyCosts: 1532, sellCosts: 1532, holdingCostsPerYear: 0, totalCosts: 3064, holdingYears: 5, yieldReductionPct: 0.51, infoOnly: true,
    });
    expect(doc.fields.costItems.map((c) => c.kind)).toEqual(['F', 'E', 'E', 'E']);
    expect(doc.title).toBe('Kosteninformation Wertpapierkauf Linde plc Registered Shares EO -,001 DATA 10');
  });

  it('Verkauf: Positionen aus dem Abschnitt „Kosten des Wertpapierverkaufes“', async () => {
    const text = `comdirect
Kosteninformation zum Wertpapiergeschäft   03.02.2026 - 09:12 Uhr
Siemens AG Namens-Aktien o.N.
WKN: 723610
Verkauf: 12 Stück zu 187,35 EUR
Kurswert: 2.248,20 EUR
Ausführungsplatz: Xetra
Kosten des Wertpapierverkaufes   13,42 EUR
Abwicklungsentgelt "Clearstream" / "Streifband" [E]   2,90 EUR
Orderprovision [E]   10,52 EUR
Kosten während der Haltedauer (pro Jahr)   0,00 EUR
Depotentgelt [E]   0,00 EUR`;
    const { det, doc } = await run(textDoc(text));
    expect(det.subtype).toBe('kosteninfo');
    expect(doc.fields).toMatchObject({ side: 'verkauf', security: 'Siemens AG Namens-Aktien o.N.', sellCosts: 1342, buyCosts: null, holdingCostsPerYear: 0 });
    expect(doc.fields.costItems).toEqual([
      { label: 'Abwicklungsentgelt "Clearstream" / "Streifband" [E]', amount: 290, kind: 'E' },
      { label: 'Orderprovision [E]', amount: 1052, kind: 'E' },
    ]);
    expect(doc.title).toBe('Kosteninformation Wertpapierverkauf Siemens AG Namens-Aktien o.N.');
  });
});
