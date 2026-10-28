// Belege (Rechnung/Kassenbon) ↔ Buchungen zuordnen.
// planReceipts(documents, txs) → { links: [{ docId, docIds, txId, score, margin, level, reason }], suggestions: [{ docId, txId, score, reason }] }
//   level 'sure' = still übernehmen, 'check' = übernehmen und in die Prüfliste; suggestions = nur Vorschlag ohne Verknüpfung
// matchReceipts(documents, txs) → links (Kompatibilität)
// applyReceipts(txs, documents, lineItems) → txs mit receiptDocId/receiptDocIds/receiptSource/receiptScore, checks (receipt/split), splitSuggestion
import { fold, findMerchant } from '../classify/merchants.de.js';

const DOC_TYPES = new Set(['rechnung', 'kassenbon']);
const STOP = new Set(['gmbh', 'markt', 'filiale', 'rechnung', 'kasse', 'europe', 'sarl', 'and', 'der', 'die', 'das', 'und', 'mit', 'kartenzahlung', 'visa', 'debitkarte', 'lastschrift', 'ueberweisung', 'kaufumsatz', 'bestellung', 'abo', 'online', 'service', 'deutschland', 'germany', 'shop', 'store']);
const SURE_SCORE = 85;   // darunter: übernehmen, aber prüfen lassen
const SURE_MARGIN = 15;  // Abstand zum Zweitbesten, ab dem ein Treffer eindeutig ist
const MAX_GROUP = 6;     // Sammelbuchung: höchstens so viele Belege
const MAX_POOL = 12;     // … aus den zeitlich nächsten Belegen
const MAX_EXACT = 8;     // Konfliktgruppen bis zu dieser Größe werden exakt gelöst, größere gierig

const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);
const tokens = (s) => fold(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const has = (text, ref) => ` ${text} `.includes(` ${ref} `);

function nameSimilarity(docTokens, txTokens, txText) {
  if (!docTokens.length || !txTokens.length) return 0;
  let hit = 0;
  for (const d of docTokens) {
    if (d.length >= 4 && (txText.includes(d) || txTokens.some(t => t.length >= 4 && (d.startsWith(t) || t.startsWith(d))))) hit++;
  }
  return Math.min(1, hit / Math.min(docTokens.length, 2));
}

// ---------------------------------------------------------------- Referenzen
const ref = (s) => { const f = fold(s); return f.length >= 5 && /\d/.test(f) ? f : null; };
const ORDER_RE = /(?:bestell(?:ung)?(?:nummer|-?nr\.?)|auftrags(?:nummer|-?nr\.?)|order(?:\s*(?:id|no\.?|number|nummer|#))?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/]{4,})/gi;
const AMAZON_RE = /\b\d{3}-\d{7}-\d{7}\b/g;
const TXCODE_RE = /transaktions(?:code|nummer|-?id)\s*[:.]?\s*([A-Z0-9]{8,20})/gi;
const CUSTOMER_RE = /(?:kunden|vertrags|mitglieds)(?:nummer|-?nr\.?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{3,})/gi;

/**
 * Eindeutige Referenzen eines Belegs: strong = Rechnungs-/Bestellnummer, Transaktionscode (nur dieser Beleg);
 * weak = Kunden-/Vertragsnummer (gilt für alle Belege desselben Anbieters, daher nur Namens-Ersatz).
 */
export function docRefs(d) {
  const f = d.fields || {};
  const text = String(d.text || '').slice(0, 20000);
  const strong = new Set(), weak = new Set();
  const add = (set, v) => { const r = ref(v); if (r) set.add(r); };
  add(strong, f.invoiceNumber); add(strong, f.orderNumber); add(strong, f.orderId); add(strong, f.transactionId);
  for (const m of `${d.title || ''}\n${text}`.matchAll(AMAZON_RE)) add(strong, m[0]);
  for (const m of text.matchAll(ORDER_RE)) if (/\d/.test(m[1])) add(strong, m[1]);
  for (const m of text.matchAll(TXCODE_RE)) if (/\d/.test(m[1])) add(strong, m[1]);
  add(weak, f.customerNumber); add(weak, f.contractNumber);
  for (const m of text.matchAll(CUSTOMER_RE)) if (/\d/.test(m[1])) add(weak, m[1]);
  for (const r of strong) weak.delete(r);
  return { strong: [...strong], weak: [...weak] };
}

/** Welche Buchungen kommen als „zählendes Glied“ in Frage: Abflüsse ohne Umbuchungen (bei PayPal also die PayPal-Zeile, nicht der Bankeinzug) */
const eligible = (t) => t.bookingDate && t.amount < 0 && !t.isTransfer && t.category !== 'umbuchung';
const lockedLink = (t) => t.receiptSource === 'user' && !!t.receiptDocId;
/** Nutzer hat an dieser Buchung schon einen Beleg gelöst → neue Auto-Links nie still übernehmen */
const touchedByUser = (t) => !!t && (t.receiptSource === 'user' || t.receiptRejected?.length > 0);
const txDocIds = (t) => (t.receiptDocIds?.length ? t.receiptDocIds : t.receiptDocId ? [t.receiptDocId] : []);

function prepTx(t) {
  const cpText = fold(`${t.counterparty || ''} ${t.counterpartyRaw || ''}`);
  return {
    t, day: dayNum(t.bookingDate),
    text: fold(`${t.counterparty || ''} ${t.counterpartyRaw || ''} ${t.purpose || ''} ${t.bookingText || ''} ${t.endToEndId || ''}`),
    cp: tokens(cpText),
    intermediary: !!findMerchant(cpText, '')?.intermediary,
    rejected: new Set(t.receiptRejected || []),
  };
}
function prepDoc(d) {
  const name = `${d.issuer || ''} ${d.institution || ''}`;
  return { d, day: dayNum(d.date), tok: tokens(name), intermediary: !!findMerchant(fold(name), '')?.intermediary, ...docRefs(d) };
}

/** Punktzahl Beleg ↔ Buchung (ohne Betragsprüfung) oder null, wenn das Zeitfenster nicht passt */
function scorePair(pd, c, { amountExact = true } = {}) {
  const diff = c.day - pd.day; // Buchung nach Beleg = positiv
  const strongHit = pd.strong.some(r => has(c.text, r));
  if (!strongHit && (diff < -2 || diff > 10)) return null;
  if (strongHit && (diff < -5 || diff > 120)) return null;
  const weakHit = !strongHit && pd.weak.some(r => has(c.text, r));
  const sim = nameSimilarity(pd.tok, c.cp, c.text);
  let score = 50 + Math.max(0, 30 - Math.abs(diff) * 2) + 40 * sim;
  if (strongHit) score += 60;
  if (weakHit) score += 25;
  if (!amountExact) score -= 5;
  // Zahlungskette: Bankeinzug eines Zahlungsdienstes (PayPal, Klarna …) ist nur Durchreiche – das Händler-Glied gewinnt
  if (c.intermediary && !pd.intermediary) score -= 10;
  const weak = sim === 0 && !strongHit && !weakHit; // nur Betrag + Datum passen
  if (weak) score -= 20;
  return { score: Math.round(score * 10) / 10, weak, strongHit, sim, diff };
}

/** Maximale Zuordnung (Summe der Punkte) einer kleinen Konfliktgruppe; deterministisch (Reihenfolge der Kanten) */
function bestMatching(edges) {
  const docs = [...new Set(edges.map(e => e.docId))];
  const byDoc = new Map(docs.map(id => [id, edges.filter(e => e.docId === id)]));
  let best = { total: -1, n: 0, pick: [] };
  const usedTx = new Set(), pick = [];
  const walk = (i, total) => {
    if (i === docs.length) {
      if (total > best.total + 1e-9 || (Math.abs(total - best.total) < 1e-9 && pick.length > best.n)) best = { total, n: pick.length, pick: [...pick] };
      return;
    }
    for (const e of byDoc.get(docs[i])) {
      if (usedTx.has(e.txId)) continue;
      usedTx.add(e.txId); pick.push(e);
      walk(i + 1, total + e.score);
      usedTx.delete(e.txId); pick.pop();
    }
    walk(i + 1, total);
  };
  walk(0, 0);
  return best.pick;
}

/** Globale Konfliktlösung: Zusammenhangskomponenten (Belege ↔ Buchungen); kleine exakt, große gierig nach Punktzahl */
function assign(cands) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const node = (x) => { if (!parent.has(x)) parent.set(x, x); return x; };
  for (const c of cands) { const a = find(node('d:' + c.docId)), b = find(node('t:' + c.txId)); if (a !== b) parent.set(a, b); }
  const comps = new Map();
  for (const c of cands) { const k = find('d:' + c.docId); if (!comps.has(k)) comps.set(k, []); comps.get(k).push(c); }
  const out = [];
  for (const edges of comps.values()) {
    edges.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId) || a.txId.localeCompare(b.txId));
    const nDocs = new Set(edges.map(e => e.docId)).size, nTx = new Set(edges.map(e => e.txId)).size;
    if (edges.length === 1) { out.push(edges[0]); continue; }
    if (Math.min(nDocs, nTx) <= MAX_EXACT && edges.length <= 40) { out.push(...bestMatching(edges)); continue; }
    const ud = new Set(), ut = new Set();
    for (const e of edges) { if (ud.has(e.docId) || ut.has(e.txId)) continue; ud.add(e.docId); ut.add(e.txId); out.push(e); }
  }
  return out;
}

/** Teilsummensuche: alle Kombinationen (2…MAX_GROUP) aus pool mit Summe target ±1; bricht bei limit Lösungen ab */
function subsetSums(pool, target, limit = 2) {
  const items = [...pool].sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
  const sols = [], pick = [];
  const walk = (i, sum) => {
    if (sols.length >= limit) return;
    if (pick.length >= 2 && Math.abs(sum - target) <= 1) { sols.push([...pick]); return; }
    if (pick.length >= MAX_GROUP || i >= items.length || sum > target + 1) return;
    for (let j = i; j < items.length && sols.length < limit; j++) {
      if (sum + items[j].amount > target + 1) continue;
      pick.push(items[j]); walk(j + 1, sum + items[j].amount); pick.pop();
    }
  };
  walk(0, 0);
  return sols;
}

export function planReceipts(documents, txs) {
  const docs = (documents || []).filter(d => DOC_TYPES.has(d.type) && d.amount > 0 && d.date);
  if (!docs.length) return { links: [], suggestions: [] };

  // Vom Nutzer bestätigte Verknüpfungen sind gesperrt (Buchung und Beleg)
  const userDocs = new Set();
  for (const t of txs) if (lockedLink(t)) for (const id of txDocIds(t)) userDocs.add(id);
  const pool = txs.filter(t => eligible(t) && !lockedLink(t)).map(prepTx);
  const byAmount = new Map();
  for (const c of pool) { const k = -c.t.amount; if (!byAmount.has(k)) byAmount.set(k, []); byAmount.get(k).push(c); }
  const pdocs = docs.filter(d => !userDocs.has(d.id)).map(prepDoc);

  // 1. Kandidaten 1:1 (Betrag ±1 Cent)
  const cands = [];
  for (const pd of pdocs) {
    for (const amt of [pd.d.amount - 1, pd.d.amount, pd.d.amount + 1]) {
      for (const c of byAmount.get(amt) || []) {
        if (c.rejected.has(pd.d.id)) continue;
        const s = scorePair(pd, c, { amountExact: amt === pd.d.amount });
        if (s) cands.push({ docId: pd.d.id, txId: c.t.id, ...s });
      }
    }
  }
  // Schwache Treffer (ohne Namens-/Referenzbezug) nur, wenn sie für Beleg und Buchung eindeutig sind – sonst bloß Vorschlag
  const perDoc = new Map(), perTx = new Map();
  for (const c of cands) { perDoc.set(c.docId, (perDoc.get(c.docId) || 0) + 1); perTx.set(c.txId, (perTx.get(c.txId) || 0) + 1); }
  const kept = cands.filter(c => !c.weak || (perDoc.get(c.docId) === 1 && perTx.get(c.txId) === 1));
  const keptSet = new Set(kept);
  const weakAmbiguous = cands.filter(c => !keptSet.has(c));
  const candsByDoc = new Map(), candsByTx = new Map();
  for (const c of cands) {
    if (!candsByDoc.has(c.docId)) candsByDoc.set(c.docId, []);
    if (!candsByTx.has(c.txId)) candsByTx.set(c.txId, []);
    candsByDoc.get(c.docId).push(c); candsByTx.get(c.txId).push(c);
  }

  // 2. Globale Zuordnung + Unsicherheit (Abstand zum Zweitbesten über alle Kandidaten von Beleg und Buchung)
  const txById = new Map(pool.map(c => [c.t.id, c]));
  const links = [];
  for (const c of assign(kept)) {
    let second = -Infinity;
    for (const o of [...candsByDoc.get(c.docId), ...candsByTx.get(c.txId)]) if (o !== c) second = Math.max(second, o.score);
    const margin = second === -Infinity ? null : Math.round((c.score - second) * 10) / 10;
    const prevUser = touchedByUser(txById.get(c.txId)?.t);
    let level = 'sure', reason = null;
    if (c.strongHit) level = 'sure';
    else if (c.weak) { level = 'check'; reason = 'Beleg passt nur über Betrag und Datum'; }
    else if (margin != null && margin < SURE_MARGIN) { level = 'check'; reason = 'Knapper Treffer – ein anderer Beleg oder eine andere Buchung passt fast genauso'; }
    else if (c.score < SURE_SCORE) { level = 'check'; reason = 'Unsicherer Belegtreffer (Name nur teilweise, Datum weiter entfernt)'; }
    if (prevUser) { level = 'check'; reason = 'Neuer Beleg vorgeschlagen, nachdem du die Verknüpfung gelöst hast'; }
    links.push({ docId: c.docId, docIds: [c.docId], txId: c.txId, score: c.score, margin, level, reason });
  }
  const usedDoc = new Set(links.map(l => l.docId)), usedTx = new Set(links.map(l => l.txId));

  // 3. n:1 Sammelbuchung: mehrere Belege desselben Händlers ergeben zusammen den Buchungsbetrag
  const freeDocs = pdocs.filter(pd => !usedDoc.has(pd.d.id));
  if (freeDocs.length >= 2) {
    for (const c of [...pool].sort((a, b) => a.day - b.day || a.t.id.localeCompare(b.t.id))) {
      if (usedTx.has(c.t.id)) continue;
      const target = -c.t.amount;
      const near = [];
      for (const pd of freeDocs) {
        if (usedDoc.has(pd.d.id) || c.rejected.has(pd.d.id) || pd.d.amount >= target) continue;
        const s = scorePair(pd, c);
        if (!s || (s.sim === 0 && !s.strongHit)) continue; // nur derselbe Händler (Name) oder gemeinsame Bestellnummer
        near.push({ pd, s });
      }
      if (near.length < 2) continue;
      near.sort((a, b) => Math.abs(a.s.diff) - Math.abs(b.s.diff) || a.pd.d.id.localeCompare(b.pd.d.id));
      const sols = subsetSums(near.slice(0, MAX_POOL).map(n => ({ id: n.pd.d.id, amount: n.pd.d.amount, n })), target);
      if (sols.length !== 1) continue; // mehrdeutig → lieber nichts
      const set = sols[0].sort((a, b) => a.n.pd.day - b.n.pd.day || a.id.localeCompare(b.id));
      const allRef = set.every(x => x.n.s.strongHit);
      const score = Math.round(Math.min(...set.map(x => x.n.s.score)) * 10) / 10;
      links.push({
        docId: set[0].id, docIds: set.map(x => x.id), txId: c.t.id, score, margin: null,
        level: allRef && !touchedByUser(c.t) ? 'sure' : 'check',
        reason: allRef ? null : `Sammelbuchung: ${set.length} Belege ergeben zusammen den Betrag`,
      });
      usedTx.add(c.t.id);
      for (const x of set) usedDoc.add(x.id);
    }
  }

  // 4. 1:n Teilzahlung – nur eindeutig: dieselbe Rechnungs-/Bestellnummer in mehreren Buchungen, deren Summe genau den Beleg ergibt
  for (const pd of pdocs) {
    if (usedDoc.has(pd.d.id) || !pd.strong.length) continue;
    const parts = pool.filter(c => !usedTx.has(c.t.id) && !c.rejected.has(pd.d.id) && pd.strong.some(r => has(c.text, r))
      && c.day - pd.day >= -5 && c.day - pd.day <= 365);
    if (parts.length < 2) continue;
    const sum = parts.reduce((s, c) => s - c.t.amount, 0);
    if (Math.abs(sum - pd.d.amount) > 1) continue;
    parts.sort((a, b) => a.day - b.day || a.t.id.localeCompare(b.t.id));
    parts.forEach((c, i) => {
      links.push({ docId: pd.d.id, docIds: [pd.d.id], txId: c.t.id, score: 100, margin: null, level: 'check', reason: `Teilzahlung ${i + 1} von ${parts.length} zu diesem Beleg` });
      usedTx.add(c.t.id);
    });
    usedDoc.add(pd.d.id);
  }

  // 5. Vorschläge ohne Wirkung: mehrdeutige Betrag+Datum-Treffer, wenn höchstens drei Buchungen in Frage kommen
  const suggestions = [];
  const sugTx = new Set();
  const byDoc = new Map();
  for (const c of weakAmbiguous) {
    if (usedDoc.has(c.docId) || usedTx.has(c.txId)) continue;
    if (!byDoc.has(c.docId)) byDoc.set(c.docId, []);
    byDoc.get(c.docId).push(c);
  }
  for (const [docId, list] of [...byDoc].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length > 3) continue;
    list.sort((a, b) => b.score - a.score || Math.abs(a.diff) - Math.abs(b.diff) || a.txId.localeCompare(b.txId));
    const c = list.find(x => !sugTx.has(x.txId));
    if (!c) continue;
    sugTx.add(c.txId);
    suggestions.push({ docId, txId: c.txId, score: c.score, reason: list.length > 1 ? `Möglicher Beleg – passt nur über Betrag und Datum (${list.length} Buchungen kommen in Frage)` : 'Möglicher Beleg – passt nur über Betrag und Datum' });
  }
  return { links, suggestions };
}

/** Kompatibel: nur die übernommenen Verknüpfungen [{ docId, docIds, txId, score, margin, level, reason }] */
export function matchReceipts(documents, txs) {
  return planReceipts(documents, txs).links;
}

// ---------------------------------------------------------------- Aufteilungs-Vorschlag aus Belegpositionen
// Stichwörter (gefaltet) → Kategorie.Unterkategorie (IDs aus classify/categories.js). Treffer: Wortanfang, Wortende oder (ab 5 Zeichen) enthalten.
const ITEM_GROUPS = [
  ['lebensmittel', 'drogerie', ['zahnpasta', 'zahncreme', 'zahnbuerste', 'zahnseide', 'shampoo', 'spuelung', 'duschgel', 'deo', 'deodorant', 'seife', 'handcreme', 'bodylotion', 'lotion', 'sonnencreme', 'rasier', 'windel', 'feuchttuech', 'toilettenpapier', 'klopapier', 'taschentuech', 'kuechenrolle', 'spuelmittel', 'spuelmaschinen', 'waschmittel', 'weichspueler', 'reiniger', 'putzmittel', 'muellbeutel', 'tampon', 'slipeinlage', 'wattepad', 'wattestaeb', 'kosmetik', 'mascara', 'nagellack', 'haarspray', 'haargel', 'mundspuelung', 'schwamm', 'alufolie', 'frischhaltefolie', 'backpapier']],
  ['gesundheit', 'apotheke', ['ibuprofen', 'paracetamol', 'aspirin', 'pflaster', 'nasenspray', 'hustensaft', 'halstablette', 'fieberthermometer']],
  ['shopping', 'elektronik', ['batterie', 'akku', 'ladekabel', 'usb', 'kopfhoerer', 'gluehbirne', 'leuchtmittel', 'speicherkarte']],
  ['shopping', 'kleidung', ['socken', 'strumpf', 'tshirt', 'unterhose', 'leggings']],
  ['lebensmittel', 'supermarkt', ['milch', 'brot', 'broetchen', 'kaese', 'butter', 'joghurt', 'quark', 'sahne', 'eier', 'mehl', 'zucker', 'nudel', 'spaghetti', 'reis', 'kartoffel', 'tomate', 'gurke', 'paprika', 'zwiebel', 'apfel', 'aepfel', 'banane', 'obst', 'gemuese', 'salat', 'fleisch', 'wurst', 'schinken', 'haehnchen', 'haferflocken', 'muesli', 'kaffee', 'tee', 'saft', 'wasser', 'limo', 'cola', 'bier', 'wein', 'schokolade', 'chips', 'pizza', 'margarine', 'honig', 'marmelade']],
];
const FOLLOW_RE = /pfand|leergut|rabatt|coupon|nachlass|gutschein|preisvorteil|aktion/;

function groupOfItem(text) {
  const f = fold(text), words = f.split(' ');
  const hits = new Set();
  for (const [cat, sub, kws] of ITEM_GROUPS) {
    if (kws.some(k => words.some(w => w.startsWith(k) || (w.endsWith(k) && k.length >= 3)) || (k.length >= 5 && f.includes(k)))) hits.add(`${cat}.${sub}`);
  }
  if (hits.size > 1) return 'ambiguous';
  return hits.size ? [...hits][0] : null;
}

/**
 * Aufteilung aus den Positionen der verknüpften Belege: nur wenn jede Position eindeutig einer Gruppe zufällt
 * (ohne Stichwort → Kategorie der Buchung), mindestens zwei Gruppen entstehen und die Positionssumme exakt den Betrag ergibt.
 * Liefert [{ amount (Vorzeichen der Buchung), category, subcategory }] oder null.
 */
export function suggestSplit(t, items) {
  if (!items?.length || !t.category || t.category === 'umbuchung' || t.splits?.length) return null;
  if (items.some(i => !Number.isFinite(i.total))) return null;
  if (items.reduce((s, i) => s + i.total, 0) !== Math.abs(t.amount)) return null;
  const own = `${t.category}.${t.subcategory || ''}`;
  const sums = new Map();
  let prev = own;
  for (const it of items) {
    let g = FOLLOW_RE.test(fold(it.text)) || it.total < 0 ? prev : groupOfItem(it.text);
    if (g === 'ambiguous') return null;
    if (!g) g = own;
    sums.set(g, (sums.get(g) || 0) + it.total);
    prev = g;
  }
  const groups = [...sums].filter(([, v]) => v !== 0);
  if (groups.length < 2 || groups.some(([, v]) => v < 0)) return null;
  const sign = t.amount < 0 ? -1 : 1;
  groups.sort((a, b) => (a[0] === own ? -1 : b[0] === own ? 1 : b[1] - a[1]));
  return groups.map(([g, v]) => { const [category, sub] = g.split('.'); return { amount: sign * v, category, subcategory: sub || null }; });
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Wendet die Zuordnung auf die Buchungen an (idempotent):
 * - receiptSource 'user' mit Beleg bleibt unverändert, abgelehnte Belege (receiptRejected) kommen nie wieder;
 * - Auto-Links, die nicht mehr gewinnen, werden entfernt; neue/bestätigte erhalten receiptSource 'auto' + receiptScore;
 * - checks (kind 'receipt'/'split') und splitSuggestion werden bei jedem Lauf neu berechnet, andere checks bleiben.
 */
export function applyReceipts(txs, documents, lineItems = []) {
  const { links, suggestions } = planReceipts(documents, txs);
  const linkBy = new Map(links.map(l => [l.txId, l]));
  const sugBy = new Map(suggestions.map(s => [s.txId, s]));
  const itemsByDoc = new Map();
  for (const li of lineItems || []) { if (!itemsByDoc.has(li.documentId)) itemsByDoc.set(li.documentId, []); itemsByDoc.get(li.documentId).push(li); }

  return txs.map(t => {
    let next = t;
    const l = linkBy.get(t.id);
    if (!lockedLink(t)) {
      if (l) {
        const patch = { receiptDocId: l.docIds[0], receiptDocIds: l.docIds, receiptSource: 'auto', receiptScore: l.score };
        if (Object.keys(patch).some(k => !sameJson(t[k], patch[k]))) next = { ...t, ...patch };
      } else if (t.receiptDocId || t.receiptDocIds?.length) {
        // verwaister Auto-Link (auch Altbestand ohne receiptSource) → entfernen
        next = { ...t, receiptDocId: null, receiptDocIds: [], receiptSource: t.receiptSource === 'user' ? 'user' : null, receiptScore: null };
      } else if (t.receiptSource === 'auto' || t.receiptScore != null) {
        next = { ...t, receiptSource: null, receiptScore: null };
      }
    }
    // Prüfpunkte
    const checks = (t.checks || []).filter(c => c.kind !== 'receipt' && c.kind !== 'split');
    if (l && next.receiptSource === 'auto' && l.level === 'check') checks.push({ kind: 'receipt', reason: l.reason, refId: l.docIds[0] });
    else if (!next.receiptDocId && sugBy.has(t.id)) { const s = sugBy.get(t.id); checks.push({ kind: 'receipt', reason: s.reason, refId: s.docId }); }
    const ids = txDocIds(next);
    const split = ids.length ? suggestSplit(next, ids.flatMap(id => itemsByDoc.get(id) || [])) : null;
    if (split) checks.push({ kind: 'split', reason: `Beleg enthält Positionen aus ${split.length} Kategorien – Aufteilung vorgeschlagen`, refId: ids[0] });
    if (!sameJson(t.checks?.length ? t.checks : null, checks.length ? checks : null)) next = { ...next, checks };
    if (!sameJson(t.splitSuggestion, split)) next = { ...next, splitSuggestion: split };
    return next;
  });
}
