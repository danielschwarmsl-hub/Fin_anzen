// Ein Szenario aus tests/fixtures/scenarios durch den echten Importer + Nachverarbeitung schicken und die Ist-Werte messen.
// Abhängigkeiten werden übergeben, damit Vitest (vi.mock) und scripts/score.mjs (Loader-Hook) dieselbe Logik nutzen.
import fs from 'node:fs';
import path from 'node:path';
import { fileItem } from './fake-db.js';

export const SCENARIO_DIR = path.resolve(import.meta.dirname, '../fixtures/scenarios');
export const SCENARIOS = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, 'EXPECTED.json'), 'utf8')).scenarios;

/** deps: { db, app, runImport, ensureSource, computeInsights } → { expense, income, saving, transactions, accounts, transferPairs, data, insights } */
export async function runScenario(id, { db, app, runImport, ensureSource, computeInsights }) {
  const sc = SCENARIOS[id];
  db.reset();
  app.progress.running = false;
  const source = await ensureSource({ kind: 'local', name: 'Szenario ' + id, root: id });
  const items = sc.files.map(f => fileItem(f, fs.readFileSync(path.join(SCENARIO_DIR, f))));
  await runImport(items, source, { concurrency: 1 });
  const snap = db.snapshot();
  const data = { accounts: snap.accounts, transactions: snap.transactions, documents: snap.documents, contracts: snap.contracts, holdings: snap.holdings, valuations: snap.valuations, assets: snap.assets };
  const insights = computeInsights(data, sc.range);
  const ids = new Set(snap.transactions.map(t => t.id));
  const byId = new Map(snap.transactions.map(t => [t.id, t]));
  const transferPairs = snap.transactions.filter(t => t.transferPairId && ids.has(t.transferPairId) && byId.get(t.transferPairId).transferPairId === t.id).length / 2;
  return {
    expense: insights.totals.expense, income: insights.totals.income, saving: insights.totals.saving,
    transactions: snap.transactions.length, accounts: snap.accounts.length, transferPairs,
    errors: [...(app.progress.errors || [])], data, insights,
  };
}

/** Kurzbeschreibung der gespeicherten Buchungen (für Fehlermeldungen) */
export function describeTx(data) {
  const acc = new Map(data.accounts.map(a => [a.id, a.name]));
  return data.transactions.map(t => `${acc.get(t.accountId)} ${t.bookingDate} ${(t.amount / 100).toFixed(2)} ${t.counterparty || t.counterpartyRaw} [${t.category}${t.isTransfer ? ', Umbuchung' : ''}]`).sort().join('\n');
}
