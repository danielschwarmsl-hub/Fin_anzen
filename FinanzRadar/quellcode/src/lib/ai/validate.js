// Prüfung aller KI-Antworten, bevor sie in die Datenbank gehen (DOM-frei, ohne Seiteneffekte).
// Grundsatz: lieber nichts übernehmen als etwas Erfundenes. Beträge in Cent, Datum ISO.
import { getCategory, categoryLabel } from '../classify/categories.js';
import { DOC_TYPES, TAX_REASONS, euroToCents, parseCategory } from './tasks.js';

/** Sicherheitsstufen (Team-Leitbild): hoch → still übernehmen, mittel → übernehmen + Prüfliste, niedrig → nur Vorschlag */
export const CONF_HIGH = 0.8;
export const CONF_MEDIUM = 0.6;
export const VAT_RATES = [0, 7, 19];
const LINE_TOLERANCE = 2; // Cent

/** 'high' | 'medium' | 'low' | null (keine Zahl) */
export function confidenceLevel(v) {
  const c = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(c)) return null;
  return c >= CONF_HIGH ? 'high' : c >= CONF_MEDIUM ? 'medium' : 'low';
}
export const toConfidence = (v) => {
  const c = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
};

/** Kurzer, einzeiliger Begründungstext (für „Warum?“) */
export function cleanReason(s, max = 160) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
const pct = (c) => `${Math.round(c * 100)} %`;
/** „KI (80 %): Begründung“ – ohne Begründung des Modells mit Ersatztext */
export function aiReasonText(confidence, reason, fallback) {
  const r = cleanReason(reason) || fallback || 'Einschätzung der lokalen KI';
  return confidence == null ? `KI: ${r}` : `KI (${pct(confidence)}): ${r}`;
}

// ---------- Beträge ----------
// Zwei Durchläufe: mit Tausendertrennern („1.234,56“, „1,099.90“, „1 234,56“) und ohne („2 100,00“ = Menge 2 + 100,00)
const NUM_RES = [/\d{1,3}(?:[.,' \u00a0]\d{3})+(?:[.,]\d{1,2})?(?!\d)/g, /\d+(?:[.,]\d{1,2})?(?!\d)/g];
function numberToCents(raw) {
  let s = raw.replace(/[' \u00a0]/g, '');
  const dec = s.match(/[.,](\d{1,2})$/);
  if (dec) s = s.slice(0, -dec[0].length).replace(/[.,]/g, '') + '.' + dec[1];
  else s = s.replace(/[.,]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
/** Alle Geldbeträge, die im Text stehen (deutsche und englische Schreibweise, „12,-“), als Set in Cent */
export function moneyValuesInText(text) {
  const out = new Set();
  const t = String(text || '');
  for (const re of NUM_RES) {
    for (const m of t.matchAll(re)) {
      const c = numberToCents(m[0]);
      if (c != null) out.add(c);
    }
  }
  return out;
}
/** Kommt der Betrag (Cent, Vorzeichen egal) im Text vor? */
export function amountInText(cents, text, values) {
  if (!Number.isInteger(cents)) return false;
  return (values || moneyValuesInText(text)).has(Math.abs(cents));
}

// ---------- Datum ----------
/** JJJJ-MM-TT, das als Kalenderdatum existiert (Round-Trip) und plausibel ist */
export function validDate(s, { now = new Date() } = {}) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.toISOString().slice(0, 10) !== s) return false;
  return y >= 1970 && y <= now.getUTCFullYear() + 1;
}

// ---------- MwSt ----------
export const validVatRate = (r) => r != null && r !== '' && VAT_RATES.includes(Number(r));
/** MwSt-Zeilen: nur Sätze 0/7/19, Steuerbetrag muss im Text stehen (falls Text vorhanden) */
export function validateVat(list, text) {
  if (!Array.isArray(list)) return [];
  const values = text ? moneyValuesInText(text) : null;
  const out = [];
  for (const v of list) {
    if (!v || !validVatRate(v.satz)) continue;
    const tax = euroToCents(v.betrag);
    if (tax == null || tax < 0) continue;
    if (values && !values.has(tax)) continue;
    out.push({ rate: Number(v.satz), tax, net: null, gross: null });
  }
  return out;
}

// ---------- Dokumentfelder ----------
/**
 * Nur fehlende Felder ergänzen, nichts überschreiben, nichts erfinden.
 * f = Antwort der Aufgabe „fields“, doc = vorhandenes Dokument, text = Dokumenttext.
 */
export function validateFields(f, doc = {}, text = doc.text || '') {
  const patch = {};
  if (!f || typeof f !== 'object') return patch;
  const values = moneyValuesInText(text);
  if (!doc.date && validDate(f.datum)) patch.date = f.datum;
  if (!doc.issuer && typeof f.aussteller === 'string' && cleanReason(f.aussteller, 120)) {
    const issuer = cleanReason(f.aussteller, 120);
    // Aussteller muss im Text stehen (Groß-/Kleinschreibung egal) – sonst erfunden
    if (!text || String(text).toLowerCase().includes(issuer.toLowerCase().slice(0, 40))) patch.issuer = issuer;
  }
  if (doc.amount == null) {
    const c = euroToCents(f.gesamtbetrag);
    if (c != null && c > 0 && amountInText(c, null, values)) patch.amount = c;
  }
  if (!doc.vat?.length) {
    const vat = validateVat(f.mwst, text);
    if (vat.length) patch.vat = vat;
  }
  return patch;
}

// ---------- Positionen ----------
/**
 * KI-Positionen nur, wenn ihre Summe auf ±2 ct zur Belegsumme passt.
 * total = bekannte Summe in Cent (z. B. doc.amount); fehlt sie, zählt die KI-Summe nur, wenn sie im Text steht.
 * → { items, total } oder null (dann vorhandene Positionen behalten)
 */
export function validateLineItems(positions, { total = null, aiTotal = null, text = '' } = {}) {
  if (!Array.isArray(positions) || !positions.length) return null;
  const items = [];
  for (const p of positions) {
    const price = euroToCents(p?.preis);
    const label = cleanReason(p?.text, 120);
    if (!label || price == null) return null; // eine kaputte Position → ganze Antwort verwerfen
    items.push({ text: label, qty: 1, unitPrice: price, total: price, vatRate: validVatRate(p.mwst_satz) ? Number(p.mwst_satz) : null });
  }
  let sum = total;
  if (sum == null) {
    const c = euroToCents(aiTotal);
    if (c != null && text && amountInText(c, text)) sum = c;
  }
  if (sum == null) return null;
  const itemsSum = items.reduce((s, i) => s + i.total, 0);
  if (Math.abs(itemsSum - Math.abs(sum)) > LINE_TOLERANCE) return null;
  return { items, total: Math.abs(sum) };
}

// ---------- Kategorien ----------
const REFUND_RE = /erstatt|gutschrift|r(?:ü|ue)ckzahl|r(?:ü|ue)ck(?:buchung|überweisung|ueberweisung)|retoure|storno|refund|zur(?:ü|ue)ck/i;
const SIGN_FREE = new Set(['bargeld']); // Ein- und Auszahlung

/**
 * Kategorie einer Buchung prüfen: keine Umbuchung, Einkommen nur bei Betrag > 0,
 * Ausgabe-Kategorien nur bei Betrag < 0 (Erstattungen dürfen positiv sein).
 * → { category, subcategory } oder null
 */
export function validateCategory(value, tx = {}) {
  const cat = parseCategory(value);
  if (!cat || cat.category === 'umbuchung') return null;
  const kind = getCategory(cat.category)?.kind;
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount === 0) return kind === 'income' || kind === 'expense' ? null : cat;
  if (kind === 'income' && amount < 0) return null;
  if (kind === 'expense' && amount > 0 && !SIGN_FREE.has(cat.category)) {
    const t = `${tx.purpose || ''} ${tx.bookingText || ''} ${tx.counterparty || ''}`;
    if (!REFUND_RE.test(t)) return null;
  }
  return cat;
}

/**
 * Antwort für eine Buchung → Patch (oder null). Hoch: übernehmen; mittel: übernehmen + Prüfliste;
 * niedrig: nur Vorschlag (aiSuggestion), Kategorie bleibt.
 */
export function categoryPatch(answer, tx, { now = new Date().toISOString() } = {}) {
  const conf = toConfidence(answer?.sicherheit);
  const level = confidenceLevel(answer?.sicherheit);
  const cat = validateCategory(answer?.kategorie, tx);
  if (!cat || level == null) return null;
  const aiReason = aiReasonText(conf, answer?.begruendung, categoryLabel(cat.category, cat.subcategory));
  if (level === 'low') return { aiSuggestion: { ...cat, confidence: conf }, aiReason, aiAt: now };
  return { ...cat, categorySource: 'ai', confidence: Math.min(0.85, conf), needsReview: level !== 'high', aiReason, aiAt: now };
}

// ---------- Dokumenttyp ----------
/**
 * Typ-Antwort prüfen. → { type, confidence, level, reason } oder null.
 * allow: zulässige Typen (Standard: alle außer „irrelevant“, das nur mit hoher Sicherheit)
 */
export function validateDocType(r, { current = null, allow = null, minLevel = 'medium' } = {}) {
  if (!r || typeof r.typ !== 'string' || !DOC_TYPES.includes(r.typ)) return null;
  if (allow && !allow.includes(r.typ)) return null;
  const conf = toConfidence(r.sicherheit);
  const level = confidenceLevel(r.sicherheit);
  if (!level || level === 'low' || (minLevel === 'high' && level !== 'high')) return null;
  if (r.typ === 'irrelevant' && level !== 'high') return null;
  if (r.typ === current) return null;
  return { type: r.typ, confidence: conf, level, reason: aiReasonText(conf, r.begruendung, `als „${r.typ}“ erkannt`) };
}

// ---------- Steuer ----------
/**
 * Steuer-Antwort → Patch. Ab Sicherheit 0,6 wird markiert (taxSource 'ai', mittel → Prüfliste),
 * darunter nur Prüfhinweis ohne Markierung.
 */
export function taxPatch(r) {
  if (!r || r.relevant !== true || !TAX_REASONS.includes(r.grund)) return null;
  const conf = toConfidence(r.sicherheit);
  const level = confidenceLevel(r.sicherheit);
  const why = aiReasonText(conf, r.begruendung, `ggf. steuerrelevant (${r.grund})`);
  if (level === 'high') return { taxRelevant: true, taxReason: r.grund, taxSource: 'ai', aiTaxReason: why };
  if (level === 'medium') return { taxRelevant: true, taxReason: r.grund, taxSource: 'ai', aiTaxReason: why, needsReview: true, reviewReason: 'KI: Steuerrelevanz prüfen' };
  return { needsReview: true, reviewReason: 'KI: möglicherweise steuerrelevant – bitte prüfen', aiTaxReason: why };
}

// ---------- Beleg ↔ Buchung ----------
/** Antwort „passt Beleg zur Buchung?“ → Hinweis (nie Bestätigung) */
export function receiptHint(r, { docId, now = new Date().toISOString() } = {}) {
  if (!r || typeof r.passt !== 'boolean') return null;
  const conf = toConfidence(r.sicherheit);
  if (conf == null) return null;
  return { kind: 'receipt', docId: docId ?? null, match: r.passt, confidence: conf, reason: aiReasonText(conf, r.begruendung, r.passt ? 'Beleg passt zur Buchung' : 'Beleg passt eher nicht'), at: now };
}
