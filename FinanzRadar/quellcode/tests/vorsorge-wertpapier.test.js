// Rentenbausteine immer „Vorsorge & Sparen“ (nie „Versicherungen“), Wertpapier-Buchungen, Wertpapier-Belege, Steuer (Anlage KAP)
import { describe, it, expect } from 'vitest';
import { normalizeCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions } from '../src/lib/classify/rules.js';
import { flagTaxDocument, flagTaxTransaction } from '../src/lib/classify/taxFlags.js';
import { planReceipts, applyReceipts, isSecuritiesReceipt } from '../src/lib/analyze/receipts.js';

let seq = 0;
const tx = (o = {}) => ({
  id: 'vw' + ++seq, accountId: 'a1', bookingDate: '2026-03-01', amount: -1000, currency: 'EUR',
  counterparty: '', counterpartyRaw: '', counterpartyIban: null, purpose: '', bookingText: null,
  mandateId: null, creditorId: null, category: null, subcategory: null, isTransfer: false, ...o,
});
const prep = (list, rules = []) => classifyTransactions(list.map(t => ({ ...t, counterparty: normalizeCounterparty(t) })), { rules });
const C = (raw, purpose = '', amount = -10000, extra = {}) => prep([tx({ counterpartyRaw: raw, purpose, amount, ...extra })], extra.rules)[0];
const cat = (t) => `${t.category}/${t.subcategory}`;

describe('Rentenbausteine: immer Vorsorge & Sparen, auch beim Versicherer', () => {
  it.each([
    ['Allianz Lebensversicherungs-AG', 'Beitrag PrivatRente Vertrag 123', 'privatrente'],
    ['Alte Leipziger Lebensversicherung', 'Fondsrente Beitrag', 'privatrente'],
    ['Canada Life Assurance Europe plc', 'Beitrag Generation Basic plus Rentenversicherung', 'privatrente'],
    ['Canada Life', 'Beitrag Generation Basic plus', 'privatrente'],
    ['MLP Banking AG', 'VERMOEGENSDEPOT SAMMELBUCHUNG SPARPLAN WKN A0RPWH', 'sparplan_depot'],
    ['MLP Banking AG', 'VERMOEGENSDEPOT SAMMELBUCH UNG SPARPLAN WKN', 'sparplan_depot'],
    ['MLP Banking AG', 'VERMOEGENSDEPOT SAMMELBUCH UNG', 'sparplan_depot'],
    ['Swiss Life AG', 'Direktversicherung Beitrag', 'betriebsrente'],
    ['ERGO Vorsorge Lebensversicherung AG', 'Rürup Beitrag 03/2026', 'riester_ruerup'],
    ['ERGO Vorsorge Lebensversicherung AG', 'Beitrag Vertrag 4711', 'privatrente'],
    ['Stuttgarter Lebensversicherung a.G.', 'Beitrag Vertrag 123 fondsgebundene Rentenversicherung', 'privatrente'],
    ['Volkswohl Bund', 'Beitrag Pensionskasse', 'betriebsrente'],
    ['Nürnberger Lebensversicherung', 'Unterstützungskasse Beitrag', 'betriebsrente'],
    ['Allianz Pensionskasse AG', 'Beitrag 03/2026', 'betriebsrente'],
    ['Debeka Lebensversicherung', 'bAV Entgeltumwandlung', 'betriebsrente'],
    ['Generali Deutschland', 'Investmentdepot Beitrag', 'sparplan_depot'],
    ['Zurich Deutscher Herold', 'Vermögensverwaltung', 'sparplan_depot'],
    ['Condor Lebensversicherung', 'Zukunftsrente Beitrag', 'privatrente'],
    ['Condor', 'Zukunftsrente Beitrag', 'privatrente'],
    ['LV 1871', 'Basisrente', 'riester_ruerup'],
    ['AXA Lebensversicherung', 'Riester Vertrag 99', 'riester_ruerup'],
    ['Württembergische Lebensversicherung', 'Altersvorsorgevertrag', 'privatrente'],
    ['HanseMerkur', 'Rentenbaustein Beitrag', 'privatrente'],
    ['Wüstenrot Bausparkasse', 'Bausparvertrag Beitrag', 'bausparen'],
    ['Deka Investment', 'VL Sparplan', 'sparplan_depot'],
    ['Union Investment', 'vermögenswirksame Leistungen', 'sparplan_depot'],
  ])('%s – %s → vorsorge_sparen/%s', (raw, purpose, sub) => {
    const t = C(raw, purpose);
    expect(cat(t)).toBe(`vorsorge_sparen/${sub}`);
    expect(t.needsReview).toBe(false);
  });

  it.each([
    ['HanseMerkur', 'Haftpflicht', 'haftpflicht'],
    ['Allianz Versicherungs-AG', 'Kfz-Versicherung', 'kfz'],
    ['Debeka', 'Risikoleben', 'leben'],
    ['Alte Leipziger', 'Berufsunfähigkeit Beitrag', 'bu'],
    ['ARAG', 'Rechtsschutz', 'rechtsschutz'],
    ['Allianz', 'Hausrat Beitrag', 'hausrat'],
    ['Barmenia', 'Zahnzusatz', 'kranken_zusatz'],
    ['Signal Iduna', 'Unfallversicherung', 'unfall'],
  ])('Risikoversicherung bleibt Versicherung: %s – %s', (raw, purpose, sub) => {
    expect(cat(C(raw, purpose))).toBe(`versicherungen/${sub}`);
  });

  it('allgemeine Versicherungsregel ohne Händler: Rentenbaustein gewinnt, Risiko bleibt', () => {
    expect(cat(C('Unbekannte Versicherung AG', 'Beitrag Rentenversicherung Vertrag 1'))).toBe('vorsorge_sparen/privatrente');
    expect(cat(C('Unbekannte Versicherung AG', 'Beitrag Haftpflicht Vertrag 1'))).toBe('versicherungen/haftpflicht');
  });

  it('gesetzliche Rentenversicherung und Rentenzahlungen sind keine privaten Rentenbausteine', () => {
    expect(C('Deutsche Rentenversicherung Bund', 'Rentenzahlung 03/2026', 150000).category).toBe('einkommen');
    expect(cat(C('Allianz Lebensversicherungs-AG', 'Rente aus Rentenversicherung', 30000))).toBe('einkommen/rente');
  });

  it('Nutzerregel und Nutzerkorrektur gehen vor', () => {
    const rules = [{ id: 'r1', match: { field: 'counterparty', op: 'contains', value: 'Allianz' }, set: { category: 'versicherungen', subcategory: 'leben' } }];
    expect(cat(C('Allianz Lebensversicherungs-AG', 'Beitrag PrivatRente', -10000, { rules }))).toBe('versicherungen/leben');
    const [u] = classifyTransactions([tx({ counterparty: 'Canada Life', purpose: 'Rentenversicherung', category: 'versicherungen', subcategory: 'leben', categorySource: 'user' })]);
    expect(cat(u)).toBe('versicherungen/leben');
  });

  it('Umbuchung bleibt Umbuchung', () => {
    const [t] = classifyTransactions([tx({ counterparty: 'Ich', purpose: 'Sparplan', isTransfer: true, transferSource: 'user' })]);
    expect(t.category).toBe('umbuchung');
  });
});

describe('Wertpapier-Buchungen auf dem Girokonto', () => {
  it('Dividende/Kupon/Erträgnisgutschrift/Ausschüttung/Zinsgutschrift (Zufluss) → Einkommen › Kapitalerträge', () => {
    expect(cat(C('comdirect', 'ERTRAEGNISGUTSCHRIFT MICROSOFT CORP', 332))).toBe('einkommen/dividenden');
    expect(cat(C('comdirect Bank AG', 'Kupon 4,25% Bundesanleihe', 4250))).toBe('einkommen/dividenden');
    expect(cat(C('comdirect', 'Dividendengutschrift WKN 870747', 332))).toBe('einkommen/dividenden');
    expect(cat(C('comdirect', 'Ertragsgutschrift iShares Core MSCI World', 1210))).toBe('einkommen/dividenden');
    expect(cat(C('Union Investment', 'Ausschüttung UniGlobal', 1210))).toBe('einkommen/dividenden');
    expect(cat(C('Renault Bank direkt', 'Zinsgutschrift', 812))).toBe('einkommen/zinsen');
  });
  it('comdirect „Wertpapiere … WPKNR … ISIN“: Abfluss = Sparplan & Depot, Verkauf (Zufluss) = Umschichtung statt Einkommen', () => {
    const buy = C('comdirect', 'Wertpapiere WPKNR 870747 ISIN US5949181045', -107730);
    expect(cat(buy)).toBe('vorsorge_sparen/sparplan_depot');
    const sell = C('comdirect Bank AG', 'Wertpapiere Verkauf WPKNR 870747 ISIN US5949181045', 107730);
    expect(cat(sell)).toBe('vorsorge_sparen/sparplan_depot');
    expect(sell.category).not.toBe('einkommen');
  });
  it('Kartenzahlung in Fremdwährung normal, Auslandseinsatzentgelt = Gebühren', () => {
    expect(cat(C('ALDI SUED', 'Kartenzahlung FW 12,00 USD Kurs 1,0900', -1101))).toBe('lebensmittel/supermarkt');
    expect(cat(C('DKB AG', 'Auslandseinsatzentgelt', -22))).toBe('finanzen/gebuehren');
  });
  it('DKB „Lohn, Gehalt, Rente“ (Zufluss) → Gehalt; Rentenkasse als Auftraggeber → Rente', () => {
    expect(cat(C('Muster GmbH', 'Abrechnung 03/2026', 250000, { bookingText: 'Lohn, Gehalt, Rente' }))).toBe('einkommen/gehalt');
    expect(cat(C('Muster GmbH', 'Lohn, Gehalt, Rente', 250000))).toBe('einkommen/gehalt');
    expect(cat(C('Deutsche Rentenversicherung', 'Rente 03/2026', 150000, { bookingText: 'Lohn, Gehalt, Rente' }))).toBe('einkommen/rente');
  });
  it('Gerichtskasse/Justizkasse → Sonstiges › Behörden', () => {
    expect(cat(C('Gerichtskasse Hamburg', 'Kostenrechnung 12345', -5000))).toBe('sonstiges/behoerden');
    expect(cat(C('Landesjustizkasse Bamberg', 'Az 4 C 12/26', -5000))).toBe('sonstiges/behoerden');
    expect(cat(C('Stadt Musterstadt', 'Bußgeld Az 123', -3000))).toBe('sonstiges/behoerden');
  });
});

// ---------------------------------------------------------------- Belege
const sdoc = (o = {}) => ({ id: 'sd' + ++seq, type: 'wertpapier', subtype: 'kauf', date: '2026-08-19', amount: -107730, issuer: 'comdirect bank AG', fields: { valuta: '2026-08-21', wkn: '870747', isin: 'US5949181045', security: 'Microsoft Corp.' }, ...o });
const giro = (o = {}) => tx({ counterparty: 'comdirect', purpose: 'Wertpapiere WPKNR 870747 ISIN US5949181045', bookingDate: '2026-08-21', amount: -107730, category: 'vorsorge_sparen', ...o });

describe('Wertpapier-Abrechnung als Beleg zur Girobuchung', () => {
  it('Kauf: Betrag + Valuta + WKN/ISIN → sicherer Beleg', () => {
    const d = sdoc({ id: 'k1' }), t = giro({ id: 'g1' });
    const [out] = applyReceipts([t], [d]);
    expect(out).toMatchObject({ receiptDocId: 'k1', receiptDocIds: ['k1'], receiptSource: 'auto' });
    expect(out.checks).toBeUndefined();
  });
  it('Dividende (Zufluss) und Verkauf (Zufluss) werden verknüpft; Betrag im Beleg ohne Vorzeichen geht auch', () => {
    const div = sdoc({ id: 'dv', subtype: 'dividende', amount: 332, date: '2026-09-12', fields: { valuta: '2026-09-14', wkn: '870747', capitalIncome: true } });
    const sell = sdoc({ id: 'vk', subtype: 'verkauf', amount: 50000, date: '2026-10-01', fields: { valuta: '2026-10-05' } });
    const t1 = giro({ id: 'gd', amount: 332, bookingDate: '2026-09-14', purpose: 'ERTRAEGNISGUTSCHRIFT MICROSOFT' });
    const t2 = giro({ id: 'gv', amount: 50000, bookingDate: '2026-10-05', purpose: 'Wertpapiere Verkauf' });
    const out = applyReceipts([t1, t2], [div, sell]);
    expect(out[0].receiptDocId).toBe('dv');
    expect(out[1].receiptDocId).toBe('vk');
  });
  it('Datum: Valuta ±3 Tage oder Geschäftstag ±5 Tage, sonst nicht', () => {
    const d = sdoc({ id: 'w1' });
    expect(planReceipts([d], [giro({ id: 'in3', bookingDate: '2026-08-24' })]).links).toHaveLength(1);
    expect(planReceipts([d], [giro({ id: 'dd5', bookingDate: '2026-08-14' })]).links).toHaveLength(1);
    expect(planReceipts([d], [giro({ id: 'out', bookingDate: '2026-08-26' })]).links).toHaveLength(0);
    const noVal = sdoc({ id: 'w2', fields: {} });
    expect(planReceipts([noVal], [giro({ id: 'nv', bookingDate: '2026-08-24' })]).links).toHaveLength(1);
  });
  it('Betrag exakt mit Vorzeichen: Kauf passt nicht auf Zufluss, ±1 Cent nicht', () => {
    const d = sdoc();
    expect(planReceipts([d], [giro({ amount: 107730 })]).links).toHaveLength(0);
    expect(planReceipts([d], [giro({ amount: -107731 })]).links).toHaveLength(0);
  });
  it('ohne Textbezug nur Betrag+Datum: verknüpft, aber zur Prüfung', () => {
    const d = sdoc({ id: 'wk' });
    const t = tx({ id: 'gw', counterparty: 'Max Mustermann', purpose: 'Überweisung', bookingDate: '2026-08-21', amount: -107730 });
    const [out] = applyReceipts([t], [d]);
    expect(out.receiptDocId).toBe('wk');
    expect(out.checks).toEqual([expect.objectContaining({ kind: 'receipt', refId: 'wk' })]);
  });
  it('„Wertpapiere“/comdirect im Text hilft ohne WKN', () => {
    const d = sdoc({ id: 'wn', fields: { valuta: '2026-08-21' } });
    const [out] = applyReceipts([giro({ purpose: 'Wertpapiere' })], [d]);
    expect(out.receiptDocId).toBe('wn');
    expect(out.checks).toBeUndefined();
  });
  it('Kosteninformation und Depot-Reporting (infoOnly) hängen nie an Buchungen', () => {
    const k = sdoc({ id: 'ki', subtype: 'kosteninfo', amount: -107730, fields: { infoOnly: true, valuta: '2026-08-21', wkn: '870747' } });
    const r = sdoc({ id: 'dr', subtype: 'depotreport', amount: -107730, fields: { infoOnly: true } });
    const flagged = sdoc({ id: 'fi', subtype: 'kauf', fields: { infoOnly: true, valuta: '2026-08-21' } });
    expect(isSecuritiesReceipt(k) || isSecuritiesReceipt(r) || isSecuritiesReceipt(flagged)).toBe(false);
    const res = planReceipts([k, r, flagged], [giro()]);
    expect(res.links).toEqual([]);
    expect(res.suggestions).toEqual([]);
    // alter Auto-Link auf ein Info-Dokument wird entfernt
    const [out] = applyReceipts([giro({ receiptDocId: 'ki', receiptDocIds: ['ki'], receiptSource: 'auto' })], [k]);
    expect(out.receiptDocId).toBeNull();
  });
  it('abgelehnter Beleg kommt nicht wieder, bestätigter bleibt', () => {
    const d = sdoc({ id: 'rj' });
    expect(planReceipts([d], [giro({ receiptRejected: ['rj'] })]).links).toHaveLength(0);
    const locked = giro({ id: 'lk', receiptDocId: 'other', receiptDocIds: ['other'], receiptSource: 'user' });
    const [out] = applyReceipts([locked], [d]);
    expect(out.receiptDocId).toBe('other');
  });
  it('zwei gleiche Käufe, eindeutige Zuordnung über Valuta', () => {
    const a = sdoc({ id: 'ka', date: '2026-08-03', fields: { valuta: '2026-08-05' } });
    const b = sdoc({ id: 'kb', date: '2026-09-02', fields: { valuta: '2026-09-04' } });
    const out = applyReceipts([giro({ id: 'ga', bookingDate: '2026-08-05' }), giro({ id: 'gb', bookingDate: '2026-09-04' })], [a, b]);
    expect(out.map(t => t.receiptDocId)).toEqual(['ka', 'kb']);
  });
  it('Rechnungen/Kassenbons werden weiterhin wie bisher zugeordnet', () => {
    const r = { id: 'rb', type: 'kassenbon', date: '2026-04-10', amount: 1000, issuer: 'REWE', fields: {} };
    const [out] = applyReceipts([tx({ counterparty: 'REWE Markt', bookingDate: '2026-04-10' })], [r, sdoc()]);
    expect(out.receiptDocId).toBe('rb');
  });
});

describe('Steuer: Kapitalerträge (Anlage KAP)', () => {
  it('Dividenden-Abrechnung und Verkauf steuerrelevant, Kosteninfo/Depotreport/Kauf nicht', () => {
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'dividende', fields: { capitalIncome: true } })).toEqual({ taxRelevant: true, taxReason: 'kapitalertraege' });
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'verkauf', fields: {} })).toEqual({ taxRelevant: true, taxReason: 'kapitalertraege' });
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'kosteninfo', fields: { infoOnly: true } }).taxRelevant).toBe(false);
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'depotreport', fields: { infoOnly: true } }).taxRelevant).toBe(false);
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'kauf', fields: {} }).taxRelevant).toBe(false);
    // Nutzerentscheidung bleibt
    expect(flagTaxDocument({ type: 'wertpapier', subtype: 'dividende', fields: { capitalIncome: true }, taxSource: 'user', taxRelevant: false }).taxRelevant).toBe(false);
  });
  it('Buchungen Dividende/Zinsen → kapitalertraege; Rentenbausteine → Versicherung & Vorsorge; Depotkauf nicht', () => {
    expect(flagTaxTransaction(C('comdirect', 'ERTRAEGNISGUTSCHRIFT MICROSOFT', 332))).toEqual({ taxRelevant: true, taxReason: 'kapitalertraege' });
    expect(flagTaxTransaction(C('Renault Bank', 'Zinsgutschrift', 812)).taxReason).toBe('kapitalertraege');
    expect(flagTaxTransaction(C('Alte Leipziger', 'Fondsrente Beitrag')).taxReason).toBe('versicherung_vorsorge');
    expect(flagTaxTransaction(C('comdirect', 'Wertpapiere WPKNR 870747 ISIN US5949181045', -107730)).taxRelevant).toBe(false);
  });
});
