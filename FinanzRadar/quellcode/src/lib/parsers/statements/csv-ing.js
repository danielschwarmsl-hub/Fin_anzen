// ING (DiBa) CSV "Umsatzanzeige": Preamble (Key;Value) + Tabelle ab "Buchung;Wertstellungsdatum|Valuta;…"
import { normalizeIban } from '../../util/format.js';
import {
  lc, cleanText, makeTx, buildResult, chronological, kindFromName, KIND_LABEL, accountName,
  normalizeBookingText, toCents, toIso, findDateRange, runningBalanceMismatches, detection,
} from './common.js';

function findHeader(rows) {
  const lim = Math.min(rows.length, 60);
  for (let i = 0; i < lim; i++) {
    const r = rows[i].map(lc);
    if (r[0] === 'buchung' && r.some(c => /auftraggeber\s*\/\s*empf/.test(c))) return i;
  }
  return -1;
}

export function detectIngCsv(ctx) {
  const rows = ctx.rows;
  if (!rows) return null;
  const hi = findHeader(rows);
  if (hi < 0) return null;
  const signals = ['Kopfzeile Buchung;…;Auftraggeber/Empfänger'];
  let conf = 0.85;
  if (rows.slice(0, hi).some(r => /umsatzanzeige/i.test(String(r[0])))) { signals.push('Umsatzanzeige'); conf += 0.07; }
  if (rows.slice(0, hi).some(r => lc(r[0]) === 'bank' && /ing/i.test(String(r[1])))) { signals.push('Bank;ING'); conf += 0.05; }
  return detection('kontoauszug', 'ing_csv', 'ING', conf, signals);
}

export function parseIngCsv(det, ctx) {
  const rows = ctx.rows;
  const hi = findHeader(rows);
  const meta = {};
  for (const r of rows.slice(0, hi)) if (r[0] && r.length > 1) meta[lc(r[0]).replace(/:$/, '')] = r.slice(1);
  const h = rows[hi].map(lc);
  const idx = {
    booking: 0,
    value: h.findIndex(c => /wertstellung|valuta/.test(c)),
    party: h.findIndex(c => /auftraggeber/.test(c)),
    text: h.findIndex(c => c === 'buchungstext'),
    purpose: h.findIndex(c => /verwendungszweck/.test(c)),
    saldo: h.findIndex(c => c === 'saldo'),
    amount: h.findIndex(c => c === 'betrag'),
  };
  const curIdx = idx.amount >= 0 && /w(ä|ae)hrung/.test(h[idx.amount + 1] || '') ? idx.amount + 1 : -1;

  let items = [];
  for (const r of rows.slice(hi + 1)) {
    const bookingDate = toIso(r[idx.booking]);
    const amount = toCents(r[idx.amount]);
    if (!bookingDate || amount == null) continue;
    items.push({
      bookingDate, valueDate: idx.value >= 0 ? toIso(r[idx.value]) : null, amount,
      saldo: idx.saldo >= 0 ? toCents(r[idx.saldo]) : null,
      party: r[idx.party] || '', text: idx.text >= 0 ? r[idx.text] : '', purpose: idx.purpose >= 0 ? r[idx.purpose] : '',
      currency: (curIdx >= 0 && r[curIdx]) || 'EUR',
    });
  }
  items = chronological(items, x => x.bookingDate);

  const iban = normalizeIban(meta.iban?.[0]) || null;
  const kontoname = cleanText(meta.kontoname?.[0] || 'Girokonto');
  const kind = kindFromName(kontoname);
  const account = {
    kind, institution: 'ING', name: accountName('ING', kontoname === 'Girokonto' || !kontoname ? KIND_LABEL[kind] : kontoname),
    iban, currency: items[0]?.currency || meta.saldo?.[1] || 'EUR', number: null,
  };
  const range = findDateRange(meta.zeitraum?.[0] || '');
  const total = items.reduce((a, t) => a + t.amount, 0);

  // Salden: Eröffnung aus erster Zeile (Saldo nach Buchung − Betrag), Schluss aus Kopf oder letzter Zeile
  let opening = null, closing = toCents(meta.saldo?.[0]);
  if (items.length && items[0].saldo != null) opening = items[0].saldo - items[0].amount;
  if (closing == null && items.length) closing = items[items.length - 1].saldo;
  const reasons = [];
  if (runningBalanceMismatches(items) > 0) reasons.push('Saldo-Verlauf unstimmig');

  const transactions = items.map(i => makeTx({
    bookingDate: i.bookingDate, valueDate: i.valueDate, amount: i.amount, currency: i.currency,
    counterpartyRaw: i.party, purpose: i.purpose, bookingText: normalizeBookingText(i.text) || cleanText(i.text) || null,
  }));
  return buildResult({
    type: 'kontoauszug', format: 'ing_csv', institution: 'ING', account, transactions,
    opening, closing, periodFrom: range?.from, periodTo: range?.to,
    openingDate: range?.from, closingDate: range?.to, style: 'umsaetze', confidence: 0.95, reviewReasons: reasons,
    fields: { rawBookingTexts: [...new Set(items.map(i => i.text).filter(Boolean))].slice(0, 20) },
  });
}
