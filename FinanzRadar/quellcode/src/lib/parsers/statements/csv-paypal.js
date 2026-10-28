// PayPal "Aktivitäten"-CSV (deutsch / englisch)
import { parseGermanDate } from '../../util/format.js';
import { lc, cleanText, makeTx, buildResult, detection, toCents, chronological } from './common.js';

const norm = s => lc(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const FIELDS = {
  date: ['datum', 'date'], time: ['uhrzeit', 'time'], name: ['name'], type: ['typ', 'type', 'beschreibung', 'description'],
  status: ['status'], currency: ['waehrung', 'currency'], gross: ['brutto', 'gross'], fee: ['gebuehr', 'entgelt', 'fee'], net: ['netto', 'net'],
  impact: ['auswirkung auf guthaben', 'balance impact'], tz: ['zeitzone', 'timezone'],
  from: ['absender e mail adresse', 'from email address'], to: ['empfaenger e mail adresse', 'to email address'],
  txid: ['transaktionscode', 'transaction id'], balance: ['guthaben', 'balance'], subject: ['betreff', 'subject'],
  item: ['artikelbezeichnung', 'item title'], note: ['hinweis', 'note'], ref: ['zugehoeriger transaktionscode', 'reference txn id'],
  invoice: ['rechnungsnummer', 'invoice number'],
};
function mapHeader(row) {
  const h = row.map(norm);
  const idx = {};
  for (const [f, names] of Object.entries(FIELDS)) idx[f] = h.findIndex(c => names.includes(c));
  return { idx, english: idx.gross >= 0 && norm(row[idx.gross]) === 'gross' };
}
const hasPaypalHeader = row => {
  const { idx } = mapHeader(row);
  return idx.date >= 0 && idx.net >= 0 && idx.gross >= 0 && idx.txid >= 0;
};

export function detectPaypalCsv(ctx) {
  const rows = ctx.rows;
  if (!rows) return null;
  const hi = rows.slice(0, 15).findIndex(hasPaypalHeader);
  if (hi < 0) return null;
  const { english } = mapHeader(rows[hi]);
  return detection('paypal', 'paypal_csv', 'PayPal', 0.93, [`PayPal-Kopfzeile (${english ? 'EN' : 'DE'})`, 'Brutto/Netto/Transaktionscode']);
}

const COMPLETED_NOT = /ausstehend|pending|storniert|cancel|abgelehnt|denied|declined|zur(ü|ue)ckgehalten|held|expired|abgelaufen|unclaimed|nicht beansprucht|failed|fehlgeschlagen|offen/i;
const MEMO = /autorisierung|authori[sz]ation/i;
const BANK_FUNDING = /bankgutschrift auf paypal|bank deposit to pp|allgemeine abbuchung\W+bankkonto|general withdrawal|abbuchung vom bankkonto|auszahlung auf bankkonto|withdraw funds to bank|bankeinzug|add funds from|guthaben aufladen|bank account/i;
const CONVERSION = /w(ä|ae)hrungsumrechnung|currency conversion|conversion/i;

const US_TZ = /^(?:PST|PDT|EST|EDT|CST|CDT|MST|MDT|AKST|AKDT|HST)$/i;
/** Schreibweise "a/b/JJJJ" einer Datei: 'dm' oder 'md'. Eindeutige Tage (>12) entscheiden; sonst Zeitzone (US → Monat zuerst). */
function slashOrder(dates, zones) {
  let dm = 0, md = 0;
  for (const v of dates) {
    const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/\d{4}/);
    if (!m) continue;
    if (+m[1] > 12) dm++; else if (+m[2] > 12) md++;
  }
  if (dm !== md) return dm > md ? 'dm' : 'md';
  return zones.some(z => US_TZ.test(String(z || '').trim())) ? 'md' : (zones.some(Boolean) ? 'dm' : 'md');
}
function parseDate(s, order) {
  const v = String(s || '').trim();
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [d, mo] = order === 'dm' ? [+m[1], +m[2]] : [+m[2], +m[1]];
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return parseGermanDate(v);
}

export function parsePaypalCsv(det, ctx) {
  const rows = ctx.rows;
  const hi = rows.slice(0, 15).findIndex(hasPaypalHeader);
  const { idx } = mapHeader(rows[hi]);
  const get = (r, f) => (idx[f] >= 0 ? r[idx[f]] ?? '' : '');
  const body = rows.slice(hi + 1).filter(r => r.length > 4);
  const order = slashOrder(body.map(r => get(r, 'date')), body.map(r => get(r, 'tz')));
  let all = body.map(r => ({ r, date: parseDate(get(r, 'date'), order), time: String(get(r, 'time')) })).filter(x => x.date);
  all = chronological(all, x => x.date + ' ' + x.time);
  const byId = new Map(all.map(x => [get(x.r, 'txid'), x.r]));

  let skippedPending = 0, skippedMemo = 0, skippedForeign = 0;
  const kept = [];
  for (const x of all) {
    const r = x.r;
    const status = cleanText(get(r, 'status')), type = cleanText(get(r, 'type'));
    if (status && COMPLETED_NOT.test(status)) { skippedPending++; continue; }
    if (MEMO.test(type)) { skippedMemo++; continue; }
    // Neuere Exporte: "Auswirkung auf Guthaben" = Memo → keine Kontobewegung (Einzugsverfahren-Zeilen bleiben für die Zuordnung zur Bankbuchung)
    if (/^memo$/i.test(cleanText(get(r, 'impact'))) && !/einzugsverfahren|direct debit/i.test(type)) { skippedMemo++; continue; }
    const cur = cleanText(get(r, 'currency')) || 'EUR';
    if (cur !== 'EUR') { skippedForeign++; continue; }
    const net = toCents(get(r, 'net'));
    if (net == null) continue;
    kept.push({ ...x, net, gross: toCents(get(r, 'gross')), fee: toCents(get(r, 'fee')), type, status, balance: toCents(get(r, 'balance')) });
  }

  // Konto-E-Mail: häufigste eigene Adresse
  const mails = new Map();
  for (const k of kept) { const m = cleanText(k.net < 0 ? get(k.r, 'from') : get(k.r, 'to')); if (m) mails.set(m, (mails.get(m) || 0) + 1); }
  const email = [...mails.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const transactions = kept.map(k => {
    const r = k.r;
    let name = cleanText(get(r, 'name'));
    const subject = cleanText(get(r, 'subject')), item = cleanText(get(r, 'item')), note = cleanText(get(r, 'note'));
    const purpose = [item, subject, note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' – ') || k.type;
    const txid = cleanText(get(r, 'txid'));
    const base = { bookingDate: k.date, amount: k.net, currency: 'EUR', fee: k.fee ? Math.abs(k.fee) : null, endToEndId: txid || null, dedupeToken: txid ? txid.toLowerCase() : null };
    if (BANK_FUNDING.test(k.type) && !CONVERSION.test(k.type)) {
      const nm = k.net < 0 ? 'PayPal-Auszahlung (Bankkonto)' : 'PayPal-Aufladung (Bankkonto)';
      return makeTx({ ...base, counterpartyRaw: nm, counterparty: nm, purpose: k.type, bookingText: 'Bankeinzug', isTransfer: true });
    }
    if (CONVERSION.test(k.type)) {
      const orig = byId.get(cleanText(get(r, 'ref')));
      if (!name && orig) name = cleanText(idx.name >= 0 ? orig[idx.name] : '');
      return makeTx({ ...base, counterpartyRaw: name || 'PayPal', purpose: `${k.type}${purpose !== k.type ? ' – ' + purpose : ''}`, bookingText: 'Währungsumrechnung' });
    }
    return makeTx({ ...base, counterpartyRaw: name || subject || 'PayPal', purpose, bookingText: k.type || null });
  });

  const account = { kind: 'paypal', institution: 'PayPal', name: 'PayPal', iban: null, currency: 'EUR', number: email };
  // Salden aus Spalte "Guthaben" (Stand nach Buchung)
  let opening = null, closing = null;
  const withBal = kept.filter(k => k.balance != null);
  if (withBal.length === kept.length && kept.length) {
    opening = kept[0].balance - kept[0].net;
    closing = kept[kept.length - 1].balance;
  }
  const res = buildResult({
    type: 'paypal', format: 'paypal_csv', institution: 'PayPal', account, transactions, opening, closing,
    openingDate: kept[0]?.date, closingDate: kept[kept.length - 1]?.date, style: 'umsaetze', confidence: 0.92,
    fields: { skippedPending, skippedMemo, skippedForeign, totalFees: transactions.reduce((a, t) => a + (t.fee || 0), 0) },
  });
  return res;
}
