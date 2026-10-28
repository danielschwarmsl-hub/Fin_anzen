// KI-Engine: Verbindung, Hardware-Profil, Aufgaben-Runner mit 6-Minuten-Wächter
import { Ollama, capabilitiesOf } from './ollama.js';
import { detectPlatform, detectAcceleration } from './hardware.js';
import { recommend, smallerModel } from './models.js';
import { TASKS, DOC_TYPES, TAX_REASONS, euroToCents, parseCategory } from './tasks.js';
import { aiHooks } from './hooks.js';
import { app, saveSettings, reload, toast } from '../store/state.svelte.js';
import { db } from '../store/db.js';

const STATEMENT_TYPES = new Set(['kontoauszug', 'paypal', 'depot', 'kreditkarte', 'einkaufszettel']);
export const SLOW_MS = globalThis.__FR_SLOW_MS || 6 * 60 * 1000; // Test-Override möglich

export const ai = $state({
  status: 'unknown', // unknown | checking | offline | ready | nomodel
  version: null, models: [], caps: {}, platform: null, accel: null, recommendation: null, tps: null,
  running: false, label: '', done: 0, total: 0, startedAt: 0, elapsedMs: 0, projectedMs: null,
  slow: null, dismissedSlow: false, error: null, lastRun: null,
});

let client = null;
let ctl = null;
let ticker = null;
let starting = false; // verhindert zwei gleichzeitig startende Läufe (zwischen Prüfung und startRun wird gewartet)
const durations = [];
const CALL_TIMEOUT = 10 * 60 * 1000;   // Sicherheitsnetz gegen hängende Anfragen (Modellstart auf CPU kann dauern)
const MAX_FAILS = 3;                    // so viele Aufrufe in Folge dürfen scheitern, bevor der Lauf endet

function getClient() {
  const url = app.settings.ai.url || 'http://localhost:11434';
  if (!client || client.base !== url.replace(/\/+$/, '')) client = new Ollama(url);
  return client;
}

export async function connect() {
  ai.status = 'checking'; ai.error = null;
  ai.platform = ai.platform || await detectPlatform();
  try {
    const v = await getClient().version();
    ai.version = v.version;
    ai.models = (await getClient().tags()).sort((a, b) => (a.size || 0) - (b.size || 0));
    for (const m of ai.models) {
      try { ai.caps[m.name] = capabilitiesOf(await getClient().show(m.name)); } catch { ai.caps[m.name] = {}; }
    }
    ai.recommendation = recommend(ai.platform, ai.accel);
    const s = app.settings.ai;
    if (!s.model || !ai.models.some(m => m.name === s.model)) {
      const pref = ai.models.find(m => m.name === ai.recommendation.text) || ai.models.find(m => !ai.caps[m.name]?.vision && !/embed/i.test(m.name)) || ai.models[0];
      if (pref) { s.model = pref.name; await saveSettings(); }
    }
    if (!s.visionModel || !ai.models.some(m => m.name === s.visionModel)) {
      const vis = ai.models.find(m => ai.caps[m.name]?.vision);
      s.visionModel = vis?.name || '';
    }
    ai.status = ai.models.length ? 'ready' : 'nomodel';
  } catch (e) {
    ai.status = 'offline';
    ai.error = /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? 'Ollama nicht erreichbar' : e.message;
  }
  installHooks();
  return ai.status;
}

/** Warm-up + Kurz-Benchmark → Beschleunigung und Token/s */
export async function benchmark() {
  const model = app.settings.ai.model;
  if (!model) return null;
  const t0 = performance.now();
  const r = await getClient().chat({ model, user: 'Zähle von 1 bis 30, nur Zahlen mit Komma getrennt.', think: thinkValue(model), timeout: 120000 });
  ai.tps = r.evalMs ? Math.round((r.evalCount / r.evalMs) * 1000 * 10) / 10 : null;
  ai.accel = await detectAcceleration(getClient(), model, ai.platform);
  ai.recommendation = recommend(ai.platform, ai.accel);
  return { tps: ai.tps, accel: ai.accel, ms: Math.round(performance.now() - t0) };
}

export function thinkValue(model) {
  const caps = ai.caps[model] || {};
  if (!caps.thinking) return undefined; // Modell kann kein Thinking → Parameter weglassen
  if (app.settings.ai.think) return caps.thinkLevels ? 'medium' : true;
  return caps.thinkLevels ? 'low' : false; // No-Thinking
}

async function call(taskName, input, { signal, vision = false } = {}) {
  const task = TASKS[taskName];
  const model = vision ? app.settings.ai.visionModel : app.settings.ai.model;
  if (!model) throw new Error('Kein Modell gewählt');
  const p = task.build(input);
  const t0 = performance.now();
  const r = await getClient().chat({ model, system: p.system, user: p.user, images: p.images, format: p.format, think: thinkValue(model), signal, numCtx: vision ? 8192 : 4096, timeout: CALL_TIMEOUT });
  durations.push(performance.now() - t0);
  if (r.evalMs) ai.tps = Math.round((r.evalCount / r.evalMs) * 10000) / 10;
  return r.json;
}

const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|network/i;
let fails = 0;
/**
 * Ein Aufruf, der den Lauf nicht beendet: Abbruch wird weitergereicht, einzelne Fehler/ungültiges JSON ergeben null.
 * Mehrere Fehler in Folge (Ollama beendet/offline, Modell fehlt) beenden den Lauf mit verständlicher Meldung.
 */
async function safeCall(taskName, input, opts) {
  try {
    const r = await call(taskName, input, opts);
    fails = 0;
    return r;
  } catch (e) {
    if (opts?.signal?.aborted || e?.name === 'AbortError') throw e;
    if (++fails >= MAX_FAILS) {
      if (NETWORK_RE.test(e?.message || '')) { ai.status = 'offline'; installHooks(); throw new Error('Ollama ist nicht mehr erreichbar – bitte Ollama starten und den Lauf wiederholen'); }
      throw new Error(`KI-Aufruf fehlgeschlagen: ${e?.message || e}`);
    }
    return null;
  }
}

function startRun(total, label) {
  fails = 0;
  ctl = new AbortController();
  durations.length = 0;
  Object.assign(ai, { running: true, label, done: 0, total, startedAt: Date.now(), elapsedMs: 0, projectedMs: null, slow: null, dismissedSlow: false, error: null });
  ticker = setInterval(watch, 1000);
  return ctl.signal;
}
function watch() {
  ai.elapsedMs = Date.now() - ai.startedAt;
  if (durations.length >= 3 && ai.total) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    ai.projectedMs = ai.elapsedMs + avg * (ai.total - ai.done);
  }
  const tooSlow = ai.elapsedMs > SLOW_MS || (ai.projectedMs != null && ai.projectedMs > SLOW_MS && ai.done >= 3);
  if (tooSlow && !ai.slow && !ai.dismissedSlow) {
    const current = app.settings.ai.model;
    ai.slow = { model: current, suggestion: smallerModel(current, ai.models), elapsedMs: ai.elapsedMs, projectedMs: ai.projectedMs };
  }
}
function endRun() {
  clearInterval(ticker); ticker = null;
  ai.lastRun = { done: ai.done, total: ai.total, ms: Date.now() - ai.startedAt, label: ai.label };
  ai.running = false; ai.label = ''; ctl = null;
}
export function cancelAi() { ctl?.abort(); }
/** Ein-Klick-Wechsel aufs kleinere Modell – laufende Aufgaben gehen damit weiter */
export async function switchToSmaller() {
  const s = ai.slow?.suggestion;
  if (!s?.installed) return false;
  app.settings.ai.model = s.name;
  await saveSettings();
  ai.slow = null; ai.dismissedSlow = false; ai.startedAt = Date.now(); durations.length = 0; ai.projectedMs = null;
  return true;
}

/** Offene Fälle abarbeiten: unsichere Buchungen, unklare Dokumente, Bons ohne Positionen */
export async function runOpenCases({ external } = {}) {
  if (ai.running || starting) return;
  starting = true;
  try { await runOpenCasesInner({ external }); } finally { starting = false; }
}

async function runOpenCasesInner({ external } = {}) {
  if (ai.status !== 'ready') { await connect(); if (ai.status !== 'ready') return; }
  const txs = (await db.transactions.toArray()).filter(t => t.needsReview && t.categorySource !== 'user' && !t.isTransfer && !t.reviewed);
  const docs = (await db.documents.toArray()).filter(d => d.type !== 'irrelevant' && !d.reviewed && (d.needsReview || d.type === 'finanz_sonstiges' || !d.date || (d.amount == null && !STATEMENT_TYPES.has(d.type))) && (d.text || '').length > 30);
  const receipts = app.settings.ai.visionModel ? (await db.documents.toArray()).filter(d => d.type === 'kassenbon' && d.ocr && d.needsReview) : [];
  const batches = [];
  for (let i = 0; i < txs.length; i += 20) batches.push(txs.slice(i, i + 20));
  const total = batches.length + docs.length + receipts.length;
  if (!total) { ai.lastRun = { done: 0, total: 0, ms: 0, label: 'Nichts offen' }; return; }
  const signal = startRun(total, 'Offene Fälle');
  let invalid = 0, applied = 0; // unbrauchbare Antworten / übernommene Ergebnisse
  external?.addEventListener('abort', () => ctl?.abort(), { once: true });
  try {
    for (const batch of batches) {
      if (signal.aborted) break;
      ai.label = `Kategorien (${batch.length} Buchungen)`;
      const res = await safeCall('categorize', { txs: batch }, { signal });
      const answers = Array.isArray(res?.ergebnisse) ? res.ergebnisse : null;
      if (!answers) invalid++;
      const byId = new Map(batch.map(x => [x.id, x]));
      for (const r of answers || []) {
        const t = r && byId.get(r.id);
        const conf = Number(r?.sicherheit);
        const cat = parseCategory(r?.kategorie);
        if (!t || !cat || !(conf >= 0.55)) continue;
        await db.transactions.update(t.id, { ...cat, categorySource: 'ai', confidence: Math.min(0.85, conf), needsReview: conf < 0.7 });
        applied++;
      }
      ai.done++;
    }
    for (const d of docs) {
      if (signal.aborted) break;
      ai.label = `Dokument: ${d.title || d.displayName || ''}`.slice(0, 80);
      const patch = {};
      if (d.type === 'finanz_sonstiges' || (d.confidence ?? 1) < 0.55) {
        const r = await safeCall('docType', { text: d.text, name: d.displayName || '' }, { signal });
        if (DOC_TYPES.includes(r?.typ) && r.sicherheit >= 0.6 && r.typ !== d.type) { patch.type = r.typ; patch.typeSource = 'ai'; }
        if (typeof r?.aussteller === 'string' && r.aussteller && !d.issuer) patch.issuer = r.aussteller;
      }
      const f = await safeCall('fields', { text: d.text, type: patch.type || d.type }, { signal });
      if (f) {
        if (!d.date && /^\d{4}-\d{2}-\d{2}$/.test(f.datum || '')) patch.date = f.datum;
        if (!d.issuer && typeof f.aussteller === 'string' && f.aussteller) patch.issuer = f.aussteller;
        if (d.amount == null && euroToCents(f.gesamtbetrag) != null) patch.amount = euroToCents(f.gesamtbetrag);
        if (!d.vat?.length && Array.isArray(f.mwst) && f.mwst.length) patch.vat = f.mwst.filter(v => v && Number.isFinite(Number(v.satz))).map(v => ({ rate: Number(v.satz), tax: euroToCents(v.betrag), net: null, gross: null }));
      }
      if (!d.taxRelevant && d.taxSource !== 'user') {
        const t = await safeCall('tax', { doc: { ...d, ...patch } }, { signal });
        if (t?.relevant === true && TAX_REASONS.includes(t.grund)) { patch.taxRelevant = true; patch.taxReason = t.grund; patch.taxSource = 'ai'; }
      }
      if (Object.keys(patch).length) { patch.aiAt = new Date().toISOString(); await db.documents.update(d.id, patch); applied++; }
      ai.done++;
    }
    for (const d of receipts) {
      if (signal.aborted) break;
      ai.label = `Bon lesen: ${d.issuer || ''}`;
      const blob = (await db.blobs.get(d.fileId))?.blob;
      // PDF-Belege o. ä. lassen sich nicht als Bild laden → überspringen, der Lauf geht weiter
      const image = blob ? await toBase64Jpeg(blob, 1280).catch(() => null) : null;
      if (image) {
        const r = await safeCall('receiptItems', { image }, { signal, vision: true });
        const items = (Array.isArray(r?.positionen) ? r.positionen : []).filter(p => p && typeof p.text === 'string' && euroToCents(p.preis) != null);
        if (items.length) {
          applied++;
          await db.lineItems.where('documentId').equals(d.id).delete();
          await db.lineItems.bulkPut(items.map((p, i) => ({ id: `${d.id}_ai${i}`, documentId: d.id, text: p.text, qty: 1, unitPrice: euroToCents(p.preis), total: euroToCents(p.preis), vatRate: p.mwst_satz ?? null })));
          const patch = { aiAt: new Date().toISOString() };
          if (d.amount == null && euroToCents(r.summe) != null) patch.amount = euroToCents(r.summe);
          await db.documents.update(d.id, patch);
        }
      }
      ai.done++;
    }
    if (invalid && !applied && !signal.aborted) ai.error = 'Das Modell lieferte keine auswertbaren Antworten – ein anderes Modell wählen?';
  } catch (e) {
    if (e?.name !== 'AbortError') ai.error = e?.message || String(e);
  } finally {
    if (ai.error) toast(ai.error, { tone: 'bad', ms: 8000 }); // der Fortschrittsbalken verschwindet – die Meldung soll nicht untergehen
    endRun();
    getClient().unload(app.settings.ai.model);
    await reload();
  }
}

async function toBase64Jpeg(blob, maxW) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Hooks ins Import-System einhängen (nur wenn aktiviert + bereit) */
export function installHooks() {
  aiHooks.beforeImport = () => cancelAi(); // ein laufender KI-Lauf würde mit der Nachverarbeitung um dieselben Buchungen konkurrieren
  const on = app.settings.ai.enabled && ai.status === 'ready' && app.settings.ai.autoRun !== false;
  // Läuft im Hintergrund weiter, damit der Import sofort fertig ist
  aiHooks.afterImport = on ? async () => { setTimeout(() => runOpenCases(), 400); } : null;
}
