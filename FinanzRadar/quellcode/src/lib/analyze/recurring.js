// Wiederkehrende Zahlungen (Abos, Versicherungen, Miete, Daueraufträge, Gehalt ...) erkennen.
// detectRecurring(txs, existingContracts) → Contract[]   linkContracts(txs, contracts) → txs mit contractId
import { fold, findMerchant } from '../classify/merchants.de.js';

// Intervallklassen: [name, Zentrum (Tage), Toleranz, Zahlungen pro Jahr]
const CLASSES = [
  ['weekly', 7, 2, 52],
  ['biweekly', 14, 3, 26],
  ['monthly', 30, 5, 12],
  ['quarterly', 91, 10, 4],
  ['halfyearly', 182, 15, 2],
  ['yearly', 365, 20, 1],
];
const MONTHS_PER = { weekly: 0, biweekly: 0, monthly: 1, quarterly: 3, halfyearly: 6, yearly: 12 };
const DAYS_PER = { weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.3, halfyearly: 182.6, yearly: 365.25 };
const AMOUNT_TOL = 0.15;
const PLATEAU_TOL = 0.08;

const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  return n ? (n % 2 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2)) : 0;
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Klassifiziert die Abstände einer Serie; liefert die beste Intervallklasse oder null */
function intervalOf(days, hintInterval) {
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  if (!gaps.length) return null;
  const need = Math.ceil(gaps.length * 0.6);
  const needStrict = Math.max(1, Math.ceil(gaps.length * 0.5));
  let best = null;
  for (const [name, c, tol] of CLASSES) {
    let strict = 0, loose = 0;
    for (const g of gaps) {
      if (Math.abs(g - c) <= tol) strict++;
      else if (name !== 'yearly' && Math.abs(g - 2 * c) <= tol * 1.5) loose++; // eine ausgelassene Zahlung
    }
    const ok = strict + loose;
    if (ok >= need && strict >= needStrict && (!best || ok > best.ok || (ok === best.ok && name === hintInterval))) best = { name, ok, strict };
  }
  return best;
}

/**
 * Preisstufen (Plateaus) einer chronologischen Betragsfolge.
 * Abweichungen bis 8 % gehören zur Stufe; eine dauerhaft neue Höhe (Folgebetrag passt zu ihr) startet eine neue Stufe;
 * einzelne Ausreißer bis 15 % werden toleriert, größere zählen als Ausreißer.
 */
function plateausOf(amts) {
  const plateaus = [];
  let cur = null, outliers = 0;
  const within = (a, ref, tol) => Math.abs(a - ref) <= ref * tol;
  for (let i = 0; i < amts.length; i++) {
    const a = amts[i];
    if (!cur) { cur = { start: i, vals: [a] }; plateaus.push(cur); continue; }
    const ref = median(cur.vals);
    if (within(a, ref, PLATEAU_TOL)) { cur.vals.push(a); continue; }
    const next = amts[i + 1];
    const levelChange = i === amts.length - 1 || (next != null && within(next, a, PLATEAU_TOL));
    if (levelChange) { cur = { start: i, vals: [a] }; plateaus.push(cur); }
    else if (within(a, ref, AMOUNT_TOL)) cur.vals.push(a);
    else outliers++;
  }
  return plateaus.length ? { plateaus: plateaus.map(p => ({ from: p.start, n: p.vals.length, med: median(p.vals) })), outliers } : null;
}

/** Prüft eine Serie [{day, amt(abs), tx}]; liefert Contract-Rohdaten oder null */
function analyzeSeries(items, minOccBase, hint) {
  const n = items.length;
  if (n < 2) return null;
  const days = items.map(i => i.day);
  const iv = intervalOf(days, hint);
  if (!iv) return null;
  const minOcc = iv.name === 'yearly' || iv.name === hint ? 2 : minOccBase;
  if (n < minOcc) return null;
  const amts = items.map(i => i.amt);
  const pl = plateausOf(amts);
  if (!pl) return null;
  const { plateaus, outliers } = pl;
  if (outliers > Math.floor(n * 0.25)) return null;
  if (plateaus.length > 4) return null;
  // Stufen müssen belastbar sein: nur die letzte darf aus einer Zahlung bestehen
  for (let i = 0; i < plateaus.length - 1; i++) if (plateaus[i].n < 2 && n > 3) return null;
  // Sprünge zwischen Stufen: höchstens Faktor 2
  for (let i = 1; i < plateaus.length; i++) { const r = plateaus[i].med / plateaus[i - 1].med; if (r > 2 || r < 0.5) return null; }
  const last = plateaus[plateaus.length - 1];
  let priceChange = null;
  if (plateaus.length > 1) {
    const prev = plateaus[plateaus.length - 2];
    priceChange = { from: prev.med, to: last.med, date: items[last.from].tx.bookingDate };
  }
  return { interval: iv.name, amount: last.med, priceChange, count: n };
}

function kindOf(category, sub, txs) {
  if (category === 'einkommen') return 'einkommen';
  if (category === 'abos_medien') return 'abo';
  if (category === 'versicherungen') return 'versicherung';
  if (category === 'wohnen' && sub === 'miete') return 'miete';
  if (category === 'vorsorge_sparen') return 'vorsorge';
  if (category === 'finanzen' && sub === 'kredit') return 'kredit';
  if (category === 'wohnen' && ['internet_telefon', 'strom_gas', 'rundfunk'].includes(sub)) return 'abo';
  if (category === 'mobilitaet' && sub === 'oepnv') return 'abo';
  if (txs.filter(t => /dauerauftrag/i.test(t.bookingText || '')).length > txs.length / 2) return 'dauerauftrag';
  return 'sonstiges';
}

function addMonths(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const max = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, max));
  return d.toISOString().slice(0, 10);
}
function nextDateOf(last, interval) {
  if (MONTHS_PER[interval]) return addMonths(last, MONTHS_PER[interval]);
  const d = new Date(last + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + DAYS_PER[interval]);
  return d.toISOString().slice(0, 10);
}

function groupKey(t) {
  const sign = t.amount < 0 ? '-' : '+';
  const cp = nameKey(t);
  if (t.mandateId) return `${sign}m:${t.mandateId}`;
  if (t.creditorId && cp) return `${sign}c:${t.creditorId}|${cp}`;
  return cp ? `${sign}n:${cp}` : null;
}
const nameKey = (t) => fold(t.counterparty || t.counterpartyRaw || '').replace(/[0-9]+/g, '').trim();

const mode = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Dieselbe Zahlung kann aus verschiedenen Quellen kommen (camt/PDF mit Mandat, CSV ohne): Gruppen ohne Mandat bzw. Gläubiger-ID
 * wandern in die Mandatsgruppe desselben Namens, wenn es genau eine gibt (mehrere Mandate = mehrere Verträge, dann bleibt es getrennt).
 */
function mergeUnreferenced(groups) {
  const refBy = new Map(); // Vorzeichen|Name → Schlüssel der Gruppen mit Mandat/Gläubiger-ID
  for (const [k, items] of groups) {
    if (!/^[-+][mc]:/.test(k)) continue;
    for (const n of new Set(items.map(i => `${k[0]}|${nameKey(i.tx)}`))) { if (!refBy.has(n)) refBy.set(n, new Set()); refBy.get(n).add(k); }
  }
  for (const [k, items] of [...groups]) {
    if (!/^[-+]n:/.test(k)) continue;
    const targets = refBy.get(`${k[0]}|${k.slice(3)}`);
    if (!targets || targets.size !== 1) continue;
    const target = groups.get([...targets][0]);
    for (const it of items) target.push(it);
    groups.delete(k);
  }
}

/** Zerlegt eine unregelmäßige Gruppe in Cluster gleicher Beträge (±2 %) */
function amountClusters(items) {
  const sorted = [...items].sort((a, b) => a.amt - b.amt);
  const clusters = [];
  for (const it of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && it.amt - c.base <= c.base * 0.02) c.items.push(it);
    else clusters.push({ base: it.amt, items: [it] });
  }
  return clusters.filter(c => c.items.length >= 2).map(c => c.items.sort((a, b) => a.day - b.day));
}

/**
 * @param {object[]} txs Buchungen (klassifiziert, Umbuchungen markiert)
 * @param {object[]} existingContracts bisherige Verträge (IDs/Notizen bleiben erhalten)
 */
export function detectRecurring(txs, existingContracts = []) {
  // Umbuchungen (Abflüsse) laufen mit, damit Serien nicht reißen, wenn eine Rate als Umbuchung erkannt wurde;
  // Serien, die überwiegend aus Umbuchungen bestehen, werden verworfen (siehe build).
  const usable = txs.filter(t => t.bookingDate && t.amount && t.category !== 'bargeld'
    && (t.amount < 0 || (t.category === 'einkommen' && !t.isTransfer)));
  let latest = 0;
  for (const t of txs) if (t.bookingDate) { const d = dayNum(t.bookingDate); if (d > latest) latest = d; }

  const groups = new Map();
  for (const t of usable) {
    const k = groupKey(t);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push({ day: dayNum(t.bookingDate), amt: Math.abs(t.amount), tx: t });
  }
  mergeUnreferenced(groups);

  const userNames = new Set(existingContracts.filter(c => c.source === 'user').map(c => fold(c.provider || c.name)));
  const out = [];
  const used = new Set();

  const build = (key, items, res) => {
    const list = items.map(i => i.tx);
    if (list.filter(t => !t.isTransfer && t.category !== 'umbuchung').length * 2 < list.length) return;
    const sign = list[0].amount < 0 ? -1 : 1;
    const provider = mode(list.map(t => t.counterparty || t.counterpartyRaw)) || 'Unbekannt';
    if (userNames.has(fold(provider))) return;
    const category = mode(list.filter(t => !t.isTransfer).map(t => t.category)) || 'sonstiges';
    const sub = mode(list.filter(t => t.category === category).map(t => t.subcategory)) || null;
    const acc = mode(list.map(t => t.accountId));
    const kind = kindOf(category, sub, list);
    const [, , , perYear] = CLASSES.find(c => c[0] === res.interval);
    const amount = sign * res.amount;
    const firstDate = list[0].bookingDate, lastDate = list[list.length - 1].bookingDate;
    const lastDay = dayNum(lastDate);
    const active = latest - lastDay <= DAYS_PER[res.interval] * 1.5;
    const pc = res.priceChange ? { from: sign * res.priceChange.from, to: sign * res.priceChange.to, date: res.priceChange.date } : null;
    const idKey = `${key}|${res.interval}|${acc}`;
    const old = existingContracts.find(c => c.source !== 'user' && c.provider === provider && c.accountId === acc && c.interval === res.interval);
    out.push({
      id: old?.id || 'ct_' + hash(idKey + (items.clusterBase ? '|' + items.clusterBase : '')),
      kind: old?.kindUser ? old.kind : kind, provider, name: provider, category, subcategory: sub,
      interval: res.interval, amount, monthly: Math.round(res.amount * perYear / 12), firstDate, lastDate,
      nextDate: nextDateOf(lastDate, res.interval), accountId: acc, txIds: list.map(t => t.id), count: list.length,
      priceChange: pc, active, yearlyCost: Math.round(res.amount * perYear), source: 'auto',
    });
    for (const t of list) used.add(t.id);
  };

  for (const [key, items] of groups) {
    items.sort((a, b) => a.day - b.day);
    if (items.length < 2) continue;
    const first = items[0].tx;
    const hint = findMerchant(fold(first.counterparty || first.counterpartyRaw), '')?.recurringHint || null;
    const base = analyzeSeries(items, 3, hint);
    if (base) { build(key, items, base); continue; }
    // Gemischte Gruppe (z. B. Amazon, Google): Cluster gleicher Beträge einzeln prüfen
    if (items.length >= 4) {
      for (const cl of amountClusters(items)) {
        const r = analyzeSeries(cl, 3, hint);
        if (r) { cl.clusterBase = cl[0].amt; build(key, cl, r); }
      }
    }
  }
  out.sort((a, b) => b.yearlyCost - a.yearlyCost);
  return out;
}

/** Verknüpft Buchungen mit ihren Verträgen (contractId) */
export function linkContracts(txs, contracts) {
  const map = new Map();
  const known = new Set();
  for (const c of contracts) {
    known.add(c.id);
    for (const id of c.txIds || []) map.set(id, c.id);
  }
  return txs.map(t => {
    const id = map.get(t.id) || null;
    const keep = !id && t.contractId && known.has(t.contractId) ? t.contractId : null;
    const next = id || keep || null;
    return (t.contractId || null) === next ? t : { ...t, contractId: next };
  });
}
