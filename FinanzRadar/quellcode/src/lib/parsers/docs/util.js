// Gemeinsame Hilfen der Dokument-Parser (DOM-frei).
import { parseGermanAmount, parseGermanDate, normalizeIban } from '../../util/format.js';

/** OCR-Rauschen in Zahlen glätten: O→0, l/I→1 innerhalb zahlenartiger Tokens. */
export function cleanOcr(line) {
  return String(line).replace(/(?<![A-Za-zÄÖÜäöüß])[\dOoIl.,]{3,}(?![A-Za-zÄÖÜäöüß])/g,
    (tok) => (/\d/.test(tok) && /[.,]/.test(tok) ? tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') : tok));
}

const DATE_RE = /\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?(?!\d)/g;
const PCT_RE = /\d+(?:[.,]\d+)?\s*%/g;
const MONEY_RE = /(?<![\d.,])[-−–]?\s?(?:\d{1,3}(?:\.\d{3})+,\d{2}|\d+[.,]\d{2})(?!\d)/g;

/** Alle Geldbeträge einer Zeile in Cent (Datumsangaben und Prozentwerte werden ignoriert). */
export function amountsIn(line) {
  const s = cleanOcr(line).replace(DATE_RE, ' ').replace(PCT_RE, ' ');
  const out = [];
  for (const m of s.matchAll(MONEY_RE)) {
    const v = parseGermanAmount(m[0].replace(/\s/g, ''));
    if (v != null) out.push(v);
  }
  return out;
}
export const lastAmount = (line) => { const a = amountsIn(line); return a.length ? a[a.length - 1] : null; };
export const hasAmount = (line) => amountsIn(line).length > 0;

/** Zeilen eines Extracted-Objekts (Seiten nacheinander), normalisiert. */
export function getLines(extracted) {
  let raw = [];
  if (extracted?.pages?.length && extracted.pages.some((p) => p.lines?.length)) {
    for (const p of extracted.pages) {
      if (p.lines?.length) raw.push(...p.lines.map((l) => l.text));
      else raw.push(...String(p.text || '').split('\n'));
    }
  } else raw = String(extracted?.text || extracted?.rawText || '').split(/\r?\n/);
  return raw.map((l) => String(l).replace(/[ \f]/g, ' ').replace(/\s+$/, '')).filter((l) => l.trim() !== '');
}

/** Spalten einer Zeile (Trennung bei ≥2 Leerzeichen/Tab). */
export const cols = (line) => String(line).trim().split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);

export function findIdx(lines, re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

/** Wert hinter einem Label ("Label   Wert" oder "Label: Wert"); null wenn nicht vorhanden. */
export function labelValue(lines, re) {
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const rest = line.slice(m.index + m[0].length).replace(/^[\s:.]+/, '').trim();
    if (rest) return rest;
  }
  return null;
}

/** Letzter Betrag der ersten Zeile, die `re` trifft (optional mit Ausschluss). */
export function amountOf(lines, re, { not, last = true } = {}) {
  for (const line of lines) {
    if (!re.test(line) || (not && not.test(line))) continue;
    const a = amountsIn(line);
    if (a.length) return last ? a[a.length - 1] : a[0];
  }
  return null;
}

export function sumOf(lines, re, { not } = {}) {
  let sum = 0, found = false;
  for (const line of lines) {
    if (!re.test(line) || (not && not.test(line))) continue;
    const a = amountsIn(line);
    if (a.length) { sum += Math.abs(a[a.length - 1]); found = true; }
  }
  return found ? sum : null;
}

const plausible = (iso) => iso && iso >= '1990-01-01' && iso <= '2100-12-31';

/** Alle Datumsangaben (dd.mm.yyyy | yyyy-mm-dd) eines Textes als ISO. */
export function allDates(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})(?!\d)/g)) {
    const iso = parseGermanDate(m[1]);
    if (plausible(iso)) out.push(iso);
  }
  return out;
}
export const firstDate = (text) => allDates(text)[0] || null;

export function firstIban(text) {
  const m = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/.exec(String(text));
  return m ? normalizeIban(m[0]) : null;
}

export const LEGAL_RE = /\b(GmbH|mbH|AG|SE|KG|OHG|UG|e\.\s?K\.|e\.\s?V\.|B\.V\.|S\.\s?à\s?r\.\s?l\.|Ltd\.?|Inc\.?|GbR)(?![A-Za-z])/;
const DOC_WORD_RE = /(rechnung|abrechnung|bescheinigung|best[aä]tigung|standmitteilung|kontoauszug|quittung|vertrag|police|versicherungsschein|mitteilung|beleg|zuwendung)/i;
const SEP_RE = /\s[–—-]\s|\s·\s|\s\|\s/;

/** Aussteller aus den Kopfzeilen: Zeile mit Rechtsform, sonst erste Nicht-Titel-Zeile. */
export function issuerFromHeader(lines, max = 10) {
  const head = lines.slice(0, max);
  const cands = head.map((l) => l.split(SEP_RE)[0].replace(/\s{2,}.*$/, '').trim());
  for (const c of cands) if (c.length >= 3 && c.length < 70 && LEGAL_RE.test(c) && !/^(kunde|empf[aä]nger|zuwendender|versicherungsnehmer|arbeitnehmer|mitarbeiter)\b/i.test(c)) return c;
  for (const c of cands) {
    if (c.length < 3 || c.length > 60) continue;
    if (DOC_WORD_RE.test(c) || /\d{2}\.\d{2}\.|^\W*$|:/.test(c) || hasAmount(c)) continue;
    return c;
  }
  return null;
}

export const MONTHS_DE = ['januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
export function monthFromName(s) {
  const n = String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ü/g, 'ue').replace(/ö/g, 'oe');
  for (let i = 0; i < 12; i++) if (n.includes(MONTHS_DE[i]) || (MONTHS_DE[i].length > 4 && n.includes(MONTHS_DE[i].slice(0, 3) + '.'))) return i + 1;
  return null;
}

export function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export const pad2 = (n) => String(n).padStart(2, '0');

export function baseDoc(detection, patch = {}) {
  return {
    type: detection?.type || 'finanz_sonstiges', subtype: detection?.subtype ?? null,
    institution: detection?.institution ?? null, date: null, periodFrom: null, periodTo: null, issuer: null,
    amount: null, currency: 'EUR', title: '', fields: {}, confidence: detection?.confidence ?? 0.5,
    needsReview: false, reviewReason: null, ...patch,
  };
}

export function baseResult(document, extra = {}) {
  return {
    document, account: null, transactions: [], lineItems: [], holdings: [], valuations: [],
    balance: null, payroll: null, vat: null, ...extra,
  };
}

/** Review-Gründe sammeln. */
export function review(doc, reason) {
  doc.needsReview = true;
  doc.reviewReason = doc.reviewReason ? `${doc.reviewReason}; ${reason}` : reason;
}

/** VAT-Satz aus Netto/Steuer ableiten (0/7/19), falls OCR den Satz verfälscht hat. */
export function snapRate(rate, net, tax) {
  if ([0, 7, 19].includes(rate)) return rate;
  if (net > 0 && tax != null) {
    const r = (tax / net) * 100;
    return [0, 7, 19].reduce((best, c) => (Math.abs(c - r) < Math.abs(best - r) ? c : best), 19);
  }
  return rate;
}
