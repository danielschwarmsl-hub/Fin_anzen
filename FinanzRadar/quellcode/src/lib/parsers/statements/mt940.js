// SWIFT MT940 (.sta/.mt940/.txt) inkl. deutscher :86:-Struktur (?00 ?20-?29 ?30-?34 ?60-?63)
import { normalizeIban } from '../../util/format.js';
import {
  cleanText, makeTx, buildResult, detection, institutionFromBlz, institutionFromIban, normalizeBookingText, accountName, KIND_LABEL,
  parseSepaTokens,
} from './common.js';

export function detectMt940(ctx) {
  const t = ctx.raw ?? ctx.text;
  if (!t || /^\s*<\?xml/.test(t)) return null;
  const head = t.slice(0, 20000);
  if (!/(^|\n):20:/.test(head) || !/(^|\n):25:/.test(head) || !/(^|\n):60[FM]:/.test(head) || !/(^|\n):61:/.test(head)) return null;
  const acct = (head.match(/(?:^|\n):25:([^\n]+)/) || [])[1]?.trim() || '';
  const inst = /^[A-Z]{2}\d{2}/.test(acct) ? institutionFromIban(acct.replace(/\s/g, '')) : institutionFromBlz(acct.split('/')[0]);
  return detection('kontoauszug', 'mt940', inst, 0.93, [':20: :25: :60F: :61: :86: vorhanden']);
}

/** Tags in Blöcke: [{ tag, value }] – Folgezeilen gehören zum vorherigen Tag */
function tokenize(text) {
  const out = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) out.push({ tag: m[1], value: m[2] });
    else if (line.startsWith('-}') || line.startsWith('{') || line === '-' || line.startsWith('}')) continue;
    else if (out.length) out[out.length - 1].value += '\n' + line;
  }
  return out;
}

function mtDate(yymmdd) {
  const yy = +yymmdd.slice(0, 2);
  return `${yy > 70 ? 1900 + yy : 2000 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}
function mtAmount(s) { return Math.round(Number(String(s).replace(',', '.')) * 100); }
function balance(value) { // C/D YYMMDD CUR amount
  const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(value.trim());
  if (!m) return null;
  return { value: (m[1] === 'D' ? -1 : 1) * mtAmount(m[4]), date: mtDate(m[2]), currency: m[3] };
}

/** :61: → { bookingDate, valueDate, amount, typeCode, ref, bankRef, supplementary } */
function parse61(value) {
  const lines = value.split('\n');
  const l1 = lines[0];
  const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+(?:,\d*)?)([A-Z][A-Z0-9]{3})(.*)$/.exec(l1);
  if (!m) return null;
  const valueDate = mtDate(m[1]);
  let bookingDate = valueDate;
  if (m[2]) {
    let y = +valueDate.slice(0, 4);
    const vm = +valueDate.slice(5, 7), bm = +m[2].slice(0, 2);
    if (bm - vm > 6) y -= 1; else if (vm - bm > 6) y += 1;
    bookingDate = `${y}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
  }
  const mark = m[3];
  const sign = mark === 'C' || mark === 'RD' ? 1 : -1;
  const [ref, bankRef] = m[7].split('//');
  return { bookingDate, valueDate, amount: sign * mtAmount(m[5]), typeCode: m[6], ref: cleanText(ref), bankRef: cleanText(bankRef || ''), supplementary: lines.slice(1).join(' ') };
}

/** :86: → { gvc, text, primanota, purpose, blz, account, name, tail } */
export function parse86(value) {
  const flat = value.replace(/\n/g, '');
  if (/^\d{3}\?\d{2}/.test(flat) || /\?00/.test(flat)) {
    const gvc = /^(\d{3})/.exec(flat)?.[1] || null;
    const subs = {};
    const re = /\?(\d{2})/g;
    const marks = [];
    let m;
    while ((m = re.exec(flat))) marks.push({ k: m[1], start: m.index, end: m.index + 3 });
    marks.forEach((mk, i) => { subs[mk.k] = (subs[mk.k] || '') + flat.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : flat.length); });
    const purposeKeys = [...Array(10).keys()].map(i => '2' + i).concat(['60', '61', '62', '63']);
    const parts = purposeKeys.map(k => subs[k]).filter(v => v != null);
    const sepa = parts.some(p => /(EREF|SVWZ|MREF|KREF|CRED|ABWA)\+/.test(p)) || /(EREF|SVWZ|MREF)\+/.test(parts.join(''));
    const purpose = sepa ? parts.join('') : parts.map(cleanText).join(' ');
    return {
      gvc, text: cleanText(subs['00'] || ''), primanota: subs['10'] || null, purpose: cleanText(purpose).replace(/\s*(EREF|KREF|MREF|CRED|SVWZ|ABWA|IBAN|BIC)\+/g, ' $1+').trim(),
      blz: cleanText(subs['30'] || ''), account: cleanText(subs['31'] || ''), name: cleanText((subs['32'] || '') + (subs['33'] || '')), tail: subs['34'] || null,
    };
  }
  return { gvc: null, text: '', primanota: null, purpose: cleanText(flat), blz: '', account: '', name: '', tail: null };
}

const GVC_TEXT = { '051': 'Gutschrift', '052': 'Gutschrift', '053': 'Gehalt/Lohn', '104': 'Lastschrift', '105': 'Lastschrift', '106': 'Lastschrift', '116': 'Überweisung', '166': 'Überweisung', '117': 'Dauerauftrag', '177': 'Dauerauftrag' };

export function parseMt940(det, ctx) {
  const text = ctx.raw ?? ctx.text;
  const toks = tokenize(text);
  // Auszüge nach :20: aufteilen
  const stmts = [];
  let cur = null;
  for (const t of toks) {
    if (t.tag === '20') { cur = { tags: [] }; stmts.push(cur); }
    if (cur) cur.tags.push(t);
  }
  // nach Konto (:25:) gruppieren: mehrere Seiten desselben Kontos zusammenfassen
  const groups = new Map();
  for (const s of stmts) {
    const acc = s.tags.find(t => t.tag === '25')?.value.trim() || '';
    if (!groups.has(acc)) groups.set(acc, []);
    groups.get(acc).push(s);
  }
  const results = [];
  for (const [acc, list] of groups) {
    const isIban = /^[A-Z]{2}\d{2}[A-Z0-9]{10,}/.test(acc.replace(/\s/g, ''));
    const iban = isIban ? normalizeIban(acc.split('/')[0]) : null;
    const number = isIban ? null : acc;
    const institution = isIban ? institutionFromIban(iban) : institutionFromBlz(acc.split('/')[0]);
    let opening = null, openingDate = null, closing = null, closingDate = null, currency = 'EUR';
    const transactions = [];
    for (const s of list) {
      let last = null;
      for (const t of s.tags) {
        if (t.tag === '60F' || t.tag === '60M') {
          const b = balance(t.value);
          if (b && opening == null) { opening = b.value; openingDate = b.date; currency = b.currency; }
        } else if (t.tag === '62F' || t.tag === '62M') {
          const b = balance(t.value);
          if (b) { closing = b.value; closingDate = b.date; }
        } else if (t.tag === '61') {
          const p = parse61(t.value);
          if (p) { last = p; transactions.push({ p, d: null }); }
        } else if (t.tag === '86' && last) {
          transactions[transactions.length - 1].d = parse86(t.value);
        }
      }
    }
    const txs = transactions.map(({ p, d }) => {
      const dd = d || {};
      const purposeSrc = dd.purpose ?? '';
      const tk = parseSepaTokens(purposeSrc);
      const ibanM = (dd.account || '').replace(/\s/g, '');
      const cpIban = /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/.test(ibanM) ? ibanM : tk.iban && /^[A-Z]{2}\d{2}/.test(tk.iban) ? tk.iban : null;
      const bt = normalizeBookingText(dd.text) || GVC_TEXT[dd.gvc] || (dd.text || null) || (p.amount > 0 ? 'Gutschrift' : null);
      return makeTx({
        bookingDate: p.bookingDate, valueDate: p.valueDate, amount: p.amount, currency,
        counterpartyRaw: dd.name || '', counterpartyIban: cpIban, purpose: purposeSrc, bookingText: bt, gvc: dd.gvc,
        endToEndId: !p.ref || /^(NONREF|NOTPROVIDED)$/i.test(p.ref) ? null : p.ref,
        info: p.supplementary,
      });
    });
    const account = { kind: 'giro', institution, name: accountName(institution, KIND_LABEL.giro), iban, currency, number };
    results.push(buildResult({
      type: 'kontoauszug', format: 'mt940', institution, account, transactions: txs, opening, closing, openingDate, closingDate,
      style: 'auszug', confidence: 0.9, fields: { statements: list.length },
    }));
  }
  return results;
}
