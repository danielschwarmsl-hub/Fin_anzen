// Prüfliste: reine Logik ohne DOM (Kriterium, Sortierung nach Geldwirkung, Bestätigungs-Patches, „Warum?“-Texte).
// Alle Felder werden defensiv gelesen: fehlt eins (z. B. checks), gibt es einfach nichts zu prüfen.
import { fold } from '../classify/merchants.de.js';

export const CHECK_KINDS = ['receipt', 'transfer', 'paypal', 'depot', 'storno', 'split'];
export const KIND_LABEL = {
  category: 'Kategorie', receipt: 'Beleg', transfer: 'Umbuchung', paypal: 'PayPal', depot: 'Depot', storno: 'Storno', split: 'Aufteilung',
  doc: 'Dokument', unreadable: 'Unlesbar',
};
// Paar-Arten: beide Seiten hängen über transferPairId (bzw. refId) zusammen
const PAIR_KINDS = new Set(['transfer', 'paypal', 'depot']);

// ---------------------------------------------------------------- Kriterium
/** Schlüssel, unter dem eine erledigte Prüfung gemerkt wird (checks werden bei jedem Lauf neu berechnet) */
export const ackKey = (c) => `${c?.kind || ''}:${c?.refId || ''}`;

/** Offene Prüfungen einer Buchung (vom Nutzer erledigte fallen weg) */
export function openChecks(t) {
  const list = Array.isArray(t?.checks) ? t.checks : [];
  if (!list.length) return [];
  const ack = new Set(Array.isArray(t.checksAck) ? t.checksAck : []);
  return list.filter(c => c && c.kind && !ack.has(ackKey(c)));
}
export const needsCategory = (t) => !!(t?.needsReview && !t.reviewed);
/** Prüflisten-Kriterium (Briefing): Kategorie unsicher ODER offene checks */
export const isPendingTx = (t) => needsCategory(t) || openChecks(t).length > 0;
export const isPendingDoc = (d) => !!(d?.needsReview && !d.reviewed && d.type !== 'irrelevant');
export const isUnreadable = (d) => d?.subtype === 'unlesbar';

export function reviewCount(transactions = [], documents = []) {
  let n = 0;
  for (const t of transactions) if (isPendingTx(t)) n++;
  for (const d of documents) if (isPendingDoc(d)) n++;
  return n;
}

/** Was an einer Buchung zu prüfen ist: Kategorie zuerst, dann die checks in ihrer Reihenfolge */
export function txAspects(t) {
  const out = [];
  if (needsCategory(t)) out.push({ kind: 'category', reason: categoryReason(t) });
  for (const c of openChecks(t)) out.push({ kind: c.kind, reason: c.reason || defaultReason(c.kind), refId: c.refId || null });
  return out;
}

function categoryReason(t) {
  if (t.reviewReason) return t.reviewReason;
  if (t.categorySource === 'ai' && t.aiReason) return `KI: ${t.aiReason}`;
  const pct = Math.round((t.confidence ?? 0) * 100);
  if (t.category === 'sonstiges' || !t.category) return 'Keine passende Kategorie gefunden.';
  return `Kategorie nur zu ${pct} % sicher.`;
}
function defaultReason(kind) {
  return ({
    receipt: 'Beleg passt nicht eindeutig.',
    transfer: 'Umbuchung zwischen eigenen Konten vermutet.',
    paypal: 'PayPal-Zahlung und Bankeinzug vermutlich dieselbe Ausgabe.',
    depot: 'Wertpapierkauf vermutlich doppelt (Giro und Depot).',
    storno: 'Zahlung und Gutschrift heben sich vermutlich auf.',
    split: 'Beleg enthält Positionen aus mehreren Kategorien.',
  })[kind] || 'Bitte prüfen.';
}

export function docReason(d) {
  if (d?.reviewReason) return d.reviewReason;
  if (isUnreadable(d)) return 'Beleg nicht lesbar – neu prüfen';
  if (d?.alternatives?.length) return 'Dokumenttyp unsicher.';
  return 'Angaben unsicher.';
}

// ---------------------------------------------------------------- Sortierung
/** Geldwirkung eines Eintrags in Cent (Beträge positiv) */
export const moneyWeight = (x) => Math.abs(Number(x?.amount) || 0);

/**
 * Prüfliste als Schlüsselliste ('t:<id>' | 'd:<id>'), sortiert nach Geldwirkung (größter Betrag zuerst),
 * bei Gleichstand die unsicherste Zuordnung zuerst.
 * @param {{transactions?: object[], documents?: object[]}} data
 * @param {'all'|'tx'|'docs'} filter
 */
export function buildQueue({ transactions = [], documents = [] } = {}, filter = 'all') {
  const items = [];
  if (filter !== 'docs') for (const t of transactions) if (isPendingTx(t)) items.push({ key: 't:' + t.id, w: moneyWeight(t), c: t.confidence ?? 0, d: t.bookingDate || '' });
  if (filter !== 'tx') for (const d of documents) if (isPendingDoc(d)) items.push({ key: 'd:' + d.id, w: moneyWeight(d), c: d.confidence ?? 0, d: d.date || '' });
  items.sort((a, b) => b.w - a.w || a.c - b.c || b.d.localeCompare(a.d));
  return items.map(i => i.key);
}

// ---------------------------------------------------------------- Patches
export const cpKey = (t) => fold(t?.counterparty || t?.counterpartyRaw || '');

/** Gegenbuchung zu einer Paar-Prüfung (refId, sonst transferPairId) */
export function pairOf(t, aspect, txById) {
  const id = aspect?.refId && txById?.has(aspect.refId) ? aspect.refId : t?.transferPairId;
  return id ? txById?.get(id) || null : null;
}

/** checksAck-Ergänzung: alle offenen Prüfungen der Art `kind` an `t` als erledigt merken */
function ackFor(t, kind) {
  const keys = (Array.isArray(t?.checks) ? t.checks : []).filter(c => c?.kind === kind).map(ackKey);
  if (!keys.length) return {};
  const prev = Array.isArray(t.checksAck) ? t.checksAck : [];
  return { checksAck: [...new Set([...prev, ...keys])] };
}

export const CATEGORY_CONFIRM = { needsReview: false, reviewed: true, categorySource: 'user', confidence: 1 };
export const TRANSFER_CONFIRM = { transferSource: 'user', isTransfer: true };
export const TRANSFER_REJECT = { transferSource: 'user', isTransfer: false, transferPairId: null, transferAccountId: null };

/** Kategorie bestätigen (auch ohne Änderung = Nutzerentscheidung) */
export function categoryPatch(t, choice) {
  const category = choice?.category || t.category || null;
  const subcategory = choice?.category ? (choice.subcategory || null) : (t.subcategory || null);
  return { ...CATEGORY_CONFIRM, category, subcategory };
}

/** Aufteilungs-Vorschlag → splits (Vorzeichen wie die Buchung) */
export function splitsFromSuggestion(t) {
  const s = Array.isArray(t?.splitSuggestion) ? t.splitSuggestion : [];
  const sign = (t?.amount ?? 0) < 0 ? -1 : 1;
  return s.filter(p => p && p.category && Number(p.amount)).map(p => ({ amount: sign * Math.abs(Math.round(Number(p.amount))), category: p.category, subcategory: p.subcategory || null }));
}

/** Beleg-Prüfung ist ein Vorschlag (refId noch nicht verknüpft) statt einer bestehenden Verknüpfung */
export function isReceiptSuggestion(t, aspect) {
  const ref = aspect?.refId;
  if (!ref) return false;
  const linked = [t?.receiptDocId, ...(Array.isArray(t?.receiptDocIds) ? t.receiptDocIds : [])];
  return !linked.includes(ref);
}

/**
 * Bestätigen einer Prüfung. Gibt [{ id, patch }] zurück – bei Paaren beide Seiten.
 * @param {object} t Buchung
 * @param {{kind:string, refId?:string}} aspect
 * @param {{ txById?: Map, choice?: {category, subcategory} }} ctx
 */
export function confirmPatches(t, aspect, { txById = new Map(), choice = null } = {}) {
  const kind = aspect?.kind;
  if (!t || !kind) return [];
  if (kind === 'category') return [{ id: t.id, patch: categoryPatch(t, choice) }];
  if (kind === 'receipt') {
    // Vorschlag (noch nicht verknüpft) → verknüpfen; sonst die bestehende Verknüpfung bestätigen
    if (isReceiptSuggestion(t, aspect)) return [{ id: t.id, patch: { receiptDocId: aspect.refId, receiptDocIds: [aspect.refId], receiptSource: 'user', ...ackFor(t, kind) } }];
    return [{ id: t.id, patch: { receiptSource: 'user', ...ackFor(t, kind) } }];
  }
  if (kind === 'paypal') {
    // Halbe Verknüpfung: Bankseite zeigt auf die PayPal-Zeile, die selbst keine Umbuchung ist
    const out = [{ id: t.id, patch: { transferSource: 'user', reviewed: true, ...ackFor(t, kind) } }];
    const p = pairOf(t, aspect, txById);
    if (p) { const ack = ackFor(p, kind); if (ack.checksAck) out.push({ id: p.id, patch: ack }); }
    return out;
  }
  if (PAIR_KINDS.has(kind)) {
    const out = [{ id: t.id, patch: { ...TRANSFER_CONFIRM, ...ackFor(t, kind) } }];
    const p = pairOf(t, aspect, txById);
    if (p) out.push({ id: p.id, patch: { ...TRANSFER_CONFIRM, ...ackFor(p, kind) } });
    return out;
  }
  if (kind === 'storno') {
    const out = [{ id: t.id, patch: { stornoSource: 'user', ...ackFor(t, kind) } }];
    const p = pairOf(t, aspect, txById);
    if (p) out.push({ id: p.id, patch: { stornoSource: 'user', ...ackFor(p, kind) } });
    return out;
  }
  if (kind === 'split') {
    const splits = splitsFromSuggestion(t);
    const sum = splits.reduce((a, s) => a + s.amount, 0);
    // Nur übernehmen, wenn die Teile die Buchung genau ergeben – sonst bleibt es beim Vorschlag
    if (splits.length >= 2 && sum === t.amount) return [{ id: t.id, patch: { splits, categorySource: 'user', confidence: 1, needsReview: false, ...ackFor(t, kind) } }];
    return [{ id: t.id, patch: { ...ackFor(t, kind) } }];
  }
  return [{ id: t.id, patch: { ...ackFor(t, kind) } }];
}

/** Ablehnen einer Prüfung (Beleg lösen, keine Umbuchung, kein Storno, nicht aufteilen) */
export function rejectPatches(t, aspect, { txById = new Map() } = {}) {
  const kind = aspect?.kind;
  if (!t || !kind || kind === 'category') return [];
  if (kind === 'receipt') {
    const prevRej = Array.isArray(t.receiptRejected) ? t.receiptRejected : [];
    // Vorschlag ablehnen: bestehende Verknüpfung bleibt
    if (isReceiptSuggestion(t, aspect)) return [{ id: t.id, patch: { receiptSource: 'user', receiptRejected: [...new Set([...prevRej, aspect.refId])], ...ackFor(t, kind) } }];
    const ids = [aspect.refId, ...(Array.isArray(t.receiptDocIds) ? t.receiptDocIds : []), t.receiptDocId].filter(Boolean);
    const prev = Array.isArray(t.receiptRejected) ? t.receiptRejected : [];
    return [{ id: t.id, patch: { receiptDocId: null, receiptDocIds: [], receiptSource: 'user', receiptRejected: [...new Set([...prev, ...ids])], ...ackFor(t, kind) } }];
  }
  if (PAIR_KINDS.has(kind)) {
    const out = [{ id: t.id, patch: { ...TRANSFER_REJECT, ...ackFor(t, kind) } }];
    const p = pairOf(t, aspect, txById);
    // PayPal-Zeile ist selbst keine Umbuchung: nur deren Prüfung erledigen
    if (p && kind === 'paypal') { const ack = ackFor(p, kind); if (ack.checksAck) out.push({ id: p.id, patch: ack }); }
    else if (p) out.push({ id: p.id, patch: { ...TRANSFER_REJECT, ...ackFor(p, kind) } });
    return out;
  }
  if (kind === 'storno') {
    const out = [{ id: t.id, patch: { stornoSource: 'user', stornoPairId: null, ...ackFor(t, kind) } }];
    const p = pairOf(t, aspect, txById);
    if (p) out.push({ id: p.id, patch: { stornoSource: 'user', stornoPairId: null, ...ackFor(p, kind) } });
    return out;
  }
  return [{ id: t.id, patch: { ...ackFor(t, kind) } }];
}

/** Mehrere Patches je Datensatz zusammenführen (checksAck wird vereinigt) */
export function mergePatches(list) {
  const m = new Map();
  for (const { id, patch } of list) {
    const cur = m.get(id);
    if (!cur) { m.set(id, { ...patch }); continue; }
    const ack = [...new Set([...(cur.checksAck || []), ...(patch.checksAck || [])])];
    Object.assign(cur, patch);
    if (ack.length) cur.checksAck = ack;
  }
  return [...m.entries()].map(([id, patch]) => ({ id, patch }));
}

/** „Alles passt“: alle offenen Prüfungen einer Buchung bestätigen */
export function confirmAllPatches(t, ctx = {}) {
  return mergePatches(txAspects(t).flatMap(a => confirmPatches(t, a, ctx)));
}

/** Vorheriger Stand der vom Patch berührten Felder (für Rückgängig) */
export function prevFor(obj, patch) {
  const prev = {};
  for (const k of Object.keys(patch)) {
    const v = obj?.[k];
    prev[k] = v === undefined ? null : (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  }
  return prev;
}

/**
 * Ähnliche offene Buchungen: gleiche Gegenpartei und gleiche Prüf-Art (ohne t selbst).
 * Gibt [{ tx, aspect }] zurück.
 */
export function similarOpen(t, kind, transactions = []) {
  const key = cpKey(t);
  if (!key || !kind) return [];
  const out = [];
  for (const x of transactions) {
    if (!x || x.id === t.id || cpKey(x) !== key) continue;
    const a = txAspects(x).find(y => y.kind === kind);
    if (a) out.push({ tx: x, aspect: a });
  }
  return out;
}

// ---------------------------------------------------------------- „Warum?“
const SRC_TEXT = {
  rule: 'Deine Regel', merchant: 'Händlerliste', keyword: 'Stichwort in Buchungstext/Zweck', user: 'Von dir festgelegt', ai: 'KI-Vorschlag', transfer: 'Als Umbuchung erkannt',
};

/** Ein Satz zur Herkunft der Kategorie */
export function categoryWhy(t, rules = []) {
  if (!t) return '';
  const src = t.categorySource;
  if (src === 'rule') {
    const r = t.ruleId ? rules.find(x => x.id === t.ruleId) : null;
    return r?.match?.value ? `Deine Regel „${r.match.value}“.` : 'Deine Regel.';
  }
  if (src === 'merchant') return t.merchant ? `Händlerliste: ${t.merchant}.` : 'Händlerliste.';
  if (src === 'ai') return t.aiReason ? `KI: ${t.aiReason}` : 'KI-Vorschlag.';
  if (src === 'keyword' && (t.confidence ?? 1) <= 0.4) return 'Keine Regel passte – Standard nach Vorzeichen.';
  return (SRC_TEXT[src] || 'Automatisch') + '.';
}

export const CONFIDENCE_TEXT = { high: 'hoch', medium: 'mittel' };

/**
 * Zahlungskette Beleg → PayPal → Bank, soweit verknüpft.
 * @returns {Array<{ kind:'doc'|'paypal'|'bank', id:string, label?:string }>} leer, wenn keine Kette (weniger als 2 Glieder)
 */
export function paymentChain(t, { txById = new Map(), accountById = new Map(), docById = new Map() } = {}) {
  if (!t) return [];
  const isPaypal = (x) => accountById.get(x?.accountId)?.kind === 'paypal';
  const linked = [t];
  const pair = t.transferPairId ? txById.get(t.transferPairId) : null;
  if (pair) linked.push(pair);
  // Rückverweis: Bankeinzug zeigt per transferPairId auf die PayPal-Zeile (halbe Verknüpfung)
  else for (const x of txById.values()) if (x?.transferPairId === t.id) { linked.push(x); break; }
  for (const c of Array.isArray(t.checks) ? t.checks : []) if (c?.kind === 'paypal' && c.refId && txById.has(c.refId)) linked.push(txById.get(c.refId));
  const pp = linked.find(isPaypal) || null;
  const bank = linked.find(x => !isPaypal(x)) || null;
  const docId = t.receiptDocId || pp?.receiptDocId || bank?.receiptDocId || null;
  const doc = docId ? docById.get(docId) : null;
  const out = [];
  if (doc) out.push({ kind: 'doc', id: doc.id });
  if (pp) out.push({ kind: 'paypal', id: pp.id });
  if (bank && (pp || doc)) out.push({ kind: 'bank', id: bank.id });
  return out.length >= 2 ? out : [];
}

const DAY = 86400000;
const dayDiff = (a, b) => Math.abs(Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / DAY;

/**
 * Gegenbuchung für eine einseitig markierte Umbuchung: gleicher Betrag mit umgekehrtem Vorzeichen,
 * anderes Konto, höchstens `days` Tage Abstand, nicht schon anderweitig gepaart. Nächstes Datum gewinnt.
 */
export function findTransferCounterpart(t, transactions = [], days = 5) {
  if (!t?.amount || !t.bookingDate) return null;
  let best = null, bestD = Infinity;
  for (const x of transactions) {
    if (!x || x.id === t.id || x.accountId === t.accountId || x.amount !== -t.amount || !x.bookingDate) continue;
    if (x.transferPairId && x.transferPairId !== t.id) continue;
    if (x.transferSource === 'user' && x.isTransfer === false) continue;
    const d = dayDiff(x.bookingDate, t.bookingDate);
    if (d <= days && d < bestD) { best = x; bestD = d; }
  }
  return best;
}

/** Beide Seiten einer manuell markierten Umbuchung */
export function linkTransferPatches(a, b) {
  const base = { ...TRANSFER_CONFIRM, category: 'umbuchung', subcategory: null, categorySource: 'user', confidence: 1, needsReview: false };
  return [
    { id: a.id, patch: { ...base, transferPairId: b.id, transferAccountId: b.accountId || null } },
    { id: b.id, patch: { ...base, transferPairId: a.id, transferAccountId: a.accountId || null } },
  ];
}
