// Gesamtlauf mit den echten (geschwärzten) Nutzerdokumenten: Erkennung → Parser → Zuordnung → Beleg-Abgleich
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { detectType } from '../src/lib/detect/index.js';
import { parse } from '../src/lib/parsers/index.js';
import { normalizeCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions } from '../src/lib/classify/rules.js';
import { applyReceipts } from '../src/lib/analyze/receipts.js';
import { flagTaxDocument } from '../src/lib/classify/taxFlags.js';

const load = (name) => {
  const { pages } = JSON.parse(fs.readFileSync(new URL(`./fixtures/real-ocr/${name}.json`, import.meta.url), 'utf8'));
  return { kind: 'pdf', ocr: true, ocrConfidence: 75, pages, text: pages.map(p => p.text).join('\n') };
};
const run = async (name) => {
  const ex = load(name), meta = { name: `${name}.pdf`, ext: 'pdf' };
  const det = detectType(ex, meta);
  return { det, res: await parse(det, ex, meta) };
};

describe('echte Bank- und Depotdokumente', () => {
  it.each([
    ['comdirect_finanzreport', 'kontoauszug', null],
    ['dkb_soll_haben', 'kontoauszug', null],
    ['comdirect_wertpapierkauf', 'wertpapier', 'kauf'],
    ['comdirect_dividende', 'wertpapier', 'dividende'],
    ['comdirect_kosteninfo_1', 'wertpapier', 'kosteninfo'],
    ['comdirect_kosteninfo_2', 'wertpapier', 'kosteninfo'],
    ['mlp_depotreport', 'wertpapier', 'depotreport'],
  ])('%s → %s %s', async (name, type, subtype) => {
    const { det, res } = await run(name);
    expect(det.type).toBe(type);
    if (subtype) expect(res.document.subtype).toBe(subtype);
  });

  it('DKB-Auszug mit geschwärzten Beträgen: klare Diagnose, erwartet 54 Buchungen', async () => {
    const { res } = await run('dkb_soll_haben');
    const d = res.document.fields.diagnostics;
    expect(d.expectedCount).toBe(54);
    expect(d.problems.join(' ')).toMatch(/keine Beträge lesbar/);
  });

  it('Wertpapierkauf wird Beleg der Girobuchung; Kosteninformation nie', async () => {
    const kauf = (await run('comdirect_wertpapierkauf')).res.document;
    const info = (await run('comdirect_kosteninfo_1')).res.document;
    const docs = [{ ...kauf, id: 'k' }, { ...info, id: 'i' }];
    const base = { accountId: 'g', currency: 'EUR', counterpartyIban: null, mandateId: null, creditorId: null, isTransfer: false, category: null, subcategory: null };
    let txs = [
      { ...base, id: 't1', bookingDate: '2026-08-21', amount: -107730, counterpartyRaw: '', bookingText: 'Wertpapiere', purpose: 'WPKNR: 123456 ISIN: US0000000000' },
      { ...base, id: 't2', bookingDate: '2026-11-03', amount: -132, counterpartyRaw: 'Bäckerei', bookingText: 'Kartenzahlung', purpose: '' },
    ];
    txs = classifyTransactions(txs.map(t => ({ ...t, counterparty: normalizeCounterparty(t) })), { rules: [] });
    expect(`${txs[0].category}/${txs[0].subcategory}`).toBe('vorsorge_sparen/sparplan_depot');
    const linked = applyReceipts(txs, docs, []);
    expect(linked[0].receiptDocId).toBe('k');
    expect(linked.some(t => t.receiptDocId === 'i')).toBe(false);
  });

  it('Dividende ist steuerrelevant (Kapitalerträge), Kosteninformation nicht', async () => {
    const div = (await run('comdirect_dividende')).res.document;
    const info = (await run('comdirect_kosteninfo_2')).res.document;
    expect(div.amount).toBe(332);
    expect(flagTaxDocument(div).taxRelevant).toBe(true);
    expect(flagTaxDocument(info).taxRelevant).toBeFalsy();
  });
});
