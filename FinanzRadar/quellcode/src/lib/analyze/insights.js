// Kennzahlen, Kategorien, Steuern, Nettovermögen und Geldfluss (Sankey) für einen Zeitraum.
// computeInsights(data, { from, to, accountIds, showTaxes }) → Insights (siehe SPEC)
// Alle Beträge in Cent. Umbuchungen zwischen eigenen Konten zählen weder als Einnahme noch als Ausgabe.
import { getCategory } from '../classify/categories.js';
import { computeNetWorth } from './networth.js';
import { estimateVat } from './vat.js';

const SAVING_KINDS = new Set(['depot', 'tagesgeld', 'festgeld', 'sparen', 'rente', 'bausparen', 'sparkonto']);
const isSavingsAccount = (a) => !!a && (SAVING_KINDS.has(a.kind) || /tagesgeld|festgeld|sparkonto|depot|bausparen/i.test(a.name || ''));
const SRC_COLOR = '#2fb67c', TAX_COLOR = '#8a6fd1', ACC_COLOR = '#6f86b3', NEUTRAL = '#9aa3ad', DRAW_COLOR = '#d6a43a';

const monthKey = (iso) => iso.slice(0, 7);
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ey, em] = to.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 600) break;
  }
  return out;
}
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

/** Lohn-/Steuerdaten (payroll) für den Zeitraum: Abrechnungen, ggf. hochgerechnet; sonst Lohnsteuerbescheinigung anteilig */
function payrollFor(documents, salaryMonths, months, from, to) {
  const FIELDS = ['gross', 'lohnsteuer', 'soli', 'kirchensteuer', 'kv', 'pv', 'rv', 'av'];
  const zero = () => Object.fromEntries(FIELDS.map(f => [f, 0]));
  const slips = documents.filter(d => d.type === 'lohn' && d.payroll && d.payroll.gross);
  const inPeriod = slips.filter(d => {
    const mk = d.payroll.period || (d.periodFrom || d.date || '').slice(0, 7);
    return mk && mk >= months[0] && mk <= months[months.length - 1];
  });
  const acc = zero();
  let monthsCovered = 0, estimated = false;
  const seen = new Set();
  for (const d of inPeriod) {
    const mk = d.payroll.period || (d.periodFrom || d.date).slice(0, 7);
    if (seen.has(mk)) continue; // doppelte Abrechnung desselben Monats
    seen.add(mk);
    for (const f of FIELDS) acc[f] += d.payroll[f] || 0;
    monthsCovered++;
  }
  if (monthsCovered) {
    // Fehlende Monate mit Gehaltseingang aus dem Durchschnitt der vorhandenen Abrechnungen ergänzen
    const missing = [...salaryMonths].filter(m => !seen.has(m)).length;
    if (missing > 0) {
      for (const f of FIELDS) acc[f] += Math.round(acc[f] / monthsCovered * missing);
      estimated = true;
      monthsCovered += missing;
    }
  } else {
    // Jahresbescheinigung: nächstliegendes Jahr, anteilig nach Monaten mit Gehalt (sonst Monate des Zeitraums)
    const certs = documents.filter(d => d.type === 'lohnsteuerbescheinigung' && d.payroll && d.payroll.gross);
    if (!certs.length) return null;
    const y0 = Number(from.slice(0, 4));
    const yearOf = (d) => Number(d.fields?.year || (d.periodFrom || d.date || '').slice(0, 4)) || y0;
    certs.sort((a, b) => Math.abs(yearOf(a) - y0) - Math.abs(yearOf(b) - y0) || yearOf(b) - yearOf(a));
    const c = certs[0];
    const n = salaryMonths.size || (yearOf(c) === y0 ? months.length : 0);
    if (!n) return null;
    for (const f of FIELDS) acc[f] = Math.round((c.payroll[f] || 0) * n / 12);
    estimated = !(months.length === 12 && yearOf(c) === y0);
    monthsCovered = n;
  }
  const ded = acc.lohnsteuer + acc.soli + acc.kirchensteuer + acc.kv + acc.pv + acc.rv + acc.av;
  return { ...acc, net: acc.gross - ded, months: monthsCovered, estimated };
}

export function computeInsights(data, opts = {}) {
  const accounts = data?.accounts || [], documents = data?.documents || [], contracts = data?.contracts || [];
  const allTx = data?.transactions || [];
  const accIds = opts.accountIds && opts.accountIds.length ? new Set(opts.accountIds) : null;
  const showTaxes = opts.showTaxes !== false;
  const accById = new Map(accounts.map(a => [a.id, a]));
  const txById = new Map();
  for (const t of allTx) txById.set(t.id, t);

  let from = opts.from, to = opts.to;
  if (!from || !to) {
    let lo = null, hi = null;
    for (const t of allTx) if (t.bookingDate) { if (!lo || t.bookingDate < lo) lo = t.bookingDate; if (!hi || t.bookingDate > hi) hi = t.bookingDate; }
    from = from || lo || new Date().toISOString().slice(0, 10);
    to = to || hi || from;
  }
  const months = monthsBetween(from, to);

  const txs = allTx.filter(t => t.bookingDate && t.bookingDate >= from && t.bookingDate <= to && (!accIds || accIds.has(t.accountId)));

  // ---------------------------------------------------------------- Linien (Aufteilungen berücksichtigen)
  const monthIdx = new Map(months.map((m, i) => [m, i]));
  const byMonth = months.map(month => ({ month, income: 0, expense: 0, saving: 0, net: 0 }));
  const catNet = new Map(); // id → { amount, subs: Map }
  const incSrc = new Map(); // sub → amount
  const merchants = new Map();
  const accIncome = new Map(), accExpense = new Map(), accSaving = new Map(); // accountId → Map
  const addTo = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  const addNested = (m, a, k, v) => { let x = m.get(a); if (!x) m.set(a, x = new Map()); addTo(x, k, v); };
  let income = 0, expense = 0, saving = 0, transfers = 0, salary = 0;
  const salaryMonths = new Set(), salaryByAcc = new Map();
  let needsReview = 0, taxFlagged = 0, uncategorized = 0;

  for (const t of txs) {
    if (t.needsReview && !t.reviewed && !t.isTransfer) needsReview++;
    if (t.taxRelevant) taxFlagged++;
    const mi = monthIdx.get(monthKey(t.bookingDate));
    if (t.isTransfer || t.category === 'umbuchung') {
      if (t.amount < 0) transfers += -t.amount;
      // Sparen: Überweisung von normalem Konto auf Spar-/Depot-/Rentenkonto
      const own = accById.get(t.accountId);
      const other = accById.get(t.transferAccountId || txById.get(t.transferPairId)?.accountId);
      if (own && other && !isSavingsAccount(own) && isSavingsAccount(other)) {
        const v = -t.amount;
        saving += v;
        if (mi != null) byMonth[mi].saving += v;
        addNested(accSaving, t.accountId, 'saving', v);
      }
      continue;
    }
    if (!t.category || t.category === 'sonstiges') uncategorized++;
    const parts = t.splits?.length ? t.splits : [{ amount: t.amount, category: t.category, subcategory: t.subcategory }];
    for (const p of parts) {
      const cat = getCategory(p.category) || getCategory('sonstiges');
      const amt = p.amount || 0;
      if (!amt) continue;
      if (cat.kind === 'income') {
        income += amt; if (mi != null) byMonth[mi].income += amt;
        addTo(incSrc, p.subcategory || 'sonstiges', amt);
        addNested(accIncome, t.accountId, p.subcategory || 'sonstiges', amt);
        if (cat.id === 'einkommen' && p.subcategory === 'gehalt' && amt > 0) { salary += amt; salaryMonths.add(monthKey(t.bookingDate)); addTo(salaryByAcc, t.accountId, amt); }
      } else if (cat.kind === 'saving') {
        saving += -amt; if (mi != null) byMonth[mi].saving += -amt;
        addNested(accSaving, t.accountId, 'saving', -amt);
      } else {
        // Ausgabe (negativ) bzw. Erstattung (positiv) – netto je Kategorie
        const e = -amt;
        if (mi != null) byMonth[mi].expense += e;
        let c = catNet.get(cat.id);
        if (!c) catNet.set(cat.id, c = { amount: 0, subs: new Map() });
        c.amount += e; addTo(c.subs, p.subcategory || '_none', e);
        addNested(accExpense, t.accountId, cat.id, e);
        if (e > 0 && cat.id !== 'bargeld') {
          const name = t.counterparty || t.counterpartyRaw || 'Unbekannt';
          let m = merchants.get(name);
          if (!m) merchants.set(name, m = { name, amount: 0, count: 0, cats: new Map() });
          m.amount += e; m.count++; addTo(m.cats, cat.id, e);
        }
      }
    }
  }

  // Kategorien (nur positive Nettoausgaben)
  const byCategory = [];
  for (const [id, c] of catNet) {
    if (c.amount <= 0) continue;
    const cat = getCategory(id);
    byCategory.push({
      id, label: cat.label, color: cat.color, amount: c.amount, share: 0,
      subs: [...c.subs].filter(([, v]) => v > 0).map(([sid, v]) => ({ id: sid === '_none' ? 'sonstiges' : sid, label: sid === '_none' ? 'Allgemein' : (cat.subs.find(s => s.id === sid)?.label || sid), amount: v })).sort((a, b) => b.amount - a.amount),
    });
  }
  byCategory.sort((a, b) => b.amount - a.amount);
  expense = sum(byCategory, c => c.amount);
  for (const c of byCategory) c.share = expense ? c.amount / expense : 0;
  for (const m of byMonth) { m.expense = Math.max(0, m.expense); m.net = m.income - m.expense; }

  const incomeBySource = [...incSrc].filter(([, v]) => v > 0).map(([id, v]) => ({
    id, label: getCategory('einkommen').subs.find(s => s.id === id)?.label || id, amount: v,
  })).sort((a, b) => b.amount - a.amount);

  const topMerchants = [...merchants.values()].sort((a, b) => b.amount - a.amount).slice(0, 15)
    .map(m => ({ name: m.name, amount: m.amount, count: m.count, category: [...m.cats].sort((a, b) => b[1] - a[1])[0][0] }));

  const totals = {
    income, expense, saving, net: income - expense,
    savingsRate: income > 0 ? Math.max(-1, Math.min(1, saving / income)) : 0,
    transfers,
  };

  // ---------------------------------------------------------------- Verträge
  const activeContracts = contracts.filter(c => c && c.active !== false && !c.hidden && c.kind !== 'einkommen' && c.kind !== 'vorsorge' && (c.amount || 0) < 0
    && (!accIds || !c.accountId || accIds.has(c.accountId)));
  const perYear = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, halfyearly: 2, yearly: 1 };
  const yearlyOf = (c) => c.yearlyCost ?? Math.round(Math.abs(c.amount) * (perYear[c.interval] || 12));
  const recurring = {
    monthlyTotal: Math.round(sum(activeContracts, c => c.monthly != null ? Math.abs(c.monthly) : yearlyOf(c) / 12)),
    yearlyTotal: sum(activeContracts, yearlyOf),
    count: activeContracts.length,
  };

  // ---------------------------------------------------------------- Steuern
  const docsInPeriod = documents.filter(d => d.date && d.date >= from && d.date <= to);
  const payroll = payrollFor(documents, salaryMonths, months, from, to);
  const vatTxs = txs.filter(t => !t.isTransfer);
  const vatEstimate = estimateVat(vatTxs, documents.filter(d => !accIds || !d.accountId || accIds.has(d.accountId)), { from, to });
  // Kapitalertragsteuer aus Jahresbescheinigungen (anteilig für Monate des Zeitraums im Bescheinigungsjahr)
  let capitalGainsTax = 0;
  for (const d of documents) {
    if (d.type !== 'steuerbescheinigung') continue;
    const y = String(d.fields?.year || '');
    const n = months.filter(m => m.startsWith(y)).length;
    if (y && n) capitalGainsTax += Math.round((d.fields?.steuernGesamt || 0) * n / 12);
  }
  if (!capitalGainsTax) capitalGainsTax = sum(txs.filter(t => t.category === 'steuern_abgaben' && t.subcategory === 'kapitalertragsteuer' && t.amount < 0), t => -t.amount);
  const directTaxes = sum(txs.filter(t => t.category === 'steuern_abgaben' && t.subcategory !== 'kapitalertragsteuer' && t.amount < 0 && !t.isTransfer), t => -t.amount);
  const payrollDeductions = payroll ? payroll.lohnsteuer + payroll.soli + payroll.kirchensteuer + payroll.kv + payroll.pv + payroll.rv + payroll.av : 0;
  const taxTotal = payrollDeductions + vatEstimate.total + capitalGainsTax + directTaxes;
  const grossBase = (payroll ? payroll.gross + (income - salary) : income);
  const taxes = {
    payroll: payroll && payroll.gross ? payroll : null,
    vatEstimate, capitalGainsTax,
    total: taxTotal,
    quote: grossBase > 0 ? taxTotal / grossBase : 0,
  };

  // ---------------------------------------------------------------- Nettovermögen
  const selAccounts = accIds ? accounts.filter(a => accIds.has(a.id)) : accounts;
  const nwIds = new Set(selAccounts.map(a => a.id));
  // Reicht der Zeitraum bis zur jüngsten Buchung (Voreinstellung "Alles"), zählt der aktuelle Stand: Kontostände und Depots
  // tragen das Datum des Auszugsendes bzw. Stichtags und liegen oft hinter der letzten Buchung.
  let lastBooking = '';
  for (const t of allTx) if (t.bookingDate && t.bookingDate > lastBooking) lastBooking = t.bookingDate;
  const nwTo = to >= lastBooking ? '9999-12-31' : to;
  const nw = computeNetWorth(
    selAccounts,
    (data?.valuations || []).filter(v => nwIds.has(v.accountId) && v.date <= nwTo),
    (data?.holdings || []).filter(h => nwIds.has(h.accountId) && (!h.date || h.date <= nwTo)),
    allTx.filter(t => nwIds.has(t.accountId) && t.bookingDate && t.bookingDate <= nwTo),
    accIds ? [] : (data?.assets || []).filter(a => !a.purchaseDate || a.purchaseDate <= nwTo),
  );
  const netWorth = {
    total: nw.total, byAccount: nw.byAccount,
    series: nw.series.filter(p => p.date >= from.slice(0, 7) + '-01' || p === nw.series[nw.series.length - 1]),
  };

  // ---------------------------------------------------------------- Sankey
  const sankey = buildSankey({
    accounts: accById, accIncome, accExpense, accSaving, salaryByAcc, salary, payroll, showTaxes,
    transfersFlow: transferFlows(txs, accById, txById, isSavingsAccount), byCategory,
  });

  return {
    period: { from, to, months },
    totals, byCategory, incomeBySource, byMonth, topMerchants, recurring, taxes, netWorth, sankey,
    flags: { needsReview, taxRelevant: taxFlagged + docsInPeriod.filter(d => d.taxRelevant).length, uncategorized },
  };
}

/** Nettofluss zwischen normalen eigenen Konten: [{ from, to, value }] */
function transferFlows(txs, accById, txById, isSav) {
  const dir = new Map();
  for (const t of txs) {
    if (!(t.isTransfer || t.category === 'umbuchung') || !(t.amount < 0)) continue;
    const own = accById.get(t.accountId);
    const otherId = t.transferAccountId || txById.get(t.transferPairId)?.accountId;
    const other = accById.get(otherId);
    if (!own || !other || own.id === other.id || isSav(own) || isSav(other)) continue;
    const k = t.accountId + '>' + otherId;
    dir.set(k, (dir.get(k) || 0) - t.amount);
  }
  const out = [];
  for (const [k, v] of dir) {
    const [a, b] = k.split('>');
    const back = dir.get(b + '>' + a) || 0;
    if (v > back) out.push({ from: a, to: b, value: v - back });
  }
  return cancelCycles(out);
}

/** Kreisflüsse (A→B→C→A) heben sich auf: Kontosalden bleiben gleich, das Sankey-Diagramm bleibt zyklenfrei. */
function cancelCycles(flows) {
  const edges = flows.map(f => ({ ...f }));
  for (let guard = 0; guard < 100; guard++) {
    const live = edges.filter(e => e.value > 0);
    const adj = new Map();
    for (const e of live) { if (!adj.has(e.from)) adj.set(e.from, []); adj.get(e.from).push(e); }
    const state = new Map(), stack = [];
    let cycle = null;
    const dfs = (u) => {
      state.set(u, 1);
      for (const e of adj.get(u) || []) {
        if (cycle) return;
        if (state.get(e.to) === 1) { cycle = [...stack.slice(stack.findIndex(x => x.from === e.to)), e]; if (stack.findIndex(x => x.from === e.to) < 0) cycle = [e]; return; }
        if (!state.get(e.to)) { stack.push(e); dfs(e.to); stack.pop(); }
      }
      state.set(u, 2);
    };
    for (const u of adj.keys()) { if (!state.get(u)) dfs(u); if (cycle) break; }
    if (!cycle) break;
    const m = Math.min(...cycle.map(e => e.value));
    for (const e of cycle) e.value -= m;
  }
  return edges.filter(e => e.value > 0);
}

// ---------------------------------------------------------------- Sankey-Aufbau
function buildSankey({ accounts, accIncome, accExpense, accSaving, salaryByAcc, salary, payroll, showTaxes, transfersFlow, byCategory }) {
  const nodes = new Map();
  const links = [];
  const node = (id, label, kind, color) => { if (!nodes.has(id)) nodes.set(id, { id, label, kind, color }); return id; };
  const link = (source, target, value) => { value = Math.round(value); if (value > 0 && source !== target) links.push({ source, target, value }); };
  const srcLabel = (id) => getCategory('einkommen').subs.find(s => s.id === id)?.label || id;

  // Top-9-Kategorien (global) + "Weitere"
  const top = new Set(byCategory.slice(0, 9).map(c => c.id));
  const catNode = (id) => {
    if (top.has(id)) { const c = getCategory(id); return node(id, c.label, 'category', c.color); }
    return node('weitere', 'Weitere', 'category', NEUTRAL);
  };
  const accNode = (id) => node(id, accounts.get(id)?.name || accounts.get(id)?.institution || 'Konto', 'account', ACC_COLOR);

  const accIds = new Set([...accIncome.keys(), ...accExpense.keys(), ...accSaving.keys(), ...transfersFlow.flatMap(f => [f.from, f.to])]);
  const inflow = new Map(), outflow = new Map();
  for (const id of accIds) { inflow.set(id, 0); outflow.set(id, 0); }
  const addIn = (id, v) => inflow.set(id, inflow.get(id) + v);
  const addOut = (id, v) => outflow.set(id, outflow.get(id) + v);

  // Einnahmen → Konten
  const ded = payroll && showTaxes && salary > 0 && payroll.net > 0 ? {
    f: salary / payroll.net,
    parts: [
      ['lohnsteuer', 'Lohnsteuer', payroll.lohnsteuer], ['soli', 'Solidaritätszuschlag', payroll.soli], ['kirchensteuer', 'Kirchensteuer', payroll.kirchensteuer],
      ['sv', 'Sozialversicherung', payroll.kv + payroll.pv + payroll.rv + payroll.av],
    ],
  } : null;
  const hasPayroll = !!(payroll && salary > 0);
  let dedSum = 0;
  if (ded) {
    const items = ded.parts.map(([id, label, v]) => [id, label, Math.round(v * ded.f)]).filter(x => x[2] > 0);
    dedSum = sum(items, x => x[2]);
    if (dedSum > 0) {
      const brutto = node('src:brutto', 'Brutto-Gehalt', 'source', SRC_COLOR);
      const netto = node('src:netto', 'Netto-Gehalt', 'source', SRC_COLOR);
      for (const [id, label, v] of items) link(brutto, node('tax:' + id, label, 'tax', TAX_COLOR), v);
      link(brutto, netto, salary);
    }
  }
  const salaryNode = dedSum > 0 ? 'src:netto' : node('src:gehalt', hasPayroll ? 'Netto-Gehalt' : 'Gehalt', 'source', SRC_COLOR);
  for (const [accId, v] of salaryByAcc) { if (v > 0) { link(salaryNode, accNode(accId), v); addIn(accId, v); } }

  // übrige Einnahmen, gekürzt auf 4 + "Weitere Einnahmen"
  const others = new Map();
  for (const [accId, m] of accIncome) for (const [sub, v] of m) if (sub !== 'gehalt' && v > 0) { if (!others.has(sub)) others.set(sub, new Map()); others.get(sub).set(accId, (others.get(sub).get(accId) || 0) + v); }
  const order = [...others].map(([sub, m]) => [sub, sum([...m.values()], x => x)]).sort((a, b) => b[1] - a[1]);
  const keep = new Set(order.slice(0, 4).map(x => x[0]));
  for (const [sub, m] of others) {
    const id = keep.has(sub) ? 'src:' + sub : 'src:weitere';
    const label = keep.has(sub) ? srcLabel(sub) : 'Weitere Einnahmen';
    const nid = node(id, label, 'source', SRC_COLOR);
    for (const [accId, v] of m) { link(nid, accNode(accId), v); addIn(accId, v); }
  }
  // gleiche Quelle→Konto-Links zusammenfassen
  mergeLinks(links);

  // Konto → Kategorien / Sparen
  for (const [accId, m] of accExpense) {
    const rest = { v: 0 };
    for (const [cat, v] of m) {
      if (v <= 0) continue;
      const tgt = catNode(cat);
      if (tgt === 'weitere') rest.v += v; else { link(accNode(accId), tgt, v); addOut(accId, v); }
    }
    if (rest.v > 0) { link(accNode(accId), catNode('__weitere__'), rest.v); addOut(accId, rest.v); }
  }
  for (const [accId, m] of accSaving) {
    const v = m.get('saving') || 0;
    if (v > 0) { link(accNode(accId), node('vorsorge_sparen', 'Sparen & Anlegen', 'saving', getCategory('vorsorge_sparen').color), v); addOut(accId, v); }
    else if (v < 0) { link(node('src:entnahme_sparen', 'Entnahme aus Sparen', 'source', DRAW_COLOR), accNode(accId), -v); addIn(accId, -v); }
  }
  // Umbuchungen zwischen normalen Konten
  for (const f of transfersFlow) { link(accNode(f.from), accNode(f.to), f.value); addOut(f.from, f.value); addIn(f.to, f.value); }

  // Konten ausgleichen: Defizit = Entnahme aus Bestand, Überschuss = Puffer
  for (const accId of accIds) {
    const diff = inflow.get(accId) - outflow.get(accId);
    if (diff > 0) link(accNode(accId), node('puffer', 'Puffer (Saldo)', 'saving', NEUTRAL), diff);
    else if (diff < 0) link(node('src:bestand', 'Entnahme aus Bestand', 'source', DRAW_COLOR), accNode(accId), -diff);
  }
  mergeLinks(links);

  // nur Knoten mit Links behalten
  const used = new Set(links.flatMap(l => [l.source, l.target]));
  return { nodes: [...nodes.values()].filter(n => used.has(n.id)), links };
}

function mergeLinks(links) {
  const m = new Map();
  for (const l of links) { const k = l.source + '\u0001' + l.target; m.set(k, (m.get(k) || 0) + l.value); }
  links.length = 0;
  for (const [k, v] of m) { const [s, t] = k.split('\u0001'); links.push({ source: s, target: t, value: v }); }
}
