// PDF-Kontoauszüge: heuristischer Zeilenparser (Buchung beginnt mit Datum, Betrag am Zeilenende)
import { parseGermanAmount, parseGermanDate, normalizeIban } from '../../util/format.js';
import {
  lc, cleanText, makeTx, buildResult, detection, findIban, detectInstitution, institutionFromIban, normalizeBookingText,
  kindFromName, KIND_LABEL, accountName, findDateRange, parseSepaTokens, fixSignByBalance,
} from './common.js';

const AMT = String.raw`[+\-−–]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}[+\-−–]?`;
const AMOUNT_END = new RegExp(String.raw`(?:^|\s)(${AMT})(?:\s*(?:EUR|€))?(?:\s*([SH]))?\s*$`);
const DATE = String.raw`\d{2}\.\d{2}\.(?:\d{4}|\d{2})?`;
const BOOKING_START = new RegExp(String.raw`^(${DATE})(?=\s|$)\s*(?:(${DATE})(?=\s|$))?\s*(.*)$`);
// Nur Seitenköpfe/-füße und Übertragszeilen am Zeilenanfang: Namen wie "Erika Muster" oder "Kontoübertrag" im Zweck bleiben Buchungstext
const SKIP_LINE = /^(seite|page)\s+\d+|^(?:zwischensumme\s+)?[uü]bertrag\b.*(?:seite|\d,\d{2})|^muster\s+[–—-]|testdokument|^\s*umsätze\s*$|^\s*buchungen\s*$|^\s*umsatzübersicht\s*$/i;
const HEADER_LINE = /^(buchung(stag)?|datum|tag|beleg(datum)?)\b.*\b(betrag|soll|haben|umsatz)/i;
const CLOSING_LINE = /^(neuer\s+(saldo|kontostand)|alter\s+(saldo|kontostand)|summe|kontostand|saldo|endsaldo|schlusssaldo|dieser auszug|hinweis|bitte beachten|wichtige|rechnungsabschluss|kontoabschluss|guthaben)/i;
const OPEN_RE = /(alter\s+(?:saldo|kontostand)|saldo\s+alt|anfangs(?:saldo|bestand)|saldo\s+vortrag|kontostand\s+zu\s+beginn)/i;
const CLOSE_RE = /(neuer\s+(?:saldo|kontostand)|saldo\s+neu|end(?:saldo|bestand)|schlusssaldo)/i;
const AMBIG_RE = /kontostand\s+(?:am|vom)/i;
const CARD_RE = /kreditkarten[- ]?(abrechnung|auszug)|(visa|master\s?card)[- ]?(karten)?[- ]?abrechnung|kartenabrechnung|abrechnung\s+ihrer\s+(visa|master)/i;
const PAYPAL_PDF = /paypal/i;

function signedAmount(tok, sh) {
  let v = parseGermanAmount(tok.replace(/[−–]/g, '-'));
  if (v == null) return null;
  if (sh === 'S') v = -Math.abs(v);
  else if (sh === 'H') v = Math.abs(v);
  return v;
}

/** Zählt Zeilen, die wie Buchungen aussehen (Datum vorn, Betrag hinten). */
function countBookingLines(lines) {
  let n = 0;
  for (const l of lines) { const m = BOOKING_START.exec(l.text); if (m && AMOUNT_END.test(m[3] || '')) n++; }
  return n;
}

export function detectPdfStatement(ctx) {
  if (ctx.kind && ctx.kind !== 'pdf' && ctx.kind !== 'image') return null;
  const lines = ctx.lines;
  if (!lines.length) return null;
  const text = lines.map(l => l.text).join('\n');
  const bookings = countBookingLines(lines);
  const hasBalance = OPEN_RE.test(text) || CLOSE_RE.test(text) || AMBIG_RE.test(text);
  const hasWord = /kontoauszug|kontoumsätze|umsatzübersicht|tagesgeld|girokonto|kontoübersicht/i.test(text.slice(0, 3000));
  const card = CARD_RE.test(text.slice(0, 3000));
  if (bookings < 2 || !(hasBalance || hasWord || card)) return null;
  if (!hasBalance && !card && !/kontoauszug/i.test(text)) return null;
  const head = lines.slice(0, 15).map(l => l.text).join('\n');
  const institution = detectInstitution(head) || institutionFromIban(findIban(head)) || detectInstitution(text, { skip: ['PayPal'] });
  const signals = [`${bookings} Buchungszeilen (Datum … Betrag)`];
  let conf = 0.55;
  if (/kontoauszug/i.test(head)) { signals.push('Titel Kontoauszug'); conf += 0.1; }
  if (OPEN_RE.test(text) && CLOSE_RE.test(text)) { signals.push('Alter/Neuer Saldo'); conf += 0.15; }
  else if (hasBalance) { signals.push('Saldozeile'); conf += 0.07; }
  if (institution) { signals.push(`Institut ${institution}`); conf += 0.1; }
  if (findIban(head)) { signals.push('IBAN im Kopf'); conf += 0.05; }
  let type = 'kontoauszug';
  if (card) { type = 'kreditkarte'; signals.push('Kreditkartenabrechnung'); }
  else if (institution === 'PayPal') type = 'paypal';
  return detection(type, 'pdf_statement', institution, conf, signals);
}

/** Spaltenpositionen "Soll"/"Haben" aus Kopfzeile (rechte Kante) */
function findSollHaben(lines) {
  for (const l of lines) {
    if (!l.items?.length) continue;
    const soll = l.items.find(i => /^soll$/i.test(i.str.trim()));
    const haben = l.items.find(i => /^haben$/i.test(i.str.trim()));
    if (soll && haben) return { soll: soll.x + soll.w, haben: haben.x + haben.w };
  }
  return null;
}

function findBalances(lines, period) {
  const out = { opening: null, closing: null, openingDate: null, closingDate: null };
  const ambiguous = [];
  for (const l of lines) {
    const t = l.text;
    const am = AMOUNT_END.exec(t);
    if (!am) continue;
    const v = signedAmount(am[1], am[2]);
    if (v == null) continue;
    const dateM = t.match(/\d{2}\.\d{2}\.\d{4}/);
    const date = dateM ? parseGermanDate(dateM[0]) : null;
    if (OPEN_RE.test(t) && out.opening == null) { out.opening = v; out.openingDate = date; }
    else if (CLOSE_RE.test(t) && out.closing == null) { out.closing = v; out.closingDate = date; }
    else if (AMBIG_RE.test(t)) ambiguous.push({ v, date });
  }
  // "Kontostand am dd.mm.yyyy": Datum entscheidet (Periodenanfang → Anfangssaldo)
  for (const a of ambiguous) {
    const nearStart = period?.from && a.date && Math.abs(Date.parse(a.date) - Date.parse(period.from)) <= 5 * 864e5;
    if (nearStart && out.opening == null) { out.opening = a.v; out.openingDate = a.date; }
    else if (out.closing == null) { out.closing = a.v; out.closingDate = a.date; }
    else if (out.opening == null) { out.opening = a.v; out.openingDate = a.date; }
  }
  return out;
}

function findPeriod(text) {
  let m = text.match(/Zeitraum\s*:?\s*(\d{2}\.\d{2}\.\d{4})\s*(?:-|–|—|bis)\s*(\d{2}\.\d{2}\.\d{4})/i)
    || text.match(/vom\s+(\d{2}\.\d{2}\.\d{4})\s+bis\s+(?:zum\s+)?(\d{2}\.\d{2}\.\d{4})/i);
  if (m) return { from: parseGermanDate(m[1]), to: parseGermanDate(m[2]) };
  const r = findDateRange(text.split('\n').slice(0, 25).join('\n'));
  if (r) return r;
  m = text.match(/Kontoauszug\s+(?:Nr\.?\s*)?(\d{1,2})\/(\d{4})/i);
  if (m) {
    const mo = String(m[1]).padStart(2, '0');
    const last = new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate();
    return { from: `${m[2]}-${mo}-01`, to: `${m[2]}-${mo}-${last}` };
  }
  return null;
}

function yearFor(_day, month, period, fallbackYear) {
  // Jahr für Datumsangaben ohne Jahr; Periode über den Jahreswechsel berücksichtigen
  if (period?.from && period?.to) {
    const fy = +period.from.slice(0, 4), ty = +period.to.slice(0, 4);
    if (fy !== ty) return month >= +period.from.slice(5, 7) ? fy : ty;
    return ty;
  }
  return fallbackYear;
}

const OWN_PERSON_PREFIX = /^(?:Überweisung|Gutschrift|Lastschrift|Zahlung)\s+(?:von|an)\s+/i;

export function parsePdfStatement(det, ctx) {
  const lines = ctx.lines;
  const text = lines.map(l => l.text).join('\n');
  const period = findPeriod(text);
  const fallbackYear = period?.to ? +period.to.slice(0, 4) : (text.match(/\b(20\d{2})\b/) || [])[1] ? +text.match(/\b(20\d{2})\b/)[1] : new Date().getFullYear();
  const bal = findBalances(lines, period);
  const sh = findSollHaben(lines);

  const head = lines.slice(0, 15).map(l => l.text).join('\n');
  const firstBooking = lines.findIndex(l => { const m = BOOKING_START.exec(l.text); return m && AMOUNT_END.test(m[3] || ''); });
  const headText = lines.slice(0, firstBooking > 0 ? firstBooking : 30).map(l => l.text).join('\n');
  const iban = findIban(headText) || findIban(text);
  const institution = det?.institution || detectInstitution(head) || institutionFromIban(iban) || detectInstitution(text, { skip: ['PayPal'] }) || null;

  // Kontoart / Name
  const titleText = headText.slice(0, 600);
  let kind;
  if (det?.type === 'kreditkarte' || CARD_RE.test(titleText)) kind = 'kreditkarte';
  else if (institution === 'PayPal') kind = 'paypal';
  else if (/Renault\s+Bank/i.test(institution || '') || /tagesgeld|sparkonto|extra-konto|festgeld/i.test(titleText)) kind = 'tagesgeld';
  else if (/depot/i.test(titleText) && !/girokonto/i.test(titleText)) kind = 'depot';
  else kind = kindFromName(titleText.match(/\b(girokonto|tagesgeld\w*|extra-konto|sparkonto|visa\S*|mastercard)\b/i)?.[0] || 'Girokonto');
  const account = { kind, institution, name: accountName(institution, KIND_LABEL[kind]), iban, currency: 'EUR', number: null };

  // Buchungen sammeln
  const bookings = [];
  let curB = null;
  const close = () => { curB = null; };
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    const m = BOOKING_START.exec(t);
    const am = m ? AMOUNT_END.exec(m[3] || '') : null;
    if (m && am && !HEADER_LINE.test(t)) {
      const body = m[3] || '';
      const restText = body.slice(0, am.index).trim();
      let amount = signedAmount(am[1], am[2]);
      if (sh && !/[+\-−–]/.test(am[1]) && !am[2]) {
        // Soll/Haben-Spalten: nach x-Position der rechten Kante
        const it = [...l.items].reverse().find(i => i.str.includes(am[1]));
        if (it) {
          const xr = it.x + it.w;
          amount = Math.abs(xr - sh.haben) < Math.abs(xr - sh.soll) ? Math.abs(amount) : -Math.abs(amount);
        }
      }
      const bookingDate = parseGermanDate(m[1], yearFor(m[1], +m[1].slice(3, 5), period, fallbackYear));
      const valueDate = m[2] ? parseGermanDate(m[2], yearFor(m[2], +m[2].slice(3, 5), period, fallbackYear)) : bookingDate;
      curB = { bookingDate, valueDate, amount, head: cleanText(restText), cont: [] };
      bookings.push(curB);
      continue;
    }
    if (HEADER_LINE.test(t) || SKIP_LINE.test(t)) continue;
    if (CLOSING_LINE.test(t)) { close(); continue; }
    if (curB) curB.cont.push(cleanText(t));
  }

  const transactions = bookings.map(b => {
    let cont = [...b.cont];
    let counterpartyIban = null;
    cont = cont.filter(c => {
      const im = /^IBAN:?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{10,})$/.exec(c);
      if (im) { counterpartyIban = findIban(im[1]); return false; }
      return true;
    });
    const known = normalizeBookingText(b.head);
    let bookingText = known || b.head || null;
    let counterparty, purpose;
    if (known === 'Zinsen' || known === 'Gebühr') {
      counterparty = institution || cont[0] || b.head;
      purpose = cont.join(' ') || b.head;
    } else if (known || (b.head && b.head.length < 40 && cont.length)) {
      counterparty = (cont[0] || b.head).replace(OWN_PERSON_PREFIX, '');
      purpose = cont.slice(1).join(' ') || (cont[0] || b.head);
    } else {
      counterparty = b.head; purpose = cont.join(' ');
      bookingText = null;
    }
    return makeTx({
      bookingDate: b.bookingDate, valueDate: b.valueDate, amount: b.amount,
      counterpartyRaw: counterparty, purpose, bookingText, counterpartyIban,
    });
  }).filter(t => t.bookingDate && t.amount != null);

  // Vorzeichen-Fallback: stimmt der Saldo nur bei invertierten Beträgen (z. B. Kreditkarte), invertieren
  const total = transactions.reduce((a, t) => a + t.amount, 0);
  const signals = [];
  if (bal.opening != null && bal.closing != null && bal.opening + total !== bal.closing && bal.opening - total === bal.closing) {
    transactions.forEach(t => { t.amount = -t.amount; });
    signals.push('Vorzeichen invertiert');
  }

  const reasons = [];
  // Genau eine Buchung mit halber Saldo-Differenz: Vorzeichen falsch gelesen → drehen und zur Prüfung markieren
  const flip = fixSignByBalance(transactions, bal.opening, bal.closing);
  if (flip) { signals.push(flip.signal); reasons.push(flip.reason); }
  if (bal.opening == null || bal.closing == null) reasons.push('Salden nicht gefunden');
  if (!transactions.length) reasons.push('Keine Buchungen erkannt');
  const periodFrom = period?.from || bal.openingDate || null;
  const periodTo = period?.to || bal.closingDate || null;
  const hasBoth = bal.opening != null && bal.closing != null;
  const sum = transactions.reduce((a, t) => a + t.amount, 0);
  const ok = hasBoth && bal.opening + sum === bal.closing;
  return buildResult({
    type: det?.type || (kind === 'kreditkarte' ? 'kreditkarte' : kind === 'paypal' ? 'paypal' : 'kontoauszug'),
    format: 'pdf_statement', institution, account, transactions,
    opening: bal.opening, closing: bal.closing, openingDate: bal.openingDate || periodFrom, closingDate: bal.closingDate || periodTo,
    periodFrom, periodTo, style: 'auszug', confidence: ok ? (flip ? 0.7 : 0.85) : 0.5, reviewReasons: reasons,
    fields: { signals },
  });
}
