// camt.052 / camt.053 (ISO 20022) – Versionen .02 bis .08, Namespaces werden entfernt
import { XMLParser } from 'fast-xml-parser';
import { normalizeIban } from '../../util/format.js';
import {
  cleanText, makeTx, buildResult, detection, institutionFromBic, institutionFromIban, institutionFromBlz, detectInstitution,
  normalizeBookingText, kindFromName, KIND_LABEL, accountName, CREDITOR_ID_RE,
} from './common.js';

const ARRAYS = new Set(['Stmt', 'Rpt', 'Ntry', 'NtryDtls', 'TxDtls', 'Bal', 'Ustrd', 'Othr', 'AddtlTxInf', 'Prtry']);
const parser = new XMLParser({
  removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false,
  trimValues: true, isArray: name => ARRAYS.has(name),
});
const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));
const first = v => arr(v)[0];

export function detectCamt(ctx) {
  const src = ctx.raw ?? (ctx.kind === 'xml' ? ctx.text : null);
  if (!src || !/^\s*(<\?xml[^>]*>\s*)?</.test(src.slice(0, 200))) return null;
  const head = src.slice(0, 4000);
  const m = head.match(/camt\.0(52|53)\.001\.(\d\d)/);
  const is53 = /BkToCstmrStmt/.test(src.slice(0, 20000)), is52 = /BkToCstmrAcctRpt/.test(src.slice(0, 20000));
  if (!m && !is53 && !is52) return null;
  const which = m ? m[1] : is52 ? '52' : '53';
  const signals = [m ? `Namespace camt.0${m[1]}.001.${m[2]}` : 'Wurzelelement BkToCstmr…'];
  const bic = (src.match(/<(?:\w+:)?BIC>([A-Z0-9]{8,11})</) || [])[1] || (src.match(/<(?:\w+:)?BICFI>([A-Z0-9]{8,11})</) || [])[1];
  const iban = (src.match(/<(?:\w+:)?IBAN>([A-Z0-9]{15,34})</) || [])[1];
  const inst = institutionFromBic(bic) || institutionFromIban(iban) || null;
  return detection('kontoauszug', which === '52' ? 'camt052' : 'camt053', inst, 0.97, signals);
}

const amt = n => {
  if (n == null) return null;
  const v = Number(txt(n));
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};
const signed = (n, ind) => { const v = amt(n); return v == null ? null : ind === 'DBIT' ? -Math.abs(v) : Math.abs(v); };
const isoOf = d => { const s = txt(d?.Dt ?? d?.DtTm ?? d); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const partyName = p => (p ? cleanText(txt(p.Nm ?? p.Pty?.Nm)) : '');
const idOf = acct => {
  const id = acct?.Id;
  if (!id) return null;
  return txt(id.IBAN) || txt(first(id.Othr)?.Id) || null;
};

const SUBFAMILY = { ESDD: 'Lastschrift', BBDD: 'Lastschrift', PMDD: 'Lastschrift', UPDD: 'Rücklastschrift', DMCT: 'Überweisung', STDO: 'Dauerauftrag', POSD: 'Kartenzahlung', POSC: 'Kartenzahlung', CWDL: 'Bargeld', ATMW: 'Bargeld', SALA: 'Gehalt/Lohn', INTR: 'Zinsen', CHRG: 'Gebühr', COMM: 'Gebühr', FEES: 'Gebühr', ESCT: null, DDRD: 'Lastschrift' };
function bookingTextOf(ntry, tx, ind, addtl) {
  const fromAddtl = normalizeBookingText(addtl);
  if (fromAddtl) return fromAddtl;
  const fam = ntry.BkTxCd?.Domn?.Fmly;
  const sub = txt(fam?.SubFmlyCd);
  const famCd = txt(fam?.Cd);
  if (SUBFAMILY[sub]) return SUBFAMILY[sub];
  if (famCd === 'CCRD') return 'Kartenzahlung';
  if (famCd === 'ICDT' || (famCd === 'RCDT') || sub === 'ESCT') return ind === 'CRDT' ? 'Gutschrift' : 'Überweisung';
  if (famCd === 'IDDT' || famCd === 'RDDT') return 'Lastschrift';
  return cleanText(addtl) || null;
}
function gvcOf(ntry) {
  const p = txt(first(ntry.BkTxCd?.Prtry)?.Cd ?? ntry.BkTxCd?.Prtry?.Cd);
  if (!p) return null;
  const parts = p.split('+');
  return /^\d{3}$/.test(parts[1] || '') ? parts[1] : /^\d{3}$/.test(parts[0]) ? parts[0] : null;
}

function txFromEntry(ntry, details, many, srcStmtCcy) {
  const ind = txt(ntry.CdtDbtInd);
  const entryAmt = signed(ntry.Amt, ind);
  let amount = entryAmt, currency = ntry.Amt?.['@_Ccy'] || srcStmtCcy || 'EUR';
  if (many && details?.AmtDtls?.TxAmt?.Amt) amount = signed(details.AmtDtls.TxAmt.Amt, ind);
  if (amount == null) return null;

  const rp = details?.RltdPties || {};
  const credit = ind === 'CRDT';
  const other = credit ? rp.Dbtr : rp.Cdtr;
  const otherAcct = credit ? rp.DbtrAcct : rp.CdtrAcct;
  const ultimate = credit ? rp.UltmtDbtr : rp.UltmtCdtr;
  const name = partyName(other) || partyName(ultimate);
  const ustrd = arr(details?.RmtInf?.Ustrd).map(txt).map(cleanText).filter(Boolean).join(' ');
  const strd = arr(details?.RmtInf?.Strd).map(s => txt(s?.CdtrRefInf?.Ref)).filter(Boolean).join(' ');
  const addtlTx = arr(details?.AddtlTxInf).map(txt).join(' ');
  const addtlNtry = txt(ntry.AddtlNtryInf);
  const refs = details?.Refs || {};
  const cdtrId = txt(first(rp.Cdtr?.Id?.PrvtId?.Othr)?.Id) || txt(first(rp.Cdtr?.Pty?.Id?.PrvtId?.Othr)?.Id)
    || txt(first(details?.CdtrSchmeId?.Id?.PrvtId?.Othr)?.Id) || (addtlTx.match(CREDITOR_ID_RE) || [])[0] || null;

  const e2e = txt(refs.EndToEndId);
  const t = makeTx({
    bookingDate: isoOf(ntry.BookgDt) || isoOf(ntry.ValDt), valueDate: isoOf(ntry.ValDt), amount, currency,
    counterpartyRaw: name, counterpartyIban: idOf(otherAcct),
    purpose: ustrd || strd || cleanText(addtlTx.replace(CREDITOR_ID_RE, '').replace(/Gl(?:ä|ae)ubiger-?ID\s*/i, '')) || '',
    bookingText: null, endToEndId: /^NOTPROVIDED$/i.test(e2e) ? null : e2e || null, mandateId: txt(refs.MndtId) || null,
    creditorId: cdtrId, gvc: gvcOf(ntry), info: addtlTx,
  });
  t.bookingText = bookingTextOf(ntry, t, ind, addtlNtry);
  if (!t.bookingDate) return null;
  return t;
}

function parseStmt(stmt, root, bicFallback, fileName) {
  const acct = stmt.Acct || {};
  const iban = normalizeIban(txt(acct.Id?.IBAN)) || null;
  const otherId = txt(first(acct.Id?.Othr)?.Id) || null;
  const ccy = txt(acct.Ccy) || 'EUR';
  const bic = txt(acct.Svcr?.FinInstnId?.BIC ?? acct.Svcr?.FinInstnId?.BICFI) || bicFallback;
  const svcrName = cleanText(txt(acct.Svcr?.FinInstnId?.Nm));
  const institution = institutionFromBic(bic) || institutionFromIban(iban) || detectInstitution(svcrName) || svcrName || null;
  const prod = cleanText(txt(acct.Nm));
  const kind = kindFromName(/giro|tagesgeld|extra|spar|visa|kredit|depot/i.test(prod) ? prod : 'Girokonto');
  const account = { kind, institution, name: accountName(institution, /giro|tagesgeld|extra|spar|visa|kredit|depot/i.test(prod) ? prod : KIND_LABEL[kind]), iban, currency: ccy, number: iban ? null : otherId };

  let opening = null, closing = null, openingDate = null, closingDate = null;
  for (const b of arr(stmt.Bal)) {
    const cd = txt(b.Tp?.CdOrPrtry?.Cd);
    const v = signed(b.Amt, txt(b.CdtDbtInd));
    const d = isoOf(b.Dt);
    if ((cd === 'OPBD' || cd === 'PRCD') && opening == null) { opening = v; openingDate = d; }
    if (cd === 'CLBD' && closing == null) { closing = v; closingDate = d; }
  }
  if (closing == null) for (const b of arr(stmt.Bal)) {
    const cd = txt(b.Tp?.CdOrPrtry?.Cd);
    if (['ITBD', 'CLAV', 'ITAV'].includes(cd)) { closing = signed(b.Amt, txt(b.CdtDbtInd)); closingDate = isoOf(b.Dt); break; }
  }

  const transactions = [];
  let skipped = 0;
  for (const ntry of arr(stmt.Ntry)) {
    const sts = txt(ntry.Sts?.Cd ?? ntry.Sts);
    if (sts && !/^BOOK$/i.test(sts)) { skipped++; continue; }
    const dets = arr(ntry.NtryDtls).flatMap(nd => arr(nd.TxDtls));
    const many = dets.length > 1 && dets.every(d => d.AmtDtls?.TxAmt?.Amt);
    const splitSum = many ? dets.reduce((a, d) => a + Math.abs(amt(d.AmtDtls.TxAmt.Amt) || 0), 0) : 0;
    if (many && splitSum === Math.abs(amt(ntry.Amt))) for (const d of dets) { const t = txFromEntry(ntry, d, true, ccy); if (t) transactions.push(t); }
    else { const t = txFromEntry(ntry, dets[0], false, ccy); if (t) transactions.push(t); }
  }

  const fr = txt(stmt.FrToDt?.FrDtTm), to = txt(stmt.FrToDt?.ToDtTm);
  const periodFrom = fr ? fr.slice(0, 10) : openingDate;
  const periodTo = to ? to.slice(0, 10) : closingDate;
  return buildResult({
    type: 'kontoauszug', format: root === 'BkToCstmrAcctRpt' ? 'camt052' : 'camt053', institution, account, transactions,
    opening, closing, openingDate: openingDate || periodFrom, closingDate: closingDate || periodTo, periodFrom, periodTo,
    style: 'auszug', confidence: 0.97, fields: { statementId: txt(stmt.Id) || null, skippedNotBooked: skipped },
  });
}

/** → Array von ParseResults (ein Auszug/Report je Stmt/Rpt) */
export function parseCamt(det, ctx) {
  const xml = ctx.raw ?? ctx.text;
  const doc = parser.parse(xml);
  const d = doc.Document || doc;
  const root = d.BkToCstmrStmt ? 'BkToCstmrStmt' : d.BkToCstmrAcctRpt ? 'BkToCstmrAcctRpt' : Object.keys(d).find(k => /^BkToCstmr/.test(k));
  if (!root) throw new Error('camt: kein BkToCstmr…-Element gefunden');
  const body = d[root];
  const stmts = [...arr(body.Stmt), ...arr(body.Rpt)];
  const bic = txt(body.GrpHdr?.MsgRcpt?.Id?.OrgId?.AnyBIC) || null;
  return stmts.map(s => parseStmt(s, root, bic));
}
