// KI-Engine gegen einen gefälschten Ollama (fetch): ungültiges JSON, Abbruch, Ollama fällt aus, erfundene Kategorien
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
vi.mock('../src/lib/store/db.js', () => ({ db: fakeDb }));
vi.mock('../src/lib/store/state.svelte.js', () => ({
  app: { settings: { ai: { enabled: true, model: 'qwen3:8b', visionModel: '', url: 'http://mock:1', think: false } } },
  saveSettings: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  toast: vi.fn(),
}));
vi.mock('../src/lib/ai/hardware.js', () => ({ detectPlatform: async () => ({ os: 'linux' }), detectAcceleration: async () => null }));

const { ai, runOpenCases, cancelAi, connect } = await import('../src/lib/ai/engine.svelte.js');
const { aiHooks } = await import('../src/lib/ai/hooks.js');

const MODELS = [{ name: 'qwen3:8b', size: 5e9, details: { parameter_size: '8B' } }];
let chatMode = 'ok';
let chatCalls = 0;
function installFetch() {
  chatCalls = 0;
  globalThis.fetch = vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    const json = (o) => ({ ok: true, json: async () => o });
    if (path === '/api/version') return json({ version: 'mock' });
    if (path === '/api/tags') return json({ models: MODELS });
    if (path === '/api/show') return json({ capabilities: ['completion'], details: {} });
    if (path === '/api/chat') {
      const body = JSON.parse(init.body);
      if (!body.messages.length) return json({});          // unload
      chatCalls++;
      if (chatMode === 'offline' && chatCalls > 1) throw new TypeError('Failed to fetch');
      if (chatMode === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true }));
      const ids = body.messages.at(-1).content.split('\n').map(l => l.split(' | ')[0].trim());
      const reply = {
        ok: { ergebnisse: ids.map(id => ({ id, kategorie: 'lebensmittel', sicherheit: 0.8 })) },
        invalid: 'das ist kein json',
        wrongshape: { ergebnisse: 'viele' },
        notiterable: { ergebnisse: { id: 'x' } },
        invented: { ergebnisse: ids.map((id, i) => ({ id, kategorie: i === 0 ? 'wohnen.miete' : i === 1 ? 'gibts_nicht' : i === 2 ? null : 'lebensmittel.erfunden', sicherheit: i === 3 ? 'hoch' : 0.9 })) },
        offline: { ergebnisse: ids.map(id => ({ id, kategorie: 'lebensmittel', sicherheit: 0.8 })) },
      }[chatMode];
      return json({ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) }, eval_count: 10, eval_duration: 1e8 });
    }
    return { ok: false, status: 404, statusText: 'nope', json: async () => ({}) };
  });
}
function seed(nBatches = 3) {
  fakeDb.transactions.rows.clear(); fakeDb.documents.rows.clear();
  for (let i = 0; i < nBatches * 20; i++) fakeDb.transactions.rows.set('t' + i, { id: 't' + i, counterparty: 'REWE', purpose: 'x', amount: -500, needsReview: true, category: 'sonstiges', categorySource: 'keyword' });
}
const cats = () => [...fakeDb.transactions.rows.values()];

describe('KI-Engine', () => {
  beforeEach(async () => {
    chatMode = 'ok'; installFetch(); seed(); ai.status = 'unknown'; ai.error = null; ai.running = false;
    await connect();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('übernimmt gültige Antworten als categorySource "ai" mit gedeckelter Sicherheit', async () => {
    await runOpenCases();
    expect(ai.error).toBeNull();
    const t = cats();
    expect(t.every(x => x.categorySource === 'ai' && x.category === 'lebensmittel' && x.confidence <= 0.85 && x.needsReview === false)).toBe(true);
    expect(ai.lastRun).toMatchObject({ done: 3, total: 3 });
  });

  it('ungültiges JSON: nichts wird verändert, Hinweis statt stillem Erfolg', async () => {
    chatMode = 'invalid';
    await runOpenCases();
    expect(cats().every(x => x.categorySource === 'keyword')).toBe(true);
    expect(ai.error).toMatch(/keine auswertbaren Antworten/);
    expect(ai.running).toBe(false);
  });

  it.each(['wrongshape', 'notiterable'])('falsche Antwortform (%s) bricht den Lauf nicht ab', async (mode) => {
    chatMode = mode;
    await runOpenCases();
    expect(ai.lastRun.done).toBe(3);
    expect(cats().every(x => x.categorySource === 'keyword')).toBe(true);
  });

  it('erfundene Kategorien, null und Text als Sicherheit werden ignoriert; unbekannte Unterkategorie entfällt', async () => {
    chatMode = 'invented';
    seed(1);
    await runOpenCases();
    const byId = Object.fromEntries(cats().map(x => [x.id, x]));
    expect(byId.t0).toMatchObject({ category: 'wohnen', subcategory: 'miete', categorySource: 'ai' });
    expect(byId.t1.categorySource).toBe('keyword'); // „gibts_nicht“
    expect(byId.t2.categorySource).toBe('keyword'); // null
    expect(byId.t3.categorySource).toBe('keyword'); // Sicherheit „hoch“
    expect(byId.t4).toMatchObject({ category: 'lebensmittel', subcategory: null, categorySource: 'ai' });
    expect(cats().some(x => x.category === 'null' || x.category === 'gibts_nicht')).toBe(false);
  });

  it('Ollama fällt mitten im Lauf aus: Lauf endet mit verständlicher Meldung, Status offline, bisherige Ergebnisse bleiben', async () => {
    chatMode = 'offline';
    seed(5);
    await runOpenCases();
    expect(ai.error).toMatch(/nicht mehr erreichbar/);
    expect(ai.status).toBe('offline');
    expect(ai.running).toBe(false);
    const done = cats().filter(x => x.categorySource === 'ai').length;
    expect(done).toBe(20); // nur der erste Batch ging durch
    expect(aiHooks.afterImport).toBeNull();
  });

  it('Abbrechen mitten im Lauf beendet sofort ohne Fehlermeldung', async () => {
    chatMode = 'hang';
    const run = runOpenCases();
    await vi.waitFor(() => expect(chatCalls).toBe(1));
    cancelAi();
    await run;
    expect(ai.running).toBe(false);
    expect(ai.error).toBeNull();
    expect(cats().every(x => x.categorySource === 'keyword')).toBe(true);
  });

  it('zwei gleichzeitige Starts ergeben nur einen Lauf', async () => {
    seed(1);
    await Promise.all([runOpenCases(), runOpenCases()]);
    expect(chatCalls).toBe(1);
  });

  it('beforeImport-Hook beendet einen laufenden Lauf (Nachverarbeitung würde sonst KI-Ergebnisse überschreiben)', async () => {
    chatMode = 'hang';
    const run = runOpenCases();
    await vi.waitFor(() => expect(chatCalls).toBe(1));
    aiHooks.beforeImport();
    await run;
    expect(ai.running).toBe(false);
  });
});

describe('KI-Kategorien bleiben nach der Nachverarbeitung erhalten', () => {
  it('classifyTransactions behält categorySource "ai", solange die Regeln nur raten', async () => {
    const { classifyTransactions } = await import('../src/lib/classify/rules.js');
    const tx = { id: 'a', bookingDate: '2026-01-02', amount: -1234, counterparty: 'Zzyzx Unbekannt GmbH', counterpartyRaw: 'Zzyzx Unbekannt GmbH', purpose: 'Rechnung 1', bookingText: 'Lastschrift', category: 'freizeit_reisen', subcategory: null, categorySource: 'ai', confidence: 0.8, needsReview: false };
    const [out] = classifyTransactions([tx], { rules: [], accounts: [] });
    expect(out.category).toBe('freizeit_reisen');
    expect(out.categorySource).toBe('ai');
  });
});
