import Dexie from 'dexie';

export const db = new Dexie('finanzradar');
db.version(1).stores({
  sources: 'id, kind',
  files: 'id, sourceId, status, ext, importedAt',
  blobs: 'id',
  documents: 'id, fileId, type, date, accountId, taxRelevant, needsReview',
  accounts: 'id, kind, iban, institution',
  transactions: 'id, accountId, documentId, bookingDate, category, dedupeKey, transferPairId, contractId, taxRelevant, needsReview',
  lineItems: 'id, documentId',
  contracts: 'id, kind, provider',
  holdings: 'id, accountId, documentId, isin',
  valuations: 'id, accountId, date',
  assets: 'id, category',
  rules: 'id',
  settings: 'key',
});

export const TABLES = ['sources', 'files', 'documents', 'accounts', 'transactions', 'lineItems', 'contracts', 'holdings', 'valuations', 'assets', 'rules'];

export async function loadAll() {
  const out = {};
  await Promise.all(TABLES.map(async t => { out[t] = await db[t].toArray(); }));
  return out;
}

export async function getSetting(key, fallback = null) {
  const r = await db.settings.get(key);
  return r ? r.value : fallback;
}
export async function setSetting(key, value) { await db.settings.put({ key, value }); }

export async function wipeAll() {
  await db.delete();
  await db.open();
}
