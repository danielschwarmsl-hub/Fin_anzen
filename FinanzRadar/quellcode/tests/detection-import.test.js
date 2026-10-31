// Erkennung & Import: Rechnungsmengen, Summenzeilen, OCR-Bons mit getrennten Preiszeilen, unlesbare Belege,
// Typ-Alternativen, Konto-Zusammenführung ohne IBAN, Dubletten-Zähler, reprocessFile (Datenbank gemockt)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---- In-Memory-Ersatz für die benutzten Dexie-Tabellen (wie tests/store.test.js) ----
function makeTable(key = 'id') {
  const rows = new Map();
  return {
    rows,
    async get(k) { return rows.get(k); },
    async put(r) { rows.set(r[key], structuredClone(r)); },
    async bulkPut(a) { for (const r of a) rows.set(r[key], structuredClone(r)); },
    async bulkUpdate(a) { for (const { key: k, changes } of a) { const r = rows.get(k); if (r) Object.assign(r, structuredClone(changes)); } },
    async bulkDelete(ids) { for (const i of ids) rows.delete(i); },
    async update(k, patch) { const r = rows.get(k); if (r) Object.assign(r, structuredClone(patch)); },
    async toArray() { return [...rows.values()].map(r => structuredClone(r)); },
    async each(fn) { for (const r of [...rows.values()]) fn(structuredClone(r)); },
    where(field) {
      const pick = (pred) => [...rows.values()].filter(r => pred(r[field]));
      const ops = (list) => ({
        toArray: async () => list.map(r => structuredClone(r)),
        primaryKeys: async () => list.map(r => r[key]),
        delete: async () => { for (const r of list) rows.delete(r[key]); },
      });
      return { equals: (v) => ops(pick(x => x === v)), anyOf: (vs) => ops(pick(x => (Array.isArray(vs) ? vs : [vs]).includes(x))) };
    },
    filter(fn) { const list = [...rows.values()].filter(fn); return { delete: async () => { for (const r of list) rows.delete(r[key]); } }; },
  };
}
const fakeDb = {};
for (const n of ['sources', 'files', 'blobs', 'documents', 'accounts', 'transactions', 'lineItems', 'holdings', 'valuations']) fakeDb[n] = makeTable();

vi.mock('../src/lib/store/db.js', () => ({ db: fakeDb }));
vi.mock('../src/lib/store/state.svelte.js', () => ({
  app: { progress: { running: false, paused: false, total: 0, done: 0, current: '', phase: '', errors: [], counts: {}, startedAt: 0, log: [], newDocs: 0, newTx: 0, dupTx: 0, enrichedTx: 0 } },
  reload: vi.fn(async () => {}),
}));
vi.mock('../src/lib/store/postprocess.js', () => ({ postProcess: vi.fn(async () => {}) }));
// Extraktion: Dateiinhalt „IMG:<OCR-Text 1. Versuch>|<OCR-Text 2. Versuch>“ simuliert ein Foto; sonst Textdatei
vi.mock('../src/lib/extract/index.js', () => ({
  terminateOcr: vi.fn(async () => {}),
  extract: vi.fn(async (meta, blob, opts = {}) => {
    const raw = await blob.text();
    if (raw.startsWith('IMG:')) {
      const [first, boosted = ''] = raw.slice(4).split('|');
      const text = (opts.ocrBoost ? boosted : first).replace(/\\n/g, '\n');
      const lines = text.split('\n').filter(l => l.trim()).map((t, i) => ({ y: 1000 - i * 15, text: t, items: [] }));
      return { kind: 'image', text, rawText: null, pages: [{ n: 1, text, lines }], rows: null, xml: null, ocr: true, ocrConfidence: text.trim() ? 82 : 0, thumbnail: null, meta: { pageCount: 1 } };
    }
    return { kind: 'text', text: raw, rawText: raw, pages: [], rows: null, xml: null, ocr: false, ocrConfidence: null, thumbnail: null, meta: {} };
  }),
}));

const { detectType, detectDocumentType, scoreTypes } = await import('../src/lib/detect/index.js');
const { parse, UNREADABLE_REASON } = await import('../src/lib/parsers/index.js');
const { mergeOcrPriceLines } = await import('../src/lib/parsers/docs/util.js');
const { runImport, ensureSource, saveResult, reprocessFile, reprocessStale, reprocessAll, PARSER_VERSION } = await import('../src/lib/store/importer.js');
const { app } = await import('../src/lib/store/state.svelte.js');
const { extract } = await import('../src/lib/extract/index.js');
const { postProcess } = await import('../src/lib/store/postprocess.js');

const FIX = path.resolve(__dirname, 'fixtures');
const textDoc = (text) => ({ kind: 'text', text, rawText: text, pages: [], rows: null, xml: null, ocr: false, ocrConfidence: null, meta: {} });
const run = (ext, name) => { const meta = { name, ext: name.split('.').pop() }; const det = detectType(ext, meta); return { det, r: parse(det, ext, meta) }; };
const reset = () => { for (const t of Object.values(fakeDb)) t.rows.clear(); };

describe('Rechnung: Mengen nur aus echter Mengenangabe, Summenzeilen', () => {
  const INVOICE = [
    'Muster Fliesen GmbH',
    'Rechnungsnummer   RE-2026-17',
    'Rechnungsdatum   05.05.2026',
    'Pos.   Leistung   Betrag EUR',
    '1   Fliesen verlegen Bad   480,00',
    '2   Silikonfugen erneuern   96,00',
    '3   Fliesenkleber Sack   2   34,50   69,00',
    '4   Montage Waschtisch   230,00',
    'Nettobetrag   875,00',
    'zzgl. 19 % Umsatzsteuer   166,25',
    'Rechnungsbetrag   1.041,25 EUR (darin 166,25 MwSt)',
  ].join('\n');

  it('ohne Mengenspalte: Menge 1 und Einzelpreis = Gesamt; Menge nur bei Menge × Preis = Gesamt; Satz für alle Positionen', () => {
    const { det, r } = run(textDoc(INVOICE), 'rechnung.txt');
    expect(det.type).toBe('rechnung');
    expect(r.lineItems.map(i => [i.qty, i.unitPrice, i.total, i.vatRate])).toEqual([
      [1, 48000, 48000, 19], [1, 9600, 9600, 19], [2, 3450, 6900, 19], [1, 23000, 23000, 19],
    ]);
    // Summenbetrag = erster Betrag nach dem Label (nicht der MwSt-Betrag in Klammern)
    expect(r.document.amount).toBe(104125);
    expect(r.document.fields).toMatchObject({ net: 87500, tax: 16625, gross: 104125 });
    expect(r.document.needsReview).toBe(false);
  });

  it('Mengenspalte mit Einheit („3 Std“) zählt auch ohne passendes Produkt; Betrag ist nie Menge', () => {
    const txt = 'Muster Service GmbH\nRechnung Nr. A-1\nDatum 01.02.2026\nArbeitszeit Monteur   3 Std   150,00\nAnfahrt   35,50   35,50\nGesamtbetrag   185,50\n';
    const { r } = run(textDoc(txt), 'r.txt');
    expect(r.lineItems.map(i => [i.text, i.qty, i.unitPrice, i.total])).toEqual([
      ['Arbeitszeit Monteur', 3, 5000, 15000], ['Anfahrt', 1, 3550, 3550],
    ]);
  });

  it('Summenzeile ohne Netto beendet die Positionsliste und wird nie Position', () => {
    const txt = 'Muster Druck GmbH\nRechnung Nr. D-77\nDatum 10.03.2026\nVisitenkarten   35,70\nVersand   23,80\nGesamtbetrag   59,50\nenthaltene MwSt 19 %   9,50\nZahlbar sofort.';
    const { r } = run(textDoc(txt), 'druck.txt');
    expect(r.lineItems.map(i => i.text)).toEqual(['Visitenkarten', 'Versand']);
    expect(r.document.amount).toBe(5950);
    expect(r.document.fields.net).toBe(5000);
    expect(r.lineItems.every(i => i.vatRate === 19)).toBe(true);
  });

  it('Kassenbon: Zwischensumme/Netto beenden die Positionen, Summe = erster Betrag nach dem Label', () => {
    const txt = 'LIDL\nDatum: 01.06.2026 09:15\nBrot 1,99 B\nMilch 1,49 b\nZwischensumme 3,48\nSUMME EUR 3,48 (2 Artikel 0,00 Rabatt)\nBar 5,00\n';
    const lines = txt.split('\n').filter(Boolean).map((t, i) => ({ y: 1000 - i * 10, text: t, items: [] }));
    const ext = { kind: 'image', text: txt, pages: [{ n: 1, text: txt, lines }], ocr: true, ocrConfidence: 80, meta: {} };
    const r = parse({ type: 'kassenbon', confidence: 0.9 }, ext, { name: 'bon.jpg', ext: 'jpg' });
    expect(r.lineItems.map(i => i.text)).toEqual(['Brot', 'Milch']);
    expect(r.document.amount).toBe(348);
    expect(r.document.fields.itemsSumOk).toBe(true);
  });
});

describe('OCR-Kassenbon mit getrennten Preiszeilen (Positionen über y)', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'bon_split.ocr.json'), 'utf8'));
  const text = fx.lines.map(l => l.text).join('\n');
  const ext = { kind: 'image', text, rawText: null, pages: [{ n: 1, text, lines: fx.lines }], rows: null, xml: null, ocr: true, ocrConfidence: fx.ocrConfidence, meta: {} };

  it('Preiszeile hängt an der nächstgelegenen Textzeile; A/B klein; Mengenzeile nur bei Menge × Preis = Gesamt', () => {
    const { det, r } = run(ext, 'bon_penny.jpg');
    expect(det.type).toBe('kassenbon');
    expect(r.lineItems.map(i => [i.text, i.qty, i.unitPrice, i.total, i.vatRate])).toEqual([
      ['Butter', 1, 199, 199, 7],
      ['Milch 3,5%', 1, 115, 115, 7],
      ['Kaffee gemahlen', 1, 599, 599, 19],
      ['Joghurt Natur', 2, 79, 158, 7],
    ]);
    expect(r.document.amount).toBe(1071);
    expect(r.document.fields.itemsSumOk).toBe(true);
    expect(r.document.fields.vatSumOk).toBe(true);
  });

  it('mergeOcrPriceLines: nutzt die Zeilenhöhe h, fasst weit entfernte Zeilen nicht zusammen', () => {
    const lines = [
      { y: 100, h: 10, text: 'Brot' }, { y: 99, h: 10, text: '2,49 A' },
      { y: 80, h: 10, text: 'Butter' }, { y: 60, h: 10, text: '1,99 A' },
    ];
    expect(mergeOcrPriceLines(lines).map(l => l.text)).toEqual(['Brot   2,49 A', 'Butter', '1,99 A']);
    const noY = [{ text: 'Brot' }, { text: '2,49' }];
    expect(mergeOcrPriceLines(noY)).toBe(noY);
  });
});

describe('Unlesbare Belege und Typ-Alternativen', () => {
  it('Bild ohne Text oder mit unsicherer OCR → Dokument „unlesbar“ zur Prüfung; klarer Text ohne Finanzbezug bleibt irrelevant', () => {
    const empty = { kind: 'image', text: '', pages: [], ocr: true, ocrConfidence: 0 };
    const d = detectDocumentType(empty, { name: 'IMG_0815.jpg' });
    expect(d).toMatchObject({ type: 'finanz_sonstiges', subtype: 'unlesbar', unreadable: true });
    const r = parse(d, empty, { name: 'IMG_0815.jpg', ext: 'jpg' });
    expect(r.document).toMatchObject({ type: 'finanz_sonstiges', subtype: 'unlesbar', needsReview: true, reviewReason: UNREADABLE_REASON });

    const blurry = { kind: 'image', text: 'Ae tr0 lmn qrst uvw xyz abcde fghij', pages: [], ocr: true, ocrConfidence: 31 };
    expect(detectDocumentType(blurry, { name: 'scan.jpg' }).subtype).toBe('unlesbar');
    expect(detectDocumentType({ ...blurry, ocrConfidence: 88 }, { name: 'scan.jpg' }).type).toBe('irrelevant');
    const recipe = textDoc('Rezept Pfannkuchen\nZutaten: Mehl, Milch, Eier\nZubereitung: alles verrühren und in der Pfanne backen.');
    expect(detectDocumentType(recipe, { name: 'rezept.txt' }).type).toBe('irrelevant');
  });

  it('alternatives: Zweit-/Drittbester mit Sicherheit; nur bei echter Unsicherheit Prüfhinweis „Typ unsicher – eher X?“', () => {
    const mixed = textDoc('Vertragsbestätigung und Rechnung\nRechnungsnummer 2026-55\nRechnungsdatum 01.02.2026\nMitgliedschaft Fitness\nLaufzeit 12 Monate\nKündigungsfrist 1 Monat\nBetrag 29,90');
    const { det, r } = run(mixed, 'dokument.txt');
    const { scores } = scoreTypes(mixed, { name: 'dokument.txt' });
    expect(Object.keys(scores).sort()).toEqual(['rechnung', 'vertrag']);
    expect(det.alternatives).toHaveLength(1);
    expect(det.alternatives[0].confidence).toBeGreaterThan(0);
    expect(det.alternatives[0].confidence).toBeLessThan(det.confidence);
    expect(det.uncertain).toBe(true);
    expect(r.document.alternatives).toEqual(det.alternatives);
    expect(r.document.needsReview).toBe(true);
    const altName = det.alternatives[0].type === 'vertrag' ? 'Vertrag / Abo' : 'Rechnung';
    expect(r.document.reviewReason).toContain(`Typ unsicher – eher ${altName}?`);

    // Eindeutige Rechnung: Alternativen dürfen vorhanden sein, aber kein Prüfhinweis
    const clear = run(textDoc('Muster GmbH\nRechnung\nRechnungsnummer R-1\nRechnungsdatum 01.01.2026\nNettobetrag 100,00\nzzgl. 19 % MwSt 19,00\nRechnungsbetrag 119,00\nzahlbar bis 15.01.2026\nVertragsnummer 4711'), 'r.txt');
    expect(clear.det.type).toBe('rechnung');
    expect(clear.det.uncertain).toBe(false);
    expect(clear.r.document.reviewReason || '').not.toMatch(/Typ unsicher/);
  });

  it('Wortgrenzen: „Europa“ und „Reisekosten“ zählen nicht als „euro“/„reis“', () => {
    const t = textDoc('Europa-Reise\nReiseplanung Europa: Rom, Paris\nReisekosten grob überschlagen');
    expect(detectDocumentType(t, { name: 'notiz.txt' }).type).toBe('irrelevant');
    const list = textDoc('Reis\nMilch\nEier\nBrot');
    expect(scoreTypes(list, { name: 'liste.txt' }).grocery).toContain('reis');
  });
});

describe('Importer', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  const item = (p, content) => ({ path: p, name: p.split('/').pop(), size: content.length, mtime: '2026-01-01T00:00:00.000Z', ext: p.split('.').pop(), getFile: async () => new File([content], p.split('/').pop()) });
  const src = () => ensureSource({ kind: 'local', name: 'T', root: 'T' });
  const save = (result) => saveResult({ document: { type: 'kontoauszug', title: 'K' }, transactions: [], ...result }, { fileId: 'f1', meta: { ext: 'pdf' }, extracted: { text: '' }, existingKeys: new Set() });

  it('unlesbares Bild: automatischer zweiter OCR-Versuch; bleibt es unlesbar, wird es als Dokument „unlesbar“ gespeichert', async () => {
    const s = await src();
    await runImport([item('Belege/foto.jpg', 'IMG:|')], s);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1][2].ocrBoost).toBe(true);
    const docs = await fakeDb.documents.toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: 'finanz_sonstiges', subtype: 'unlesbar', needsReview: true, reviewReason: 'Beleg nicht lesbar – neu prüfen' });
    expect((await fakeDb.files.toArray())[0].status).toBe('done');
  });

  it('zweiter OCR-Versuch liefert lesbaren Bon → normaler Kassenbon', async () => {
    const s = await src();
    await runImport([item('Belege/bon.jpg', 'IMG:|REWE\\nDatum 12.04.2026\\nBon-Nr. 1\\nBrot 2,49 A\\nSUMME EUR 2,49\\nKartenzahlung 2,49')], s);
    const docs = await fakeDb.documents.toArray();
    expect(docs[0]).toMatchObject({ type: 'kassenbon', amount: 249 });
  });

  it('früher wegen OCR ignorierte Dateien werden beim erneuten Import erneut versucht', async () => {
    const s = await src();
    const it1 = item('Belege/alt.jpg', 'IMG:|');
    const { sha256Hex } = await import('../src/lib/util/format.js');
    const hash = await sha256Hex(await (await it1.getFile()).arrayBuffer());
    await fakeDb.files.put({ id: hash, sourceId: s.id, path: it1.path, name: it1.name, size: it1.size, mtime: it1.mtime, status: 'ignored', detection: { type: 'irrelevant', subtype: 'kein_text' }, origins: [] });
    await fakeDb.files.put({ id: 'other', sourceId: s.id, path: 'Privat/rezept.txt', name: 'rezept.txt', size: 3, mtime: it1.mtime, status: 'ignored', detection: { type: 'irrelevant', subtype: 'kein_finanzbezug' }, origins: [] });
    const it2 = item('Privat/rezept.txt', 'abc');
    it2.getFile = vi.fn(it2.getFile);
    await runImport([it1, it2], s);
    expect(it2.getFile).not.toHaveBeenCalled();
    expect((await fakeDb.files.get(hash)).status).toBe('done');
    expect((await fakeDb.documents.toArray())[0].subtype).toBe('unlesbar');
  });

  it('Konto ohne IBAN: andere Bank → eigenes Konto; gleiche Bank + Name → zusammenführen; nur unsicherer Kandidat → eigenes Konto + Prüfhinweis', async () => {
    await save({ account: { kind: 'giro', institution: 'ING', name: 'ING Girokonto', iban: 'DE02500105170137075030' } });
    await save({ account: { kind: 'giro', institution: 'Sparkasse', name: 'Sparkasse Girokonto', iban: null } });
    expect(fakeDb.accounts.rows.size).toBe(2);
    await save({ account: { kind: 'giro', institution: 'ING', name: 'ING Girokonto', iban: null } });
    expect(fakeDb.accounts.rows.size).toBe(2);
    await save({ account: { kind: 'giro', institution: 'ING', name: 'ING Zweitkonto', iban: null } });
    expect(fakeDb.accounts.rows.size).toBe(3);
    const docs = await fakeDb.documents.toArray();
    expect(docs.map(d => !!d.needsReview)).toEqual([false, false, false, true]);
    expect(docs[3].reviewReason).toBe('Konto zugeordnet? bitte prüfen');
    // Neues Dokument mit IBAN, bestehendes Konto ohne IBAN mit gleichem Namen → zusammenführen und IBAN ergänzen
    await save({ account: { kind: 'giro', institution: 'Sparkasse', name: 'Sparkasse Girokonto', iban: 'DE89370400440532013000' } });
    expect(fakeDb.accounts.rows.size).toBe(3);
    expect((await fakeDb.accounts.toArray()).find(a => a.institution === 'Sparkasse').iban).toBe('DE89370400440532013000');
  });

  it('Dubletten-Zähler: dupTx (übersprungen) und enrichedTx (ergänzt)', async () => {
    Object.assign(app.progress, { newTx: 0, dupTx: 0, enrichedTx: 0, newDocs: 0 });
    const account = { kind: 'giro', institution: 'ING', name: 'ING Girokonto', iban: 'DE02500105170137075030' };
    const tx = (k, extra = {}) => ({ bookingDate: '2026-03-01', amount: -1000, dedupeKey: k, ...extra });
    const keys = new Set();
    const opts = { fileId: 'f1', meta: { ext: 'csv' }, extracted: { text: '' }, existingKeys: keys };
    await saveResult({ document: { type: 'kontoauszug' }, account, transactions: [tx('a'), { ...tx('b'), amount: -500 }] }, opts);
    expect(app.progress.newTx).toBe(2);
    await saveResult({ document: { type: 'kontoauszug' }, account, transactions: [tx('a')] }, opts); // gleicher Schlüssel
    await saveResult({ document: { type: 'kontoauszug' }, account, transactions: [{ ...tx('x'), amount: -500, counterpartyIban: 'DE89370400440532013000' }] }, opts); // anderes Format, ergänzt
    await saveResult({ document: { type: 'kontoauszug' }, account, transactions: [tx('y')] }, opts); // anderes Format, nichts Neues
    expect(app.progress).toMatchObject({ newTx: 2, dupTx: 2, enrichedTx: 1 });
    expect((await fakeDb.transactions.toArray()).find(t => t.amount === -500).counterpartyIban).toBe('DE89370400440532013000');
  });

  it('reprocessFile: liest den gespeicherten Inhalt neu, ersetzt die alten Daten, Typ vom Nutzer; danach Nachverarbeitung', async () => {
    const s = await src();
    const txt = 'Muster GmbH\nRechnung\nRechnungsnummer R-9\nRechnungsdatum 01.01.2026\nBeratung   100,00\nNettobetrag 100,00\nzzgl. 19 % MwSt 19,00\nRechnungsbetrag 119,00\n';
    await runImport([item('Belege/r.txt', txt)], s);
    const [file] = await fakeDb.files.toArray();
    const [oldDoc] = await fakeDb.documents.toArray();
    expect(oldDoc.type).toBe('rechnung');
    expect(fakeDb.lineItems.rows.size).toBe(1);
    postProcess.mockClear();
    await fakeDb.documents.update(oldDoc.id, { aiHint: 'Fitnessstudio', aiAt: '2026-05-01T00:00:00.000Z', aiSuggestion: { type: 'rechnung' } });

    await reprocessFile(file.id, { forceType: 'vertrag' });
    const docs = await fakeDb.documents.toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0].id).not.toBe(oldDoc.id);
    expect(docs[0].type).toBe('vertrag');
    // KI-Hinweise bleiben, der KI-Typvorschlag ist durch die Nutzerwahl überholt
    expect(docs[0]).toMatchObject({ aiHint: 'Fitnessstudio', aiAt: '2026-05-01T00:00:00.000Z' });
    expect(docs[0].aiSuggestion).toBeUndefined();
    expect(fakeDb.lineItems.rows.size).toBe(0);
    expect((await fakeDb.files.get(file.id))).toMatchObject({ status: 'done', detection: { type: 'vertrag', forced: true } });
    expect(postProcess).toHaveBeenCalledTimes(1);

    await reprocessFile(file.id, { ocrBoost: true });
    expect(extract.mock.calls.at(-1)[2].ocrBoost).toBe(true);
    expect((await fakeDb.documents.toArray())[0].type).toBe('rechnung');
    await expect(reprocessFile('gibt-es-nicht')).rejects.toThrow(/nicht gefunden/);
  });

  it('Nutzer wählt „Kontoauszug“: Datei wird als Kontoauszug mit Buchungen verarbeitet, auch wenn die Erkennung anders lautet', async () => {
    const s = await src();
    const img = 'IMG:Gehaltsabrechnung Lohnsteuer Brutto Netto\\nDatum Erläuterung Betrag EUR\\n02.01.2025 Gutschrift Arbeitgeber GmbH 2.850,00\\n03.01.2025 Lastschrift Stadtwerke -85,00\\nKontostand am 31.01.2025 2.765,00';
    await runImport([item('Banken/dkb.png', img)], s);
    const [file] = await fakeDb.files.toArray();
    expect((await fakeDb.documents.toArray())[0].type).not.toBe('kontoauszug');
    await reprocessFile(file.id, { forceType: 'kontoauszug' });
    const docs = await fakeDb.documents.toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0].type).toBe('kontoauszug');
    const txs = (await fakeDb.transactions.toArray()).map(t => t.amount).sort((a, b) => a - b);
    expect(txs).toEqual([-8500, 285000]);
    expect(fakeDb.accounts.rows.size).toBe(1);
  });

  it('Update auf Version 4: früher falsch erkannte Wertpapier-Dokumente neu lesen, echte Rechnungen nicht', async () => {
    const s = await src();
    const rech = 'Muster GmbH\nRechnung\nRechnungsnummer R-9\nRechnungsdatum 01.01.2026\nBeratung   100,00\nRechnungsbetrag 100,00\n';
    const div = 'comdirect\nGutschrift fälliger Wertpapier-Erträge\nDividendengutschrift\nDepotbestand per 19.08.2026 STK 5,000 Microsoft Corp.\nBruttobetrag: USD 4,55\nVerrechnung über Konto (IBAN) Valuta Zu Ihren Gunsten vor Steuern\nDE00 EUR 14.09.2026 EUR 3,32\n';
    await runImport([item('Belege/r.txt', rech), item('Belege/d.txt', div)], s);
    const docs = await fakeDb.documents.toArray();
    const d = docs.find(x => x.type === 'wertpapier');
    expect(d).toBeTruthy();
    await fakeDb.documents.update(d.id, { type: 'rechnung' }); // simuliert: alte Version hielt die Dividende für eine Rechnung
    const store = new Map([['parserVersion', 3]]);
    const io = { getSetting: async (k, f) => (store.has(k) ? store.get(k) : f), setSetting: async (k, v) => { store.set(k, v); } };
    extract.mockClear();
    expect(await reprocessStale(io)).toEqual({ done: 1, failed: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect((await fakeDb.documents.toArray()).filter(x => x.type === 'wertpapier')).toHaveLength(1);
  });

  it('nach Update: nur verdächtige Altimporte neu lesen (lange Nicht-Kontoauszüge, Kontoauszüge ohne Buchungen), einmal je Version', async () => {
    const s = await src();
    const txt = 'Muster GmbH\nRechnung\nRechnungsnummer R-9\nRechnungsdatum 01.01.2026\nBeratung   100,00\nRechnungsbetrag 100,00\n';
    await runImport([item('Belege/a.txt', txt), item('Belege/b.txt', txt.replace('R-9', 'R-10'))], s);
    const docs = await fakeDb.documents.toArray();
    expect(docs).toHaveLength(2);
    await fakeDb.documents.update(docs[0].id, { pages: 69 }); // simuliert: langes Dokument, falsch als Rechnung erkannt
    const store = new Map([['parserVersion', 1]]);
    const io = { getSetting: async (k, f) => (store.has(k) ? store.get(k) : f), setSetting: async (k, v) => { store.set(k, v); } };
    extract.mockClear();
    const r = await reprocessStale(io);
    expect(r).toEqual({ done: 1, failed: 0 });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(store.get('parserVersion')).toBe(PARSER_VERSION);
    expect(await reprocessStale(io)).toEqual({ done: 0, failed: 0 });
    const all = await reprocessAll();
    expect(all).toEqual({ done: 2, failed: 0 });
  });

  it('Neu einlesen behält Nutzerentscheidungen an Buchungen (Kategorie, Notiz, geprüft)', async () => {
    const s = await src();
    const img = 'IMG:Gehaltsabrechnung Lohnsteuer Brutto Netto\\nDatum Erläuterung Betrag EUR\\n02.01.2025 Gutschrift Arbeitgeber GmbH 2.850,00\\n03.01.2025 Lastschrift Stadtwerke -85,00\\nKontostand am 31.01.2025 2.765,00';
    await runImport([item('Banken/dkb2.png', img)], s);
    const [file] = await fakeDb.files.toArray();
    await reprocessFile(file.id, { forceType: 'kontoauszug' });
    const t = (await fakeDb.transactions.toArray()).find(x => x.amount === -8500);
    await fakeDb.transactions.update(t.id, { category: 'wohnen', subcategory: 'wasser', categorySource: 'user', confidence: 1, note: 'Wasser Abschlag', reviewed: true, needsReview: false });
    await reprocessFile(file.id, { forceType: 'kontoauszug' });
    const after = (await fakeDb.transactions.toArray()).find(x => x.amount === -8500);
    expect(after.id).not.toBe(t.id);
    expect(after).toMatchObject({ category: 'wohnen', subcategory: 'wasser', categorySource: 'user', note: 'Wasser Abschlag', reviewed: true });
  });

  it('KI-Typerkennung: typeSource/aiReason/alternatives ins Dokument, Prüfhinweis; typeSource in files.detection', async () => {
    const { aiHooks } = await import('../src/lib/ai/hooks.js');
    const prev = aiHooks.detect;
    aiHooks.detect = vi.fn(async (ex, meta, det) => ({ ...det, type: 'vertrag', confidence: 0.7, typeSource: 'ai', aiReason: 'Abo-Bestätigung', alternatives: [{ type: 'rechnung', confidence: 0.2 }], needsReview: true }));
    try {
      const s = await src();
      await runImport([item('Privat/notiz.txt', 'Bitte den Betrag für die Zahlung im nächsten Monat prüfen und ablegen.')], s);
      expect(aiHooks.detect).toHaveBeenCalledTimes(1);
      const [doc] = await fakeDb.documents.toArray();
      expect(doc).toMatchObject({ type: 'vertrag', typeSource: 'ai', aiReason: 'Abo-Bestätigung', needsReview: true });
      expect(doc.reviewReason).toContain('KI hat den Dokumenttyp bestimmt – bitte prüfen');
      const [file] = await fakeDb.files.toArray();
      expect(file.detection.typeSource).toBe('ai');
      // Nutzerwahl: keine KI, keine erneute Erkennung
      aiHooks.detect.mockClear();
      await reprocessFile(file.id, { forceType: 'rechnung' });
      expect(aiHooks.detect).not.toHaveBeenCalled();
      expect((await fakeDb.files.get(file.id)).detection).toMatchObject({ type: 'rechnung', typeSource: 'user' });
    } finally { aiHooks.detect = prev; }
  });
});
