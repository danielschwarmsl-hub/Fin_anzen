// comdirect: Umsätze Girokonto / Tagesgeld PLUS / Visa-Karte (mehrere Abschnitte je Datei) und Depot (Bestand + Umsätze)
import { normalizeIban } from '../../util/format.js';
import {
  lc, cleanText, makeTx, buildResult, chronological, kindFromName, KIND_LABEL, accountName, findIban,
  normalizeBookingText, toCents, toIso, findDateRange, parseQty, detection,
} from './common.js';

const isSectionTitle = r => /^Ums(ä|ae)tze\b/i.test(r[0] || '');
const isTxHeader = r => lc(r[0]) === 'buchungstag' && r.some(c => /umsatz in|betrag/i.test(c)) && !r.some(c => /w(ä|ae)hrung|wkn/i.test(c));
const isDepotUmsatzHeader = r => lc(r[0]) === 'buchungstag' && r.some(c => /gesch(ä|ae)ftstag/i.test(c)) && r.some(c => /wkn/i.test(c));
const isDepotBestandHeader = r => r.some(c => lc(c) === 'isin') && r.some(c => lc(c) === 'wkn') && r.some(c => /st(ü|ue)ck|nom/i.test(c)) && !isDepotUmsatzHeader(r);

export function detectComdirectCsv(ctx) {
  const rows = ctx.rows;
  if (!rows) return null;
  const head = rows.slice(0, 60);
  if (head.some(isDepotUmsatzHeader) || head.some(isDepotBestandHeader)) return null;
  const title = head.find(isSectionTitle);
  const hdr = head.find(isTxHeader);
  if (!hdr) return null;
  const signals = [];
  let conf = 0.7;
  if (title) { signals.push(`Abschnitt "${title[0]}"`); conf += 0.15; }
  if (hdr.some(c => /wertstellung \(valuta\)/i.test(c)) || hdr.some(c => /^vorgang$/i.test(c))) { signals.push('Kopfzeile Buchungstag;Wertstellung (Valuta);Vorgang'); conf += 0.1; }
  if (head.some(r => /^(alter|neuer) kontostand$/i.test(r[0]))) { signals.push('Kontostand-Zeilen'); conf += 0.05; }
  if (!title && !signals.length) return null;
  const isCard = title && /visa|kredit|mastercard/i.test(title[0]);
  return detection(isCard && !head.some(r => /girokonto/i.test(r[0])) ? 'kreditkarte' : 'kontoauszug', 'comdirect_csv', 'comdirect', conf, signals);
}

export function detectComdirectDepot(ctx) {
  const rows = ctx.rows;
  if (!rows) return null;
  const head = rows.slice(0, 60);
  const best = head.find(isDepotBestandHeader);
  const umsatz = head.find(isDepotUmsatzHeader);
  if (!best && !umsatz) return null;
  const signals = [best ? 'Depotbestand: Bezeichnung;ISIN;WKN;Stück' : 'Depot-Umsätze: Buchungstag;Geschäftstag;WKN'];
  let conf = 0.8;
  if (head.some(r => /^(Depotbestand|Ums(ä|ae)tze Depot)/i.test(r[0] || ''))) { signals.push('Titelzeile Depot'); conf += 0.12; }
  return detection('depot', 'comdirect_depot_csv', 'comdirect', conf, signals);
}

// ------------------------------------------------------------- Buchungstext-Zerlegung
const LABELS = [
  ['Auftraggeber', /Auftraggeber:/g], ['Empfänger', /Empf(?:ä|ae)nger:/g], ['Kto/IBAN', /Kto\/IBAN:/g], ['BLZ/BIC', /BLZ\/BIC:/g],
  ['Buchungstext', /Buchungstext:/g], ['Ref', /(?:End-to-End-)?Ref\.(?:\s*:)?/g], ['Mandat', /Mandatsref(?:erenz)?\.?:/g],
  ['Glaeubiger', /Gl(?:ä|ae)ubiger-?ID:/g], ['Kundenref', /Kundenreferenz:/g],
];
/** "Auftraggeber: X Buchungstext: Y Ref. Z" → Felder, sonst null */
export function splitComdirectText(text) {
  const hits = [];
  for (const [key, re] of LABELS) { re.lastIndex = 0; let m; while ((m = re.exec(text))) hits.push({ key, start: m.index, end: m.index + m[0].length }); }
  if (!hits.some(h => h.key === 'Auftraggeber' || h.key === 'Empfänger' || h.key === 'Buchungstext')) return null;
  hits.sort((a, b) => a.start - b.start);
  const out = {};
  hits.forEach((h, i) => { const v = cleanText(text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length)); if (out[h.key] === undefined) out[h.key] = v; });
  return out;
}
const CARD_RE = /\s+(?:VISA\s+)?(?:Debit|Kredit)karte\b/i;
const COMPANY_RE = /^(.*?\b(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|SE|KG|UG|Ltd\.?|Inc\.?|B\.V\.|S\.C\.A\.?|S\.a\.r\.l\.?(?:\s+et\s+Cie)?|e\.V\.|mbH|OHG|GbR))\b\.?\s+(.+)$/;
const KEYWORD_SPLIT = /\s+(?=(?:Umbuchung|Sparplan|Rechnung|Beitrag|Miete|Gehalt|Lohn|Abo\b|Bestellung|Kd\.|Kundennr|Vertrag|Kartenzahlung|Zinsen)\b)/;
/** Fallback für freie Texte (Beispieldateien): Gegenpartei + Zweck trennen */
export function splitFreeText(text) {
  const t = cleanText(text);
  let m = CARD_RE.exec(t);
  if (m && m.index > 0) return { party: t.slice(0, m.index), purpose: t.slice(m.index).trim() };
  m = COMPANY_RE.exec(t);
  if (m) return { party: m[1], purpose: m[2] };
  const k = KEYWORD_SPLIT.exec(t);
  if (k && k.index > 2) return { party: t.slice(0, k.index), purpose: t.slice(k.index).trim() };
  return { party: t, purpose: t };
}
function interpretText(text) {
  const f = splitComdirectText(text);
  if (f) {
    const party = f['Auftraggeber'] || f['Empfänger'] || '';
    const ibanM = (f['Kto/IBAN'] || '').match(/[A-Z]{2}\d{2}[A-Z0-9 ]{10,32}/);
    return {
      party, purpose: f['Buchungstext'] || '', counterpartyIban: ibanM ? normalizeIban(ibanM[0]).slice(0, 22) : null,
      ref: f['Ref'] || null, mandateId: f['Mandat'] || null, creditorId: f['Glaeubiger'] || null,
    };
  }
  const s = splitFreeText(text);
  return { party: s.party, purpose: s.purpose };
}

// ------------------------------------------------------------- Giro / Tagesgeld / Visa
function sectionsOf(rows) {
  const starts = rows.map((r, i) => (isSectionTitle(r) && !/^Ums(ä|ae)tze Depot/i.test(r[0]) ? i : -1)).filter(i => i >= 0);
  if (!starts.length) { const hi = rows.findIndex(isTxHeader); return hi >= 0 ? [{ start: 0, end: rows.length }] : []; }
  return starts.map((s, i) => ({ start: s, end: i + 1 < starts.length ? starts[i + 1] : rows.length }));
}

function parseSection(rows, sec, ctx) {
  const part = rows.slice(sec.start, sec.end);
  const titleRow = isSectionTitle(part[0]) ? part[0] : null;
  const hi = part.findIndex(isTxHeader);
  if (hi < 0) return null;
  const pre = part.slice(0, Math.max(hi, 0));
  const title = cleanText(titleRow?.[0] || 'Girokonto');
  const label = cleanText(title.replace(/^Ums(ä|ae)tze\s*/i, '')) || 'Girokonto';
  const kind = kindFromName(label);
  const preText = pre.map(r => r.join(' ')).join(' ');
  const range = findDateRange(preText);
  const iban = findIban(preText);
  let opening = null, closing = null;
  for (const r of pre) {
    if (/^alter kontostand/i.test(r[0])) opening = toCents(r[1]);
    if (/^neuer kontostand/i.test(r[0])) closing = toCents(r[1]);
  }
  const h = part[hi].map(lc);
  const col = re => h.findIndex(c => re.test(c));
  const idx = {
    date: 0, value: col(/wertstellung|umsatztag|valuta/), type: col(/^vorgang$/), text: col(/^buchungstext$/),
    ref: col(/^referenz$/), amount: col(/umsatz in|^betrag/),
  };
  let pending = 0;
  let items = [];
  for (const r of part.slice(hi + 1)) {
    if (!r.length || (r.length === 1 && !r[0])) { if (items.length) break; continue; }
    if (/^(alter|neuer) kontostand/i.test(r[0])) continue;
    if (/^offen$/i.test(r[0])) { pending++; continue; }
    const bookingDate = toIso(r[idx.date]);
    const amount = toCents(r[idx.amount]);
    if (!bookingDate || amount == null) continue;
    items.push({ bookingDate, valueDate: idx.value >= 0 ? toIso(r[idx.value]) : null, amount, type: idx.type >= 0 ? r[idx.type] : '', text: idx.text >= 0 ? r[idx.text] : '', ref: idx.ref >= 0 ? r[idx.ref] : '' });
  }
  items = chronological(items, x => x.bookingDate);
  const account = {
    kind, institution: 'comdirect', name: accountName('comdirect', label), iban, currency: 'EUR', number: null,
  };
  const transactions = items.map(i => {
    const it = interpretText(i.text);
    const bt = normalizeBookingText(i.type) || cleanText(i.type) || null;
    return makeTx({
      bookingDate: i.bookingDate, valueDate: i.valueDate, amount: i.amount,
      counterpartyRaw: it.party, purpose: it.purpose || i.text, bookingText: bt, counterpartyIban: it.counterpartyIban,
      endToEndId: it.ref || i.ref || null, mandateId: it.mandateId, creditorId: it.creditorId,
    });
  });
  const res = buildResult({
    type: kind === 'kreditkarte' ? 'kreditkarte' : 'kontoauszug', format: 'comdirect_csv', institution: 'comdirect', account, transactions,
    opening, closing, periodFrom: range?.from, periodTo: range?.to, openingDate: range?.from, closingDate: range?.to,
    style: 'umsaetze', confidence: 0.9, fields: { pendingSkipped: pending },
  });
  // Ohne Alt-/Neu-Saldo: nur Neuer Kontostand als Bewertung zum letzten Buchungstag
  return res;
}

export function parseComdirectCsv(det, ctx) {
  const rows = ctx.rows;
  const secs = sectionsOf(rows);
  return secs.map(s => parseSection(rows, s, ctx)).filter(r => r && (r.transactions.length || r.balance));
}

// ------------------------------------------------------------- Depot
export function parseComdirectDepot(det, ctx) {
  const rows = ctx.rows;
  const hiU = rows.findIndex(isDepotUmsatzHeader);
  const preAll = rows.slice(0, 12);
  const depotNr = (preAll.map(r => r.join(' ').match(/Depot-?Nr\.?\s*:?\s*(\d{4,})/i)).find(Boolean) || [])[1] || null;
  const account = { kind: 'depot', institution: 'comdirect', name: 'comdirect Depot', iban: null, currency: 'EUR', number: depotNr };
  if (hiU >= 0) return parseDepotUmsaetze(rows, hiU, account);

  const hi = rows.findIndex(isDepotBestandHeader);
  const h = rows[hi].map(lc);
  const col = (...res) => { for (const re of res) { const i = h.findIndex(c => re.test(c)); if (i >= 0) return i; } return -1; };
  const idx = {
    name: col(/^bezeichnung/, /^name/), isin: col(/^isin$/), wkn: col(/^wkn$/), qty: col(/st(ü|ue)ck|nom/),
    price: col(/^(aktueller\s+)?kurs$/, /^(aktueller\s+)?kurs(?!.*(datum|zeit|einstand))/), value: col(/wert in eur/, /^kurswert/, /^wert(?!.*einstand)/),
  };
  const stand = rows.slice(0, hi).map(r => (lc(r[0]).startsWith('stand') ? toIso(r[1] || r[0].replace(/^\D*/, '')) : null)).find(Boolean)
    || toIso(rows.slice(0, hi).map(r => r.join(' ')).join(' ').match(/\d{2}\.\d{2}\.\d{4}/)?.[0]);
  const holdings = [];
  let declaredTotal = null;
  for (const r of rows.slice(hi + 1)) {
    if (!r.length || !r.some(Boolean)) continue;
    if (/^(summe|gesamt)/i.test(r[0])) { declaredTotal = [...r].reverse().map(toCentsSafe).find(v => v != null) ?? null; continue; }
    const value = toCents(r[idx.value]);
    if (!r[idx.name] || value == null) continue;
    holdings.push({
      name: r[idx.name], isin: r[idx.isin] || null, wkn: r[idx.wkn] || null,
      qty: parseQty(r[idx.qty]), price: idx.price >= 0 ? toCents(r[idx.price]) : null, value, date: stand,
    });
  }
  const sumValue = holdings.reduce((a, x) => a + x.value, 0);
  const total = declaredTotal ?? sumValue;
  const reasons = [];
  if (declaredTotal != null && declaredTotal !== sumValue) reasons.push('Depotsumme stimmt nicht');
  const res = buildResult({
    type: 'depot', format: 'comdirect_depot_csv', institution: 'comdirect', account, transactions: [], holdings,
    valuations: [{ date: stand, value: total, label: 'Depotwert comdirect' }], periodFrom: stand, periodTo: stand,
    style: 'bestand', total, confidence: 0.92, reviewReasons: reasons, fields: { positions: holdings.length, depotValue: total },
  });
  return res;
}
function toCentsSafe(v) { try { return /\d/.test(String(v)) ? toCents(v) : null; } catch { return null; } }

function parseDepotUmsaetze(rows, hi, account) {
  const h = rows[hi].map(lc);
  const col = re => h.findIndex(c => re.test(c));
  const idx = { date: 0, biz: col(/gesch(ä|ae)ftstag/), qty: col(/st(ü|ue)ck/), name: col(/bezeichnung/), wkn: col(/wkn/), cur: col(/w(ä|ae)hrung/), price: col(/kurs/), amount: col(/umsatz in/) };
  let items = [];
  for (const r of rows.slice(hi + 1)) {
    const bookingDate = toIso(r[idx.date]);
    let amount = toCents(r[idx.amount]);
    if (!bookingDate || amount == null) continue;
    const qty = parseQty(r[idx.qty]);
    // Kauf (Stück > 0) = Mittelabfluss, Verkauf = Zufluss
    if (qty != null && ((qty > 0 && amount > 0) || (qty < 0 && amount < 0))) amount = -amount;
    items.push({ bookingDate, valueDate: toIso(r[idx.biz]), amount, qty, name: r[idx.name], wkn: r[idx.wkn], price: r[idx.price], cur: r[idx.cur] || 'EUR' });
  }
  items = chronological(items, x => x.bookingDate);
  const transactions = items.map(i => makeTx({
    bookingDate: i.bookingDate, valueDate: i.valueDate, amount: i.amount, currency: 'EUR', counterpartyRaw: i.name,
    purpose: `${i.qty != null ? Math.abs(i.qty) : ''} Stück ${i.name} (WKN ${i.wkn || '–'}) zu ${i.price || '–'} ${i.cur}`.trim(),
    bookingText: i.qty != null && i.qty < 0 ? 'Wertpapierverkauf' : 'Wertpapierkauf',
  }));
  return buildResult({
    type: 'depot', format: 'comdirect_depot_csv', institution: 'comdirect', account, transactions, style: 'umsaetze', confidence: 0.85,
    fields: { kind: 'depot-umsaetze' },
  });
}
