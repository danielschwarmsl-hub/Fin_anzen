// Belege (Rechnung/Kassenbon) ↔ Buchungen zuordnen.
// matchReceipts(documents, txs) → [{ docId, txId, score }]  (eins-zu-eins, gierig nach Punktzahl)
import { fold } from '../classify/merchants.de.js';

const DOC_TYPES = new Set(['rechnung', 'kassenbon']);
const STOP = new Set(['gmbh', 'markt', 'filiale', 'rechnung', 'kasse', 'europe', 'sarl', 'and', 'der', 'die', 'das', 'und', 'mit', 'kartenzahlung', 'visa', 'debitkarte', 'lastschrift', 'ueberweisung', 'kaufumsatz', 'bestellung', 'abo', 'online', 'service', 'deutschland', 'germany', 'shop', 'store']);

const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);
const tokens = (s) => fold(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

function nameSimilarity(docTokens, txTokens, txText) {
  if (!docTokens.length || !txTokens.length) return 0;
  let hit = 0;
  for (const d of docTokens) {
    if (d.length >= 4 && (txText.includes(d) || txTokens.some(t => t.length >= 4 && (d.startsWith(t) || t.startsWith(d))))) hit++;
  }
  return Math.min(1, hit / Math.min(docTokens.length, 2));
}

export function matchReceipts(documents, txs) {
  const docs = (documents || []).filter(d => DOC_TYPES.has(d.type) && d.amount > 0 && d.date);
  if (!docs.length) return [];

  // Buchungen nach Betrag (Betrag in Cent, Abflüsse) indexieren
  const byAmount = new Map();
  const taken = new Set();
  for (const t of txs) {
    if (t.receiptDocId && t.receiptSource === 'user') { taken.add(t.id); continue; }
    if (!t.bookingDate || !(t.amount < 0) || t.isTransfer) continue;
    const k = -t.amount;
    let l = byAmount.get(k);
    if (!l) byAmount.set(k, l = []);
    l.push({ t, day: dayNum(t.bookingDate), text: fold(`${t.counterparty || ''} ${t.counterpartyRaw || ''} ${t.purpose || ''}`), cp: tokens(`${t.counterparty || ''} ${t.counterpartyRaw || ''}`) });
  }
  const userDocs = new Set(txs.filter(t => t.receiptDocId && t.receiptSource === 'user').map(t => t.receiptDocId));

  const cands = [];
  for (const d of docs) {
    if (userDocs.has(d.id)) continue;
    const dday = dayNum(d.date);
    const invNo = fold(d.fields?.invoiceNumber || '');
    const dtok = tokens(`${d.issuer || ''} ${d.institution || ''}`);
    for (const amt of [d.amount - 1, d.amount, d.amount + 1]) {
      for (const c of byAmount.get(amt) || []) {
        const diff = c.day - dday; // Buchung nach Beleg = positiv
        const invoiceHit = invNo.length >= 5 && c.text.includes(invNo);
        if (!invoiceHit && (diff < -2 || diff > 10)) continue;
        if (invoiceHit && (diff < -5 || diff > 120)) continue;
        let score = 50 + Math.max(0, 30 - Math.abs(diff) * 2);
        const sim = nameSimilarity(dtok, c.cp, c.text);
        score += 40 * sim;
        if (invoiceHit) score += 60;
        if (Math.abs(c.t.amount) !== d.amount) score -= 5;
        const weak = sim === 0 && !invoiceHit; // nur Betrag + Datum passen
        if (weak) score -= 20;
        cands.push({ docId: d.id, txId: c.t.id, score: Math.round(score * 10) / 10, weak });
      }
    }
  }
  // Schwache Treffer (ohne Namensbezug) nur, wenn sie für den Beleg eindeutig sind
  const perDoc = new Map();
  for (const c of cands) perDoc.set(c.docId, (perDoc.get(c.docId) || 0) + 1);
  const perTx = new Map();
  for (const c of cands) perTx.set(c.txId, (perTx.get(c.txId) || 0) + 1);
  const kept = cands.filter(c => !c.weak || (perDoc.get(c.docId) === 1 && perTx.get(c.txId) === 1));
  cands.length = 0; cands.push(...kept.map(({ weak, ...c }) => c));
  cands.sort((a, b) => b.score - a.score);
  const usedDoc = new Set(), usedTx = new Set(taken);
  const out = [];
  for (const c of cands) {
    if (usedDoc.has(c.docId) || usedTx.has(c.txId)) continue;
    usedDoc.add(c.docId); usedTx.add(c.txId);
    out.push(c);
  }
  return out;
}
