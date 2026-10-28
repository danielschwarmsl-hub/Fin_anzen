// Generischer Bank-CSV-Parser mit Spalten-Erkennung über Kopfzeilen-Schlüsselwörter + benannte Profile (Sparkasse, DKB, N26, Volksbank)
import { normalizeIban } from '../../util/format.js';
import {
  lc, cleanText, makeTx, buildResult, chronological, kindFromName, KIND_LABEL, accountName, findIban, institutionFromIban,
  normalizeBookingText, toCents, toIso, findDateRange, runningBalanceMismatches, detection,
} from './common.js';

const norm = s => lc(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[*()€\[\]\\:]/g, ' ').replace(/\s+/g, ' ').trim();

// Reihenfolge = Priorität; jedes Feld nimmt die erste noch freie, passende Spalte (von links)
const RULES = [
  ['date', /^(buchungsdatum|buchungstag|booking date|buchung|bu-tag|datum|date|transaktionsdatum|umsatzdatum|belegdatum)$/],
  ['valueDate', /wertstellung|valuta|value date|^wert$/],
  ['date', /buchungs?(datum|tag)|datum|date/],
  ['amount', /^(betrag|amount|umsatz in eur|umsatz eur|betrag eur|amount eur|umsatz|wert in eur|betrag in eur)$/],
  ['amount', /^(betrag|amount)\b|umsatz in/],
  ['debit', /^(soll|belastung|ausgaben|debit)\b/],
  ['credit', /^(haben|einnahmen|credit)\b/],
  ['accountIban', /^auftragskonto$|iban auftragskonto|iban kontoinhaber|iban des kontoinhabers/],
  ['iban', /iban|kontonummer ?\/ ?iban/],
  ['payee', /^zahlungsempf|^empfaenger$/],
  ['payer', /^zahlungspflichtig|^auftraggeber$/],
  ['counterparty', /beguenstigter|auftraggeber|empfaenger|name zahlungsbeteiligter|partner name|zahlungsbeteiligter|^name$|^payee$|^beneficiary/],
  ['purpose', /^(verwendungszweck|purpose|payment reference|zahlungsreferenz|beschreibung|description|zweck|mitteilung|text|buchungsinformation|buchungsdetails)$/],
  ['purpose', /verwendungszweck|payment reference/],
  ['bookingText', /^(umsatztyp|vorgang|type|typ|transaktionsart|buchungsart|umsatzart)$/],
  ['currency', /^(waehrung|currency|whrg)\b/],
  ['mandateId', /mandatsreferenz|mandate/],
  ['creditorId', /glaeubiger/],
  ['reference', /kundenreferenz|end-?to-?end|^referenz/],
  ['balance', /^(saldo|balance)\b/],
  ['status', /^(status|state)$/],
];
const FIELD_NAMES = ['date', 'valueDate', 'amount', 'debit', 'credit', 'counterparty', 'purpose', 'iban', 'bookingText', 'currency', 'accountIban', 'payer', 'payee', 'mandateId', 'creditorId', 'reference', 'balance', 'status'];

function mapRow(row) {
  const names = row.map(norm);
  const cols = Object.fromEntries(FIELD_NAMES.map(f => [f, null]));
  const used = new Set();
  for (const [f, re] of RULES) {
    if (cols[f] != null) continue;
    const i = names.findIndex((n, k) => !used.has(k) && n && re.test(n));
    if (i >= 0) { cols[f] = i; used.add(i); }
  }
  // "Buchungstext": ohne eigenen Verwendungszweck ist es der Freitext (Commerzbank: Umsatzart + Buchungstext), sonst die Buchungsart (Sparkasse)
  const bt = names.findIndex((n, k) => !used.has(k) && n === 'buchungstext');
  if (bt >= 0) {
    if (cols.purpose == null) cols.purpose = bt;
    else if (cols.bookingText == null) cols.bookingText = bt;
  }
  return { cols, names };
}
const usable = c => c.date != null && (c.amount != null || (c.debit != null && c.credit != null) || c.debit != null || c.credit != null);

function profileOf(names, cols) {
  const has = re => names.some(n => re.test(n));
  if (has(/^auftragskonto$/) && (has(/glaeubiger/) || has(/beguenstigter ?\/ ?zahlungspflichtiger/))) return { institution: 'Sparkasse', name: 'sparkasse_camt_v2' };
  if (cols.payer != null && cols.payee != null && has(/^umsatztyp$/)) return { institution: 'DKB', name: 'dkb' };
  if (has(/^partner iban$/) || (has(/^booking date$/) && has(/^partner name$/))) return { institution: 'N26', name: 'n26' };
  if (has(/name zahlungsbeteiligter/) && has(/iban zahlungsbeteiligter/)) return { institution: 'Volksbank', name: 'volksbank' };
  if (has(/^buchungsdetails$/) && has(/^umsatzart$/)) return { institution: 'Postbank', name: 'postbank' };
  return null;
}

/**
 * Spalten-Mapping erraten.
 * → { headerRow, columns:{date,valueDate,amount,debit,credit,counterparty,purpose,iban,bookingText,currency,…}, profile, confidence }
 */
export function guessCsvMapping(rows) {
  const empty = { headerRow: -1, columns: Object.fromEntries(FIELD_NAMES.map(f => [f, null])), profile: null, confidence: 0 };
  if (!rows?.length) return empty;
  const lim = Math.min(rows.length, 60);
  for (let i = 0; i < lim; i++) {
    const r = rows[i];
    if (!r || r.filter(c => String(c ?? '').trim()).length < 3) continue;
    const { cols, names } = mapRow(r.map(c => String(c ?? '')));
    if (!usable(cols)) continue;
    // Plausibilitätsprüfung: in den Folgezeilen steht ein parsbares Datum
    const next = rows.slice(i + 1, i + 12);
    const ok = next.filter(x => toIso(x?.[cols.date]) != null).length;
    if (!ok && next.length) continue;
    const profile = profileOf(names, cols);
    const filled = Object.values(cols).filter(v => v != null).length;
    const confidence = Math.min(0.95, 0.4 + filled * 0.06 + (profile ? 0.2 : 0));
    return { headerRow: i, columns: cols, profile, confidence: Math.round(confidence * 100) / 100 };
  }
  return empty;
}

export function detectGenericCsv(ctx) {
  const rows = ctx.rows;
  if (!rows || rows.length < 2) return null;
  const m = guessCsvMapping(rows);
  if (m.headerRow < 0) return null;
  const signals = [`Kopfzeile in Zeile ${m.headerRow + 1}`, `Datum + ${m.columns.amount != null ? 'Betrag' : 'Soll/Haben'}`];
  if (m.profile) signals.push(`Profil ${m.profile.name}`);
  const sample = rows.slice(m.headerRow + 1, m.headerRow + 40);
  const dated = sample.filter(r => toIso(r[m.columns.date]) != null).length;
  if (!sample.length || dated / sample.length < 0.5) return null;
  const iban = findIban(rows.slice(0, m.headerRow).map(r => r.join(' ')).join(' ')) || (m.columns.accountIban != null ? rows[m.headerRow + 1]?.[m.columns.accountIban] : null);
  const inst = m.profile?.institution || institutionFromIban(iban) || null;
  return detection('kontoauszug', 'generic_csv', inst, m.profile ? 0.82 : Math.min(0.62, m.confidence), signals, { mapping: m, profile: m.profile?.name || null });
}

/**
 * Parst Zeilen mit explizitem Mapping.
 * accountInfo: { institution?, name?, iban?, kind?, currency?, number? }
 */
export function parseCsvWithMapping(rows, mapping, accountInfo = {}) {
  const c = mapping.columns;
  const hi = mapping.headerRow ?? 0;
  const names = (rows[hi] || []).map(norm);
  const profile = mapping.profile || profileOf(names, c);
  const pre = rows.slice(0, Math.max(hi, 0));
  const preText = pre.map(r => r.join(' ')).join(' ');

  const get = (r, k) => (c[k] != null ? r[c[k]] : undefined);
  const stat = { skipped: 0, pending: 0 };
  let items = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || !r.some(x => String(x ?? '').trim())) continue;
    const bookingDate = toIso(get(r, 'date'));
    let amount;
    if (c.amount != null) amount = toCents(get(r, 'amount'));
    else {
      const d = toCents(get(r, 'debit')), cr = toCents(get(r, 'credit'));
      amount = d == null && cr == null ? null : (cr || 0) - Math.abs(d || 0);
    }
    if (!bookingDate || amount == null) { stat.skipped++; continue; }
    const status = cleanText(get(r, 'status'));
    if (status && /vorgemerkt|offen|pending|ausstehend/i.test(status)) { stat.pending++; continue; }
    items.push({ r, bookingDate, valueDate: toIso(get(r, 'valueDate')), amount, saldo: c.balance != null ? toCents(get(r, 'balance')) : null });
  }
  items = chronological(items, x => x.bookingDate);

  const accIban = normalizeIban(accountInfo.iban) || findIban(preText) || (c.accountIban != null ? findIban(items[0]?.r[c.accountIban]) : null)
    || null;
  const institution = accountInfo.institution || profile?.institution || institutionFromIban(accIban) || 'Unbekannt';
  const labelHint = accountInfo.name || cleanText(pre.map(r => r.join(' ')).find(x => /girokonto|tagesgeld|visa|kreditkarte|mastercard/i.test(x)) || '');
  const kind = accountInfo.kind || kindFromName(labelHint || 'Girokonto');
  const account = {
    kind, institution, name: accountInfo.name && accountInfo.name.includes(institution) ? accountInfo.name : accountName(institution, accountInfo.name || KIND_LABEL[kind]),
    iban: accIban, currency: accountInfo.currency || cleanText(get(items[0]?.r || [], 'currency')) || 'EUR', number: accountInfo.number || null,
  };

  const transactions = items.map(({ r, bookingDate, valueDate, amount }) => {
    let party = cleanText(get(r, 'counterparty'));
    if (!party && (c.payer != null || c.payee != null)) {
      const out = amount < 0;
      // Beide Spalten (DKB, Postbank): Gegenpartei je Richtung; nur eine vorhanden: diese
      party = cleanText(c.payer != null && c.payee != null ? get(r, out ? 'payee' : 'payer') : get(r, c.payee != null ? 'payee' : 'payer'));
    }
    const rawType = cleanText(get(r, 'bookingText'));
    let purpose = cleanText(get(r, 'purpose'));
    return makeTx({
      bookingDate, valueDate, amount, currency: cleanText(get(r, 'currency')) || account.currency,
      counterpartyRaw: party, counterpartyIban: findIban(String(get(r, 'iban') ?? '').toUpperCase()) || null,
      purpose, bookingText: normalizeBookingText(rawType) || rawType || null,
      mandateId: cleanText(get(r, 'mandateId')) || null, creditorId: cleanText(get(r, 'creditorId')) || null,
      endToEndId: cleanText(get(r, 'reference')) || null,
    });
  });

  // Salden: Spalte "Saldo" oder Kopfzeile "Kontostand vom …: x"
  let opening = null, closing = null, openingDate = null, closingDate = null;
  const reasons = [];
  if (items.length && items.every(i => i.saldo != null)) {
    opening = items[0].saldo - items[0].amount;
    closing = items[items.length - 1].saldo;
    if (runningBalanceMismatches(items) > 0) reasons.push('Saldo-Verlauf unstimmig');
  } else {
    for (const r of pre) {
      const m = /kontostand(?:\s+vom\s+(\d{2}\.\d{2}\.\d{4}))?/i.exec(r[0] || '');
      if (m && r[1] != null && toCents(r[1]) != null) { closing = toCents(r[1]); closingDate = m[1] ? toIso(m[1]) : null; break; }
    }
  }
  const range = findDateRange(preText);
  if (stat.skipped) reasons.push(`${stat.skipped} Zeile(n) nicht lesbar`);
  const named = !!profile;
  return buildResult({
    type: kind === 'kreditkarte' ? 'kreditkarte' : 'kontoauszug', format: 'generic_csv', institution, account, transactions,
    opening, closing, openingDate, closingDate, periodFrom: range?.from, periodTo: range?.to, style: 'umsaetze',
    confidence: named ? 0.85 : 0.6, reviewReasons: reasons, needsReview: false,
    fields: { profile: profile?.name || null, skippedRows: stat.skipped, pendingSkipped: stat.pending, mapping: c },
  });
}

export function parseGenericCsv(det, ctx) {
  const rows = ctx.rows;
  const mapping = det?.mapping || guessCsvMapping(rows);
  if (mapping.headerRow < 0) throw new Error('Keine Datums-/Betragsspalten gefunden');
  return parseCsvWithMapping(rows, mapping, { institution: det?.institution || undefined });
}
