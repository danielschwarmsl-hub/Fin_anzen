// KI-Engine: Verbindung, Hardware-Profil, Aufgaben-Runner mit 6-Minuten-Wächter
import { Ollama, capabilitiesOf, isLocalUrl, NOT_LOCAL_MSG } from './ollama.js';
import { detectPlatform, detectAcceleration } from './hardware.js';
import { recommend, smallerModel } from './models.js';
import { TASKS, DOC_TYPES } from './tasks.js';
import { categoryPatch, validateDocType, validateFields, validateLineItems, taxPatch, receiptHint, cleanReason } from './validate.js';
import { displayName } from '../parsers/naming.js';
import { aiHooks } from './hooks.js';
import { app, saveSettings, reload, toast } from '../store/state.svelte.js';
import { db } from '../store/db.js';

const STATEMENT_TYPES = new Set(['kontoauszug', 'paypal', 'depot', 'kreditkarte', 'einkaufszettel']);
// Typen, die der Import-Hook setzen darf: keine Kontoauszüge (brauchen erkanntes Format) und nie „irrelevant“ (Datei würde still ignoriert)
const HOOK_TYPES = DOC_TYPES.filter(t => !STATEMENT_TYPES.has(t) && t !== 'irrelevant');
const HOOK_TIMEOUT = 45 * 1000;        // je KI-Aufruf während des Imports
const HOOK_MAX_FAILS = 2;              // danach bleiben die Import-Hooks bis zum nächsten Import still
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
  if (!isLocalUrl(app.settings.ai.url || 'http://localhost:11434')) {
    // Kein Aufruf an fremde Rechner – Finanzdaten bleiben auf diesem Gerät
    ai.status = 'offline'; ai.error = NOT_LOCAL_MSG;
    installHooks();
    return ai.status;
  }
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

async function call(taskName, input, { signal, vision = false, timeout = CALL_TIMEOUT, record = true } = {}) {
  const task = TASKS[taskName];
  const model = vision ? app.settings.ai.visionModel : app.settings.ai.model;
  if (!model) throw new Error('Kein Modell gewählt');
  const p = task.build(input);
  const t0 = performance.now();
  const r = await getClient().chat({ model, system: p.system, user: p.user, images: p.images, format: p.format, think: thinkValue(model), signal, numCtx: vision ? 8192 : 4096, timeout });
  if (record) durations.push(performance.now() - t0);
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
  const allDocs = await db.documents.toArray();
  const docById = new Map(allDocs.map(d => [d.id, d]));
  const allTxs = await db.transactions.toArray();
  // aiAt: schon einmal von der KI beantwortet → nicht bei jedem Lauf erneut fragen
  const txs = allTxs.filter(t => t.needsReview && t.categorySource !== 'user' && !t.isTransfer && !t.reviewed && !t.aiAt);
  const docs = allDocs.filter(d => d.type !== 'irrelevant' && !d.reviewed && !d.aiAt && (d.needsReview || d.type === 'finanz_sonstiges' || !d.date || (d.amount == null && !STATEMENT_TYPES.has(d.type))) && (d.text || '').length > 30);
  const receipts = app.settings.ai.visionModel ? allDocs.filter(d => d.type === 'kassenbon' && d.ocr && d.needsReview && !d.aiItemsAt) : [];
  // Prüffälle „Beleg ↔ Buchung“: KI-Einschätzung nur als Hinweis (aiHint), bestätigt wird nie automatisch
  const receiptChecks = allTxs.map(t => ({ t, doc: docById.get(receiptCheckDocId(t)) })).filter(({ t, doc }) => doc && t.receiptSource !== 'user' && t.aiHint?.docId !== doc.id);
  const batches = [];
  for (let i = 0; i < txs.length; i += 20) batches.push(txs.slice(i, i + 20));
  const total = batches.length + docs.length + receipts.length + receiptChecks.length;
  if (!total) { ai.lastRun = { done: 0, total: 0, ms: 0, label: 'Nichts offen' }; return; }
  const reprocess = docs.length ? await loadReprocess() : null;
  const reparse = []; // Dokumente mit neuem Typ → nach dem Lauf mit dem passenden Parser neu lesen
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
        const patch = t && categoryPatch(r, t);
        if (!patch) continue;
        await db.transactions.update(t.id, patch);
        if (patch.categorySource === 'ai') applied++;
      }
      ai.done++;
    }
    for (const d of docs) {
      if (signal.aborted) break;
      ai.label = `Dokument: ${d.title || d.displayName || ''}`.slice(0, 80);
      const patch = {};
      const reasons = [];
      if (d.typeSource !== 'user' && (d.type === 'finanz_sonstiges' || (d.confidence ?? 1) < 0.55)) {
        const r = await safeCall('docType', { text: d.text, name: d.displayName || '' }, { signal });
        const v = validateDocType(r, { current: d.type });
        if (v) {
          Object.assign(patch, { type: v.type, typeSource: 'ai', confidence: Math.min(0.85, v.confidence) });
          reasons.push(v.reason);
          if (v.level !== 'high') addReview(patch, d, 'KI hat den Dokumenttyp geändert – bitte prüfen');
          if (reprocess && d.fileId) reparse.push({ fileId: d.fileId, type: v.type, reason: v.reason, review: v.level !== 'high' });
        }
      }
      // Neuer Typ + Neu-Lesen möglich: Felder liefert gleich der passende Parser, nicht die KI
      if (!(patch.type && reprocess && d.fileId)) {
        const f = await safeCall('fields', { text: d.text, type: patch.type || d.type }, { signal });
        const fp = validateFields(f, d, d.text);
        if (Object.keys(fp).length) {
          Object.assign(patch, fp);
          reasons.push(`KI ergänzt: ${Object.keys(fp).map(k => FIELD_LABEL[k] || k).join(', ')}`);
          if (fp.date || fp.amount != null || fp.issuer) patch.displayName = displayName({ ...d, ...patch }, extOf(d.displayName));
        }
        if (!d.taxRelevant && d.taxSource !== 'user' && d.taxSource !== 'ai') {
          const tp = taxPatch(await safeCall('tax', { doc: { ...d, ...patch } }, { signal }));
          if (tp) {
            const { needsReview, reviewReason, ...rest } = tp;
            Object.assign(patch, rest);
            if (needsReview) addReview(patch, d, reviewReason);
          }
        }
      }
      if (Object.keys(patch).length) {
        if (reasons.length) patch.aiReason = reasons.join(' · ');
        applied++;
      }
      patch.aiAt = new Date().toISOString(); // auch ohne Ergebnis: nicht endlos erneut fragen
      await db.documents.update(d.id, patch);
      ai.done++;
    }
    for (const d of receipts) {
      if (signal.aborted) break;
      ai.label = `Bon lesen: ${d.issuer || ''}`;
      const blob = (await db.blobs.get(d.fileId))?.blob;
      // PDF-Belege o. ä. lassen sich nicht als Bild laden → überspringen, der Lauf geht weiter
      const image = blob ? await toBase64Jpeg(blob, 1280).catch(() => null) : null;
      const patch = { aiItemsAt: new Date().toISOString() };
      if (image) {
        const r = await safeCall('receiptItems', { image }, { signal, vision: true });
        // Positionen nur, wenn ihre Summe zur Belegsumme passt – sonst bleiben die vorhandenen
        const v = validateLineItems(r?.positionen, { total: d.amount ?? null, aiTotal: r?.summe, text: d.text });
        if (v) {
          applied++;
          await db.lineItems.where('documentId').equals(d.id).delete();
          await db.lineItems.bulkPut(v.items.map((p, i) => ({ ...p, id: `${d.id}_ai${i}`, documentId: d.id })));
          if (d.amount == null) patch.amount = v.total;
          patch.aiReason = `KI hat ${v.items.length} Positionen vom Bon gelesen (Summe passt)`;
        }
      }
      await db.documents.update(d.id, patch);
      ai.done++;
    }
    for (const { t, doc } of receiptChecks) {
      if (signal.aborted) break;
      ai.label = `Beleg prüfen: ${t.counterparty || ''}`.slice(0, 80);
      const hint = receiptHint(await safeCall('receiptMatch', { tx: t, doc }, { signal }), { docId: doc.id });
      if (hint) { await db.transactions.update(t.id, { aiHint: hint }); applied++; }
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
  if (reparse.length && !signal.aborted) await reparseFiles(reprocess, reparse);
}

const FIELD_LABEL = { date: 'Datum', issuer: 'Aussteller', amount: 'Betrag', vat: 'MwSt' };
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [])[1]?.toLowerCase() || '';
function addReview(patch, d, reason) {
  patch.needsReview = true;
  const prev = patch.reviewReason ?? d.reviewReason;
  patch.reviewReason = prev && !prev.includes(reason) ? `${prev}; ${reason}` : prev || reason;
}
/** Beleg-ID eines offenen Prüffalls „Beleg“ (checks aus der Nachverarbeitung) */
function receiptCheckDocId(t) {
  const c = Array.isArray(t.checks) ? t.checks.find(x => x?.kind === 'receipt') : null;
  return c ? c.refId || t.receiptDocId || null : null;
}

/** reprocessFile aus dem Importer – optional (fehlt sie, bleibt es beim geänderten Typ) */
async function loadReprocess() {
  try {
    const m = await import('../store/importer.js');
    return typeof m.reprocessFile === 'function' ? m.reprocessFile : null;
  } catch { return null; }
}
async function reparseFiles(reprocess, list) {
  for (const r of list) {
    try {
      await reprocess(r.fileId, { forceType: r.type });
      // Das neu gelesene Dokument trägt die KI-Herkunft weiter (Begründung für „Warum?“)
      const now = new Date().toISOString();
      for (const d of (await db.documents.toArray()).filter(x => x.fileId === r.fileId && x.type === r.type)) {
        const patch = { typeSource: 'ai', aiReason: r.reason, aiAt: now };
        if (r.review) addReview(patch, d, 'KI hat den Dokumenttyp geändert – bitte prüfen');
        await db.documents.update(d.id, patch);
      }
    } catch (e) { console.warn('KI: Neu-Lesen fehlgeschlagen', e); }
  }
  await reload();
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

/** Import-Hooks nur, wenn KI eingeschaltet und verbunden */
const hooksActive = () => !!(app.settings.ai.enabled && ai.status === 'ready' && app.settings.ai.model);
let hookFails = 0;
/** Ein KI-Aufruf während des Imports: Zeitlimit, Fehler → null (der Import läuft immer weiter) */
async function hookCall(taskName, input, signal) {
  if (hookFails >= HOOK_MAX_FAILS || signal?.aborted) return null;
  try {
    const r = await call(taskName, input, { signal, timeout: HOOK_TIMEOUT, record: false });
    hookFails = 0;
    return r;
  } catch {
    if (!signal?.aborted) hookFails++;
    return null;
  }
}

/** Typ-Fallback bei unsicherer Erkennung: KI-Typ nur, wenn zulässig und mindestens mittel sicher */
export async function aiDetect(extracted, meta, detection, { signal } = {}) {
  try {
    if (!hooksActive() || !detection) return detection;
    const text = extracted?.text || extracted?.rawText || '';
    const v = validateDocType(await hookCall('docType', { text, name: meta?.name || '' }, signal), { current: detection.type, allow: HOOK_TYPES });
    if (!v) return detection;
    return {
      ...detection, type: v.type, subtype: null, institution: null, format: null,
      confidence: Math.min(0.85, v.confidence), signals: [...(detection.signals || []), 'KI'],
      alternatives: [{ type: detection.type, confidence: detection.confidence }, ...(detection.alternatives || []).filter(a => a?.type !== v.type)],
      typeSource: 'ai', aiReason: v.reason, needsReview: v.level !== 'high',
    };
  } catch { return detection; }
}

/** Parse-Fallback für Prüf-Dokumente: fehlende Felder ergänzen, Vorhandenes nie überschreiben, nichts erfinden */
export async function aiParse(detection, extracted, meta, result, { signal } = {}) {
  try {
    const doc = result?.document;
    if (!hooksActive() || !doc || STATEMENT_TYPES.has(doc.type) || doc.type === 'irrelevant') return result;
    const out = { ...doc };
    const reasons = [];
    if (detection?.typeSource === 'ai' && doc.type === detection.type) {
      out.typeSource = 'ai';
      reasons.push(detection.aiReason);
    }
    const text = extracted?.text || extracted?.rawText || '';
    const missing = !doc.date || doc.amount == null || !doc.issuer || !result.vat?.length;
    let vat = result.vat;
    if (missing && text.length > 30) {
      const fp = validateFields(await hookCall('fields', { text, type: doc.type }, signal), { ...doc, vat: result.vat }, text);
      if (fp.vat) { vat = fp.vat; delete fp.vat; reasons.push('KI ergänzt: MwSt'); }
      if (Object.keys(fp).length) {
        Object.assign(out, fp);
        reasons.push(`KI ergänzt: ${Object.keys(fp).map(k => FIELD_LABEL[k] || k).join(', ')}`);
        out.displayName = displayName(out, meta?.ext || extOf(meta?.name));
      }
    }
    if (!reasons.length) return result;
    out.aiReason = cleanReason(reasons.join(' · '), 300); // aiAt bleibt frei: der Lauf danach darf Typ/Steuer noch klären
    return { ...result, document: out, vat };
  } catch { return result; }
}

/** Hooks ins Import-System einhängen (nur wenn aktiviert + bereit) */
export function installHooks() {
  aiHooks.beforeImport = () => { cancelAi(); hookFails = 0; }; // ein laufender KI-Lauf würde mit der Nachverarbeitung um dieselben Buchungen konkurrieren
  // „Nach Import automatisch“ gilt für alles, was die KI ungefragt tut
  const on = hooksActive() && app.settings.ai.autoRun !== false;
  aiHooks.detect = on ? aiDetect : null;
  aiHooks.parse = on ? aiParse : null;
  // Läuft im Hintergrund weiter, damit der Import sofort fertig ist
  aiHooks.afterImport = on ? async () => { setTimeout(() => runOpenCases(), 400); } : null;
}
