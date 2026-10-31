// Depot-Reporting (PDF, Textebene): MLP „Reporting für Ihre Konten und Depots“ und der Depotbestand im comdirect-Finanzreport.
// MLP: bleibt für den Nutzer ein Wertpapier-Dokument „Depot-Reporting Q1 2025 MLP“ (Typ wertpapier/depotreport, nur Info, kein
// Betrag), trägt aber das Depotkonto mit Beständen, die Bewertung zum Stichtag (Gesamtwert inkl. Liquiditätskonto), Kennzahlen,
// Wertentwicklung und die Käufe der Transaktionsübersicht; das Liquiditätskonto ist ein zweites Ergebnis (Konto mit IBAN, Stand
// nur als Saldo – der Betrag steckt schon im Depotwert). Geschwärzte Scans ohne lesbare Werte erkennt der Detektor nicht: Sie
// bleiben das reine Info-Dokument des Wertpapier-Parsers.
// comdirect: parseComdirectDepot(lines, …) liefert Bestand, Gesamtkurswert und Steuerübersicht für ein eigenes Depot-Ergebnis.
import { parseGermanAmount, parseGermanDate } from '../../util/format.js';
import { cleanText, makeTx, buildResult, detection, findIban, parseQty } from './common.js';

export const MLP_REPORT_RE = /Reporting\s+f(?:ü|ue|u)r\s+Ihre\s+Konten\s+und\s+Depots/i;
const MLP_OVERVIEW_RE = /Verm(?:ö|oe|o)gensdepot\s+im\s+(?:Ü|U|Ue)berblick/i;

const NUM = '\\d{1,3}(?:\\.\\d{3})*,\\d+';
const AMT = `[+\\-−–]?\\d{1,3}(?:\\.\\d{3})*,\\d{2}`;
const cents = (s) => (s == null ? null : parseGermanAmount(String(s).replace(/[−–]/g, '-')));
const pct = (s) => (s == null ? null : Number(String(s).replace(/\./g, '').replace(',', '.')));
const iso2 = (s) => parseGermanDate(s); // „02.01.25“ → 2025-01-02
const isoDate = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

/** „31. März 2025“ → ISO */
function wordDate(s) {
  const m = /(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})/.exec(s || '');
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase().replace('maerz', 'märz')) + 1;
  return mo ? isoDate(Number(m[3]), mo, Number(m[1])) : null;
}

// ---------------------------------------------------------------- MLP: Zeilenmuster
// Depotübersicht: „A0NB6T   Nordstern Funds - Global Opportunity   20,00 EUR   6,408   118,42 EUR   758,84 EUR“
// (WKN, Bezeichnung, Sparrate optional, Anteile, Kurs + Währung, Kurswert EUR); der Name bricht in Folgezeilen um.
const POS_RE = new RegExp(`^((?=[A-Z0-9]*\\d)[A-Z0-9]{6})\\s+(.+?)\\s+(?:(${NUM})\\s*EUR\\s+)?(${NUM})\\s+(${NUM})\\s*([A-Z]{3})\\s+(${NUM})\\s*EUR$`);
// „Aktien Welt   31.03.2025   13,72 %“ – Anlageschwerpunkt, Kursdatum, Anteil
const FOCUS_RE = /^(.*?)\s*(\d{2}\.\d{2}\.\d{4})\s+(\d{1,3},\d{1,2})\s*%$/;
const CUSTODY_RE = /^(Wertpapierrechnung|Girosammelverwahrung|Streifbandverwahrung|Sonstige|Treuhand\w*)\b\s*(.*)$/i;
const BLOCK_RE = /Sperre|St(?:ü|ue)cke/i;
const LIQ_LINE_RE = new RegExp(`^Liquidit(?:ä|ae|a)tskonto\\s+(${AMT})\\s*EUR$`, 'i');
const SUM_RE = new RegExp(`^Summe\\s+(${AMT})\\s*EUR`, 'i');
const TOTAL_RE = new RegExp(`^Gesamtwert\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\s+(${AMT})\\s*EUR`, 'i');
const RESULT_RE = new RegExp(`^Gesamtergebnis\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\s+bis\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\s+(${AMT})\\s*EUR`, 'i');
const TRADE_HEAD_RE = /^Bezeichnung\s+(.+?)\s+WKN\s+((?=[A-Z0-9]*\d)[A-Z0-9]{6})\s*$/;
const TRADE_RE = /^(\d{2}\.\d{2}\.\d{2}(?:\d{2})?)\s+([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\s./-]*?)\s+([+\-−–]?\d.*)$/;
const TOKEN_RE = /([+\-−–]?\d{1,3}(?:\.\d{3})*,\d+)(?:\s*([A-Z]{3})\b)?/g;
const PERF_POS_RE = new RegExp(`^((?=[A-Z0-9]*\\d)[A-Z0-9]{6})\\s+(.+?)\\s+([+\\-−–]?\\d{1,3},\\d{2})\\s*%\\s+(${AMT})\\s*EUR$`);

// Kennzahlen „Ihr Vermögensdepot im Überblick“: Feldname ← Zeilenanfang
const FIGURES = [
  ['distributions', /^Aussch(?:ü|ue|u)ttungen\s*\/\s*Zinsen/i],
  ['depotFee', /^Depotentgelt\b/i],
  ['foreignFees', /^Fremde\s+Spesen\b/i],
  ['trailerRefund', /^Erstattete\s+Vertriebsfolgeprovision\b/i],
  ['savingsRate', /^Aktuelle\s+Sparrate\b/i],
  ['firstDeposit', /^Ersteinzahlung\b/i],
  ['deposits', /^Summe\s+der\s+Einzahlungen\b/i],
  ['deliveriesIn', /^Summe\s+der\s+Einlieferungen\b/i],
  ['withdrawals', /^Summe\s+der\s+Auszahlungen\b/i],
  ['deliveriesOut', /^Summe\s+der\s+Auslieferungen\b/i],
  ['taxCredit', /^Anrechenbare\s+Steuern\b/i],
  ['flatTax', /^Abgeltungs?steuer\b/i],
  ['flatTaxRefund', /^Erstattete\s+Abgeltungs?steuer\b/i],
];
const AMT_END_RE = new RegExp(`(${AMT})\\s*EUR\\s*$`);

const linesOf = (ctx) => ctx.lines.map(l => ({ ...l, text: String(l.text || '').replace(/\s+$/, '') })).filter(l => l.text.trim());

/** Erkennung: MLP-Reporting mit lesbarem Inhalt (mindestens eine Position oder der Gesamtwert). */
export function detectMlpReporting(ctx) {
  if (ctx.kind && ctx.kind !== 'pdf' && ctx.kind !== 'image') return null;
  const text = ctx.text || '';
  if (!(MLP_REPORT_RE.test(text) || MLP_OVERVIEW_RE.test(text)) || !/\bMLP\b/.test(text)) return null;
  const lines = linesOf(ctx).map(l => l.text.trim());
  const positions = lines.filter(t => POS_RE.test(t)).length;
  const total = lines.some(t => TOTAL_RE.test(t));
  if (!positions && !total) return null;
  const trades = lines.filter(t => { const m = TRADE_RE.exec(t); return m && /EUR/.test(m[3]); }).length;
  const signals = ['MLP Reporting für Konten und Depots'];
  if (positions) signals.push(`${positions} Depotpositionen`);
  if (total) signals.push('Gesamtwert zum Stichtag');
  if (trades) signals.push(`${trades} Transaktionen`);
  return detection('wertpapier', 'mlp_reporting', 'MLP', 0.95, signals, { subtype: 'depotreport' });
}

/** Zeitraum aus „zum 1. Quartal 2025“ bzw. „Transaktionsübersicht vom 01. Januar 2025 bis 31. März 2025“. */
function periodOf(text) {
  const q = /\b([1-4])\.\s*Quartal\s+(20\d{2})\b/i.exec(text);
  if (q) {
    const y = Number(q[2]), m = Number(q[1]) * 3;
    return { from: isoDate(y, m - 2, 1), to: isoDate(y, m, lastDay(y, m)), label: `Q${q[1]} ${y}` };
  }
  const r = /vom\s+(\d{1,2}\.\s*\p{L}+\s+\d{4})\s+bis\s+(\d{1,2}\.\s*\p{L}+\s+\d{4})/iu.exec(text);
  if (r) return { from: wordDate(r[1]), to: wordDate(r[2]), label: null };
  return null;
}

/** Depotübersicht: Positionen mit Folgezeilen (Namensrest, Schwerpunkt/Kursdatum/Anteil, Verwahrart, Sperre/Devisenkurs). */
function parsePositions(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = POS_RE.exec(lines[i]);
    if (!m) continue;
    const h = {
      name: cleanText(m[2]), isin: null, wkn: m[1], qty: parseQty(m[4]), price: cents(m[5]), priceExact: parseQty(m[5]),
      currency: m[6], value: cents(m[7]), savingsRate: m[3] ? cents(m[3]) : null,
      focus: null, priceDate: null, share: null, custody: null, fxRate: null,
    };
    const nameParts = [];
    let j = i + 1;
    // Namensrest bis zur Zeile mit Kursdatum und Anteil (höchstens drei Zeilen)
    for (; j < lines.length && j <= i + 4; j++) {
      const t = lines[j];
      if (POS_RE.test(t) || LIQ_LINE_RE.test(t) || SUM_RE.test(t)) break;
      const f = FOCUS_RE.exec(t);
      if (f) { h.focus = cleanText(f[1]) || null; h.priceDate = parseGermanDate(f[2]); h.share = pct(f[3]); j++; break; }
      nameParts.push(t);
    }
    if (h.priceDate) {
      if (nameParts.length) h.name = cleanText(`${h.name} ${nameParts.join(' ')}`);
      for (let k = j; k < lines.length && k <= j + 1; k++) {
        const t = lines[k];
        if (POS_RE.test(t)) break;
        const c = CUSTODY_RE.exec(t);
        if (c) { h.custody = c[1]; continue; }
        if (BLOCK_RE.test(t)) { const fx = /(\d+,\d{3,6})\s*$/.exec(t); if (fx) h.fxRate = parseQty(fx[1]); }
      }
    }
    out.push(h);
  }
  return out;
}

/** Wertpapiergeschäfte der Transaktionsübersicht je Fonds („02.01.25   Kauf   20,00 EUR   121,05 EUR   0,00 EUR   0,165“). */
function parseTrades(lines) {
  const out = [];
  let cur = null;
  for (const t of lines) {
    const h = TRADE_HEAD_RE.exec(t);
    if (h) { cur = { name: cleanText(h[1]), wkn: h[2] }; continue; }
    if (!cur) continue;
    const m = TRADE_RE.exec(t);
    if (!m) continue;
    const toks = [...m[3].matchAll(TOKEN_RE)].map(x => ({ s: x[1], cur: x[2] || null }));
    // Betrag (EUR) vorn, Anteile (ohne Währung) hinten – sonst unlesbar (geschwärzt)
    if (toks.length < 3 || toks[0].cur !== 'EUR' || toks[toks.length - 1].cur) continue;
    const mid = toks.slice(1, -1);
    const foreign = mid.filter(x => x.cur && x.cur !== 'EUR');
    const eur = mid.filter(x => x.cur === 'EUR');
    // Spalten: [Steuern EUR] Anteilspreis (EUR/Fremdwährung) [Devisenkurs] Ausgabeaufschlag bzw. fremde Spesen (EUR)
    let price, fx = null, fee = null, tax = null;
    if (foreign.length) {
      price = foreign[0]; fx = foreign[1] || null;
      fee = eur.length ? eur[eur.length - 1] : null;
      if (eur.length > 1) tax = eur[0];
    } else {
      fee = eur.length >= 2 ? eur[eur.length - 1] : null;
      price = eur.length >= 2 ? eur[eur.length - 2] : eur[0];
      if (eur.length > 2) tax = eur[0];
    }
    const kind = cleanText(m[2]);
    out.push({
      date: iso2(m[1]), kind, wkn: cur.wkn, name: cur.name, amount: cents(toks[0].s), units: parseQty(toks[toks.length - 1].s),
      price: price ? parseQty(price.s) : null, priceCurrency: price?.cur || null, fxRate: fx ? parseQty(fx.s) : null,
      fee: fee ? cents(fee.s) : null, tax: tax ? cents(tax.s) : null,
    });
  }
  return out;
}

const OUTFLOW = /kauf|sparplan|wiederanlage|einlieferung/i;
const fmtNum = (n, d) => (n == null ? '–' : n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: 6 }));

/** Abschnitt zwischen zwei Überschriften (Zeilen) */
function section(lines, startRe, endRe) {
  const s = lines.findIndex(t => startRe.test(t));
  if (s < 0) return [];
  const rest = lines.slice(s + 1);
  const e = endRe ? rest.findIndex(t => endRe.test(t)) : -1;
  return e < 0 ? rest : rest.slice(0, e);
}

export function parseMlpReporting(det, ctx) {
  const all = linesOf(ctx);
  const lines = all.map(l => l.text.trim());
  const text = lines.join('\n');
  const period = periodOf(text);
  const stand = wordDate(/Stand:\s*(\d{1,2}\.\s*\p{L}+\s+\d{4})/iu.exec(text)?.[1]);

  const positions = parsePositions(lines);
  const liqLine = lines.map(t => LIQ_LINE_RE.exec(t)).find(Boolean);
  const liquidity = liqLine ? cents(liqLine[1]) : null;
  const overviewIdx = lines.findIndex(t => /^Depot(?:ü|ue)bersicht/i.test(t));
  const sumLine = lines.slice(Math.max(0, overviewIdx)).map(t => SUM_RE.exec(t)).find(Boolean);
  const totals = lines.map(t => TOTAL_RE.exec(t)).filter(Boolean).map(m => ({ date: parseGermanDate(m[1]), value: cents(m[2]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const end = totals.at(-1) || null;
  const date = end?.date || stand || period?.to || null;
  const depotValue = end?.value ?? (sumLine ? cents(sumLine[1]) : null);
  const securitiesValue = positions.reduce((a, h) => a + (h.value || 0), 0);

  // Kennzahlen „Ihr Vermögensdepot im Überblick“
  const figures = {};
  for (const t of section(lines, MLP_OVERVIEW_RE, /^Wertentwicklung\b/i)) {
    const f = FIGURES.find(([, re]) => re.test(t));
    const a = AMT_END_RE.exec(t);
    if (f && a && figures[f[0]] == null) figures[f[0]] = cents(a[1]);
    const r = RESULT_RE.exec(t);
    if (r) { figures.result = cents(r[3]); figures.resultPeriod = { from: parseGermanDate(r[1]), to: parseGermanDate(r[2]) }; }
  }
  if (totals.length > 1) { figures.valuePrevYearEnd = totals[0].value; figures.valuePrevDate = totals[0].date; }
  if (end) figures.valueEnd = end.value;

  // Wertentwicklung: zeit-/geldgewichtet [laufendes Jahr, Berichtszeitraum, seit Beginn]
  const perfHead = section(lines, /^Wertentwicklung\s+Ihres\b/i, /^zeitgewichtete\b/i).join(' ');
  const perfPeriods = [...perfHead.matchAll(/(\d{2}\.\d{2}\.\d{4})\s*bis\s*(\d{2}\.\d{2}\.\d{4})/g)].slice(0, 3);
  const rates = (re) => { const l = lines.find(t => re.test(t)); return l ? [...l.matchAll(/([+\-−–]?\d{1,3},\d{1,2})\s*%/g)].map(x => pct(x[1].replace(/[−–]/, '-'))) : []; };
  const twr = rates(/^zeitgewichtete\s+Rendite/i), mwr = rates(/^geldgewichtete\s+Rendite/i);
  const performance = twr.length || mwr.length ? {
    labels: ['Laufendes Jahr', 'Berichtszeitraum', 'Seit Beginn'],
    periods: perfPeriods.map(m => ({ from: parseGermanDate(m[1]), to: parseGermanDate(m[2]) })), twr, mwr,
  } : null;
  // Wertentwicklung je Wertpapier seit erstmaligem Kauf
  for (const t of section(lines, /^Wertentwicklung\s+Ihrer\s+Wertpapiere/i, /^Depotentwicklung\b/i)) {
    const m = PERF_POS_RE.exec(t);
    const h = m && positions.find(p => p.wkn === m[1]);
    if (h) { h.performancePct = pct(m[3].replace(/[−–]/, '-')); h.result = cents(m[4]); }
  }

  // Depotaufbau / Anlagestruktur
  const structure = {};
  for (const t of section(lines, /^Depotaufbau\b/i, MLP_OVERVIEW_RE)) {
    const m = new RegExp(`^(\\p{L}[\\p{L}\\s-]*?)\\s+(${AMT})\\s*EUR\\b`, 'u').exec(t);
    if (m && !/^(Summe|Anlagepositionen)/i.test(m[1])) structure[cleanText(m[1])] = cents(m[2]);
  }
  const ex = new RegExp(`\\(alle\\s+Konten\\s+und\\s+Depots\\)\\s+(${AMT})\\s*EUR\\s+(${AMT})\\s*EUR`, 'i').exec(text);
  const exemption = ex ? { requested: cents(ex[1]), remaining: cents(ex[2]) } : null;

  const number = /^Depot:\s*(\d{6,})\b/im.exec(text)?.[1] || null;
  const liqIban = findIban(lines.find(t => /^Liquidit(?:ä|ae|a)tskonto\s*:/i.test(t)) || '');
  const customer = /Kundennummer:?\s*(\d{5,})/i.exec(text)?.[1] || null;
  const depotAccount = { kind: 'depot', institution: 'MLP', name: 'MLP Vermögensdepot', iban: null, currency: 'EUR', number };

  for (const h of positions) h.date = date;
  const trades = parseTrades(lines);
  const transactions = trades.map(t => makeTx({
    bookingDate: t.date, valueDate: t.date,
    // Kauf: Geld fließt aus dem Depot-Guthaben in den Fonds (wie comdirect-Depotumsätze); im Depot neutral (Umschichtung)
    amount: OUTFLOW.test(t.kind) ? -Math.abs(t.amount) : Math.abs(t.amount),
    counterpartyRaw: t.name,
    purpose: `${t.kind} ${fmtNum(t.units, 3)} Anteile ${t.name} (WKN ${t.wkn}) zu ${fmtNum(t.price, 2)} ${t.priceCurrency || 'EUR'}`
      + (t.fxRate ? `, Devisenkurs ${fmtNum(t.fxRate, 4)}` : '') + (t.fee ? `, Spesen ${fmtNum(t.fee / 100, 2)} EUR` : ''),
    bookingText: /verkauf/i.test(t.kind) ? 'Wertpapierverkauf' : /kauf|sparplan/i.test(t.kind) ? 'Wertpapierkauf' : t.kind,
    dedupeToken: `${t.wkn}-${t.kind}-${t.units ?? ''}`.toLowerCase(),
  }));
  for (let k = 0; k < transactions.length; k++) {
    const t = trades[k];
    Object.assign(transactions[k], { wkn: t.wkn, units: t.units, unitPrice: t.price, priceCurrency: t.priceCurrency, fxRate: t.fxRate, tradeFee: t.fee });
  }

  const reasons = [];
  if (depotValue != null && positions.length && liquidity != null && securitiesValue + liquidity !== depotValue) {
    reasons.push('Depotsumme stimmt nicht (Positionen + Liquiditätskonto ≠ Gesamtwert)');
  }
  const tradeRows = lines.filter(t => /^\d{2}\.\d{2}\.\d{2}\s+\p{L}/u.test(t)).length;
  if (tradeRows > trades.length) reasons.push(`${tradeRows - trades.length} Transaktionen nicht lesbar – bitte prüfen`);

  const res = buildResult({
    type: 'depot', format: 'mlp_reporting', institution: 'MLP', account: depotAccount, transactions, holdings: positions,
    valuations: depotValue != null && date ? [{ date, value: depotValue, label: 'Depotwert MLP Vermögensdepot' }] : [],
    periodFrom: period?.from, periodTo: period?.to || date, style: 'bestand', confidence: reasons.length ? 0.6 : 0.95, reviewReasons: reasons,
  });
  // Für den Nutzer ein Wertpapier-Dokument (Depot-Reporting), kein Betrag, nie Beleg
  const label = period?.label || null;
  res.document = {
    ...res.document,
    type: 'wertpapier', subtype: 'depotreport', institution: 'MLP', issuer: 'MLP', date, amount: null,
    title: ['Depot-Reporting', label, 'MLP'].filter(Boolean).join(' '),
    fields: {
      format: 'mlp_reporting', security: null, wkn: null, isin: null, period: label, depot: 'Vermögensdepot', infoOnly: true,
      depotName: depotAccount.name, depotNumber: number, customerNumber: customer, depotValue, securitiesValue: positions.length ? securitiesValue : null,
      liquidity: liquidity != null || liqIban ? { iban: liqIban, value: liquidity } : null,
      positions: positions.length, structure: Object.keys(structure).length ? structure : null,
      ...figures, performance, exemption, transactionCount: transactions.length,
    },
  };
  const out = [res];
  if (liqIban) {
    // Liquiditätskonto: eigenes Konto; Stand nur als Saldo (keine Bewertung – im Depotwert enthalten, sonst doppelt im Vermögen)
    const acc = { kind: 'tagesgeld', institution: 'MLP', name: 'MLP Liquiditätskonto', iban: liqIban, currency: 'EUR', number: null, depotNumber: number };
    const liq = buildResult({
      type: 'kontoauszug', format: 'mlp_reporting', institution: 'MLP', account: acc, transactions: [], valuations: [],
      closing: liquidity, closingDate: date, periodFrom: period?.from, periodTo: date, style: 'auszug', confidence: 0.9,
      fields: { variant: 'mlp_reporting', section: 'Liquiditätskonto', includedInDepotValue: true, depotNumber: number },
    });
    liq.valuations = [];
    liq.document.title = `Kontostand MLP Liquiditätskonto${date ? ' ' + date.split('-').reverse().join('.') : ''}`;
    out.push(liq);
  }
  return out;
}

// ---------------------------------------------------------------- comdirect Finanzreport: Depotbestand + Steuerübersicht
// „A2QL8M / Wertpapierrechnung   140,000   1,107   EUR   154,98   150,88   +4,10“, danach „Kanada/USA über AKV   +0,00“
// (Lagerland, Stückzinsen) und der Name – oder nur „VESTRA GR.HLDG NA 1/8   +0,00“ (Name, Stückzinsen).
const CD_ROW_RE = new RegExp(`^((?=[A-Z0-9]*\\d)[A-Z0-9]{6})\\s*/\\s*(\\S+)\\s+(${NUM})\\s+(${NUM})\\s+([A-Z]{3})\\s+(${AMT})\\s+(${AMT})\\s+(${AMT})$`);
const CD_TAIL_RE = new RegExp(`^(.*?)\\s+(${AMT})$`);
const CD_END_RE = /^(?:Gesamtkurswert|Ste[uv]er[üu]bersicht|Zins[üu]bersicht|Wichtige\s+Hinweise)/i;
const CD_NOISE_RE = /^(?:Finanzreport\s+Nr|Kundennummer|Depotbestand\b|WKN\s*\/\s*Verwahrart|Bezeichnung\s+Kurs|comdirect\s+[–-]\s+eine\s+Marke|Pascalkehre)/i;
const LAGER_RE = /(?:über\s+AKV|direkt|Lagerstelle)\s*$/i;
const TAX_KEYS = [
  ['gainsStocks', /^Gewinne\/Verluste\s+Aktien/i], ['lossPotStocks', /^Verlustverrechnungstopf\s+Aktien/i],
  ['gainsOther', /^Gewinne\/Verluste\s+Sonstige/i], ['lossPotOther', /^Verlustverrechnungstopf\s+Sonstige/i],
  ['allowanceFiled', /^Eingereichter\s+Freibetrag/i], ['allowanceUsed', /^In\s+Anspruch\s+genommener\s+Freibetrag/i],
  ['allowanceRemaining', /^Verbleibender\s+Freibetrag/i], ['foreignTaxCreditable', /^Anrechenbare\s+ausl/i],
  ['capitalGainsTax', /^Abgef(?:ü|ue)hrte\s+Kapitalertrag/i], ['soli', /^Abgef(?:ü|ue)hrter\s+Solidarit/i],
  ['churchTax', /^Abgef(?:ü|ue)hrte\s+Kirchensteuer/i], ['foreignTaxCredited', /^Angerechnete\s+ausl/i],
];

/** Depotbestand eines comdirect-Finanzreports → { holdings, total, cost, gain } oder null (kein lesbarer Bestand). */
export function parseComdirectDepot(lines, date) {
  const ls = lines.map(l => cleanText(typeof l === 'string' ? l : l.text));
  const start = ls.findIndex(t => /^Depotbestand\b/i.test(t));
  if (start < 0) return null;
  const holdings = [];
  let cur = null, total = null, cost = null, gain = null, accrued = null;
  const flush = () => {
    if (!cur) return;
    const named = cur.rest.filter(r => r.amount == null || !LAGER_RE.test(r.text));
    const lager = cur.rest.find(r => r.amount != null && LAGER_RE.test(r.text));
    cur.h.name = cleanText(named.map(r => r.text).join(' ')) || cur.h.wkn;
    if (lager) cur.h.custodyCountry = lager.text;
    const ac = cur.rest.find(r => r.amount != null);
    cur.h.accruedInterest = ac ? ac.amount : null;
    holdings.push(cur.h);
    cur = null;
  };
  for (let i = start + 1; i < ls.length; i++) {
    const t = ls[i];
    if (!t || CD_NOISE_RE.test(t)) continue;
    const g = new RegExp(`^Gesamtkurswert\\s+(${AMT})(?:\\s+(${AMT}))?(?:\\s+(${AMT}))?`, 'i').exec(t);
    if (g) { flush(); total = cents(g[1]); cost = cents(g[2]); gain = cents(g[3]); continue; }
    const gw = new RegExp(`^Gesamtwert\\s+(${AMT})$`, 'i').exec(t);
    if (gw) { total = cents(gw[1]); continue; }
    const sz = new RegExp(`^St(?:ü|ue)ckzinsen\\s+gesamt\\s+(${AMT})`, 'i').exec(t);
    if (sz) { accrued = cents(sz[1]); continue; }
    if (CD_END_RE.test(t)) { flush(); break; }
    const m = CD_ROW_RE.exec(t);
    if (m) {
      flush();
      cur = {
        h: {
          name: null, isin: null, wkn: m[1], custody: m[2], qty: parseQty(m[3]), price: cents(m[4]), priceExact: parseQty(m[4]),
          currency: m[5], value: cents(m[6]), cost: cents(m[7]), gain: cents(m[8]), date,
        },
        rest: [],
      };
      continue;
    }
    if (!cur) continue;
    if (cur.rest.length >= 3) { flush(); continue; }
    const tail = CD_TAIL_RE.exec(t);
    cur.rest.push(tail ? { text: cleanText(tail[1]), amount: cents(tail[2]) } : { text: t, amount: null });
  }
  flush();
  if (!holdings.length) return null;
  return { holdings, total: total ?? holdings.reduce((a, h) => a + (h.value || 0), 0), cost, gain, accruedInterest: accrued };
}

/** Steuerübersicht des Finanzreports → { taxOverview: { Bezeichnung: Cent }, …Schlüssel } oder null */
export function parseTaxOverview(lines) {
  const ls = lines.map(l => cleanText(typeof l === 'string' ? l : l.text));
  const start = ls.findIndex(t => /^Ste[uv]er[üu]bersicht/i.test(t));
  if (start < 0) return null;
  const overview = {}, keyed = {};
  for (let i = start + 1; i < ls.length; i++) {
    const t = ls[i];
    if (/^(?:Zins[üu]bersicht|Wichtige\s+Hinweise|\d\s+Dieses\s+ist|comdirect\s+[–-]\s+eine)/i.test(t)) break;
    const key = TAX_KEYS.find(([, re]) => re.test(t));
    if (!key) continue;
    let m = new RegExp(`^(.*?)\\s+(${AMT})$`).exec(t);
    let label = m ? m[1] : t, amount = m ? cents(m[2]) : null;
    // Betrag in der Folgezeile („Abgeführte Kapitalertragsteuer“ / „10,40“)
    if (amount == null && new RegExp(`^${AMT}$`).test(ls[i + 1] || '')) { amount = cents(ls[i + 1]); i++; }
    if (amount == null) continue;
    label = cleanText(label);
    overview[label] = amount;
    keyed[key[0]] = amount;
  }
  if (!Object.keys(overview).length) return null;
  const paid = ['capitalGainsTax', 'soli', 'churchTax'].filter(k => keyed[k] != null);
  return { taxOverview: overview, ...keyed, ...(paid.length ? { taxPaid: paid.reduce((a, k) => a + keyed[k], 0) } : {}) };
}

/** Depot-Ergebnis für den Finanzreport (comdirect Depot, Bestand + Bewertung zum Berichtstag) oder null. */
export function finanzreportDepotResult(lines, reportDate, tax) {
  const dep = parseComdirectDepot(lines, reportDate);
  if (!dep) return null;
  const sum = dep.holdings.reduce((a, h) => a + (h.value || 0), 0);
  const reasons = sum !== dep.total ? ['Depotsumme stimmt nicht'] : [];
  return buildResult({
    type: 'depot', format: 'pdf_statement', institution: 'comdirect',
    account: { kind: 'depot', institution: 'comdirect', name: 'comdirect Depot', iban: null, currency: 'EUR', number: null },
    transactions: [], holdings: dep.holdings, valuations: reportDate ? [{ date: reportDate, value: dep.total, label: 'Depotwert comdirect' }] : [],
    periodFrom: reportDate, periodTo: reportDate, style: 'bestand', total: dep.total, confidence: reasons.length ? 0.6 : 0.9, reviewReasons: reasons,
    fields: {
      variant: 'finanzreport', section: 'Depot', positions: dep.holdings.length, depotValue: dep.total,
      cost: dep.cost, gain: dep.gain, accruedInterest: dep.accruedInterest, ...(tax || {}),
    },
  });
}
