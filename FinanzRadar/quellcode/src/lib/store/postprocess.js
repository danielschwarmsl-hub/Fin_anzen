// Nachverarbeitung über den gesamten Datenbestand (nach jedem Import oder Regeländerung)
import { db } from './db.js';
import { normalizeCounterparty } from '../classify/normalize.js';
import { classifyTransactions } from '../classify/rules.js';
import { flagTaxDocument, flagTaxTransaction } from '../classify/taxFlags.js';
import { detectTransfers, detectStornos, computeFlowChecks } from '../analyze/transfers.js';
import { detectRecurring, linkContracts, linkContractDocs } from '../analyze/recurring.js';
import { applyReceipts } from '../analyze/receipts.js';

/** Unterscheidet sich der Datensatz? Primitive per ===, verschachtelte Werte per JSON (große Texte werden nicht serialisiert). */
export function differs(a, b) {
  if (!a || !b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (x === y) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object') { if (JSON.stringify(x) !== JSON.stringify(y)) return true; continue; }
    if (x == null && y == null) continue; // undefined ≙ null
    return true;
  }
  return false;
}

/**
 * Neu erkannte Verträge mit den bisherigen verheiraten (ID, Notiz, „ausgeblendet“, Art bleiben erhalten).
 * Jeder alte Vertrag wird höchstens einmal vergeben: erst gleiche ID, dann gleicher Anbieter + Konto + Rhythmus mit dem
 * nächstliegenden Betrag (Paare global nach Betragsabstand, nicht der erste Treffer).
 * (Mehrere Betragsgruppen desselben Anbieters sonst bekämen alle dieselbe ID und fielen beim Speichern zusammen.)
 * Dokument-Verträge (source 'doc') entstehen in linkContractDocs neu und bleiben hier außen vor.
 */
export function mergeContracts(detected, contractsOld = []) {
  const oldAuto = contractsOld.filter(c => c.source !== 'user' && c.source !== 'doc');
  const byId = new Map(oldAuto.map(o => [o.id, o]));
  const claimed = new Set();
  const pairs = detected.map(c => {
    const o = byId.get(c.id);
    if (o && !claimed.has(o.id)) { claimed.add(o.id); return [c, o]; }
    return [c, null];
  });
  const options = [];
  pairs.forEach((pair, i) => {
    if (pair[1]) return;
    const c = pair[0];
    oldAuto.forEach((x, j) => {
      if (claimed.has(x.id) || x.provider !== c.provider || x.accountId !== c.accountId || x.interval !== c.interval) return;
      options.push({ i, j, dist: Math.abs((x.amount || 0) - (c.amount || 0)) });
    });
  });
  options.sort((a, b) => a.dist - b.dist || a.i - b.i || a.j - b.j);
  for (const { i, j } of options) {
    const o = oldAuto[j];
    if (pairs[i][1] || claimed.has(o.id)) continue;
    claimed.add(o.id); pairs[i][1] = o;
  }
  return pairs.map(([c, old]) => (old ? { ...c, id: old.id, note: old.note, hidden: old.hidden, kind: old.kindUser ? old.kind : c.kind, kindUser: old.kindUser } : c));
}

/**
 * Lesen, Rechnen und Schreiben laufen in EINER Transaktion: parallele Änderungen (KI-Lauf, Korrekturen im UI)
 * gehen so nicht verloren. Geschrieben werden nur tatsächlich geänderte Datensätze (IndexedDB-Schreiben ist der Engpass).
 */
export function postProcess() {
  return db.transaction('rw', [db.accounts, db.rules, db.documents, db.contracts, db.transactions, db.lineItems], runPostProcess);
}

async function runPostProcess() {
  const [accounts, rules, documents, contractsOld, lineItems] = await Promise.all([db.accounts.toArray(), db.rules.toArray(), db.documents.toArray(), db.contracts.toArray(), db.lineItems.toArray()]);
  let txs = await db.transactions.toArray();
  const txBefore = new Map(txs.map(t => [t.id, JSON.stringify(t)]));
  const docBefore = new Map(documents.map(d => [d.id, { ...d }]));

  // 1. Gegenparteien normalisieren (nur wenn nicht vom Nutzer gesetzt)
  txs = txs.map(t => (t.counterpartyUser ? t : { ...t, counterparty: normalizeCounterparty(t) || t.counterparty || t.counterpartyRaw || '' }));
  // Überweisungen an sich selbst (Kontoinhaber = Gegenpartei) verständlich benennen
  const owners = new Set(accounts.map(a => (a.owner || '').toLowerCase().trim()).filter(n => n.length > 3));
  if (owners.size) {
    txs = txs.map(t => {
      if (t.counterpartyUser || !owners.has(String(t.counterparty || '').toLowerCase().trim())) return t;
      const p = `${t.purpose || ''} ${t.bookingText || ''}`;
      const hint = /tagesgeld|festgeld|spar(en|konto)/i.test(p) ? 'Tagesgeld' : /depot|sparplan|wertpapier|verrechnungskonto/i.test(p) ? 'Depot' : /kreditkarte|visa|mastercard/i.test(p) ? 'Kreditkarte' : null;
      return { ...t, counterparty: 'Eigenes Konto' + (hint ? ' · ' + hint : ''), ownTransfer: true };
    });
  }
  // 2. Umbuchungen (eigene Konten, PayPal-Aufladungen, Kreditkartenausgleich)
  txs = detectTransfers(txs, accounts);
  // Überweisung an sich selbst ohne importierte Gegenbuchung: genau ein eigenes Spar-/Depotkonto passender Art → Umbuchung dorthin
  // (macht das Ergebnis unabhängig davon, ob CSV, PDF oder camt zuerst importiert wurde)
  const KIND_BY_HINT = { 'Eigenes Konto · Tagesgeld': ['tagesgeld'], 'Eigenes Konto · Depot': ['depot'] };
  txs = txs.map(t => {
    if (!t.ownTransfer || t.isTransfer || t.categorySource === 'user' || t.transferSource === 'user') return t;
    const kinds = KIND_BY_HINT[t.counterparty];
    if (!kinds) return t;
    const cands = accounts.filter(a => kinds.includes(a.kind) && a.id !== t.accountId);
    return cands.length === 1 ? { ...t, isTransfer: true, transferAccountId: cands[0].id, transferSource: 'auto', transferConfidence: 'high' } : t;
  });
  // Storno-/Erstattungspaare; danach Prüfliste für Geldfluss (Umbuchung, PayPal, Depot, Storno) neu berechnen
  txs = detectStornos(txs);
  txs = computeFlowChecks(txs, accounts);
  // 3. Kategorisieren
  txs = classifyTransactions(txs, { rules, accounts });
  // 4. Wiederkehrende Zahlungen → Verträge/Abos
  const userContracts = contractsOld.filter(c => c.source === 'user');
  const auto = mergeContracts(detectRecurring(txs, userContracts), contractsOld);
  // Vertragsdokumente anhängen; Verträge ohne Zahlung als noPayments
  const contracts = linkContractDocs([...userContracts, ...auto], documents, txs, contractsOld);
  txs = linkContracts(txs, contracts);
  // 5. Belege ↔ Buchungen (Nutzer-Links bleiben, verwaiste Auto-Links fallen weg; checks receipt/split, splitSuggestion)
  txs = applyReceipts(txs, documents, lineItems);
  // 6. Steuer-Flags (Nutzerentscheidung bleibt)
  const docs = documents.map(d => (d.taxSource === 'user' ? d : { ...d, ...flagTaxDocument(d) }));
  txs = txs.map(t => (t.taxSource === 'user' ? t : { ...t, ...flagTaxTransaction(t) }));
  // Beleg-Flag auf verknüpfte Buchung übertragen und umgekehrt
  const docById = new Map(docs.map(d => [d.id, d]));
  for (const t of txs) {
    const d = t.receiptDocId && docById.get(t.receiptDocId);
    if (d && d.taxRelevant && !t.taxRelevant && t.taxSource !== 'user') { t.taxRelevant = true; t.taxReason = d.taxReason; }
    if (d && t.taxRelevant && !d.taxRelevant && d.taxSource !== 'user') { d.taxRelevant = true; d.taxReason = t.taxReason; }
  }

  const txChanged = txs.filter(t => txBefore.get(t.id) !== JSON.stringify(t));
  const docChanged = docs.filter(d => differs(docBefore.get(d.id), d));
  if (txChanged.length) await db.transactions.bulkPut(txChanged);
  await db.contracts.clear();
  await db.contracts.bulkPut(contracts);
  if (docChanged.length) await db.documents.bulkPut(docChanged);
}
