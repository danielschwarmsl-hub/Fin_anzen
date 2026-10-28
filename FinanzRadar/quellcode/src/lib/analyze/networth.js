// Nettovermögen: Konten (Kontostand), Depots (Bestände), Rentenverträge (Fondsguthaben/Rückkaufswert), Sachwerte.
// computeNetWorth(accounts, valuations, holdings, transactions, assets) → { total, byAccount, series, assetsTotal }
const DEPOT_KINDS = new Set(['depot']);
const DAY = 864e5;
const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
const isoOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** Summe nach Tag aufsteigend → { days:number[], cum:number[] } für Bereichssummen per Binärsuche */
function prefix(txs) {
  const rows = txs.filter(t => t.bookingDate && t.amount).map(t => [dayNum(t.bookingDate), t.amount]).sort((a, b) => a[0] - b[0]);
  const days = rows.map(r => r[0]);
  const cum = [];
  let s = 0;
  for (const r of rows) { s += r[1]; cum.push(s); }
  return { days, cum };
}
// Summe aller Buchungen mit Tag <= d
function upTo(p, d) {
  let lo = 0, hi = p.days.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (p.days[m] <= d) lo = m + 1; else hi = m; }
  return lo ? p.cum[lo - 1] : 0;
}

export function assetValue(a) {
  return a.currentValue ?? a.purchasePrice ?? a.price ?? 0;
}

/**
 * Wert eines Kontos zum Stichtag d (Tagesnummer) oder null, wenn dann noch nichts bekannt war.
 * Anker = jüngste Bewertung bis d (sonst die älteste, rückwärts gerechnet); Umsätze verschieben den Anker.
 */
function accountValueAt(acc, d) {
  if (acc.holdingsByDay) {
    // Depot: Bestand der jüngsten Momentaufnahme bis d
    let best = null;
    for (const h of acc.holdingsByDay) if (h.day <= d) best = h; else break;
    if (best) return { value: best.value, date: isoOf(best.day) };
    if (!acc.vals.length) return null;
  }
  if (!acc.vals.length) return null;
  let anchor = null;
  for (const v of acc.vals) if (v.day <= d) anchor = v; else break;
  if (!anchor) {
    // vor der ersten Bewertung: nur sinnvoll, wenn es Umsätze gibt, die davor liegen
    if (!acc.txp.days.length || acc.txp.days[0] > d) return null;
    const first = acc.vals[0];
    return { value: first.value - (upTo(acc.txp, first.day) - upTo(acc.txp, d)), date: isoOf(d) };
  }
  const delta = upTo(acc.txp, d) - upTo(acc.txp, anchor.day);
  return { value: anchor.value + delta, date: anchor.day === d || !delta ? isoOf(anchor.day) : isoOf(d) };
}

export function computeNetWorth(accounts = [], valuations = [], holdings = [], transactions = [], assets = []) {
  const txByAcc = new Map(), valByAcc = new Map(), holdByAcc = new Map();
  for (const t of transactions) { if (!t.accountId) continue; if (!txByAcc.has(t.accountId)) txByAcc.set(t.accountId, []); txByAcc.get(t.accountId).push(t); }
  for (const v of valuations) { if (!v.accountId || v.value == null || !v.date) continue; if (!valByAcc.has(v.accountId)) valByAcc.set(v.accountId, []); valByAcc.get(v.accountId).push(v); }
  for (const h of holdings) { if (!h.accountId || !h.date) continue; if (!holdByAcc.has(h.accountId)) holdByAcc.set(h.accountId, []); holdByAcc.get(h.accountId).push(h); }

  const accs = [];
  for (const a of accounts) {
    if (a.excludeFromNetWorth || a.hidden) continue;
    const vals = (valByAcc.get(a.id) || []).map(v => ({ day: dayNum(v.date), value: v.value })).sort((x, y) => x.day - y.day);
    // gleiche Tage: letzte gewinnt
    const uniq = [];
    for (const v of vals) { if (uniq.length && uniq[uniq.length - 1].day === v.day) uniq[uniq.length - 1] = v; else uniq.push(v); }
    let holdingsByDay = null;
    const hs = holdByAcc.get(a.id);
    if (hs?.length) {
      // Derselbe Bestand kann mehrfach vorliegen (Depotliste zweimal am selben Tag exportiert): je Tag zählt nur ein Dokument
      const perDay = new Map(); // Datum → Dokument → Summe
      for (const h of hs) {
        let docs = perDay.get(h.date);
        if (!docs) perDay.set(h.date, docs = new Map());
        docs.set(h.documentId ?? '', (docs.get(h.documentId ?? '') || 0) + (h.value || 0));
      }
      const m = new Map([...perDay].map(([date, docs]) => [date, [...docs.values()].at(-1)]));
      holdingsByDay = [...m.entries()].map(([date, value]) => ({ day: dayNum(date), value })).sort((x, y) => x.day - y.day);
    }
    const isDepot = DEPOT_KINDS.has(a.kind) || !!holdingsByDay;
    // Depot: Umsätze verändern den Bestandswert nicht (Kurse stecken im Bestand)
    const txp = isDepot ? prefix([]) : prefix(txByAcc.get(a.id) || []);
    accs.push({ a, vals: uniq, txp, holdingsByDay: isDepot ? holdingsByDay : null });
  }

  // Zeitachse
  let minDay = Infinity, maxDay = -Infinity;
  const touch = (d) => { if (d < minDay) minDay = d; if (d > maxDay) maxDay = d; };
  for (const x of accs) {
    x.vals.forEach(v => touch(v.day));
    x.holdingsByDay?.forEach(h => touch(h.day));
    x.txp.days.forEach(touch);
  }
  const assetList = (assets || []).filter(a => assetValue(a) !== 0);
  const assetsTotal = assetList.reduce((s, a) => s + assetValue(a), 0);

  // Aktueller Stand (jüngster bekannter Tag)
  const byAccount = [];
  let total = 0;
  if (maxDay >= 0 && Number.isFinite(maxDay)) {
    for (const x of accs) {
      // Jede Quelle zählt mit ihrem eigenen letzten Stand (Rentenvertrag: Stichtag, Konto: nach letztem Umsatz)
      const lastOwn = Math.max(-Infinity, ...x.vals.map(v => v.day), ...(x.holdingsByDay || []).map(h => h.day), ...(x.txp.days.length ? [x.txp.days[x.txp.days.length - 1]] : []));
      const r = accountValueAt(x, lastOwn);
      if (!r) continue;
      byAccount.push({ accountId: x.a.id, name: x.a.name || x.a.institution || 'Konto', kind: x.a.kind, value: r.value, date: r.date });
      total += r.value;
    }
  }
  total += assetsTotal;

  // Monatliche Reihe
  const series = [];
  if (Number.isFinite(minDay)) {
    const start = new Date(minDay * DAY);
    let y = start.getUTCFullYear(), m = start.getUTCMonth();
    const points = [];
    for (;;) {
      const end = Math.floor(Date.UTC(y, m + 1, 0) / DAY);
      if (end >= maxDay) break;
      if (end >= minDay) points.push(end);
      m++; if (m > 11) { m = 0; y++; }
    }
    points.push(maxDay);
    for (const d of points) {
      let v = 0, any = false;
      for (const x of accs) {
        let r = accountValueAt(x, d);
        // Reine Stichtagswerte (Depot, Rente) vor dem ersten bekannten Stand konstant fortschreiben – sonst springt die Kurve künstlich
        if (!r && !x.txp.days.length) {
          const first = x.holdingsByDay?.[0] || x.vals[0];
          if (first) r = { value: first.value };
        }
        if (r) { v += r.value; any = true; }
      }
      for (const a of assetList) {
        const pd = a.purchaseDate ? dayNum(a.purchaseDate) : null;
        if (pd == null || pd <= d) { v += assetValue(a); any = true; }
      }
      if (any) series.push({ date: isoOf(d), value: v });
    }
  }
  return { total, byAccount, series, assetsTotal };
}
