// Importer, Postprocess-Helfer, Suche und KI-Validierung – ohne Browser (Datenbank und Pipeline sind gemockt)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- In-Memory-Ersatz für die benutzten Dexie-Tabellen ----
function makeTable(key = 'id') {
  const rows = new Map();
  const t = {
    rows,
    async get(k) { return rows.get(k); },
    async put(r) { rows.set(r[key], structuredClone(r)); },
    async bulkPut(a) { for (const r of a) rows.set(r[key], structuredClone(r)); },
    async bulkDelete(ids) { for (const i of ids) rows.delete(i); },
    async update(k, patch) { const r = rows.get(k); if (r) Object.assign(r, structuredClone(patch)); },
    async toArray() { return [...rows.values()].map(r => structuredClone(r)); },
    async each(fn) { for (const r of [...rows.values()]) fn(structuredClone(r)); },
    async clear() { rows.clear(); },
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
  return t;
}
const fakeDb = {};
for (const n of ['sources', 'files', 'blobs', 'documents', 'accounts', 'transactions', 'lineItems', 'holdings', 'valuations']) fakeDb[n] = makeTable();

vi.mock('../src/lib/store/db.js', () => ({ db: fakeDb }));
vi.mock('../src/lib/store/state.svelte.js', () => ({
  app: { progress: { running: false, paused: false, total: 0, done: 0, current: '', phase: '', errors: [], counts: {}, startedAt: 0, log: [] } },
  reload: vi.fn(async () => {}),
}));
vi.mock('../src/lib/store/postprocess.js', () => ({ postProcess: vi.fn(async () => {}) }));
vi.mock('../src/lib/extract/index.js', () => ({
  terminateOcr: vi.fn(async () => {}),
  extract: vi.fn(async (meta, blob, opts) => {
    const text = await blob.text();
    await new Promise(r => setTimeout(r, /SLOW/.test(text) ? 40 : 3));
    opts.signal?.throwIfAborted();
    if (/BOOM/.test(text)) throw Object.assign(new Error('kaputt'), { name: 'InvalidPDFException' });
    if (/QUOTA/.test(text)) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    return { kind: 'text', text, rawText: text, pages: [], rows: null, xml: null, ocr: false, ocrConfidence: null, thumbnail: null, meta: {} };
  }),
}));
vi.mock('../src/lib/detect/index.js', () => ({ detectType: vi.fn((ex) => ({ type: /IRRELEVANT/.test(ex.text) ? 'irrelevant' : 'rechnung', format: null, institution: null, confidence: 0.9 })) }));
vi.mock('../src/lib/parsers/index.js', () => ({
  parse: vi.fn(async (det, ex) => ({
    document: { type: det.type, title: ex.text.slice(0, 20), date: '2026-01-01' },
    account: null,
    transactions: [],
    lineItems: Array.from({ length: /MANY/.test(ex.text) ? 5000 : 1 }, (_, i) => ({ text: 'p' + i, total: 100 })),
  })),
}));
vi.mock('../src/lib/parsers/naming.js', () => ({ displayName: () => 'doc' }));

const { runImport, ensureSource, pauseImport, resumeImport, cancelImport, errorText } = await import('../src/lib/store/importer.js');
const { app } = await import('../src/lib/store/state.svelte.js');
const { terminateOcr } = await import('../src/lib/extract/index.js');

const item = (path, content, extra = {}) => ({ path, name: path.split('/').pop(), size: content.length, mtime: extra.mtime ?? '2026-01-01T00:00:00.000Z', ext: path.split('.').pop(), getFile: async () => new File([content], path.split('/').pop()) });
const reset = () => { for (const t of Object.values(fakeDb)) t.rows.clear(); };
const src = () => ensureSource({ kind: 'local', name: 'T', root: 'T' });

describe('importer', () => {
  beforeEach(() => { reset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('legt Dubletten (gleicher Inhalt, andere Ordner) auch bei parallelen Workern nur einmal an und merkt sich jeden Pfad', async () => {
    const s = await src();
    const items = ['A/x.txt', 'B/x.txt', 'C/x.txt', 'D/x.txt', 'E/y.txt'].map((p, i) => item(p, i === 4 ? 'other' : 'same content'));
    await runImport(items, s, { concurrency: 3 });
    expect(fakeDb.documents.rows.size).toBe(2);
    const files = await fakeDb.files.toArray();
    const same = files.find(f => f.origins.length > 1);
    expect(same.origins.map(o => o.path).sort()).toEqual(['A/x.txt', 'B/x.txt', 'C/x.txt', 'D/x.txt']);
    expect(app.progress.skipped).toBe(3);
  });

  it('Fehler einzelner Dateien landen in progress.errors, die übrigen werden trotzdem importiert; Status „error“ statt „processing“', async () => {
    const s = await src();
    await runImport([item('a.txt', 'ok 1'), item('b.pdf', 'BOOM'), item('c.txt', 'ok 2')], s);
    expect(app.progress.errors).toHaveLength(1);
    expect(app.progress.errors[0]).toEqual({ name: 'b.pdf', error: 'Keine gültige PDF-Datei' });
    expect(fakeDb.documents.rows.size).toBe(2);
    const statuses = (await fakeDb.files.toArray()).map(f => f.status).sort();
    expect(statuses).toEqual(['done', 'done', 'error']);
    expect(app.progress.running).toBe(false);
  });

  it('Neuimport: bekannte Dateien (auch Dubletten-Pfade) werden übersprungen, fehlgeschlagene erneut versucht', async () => {
    const s = await src();
    const items = [item('A/x.txt', 'same'), item('B/x.txt', 'same'), item('bad.pdf', 'BOOM'), item('m.txt', 'mtime', { mtime: 0 })];
    await runImport(items, s);
    items.forEach(i => { const g = i.getFile; i.getFile = vi.fn(g); });
    await runImport(items, s);
    expect(items[0].getFile).not.toHaveBeenCalled();
    expect(items[1].getFile).not.toHaveBeenCalled(); // Dubletten-Pfad ist bekannt
    expect(items[3].getFile).not.toHaveBeenCalled(); // mtime 0 / null stimmt überein
    expect(items[2].getFile).toHaveBeenCalledTimes(1); // Fehler wird erneut versucht
    expect(app.progress.skipped).toBe(3);
  });

  it('Neuimport einer „processing“-Leiche (Absturz) räumt Teildaten weg und liest die Datei neu', async () => {
    const s = await src();
    const content = 'half way';
    const buf = await new File([content], 'h.txt').arrayBuffer();
    const { sha256Hex } = await import('../src/lib/util/format.js');
    const hash = await sha256Hex(buf);
    await fakeDb.files.put({ id: hash, sourceId: s.id, path: 'h.txt', name: 'h.txt', status: 'processing', origins: [] });
    await fakeDb.documents.put({ id: 'doc_old', fileId: hash });
    await fakeDb.transactions.put({ id: 'tx_old', documentId: 'doc_old', dedupeKey: 'k1' });
    await runImport([item('h.txt', content)], s);
    expect(fakeDb.documents.rows.has('doc_old')).toBe(false);
    expect(fakeDb.transactions.rows.size).toBe(0);
    expect(fakeDb.documents.rows.size).toBe(1);
    expect((await fakeDb.files.get(hash)).status).toBe('done');
  });

  it('Pause hält alle Worker an, Weiter lässt alle weiterlaufen', async () => {
    const s = await src();
    const items = Array.from({ length: 12 }, (_, i) => item(`f${i}.txt`, 'SLOW content ' + i));
    const run = runImport(items, s, { concurrency: 3 });
    await vi.waitFor(() => expect(app.progress.done).toBeGreaterThan(0));
    pauseImport();
    await new Promise(r => setTimeout(r, 120)); // laufende Dateien dürfen noch fertig werden
    const frozen = app.progress.done;
    await new Promise(r => setTimeout(r, 60));
    expect(app.progress.done).toBe(frozen);
    expect(frozen).toBeLessThan(12);
    resumeImport();
    await run;
    expect(app.progress.done).toBe(12);
    expect(fakeDb.documents.rows.size).toBe(12);
  });

  it('Abbrechen im Pause-Zustand beendet den Lauf (kein Hängenbleiben); abgebrochene Datei wird beim nächsten Mal erneut gelesen', async () => {
    const s = await src();
    const items = Array.from({ length: 10 }, (_, i) => item(`g${i}.txt`, 'SLOW content g' + i));
    const run = runImport(items, s, { concurrency: 3 });
    await vi.waitFor(() => expect(app.progress.done).toBeGreaterThan(0));
    pauseImport();
    await new Promise(r => setTimeout(r, 30));
    cancelImport();
    await run;
    expect(app.progress.running).toBe(false);
    expect(app.progress.paused).toBe(false);
    expect((await fakeDb.files.toArray()).filter(f => f.status === 'processing')).toHaveLength(0);
    const before = fakeDb.documents.rows.size;
    expect(before).toBeLessThan(10);
    await runImport(items, s);
    expect(fakeDb.documents.rows.size).toBe(10);
  });

  it('begrenzt Positionen je Dokument und überspringt leere Dateien', async () => {
    const s = await src();
    await runImport([item('big.txt', 'MANY lines'), item('empty.txt', '')], s);
    expect(fakeDb.lineItems.rows.size).toBe(500);
    const empty = (await fakeDb.files.toArray()).find(f => f.name === 'empty.txt');
    expect(empty.status).toBe('ignored');
    expect(fakeDb.blobs.rows.has(empty.id)).toBe(false);
  });

  it('Speicher voll beendet den Import mit klarer Meldung', async () => {
    const s = await src();
    await runImport(Array.from({ length: 6 }, (_, i) => item(`q${i}.txt`, i === 1 ? 'QUOTA' : 'fine ' + i)), s, { concurrency: 1 });
    expect(app.progress.errors.map(e => e.error)).toContain('Speicher des Browsers voll');
    expect(app.progress.errors.some(e => e.name === 'Speicher')).toBe(true);
    expect(app.progress.done).toBeLessThan(6);
  });

  it('beendet den OCR-Worker nach dem Import', async () => {
    terminateOcr.mockClear();
    await runImport([item('o.txt', 'x')], await src());
    expect(terminateOcr).toHaveBeenCalled();
  });

  it('Quellenfehler (Aufzählung bricht ab) wird gemeldet, bereits gesammelte Dateien laufen weiter', async () => {
    async function* gen() { yield item('ok.txt', 'fine'); throw new Error('Netzwerk weg'); }
    await runImport(gen(), await src());
    expect(app.progress.errors[0].error).toMatch(/Netzwerk weg/);
    expect(fakeDb.documents.rows.size).toBe(1);
  });
});

describe('errorText', () => {
  it('übersetzt bekannte Fehlerarten und überlebt Nicht-Error-Objekte', () => {
    expect(errorText({ name: 'PasswordException', message: 'No password given' })).toBe('PDF ist passwortgeschützt');
    expect(errorText({ name: 'NotReadableError', message: 'x' })).toMatch(/nicht lesbar/);
    expect(errorText({ code: 2, message: 'ERR_LIBHEIF format not supported' })).toMatch(/HEIC/);
    expect(errorText({ code: 7 })).toBe('{"code":7}');
    expect(errorText('einfach Text')).toBe('einfach Text');
    expect(errorText(new Error('boom'))).toBe('boom');
  });
});

describe('postprocess-Helfer', () => {
  it('mergeContracts vergibt jede alte ID nur einmal (mehrere Betragsgruppen desselben Anbieters fallen nicht zusammen)', async () => {
    const { mergeContracts } = await vi.importActual('../src/lib/store/postprocess.js');
    const detected = [
      { id: 'ct_a', provider: 'Amazon', accountId: 'acc1', interval: 'monthly', kind: 'abo' },
      { id: 'ct_b', provider: 'Amazon', accountId: 'acc1', interval: 'monthly', kind: 'abo' },
    ];
    const old = [{ id: 'ct_a', provider: 'Amazon', accountId: 'acc1', interval: 'monthly', note: 'Prime', hidden: true }, { id: 'ct_b', provider: 'Amazon', accountId: 'acc1', interval: 'monthly' }];
    const out = mergeContracts(detected, old);
    expect(out.map(c => c.id)).toEqual(['ct_a', 'ct_b']);
    expect(out[0]).toMatchObject({ note: 'Prime', hidden: true });
    // wiederholt → stabil
    expect(mergeContracts(out, out).map(c => c.id)).toEqual(['ct_a', 'ct_b']);
  });
  it('mergeContracts: Fallback über Anbieter/Konto/Rhythmus, nie doppelt; Nutzerverträge bleiben außen vor', async () => {
    const { mergeContracts } = await vi.importActual('../src/lib/store/postprocess.js');
    const detected = [{ id: 'new1', provider: 'Spotify', accountId: 'a', interval: 'monthly', kind: 'abo' }, { id: 'new2', provider: 'Spotify', accountId: 'a', interval: 'monthly', kind: 'abo' }];
    const old = [{ id: 'old1', provider: 'Spotify', accountId: 'a', interval: 'monthly', note: 'x', kindUser: true, kind: 'streaming' }, { id: 'u1', source: 'user', provider: 'Spotify', accountId: 'a', interval: 'monthly' }];
    const out = mergeContracts(detected, old);
    expect(out.map(c => c.id)).toEqual(['old1', 'new2']);
    expect(out[0].kind).toBe('streaming');
  });
  it('differs erkennt echte Änderungen, ignoriert undefined/null und gleiche verschachtelte Werte', async () => {
    const { differs } = await vi.importActual('../src/lib/store/postprocess.js');
    expect(differs({ a: 1, t: 'x', n: { v: [1] } }, { a: 1, t: 'x', n: { v: [1] }, extra: undefined, m: null })).toBe(false);
    expect(differs({ a: 1 }, { a: 2 })).toBe(true);
    expect(differs({ n: { v: [1] } }, { n: { v: [2] } })).toBe(true);
    expect(differs({ a: 1 }, { a: 1, b: 'neu' })).toBe(true);
    expect(differs(undefined, { a: 1 })).toBe(true);
  });
});

describe('Suche', () => {
  it('baut den Index in Häppchen, liefert Treffer und verwirft veraltete Aufbauten', async () => {
    const { buildIndex, search } = await import('../src/lib/store/search.js');
    const mk = (n) => ({ accounts: [], contracts: [], documents: [], transactions: Array.from({ length: n }, (_, i) => ({ id: 't' + i, counterparty: i % 2 ? 'REWE Markt' : 'Shell Tankstelle', purpose: 'Einkauf ' + i, bookingDate: '2026-01-01', amount: -i })) });
    const first = buildIndex(mk(4000)); // wird vom zweiten Aufbau überholt
    const second = buildIndex(mk(10));
    await Promise.all([first, second]);
    const r = search('rewe');
    expect(r.total).toBe(5);
    expect(search('shell').transactions.length).toBe(5);
  });
});

describe('Extraktion großer Dateien', () => {
  it('kürzt reinen Fließtext, lässt Tabellen und Kontoauszug-Textformate vollständig', async () => {
    const { extract } = await vi.importActual('../src/lib/extract/index.js');
    const big = 'Notiz zur Rechnung Betrag 12,00 EUR\n'.repeat(40000); // ~1,4 Mio. Zeichen
    const t = await extract({ name: 'n.txt', ext: 'txt', size: big.length }, new Blob([big]));
    expect(t.text.length).toBeLessThanOrEqual(1_000_000);
    const sta = await extract({ name: 'a.sta', ext: 'sta', size: big.length }, new Blob([big]));
    expect(sta.text.length).toBe(big.length);
    const csv = 'Datum;Betrag;Text\n' + '01.01.2026;12,00;Test\n'.repeat(80000);
    const c = await extract({ name: 'b.csv', ext: 'csv', size: csv.length }, new Blob([csv]));
    expect(c.rows.length).toBe(80001);
  });
});

describe('pdf.js-Polyfills (Worker)', () => {
  it('sumPrecise rechnet exakt und verhält sich wie Math.sumPrecise', async () => {
    const { sumPrecise } = await import('../src/lib/extract/pdf-polyfills.js');
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
    expect(sumPrecise([0.1, 0.2, 0.3])).toBe(0.6);
    expect(sumPrecise([1e20, 0.1, -1e20])).toBe(0.1);
    expect(sumPrecise([1, 2, 3, 4])).toBe(10);
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
    expect(sumPrecise([Infinity, 1])).toBe(Infinity);
    expect(sumPrecise([Infinity, -Infinity])).toBeNaN();
    expect(() => sumPrecise([1, '2'])).toThrow(TypeError);
    expect(typeof Math.sumPrecise).toBe('function');
  });
  it('Map.getOrInsertComputed und Promise.withResolvers sind vorhanden', () => {
    const m = new Map();
    expect(m.getOrInsertComputed('a', () => 5)).toBe(5);
    expect(m.getOrInsert('a', 9)).toBe(5);
    expect(typeof Promise.withResolvers).toBe('function');
  });
});
