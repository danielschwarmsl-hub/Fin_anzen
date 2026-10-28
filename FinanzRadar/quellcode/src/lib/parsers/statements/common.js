// Gemeinsame Helfer der Kontoumsatz-Parser (DOM-frei).
import { parseGermanAmount, parseGermanDate, normalizeIban, slug, fmtDate, fmtEUR, extOf } from '../../util/format.js';
import { parseCsv } from '../../extract/decode.js';

// ---------------------------------------------------------------- Kontext
/** Vereinheitlichte, lazy berechnete Sicht auf das Extracted-Objekt. */
export function buildContext(extracted, fileMeta) {
  const e = extracted || {};
  const name = fileMeta?.name || '';
  const ext = String(fileMeta?.ext || extOf(name) || '').toLowerCase();
  const raw = typeof e.rawText === 'string' ? e.rawText : (typeof e.xml === 'string' ? e.xml : null);
  const text = typeof e.text === 'string' && e.text ? e.text : (raw || '');
  let rows, lines;
  return {
    e, name, ext, kind: e.kind, raw, text,
    get rows() {
      if (rows !== undefined) return rows;
      if (Array.isArray(e.rows)) rows = e.rows.map(r => r.map(c => (c == null ? '' : typeof c === 'number' ? c : String(c).trim())));
      else if (raw && ['csv', 'text', undefined].includes(e.kind) && !/^\s*</.test(raw) && !/:20:/.test(raw.slice(0, 400))) {
        rows = parseCsv(raw, e.meta?.delimiter).rows;
      } else rows = null;
      return rows;
    },
    get lines() {
      if (lines) return lines;
      lines = flattenLines(e);
      return lines;
    },
  };
}

/** Alle PDF-Zeilen seitenübergreifend: [{ n, y, text, items }] */
export function flattenLines(e) {
  const out = [];
  if (Array.isArray(e.pages) && e.pages.some(p => p.lines?.length)) {
    for (const p of e.pages) for (const l of p.lines || []) out.push({ n: p.n, y: l.y, text: l.text, items: l.items || [] });
  } else {
    const pages = e.pages?.length ? e.pages.map(p => p.text || '') : String(e.text || '').split(/\n\f\n|\f/);
    pages.forEach((t, i) => t.split(/\r?\n/).forEach(s => { if (s.trim()) out.push({ n: i + 1, y: 0, text: s.replace(/\s+$/, ''), items: [] }); }));
  }
  return out;
}

export const lc = s => String(s ?? '').toLowerCase();

// ---------------------------------------------------------------- Texte
export function cleanText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
/** Anzeigename: Whitespace glätten, "NAME//ORT/DE"-Suffix (MT940) entfernen */
export function cleanName(s) { return cleanText(s).replace(/\s*\/\/.*$/, '').trim(); }

// ---------------------------------------------------------------- IBAN / Institution
const IBAN_LEN = { DE: 22, AT: 20, CH: 21, NL: 18, FR: 27, LU: 20, ES: 24, IT: 27, BE: 16, GB: 22, IE: 22, PT: 25, PL: 28, DK: 18, SE: 24, FI: 18, NO: 15 };
/** Erste plausible IBAN im Text (mit oder ohne Leerzeichen), normalisiert. */
export function findIban(text) {
  const re = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){3,8})/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let s = m[1].replace(/\s+/g, '');
    const len = IBAN_LEN[s.slice(0, 2)];
    if (len) { if (s.length < len) continue; s = s.slice(0, len); }
    else if (s.length < 15 || s.length > 34) continue;
    return s;
  }
  return null;
}

const BLZ_TABLE = { '50010517': 'ING', '12030000': 'DKB', '20041111': 'comdirect', '20041133': 'comdirect', '20041144': 'comdirect', '20041155': 'comdirect', '10011001': 'N26', '76030080': 'Consorsbank' };
export function institutionFromIban(iban) {
  const i = normalizeIban(iban);
  if (!i || !i.startsWith('DE') || i.length < 14) return null;
  const blz = i.slice(4, 12);
  if (BLZ_TABLE[blz]) return BLZ_TABLE[blz];
  if (blz.slice(3, 6) === '400') return 'Commerzbank';
  if (blz.slice(3, 6) === '700') return 'Deutsche Bank';
  if (blz.slice(0, 3) === '100' && blz.slice(3, 6) === '100') return 'Postbank';
  return null;
}
export function institutionFromBlz(blz) {
  const b = String(blz || '').replace(/\D/g, '');
  return b.length === 8 ? institutionFromIban('DE00' + b + '0000000000') : null;
}
const BIC_PREFIX = [['COBADEHD', 'comdirect'], ['INGD', 'ING'], ['COBA', 'Commerzbank'], ['DEUT', 'Deutsche Bank'], ['BYLA', 'DKB'], ['GENO', 'Volksbank'], ['PBNK', 'Postbank'], ['NTSB', 'N26'], ['CSDB', 'comdirect'], ['TRBK', 'Trade Republic'], ['SCFB', 'Consorsbank'], ['CSDB', 'Consorsbank']];
export function institutionFromBic(bic) {
  const b = String(bic || '').toUpperCase();
  for (const [p, n] of BIC_PREFIX) if (b.startsWith(p)) return n;
  return null;
}

const INSTITUTIONS = [
  ['Renault Bank', /Renault\s+Bank/i],
  ['ING', /\bING[-\s]?DiBa\b|\bING\s+(?:Deutschland|Bank|Girokonto|Extra)|\bING\b(?![a-zäöüß])/],
  ['comdirect', /comdirect/i],
  ['DKB', /\bDKB\b|Deutsche\s+Kreditbank/i],
  ['Sparkasse', /Sparkasse/i],
  ['Commerzbank', /Commerzbank/i],
  ['Deutsche Bank', /Deutsche\s+Bank/i],
  ['N26', /\bN26\b/],
  ['Volksbank', /Volksbank|Raiffeisenbank|\bVR[- ]Bank/i],
  ['Trade Republic', /Trade\s+Republic/i],
  ['Consorsbank', /Consorsbank|Cortal\s+Consors/i],
  ['Postbank', /Postbank/i],
  ['Targobank', /Targobank/i],
  ['Santander', /Santander/i],
  ['Hanseatic Bank', /Hanseatic\s+Bank/i],
  ['Barclays', /Barclays/i],
  ['Norisbank', /Norisbank/i],
  ['PayPal', /PayPal/i],
];
/** Institution aus Text: frühester Treffer gewinnt. `skip` = auszuschließende Namen (z. B. PayPal im Fließtext). */
export function detectInstitution(text, { skip = [] } = {}) {
  let best = null;
  for (const [name, re] of INSTITUTIONS) {
    if (skip.includes(name)) continue;
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { name, index: m.index };
  }
  return best?.name || null;
}

// ---------------------------------------------------------------- Konto
export function kindFromName(name) {
  const s = lc(name);
  if (/kredit|visa|mastercard|master card/.test(s)) return 'kreditkarte';
  if (/depot/.test(s)) return 'depot';
  if (/tagesgeld|extra|spar|festgeld|verrechnung(?!.*giro)/.test(s)) return 'tagesgeld';
  if (/paypal/.test(s)) return 'paypal';
  if (/giro|konto/.test(s)) return 'giro';
  return 'giro';
}
export const KIND_LABEL = { giro: 'Girokonto', tagesgeld: 'Tagesgeld', depot: 'Depot', kreditkarte: 'Kreditkarte', paypal: '', sonstige: 'Konto' };
export function accountName(institution, label) {
  const l = cleanText(label);
  if (!institution) return l || 'Konto';
  if (!l) return institution;
  return lc(l).includes(lc(institution)) ? l : `${institution} ${l}`;
}
export function accountKeyOf(account) {
  const iban = normalizeIban(account?.iban);
  if (iban) return iban;
  const inst = account?.institution || '';
  const base = account?.number || account?.name || '';
  const withInst = !inst || (!account?.number && lc(base).includes(lc(inst))) ? base : `${inst} ${base}`;
  return slug(withInst) || 'konto';
}

// ---------------------------------------------------------------- Buchungstext
const BT_RULES = [
  [/r(ü|ue)cklastschrift|r(ü|ue)ckbuchung|retoure/i, 'Rücklastschrift'],
  [/entgelt|geb(ü|ue)hr|provision|kontof(ü|ue)hrung|spesen|\bfees?\b|charge/i, 'Gebühr'],
  [/zins|interest/i, 'Zinsen'],
  [/dauerauftrag|standing order/i, 'Dauerauftrag'],
  [/lastschrift|einzug|direct debit/i, 'Lastschrift'],
  [/bargeld|geldautomat|barauszahlung|bareinzahlung|auszahlung|\batm\b|cash/i, 'Bargeld'],
  [/karte|card|visa|mastercard|maestro|girocard|kaufumsatz|presentment|\bpos\b/i, 'Kartenzahlung'],
  [/gehalt|lohn|besoldung|bez(ü|ue)ge|verg(ü|ue)tung|salary|payroll/i, 'Gehalt/Lohn'],
  [/gutschrift|eingang|incoming|zahlungseingang|credit transfer|erstattung/i, 'Gutschrift'],
  [/(ü|ue)berweisung|umbuchung|transfer|zahlung|outgoing/i, 'Überweisung'],
];
/** Normalisiert Buchungstext/Vorgang; null, wenn nichts Bekanntes erkannt wurde. */
export function normalizeBookingText(raw) {
  const s = cleanText(raw);
  if (!s) return null;
  for (const [re, out] of BT_RULES) if (re.test(s)) return out;
  return null;
}

// ---------------------------------------------------------------- SEPA-Tokens
const TOKEN_RE = /(?:^|\s)(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|BREF|RREF|OAMT|COAM|ORMR|PURP|ISSR)\+/g;
export const CREDITOR_ID_RE = /[A-Z]{2}\d{2}ZZZ[0-9A-Z]{8,}/;
/** Zerlegt "EREF+… MREF+… SVWZ+…" */
export function parseSepaTokens(text) {
  const s = String(text ?? '');
  const hits = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) hits.push({ key: m[1], start: m.index + (m[0].startsWith(' ') || /^\s/.test(m[0]) ? 1 : 0), valStart: m.index + m[0].length });
  if (!hits.length) return { found: false, rest: s };
  const out = { found: true, rest: s.slice(0, hits[0].start).trim() };
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : s.length;
    const v = s.slice(h.valStart, end).trim();
    if (out[h.key.toLowerCase()] === undefined) out[h.key.toLowerCase()] = v;
  });
  return out;
}
const noRef = v => !v || /^(NOTPROVIDED|NONREF|NOREF|KEINE ANGABE)$/i.test(v.trim());

/** Reichert eine Transaktion um SEPA-Referenzen an und normalisiert Verwendungszweck. */
function enrich(tx) {
  const raw = String(tx.purpose ?? '');
  const tk = parseSepaTokens(raw);
  if (tk.found) {
    if (!tx.endToEndId && !noRef(tk.eref)) tx.endToEndId = tk.eref.replace(/\s+/g, '');
    if (!tx.mandateId && !noRef(tk.mref)) tx.mandateId = tk.mref.replace(/\s+/g, '');
    if (!tx.creditorId && tk.cred && !noRef(tk.cred)) tx.creditorId = tk.cred.replace(/\s+/g, '');
    if (!tx.counterpartyIban && tk.iban && /^[A-Z]{2}\d{2}/.test(tk.iban.replace(/\s/g, ''))) tx.counterpartyIban = normalizeIban(tk.iban);
    if (!tx.counterpartyRaw && tk.abwa) { tx.counterpartyRaw = cleanText(tk.abwa); tx.counterparty = cleanName(tk.abwa); }
    const p = cleanText(tk.svwz ?? tk.rest ?? '');
    tx.purpose = p || cleanText(raw);
  } else tx.purpose = cleanText(raw);
  const all = `${raw} ${tx._info || ''}`;
  if (!tx.creditorId) { const g = all.match(CREDITOR_ID_RE); if (g) tx.creditorId = g[0]; }
  if (!tx.creditorId) { const g = all.match(/Gl(?:ä|ae)ubiger[- ]?ID:?\s*([A-Z0-9]{8,})/i); if (g) tx.creditorId = g[1]; }
  if (!tx.mandateId) { const g = all.match(/Mandat(?:s?ref(?:erenz)?)?\.?\s*:\s*([A-Za-z0-9\-_/.]{3,35})/); if (g && !/^(ref|referenz)$/i.test(g[1])) tx.mandateId = g[1]; }
  if (!tx.endToEndId) { const g = all.match(/(?:End-to-End-Ref(?:erenz)?\.?|Referenz|Kundenreferenz)\s*:\s*([A-Za-z0-9\-_/.]{4,35})/i); if (g && !noRef(g[1])) tx.endToEndId = g[1]; }
  delete tx._info;
  return tx;
}

/** Leere Transaktion nach SPEC (ohne id). */
export function makeTx(p) {
  const counterpartyRaw = p.counterpartyRaw != null ? cleanText(p.counterpartyRaw) : '';
  return {
    accountId: null, documentId: null, fileId: null,
    bookingDate: p.bookingDate, valueDate: p.valueDate || p.bookingDate,
    amount: p.amount, currency: p.currency || 'EUR',
    counterparty: p.counterparty != null ? cleanName(p.counterparty) : cleanName(counterpartyRaw),
    counterpartyRaw, counterpartyIban: p.counterpartyIban ? normalizeIban(p.counterpartyIban) : null,
    purpose: p.purpose ?? '', bookingText: p.bookingText || null,
    mandateId: p.mandateId || null, creditorId: p.creditorId || null, endToEndId: p.endToEndId || null,
    gvc: p.gvc || null, fee: p.fee ?? null,
    category: null, subcategory: null, categorySource: null, confidence: null,
    transferPairId: null, isTransfer: !!p.isTransfer, contractId: null, receiptDocId: null,
    taxRelevant: false, taxReason: null, needsReview: false, dedupeKey: null,
    _info: p.info || '', _dedupe: p.dedupeToken || null,
  };
}

const SALARY_RE = /^(gehalt|lohn|bez(ü|ue)ge|verg(ü|ue)tung|besoldung|entgelt)\b/i;
/** Finalisierung: Anreicherung, Buchungstext, dedupeKey (mit Zähler bei identischen Schlüsseln). */
export function finalizeTransactions(list, accountKey) {
  const seen = new Map();
  return list.map(t => {
    const tx = enrich(t);
    if (tx.amount > 0 && SALARY_RE.test(tx.purpose) && ['Gutschrift', 'Überweisung', null].includes(tx.bookingText)) tx.bookingText = 'Gehalt/Lohn';
    if (tx.amount > 0 && tx.gvc === '053') tx.bookingText = 'Gehalt/Lohn';
    if (!tx.counterparty && tx.counterpartyRaw) tx.counterparty = cleanName(tx.counterpartyRaw);
    const token = tx._dedupe || slug(tx.counterpartyRaw + tx.purpose).slice(0, 40);
    delete tx._dedupe;
    let key = `${accountKey}|${tx.bookingDate}|${tx.amount}|${token}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key += `#${n}`;
    tx.dedupeKey = key;
    return tx;
  });
}

// ---------------------------------------------------------------- Zahlen / Datum
export function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100);
  return parseGermanAmount(String(v).replace(/[−–]/g, '-'));
}
export function toIso(v, fallbackYear) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(+v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') { // Excel-Seriennummer
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    return null;
  }
  return parseGermanDate(String(v), fallbackYear);
}
/** Findet alle zwei Datumsangaben "01.01.2026 - 30.06.2026" */
export function findDateRange(text) {
  const m = String(text || '').match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*(?:-|–|—|bis)\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i);
  if (!m) return null;
  const a = parseGermanDate(m[1]), b = parseGermanDate(m[2]);
  return a && b ? { from: a, to: b } : null;
}

/** Quantität/Stückzahl: Komma → deutsch, sonst Punkt als Dezimaltrenner */
export function parseQty(s) {
  if (s == null || s === '') return null;
  const t = String(s).trim().replace(/\s/g, '');
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Ist die Datei zeitlich absteigend sortiert? Dann umdrehen → chronologisch. */
export function chronological(items, dateOf) {
  if (items.length > 1 && dateOf(items[0]) > dateOf(items[items.length - 1])) return [...items].reverse();
  return items;
}

// ---------------------------------------------------------------- Ergebnis
const sum = list => list.reduce((a, t) => a + (t.amount || 0), 0);

function periodTitle(from, to) {
  if (from && to && from.slice(0, 7) === to.slice(0, 7)) return { month: `${to.slice(5, 7)}/${to.slice(0, 4)}` };
  if (from && to) return { range: `${fmtDate(from, { short: true })}–${fmtDate(to)}` };
  if (to) return { range: fmtDate(to) };
  return {};
}

/**
 * Baut das ParseResult.
 * o: { type, format, institution, account, transactions, holdings, valuations, opening, closing, openingDate, closingDate,
 *      periodFrom, periodTo, style:'auszug'|'umsaetze', confidence, reviewReasons, fields, total }
 */
export function buildResult(o) {
  const account = o.account || null;
  const accKey = account ? accountKeyOf(account) : slug(o.institution || 'konto');
  const txs = finalizeTransactions(o.transactions || [], accKey);
  const dates = txs.map(t => t.bookingDate).filter(Boolean).sort();
  const periodFrom = o.periodFrom || dates[0] || o.openingDate || null;
  const periodTo = o.periodTo || dates[dates.length - 1] || o.closingDate || null;
  const total = sum(txs);
  const reasons = [...(o.reviewReasons || [])];

  let balance = null;
  const { opening = null, closing = null } = o;
  if (opening != null || closing != null) {
    const check = opening != null && closing != null ? opening + total === closing : null;
    balance = { opening, closing, openingDate: o.openingDate || periodFrom, closingDate: o.closingDate || periodTo, check };
    if (check === false) reasons.unshift('Saldo stimmt nicht');
  }

  const valuations = [...(o.valuations || [])];
  if (!valuations.length && closing != null && o.type !== 'depot') {
    valuations.push({ date: balance.closingDate, value: closing, label: `Kontostand ${account?.name || o.institution || ''}`.trim() });
  }

  const label = account?.name || o.institution || 'Konto';
  const pt = periodTitle(periodFrom, periodTo);
  let title;
  if (o.type === 'depot') title = `${o.style === 'bestand' ? 'Depotbestand' : 'Depotumsätze'} ${label}${periodTo ? ' ' + fmtDate(periodTo) : ''}`;
  else if (o.style === 'umsaetze') title = `Umsätze ${label}${pt.range ? ' ' + pt.range : pt.month ? ' ' + pt.month : ''}`;
  else title = `Kontoauszug ${label}${pt.month ? ' ' + pt.month : pt.range ? ' ' + pt.range : ''}`;

  const needsReview = reasons.length > 0 || !!o.needsReview;
  return {
    document: {
      type: o.type, subtype: account?.kind || null, institution: o.institution || null,
      date: periodTo, periodFrom, periodTo, issuer: o.institution || null,
      amount: o.total ?? null, currency: account?.currency || 'EUR', title,
      fields: {
        format: o.format, iban: account?.iban || null, accountName: account?.name || null,
        openingBalance: opening, closingBalance: closing, transactionCount: txs.length,
        ...(o.fields || {}),
      },
      confidence: o.confidence ?? 0.8,
      needsReview, reviewReason: needsReview ? reasons.join('; ') || (o.reviewReason || null) : null,
    },
    account,
    transactions: txs,
    lineItems: [],
    holdings: o.holdings || [],
    valuations,
    balance,
    payroll: null,
    vat: null,
  };
}

/**
 * Saldo-Differenz d = Endsaldo − (Anfangssaldo + Summe): Liegt genau eine Buchung mit Betrag −d/2 vor, hat sie
 * vermutlich das falsche Vorzeichen (Soll/Haben falsch gelesen). Dreht das Vorzeichen und gibt den Prüfgrund zurück.
 */
export function fixSignByBalance(transactions, opening, closing) {
  if (opening == null || closing == null || !transactions.length) return null;
  const d = closing - (opening + sum(transactions));
  if (d === 0 || d % 2 !== 0) return null;
  const hits = transactions.filter(t => t.amount === -d / 2);
  if (hits.length !== 1) return null;
  const t = hits[0];
  const before = t.amount;
  t.amount = -t.amount;
  return {
    signal: `Vorzeichen korrigiert: ${fmtDate(t.bookingDate)} ${fmtEUR(before)} → ${fmtEUR(t.amount)}`,
    reason: `Vorzeichen einer Buchung korrigiert (${fmtDate(t.bookingDate)}, ${fmtEUR(t.amount)}) – bitte prüfen`,
  };
}

/** Prüft ob Zeilen-Salden fortlaufend stimmen (chronologisch). Gibt Anzahl Abweichungen zurück. */
export function runningBalanceMismatches(items) {
  let bad = 0;
  for (let i = 1; i < items.length; i++) {
    if (items[i].saldo != null && items[i - 1].saldo != null && items[i - 1].saldo + items[i].amount !== items[i].saldo) bad++;
  }
  return bad;
}

export function detection(type, format, institution, confidence, signals, extra = {}) {
  return { type, format, institution: institution || null, confidence: Math.min(1, Math.round(confidence * 100) / 100), signals, ...extra };
}
