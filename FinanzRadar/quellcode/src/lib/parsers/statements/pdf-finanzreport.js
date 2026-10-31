// comdirect Finanzreport (PDF): ein Dokument mit Kontoübersicht, Girokonto, Tagesgeld PLUS-Konto, Visa-Karte, Depotbestand,
// Steuer- und Zinsübersicht. Jeder Kontoabschnitt wird ein eigenes Konto (ParseResult); Depot-, Steuer- und Zinsteil sind
// keine Buchungen. Je Buchung zwei Datumszeilen: Buchungstag (mit Betrag am Ende) und darunter Valuta.
import { parseGermanAmount, parseGermanDate } from '../../util/format.js';
import { cleanText, makeTx, buildResult, normalizeBookingText, accountName, detection, findIban, kindSign } from './common.js';
import { finanzreportDepotResult, parseTaxOverview } from './pdf-depotreport.js';

export const FINANZREPORT_RE = /Finanzreport\s+Nr\.?\s*\d+\s+per\s+(\d{2}\.\d{2}\.\d{4})/i;

// Beträge mit Vorzeichen am Zeilenende („+8,73“, „-1.077,30“); ohne Vorzeichen (OCR) entscheidet der Vorgang
const AMT_END = /(?:^|\s)([+\-−–]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})(?:\s*(?:EUR|€))?\s*$/;
const DATE_START = /^(\d{2}\.\d{2}\.\d{4})(?=\s|$)\s*(.*)$/;
const SECTIONS = [
  { re: /^Girokonto\b/i, kind: 'giro', label: 'Girokonto' },
  { re: /^Tagesgeld\s*PLUS(?:-Konto)?\b/i, kind: 'tagesgeld', label: 'Tagesgeld PLUS-Konto' },
  { re: /^Verrechnungskonto\b/i, kind: 'giro', label: 'Verrechnungskonto' },
  { re: /^Visa-?Karte\b/i, kind: 'kreditkarte', label: 'Visa-Karte' },
];
// Abschnitte ohne Buchungen bzw. Ende eines Kontoabschnitts
const END_RE = /^(?:Depot(?:bestand)?\b|Ste[uv]er[üu]bersicht|Zins[üu]bersicht|Konto[üu]bersicht|Wichtige\s+Hinweise|Gesamtsaldo|Gesamtkurswert)/i;
const COLHEAD_RE = /^(?:Buchungstag|Valuta|Referenz)\b|\b(?:Ausgang|Eingang)\s*$/i;
const PAGE_NOISE = /^Finanzreport\s+Nr|^Kundennummer|eine\s+Marke\s+der\s+Commerzbank|^USt-?I/i;
const OPEN_RE = /^Alter\s+Saldo\b/i;
const CLOSE_RE = /^Ne[uv]er\s+Saldo\b/i;
// Vorgang am Anfang der Buchungszeile (nur ohne Spaltenpositionen nötig)
const VORGANG_RE = /^(Kupon|Wertpapiere|Dividende|Übertrag\s*\/?|Lastschrift\s*\/?|Kontoführungs\w*|Visa-Umsatz|Überweisung|Gutschrift|Dauerauftrag|Zinsen|Entgelt|Bargeld\w*|Auszahlung|Einzahlung|Umbuchung)\s*/i;

const amountOf = (tok) => (tok ? parseGermanAmount(tok.replace(/[−–]/g, '-')) : null);

export function detectFinanzreport(lines, text) {
  const m = FINANZREPORT_RE.exec(text);
  const sections = findSections(lines);
  const signals = [`Finanzreport Nr. … per ${m?.[1] || '?'}`];
  if (sections.length) signals.push(`Kontoabschnitte: ${sections.map(s => s.label).join(', ')}`);
  if (/^Depot(?:bestand)?\b/im.test(text)) signals.push('Depotbestand');
  const bookings = sections.reduce((a, s) => a + s.bookings.filter(b => b.amount != null).length, 0);
  return { ...detection('kontoauszug', 'pdf_statement', 'comdirect', /comdirect/i.test(text) ? 0.9 : 0.8, signals), bookings, variant: 'finanzreport' };
}

/** Kontoabschnitt beginnt mit dem Kontonamen (ohne Betrag) und einem Spaltenkopf in den nächsten Zeilen. */
function sectionStart(lines, i) {
  const t = lines[i].text.trim();
  const s = SECTIONS.find(x => x.re.test(t));
  if (!s || AMT_END.test(t)) return null;
  for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
    const u = lines[j].text.trim();
    if (/\b(?:Valuta|Buchungstag)\b/i.test(u)) return s;
    if (END_RE.test(u) || SECTIONS.some(x => x.re.test(u))) return null; // Zeile der Kontoübersicht
  }
  return null;
}

/** Spalten aus dem Kopf „Buchungstag | Vorgang | Auftraggeber/Empfänger | Buchungstext | Ausgang“ (nur mit Positionen). */
function columnsOf(line) {
  if (!line?.items?.length) return null;
  const cols = [];
  for (const it of splitHeaderItems(line.items)) {
    const s = it.str.trim();
    if (/^(?:Buchungstag|Valuta)$/i.test(s)) cols.push({ key: 'date', x: it.x });
    else if (/^(?:Vorgang|Referenz)$/i.test(s)) cols.push({ key: 'vorgang', x: it.x });
    else if (/^(?:Auftraggeber|Empf|IBAN)/i.test(s)) cols.push({ key: 'party', x: it.x });
    else if (/^Buchungstext$/i.test(s)) cols.push({ key: 'text', x: it.x });
    else if (/^(?:Ausgang|Eingang)$/i.test(s)) cols.push({ key: 'amount', x: it.x });
  }
  return cols.some(c => c.key === 'vorgang') && cols.some(c => c.key === 'text') ? cols.sort((a, b) => a.x - b.x) : null;
}

/**
 * pdf.js fasst nah beieinander stehende Spaltenköpfe zu einem Stück zusammen („Buchungstag Vorgang“): in einzelne
 * Wörter mit anteilig (nach Zeichen) geschätzter x-Position zerlegen.
 */
function splitHeaderItems(items) {
  return items.flatMap(it => {
    const str = String(it.str || '');
    const words = [...str.matchAll(/\S+/g)];
    if (words.length < 2 || !it.w) return [it];
    return words.map(m => ({ ...it, str: m[0], x: it.x + it.w * (m.index / str.length), w: it.w * (m[0].length / str.length) }));
  });
}

/** Zeile in Spalten zerlegen: mit Positionen nach x, sonst nach Lücken (pdf.js trennt Spalten mit drei Leerzeichen). */
function cellsOf(line, rest, cols) {
  const out = { vorgang: '', party: '', text: '' };
  if (cols && line.items?.length) {
    for (const it of line.items) {
      const s = it.str.trim();
      if (!s) continue;
      const col = [...cols].reverse().find(c => c.x <= it.x + 3) || cols[0];
      if (col.key === 'date' || col.key === 'amount') continue;
      out[col.key] = out[col.key] ? `${out[col.key]} ${s}` : s;
    }
    return out;
  }
  const segs = rest.split(/\s{3,}/).map(s => s.trim()).filter(Boolean);
  if (segs.length >= 3) return { vorgang: segs[0], party: segs[1], text: segs.slice(2).join(' ') };
  if (segs.length === 2) return { vorgang: segs[0], party: '', text: segs[1] };
  const v = VORGANG_RE.exec(rest);
  return v ? { vorgang: v[0].trim(), party: '', text: rest.slice(v[0].length) } : { vorgang: '', party: '', text: rest };
}

function findSections(lines) {
  const out = [];
  let cur = null, cols = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.text.trim();
    if (!t) continue;
    const s = sectionStart(lines, i);
    if (s) { cur = { ...s, title: t, bookings: [], opening: null, closing: null, openingDate: null, closingDate: null, unread: 0 }; out.push(cur); cols = null; continue; }
    if (!cur) continue;
    if (END_RE.test(t)) { cur = null; continue; }
    if (PAGE_NOISE.test(t)) continue;
    if (COLHEAD_RE.test(t) && !DATE_START.test(t)) { cols = columnsOf(l) || cols; continue; }
    const am = AMT_END.exec(t);
    const dm = /(\d{2}\.\d{2}\.\d{4})/.exec(t);
    if (OPEN_RE.test(t)) { cur.opening = amountOf(am?.[1]); cur.openingDate = dm ? parseGermanDate(dm[1]) : null; continue; }
    if (CLOSE_RE.test(t)) { cur.closing = amountOf(am?.[1]); cur.closingDate = dm ? parseGermanDate(dm[1]) : null; cur = null; continue; }
    const last = cur.bookings[cur.bookings.length - 1];
    const d = DATE_START.exec(t);
    if (d && last && last.justStarted && !am) {
      // zweite Datumszeile = Valuta; Rest gehört zur Buchung (Referenz, Vorgang-Fortsetzung, Buchungstext)
      last.valueDate = parseGermanDate(d[1]);
      last.justStarted = false;
      const c = cellsOf(l, d[2], cols);
      // Spalte unter „Vorgang“ ist hier die Referenz – nur Wortfortsetzungen („Überweisung“, „ntgelt“) gehören zum Vorgang
      if (c.vorgang && /\d/.test(c.vorgang)) c.vorgang = '';
      addCells(last, c);
      continue;
    }
    if (d) {
      const rest = am ? d[2].slice(0, Math.max(0, d[2].length - (t.length - am.index))).trim() : d[2];
      const b = { bookingDate: parseGermanDate(d[1]), valueDate: null, amount: amountOf(am?.[1]), signed: !!am && /^[+\-−–]/.test(am[1]), vorgang: [], party: [], text: [], justStarted: true };
      addCells(b, cellsOf(l, rest, cols));
      cur.bookings.push(b);
      continue;
    }
    // Folgezeile: mit Positionen nach Spalten, sonst ganz zum Buchungstext; unter „Vorgang“ steht hier nur die Referenz
    if (last) {
      last.justStarted = false;
      const c = cols && l.items?.length ? cellsOf(l, t, cols) : { text: t };
      if (c.vorgang && /\d/.test(c.vorgang)) c.vorgang = '';
      addCells(last, c);
    }
  }
  return out;
}

/**
 * Kontoübersicht: „Girokonto   DE25 2004 1133 0007 3400 61   +2.823,72“, „Visa-Karte 4871   +0,00“ → je Konto IBAN bzw.
 * Kartenendung und Saldo zum Stichtag (Kontrollwert für den Neuen Saldo des Abschnitts).
 * → [{ label, iban, card, balance }]
 */
function findOverview(lines) {
  const i = lines.findIndex(l => /^Konto[üu]bersicht\b/i.test(l.text.trim()));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length && j <= i + 15; j++) {
    const t = lines[j].text.trim();
    if (/^Gesamtsaldo\b/i.test(t)) break;
    const s = SECTIONS.find(x => x.re.test(t));
    const am = AMT_END.exec(t);
    if (!s || !am) continue;
    const head = t.slice(0, am.index);
    out.push({
      label: s.label, iban: findIban(head),
      card: s.kind === 'kreditkarte' ? cardEnd(head) : null, balance: amountOf(am[1]),
    });
  }
  return out;
}

// Kartenendung direkt hinter dem Kontonamen: „Visa-Karte 4871“
const cardEnd = (t) => /^Visa-?Karte\s+(?:Nr\.?\s*)?(?:[X*•]+\s*)*(\d{4})\b/i.exec(String(t || '').trim())?.[1] || null;
const fmtEur = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

function addCells(b, c) {
  if (c.vorgang) b.vorgang.push(c.vorgang);
  if (c.party) b.party.push(c.party);
  if (c.text) b.text.push(c.text);
}

// „Kontoführungse“ + „ntgelt“ (Silbentrennung im Spaltenumbruch) wieder zusammenfügen
const joinWrapped = (parts) => parts.reduce((a, p) => (!a ? p : /[a-zäöüß]$/.test(a) && /^[a-zäöüß]/.test(p) ? a + p : `${a} ${p}`), '');

function toTransactions(sec) {
  let signKind = 0, signUnknown = 0;
  const txs = [];
  for (const b of sec.bookings) {
    if (b.amount == null || !b.bookingDate) continue;
    const vorgang = cleanText(joinWrapped(b.vorgang));
    const text = cleanText(b.text.join(' '));
    let amount = b.amount;
    if (!b.signed) {
      // OCR hat das Vorzeichen verloren (oder es ist geschwärzt): Vorgang entscheidet
      const s = kindSign(vorgang, text);
      if (s) { amount = s * Math.abs(amount); signKind++; } else signUnknown++;
    }
    // Spalte „Auftraggeber/Empfänger“ enthält in der Valuta-Zeile IBAN und BIC – für den Namen entfernen
    const party = cleanText(b.party.join(' ').replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b(?:\s+[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b)?/g, ' '));
    const counterpartyIban = findIban(b.party.join(' '));
    const bookingText = normalizeBookingText(vorgang) || vorgang || null;
    // Entgelt/Zinsen ohne Auftraggeber: Gegenpartei ist die Bank selbst
    const counterparty = party || (sec.kind === 'kreditkarte' ? text.split(/\s{2,}|\s+(?:WWW\.|Betrag:|USD|Kurs:)/i)[0] : '')
      || (bookingText === 'Gebühr' || bookingText === 'Zinsen' ? 'comdirect' : '') || vorgang;
    txs.push(makeTx({
      bookingDate: b.bookingDate, valueDate: b.valueDate || b.bookingDate, amount,
      counterpartyRaw: counterparty, purpose: text || vorgang, bookingText, counterpartyIban,
    }));
  }
  return { txs, signKind, signUnknown };
}

export function parseFinanzreport(det, lines, text) {
  const per = FINANZREPORT_RE.exec(text);
  const reportDate = per ? parseGermanDate(per[1]) : null;
  const sections = findSections(lines);
  const overview = findOverview(lines);
  const ignored = [['Depot', /^Depot(?:bestand)?\b/im], ['Steuerübersicht', /^Ste[uv]er[üu]bersicht/im], ['Zinsübersicht', /^Zins[üu]bersicht/im]]
    .filter(([, re]) => re.test(text)).map(([n]) => n);
  const results = [];
  for (const sec of sections) {
    const { txs, signKind, signUnknown } = toTransactions(sec);
    const unread = sec.bookings.filter(b => b.amount == null).length;
    // IBAN bzw. Kartenendung aus der Kontoübersicht (Kartenendung auch im Abschnittskopf „Visa-Karte 4871“)
    const ov = overview.find(o => o.label === sec.label) || null;
    const card = sec.kind === 'kreditkarte' ? ov?.card || cardEnd(sec.title) : null;
    const account = { kind: sec.kind, institution: 'comdirect', name: accountName('comdirect', sec.label), iban: ov?.iban || null, currency: 'EUR', number: card };
    const reasons = [];
    const problems = [];
    if (unread) {
      reasons.push(`${unread} von ${sec.bookings.length} Buchungen ohne lesbaren Betrag – bitte prüfen`);
      problems.push(`${unread} Buchung${unread === 1 ? '' : 'en'} mit Datum, aber ohne lesbaren Betrag – Beträge geschwärzt oder Scan zu unscharf.`);
    }
    if (signUnknown) reasons.push(`Vorzeichen bei ${signUnknown} Buchung${signUnknown === 1 ? '' : 'en'} unklar – bitte prüfen`);
    if (signKind) problems.push(`Vorzeichen bei ${signKind} Buchung${signKind === 1 ? '' : 'en'} aus dem Vorgang abgeleitet (im Text fehlte „+“/„−“).`);
    if (ov?.balance != null && sec.closing != null && ov.balance !== sec.closing) {
      reasons.push('Neuer Saldo weicht von der Kontoübersicht ab – bitte prüfen');
      problems.push(`Saldo laut Kontoübersicht ${fmtEur(ov.balance)}, Neuer Saldo im Abschnitt ${fmtEur(sec.closing)}.`);
    }
    const sum = txs.reduce((a, t) => a + t.amount, 0);
    const hasBoth = sec.opening != null && sec.closing != null;
    if (hasBoth && sec.opening + sum !== sec.closing) problems.push(`Saldo geht nicht auf: Alter Saldo + Buchungen ≠ Neuer Saldo (Differenz ${((sec.closing - sec.opening - sum) / 100).toFixed(2).replace('.', ',')} €).`);
    if (!txs.length && !unread && sec.closing == null && sec.opening == null && results.length) continue;
    if (!txs.length && !unread && sec.closing == null) reasons.push('Keine Buchungen erkannt');
    const periodFrom = sec.openingDate || sec.bookings.map(b => b.bookingDate).filter(Boolean).sort()[0] || null;
    const periodTo = sec.closingDate || reportDate;
    results.push(buildResult({
      type: sec.kind === 'kreditkarte' ? 'kreditkarte' : 'kontoauszug',
      format: 'pdf_statement', institution: 'comdirect', account, transactions: txs,
      opening: sec.opening, closing: sec.closing, openingDate: sec.openingDate || periodFrom, closingDate: sec.closingDate || periodTo,
      periodFrom, periodTo, style: 'auszug',
      confidence: hasBoth && sec.opening + sum === sec.closing && !unread ? 0.9 : 0.6, reviewReasons: reasons,
      fields: {
        variant: 'finanzreport', section: sec.label, ...(ignored.length ? { infoSections: ignored } : {}),
        ...(ov?.balance != null ? { overviewBalance: ov.balance } : {}),
        expectedCount: sec.bookings.length, readCount: txs.length,
        diagnostics: {
          pages: new Set(lines.map(l => l.n)).size, lines: lines.length, numberFormat: 'comma', header: sec.label,
          dateLines: sec.bookings.length, bookings: txs.length, unparsed: [], strayAmounts: [],
          expectedCount: sec.bookings.length, readCount: txs.length,
          balance: hasBoth ? { opening: sec.opening, closing: sec.closing, sum, diff: sec.closing - (sec.opening + sum) } : null,
          problems,
        },
      },
    }));
  }
  if (!results.length) {
    // Kein Kontoabschnitt erkannt: leerer Auszug mit Diagnose statt „Sonstiges“
    results.push(buildResult({
      type: 'kontoauszug', format: 'pdf_statement', institution: 'comdirect',
      account: { kind: 'giro', institution: 'comdirect', name: accountName('comdirect', 'Girokonto'), iban: null, currency: 'EUR', number: null },
      transactions: [], periodTo: reportDate, style: 'auszug', confidence: 0.4,
      reviewReasons: ['Keine Kontoabschnitte (Girokonto, Tagesgeld, Visa-Karte) im Finanzreport erkannt'],
      fields: { variant: 'finanzreport', diagnostics: { pages: new Set(lines.map(l => l.n)).size, lines: lines.length, numberFormat: 'comma', header: null, dateLines: 0, bookings: 0, unparsed: [], strayAmounts: [], expectedCount: null, readCount: 0, balance: null, problems: ['Keine Kontoabschnitte im Finanzreport gefunden.'] } },
    }));
  }
  // Depotbestand → eigenes Ergebnis (comdirect Depot: Bestände + Bewertung); Steuerübersicht dorthin, sonst zum ersten Konto
  const tax = parseTaxOverview(lines);
  const depot = finanzreportDepotResult(lines, reportDate, tax);
  if (depot) results.push(depot);
  else if (tax) Object.assign(results[0].document.fields, tax);
  return results;
}
