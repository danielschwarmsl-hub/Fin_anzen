// Wiederkehrende Zahlungen (Abos, Versicherungen, Miete, Daueraufträge, Gehalt ...) erkennen.
// detectRecurring(txs, userContracts) → Contract[]   linkContracts(txs, contracts) → txs mit contractId
// linkContractDocs(contracts, documents, txs, previous) → Verträge mit Vertragsdokument; Dokumente ohne Zahlung als Vertrag mit noPayments
// Bekannte Abo-Anbieter (Händlerliste mit recurringHint) werden über ihren Händlereintrag gruppiert – auch hinter Debitkarte,
// PayPal oder Amazon – und gelten schon ab der ersten Zahlung als Vertrag (fromKnownProvider).
import { fold, findMerchant, findSubscription } from '../classify/merchants.de.js';

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
// Bekannter Anbieter: Abbuchungstag schwankt um bis zu ±5 Tage (Abstand zweier Zahlungen also bis ±10), Preiserhöhung bis +30 %
const KNOWN_DAY_JITTER = 5;
const KNOWN_PRICE_TOL = 0.3;

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
  for (const [name, c, baseTol] of CLASSES) {
    // Rhythmus des bekannten Anbieters: schwankender Abbuchungstag (z. B. Kartenzahlung, Wochenende) tolerieren
    const tol = name === hintInterval && c >= 30 ? Math.max(baseTol, 2 * KNOWN_DAY_JITTER) : baseTol;
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

/**
 * Bekannter Abo-Anbieter ohne belastbare Serie (eine Zahlung, unregelmäßige Abstände): Vertrag aus der jüngsten Zahlung
 * und den unmittelbar vorangehenden Zahlungen ähnlicher Höhe (Preiserhöhung bis +30 %); Rhythmus aus dem recurringHint.
 * Nur für Abos/Versicherungen und nicht für Läden mit Einzelkäufen (noSingle: App-/Spiele-Stores).
 */
function knownSingle(items, known) {
  if (!known?.recurringHint || known.noSingle) return null;
  const list = items.filter(i => !i.tx.isTransfer && i.tx.category !== 'umbuchung' && i.tx.amount < 0);
  if (!list.length) return null;
  const last = list[list.length - 1];
  if (!['abo', 'versicherung'].includes(kindOf(last.tx.category, last.tx.subcategory, []))) return null;
  let from = list.length - 1;
  while (from > 0 && Math.abs(list[from - 1].amt - last.amt) <= list[from - 1].amt * KNOWN_PRICE_TOL) from--;
  const sel = list.slice(from);
  const firstAmt = sel[0].amt;
  const priceChange = Math.abs(firstAmt - last.amt) > firstAmt * PLATEAU_TOL
    ? { from: firstAmt, to: last.amt, date: sel.find(i => Math.abs(i.amt - firstAmt) > firstAmt * PLATEAU_TOL).tx.bookingDate } : null;
  return { items: sel, res: { interval: known.recurringHint, amount: last.amt, priceChange, count: sel.length, fromKnownProvider: true } };
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

/**
 * Bekannter Abo-Anbieter einer Abbuchung: Gegenpartei (Name/Rohtext) bzw. – hinter Debitkarte, PayPal, Amazon & Co. –
 * der Verwendungszweck. Ein anderer bekannter Händler ohne Abo-Hinweis als Gegenpartei schließt den Zweck aus.
 */
function knownOf(t) {
  if (!(t.amount < 0)) return null;
  const cp = fold(t.counterparty), raw = fold(t.counterpartyRaw);
  const direct = findMerchant(cp, '') || (raw && raw !== cp ? findMerchant(raw, '') : null);
  if (direct && !direct.intermediary && !direct.platform) return direct.recurringHint ? direct : null;
  return findSubscription('', `${raw} ${fold(t.purpose)}`);
}

function groupKey(t, known) {
  const sign = t.amount < 0 ? '-' : '+';
  const cp = nameKey(t);
  if (t.mandateId) return `${sign}m:${t.mandateId}`;
  if (t.creditorId && cp) return `${sign}c:${t.creditorId}|${cp}`;
  // wechselnde Referenzen im Namen („AUDIBLE 4S7XK1“) oder Kartenumsatz ohne Händlernamen: über den Händlereintrag bündeln
  if (known) return `${sign}k:${known.id}`;
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
    if (!/^[-+][nk]:/.test(k)) continue;
    const rest = [];
    for (const it of items) {
      const targets = refBy.get(`${k[0]}|${nameKey(it.tx)}`);
      if (targets && targets.size === 1) groups.get([...targets][0]).push(it);
      else rest.push(it);
    }
    if (!rest.length) groups.delete(k);
    else if (rest.length !== items.length) { items.length = 0; items.push(...rest); }
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
 * @param {object[]} existingContracts bisherige Verträge – nur Nutzerverträge zählen (deren Anbieter wird nicht erneut erkannt)
 */
export function detectRecurring(txs, existingContracts = []) {
  // Umbuchungen (Abflüsse) laufen mit, damit Serien nicht reißen, wenn eine Rate als Umbuchung erkannt wurde;
  // Serien, die überwiegend aus Umbuchungen bestehen, werden verworfen (siehe build).
  const usable = txs.filter(t => t.bookingDate && t.amount && t.category !== 'bargeld'
    && (t.amount < 0 || (t.category === 'einkommen' && !t.isTransfer)));
  let latest = 0;
  for (const t of txs) if (t.bookingDate) { const d = dayNum(t.bookingDate); if (d > latest) latest = d; }

  const groups = new Map();
  const knownBy = new Map(); // Gruppenschlüssel → bekannter Anbieter (Händlereintrag)
  for (const t of usable) {
    const known = knownOf(t);
    const k = groupKey(t, known);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push({ day: dayNum(t.bookingDate), amt: Math.abs(t.amount), tx: t });
    if (known && !knownBy.has(k)) knownBy.set(k, known);
  }
  mergeUnreferenced(groups);

  const userNames = new Set(existingContracts.filter(c => c.source === 'user').map(c => fold(c.provider || c.name)));
  const out = [];
  const used = new Set();

  const build = (key, items, res, known = null) => {
    const list = items.map(i => i.tx);
    if (list.filter(t => !t.isTransfer && t.category !== 'umbuchung').length * 2 < list.length) return false;
    const sign = list[0].amount < 0 ? -1 : 1;
    let provider = mode(list.map(t => t.counterparty || t.counterpartyRaw)) || 'Unbekannt';
    // Kartenumsatz/Plattform als Gegenpartei („VISA …“, „Amazon“) oder Name mit Referenz („Audible 4S7XK1“): Name des bekannten Anbieters
    if (known) {
      const f = fold(provider), hit = known.re.exec(f);
      if (!hit || hit.index !== 0 || /\d/.test(f)) provider = known.name;
    }
    if (userNames.has(fold(provider))) return false;
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
    // IDs/Notizen/Art früherer Läufe übernimmt mergeContracts (store/postprocess.js)
    const idKey = `${key}|${res.interval}|${acc}`;
    out.push({
      id: 'ct_' + hash(idKey + (items.clusterBase ? '|' + items.clusterBase : '')),
      kind, provider, name: provider, category, subcategory: sub,
      interval: res.interval, amount, monthly: Math.round(res.amount * perYear / 12), firstDate, lastDate,
      nextDate: nextDateOf(lastDate, res.interval), accountId: acc, txIds: list.map(t => t.id), count: list.length,
      priceChange: pc, active, yearlyCost: Math.round(res.amount * perYear), source: 'auto',
      ...(res.fromKnownProvider ? { fromKnownProvider: true } : {}),
    });
    for (const t of list) used.add(t.id);
    return true;
  };

  for (const [key, items] of groups) {
    items.sort((a, b) => a.day - b.day);
    const known = knownBy.get(key) || null;
    if (items.length < 2 && !known) continue;
    const first = items[0].tx;
    // ÖPNV-Abo (Deutschlandticket über DB Vertrieb & Co.): monatlich
    const hint = known?.recurringHint || findMerchant(fold(first.counterparty || first.counterpartyRaw), '')?.recurringHint
      || (items[items.length - 1].tx.subcategory === 'oepnv' ? 'monthly' : null);
    const base = items.length >= 2 ? analyzeSeries(items, 3, hint) : null;
    if (base) { build(key, items, base, known); continue; }
    // Gemischte Gruppe (z. B. Amazon, Google): Cluster gleicher Beträge einzeln prüfen
    let built = false;
    if (items.length >= 4) {
      for (const cl of amountClusters(items)) {
        const r = analyzeSeries(cl, 3, hint);
        if (r) { cl.clusterBase = cl[0].amt; built = build(key, cl, r, known) || built; }
      }
    }
    // Bekannter Abo-Anbieter: schon die erste Zahlung (bzw. die jüngste Preisstufe) ist ein Vertrag
    if (!built && known) {
      const single = knownSingle(items, known);
      if (single) build(key, single.items, single.res, known);
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

// ---------------------------------------------------------------- Vertragsdokumente
const PER_YEAR = Object.fromEntries(CLASSES.map(c => [c[0], c[3]]));
const nameTokens = (s) => fold(s).split(' ').filter(w => w.length >= 3 && !['gmbh', 'and', 'der', 'die', 'das', 'und', 'deutschland', 'germany', 'service', 'online'].includes(w));
const contractRef = (s) => { const f = fold(s); return f.length >= 4 && /\d/.test(f) ? f : null; };
const sameName = (a, b) => {
  const x = nameTokens(a), y = nameTokens(b);
  return x.some(p => p.length >= 4 && y.some(q => q.length >= 4 && (p.startsWith(q) || q.startsWith(p))));
};
/** Preis eines Dokuments im Rhythmus des Vertrags (null, wenn nicht vergleichbar) */
function docPriceFor(f, interval) {
  if (f.price == null) return null;
  if (!f.interval || f.interval === interval) return f.price;
  const perYear = f.priceYearly ?? (f.priceMonthly != null ? f.priceMonthly * 12 : null);
  return perYear != null && PER_YEAR[interval] ? Math.round(perYear / PER_YEAR[interval]) : null;
}
const DOC_FIELDS = ['contractNumber', 'cancellationPeriod', 'startDate', 'term', 'product'];

/**
 * Verbindet Vertragsdokumente (type 'vertrag') mit erkannten Serien:
 * 1. Vertragsnummer im Verwendungszweck einer Zahlung der Serie (stärkster Schlüssel),
 * 2. sonst Anbieter + Betrag (±2 %) + Rhythmus – nur bei genau einem passenden Vertrag (sonst nächstliegender Betrag, Gleichstand → keiner).
 * Übernimmt Vertragsnummer, Kündigungsfrist, Beginn, Laufzeit, Produkt (bei Nutzerverträgen nur leere Felder).
 * Dokumente ohne passende Zahlung werden eigene Verträge mit noPayments: true (active: false → zählen nicht in Fixkosten).
 * @param {object[]} previous bisherige Verträge (Notiz, „ausgeblendet“, Art bleiben für Dokument-Verträge erhalten)
 */
export function linkContractDocs(contracts, documents = [], txs = [], previous = []) {
  const docs = (documents || []).filter(d => d.type === 'vertrag' && !d.ignored)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.id).localeCompare(String(b.id)));
  if (!docs.length) return contracts;
  const txById = new Map(txs.map(t => [t.id, t]));
  const textOf = new Map(contracts.map(c => [c.id, ' ' + (c.txIds || []).map(id => { const t = txById.get(id); return t ? fold(`${t.purpose || ''} ${t.endToEndId || ''} ${t.mandateId || ''}`) : ''; }).join(' ') + ' ']));
  const out = contracts.map(c => ({ ...c }));
  const linked = new Map(); // Vertrags-ID → Dokumente (neuestes zuerst)
  const rest = [];
  for (const d of docs) {
    const f = d.fields || {};
    const num = contractRef(f.contractNumber);
    let target = num ? out.find(c => !c.noPayments && textOf.get(c.id)?.includes(` ${num} `)) : null;
    let how = target ? 'nummer' : null;
    if (!target) {
      const provider = f.provider || d.issuer || d.institution;
      const hits = out.filter(c => !c.noPayments && c.amount < 0 && provider && sameName(provider, c.provider || c.name) && (!f.interval || c.interval === f.interval))
        .map(c => { const p = docPriceFor(f, c.interval); return { c, dist: p == null ? Infinity : Math.abs(Math.abs(c.amount) - p) / Math.max(1, p) }; })
        .filter(h => h.dist <= 0.02)
        .sort((a, b) => a.dist - b.dist);
      if (hits.length === 1 || (hits.length > 1 && hits[0].dist < hits[1].dist)) { target = hits[0].c; how = 'anbieter'; }
    }
    if (!target) { rest.push(d); continue; }
    if (!linked.has(target.id)) linked.set(target.id, []);
    linked.get(target.id).push({ d, how });
  }
  for (const c of out) {
    const list = linked.get(c.id);
    if (!list) continue;
    const f = list[0].d.fields || {};
    c.docId = list[0].d.id; c.docIds = list.map(x => x.d.id); c.docMatch = list[0].how;
    for (const k of DOC_FIELDS) if (f[k] != null && (c.source !== 'user' || c[k] == null)) c[k] = f[k];
  }
  // Dokumente ohne Zahlung: je Vertragsnummer bzw. Anbieter+Preis+Rhythmus ein Vertrag
  const prevById = new Map(previous.map(c => [c.id, c]));
  const groups = new Map();
  for (const d of rest) {
    const f = d.fields || {};
    const provider = f.provider || d.issuer || d.institution || null;
    const key = contractRef(f.contractNumber) || `${fold(provider)}|${f.price}|${f.interval}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  for (const list of groups.values()) {
    const d = list[0], f = d.fields || {};
    const provider = f.provider || d.issuer || d.institution || 'Unbekannt';
    const m = findMerchant(fold(provider), '');
    const interval = f.interval || 'monthly';
    const id = 'ctd_' + d.id;
    const old = prevById.get(id);
    const kind = old?.kindUser ? old.kind : m ? kindOf(m.category, m.sub, []) : 'sonstiges';
    const yearly = f.priceYearly ?? (f.price != null ? f.price * (PER_YEAR[interval] || 12) : null);
    out.push({
      id, source: 'doc', noPayments: true, active: false, kind, kindUser: old?.kindUser, note: old?.note, hidden: old?.hidden,
      provider, name: provider + (f.product ? ' ' + f.product : ''), category: m?.category || null, subcategory: m?.sub || null,
      interval, amount: f.price != null ? -f.price : null, monthly: yearly != null ? Math.round(yearly / 12) : null, yearlyCost: yearly,
      firstDate: f.startDate || d.date || null, lastDate: null, nextDate: null, accountId: null, txIds: [], count: 0, priceChange: null,
      docId: d.id, docIds: list.map(x => x.id), docMatch: null,
      ...Object.fromEntries(DOC_FIELDS.map(k => [k, f[k] ?? null])),
    });
  }
  return out;
}
