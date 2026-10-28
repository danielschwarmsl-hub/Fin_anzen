// KI-Import-Hooks (detect/parse), Lokalität, Typwechsel mit Neu-Lesen und Beleg-Hinweise – gegen einen gefälschten Ollama (fetch)
import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeTable() {
  const rows = new Map();
  return {
    rows,
    async get(k) { return rows.get(k); },
    async put(r) { rows.set(r.id, structuredClone(r)); },
    async bulkPut(a) { for (const r of a) rows.set(r.id, structuredClone(r)); },
    async update(k, patch) { const r = rows.get(k); if (r) Object.assign(r, structuredClone(patch)); },
    async toArray() { return [...rows.values()].map(r => structuredClone(r)); },
    where() { return { equals: () => ({ delete: async () => {} }) }; },
  };
}
const fakeDb = { transactions: makeTable(), documents: makeTable(), blobs: makeTable(), lineItems: makeTable() };
const settings = { ai: { enabled: true, model: 'qwen3:8b', visionModel: '', url: 'http://127.0.0.1:11434', think: false } };
vi.mock('../src/lib/store/db.js', () => ({ db: fakeDb }));
vi.mock('../src/lib/store/state.svelte.js', () => ({ app: { settings }, saveSettings: vi.fn(async () => {}), reload: vi.fn(async () => {}), toast: vi.fn() }));
vi.mock('../src/lib/ai/hardware.js', () => ({ detectPlatform: async () => ({ os: 'linux' }), detectAcceleration: async () => null }));
const reprocessFile = vi.fn(async (fileId, { forceType }) => {
  // wie der Importer: altes Dokument der Datei weg, neues mit erzwungenem Typ
  for (const [id, d] of fakeDb.documents.rows) if (d.fileId === fileId) fakeDb.documents.rows.delete(id);
  fakeDb.documents.rows.set('neu', { id: 'neu', fileId, type: forceType, text: 'neu gelesen', needsReview: false });
});
vi.mock('../src/lib/store/importer.js', () => ({ reprocessFile }));

const { ai, connect, installHooks, runOpenCases } = await import('../src/lib/ai/engine.svelte.js');
const { aiHooks } = await import('../src/lib/ai/hooks.js');

let replies;
let chats;
function installFetch() {
  chats = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const json = (o) => ({ ok: true, json: async () => o });
    if (path === '/api/version') return json({ version: 'mock' });
    if (path === '/api/tags') return json({ models: [{ name: 'qwen3:8b', size: 5e9 }] });
    if (path === '/api/show') return json({ capabilities: ['completion'], details: {} });
    if (path === '/api/chat') {
      const body = JSON.parse(init.body);
      if (!body.messages.length) return json({});
      const sys = body.messages[0].content;
      const key = /Dokumenttyp/.test(sys) ? 'docType' : /Kernfelder/.test(sys) ? 'fields' : /Einkommensteuer/.test(sys) ? 'tax' : /Beleg zu einer Kontobuchung/.test(sys) ? 'match' : 'categorize';
      chats.push(key);
      const r = typeof replies[key] === 'function' ? replies[key](body, init) : replies[key];
      if (r instanceof Error) throw r;
      if (r instanceof Promise) return r;
      return json({ message: { content: JSON.stringify(r ?? {}) } });
    }
    return { ok: false, status: 404, statusText: 'nope', json: async () => ({}) };
  });
}

const TEXT = 'Malermeister Kunz GmbH\nRechnung Nr. 4711 vom 03.02.2026\nArbeitskosten 100,00\nGesamtbetrag 119,00 EUR\nMwSt 19 % 19,00';
const detection = { type: 'finanz_sonstiges', subtype: null, institution: null, format: null, confidence: 0.4, signals: ['rechnung'] };

beforeEach(async () => {
  for (const t of Object.values(fakeDb)) t.rows.clear();
  Object.assign(settings.ai, { enabled: true, url: 'http://127.0.0.1:11434', autoRun: true });
  replies = { docType: { typ: 'rechnung', sicherheit: 0.9, begruendung: 'Rechnungsnummer und Gesamtbetrag' }, fields: {}, tax: { relevant: false, grund: 'sonstiges', sicherheit: 0.9 }, match: null, categorize: { ergebnisse: [] } };
  installFetch();
  reprocessFile.mockClear();
  ai.status = 'unknown'; ai.error = null; ai.running = false;
  await connect();
});

describe('Lokalität', () => {
  it('fremde Adresse: kein Aufruf, Status offline mit klarer Meldung, Hooks aus', async () => {
    settings.ai.url = 'http://192.168.0.5:11434';
    globalThis.fetch.mockClear();
    expect(await connect()).toBe('offline');
    expect(ai.error).toMatch(/Nur lokale Ollama-Adressen/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(aiHooks.detect).toBeNull();
    expect(aiHooks.parse).toBeNull();
  });
});

describe('Hooks anschließen', () => {
  it('aktiv nur bei eingeschalteter, verbundener KI', () => {
    expect(typeof aiHooks.detect).toBe('function');
    expect(typeof aiHooks.parse).toBe('function');
    settings.ai.enabled = false; installHooks();
    expect(aiHooks.detect).toBeNull();
    expect(aiHooks.parse).toBeNull();
    settings.ai.enabled = true; ai.status = 'offline'; installHooks();
    expect(aiHooks.detect).toBeNull();
  });

  it('detect: KI-Typ mit Begründung, Original als Alternative; mittel → Prüfen', async () => {
    const d = await aiHooks.detect({ text: TEXT }, { name: 'scan.pdf' }, detection, {});
    expect(d).toMatchObject({ type: 'rechnung', typeSource: 'ai', needsReview: false, confidence: 0.85 });
    expect(d.aiReason).toBe('KI (90 %): Rechnungsnummer und Gesamtbetrag');
    expect(d.alternatives[0]).toEqual({ type: 'finanz_sonstiges', confidence: 0.4 });
    replies.docType = { typ: 'rechnung', sicherheit: 0.65 };
    expect((await aiHooks.detect({ text: TEXT }, { name: 'x' }, detection, {})).needsReview).toBe(true);
  });

  it.each([
    ['unsicher', { typ: 'rechnung', sicherheit: 0.4 }],
    ['unbekannter Typ', { typ: 'quittung', sicherheit: 0.99 }],
    ['Kontoauszug (Format fehlt)', { typ: 'kontoauszug', sicherheit: 0.99 }],
    ['irrelevant (Datei würde verschwinden)', { typ: 'irrelevant', sicherheit: 0.99 }],
    ['kein JSON', 'Unsinn'],
    ['Netzwerkfehler', new TypeError('Failed to fetch')],
  ])('detect behält das Original: %s', async (_, reply) => {
    replies.docType = reply;
    expect(await aiHooks.detect({ text: TEXT }, { name: 'x' }, detection, {})).toBe(detection);
  });

  it('detect: Abbruch des Imports → sofort Original, kein Fehler', async () => {
    const ctl = new AbortController(); ctl.abort();
    expect(await aiHooks.detect({ text: TEXT }, { name: 'x' }, detection, { signal: ctl.signal })).toBe(detection);
  });

  it('nach zwei Fehlern bleiben die Hooks bis zum nächsten Import still', async () => {
    replies.docType = new TypeError('Failed to fetch');
    await aiHooks.detect({ text: TEXT }, {}, detection, {});
    await aiHooks.detect({ text: TEXT }, {}, detection, {});
    chats.length = 0;
    await aiHooks.detect({ text: TEXT }, {}, detection, {});
    expect(chats).toEqual([]);
    aiHooks.beforeImport();
    replies.docType = { typ: 'rechnung', sicherheit: 0.9 };
    expect((await aiHooks.detect({ text: TEXT }, {}, detection, {})).type).toBe('rechnung');
  });

  it('parse: ergänzt nur fehlende, im Text belegte Felder', async () => {
    replies.fields = { datum: '2026-02-03', aussteller: 'Ganz Andere AG', gesamtbetrag: 119, mwst: [{ satz: 19, betrag: 19 }] };
    const result = { document: { type: 'rechnung', date: null, amount: null, issuer: 'Kunz', needsReview: true, displayName: 'alt.pdf' }, vat: null, lineItems: [] };
    const out = await aiHooks.parse(detection, { text: TEXT }, { name: 'scan.pdf', ext: 'pdf' }, result, {});
    expect(out.document).toMatchObject({ date: '2026-02-03', amount: 11900, issuer: 'Kunz', needsReview: true });
    expect(out.vat).toEqual([{ rate: 19, tax: 1900, net: null, gross: null }]);
    expect(out.document.aiReason).toMatch(/KI ergänzt/);
    expect(out.document.displayName).not.toBe('alt.pdf');
    expect(result.document.amount).toBeNull(); // Original unverändert
  });

  it('parse: erfundene Werte → Ergebnis unverändert; Fehler brechen nie ab', async () => {
    const result = { document: { type: 'rechnung', date: null, amount: null, needsReview: true }, vat: null };
    replies.fields = { datum: '2026-02-31', gesamtbetrag: 999.99 };
    expect(await aiHooks.parse(detection, { text: TEXT }, { name: 'x' }, result, {})).toBe(result);
    replies.fields = new Error('boom');
    expect(await aiHooks.parse(detection, { text: TEXT }, { name: 'x' }, result, {})).toBe(result);
  });
});

describe('Offene Fälle', () => {
  it('Typwechsel → Datei wird mit erzwungenem Typ neu gelesen, neues Dokument trägt die Begründung', async () => {
    fakeDb.documents.rows.set('d1', { id: 'd1', fileId: 'f1', type: 'finanz_sonstiges', text: TEXT, needsReview: true, confidence: 0.4 });
    await runOpenCases();
    expect(reprocessFile).toHaveBeenCalledWith('f1', { forceType: 'rechnung' });
    expect(chats).not.toContain('fields'); // Felder liefert der passende Parser
    expect(fakeDb.documents.rows.get('neu')).toMatchObject({ type: 'rechnung', typeSource: 'ai', aiReason: 'KI (90 %): Rechnungsnummer und Gesamtbetrag' });
  });

  it('Dokument wird nur einmal gefragt; Steuer-Flag mit Sicherheit und Sperre gegen Überschreiben', async () => {
    fakeDb.documents.rows.set('d1', { id: 'd1', fileId: 'f1', type: 'rechnung', text: TEXT, needsReview: true, confidence: 0.9, issuer: 'Kunz' });
    replies.fields = { gesamtbetrag: 119, datum: '2026-02-03' };
    replies.tax = { relevant: true, grund: 'haushalt_handwerker', sicherheit: 0.7, begruendung: 'Arbeitskosten Maler' };
    await runOpenCases();
    const d = fakeDb.documents.rows.get('d1');
    expect(d).toMatchObject({ amount: 11900, date: '2026-02-03', taxRelevant: true, taxSource: 'ai', taxReason: 'haushalt_handwerker', needsReview: true });
    expect(d.aiTaxReason).toBe('KI (70 %): Arbeitskosten Maler');
    expect(d.aiAt).toBeTruthy();
    chats.length = 0;
    await runOpenCases();
    expect(chats).toEqual([]);
  });

  it('Kategorien: keine Umbuchung, Vorzeichen geprüft, Begründung gespeichert', async () => {
    fakeDb.transactions.rows.set('a', { id: 'a', amount: -5000, needsReview: true, category: 'sonstiges', categorySource: 'keyword' });
    fakeDb.transactions.rows.set('b', { id: 'b', amount: -5000, needsReview: true, category: 'sonstiges', categorySource: 'keyword' });
    fakeDb.transactions.rows.set('c', { id: 'c', amount: 5000, needsReview: true, category: 'sonstiges', categorySource: 'keyword', purpose: 'Einkauf' });
    replies.categorize = { ergebnisse: [
      { id: 'a', kategorie: 'umbuchung.eigene_konten', sicherheit: 0.95 },
      { id: 'b', kategorie: 'einkommen.gehalt', sicherheit: 0.95 },
      { id: 'c', kategorie: 'shopping', sicherheit: 0.95, begruendung: 'Onlinehandel' },
    ] };
    await runOpenCases();
    const t = Object.fromEntries([...fakeDb.transactions.rows].map(([k, v]) => [k, v]));
    expect(t.a.categorySource).toBe('keyword');
    expect(t.b.categorySource).toBe('keyword');
    expect(t.c.categorySource).toBe('keyword'); // positive Ausgabe ohne Erstattungshinweis
  });

  it('Beleg-Prüffall: KI-Einschätzung nur als Hinweis, nie bestätigt', async () => {
    fakeDb.documents.rows.set('r1', { id: 'r1', type: 'kassenbon', text: 'REWE Summe 12,34', amount: 1234, date: '2026-03-01', issuer: 'REWE', reviewed: true });
    fakeDb.transactions.rows.set('t1', { id: 't1', amount: -1234, bookingDate: '2026-03-02', counterparty: 'REWE', receiptDocId: 'r1', receiptSource: 'auto', checks: [{ kind: 'receipt', reason: 'knapp', refId: 'r1' }] });
    replies.match = { passt: true, sicherheit: 0.9, begruendung: 'Händler, Betrag und Datum passen' };
    await runOpenCases();
    const t = fakeDb.transactions.rows.get('t1');
    expect(t.aiHint).toMatchObject({ kind: 'receipt', docId: 'r1', match: true, confidence: 0.9 });
    expect(t.receiptSource).toBe('auto');
    chats.length = 0;
    await runOpenCases();
    expect(chats).toEqual([]); // schon beantwortet
  });
});
