// PDF-Kontoauszüge: heuristischer Zeilenparser (Buchung beginnt mit Datum, Betrag am Zeilenende)
import { parseGermanAmount, parseGermanDate, normalizeIban } from '../../util/format.js';
import {
  lc, cleanText, makeTx, buildResult, detection, findIban, detectInstitution, institutionFromIban, normalizeBookingText,
  kindFromName, KIND_LABEL, accountName, findDateRange, parseSepaTokens, fixSignByBalance, kindSign,
} from './common.js';
import { FINANZREPORT_RE, detectFinanzreport, parseFinanzreport } from './pdf-finanzreport.js';

// Beträge: deutsch „-1.234,56“ oder – z. B. im DKB-Umsatzexport – mit Dezimalpunkt „-1234.56“ / „-1,234.56“
const AMT = String.raw`[+\-−–]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}[+\-−–]?`;
const AMT_DOT = String.raw`[+\-−–]?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}[+\-−–]?`;
// Soll/Haben-Kennzeichen vor oder nach der Währung: „1.234,80 H EUR“ (DKB alt) wie „1.234,80 EUR H“
const amountEnd = (amt) => new RegExp(String.raw`(?:^|\s)(${amt})(?:\s*(?:EUR|€))?(?:\s*([SH]))?(?:\s*(?:EUR|€))?\s*$`);
const AMOUNT_END = amountEnd(AMT);
const AMOUNT_END_DOT = amountEnd(AMT_DOT);
const DATE = String.raw`\d{2}\.\d{2}\.(?:\d{4}|\d{2})?`;
const BOOKING_START = new RegExp(String.raw`^(${DATE})(?=\s|$)\s*(?:(${DATE})(?=\s|$))?\s*(.*)$`);
// Nur Seitenköpfe/-füße und Übertragszeilen am Zeilenanfang: Namen wie "Erika Muster" oder "Kontoübertrag" im Zweck bleiben Buchungstext
const SKIP_LINE = /^(seite|page)\s+\d+|^(?:zwischensumme\s+)?[uü]bertrag\b.*(?:seite|\d,\d{2})|^muster\s+[–—-]|testdokument|^\s*umsätze\s*$|^\s*buchungen\s*$|^\s*umsatzübersicht\s*$/i;
// „Bu.Tag Wert Wir haben für Sie gebucht Belastung in EUR Gutschrift in EUR“: älteres DKB-Layout
const HEADER_LINE = /^(buchung(stag)?|datum|tag|beleg(datum)?|bu\.\s*tag)\b.*\b(betrag|soll|haben|umsatz|belastung|gutschrift)/i;
const CLOSING_LINE = /^(ne[uv]er\s+(saldo|kontostand)|alter\s+(saldo|kontostand)|summe|kontostand|saldo|endsaldo|schlusssaldo|dieser auszug|hinweis|bitte beachten|wichtige|rechnungsabschluss|kontoabschluss|guthaben|gesamtumsatzsummen|ihr dispositionskredit)/i;
// „Kontostand am 04.02.2026, Auszug Nr. 2“ (DKB): Endstand des Vorauszugs = Anfangssaldo
const OPEN_RE = /(alter\s+(?:saldo|kontostand)|saldo\s+alt|anfangs(?:saldo|bestand)|saldo\s+vortrag|kontostand\s+zu\s+beginn|kontostand\s+am\s+\d{2}\.\d{2}\.\d{4}\s*,?\s*auszug\s+nr)/i;
const CLOSE_RE = /(ne[uv]er\s+(?:saldo|kontostand)|saldo\s+neu|end(?:saldo|bestand)|schlusssaldo)/i;
// Seitenfuß (Bankangaben) beendet die laufende Buchung – sonst landet er im Verwendungszweck
const FOOTER_LINE = /vorsitzende[rn]?\s+des\s+aufsichtsrats|handelsregister|^ein\s+(?:unternehmen|\S+)\s+der\b|amtsgericht|www\.dkb\.de|^deutsche\s+kreditbank\s+ag\b|^bayerische[nr]?\s+landesbank/i;
// Buchungsarten, die im Soll/Haben-Layout (DKB) eine Buchung einleiten – auch wenn das Datum fehlt (geschwärzt/nicht gelesen)
const KIND_WORDS = String.raw`(?:Basislastschrift|Firmenlastschrift|Lastschrift|Kartenzahlung(?:\s+(?:FW|onl))?|Kartenzahlun|Lohn,\s*Gehalt,\s*Rente|Dauerauftrag|Überweisung|Echtzeitüberweisung|Gutschrift|Zahlungseingang|Abbuchung|Rücklastschrift|Abschluss|Entgelt|Bargeldauszahlung)`;
const KIND_START = new RegExp(String.raw`^${KIND_WORDS}(?:\s+${AMT})?\s*$`, 'i');
const KIND_ANY = new RegExp(String.raw`^(?:${DATE}\s*)?${KIND_WORDS}\b`, 'i');
const AMBIG_RE = /kontostand\s+(?:am|vom)/i;
const CARD_RE = /kreditkarten[- ]?(abrechnung|auszug)|(visa|master\s?card)[- ]?(karten)?[- ]?abrechnung|kartenabrechnung|abrechnung\s+ihrer\s+(visa|master)/i;
const PAYPAL_PDF = /paypal/i;
const SOLL_HABEN_HEAD = /\bsoll\b.*\bhaben\b|\bbelastung\b.*\bgutschrift\b/i;

/** Spaltenkopf mit getrennten Soll- und Haben-Spalten (DKB „Betrag Soll EUR | Betrag Haben EUR“)? */
const isSollHabenHeader = (t) => HEADER_LINE.test(t) && SOLL_HABEN_HEAD.test(t) && !/gesamtumsatz|summe/i.test(t);

/**
 * OCR-Varianten glätten (nur der Zeilentext, Positionen bleiben): „05.02.2026/Basislastschrift“ → „05.02.2026 Basislastschrift“,
 * Rahmenreste „[Datum [Erläuterung“ am Zeilenanfang weg. Im Soll/Haben-Layout leitet eine weitere Buchungsart-Zeile
 * („Kartenzahlung FW“) ohne Datum eine neue Buchung ein; sie bekommt das Datum der Vorbuchung (`inheritedDate`).
 */
function normalizeLines(lines) {
  const sollHaben = lines.some(l => isSollHabenHeader(l.text.replace(/[[\]|]/g, ' ').trim()));
  let lastDate = null, kindSeen = false;
  return lines.map(l => {
    let t = l.text.replace(/^[\s[\]|{}„"“]+(?=\S)/, '').replace(/^(\d{2}\.\d{2}\.\d{4})\s*\/\s*(?=\S)/, '$1 ');
    if (HEADER_LINE.test(t.replace(/[[\]|]/g, ' '))) t = t.replace(/[[\]|]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    let inheritedDate = false;
    if (sollHaben) {
      const d = /^(\d{2}\.\d{2}\.\d{4})(?=\s|$)\s*(.*)$/.exec(t);
      if (d && !HEADER_LINE.test(t)) { lastDate = d[1]; kindSeen = !!d[2].trim(); }
      else if (lastDate && KIND_START.test(t.trim())) {
        if (kindSeen) { t = `${lastDate} ${t.trim()}`; inheritedDate = true; } else kindSeen = true;
      } else if (lastDate && t.trim() && !HEADER_LINE.test(t)) kindSeen = true;
      if (CLOSING_LINE.test(t.trim()) || FOOTER_LINE.test(t)) kindSeen = true;
    }
    return t === l.text && !inheritedDate ? l : { ...l, text: t, inheritedDate };
  });
}

function signedAmount(tok, sh, fmt) {
  let t = tok.replace(/[−–]/g, '-');
  if (fmt?.style === 'dot') t = t.replace(/,/g, '').replace('.', ',');
  let v = parseGermanAmount(t);
  if (v == null) return null;
  if (sh === 'S') v = -Math.abs(v);
  else if (sh === 'H') v = Math.abs(v);
  return v;
}

/**
 * Zahlenformat des Dokuments: überwiegen Zeilen, die auf „-75.00“ enden, gilt der Dezimalpunkt. Beim Dezimalpunkt
 * zählt ein Betrag nur in der Betragsspalte (rechte Kante nahe „Betrag“ im Spaltenkopf), damit „… vom 27.12“ im
 * Verwendungszweck kein Betrag wird.
 */
function amountFormat(lines) {
  let comma = 0, dot = 0;
  for (const l of lines) {
    const t = l.text.trim();
    if (AMOUNT_END.test(t)) comma++;
    else if (AMOUNT_END_DOT.test(t)) dot++;
  }
  if (!(dot > comma && dot >= 2)) return { style: 'comma', re: AMOUNT_END, colOk: () => true };
  let colRight = null;
  for (const l of lines) {
    if (!HEADER_LINE.test(l.text.trim())) continue;
    const it = (l.items || []).find(i => /betrag/i.test(i.str));
    if (it) { colRight = it.x + it.w; break; }
  }
  const colOk = (line, tok) => {
    if (colRight == null || !line.items?.length) return true;
    const it = [...line.items].reverse().find(i => i.str.includes(tok.trim()));
    return !it || it.x + it.w >= colRight - 80;
  };
  return { style: 'dot', re: AMOUNT_END_DOT, colOk };
}

const MAX_BLOCK_LINES = 6; // so weit darf der Betrag unter der Datumszeile stehen (mehrzeilige „Erläuterung“)

/**
 * Buchungsblöcke: Zeile mit Datum vorn startet eine Buchung. Der Betrag steht am Ende der Datumszeile oder – bei
 * mehrzeiliger Erläuterung bzw. Datum in eigener Zeile – am Ende einer der folgenden Zeilen vor dem nächsten Datum.
 * Datumszeilen ohne Betrag im Block bleiben Text der vorherigen Buchung (z. B. „15.01. Rechnung“ im Zweck).
 * → [{ m, line, amountTok, sh, amountLine, cont: [{ text, line }] }]; Zeilen außerhalb von Blöcken: { text, line, loose: true }
 */
function bookingBlocks(lines, fmt = amountFormat(lines)) {
  const AE = fmt.re;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.text.trim();
    if (!t) continue;
    const m = BOOKING_START.exec(t);
    if (!m || HEADER_LINE.test(t)) { out.push({ text: t, line: l, loose: true }); continue; }
    const am0 = AE.exec(m[3] || '');
    const am = am0 && fmt.colOk(l, am0[1]) ? am0 : null;
    if (am) { out.push({ m, line: l, am, amountLine: l, rest: (m[3] || '').slice(0, am.index).trim(), cont: [] }); continue; }
    // Betrag in einer Folgezeile suchen (bis zur nächsten Datums-, Kopf- oder Abschlusszeile)
    let found = -1, fam = null;
    for (let j = i + 1; j < lines.length && j <= i + MAX_BLOCK_LINES; j++) {
      const u = lines[j].text.trim();
      if (!u) continue;
      if (BOOKING_START.test(u) || HEADER_LINE.test(u) || CLOSING_LINE.test(u) || SKIP_LINE.test(u) || FOOTER_LINE.test(u)) break;
      const a = AE.exec(u);
      if (a && fmt.colOk(lines[j], a[1])) { found = j; fam = a; break; }
    }
    if (found < 0) { out.push({ text: t, line: l, loose: true }); continue; }
    const cont = [];
    for (let j = i + 1; j < found; j++) { const u = lines[j].text.trim(); if (u) cont.push(u); }
    const lastRest = lines[found].text.trim().slice(0, fam.index).trim();
    if (lastRest) cont.push(lastRest);
    out.push({ m, line: l, am: fam, amountLine: lines[found], rest: (m[3] || '').trim(), cont });
    i = found;
  }
  return out;
}

/** Zählt Buchungen (Datum vorn, Betrag am Zeilenende – auch in einer Folgezeile). */
function countBookingLines(lines, fmt) {
  return bookingBlocks(lines, fmt).filter(b => !b.loose).length;
}

/** Zeilen, die eine Buchung einleiten (Datum vorn), und davon die mit bekannter Buchungsart – auch ohne lesbaren Betrag. */
function startLines(lines) {
  const starts = lines.filter(l => { const t = l.text.trim(); return BOOKING_START.test(t) && !HEADER_LINE.test(t); });
  return { starts: starts.length, kinds: lines.filter(l => KIND_ANY.test(l.text.trim())).length };
}

/**
 * Scan/geschwärzter Auszug ohne lesbare Beträge: Titel „Kontoauszug“, Spaltenkopf „Datum … Betrag“ und viele Datumszeilen
 * mit Buchungsarten. Bleibt Kontoauszug (mit klarer Diagnose) statt als Lohnabrechnung o. Ä. zu enden.
 */
function detectUnreadableStatement(lines, text) {
  if (!/kontoauszug/i.test(text.slice(0, 3000))) return null;
  if (!lines.some(l => HEADER_LINE.test(l.text.trim()))) return null;
  const { starts, kinds } = startLines(lines);
  if (starts < 5 || kinds < 3) return null;
  const head = lines.slice(0, 15).map(l => l.text).join('\n');
  const institution = detectInstitution(head) || institutionFromIban(findIban(head)) || detectInstitution(text, { skip: ['PayPal'] });
  const signals = ['Titel Kontoauszug', 'Spaltenkopf Datum/Betrag', `${starts} Datumszeilen, ${kinds} mit Buchungsart`, 'Beträge nicht lesbar'];
  if (institution) signals.push(`Institut ${institution}`);
  return { ...detection('kontoauszug', 'pdf_statement', institution, institution ? 0.78 : 0.72, signals), bookings: 0, dateLines: starts };
}

export function detectPdfStatement(ctx) {
  if (ctx.kind && ctx.kind !== 'pdf' && ctx.kind !== 'image') return null;
  const lines = normalizeLines(ctx.lines);
  if (!lines.length) return null;
  const text = lines.map(l => l.text).join('\n');
  if (FINANZREPORT_RE.test(text.slice(0, 4000))) return detectFinanzreport(lines, text);
  const fmt = amountFormat(lines);
  const bookings = countBookingLines(lines, fmt);
  if (bookings < 2) return detectUnreadableStatement(lines, text);
  const hasBalance = OPEN_RE.test(text) || CLOSE_RE.test(text) || AMBIG_RE.test(text);
  const hasWord = /kontoauszug|kontoumsätze|umsatzübersicht|tagesgeld|girokonto|kontoübersicht|anzahl der (?:transaktionen|umsätze|buchungen)/i.test(text.slice(0, 3000));
  // Spaltenkopf „Datum … Betrag“ und viele Buchungen: Umsatzliste, auch ohne Titel/Saldo (z. B. DKB „Datum Erläuterung Betrag EUR“)
  const header = lines.some(l => HEADER_LINE.test(l.text.trim()));
  const list = header && bookings >= 10;
  const card = CARD_RE.test(text.slice(0, 3000));
  if (bookings < 2 || !(hasBalance || hasWord || card || list)) return null;
  if (!hasBalance && !card && !list && !/kontoauszug/i.test(text)) return null;
  const head = lines.slice(0, 15).map(l => l.text).join('\n');
  const institution = detectInstitution(head) || institutionFromIban(findIban(head)) || detectInstitution(text, { skip: ['PayPal'] });
  const signals = [`${bookings} Buchungszeilen (Datum … Betrag)`];
  let conf = 0.55;
  if (/kontoauszug/i.test(head)) { signals.push('Titel Kontoauszug'); conf += 0.1; }
  if (OPEN_RE.test(text) && CLOSE_RE.test(text)) { signals.push('Alter/Neuer Saldo'); conf += 0.15; }
  else if (hasBalance) { signals.push('Saldozeile'); conf += 0.07; }
  if (institution) { signals.push(`Institut ${institution}`); conf += 0.1; }
  if (findIban(head)) { signals.push('IBAN im Kopf'); conf += 0.05; }
  if (header) { signals.push('Spaltenkopf Datum/Betrag'); conf += 0.05; }
  if (bookings >= 10) conf += 0.1;
  let type = 'kontoauszug';
  if (card) { type = 'kreditkarte'; signals.push('Kreditkartenabrechnung'); }
  else if (institution === 'PayPal') type = 'paypal';
  return { ...detection(type, 'pdf_statement', institution, Math.min(0.95, conf), signals), bookings };
}

/**
 * Spaltenpositionen „Soll“/„Haben“ aus der Kopfzeile (rechte Kante der Spalte). Der Kopf kommt als einzelne Wörter
 * („Betrag“, „Soll“, „EUR“), als Textstück je Spalte („Betrag Soll EUR“) oder als ein Stück für die ganze Zeile.
 * Die Spalte reicht bis zum Ende ihrer Beschriftung (Folgestücke wie „EUR“ gehören dazu). Älteres DKB-Layout:
 * „Belastung in EUR“ / „Gutschrift in EUR“ (dort steht „haben“ auch in „Wir haben für Sie gebucht“). → { soll, haben } | null
 */
function findSollHaben(lines) {
  const UNIT = /^\(?(?:in\s+)?(?:EUR|€)\)?$/i;
  for (const l of lines) {
    const t = l.text.trim();
    if (!l.items?.length || !SOLL_HABEN_HEAD.test(t) || /gesamtumsatz|summe/i.test(t) || BOOKING_START.test(t)) continue;
    const WORD = /\bbelastung\b.*\bgutschrift\b/i.test(t) && HEADER_LINE.test(t)
      ? { soll: /\bbelastung\b/i, haben: /\bgutschrift\b/i } : { soll: /\bsoll\b/i, haben: /\bhaben\b/i };
    const items = [...l.items].sort((a, b) => a.x - b.x);
    const edge = (key) => {
      const i = items.findIndex(it => WORD[key].test(it.str));
      if (i < 0) return null;
      const it = items[i];
      const other = WORD[key === 'soll' ? 'haben' : 'soll'].exec(it.str);
      const mine = WORD[key].exec(it.str);
      if (other && other.index > mine.index) {
        // ein Stück für beide Spalten: Ende des eigenen Teils anteilig nach Zeichen schätzen
        const part = it.str.slice(0, other.index).replace(/\s*betrag\s*$/i, '').trimEnd();
        return it.x + it.w * (part.length / Math.max(1, it.str.length));
      }
      let j = i;
      while (j + 1 < items.length && UNIT.test(items[j + 1].str.trim())) j++;
      return items[j].x + items[j].w;
    };
    const soll = edge('soll'), haben = edge('haben');
    if (soll != null && haben != null && soll !== haben) return { soll, haben };
  }
  return null;
}

/** Vorzeichen nach Spalte: rechte Kante des Betrags näher an Soll (−1) oder Haben (+1); null ohne Position. */
function columnSign(line, tok, sh) {
  if (!sh || !line?.items?.length) return null;
  const it = [...line.items].reverse().find(i => i.str.includes(tok.trim()));
  if (!it) return null;
  const xr = it.x + it.w;
  return Math.abs(xr - sh.haben) < Math.abs(xr - sh.soll) ? 1 : -1;
}

function findBalances(lines, period, fmt = amountFormat(lines), sh = null) {
  const out = { opening: null, closing: null, openingDate: null, closingDate: null };
  const ambiguous = [];
  for (const l of lines) {
    const t = l.text;
    const am = fmt.re.exec(t);
    if (!am) continue;
    let v = signedAmount(am[1], am[2], fmt);
    if (v == null) continue;
    // Soll/Haben-Spalten: Saldo in der Soll-Spalte ist negativ
    const cs = !/[+\-−–]/.test(am[1]) && !am[2] ? columnSign(l, am[1], sh) : null;
    if (cs) v = cs * Math.abs(v);
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

/**
 * DKB „Gesamtumsatzsummen  Summe Soll EUR  Anzahl  Summe Haben EUR  Anzahl“, Folgezeile „<summe> 51 <summe> 3“.
 * Anzahl = erste und letzte ganze Zahl (geschwärzte/unlesbare Summen hinterlassen Reste); Summen nur, wenn beide lesbar.
 * → { sollCount, habenCount, sollSum, habenSum } | null
 */
function findTotals(lines) {
  const i = lines.findIndex(l => /gesamtumsatzsummen/i.test(l.text));
  if (i < 0) return null;
  for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
    const t = lines[j].text;
    const amts = [...t.matchAll(new RegExp(String.raw`(?:^|\s)(${AMT})(?=\s|$)`, 'g'))].map(m => m[1]);
    const rest = amts.reduce((r, a) => r.replace(a, ' '), t);
    const ints = [...rest.matchAll(/(?:^|\s)(\d{1,4})(?=\s|$)/g)].map(m => +m[1]);
    if (ints.length < 2) continue;
    const s0 = amts.length === 2 ? signedAmount(amts[0]) : null, s1 = amts.length === 2 ? signedAmount(amts[1]) : null;
    return {
      sollCount: ints[0], habenCount: ints[ints.length - 1],
      sollSum: s0 != null && s1 != null ? -Math.abs(s0) : null, habenSum: s0 != null && s1 != null ? Math.abs(s1) : null,
    };
  }
  return null;
}

function findPeriod(text) {
  let m = text.match(/Zeitraum\s*:?\s*(\d{2}\.\d{2}\.\d{4})\s*(?:-|–|—|bis)\s*(\d{2}\.\d{2}\.\d{4})/i)
    || text.match(/vom\s+(\d{2}\.\d{2}\.\d{4})\s+bis\s+(?:zum\s+)?(\d{2}\.\d{2}\.\d{4})/i);
  if (m) return { from: parseGermanDate(m[1]), to: parseGermanDate(m[2]) };
  const r = findDateRange(text.split('\n').slice(0, 25).join('\n'));
  if (r) return r;
  // DKB: „Kontostand am 04.02.2026, Auszug Nr. 2“ (Beginn) … „Kontostand am 04.03.2026 um 18:05 Uhr“ (Ende)
  m = text.match(/Kontostand\s+am\s+(\d{2}\.\d{2}\.\d{4})\s*,?\s*Auszug\s+Nr/i);
  if (m) {
    const end = [...text.matchAll(/Kontostand\s+am\s+(\d{2}\.\d{2}\.\d{4})(?!\s*,?\s*Auszug)/gi)].pop();
    return { from: parseGermanDate(m[1]), to: end ? parseGermanDate(end[1]) : null };
  }
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

const fmtCent = (c) => (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2).replace('.', ',') + ' €';
const clip = (s, n = 140) => { const t = cleanText(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * Diagnose für die Anzeige im Dokument: was gefunden wurde und wo das Einlesen hakt – in Sätzen, mit Seite und Zeile.
 * → { pages, lines, numberFormat, header, dateLines, bookings, unparsed: [{ page, text }], strayAmounts: [{ page, text }],
 *     expectedCount, readCount, balance, problems: string[] }
 */
function diagnose({ lines, fmt, blocks, transactions, readCount, expectedCount, bal, sum, totals = null, signKind = 0, signUnknown = 0, inherited = 0, sollHaben = false, sh = null, ocr = false }) {
  const isHeader = (t) => HEADER_LINE.test(t);
  const dateLines = lines.filter(l => { const t = l.text.trim(); return BOOKING_START.test(t) && !isHeader(t); });
  const amountLines = new Set(blocks.filter(b => !b.loose).map(b => b.amountLine));
  const unparsed = blocks.filter(b => b.loose && BOOKING_START.test(b.text) && !isHeader(b.text)).map(b => ({ page: b.line.n ?? null, text: clip(b.text) }));
  const otherStyle = fmt.style === 'dot' ? AMOUNT_END : AMOUNT_END_DOT;
  const strayAmounts = lines.filter(l => {
    const t = l.text.trim();
    return !amountLines.has(l) && (fmt.re.test(t) || otherStyle.test(t)) && !OPEN_RE.test(t) && !CLOSE_RE.test(t) && !AMBIG_RE.test(t) && !BOOKING_START.test(t);
  }).map(l => ({ page: l.n ?? null, text: clip(l.text.trim()) }));
  const header = lines.find(l => isHeader(l.text.trim()))?.text.trim() || null;
  const pages = new Set(lines.map(l => l.n)).size;
  const fmtName = fmt.style === 'dot' ? 'Dezimalpunkt (-75.00)' : 'Dezimalkomma (-75,00)';
  const where = (list) => { const ps = [...new Set(list.map(x => x.page).filter(Boolean))]; return ps.length ? ` (Seite ${ps.slice(0, 6).join(', ')}${ps.length > 6 ? ' …' : ''})` : ''; };
  const problems = [];
  if (!lines.length) problems.push('Kein Text im PDF gefunden – vermutlich ein Scan ohne Textebene.');
  else if (!dateLines.length) problems.push(`Keine Zeile beginnt mit einem Datum (TT.MM.JJJJ) – die Buchungsspalten wurden nicht erkannt${header ? ` (Spaltenkopf: „${clip(header, 80)}“)` : ', auch kein Spaltenkopf „Datum … Betrag“'}.`);
  else if (!transactions.length && !strayAmounts.length && !lines.some(l => fmt.re.test(l.text.trim()))
    && (ocr || !dateLines.some(l => /\d\s*$/.test(l.text.trim().slice(10))))) {
    // Kein einziger Betrag im ganzen Text: geschwärzt oder Scan zu unscharf – Datums-/Buchungsart-Zeilen zeigen, dass es ein Auszug ist
    const { starts, kinds } = startLines(lines);
    problems.push(`Datumszeilen/Buchungsarten erkannt (${Math.max(starts, kinds)}), aber keine Beträge lesbar – Beträge geschwärzt oder Scan zu unscharf.`);
  } else if (!transactions.length) {
    problems.push(`${dateLines.length} Zeilen mit Datum gefunden, aber zu keiner ein Betrag am Zeilenende (erwartetes Format: ${fmtName}).`);
    if (strayAmounts.length) problems.push(`Beträge stehen in eigenen Zeilen ohne Datum, z. B. Seite ${strayAmounts[0].page}: „${strayAmounts[0].text}“.`);
  }
  if (unparsed.length && transactions.length) problems.push(`${unparsed.length} Datumszeile${unparsed.length === 1 ? '' : 'n'} ohne erkennbaren Betrag${where(unparsed)} – z. B. „${unparsed[0].text}“.`);
  if (expectedCount != null && readCount !== expectedCount) problems.push(`Laut Auszug ${expectedCount} Transaktionen, gelesen ${readCount} (${readCount < expectedCount ? `${expectedCount - readCount} fehlen` : `${readCount - expectedCount} zu viel`}).`);
  if (signUnknown) problems.push(`Bei ${signUnknown} Buchung${signUnknown === 1 ? '' : 'en'} ist unklar, ob Soll oder Haben (keine Spaltenposition, Buchungsart unbekannt) – als Haben gelesen.`);
  if (inherited) problems.push(`${inherited} Buchung${inherited === 1 ? '' : 'en'} ohne lesbares Datum – Datum der vorherigen Buchung übernommen.`);
  // Kontrollsummen (DKB „Gesamtumsatzsummen“)
  if (totals?.sollSum != null && transactions.length) {
    const soll = transactions.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0);
    const haben = transactions.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    if (soll !== totals.sollSum || haben !== totals.habenSum) problems.push(`Summen laut Auszug Soll ${fmtCent(totals.sollSum)} / Haben ${fmtCent(totals.habenSum)}, gelesen ${fmtCent(soll)} / ${fmtCent(haben)}.`);
  }
  let balance = null;
  if (bal.opening != null && bal.closing != null) {
    const diff = bal.closing - (bal.opening + sum);
    balance = { opening: bal.opening, closing: bal.closing, sum, diff };
    if (diff) problems.push(`Saldo geht nicht auf: Anfang ${fmtCent(bal.opening)} + Buchungen ${fmtCent(sum)} = ${fmtCent(bal.opening + sum)}, laut Auszug ${fmtCent(bal.closing)} (Differenz ${fmtCent(diff)}).`);
  }
  return {
    pages, lines: lines.length, numberFormat: fmt.style, header, dateLines: dateLines.length, bookings: transactions.length,
    unparsed: unparsed.slice(0, 8), strayAmounts: strayAmounts.slice(0, 5), expectedCount, readCount, balance, problems,
    ...(sollHaben ? { sollHaben: { columns: !!sh, signFromKind: signKind, signUnknown } } : {}),
    ...(totals ? { totals } : {}),
  };
}

const OWN_PERSON_PREFIX = /^(?:Überweisung|Gutschrift|Lastschrift|Zahlung)\s+(?:von|an)\s+/i;

export function parsePdfStatement(det, ctx) {
  const lines = normalizeLines(ctx.lines);
  const text = lines.map(l => l.text).join('\n');
  if (det?.variant === 'finanzreport' || FINANZREPORT_RE.test(text.slice(0, 4000))) return parseFinanzreport(det, lines, text);
  const period = findPeriod(text);
  const fallbackYear = period?.to ? +period.to.slice(0, 4) : (text.match(/\b(20\d{2})\b/) || [])[1] ? +text.match(/\b(20\d{2})\b/)[1] : new Date().getFullYear();
  const fmt = amountFormat(lines);
  const sh = findSollHaben(lines);
  const bal = findBalances(lines, period, fmt, sh);
  // Soll/Haben-Layout (Beträge ohne Vorzeichen): ohne Spaltenposition entscheidet die Buchungsart
  const sollHaben = !!sh || lines.some(l => isSollHabenHeader(l.text.trim()));
  const totals = findTotals(lines);

  const head = lines.slice(0, 15).map(l => l.text).join('\n');
  const firstBlock = bookingBlocks(lines, fmt).find(b => !b.loose);
  const firstBooking = firstBlock ? lines.indexOf(firstBlock.line) : -1;
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
  for (const b of bookingBlocks(lines, fmt)) {
    if (b.loose) {
      const t = b.text;
      if (HEADER_LINE.test(t) || SKIP_LINE.test(t)) continue;
      if (CLOSING_LINE.test(t) || FOOTER_LINE.test(t)) { close(); continue; }
      if (curB) curB.cont.push(cleanText(t));
      continue;
    }
    const { m, am } = b;
    let amount = signedAmount(am[1], am[2], fmt);
    let signFrom = null;
    if (sollHaben && amount != null && !/[+\-−–]/.test(am[1]) && !am[2]) {
      // Soll/Haben-Spalten: nach x-Position der rechten Kante, sonst nach Buchungsart
      const cs = columnSign(b.amountLine, am[1], sh);
      const ks = cs ? null : kindSign(b.rest || b.cont[0], b.cont.join(' '));
      const sign = cs || ks;
      if (sign) amount = sign * Math.abs(amount);
      signFrom = cs ? 'column' : ks ? 'kind' : 'unknown';
    }
    const bookingDate = parseGermanDate(m[1], yearFor(m[1], +m[1].slice(3, 5), period, fallbackYear));
    const valueDate = m[2] ? parseGermanDate(m[2], yearFor(m[2], +m[2].slice(3, 5), period, fallbackYear)) : bookingDate;
    // Datum in eigener Zeile: erste Folgezeile ist der Kopf (Buchungsart/Gegenpartei)
    const cont = b.cont.map(cleanText).filter(Boolean);
    const head = cleanText(b.rest) || cont.shift() || '';
    curB = { bookingDate, valueDate, amount, head, cont, signFrom, inheritedDate: !!b.line.inheritedDate };
    bookings.push(curB);
  }

  const transactions = bookings.map(b => {
    let cont = [...b.cont];
    let counterpartyIban = null;
    const IBAN_LINE = /^IBAN:?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{10,})$/;
    const ibanIdx = cont.findIndex(c => IBAN_LINE.test(c));
    cont = cont.filter(c => {
      const im = IBAN_LINE.exec(c);
      if (im) { counterpartyIban = findIban(im[1]) || im[1].replace(/\s+/g, ''); return false; }
      return true;
    });
    const known = normalizeBookingText(b.head);
    let bookingText = known || b.head || null;
    let counterparty, purpose;
    if (!known && ibanIdx >= 0) {
      // DKB & Co.: Empfänger (ggf. mit Adresszeile) – „IBAN …“ – Verwendungszweck; keine eigene Buchungsart-Zeile
      counterparty = b.head.replace(OWN_PERSON_PREFIX, '');
      purpose = b.cont.slice(ibanIdx + 1).join(' ') || b.cont.slice(0, ibanIdx).join(' ');
      bookingText = normalizeBookingText(purpose)
        || (/(?:debit|kredit)kartenumsatz|kartenzahlung|girocard|apple pay|google pay/i.test(purpose) ? 'Kartenzahlung'
          : /\bPP\.\d+\.PP\b|ihr einkauf bei|lastschrift/i.test(purpose) ? 'Lastschrift' : null);
    } else if (known === 'Zinsen' || known === 'Gebühr') {
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
  // Umsatzexporte ohne Saldo (z. B. DKB): „Anzahl der Transaktionen: 733“ als Vollständigkeitsprüfung; 0,00-Zeilen zählen mit
  const expectedM = text.match(/anzahl der (?:transaktionen|umsätze|buchungen)\s*:?\s*(\d+)/i);
  // DKB „Gesamtumsatzsummen“: Anzahl Soll + Anzahl Haben
  const expectedCount = expectedM ? +expectedM[1] : totals ? totals.sollCount + totals.habenCount : null;
  const readCount = transactions.length;
  const signKind = bookings.filter(b => b.amount != null && b.signFrom === 'kind').length;
  const signUnknown = bookings.filter(b => b.amount != null && b.signFrom === 'unknown').length;
  const inherited = bookings.filter(b => b.amount != null && b.inheritedDate).length;
  for (let i = transactions.length - 1; i >= 0; i--) if (transactions[i].amount === 0) transactions.splice(i, 1);

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
  const countOk = expectedCount != null && readCount === expectedCount;
  if (expectedCount != null && !countOk) reasons.push(`${readCount} von ${expectedCount} Transaktionen gelesen – bitte prüfen`);
  else if ((bal.opening == null || bal.closing == null) && !countOk) reasons.push('Salden nicht gefunden');
  if (signUnknown) reasons.push(`Vorzeichen bei ${signUnknown} Buchung${signUnknown === 1 ? '' : 'en'} unklar (Soll/Haben) – bitte prüfen`);
  if (signKind) signals.push(`Vorzeichen aus Buchungsart: ${signKind}`);
  const diagnostics = diagnose({
    lines, fmt, blocks: bookingBlocks(lines, fmt), transactions, readCount, expectedCount, bal, sum: transactions.reduce((a, t) => a + t.amount, 0),
    totals, signKind, signUnknown, inherited, sollHaben, sh, ocr: !!ctx.e?.ocr,
  });
  if (!transactions.length) reasons.unshift(`Keine Buchungen erkannt${diagnostics.problems[0] ? ': ' + diagnostics.problems[0] : ''}`);
  const periodFrom = period?.from || bal.openingDate || null;
  const periodTo = period?.to || bal.closingDate || null;
  const hasBoth = bal.opening != null && bal.closing != null;
  const sum = transactions.reduce((a, t) => a + t.amount, 0);
  const ok = hasBoth && bal.opening + sum === bal.closing;
  return buildResult({
    type: det?.type || (kind === 'kreditkarte' ? 'kreditkarte' : kind === 'paypal' ? 'paypal' : 'kontoauszug'),
    format: 'pdf_statement', institution, account, transactions,
    opening: bal.opening, closing: bal.closing, openingDate: bal.openingDate || periodFrom, closingDate: bal.closingDate || periodTo,
    periodFrom, periodTo, style: 'auszug', confidence: ok || (countOk && !hasBoth) ? (flip ? 0.7 : 0.85) : 0.5, reviewReasons: reasons,
    fields: { signals, ...(expectedCount != null ? { expectedCount, readCount } : {}), ...(totals ? { controlTotals: totals } : {}), diagnostics },
  });
}
