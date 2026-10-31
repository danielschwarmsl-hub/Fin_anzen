// Wertpapier-Dokumente der Bank/des Brokers: Kauf/Verkauf (Geschäfts-/Wertpapierabrechnung), Dividende/Ertragsgutschrift,
// MiFID-Kosteninformation (ex ante) und Depot-Reporting. Beträge in Cent; Kauf negativ (Belastung), Verkauf/Ertrag positiv.
// Kosteninformation und Reporting sind reine Info: kein Betrag, fields.infoOnly = true (nie Beleg zu einer Buchung).
import { parseGermanDate } from '../../util/format.js';
import { getLines, allDates, baseDoc, baseResult, review, cleanOcr, pad2, lastDayOfMonth } from './util.js';
import { BROKERS, matchFirst } from './known.js';

export const SECURITY_SUBTYPES = ['kauf', 'verkauf', 'dividende', 'kosteninfo', 'depotreport'];
const INFO_ONLY = new Set(['kosteninfo', 'depotreport']);

const fold = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

/** Untertyp aus dem (gefalteten) Text; Reihenfolge: Info-Dokumente vor Erträgen vor Kauf/Verkauf. */
export function securitySubtype(text) {
  const t = fold(text);
  if (/kosteninformation zum wertpapiergeschaeft|kostensimulation|ex-?ante[- ]?kosten|kosteninformation\b.*(?:kauf|verkauf)/.test(t)) return 'kosteninfo';
  if (/reporting fuer ihre konten|depotauszug|vermoegens-?report|depot-?reporting|quartalsreport|depotuebersicht|depotaufstellung|jahresdepot/.test(t)) return 'depotreport';
  if (/dividendengutschrift|gutschrift faelliger wertpapier-?ertraege|ertra(?:e|eg)nis-?gutschrift|ertragsgutschrift|ausschuettungsgutschrift|zinsgutschrift|kupongutschrift|\bdividende\b|\bausschuettung\b|\bkupon\b|zinsschein/.test(t)) return 'dividende';
  const lasten = /zu ihren lasten/.test(t), gunsten = /zu ihren gunsten/.test(t);
  if (lasten !== gunsten) return lasten ? 'kauf' : 'verkauf';
  const kauf = /wertpapierkauf|(?<!ver)\bkauf\b|\bbuy\b/.exec(t), verkauf = /wertpapierverkauf|\bverkauf\b|\bsell\b/.exec(t);
  if (kauf && verkauf) return kauf.index <= verkauf.index ? 'kauf' : 'verkauf';
  if (verkauf) return 'verkauf';
  if (kauf) return 'kauf';
  return /depotbestand|vermoegensdepot/.test(t) ? 'depotreport' : null;
}

// ---------------------------------------------------------------- Zahlen
const DATE_RE = /\b\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?(?!\d)/g;
const PCT_RE = /\d+(?:[.,]\d+)?\s*%/g;
// Nur saubere Beträge: direkt davor kein Buchstabe/keine Ziffer (geschwärzte Stellen liest die OCR als „N.H62,00“, „MH, 50“)
const MONEY_RE = /(?<![\p{L}\d.,])([-−–]\s?)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?![\d,]|\.\d)(\s?[-−–](?!\s*\d))?/gu;

const CUR = '(EUR|USD|GBP|CHF|CAD|JPY|DKK|SEK|NOK|AUD|HKD|€)';
const CUR_BEFORE = new RegExp(`(?<![A-Za-z])${CUR}[\\s:]{0,2}$`), CUR_AFTER = new RegExp(`^\\s?${CUR}`);

/** Beträge einer Zeile in Cent mit Währung davor/dahinter: [{ cents, cur }] */
function moneyIn(line) {
  const s = cleanOcr(line).replace(DATE_RE, (m) => ' '.repeat(m.length)).replace(PCT_RE, (m) => ' '.repeat(m.length));
  const out = [];
  for (const m of s.matchAll(MONEY_RE)) {
    const v = Math.round(Number(m[2].replace(/\./g, '').replace(',', '.')) * 100);
    const neg = !!m[1] || !!m[3];
    const before = s.slice(Math.max(0, m.index - 6), m.index), after = s.slice(m.index + m[0].length, m.index + m[0].length + 5);
    const cur = (CUR_BEFORE.exec(before) || CUR_AFTER.exec(after) || [])[1] || null;
    out.push({ cents: neg ? -v : v, cur: cur === '€' ? 'EUR' : cur });
  }
  return out;
}
const lastMoney = (line, cur) => { const a = moneyIn(line).filter((x) => !cur || x.cur === cur || x.cur == null); return a.length ? a[a.length - 1] : null; };

/** Betrag hinter einem Label (gleiche Zeile, sonst die nächste Zeile ohne eigenes Label). */
function labeled(lines, re, { cur, not } = {}) {
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i]) || (not && not.test(lines[i]))) continue;
    const m = lastMoney(lines[i].slice(re.exec(lines[i]).index), cur);
    if (m) return m;
  }
  return null;
}

const num = (s) => { const v = Number(String(s).replace(/\./g, '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const dateIn = (line) => allDates(String(line || ''))[0] || null;
const clean = (s) => String(s || '').replace(/[|[\]{}_—–=‚'"]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
// Geschwärzte Stellen erscheinen als kurze Großbuchstaben-Fetzen („DD“, „MM“, „EEE“, „N“)
const meaningful = (s) => /[a-zäöü]{2}/.test(s) || /[A-ZÄÖÜ]{4,}/.test(s);

// ---------------------------------------------------------------- Kennungen
function isinValid(isin) {
  const digits = isin.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
function findIsin(lines) {
  for (const l of lines) for (const m of l.matchAll(/\b([A-Z]{2}[A-Z0-9]{9}\d)\b/g)) if (isinValid(m[1])) return m[1];
  return null;
}
function findWkn(lines, isin) {
  for (const l of lines) {
    const m = /\b(?:WKN|WPKNR)\b[^A-Z0-9\n]{0,6}([A-Z0-9]{6})\b/i.exec(l);
    if (m && /\d/.test(m[1])) return m[1].toUpperCase();
  }
  if (isin) {
    const l = lines.find((x) => x.includes(isin));
    const m = l && /\b([A-Z0-9]{6})\b\s*\/?\s*[A-Z]{2}[A-Z0-9]{9}\d/.exec(l);
    if (m && /\d/.test(m[1])) return m[1];
  }
  return null;
}

/** Bezeichnung des Wertpapiers: Zeile unter „Wertpapier-Bezeichnung“, Zeile mit „… 10 Stk.“ oder vor der ISIN. */
function findSecurity(lines, isin, wkn) {
  const strip = (s) => clean(String(s)
    .replace(/^\s*per\s+\d{1,2}\.\d{1,2}\.\d{2,4}\s*/i, '')
    .replace(isin || '\u0000', ' ').replace(new RegExp(`\\b${wkn || '\u0000'}\\b`), ' ')
    .replace(/\b(?:ISIN|WKN)\b\s*:?/gi, ' ').replace(/\s\/\s*$/, ' ')
    .replace(/\s+[\d.,]+\s*(?:Stk\.?|St\.|St[uü]ck)(?=\s|$).*$/i, ' ')
    .replace(/\b(?:STK|Stk\.?|St[uü]ck)\s*[\d.,]+.*$/i, ' ')
    .replace(/(?:\s+([A-Z])\1{0,3})+\s*$/, ''));
  const h = lines.findIndex((l) => /wertpapier-?\s?bezeichnun|^\s*(?:bezeichnung|wertpapier|position)\b/i.test(l));
  if (h >= 0) {
    for (const l of lines.slice(h + 1, h + 3)) {
      const s = strip(l);
      if (s.length >= 3 && meaningful(s) && !/nennwert|kurs\b|anzahl|^stk/i.test(s)) return s.slice(0, 80);
    }
  }
  for (const l of lines) {
    const m = /^(.{3,60}?)\s+[\d.,]+\s*(?:Stk\.?|St[uü]ck)\b/i.exec(l);
    if (m && meaningful(m[1]) && !/kauf|verkauf|position|anzahl|bestand/i.test(m[1])) return strip(m[1]).slice(0, 80);
  }
  if (isin) {
    const i = lines.findIndex((l) => l.includes(isin));
    const s = i >= 0 ? strip(lines[i]) : '';
    if (s.length >= 3 && meaningful(s)) return s.slice(0, 80);
    const prev = i > 0 ? strip(lines[i - 1]) : '';
    if (prev.length >= 3 && meaningful(prev) && !/:\s*$/.test(prev)) return prev.slice(0, 80);
  }
  return null;
}

function findQuantity(lines) {
  for (const l of lines) {
    // „10 Stk.“ vor „Stk. 10“; eine Zahl mit Währung dahinter ist der Kurs, nicht die Stückzahl
    const m = /(?:^|\s)(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(?:Stk\.?|St[uü]ck)(?=\s|$)/i.exec(l)
      || /\b(?:STK|Stk\.?|St\.|St[uü]ck|Anzahl)\s*:?\s*(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)(?=\s|$)(?!\s*(?:EUR|USD|€))/i.exec(l);
    if (m) { const q = num(m[1]); if (q > 0) return q; }
  }
  return null;
}

function findPrice(lines) {
  for (const l of lines) {
    const m = /\b(?:Ausf[uü]hrungskurs|Kurs|Preis)\b(?!wert)[^\d\n]{0,25}?(?<![\p{L}\d.,])(\d{1,3}(?:\.\d{3})*,\d{2,6}|\d+,\d{2,6})(?![\d,])/iu.exec(l)
      || /\bzu\s+(?<![\p{L}\d.,])(\d{1,3}(?:\.\d{3})*,\d{2,6}|\d+,\d{2,6})\s*(?:EUR|USD|€)/iu.exec(l)
      || /\bStk\.?\s+(\d{1,3}(?:\.\d{3})*,\d{2,6}|\d+,\d{2,6})\s*(?:EUR|€)\s+[\d.,]+\s*(?:EUR|€)/iu.exec(l.replace(/^.*?\d+\s*(?=Stk)/i, ''));
    if (m) { const v = num(m[1]); if (v > 0) return Math.round(v * 100); }
  }
  return null;
}

function findVenue(lines) {
  for (const l of lines) {
    const m = /(?:Ausf[uü]hrungsplatz|Handelsplatz|B[oö]rsenplatz|Ausf[uü]hrungsort|Handelsort)\s*[:.]?\s*([A-Za-zÄÖÜäöü][\w&.\- ]{1,40}?)(?=\s{2,}|\s*\(|\s*$|\s+Handels)/.exec(l)
      || /\ban der\s+([A-Z][\w&.\- ]{2,30}?)\s+(?:Exchange|B[oö]rse)\b/.exec(l);
    if (m) { const v = clean(m[1]); if (v && meaningful(v)) return v; }
  }
  return null;
}

function findOrderNo(lines) {
  for (const l of lines) {
    const m = /\b(?:Ordernummer|Order-?Nr\.?|Auftragsnummer|Auftrags-?Nr\.?|Order)\s*[:.]?\s*([A-Z0-9][A-Z0-9.\-/]{4,})/i.exec(l);
    if (m && /\d/.test(m[1]) && /\d{3}/.test(m[1])) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------- Datum, Valuta, Endbetrag
const TRADE_DAY = /gesch[aä]ftstag|schlusstag|handelstag|ausf[uü]hrungstag|ausf[uü]hrungszeit|^\s*datum\b|\bdatum\s*:/i;

function findDate(lines, subtype) {
  for (const l of lines) if (/gesch[aä]ftstag|schlusstag|handelstag|ausf[uü]hrungstag/i.test(l) && dateIn(l)) return dateIn(l);
  if (subtype !== 'depotreport') {
    const t = lines.find((l) => /kosteninformation|gesch[aä]ftsabrechnung|wertpapierabrechnung|abrechnung\s+vom|market-?order|limit-?order/i.test(l) && dateIn(l));
    if (t) return dateIn(t);
  }
  const alone = lines.slice(0, 25).find((l) => /^\W{0,3}\d{1,2}\.\d{1,2}\.\d{4}\W{0,3}$/.test(l.trim()));
  if (alone) return dateIn(alone);
  for (const l of lines) if (TRADE_DAY.test(l) && dateIn(l)) return dateIn(l);
  for (const l of lines) if (/zahlbar\s+ab|zahltag|ex-?tag/i.test(l) && dateIn(l)) return dateIn(l.replace(/^.*?(?=zahlbar|zahltag|ex-?tag)/i, ''));
  return allDates(lines.join('\n'))[0] || null;
}

/**
 * Endbetrag mit Vorzeichen: „Zu Ihren Lasten/Gunsten nach Steuern“ vor „… vor Steuern“ vor „Ausmachender Betrag/Gesamt“ (nur EUR).
 * Steht der Betrag nicht in der Zeile (Tabellenkopf), gilt die nächste Zeile; dort steht meist auch die Valuta.
 */
function findTotal(lines, subtype) {
  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /zu\s+ihren\s+(lasten|gunsten)(?:\s+(nach|vor)\s+steuern)?/i.exec(l);
    if (m) {
      const tail = l.slice(m.index);
      let money = lastMoney(tail, 'EUR'), at = i;
      if (!money && lines[i + 1]) { money = lastMoney(lines[i + 1], 'EUR'); at = i + 1; }
      if (!money) continue;
      const rank = /nach/i.test(m[2] || '') ? 3 : 2;
      const sign = /lasten/i.test(m[1]) ? -1 : 1;
      cands.push({ rank, cents: sign * Math.abs(money.cents), line: at });
      continue;
    }
    if (/^\W*(?:ausmachender\s+betrag|gesamt(?:betrag)?|endbetrag|total|betrag\s+zu\s+ihren)\b/i.test(l)) {
      const money = lastMoney(l, 'EUR');
      if (money && (money.cur === 'EUR' || !/[A-Z]{3}/.test(l.replace(/EUR/g, '')))) {
        const sign = money.cents < 0 ? -1 : subtype === 'kauf' ? -1 : 1;
        cands.push({ rank: 1, cents: sign * Math.abs(money.cents), line: i });
      }
    }
  }
  cands.sort((a, b) => b.rank - a.rank || a.line - b.line);
  return cands[0] || null;
}

function findValuta(lines, total) {
  // Datum in der Betragszeile unter dem Kopf „Valuta | Zu Ihren Lasten …“
  if (total && /valuta/i.test(lines[total.line - 1] || '') && dateIn(lines[total.line])) return dateIn(lines[total.line]);
  for (let i = 0; i < lines.length; i++) {
    if (!/valuta|belastung erfolgt mit|gutschrift erfolgt mit|wertstellung/i.test(lines[i])) continue;
    const d = dateIn(lines[i].replace(/^.*?(?=valuta|belastung|gutschrift|wertstellung)/i, '')) || dateIn(lines[i + 1]);
    if (d) return d;
  }
  return null;
}

/** Zeitraum eines Reportings: „zum 1. Quartal 2025“, „Depotauszug per 31.12.2025“, „vom … bis …“. */
function findPeriod(lines) {
  const text = lines.join('\n');
  const q = /\b([1-4])\.\s*quartal\s+(20\d{2})\b/i.exec(text);
  if (q) {
    const y = Number(q[2]), m = Number(q[1]) * 3;
    return { from: `${y}-${pad2(m - 2)}-01`, to: `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`, label: `Q${q[1]} ${y}` };
  }
  const per = /(?:depotauszug|depotaufstellung|depotbestand|stand|stichtag)\D{0,15}(?:per|zum|vom|am)?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i.exec(text);
  if (per) { const d = parseGermanDate(per[1]); return { from: null, to: d, label: d ? d.split('-').reverse().join('.') : null }; }
  return null;
}

const euro = (cents) => {
  const [i, d] = (Math.abs(cents) / 100).toFixed(2).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} €`;
};

const SUB_TITLES = { kauf: 'Wertpapierkauf', verkauf: 'Wertpapierverkauf', dividende: 'Dividende', kosteninfo: 'Kosteninformation', depotreport: 'Depot-Reporting' };

export function parse(extracted, fileMeta, detection) {
  const lines = getLines(extracted).map(cleanOcr);
  const raw = lines.join('\n');
  const subtype = SECURITY_SUBTYPES.includes(detection?.subtype) ? detection.subtype : securitySubtype(raw);
  const doc = baseDoc(detection, { type: 'wertpapier', subtype });
  const institution = matchFirst(BROKERS, raw) || detection?.institution || null;
  doc.institution = institution; doc.issuer = institution;

  const isin = findIsin(lines);
  const wkn = findWkn(lines, isin);
  const security = findSecurity(lines, isin, wkn);
  const fields = { security, wkn, isin };
  const info = INFO_ONLY.has(subtype);

  if (subtype === 'depotreport') {
    const p = findPeriod(lines);
    doc.periodFrom = p?.from || null; doc.periodTo = p?.to || null;
    doc.date = p?.to || findDate(lines, subtype);
    Object.assign(fields, {
      security: null, wkn: null, isin: null, period: p?.label || null,
      depot: /verm[oö]gensdepot/i.test(raw) ? 'Vermögensdepot' : null, infoOnly: true,
    });
    doc.title = ['Depot-Reporting', p?.label, institution].filter(Boolean).join(' ');
  } else {
    doc.date = findDate(lines, subtype);
    const quantity = findQuantity(lines);
    const price = findPrice(lines);
    const venue = findVenue(lines);
    Object.assign(fields, { quantity, price, venue, orderNo: findOrderNo(lines) });
    if (info) {
      const side = /\bverkauf\s*:/i.test(raw) && !/\bkauf\s*:/i.test(raw) ? 'verkauf' : /\bkauf\s*:/i.test(raw) ? 'kauf' : null;
      Object.assign(fields, { side, infoOnly: true });
      doc.title = [`Kosteninformation ${side === 'verkauf' ? 'Wertpapierverkauf' : 'Wertpapierkauf'}`, security].filter(Boolean).join(' ');
    } else {
      const total = findTotal(lines, subtype);
      if (total) {
        // Vorzeichen folgt der Art: Kauf belastet, Verkauf/Ertrag schreibt gut
        doc.amount = subtype === 'kauf' ? -Math.abs(total.cents) : subtype ? Math.abs(total.cents) : total.cents;
      }
      fields.valuta = findValuta(lines, total);
      fields.marketValue = labeled(lines, /\bkurswert\b/i, { cur: 'EUR' })?.cents ?? null;
      const feeSum = labeled(lines, /summe\s+(?:entgelte|geb[uü]hren|kosten)|(?:^|\s)entgelte\s+gesamt/i, { cur: 'EUR' });
      let fees = feeSum ? Math.abs(feeSum.cents) : null;
      if (fees == null) {
        let s = 0, hit = false;
        for (const l of lines) {
          if (!/provision|entgelt|fremdkosten|b[oö]rsengeb[uü]hr|transaktionsgeb[uü]hr|spesen|maklercourtage|courtage/i.test(l) || /summe|eigene entgelte\s*$/i.test(l)) continue;
          const m = lastMoney(l, 'EUR');
          if (m) { s += Math.abs(m.cents); hit = true; }
        }
        fees = hit ? s : null;
      }
      fields.fees = fees;
      const taxes = labeled(lines, /abgef[uü]hrte\s+steuern|einbehaltene\s+steuern|steuern\s+gesamt/i, { cur: 'EUR' })
        ?? labeled(lines, /kapitalertrags?steuer/i, { cur: 'EUR' });
      fields.taxPaid = taxes && taxes.cents !== 0 ? Math.abs(taxes.cents) : null;

      if (subtype === 'dividende') {
        const gross = labeled(lines, /brutto(?:betrag)?|dividenden-?betrag|aussch[uü]ttung\s+gesamt/i, { not: /pro\s+st/i });
        const wht = labeled(lines, /quellensteuer/i, { not: /anrechenbar|verrechnung|ermittlung/i });
        const fx = /devisenkurs[^\d\n]*?(\d+,\d{2,6})/i.exec(raw);
        const cur = gross?.cur || (/\b(USD|GBP|CHF|CAD|JPY|DKK|SEK|NOK)\b/.exec(raw)?.[1] ?? 'EUR');
        Object.assign(fields, {
          currency: cur, grossForeign: cur !== 'EUR' && gross ? Math.abs(gross.cents) : null,
          gross: cur === 'EUR' && gross ? Math.abs(gross.cents) : null,
          withholdingTax: wht ? Math.abs(wht.cents) : null, fxRate: fx ? num(fx[1]) : null,
          perShare: /([A-Z]{3})\s+(\d+,\d{2,6})\s+(?:dividende|aussch[uü]ttung|ertrag)\s+pro\s+st/i.exec(raw)?.[2] ?? null,
          capitalIncome: true,
        });
        if (fields.perShare) fields.perShare = num(fields.perShare);
      } else {
        fields.currency = 'EUR';
      }
      const name = security || (subtype === 'dividende' ? null : institution);
      doc.title = [SUB_TITLES[subtype] || 'Wertpapierabrechnung', name, doc.amount != null ? euro(doc.amount) : null].filter(Boolean).join(' ');
      if (doc.amount == null) review(doc, 'Endbetrag nicht erkannt');
      if (!subtype) review(doc, 'Art der Wertpapierabrechnung unklar');
    }
  }
  doc.fields = fields;
  if (!doc.date) review(doc, 'Datum nicht erkannt');
  return baseResult(doc);
}
