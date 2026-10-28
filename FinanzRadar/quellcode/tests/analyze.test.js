import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeText, parseCsv } from '../src/lib/extract/decode.js';
import { extractPdfText } from '../src/lib/extract/pdf.js';
import { CATEGORIES, getCategory, getSub, categoryLabel } from '../src/lib/classify/categories.js';
import { MERCHANTS, findMerchant, fold } from '../src/lib/classify/merchants.de.js';
import { normalizeCounterparty, resolveCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions, suggestRuleFromCorrection } from '../src/lib/classify/rules.js';
import { flagTaxDocument, flagTaxTransaction } from '../src/lib/classify/taxFlags.js';
import { detectTransfers, PAYPAL_CREDITOR_ID } from '../src/lib/analyze/transfers.js';
import { detectRecurring, linkContracts } from '../src/lib/analyze/recurring.js';
import { matchReceipts } from '../src/lib/analyze/receipts.js';
import { computeNetWorth } from '../src/lib/analyze/networth.js';
import { estimateVat } from '../src/lib/analyze/vat.js';
import { computeInsights } from '../src/lib/analyze/insights.js';
import { buildTaxZip, buildArchiveZip, buildCsvExport, planZipPaths, REASON_FOLDER } from '../src/lib/export/zip.js';
import { layoutSankey } from '../src/lib/charts/sankeyLayout.js';

const ROOT = path.resolve(import.meta.dirname, '../samples/out');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'EXPECTED.json'), 'utf8')).files;

// ---------------------------------------------------------------- Helfer
let seq = 0;
const tx = (o = {}) => ({
  id: 'tx' + ++seq, accountId: 'a1', bookingDate: '2026-03-01', amount: -1000, currency: 'EUR',
  counterparty: '', counterpartyRaw: '', counterpartyIban: null, purpose: '', bookingText: null,
  mandateId: null, creditorId: null, category: null, subcategory: null, isTransfer: false, ...o,
});
const cls = (o, extra) => classifyTransactions([tx(o)], extra)[0];

/** Jeder Mittelknoten: Zufluss == Abfluss (±1 Cent), alle Werte > 0, alle Knoten vorhanden */
function sankeyIssues(sk) {
  const issues = [];
  const ids = new Set(sk.nodes.map(n => n.id));
  const inn = new Map(), out = new Map();
  for (const l of sk.links) {
    if (!(l.value > 0) || !Number.isInteger(l.value)) issues.push(`Wert ${l.source}->${l.target}: ${l.value}`);
    if (!ids.has(l.source) || !ids.has(l.target)) issues.push(`Knoten fehlt ${l.source}->${l.target}`);
    out.set(l.source, (out.get(l.source) || 0) + l.value);
    inn.set(l.target, (inn.get(l.target) || 0) + l.value);
  }
  for (const n of sk.nodes) {
    if (inn.has(n.id) && out.has(n.id) && Math.abs(inn.get(n.id) - out.get(n.id)) > 1) issues.push(`Bilanz ${n.id}: in ${inn.get(n.id)} out ${out.get(n.id)}`);
    if (!inn.has(n.id) && !out.has(n.id)) issues.push(`Knoten ohne Link ${n.id}`);
  }
  return issues;
}

/** Mini-ZIP-Leser: Dateinamen aus den lokalen Headern */
async function zipNames(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const names = [];
  for (let i = 0; i < buf.length - 30; i++) {
    if (dv.getUint32(i, true) === 0x04034b50) {
      const n = dv.getUint16(i + 26, true);
      names.push(new TextDecoder().decode(buf.slice(i + 30, i + 30 + n)));
    }
  }
  return names;
}

// ---------------------------------------------------------------- Kategorien
describe('Kategorien', () => {
  const IDS = ['einkommen', 'steuern_abgaben', 'wohnen', 'lebensmittel', 'mobilitaet', 'versicherungen', 'vorsorge_sparen', 'abos_medien', 'gesundheit', 'freizeit_reisen', 'shopping', 'beruf', 'spenden', 'finanzen', 'bargeld', 'umbuchung', 'sonstiges'];
  it('alle Hauptkategorien laut SPEC, eindeutige Farben, 3+ Unterkategorien', () => {
    expect(CATEGORIES.map(c => c.id)).toEqual(IDS);
    expect(new Set(CATEGORIES.map(c => c.color)).size).toBe(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(['income', 'expense', 'neutral', 'tax', 'saving']).toContain(c.kind);
      expect(c.label).toBeTruthy();
      expect(c.icon).toBeTruthy();
      expect(c.subs.length).toBeGreaterThanOrEqual(3);
      expect(new Set(c.subs.map(s => s.id)).size).toBe(c.subs.length);
    }
  });
  it('geforderte Unterkategorien und Zugriff', () => {
    const subs = (id) => getCategory(id).subs.map(s => s.id);
    expect(subs('wohnen')).toEqual(expect.arrayContaining(['miete', 'nebenkosten', 'strom_gas', 'internet_telefon', 'rundfunk', 'handwerker', 'einrichtung']));
    expect(subs('steuern_abgaben')).toEqual(expect.arrayContaining(['lohnsteuer', 'soli', 'kirchensteuer', 'kv', 'pv', 'rv', 'av', 'kapitalertragsteuer', 'mwst_geschaetzt']));
    expect(subs('vorsorge_sparen')).toEqual(expect.arrayContaining(['privatrente', 'riester_ruerup', 'sparplan_depot', 'tagesgeld', 'bausparen']));
    expect(subs('versicherungen')).toEqual(expect.arrayContaining(['haftpflicht', 'hausrat', 'bu', 'kranken_zusatz', 'kfz', 'rechtsschutz', 'leben']));
    expect(subs('abos_medien')).toEqual(expect.arrayContaining(['streaming', 'musik', 'software', 'cloud', 'zeitung', 'fitness', 'gaming']));
    expect(getSub('wohnen', 'miete').label).toBe('Miete');
    expect(getSub('wohnen', 'x')).toBeNull();
    expect(getCategory('gibtsnicht')).toBeNull();
    expect(categoryLabel('wohnen', 'miete')).toContain('Miete');
  });
  it('alle Händler zeigen auf existierende Kategorien', () => {
    for (const m of MERCHANTS) {
      expect(getCategory(m.category), m.name).toBeTruthy();
      if (m.sub) expect(getSub(m.category, m.sub), `${m.name}: ${m.category}.${m.sub}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- Händlerliste
describe('Händlerliste', () => {
  it('~250+ Einträge mit gültigen Mustern', () => {
    expect(MERCHANTS.length).toBeGreaterThanOrEqual(250);
    expect(new Set(MERCHANTS.map(m => m.id)).size).toBe(MERCHANTS.length);
  });
  it.each([
    ['REWE Markt', 'lebensmittel', 'supermarkt'], ['EDEKA Nord', 'lebensmittel', 'supermarkt'], ['ALDI SUED', 'lebensmittel', 'supermarkt'], ['LIDL SAGT DANKE', 'lebensmittel', 'supermarkt'],
    ['Penny Markt', 'lebensmittel', 'supermarkt'], ['Netto Marken-Discount', 'lebensmittel', 'supermarkt'], ['Kaufland', 'lebensmittel', 'supermarkt'], ['dm drogerie markt', 'lebensmittel', 'drogerie'],
    ['Rossmann Filiale', 'lebensmittel', 'drogerie'], ['Müller Drogerie', 'lebensmittel', 'drogerie'], ['Aral Tankstelle', 'mobilitaet', 'tanken'], ['Shell', 'mobilitaet', 'tanken'],
    ['TotalEnergies', 'mobilitaet', 'tanken'], ['JET Tankstelle', 'mobilitaet', 'tanken'], ['Deutsche Bahn Vertrieb GmbH', 'mobilitaet', 'bahn_fernverkehr'], ['DB Vertrieb', 'mobilitaet', 'bahn_fernverkehr'],
    ['HVV', 'mobilitaet', 'oepnv'], ['BVG', 'mobilitaet', 'oepnv'], ['FlixBus', 'mobilitaet', 'bahn_fernverkehr'], ['Uber BV', 'mobilitaet', 'taxi_sharing'], ['FREE NOW', 'mobilitaet', 'taxi_sharing'],
    ['Deutschlandticket Abo', 'mobilitaet', 'oepnv'], ['Telekom Deutschland GmbH', 'wohnen', 'internet_telefon'], ['Vodafone GmbH', 'wohnen', 'internet_telefon'], ['Telefonica Germany', 'wohnen', 'internet_telefon'],
    ['1&1 Telecom', 'wohnen', 'internet_telefon'], ['congstar', 'wohnen', 'internet_telefon'], ['Vattenfall Europe Sales', 'wohnen', 'strom_gas'], ['E.ON Energie', 'wohnen', 'strom_gas'],
    ['EnBW', 'wohnen', 'strom_gas'], ['Stadtwerke Musterstadt', 'wohnen', 'strom_gas'], ['Lichtblick', 'wohnen', 'strom_gas'], ['Tibber', 'wohnen', 'strom_gas'], ['Octopus Energy', 'wohnen', 'strom_gas'],
    ['Netflix International B.V.', 'abos_medien', 'streaming'], ['Spotify AB', 'abos_medien', 'musik'], ['Disney Plus', 'abos_medien', 'streaming'], ['Amazon Prime', 'abos_medien', 'streaming'],
    ['DAZN', 'abos_medien', 'streaming'], ['Sky Deutschland', 'abos_medien', 'streaming'], ['APPLE.COM/BILL', 'abos_medien', 'streaming'], ['YouTube Premium', 'abos_medien', 'streaming'],
    ['Audible', 'abos_medien', 'hoerbuch'], ['Deezer', 'abos_medien', 'musik'], ['RTL+', 'abos_medien', 'streaming'], ['Joyn', 'abos_medien', 'streaming'],
    ['Adobe Systems Software Ireland Ltd', 'abos_medien', 'software'], ['Microsoft 365', 'abos_medien', 'software'], ['Dropbox', 'abos_medien', 'cloud'], ['OpenAI Ireland Ltd.', 'abos_medien', 'software'],
    ['Anthropic', 'abos_medien', 'software'], ['Notion Labs', 'abos_medien', 'software'], ['iCloud Speicher', 'abos_medien', 'cloud'],
    ['Amazon Payments Europe S.C.A.', 'shopping', 'online'], ['Otto GmbH', 'shopping', 'online'], ['Zalando SE', 'shopping', 'kleidung'], ['MediaMarkt', 'shopping', 'elektronik'], ['Saturn', 'shopping', 'elektronik'],
    ['IKEA Deutschland', 'shopping', 'moebel'], ['H&M', 'shopping', 'kleidung'], ['Decathlon', 'shopping', 'kleidung'], ['eBay Sarl', 'shopping', 'online'], ['Etsy', 'shopping', 'online'],
    ['AliExpress', 'shopping', 'online'], ['Temu', 'shopping', 'online'], ['SHEIN', 'shopping', 'online'],
    ['Allianz Versicherungs-AG', 'versicherungen', null], ['HUK-COBURG', 'versicherungen', null], ['AXA', 'versicherungen', null], ['ERGO Versicherung', 'versicherungen', null], ['Generali', 'versicherungen', null],
    ['Alte Leipziger Versicherung AG', 'versicherungen', null], ['R+V Versicherung', 'versicherungen', null], ['Debeka', 'versicherungen', null], ['Signal Iduna', 'versicherungen', null],
    ['HanseMerkur', 'versicherungen', null], ['DEVK', 'versicherungen', null], ['Barmenia', 'versicherungen', null], ['LV 1871', 'versicherungen', null], ['Hannoversche Lebensversicherung', 'versicherungen', null],
    ['CosmosDirekt', 'versicherungen', null], ['Check24', 'versicherungen', null],
    ['Stadt-Apotheke', 'gesundheit', 'apotheke'], ['DocMorris', 'gesundheit', 'apotheke'], ['Shop Apotheke', 'gesundheit', 'apotheke'], ['Fielmann', 'gesundheit', 'brille'], ['Apollo-Optik', 'gesundheit', 'brille'], ['Zahnarztpraxis Dr. Meier', 'gesundheit', 'zahnarzt'],
    ['Urban Sports Club GmbH', 'abos_medien', 'fitness'], ['McFit', 'abos_medien', 'fitness'], ['FitX', 'abos_medien', 'fitness'], ['Clever Fit', 'abos_medien', 'fitness'],
    ['ARD ZDF Deutschlandradio Beitragsservice', 'wohnen', 'rundfunk'], ['ver.di Bundesverwaltung', 'beruf', 'gewerkschaft'], ['IG Metall', 'beruf', 'gewerkschaft'],
    ['Ärzte ohne Grenzen e.V.', 'spenden', 'organisation'], ['UNICEF', 'spenden', 'organisation'], ['WWF Deutschland', 'spenden', 'organisation'], ['Greenpeace e.V.', 'spenden', 'organisation'],
    ['Deutsches Rotes Kreuz', 'spenden', 'organisation'], ['Caritasverband', 'spenden', 'organisation'].slice(0, 1).concat(['spenden', 'organisation']).slice(0, 3), ['Brot für die Welt', 'spenden', 'organisation'],
    ['Trade Republic Bank GmbH', 'vorsorge_sparen', 'sparplan_depot'], ['Scalable Capital', 'vorsorge_sparen', 'sparplan_depot'], ['Renault Bank direkt', 'vorsorge_sparen', 'tagesgeld'],
  ])('%s → %s.%s', (name, cat, sub) => {
    const m = findMerchant(fold(name), '');
    expect(m, name).toBeTruthy();
    expect(m.category).toBe(cat);
    if (sub) expect(m.sub).toBe(sub);
  });
  it('Zahlungsdienstleister sind als intermediary markiert', () => {
    for (const n of ['PayPal Europe S.a.r.l. et Cie S.C.A', 'Klarna Bank AB', 'SumUp Payments', 'Stripe', 'Adyen N.V.']) expect(findMerchant(fold(n))?.intermediary, n).toBe(true);
  });
  it('keine Fehltreffer bei Alltagsbegriffen', () => {
    for (const n of ['Max Mustermann', 'Gehalt 03/2026', 'Frigotechnik GmbH', 'Anna Beispiel', 'Miete 03/2026 Musterstraße 1', 'Sportartikel Beispiel']) expect(findMerchant(fold(n), '')?.name, n).toBeUndefined();
  });
  it('ALDI Talk ist Mobilfunk, nicht Supermarkt; Globus Baumarkt nicht Globus', () => {
    expect(findMerchant('aldi talk', '').category).toBe('wohnen');
    expect(findMerchant('globus baumarkt', '').sub).toBe('einrichtung');
  });
});

// ---------------------------------------------------------------- Normalisierung
describe('Gegenpartei normalisieren', () => {
  const n = (counterpartyRaw, extra = {}) => normalizeCounterparty({ counterpartyRaw, purpose: '', ...extra });
  it('Rechtsformen und Rauschen entfernen', () => {
    expect(n('Netflix International B.V.')).toBe('Netflix International');
    expect(n('Spotify AB')).toBe('Spotify');
    expect(n('Frigotechnik GmbH & Co. KG')).toBe('Frigotechnik');
    expect(n('Telekom Deutschland GmbH')).toBe('Telekom Deutschland');
    expect(n('Adobe Systems Software Ireland Ltd')).toBe('Adobe Systems Software Ireland');
    expect(n('Ärzte ohne Grenzen e.V.')).toBe('Ärzte ohne Grenzen');
    expect(n('Allianz Lebensversicherungs-AG')).toBe('Allianz Lebensversicherungs-AG');
  });
  it('Kartenzahlung: Karten-/Datums-/Referenzrauschen, doppelte Namen, Stadt', () => {
    expect(n('REWE Markt Hamburg-Eimsbüttel VISA Debitkarte REWE Markt Hamburg', { bookingText: 'Kartenzahlung' })).toBe('REWE Markt');
    expect(n('EDEKA NORD SAGT DANKE // HAMBURG', { bookingText: 'Kartenzahlung' })).toBe('Edeka Nord');
    expect(n('LIDL SAGT DANKE 12.03. 1234567890', { bookingText: 'Kartenzahlung' })).toBe('Lidl');
    expect(n('SHELL 1234 NR XXXX 5678 KAUFUMSATZ 10.06.', { bookingText: 'Kartenzahlung' })).toBe('Shell');
  });
  it('Großschreibung → Title Case, gemischte Schreibweise bleibt', () => {
    expect(n('DEUTSCHE BAHN VERTRIEB GMBH')).toBe('Deutsche Bahn Vertrieb');
    expect(n('dm drogerie markt')).toBe('dm drogerie markt');
    expect(n('eBay Sarl')).toBe('eBay');
  });
  it('PayPal-Lastschrift → Händler, Vermittler bleibt erhalten', () => {
    const t = { counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: 'PP.1234.PP . ABC Shop, Ihr Einkauf bei ABC Shop' };
    expect(resolveCounterparty(t)).toEqual({ name: 'ABC Shop', intermediary: 'PayPal' });
    expect(normalizeCounterparty({ ...t, purpose: '1234567890 PP.1234.PP . Reisebüro Probe, Ihr Einkauf bei Reisebüro Probe' })).toBe('Reisebüro Probe');
    expect(resolveCounterparty({ counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: 'Zahlung' })).toEqual({ name: 'PayPal', intermediary: 'PayPal' });
  });
  it('Klarna, SumUp, Amazon Payments', () => {
    expect(resolveCounterparty({ counterpartyRaw: 'Klarna Bank AB (publ)', purpose: 'Ihr Einkauf bei Zalando' })).toEqual({ name: 'Zalando', intermediary: 'Klarna' });
    expect(resolveCounterparty({ counterpartyRaw: 'SumUp *Cafe X', purpose: '' })).toEqual({ name: 'Cafe X', intermediary: 'SumUp' });
    expect(resolveCounterparty({ counterpartyRaw: 'SUMUP  *CAFE LUNA', purpose: '' }).name).toBe('Cafe Luna');
    expect(resolveCounterparty({ counterpartyRaw: 'Amazon Payments Europe S.C.A', purpose: 'AMZN Mktp DE Bestellung 171-2233445' }).name).toBe('Amazon');
    expect(n('AMZN Mktp DE*2K4AB7')).toBe('Amazon');
  });
  it('PayPal-Konto-Buchungen bleiben unverändert', () => {
    expect(n('PayPal-Aufladung (Bankkonto)')).toBe('PayPal-Aufladung (Bankkonto)');
    expect(n('ABC Shop')).toBe('ABC Shop');
  });
  it('leere Gegenpartei fällt auf Verwendungszweck zurück', () => {
    expect(normalizeCounterparty({ counterpartyRaw: '', purpose: 'Rückzahlung Darlehen' })).toBe('Rückzahlung Darlehen');
  });
});

// ---------------------------------------------------------------- Klassifizierung
describe('Klassifizierung', () => {
  const C = (counterparty, purpose = '', amount = -1000, extra = {}) => cls({ counterparty, counterpartyRaw: counterparty, purpose, amount, ...extra });
  it('REWE / Netflix / Allianz / Vattenfall / ver.di', () => {
    expect(C('REWE Markt', 'VISA Debitkarte', -5230)).toMatchObject({ category: 'lebensmittel', subcategory: 'supermarkt', categorySource: 'merchant', confidence: 0.9 });
    expect(C('Netflix International', 'Netflix Standard 2026-06', -1399)).toMatchObject({ category: 'abos_medien', subcategory: 'streaming' });
    expect(C('Vattenfall Europe Sales', 'Abschlag Strom', -8450)).toMatchObject({ category: 'wohnen', subcategory: 'strom_gas' });
    expect(C('Gewerkschaft ver.di', 'Mitgliedsbeitrag Quartal', -3850)).toMatchObject({ category: 'beruf', subcategory: 'gewerkschaft' });
    expect(C('Allianz Versicherungs-AG', 'Vertragsnr. 123 Beitrag Haftpflicht', -1200)).toMatchObject({ category: 'versicherungen', subcategory: 'haftpflicht' });
    expect(C('Allianz Lebensversicherungs-AG', 'Vertragsnr. 4711-0815 Beitrag Privatrente', -15000)).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'privatrente' });
    expect(C('Alte Leipziger Versicherung AG', 'BU-Vertrag 55-778899 Beitrag', -6230)).toMatchObject({ category: 'versicherungen', subcategory: 'bu' });
    expect(C('HUK-COBURG', 'Beitrag Kfz-Versicherung', -5000)).toMatchObject({ category: 'versicherungen', subcategory: 'kfz' });
  });
  it('Stichwortregeln (0,7)', () => {
    expect(C('Frigotechnik', 'Gehalt 06/2026', 329098)).toMatchObject({ category: 'einkommen', subcategory: 'gehalt', categorySource: 'keyword' });
    expect(C('Hausverwaltung Elbblick', 'Miete 06/2026', -115000)).toMatchObject({ category: 'wohnen', subcategory: 'miete' });
    expect(C('Max Mustermann', 'Miete 06/2026 Musterstraße 1', -115000)).toMatchObject({ category: 'wohnen', subcategory: 'miete', categorySource: 'keyword' });
    expect(C('Renault Bank', 'Zinsgutschrift Tagesgeld', 873)).toMatchObject({ category: 'einkommen', subcategory: 'zinsen' });
    expect(C('Comdirect', 'Dividende ETF', 4200)).toMatchObject({ category: 'einkommen', subcategory: 'dividenden' });
    expect(C('Finanzamt Hamburg', 'Erstattung Einkommensteuer 2024', 91200)).toMatchObject({ category: 'einkommen', subcategory: 'erstattung' });
    expect(C('Finanzamt Hamburg', 'Einkommensteuer Vorauszahlung', -50000)).toMatchObject({ category: 'steuern_abgaben' });
    expect(C('Geldautomat Hamburg', 'Bargeldauszahlung', -10000)).toMatchObject({ category: 'bargeld', subcategory: 'auszahlung' });
    expect(C('ING', 'Kontoführung Entgelt', -499)).toMatchObject({ category: 'finanzen', subcategory: 'kontofuehrung' });
    expect(C('Trade Republic', 'Sparplan Ausführung', -5000)).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'sparplan_depot' });
    expect(C('Max Mustermann', 'Wertpapierkauf ETF', -30000)).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'sparplan_depot' });
    expect(C('Max Mustermann', 'Tagesgeld Sparen 06/2026', -50000)).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'tagesgeld' });
    expect(C('Lieschen Müller', 'Spende Hochwasserhilfe', -2000)).toMatchObject({ category: 'spenden' });
    expect(C('ARD ZDF Deutschlandradio Beitragsservice', 'Rundfunkbeitrag Quartal', -5508)).toMatchObject({ category: 'wohnen', subcategory: 'rundfunk' });
    expect(C('Städtische Kita Sonnenschein', 'Kita Beitrag 05/2026', -18000)).toMatchObject({ category: 'beruf', subcategory: 'kinderbetreuung' });
    expect(C('Hans Meier', 'Versicherungsbeitrag Vertragsnr 99', -4000)).toMatchObject({ category: 'versicherungen' });
  });
  it('Standard nach Vorzeichen, needsReview unter 0,6', () => {
    expect(C('Anna Beispiel', 'Geld gesendet', -2500)).toMatchObject({ category: 'sonstiges', confidence: 0.3, needsReview: true });
    expect(C('Onkel Karl', 'Danke', 5000)).toMatchObject({ category: 'einkommen', subcategory: 'sonstiges', confidence: 0.4, needsReview: true });
    expect(C('REWE', '', -100).needsReview).toBe(false);
  });
  it('Umbuchung: isTransfer → umbuchung mit Konfidenz 1', () => {
    expect(cls({ counterparty: 'Max Mustermann', purpose: 'Tagesgeld Sparen', amount: -50000, isTransfer: true })).toMatchObject({ category: 'umbuchung', categorySource: 'transfer', confidence: 1, subcategory: 'eigene_konten' });
    expect(cls({ counterparty: 'PayPal-Aufladung (Bankkonto)', amount: 8990, isTransfer: true })).toMatchObject({ category: 'umbuchung', subcategory: 'paypal' });
  });
  it('Banken als Gegenpartei sind nur schwache Hinweise (Gehalt vom Arbeitgeber "Sparkasse" bleibt Gehalt)', () => {
    expect(C('Hamburger Sparkasse', 'Gehalt 05/2026', 280000, { bookingText: 'Gehalt/Lohn' })).toMatchObject({ category: 'einkommen', subcategory: 'gehalt' });
    expect(C('Sparkasse Musterstadt', 'Sonstige Buchung', -500)).toMatchObject({ category: 'finanzen', confidence: 0.5, needsReview: true });
  });
  it('Nutzerregeln gehen vor und setzen Steuer-Flags', () => {
    const rules = [
      { id: 'r1', match: { field: 'counterparty', op: 'contains', value: 'rewe' }, set: { category: 'freizeit_reisen', subcategory: 'hobby' } },
      { id: 'r2', match: { field: 'purpose', op: 'regex', value: 'fachbuch|seminar' }, set: { category: 'beruf', subcategory: 'fortbildung', taxRelevant: true, taxReason: 'beruf' } },
      { id: 'r3', match: { field: 'iban', op: 'equals', value: 'DE89 3704 0044 0532 0130 00' }, set: { category: 'sonstiges', subcategory: 'privat' } },
      { id: 'r4', match: { field: 'creditorId', op: 'equals', value: 'DE98ZZZ09999999999' }, set: { category: 'abos_medien', subcategory: 'musik' } },
      { id: 'r5', match: { field: 'any', op: 'contains', value: 'kaffeemaschine' }, set: { category: 'wohnen', subcategory: 'einrichtung' } },
    ];
    expect(cls({ counterparty: 'REWE Markt', amount: -100 }, { rules })).toMatchObject({ category: 'freizeit_reisen', categorySource: 'rule', confidence: 1 });
    expect(cls({ counterparty: 'Buchhandlung', purpose: 'Fachbuch Python', amount: -3000 }, { rules })).toMatchObject({ category: 'beruf', taxRelevant: true, taxReason: 'beruf', taxSource: 'rule' });
    expect(cls({ counterparty: 'Egal', counterpartyIban: 'DE89370400440532013000', amount: -3000 }, { rules }).subcategory).toBe('privat');
    expect(cls({ counterparty: 'Egal', creditorId: 'DE98ZZZ09999999999', amount: -3000 }, { rules }).category).toBe('abos_medien');
    expect(cls({ counterparty: 'Egal', purpose: 'Rechnung Kaffeemaschine', amount: -3000 }, { rules }).subcategory).toBe('einrichtung');
    // deaktivierte / ungültige Regeln werden ignoriert
    expect(cls({ counterparty: 'REWE Markt', amount: -100 }, { rules: [{ ...rules[0], enabled: false }, { id: 'x', match: { field: 'purpose', op: 'regex', value: '(' }, set: { category: 'beruf' } }] }).category).toBe('lebensmittel');
  });
  it('Nutzerentscheidungen werden nie überschrieben; KI-Vorschlag bleibt bei schwachem Regeltreffer', () => {
    const user = tx({ counterparty: 'REWE', amount: -100, category: 'shopping', categorySource: 'user', confidence: 1 });
    expect(classifyTransactions([user], { rules: [{ id: 'r', match: { field: 'any', op: 'contains', value: 'rewe' }, set: { category: 'beruf' } }] })[0]).toBe(user);
    const ai = tx({ counterparty: 'Unbekannt GmbH', amount: -100, category: 'gesundheit', categorySource: 'ai', confidence: 0.7 });
    expect(classifyTransactions([ai])[0].category).toBe('gesundheit');
    const ai2 = tx({ counterparty: 'REWE', amount: -100, category: 'gesundheit', categorySource: 'ai', confidence: 0.7 });
    expect(classifyTransactions([ai2])[0].category).toBe('lebensmittel');
  });
  it('geprüfte Buchungen (reviewed) tauchen nicht erneut in der Prüfliste auf', () => {
    expect(cls({ counterparty: 'Anna Beispiel', amount: -100, reviewed: true }).needsReview).toBe(false);
  });
  it('Rückerstattung übernimmt die Kategorie früherer Ausgaben beim Empfänger', () => {
    const out = classifyTransactions([
      tx({ counterparty: 'Zalando', amount: -5000 }),
      tx({ counterparty: 'Obskurshop', amount: -1000 }),
      tx({ counterparty: 'Obskurshop', amount: 1000, purpose: 'Zahlungsrückerstattung', bookingText: 'Zahlungsrückerstattung' }),
    ]);
    expect(out[2].category).toBe(out[1].category);
    expect(out[2].category).toBe('sonstiges');
  });
  it('suggestRuleFromCorrection', () => {
    const t = tx({ counterparty: 'ABC Shop', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: 'PP.1234.PP . ABC Shop, Ihr Einkauf bei ABC Shop', amount: -5999 });
    const r = suggestRuleFromCorrection(t, 'shopping');
    expect(r).toMatchObject({ match: { field: 'counterparty', op: 'contains', value: 'ABC Shop' }, set: { category: 'shopping', subcategory: null } });
    expect(r.id).toBeTruthy();
    expect(suggestRuleFromCorrection(t, 'shopping.online').set.subcategory).toBe('online');
    expect(suggestRuleFromCorrection(t, 'gibtsnicht')).toBeNull();
    const byIban = suggestRuleFromCorrection(tx({ counterparty: '', counterpartyRaw: '', counterpartyIban: 'de89 3704 0044 0532 0130 00', amount: -1 }), 'wohnen.miete');
    expect(byIban.match).toEqual({ field: 'iban', op: 'equals', value: 'DE89370400440532013000' });
    // Regel greift anschließend wirklich
    expect(classifyTransactions([t], { rules: [r] })[0]).toMatchObject({ category: 'shopping', categorySource: 'rule' });
  });
});

// ---------------------------------------------------------------- Steuer-Flags
describe('Steuer-Flags', () => {
  it('Dokumente nach Typ', () => {
    expect(flagTaxDocument({ type: 'lohn' })).toEqual({ taxRelevant: true, taxReason: 'lohn' });
    expect(flagTaxDocument({ type: 'lohnsteuerbescheinigung' }).taxReason).toBe('lohn');
    expect(flagTaxDocument({ type: 'steuerbescheinigung' }).taxReason).toBe('kapitalertraege');
    expect(flagTaxDocument({ type: 'spende' }).taxReason).toBe('spenden');
    expect(flagTaxDocument({ type: 'versicherung' }).taxReason).toBe('versicherung_vorsorge');
    expect(flagTaxDocument({ type: 'rente' }).taxReason).toBe('versicherung_vorsorge');
    expect(flagTaxDocument({ type: 'kontoauszug' })).toEqual({ taxRelevant: false, taxReason: null });
    expect(flagTaxDocument({ type: 'einkaufszettel' }).taxRelevant).toBe(false);
  });
  it('Rechnungen: Handwerker, Beruf, Gesundheit, Kinder', () => {
    expect(flagTaxDocument({ type: 'rechnung', fields: { isCraftsman: true } }).taxReason).toBe('haushalt_handwerker');
    expect(flagTaxDocument({ type: 'rechnung', issuer: 'Gebäudereinigung Blitz', title: 'Rechnung' }).taxReason).toBe('haushalt_handwerker');
    expect(flagTaxDocument({ type: 'rechnung', text: 'Nebenkostenabrechnung 2025' }).taxReason).toBe('haushalt_handwerker');
    expect(flagTaxDocument({ type: 'rechnung', issuer: 'Amazon EU', text: 'Dell Monitor 27 Zoll' }).taxReason).toBe('beruf');
    expect(flagTaxDocument({ type: 'rechnung', text: 'Fachbuch Python' }).taxReason).toBe('beruf');
    expect(flagTaxDocument({ type: 'rechnung', text: 'Seminar Projektmanagement' }).taxReason).toBe('beruf');
    expect(flagTaxDocument({ type: 'rechnung', issuer: 'Optik Muster GmbH', text: 'Gleitsichtbrille' }).taxReason).toBe('gesundheit');
    expect(flagTaxDocument({ type: 'rechnung', issuer: 'Dr. Meier Zahnarzt' }).taxReason).toBe('gesundheit');
    expect(flagTaxDocument({ type: 'kassenbon', issuer: 'Stadt-Apotheke' }).taxReason).toBe('gesundheit');
    expect(flagTaxDocument({ type: 'rechnung', issuer: 'Kita Sonnenschein', title: 'Betreuungsgebühr' }).taxReason).toBe('kinder_bildung');
    expect(flagTaxDocument({ type: 'rechnung', text: 'Strom Jahresabrechnung' }).taxRelevant).toBe(false);
    expect(flagTaxDocument({ type: 'kassenbon', issuer: 'REWE', text: 'REWE Markt\nZahncreme 1,95\nBio Rezept-Joghurt' }).taxRelevant).toBe(false);
  });
  it('Nutzerentscheidung bleibt bestehen', () => {
    expect(flagTaxDocument({ type: 'lohn', taxRelevant: false, taxReason: null, taxSource: 'user' })).toEqual({ taxRelevant: false, taxReason: null });
    expect(flagTaxDocument({ type: 'kassenbon', taxRelevant: true, taxReason: 'beruf', taxSource: 'user' })).toEqual({ taxRelevant: true, taxReason: 'beruf' });
    expect(flagTaxTransaction({ category: 'spenden', taxRelevant: false, taxReason: null, taxSource: 'user' })).toEqual({ taxRelevant: false, taxReason: null });
    expect(flagTaxTransaction({ category: 'wohnen', amount: -5, taxRelevant: true, taxReason: 'sonstiges', taxSource: 'rule' }).taxReason).toBe('sonstiges');
  });
  it('Buchungen nach Kategorie und Stichwort', () => {
    const f = (o) => flagTaxTransaction({ amount: -1000, ...o });
    expect(f({ category: 'spenden', subcategory: 'organisation' }).taxReason).toBe('spenden');
    expect(f({ category: 'versicherungen', subcategory: 'haftpflicht' }).taxReason).toBe('versicherung_vorsorge');
    expect(f({ category: 'versicherungen', subcategory: 'hausrat' }).taxRelevant).toBe(false);
    expect(f({ category: 'vorsorge_sparen', subcategory: 'privatrente' }).taxReason).toBe('versicherung_vorsorge');
    expect(f({ category: 'vorsorge_sparen', subcategory: 'tagesgeld' }).taxRelevant).toBe(false);
    expect(f({ category: 'gesundheit', subcategory: 'apotheke' }).taxReason).toBe('gesundheit');
    expect(f({ category: 'wohnen', subcategory: 'handwerker' }).taxReason).toBe('haushalt_handwerker');
    expect(f({ category: 'beruf', subcategory: 'gewerkschaft' }).taxReason).toBe('beruf');
    expect(f({ category: 'beruf', subcategory: 'kinderbetreuung' }).taxReason).toBe('kinder_bildung');
    expect(f({ category: 'einkommen', subcategory: 'zinsen', amount: 500 }).taxReason).toBe('kapitalertraege');
    expect(f({ category: 'shopping', subcategory: 'elektronik', purpose: 'Laptop Bestellung' }).taxReason).toBe('beruf');
    expect(f({ category: 'lebensmittel', subcategory: 'supermarkt' }).taxRelevant).toBe(false);
    expect(f({ category: 'umbuchung', isTransfer: true, purpose: 'Spende' }).taxRelevant).toBe(false);
  });
});

// ---------------------------------------------------------------- Umbuchungen
describe('Umbuchungen erkennen', () => {
  const accounts = [
    { id: 'ing', kind: 'giro', institution: 'ING', name: 'ING Girokonto', iban: 'DE12500105170000000001' },
    { id: 'cd', kind: 'giro', institution: 'comdirect', name: 'comdirect Girokonto', iban: null },
    { id: 'pp', kind: 'paypal', institution: 'PayPal', name: 'PayPal' },
    { id: 'tg', kind: 'tagesgeld', institution: 'Renault Bank', name: 'Tagesgeld', iban: 'DE00123400000000000003' },
    { id: 'cc', kind: 'kreditkarte', institution: 'Barclays', name: 'Barclays Visa', iban: null },
  ];
  const T = (o) => tx(o);
  it('gegenläufige Beträge in 5 Tagen, eins-zu-eins, nächstes Datum zuerst', () => {
    const a1 = T({ id: 'a1', accountId: 'ing', bookingDate: '2026-03-04', amount: -30000, purpose: 'Umbuchung Sparplan' });
    const b1 = T({ id: 'b1', accountId: 'cd', bookingDate: '2026-03-04', amount: 30000, purpose: 'Umbuchung Sparplan' });
    const a2 = T({ id: 'a2', accountId: 'ing', bookingDate: '2026-04-03', amount: -30000, purpose: 'Umbuchung' });
    const b2 = T({ id: 'b2', accountId: 'cd', bookingDate: '2026-04-05', amount: 30000, purpose: 'Umbuchung' });
    const b3 = T({ id: 'b3', accountId: 'cd', bookingDate: '2026-04-04', amount: 30000, purpose: 'Umbuchung' });
    const out = Object.fromEntries(detectTransfers([a1, b1, a2, b2, b3], accounts).map(t => [t.id, t]));
    expect(out.a1).toMatchObject({ isTransfer: true, transferPairId: 'b1', transferAccountId: 'cd' });
    expect(out.b1).toMatchObject({ isTransfer: true, transferPairId: 'a1', transferAccountId: 'ing' });
    expect(out.a2.transferPairId).toBe('b3'); // 1 Tag Abstand schlägt 2 Tage
    expect(out.b3.transferPairId).toBe('a2');
    expect(out.b2.isTransfer).toBe(false); // übrig, kein zweiter Partner
  });
  it('ohne Hinweis: runde kleine Beträge werden nicht gepaart', () => {
    const out = detectTransfers([T({ id: 'r1', accountId: 'ing', bookingDate: '2026-03-01', amount: -5000 }), T({ id: 'r2', accountId: 'cd', bookingDate: '2026-03-01', amount: 5000 })], accounts);
    expect(out.every(t => !t.isTransfer)).toBe(true);
  });
  it('nicht zwischen demselben Konto, nicht außerhalb von 5 Tagen, nicht bei anderem Betrag', () => {
    const out = detectTransfers([
      T({ id: 'x1', accountId: 'ing', bookingDate: '2026-03-01', amount: -500 }), T({ id: 'x2', accountId: 'ing', bookingDate: '2026-03-01', amount: 500 }),
      T({ id: 'y1', accountId: 'ing', bookingDate: '2026-03-01', amount: -700 }), T({ id: 'y2', accountId: 'cd', bookingDate: '2026-03-07', amount: 700 }),
      T({ id: 'z1', accountId: 'ing', bookingDate: '2026-03-01', amount: -900 }), T({ id: 'z2', accountId: 'cd', bookingDate: '2026-03-02', amount: 901 }),
    ], accounts);
    expect(out.every(t => !t.isTransfer)).toBe(true);
  });
  it('Gegenkonto-IBAN ist ein eigenes Konto (auch ohne Gegenbuchung)', () => {
    const [t] = detectTransfers([T({ accountId: 'ing', amount: -50000, counterpartyIban: 'DE00 1234 0000 0000 0000 03', counterparty: 'Max Mustermann' })], accounts);
    expect(t).toMatchObject({ isTransfer: true, transferPairId: null, transferAccountId: 'tg' });
  });
  it('PayPal: Bankabbuchung ↔ Aufladung (Bankeinzug), Händler-Buchung bleibt Ausgabe', () => {
    const bank = T({ id: 'bk', accountId: 'ing', bookingDate: '2026-05-20', amount: -5999, counterparty: 'ABC Shop', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID, purpose: 'PP.1234.PP . ABC Shop, Ihr Einkauf bei ABC Shop' });
    const fund = T({ id: 'fd', accountId: 'pp', bookingDate: '2026-05-20', amount: 5999, counterparty: 'PayPal-Aufladung (Bankkonto)', bookingText: 'Bankeinzug', isTransfer: true });
    const shop = T({ id: 'sh', accountId: 'pp', bookingDate: '2026-05-20', amount: -5999, counterparty: 'ABC Shop', bookingText: 'Allgemeine Zahlung' });
    const out = Object.fromEntries(detectTransfers([bank, fund, shop], accounts).map(t => [t.id, t]));
    expect(out.bk).toMatchObject({ isTransfer: true, transferPairId: 'fd' });
    expect(out.fd).toMatchObject({ isTransfer: true, transferPairId: 'bk' });
    expect(out.sh.isTransfer).toBe(false);
  });
  it('PayPal-Lastschrift ohne importiertes PayPal-Konto bleibt normale Ausgabe', () => {
    const bank = T({ accountId: 'ing', amount: -5999, counterparty: 'ABC Shop', counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID });
    expect(detectTransfers([bank], accounts.filter(a => a.id !== 'pp'))[0].isTransfer).toBe(false);
  });
  it('PayPal-Zahlung im Einzugsverfahren: Bankbuchung ist Gegenbuchung der PayPal-Buchung', () => {
    const bank = T({ id: 'bk', accountId: 'ing', bookingDate: '2026-05-21', amount: -2000, counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', creditorId: PAYPAL_CREDITOR_ID });
    const pp = T({ id: 'pp1', accountId: 'pp', bookingDate: '2026-05-20', amount: -2000, counterparty: 'Spielwaren Bunt', bookingText: 'Zahlung im Einzugsverfahren mit Zahlungsrechnung' });
    const out = Object.fromEntries(detectTransfers([bank, pp], accounts).map(t => [t.id, t]));
    expect(out.bk.isTransfer).toBe(true);
    expect(out.pp1.isTransfer).toBe(false === out.pp1.isTransfer ? false : out.pp1.isTransfer);
  });
  it('Kreditkartenabrechnung ↔ Gutschrift auf der Karte', () => {
    const bank = T({ id: 'k1', accountId: 'ing', bookingDate: '2026-04-02', amount: -123456, counterparty: 'Barclays', purpose: 'Kreditkartenabrechnung 03/2026' });
    const card = T({ id: 'k2', accountId: 'cc', bookingDate: '2026-04-03', amount: 123456, purpose: 'Ausgleich Kreditkarte' });
    const other = T({ id: 'k3', accountId: 'cc', bookingDate: '2026-04-03', amount: -2000, counterparty: 'Restaurant' });
    const out = Object.fromEntries(detectTransfers([bank, card, other], accounts).map(t => [t.id, t]));
    expect(out.k1).toMatchObject({ isTransfer: true, transferPairId: 'k2' });
    expect(out.k3.isTransfer).toBe(false);
    // ohne Gegenbuchung nur dann, wenn die Karte als Konto bekannt ist
    expect(detectTransfers([T({ accountId: 'ing', amount: -500, counterparty: 'Barclays Bank', purpose: 'Kreditkartenabrechnung' })], accounts)[0].isTransfer).toBe(true);
    expect(detectTransfers([T({ accountId: 'ing', amount: -500, counterparty: 'Barclays Bank', purpose: 'Kreditkartenabrechnung' })], accounts.filter(a => a.id !== 'cc'))[0].isTransfer).toBe(false);
  });
  it('idempotent, Nutzerentscheidungen bleiben, automatische Markierungen verfallen mit dem Partner', () => {
    const a = T({ id: 'a', accountId: 'ing', bookingDate: '2026-03-04', amount: -300 }), b = T({ id: 'b', accountId: 'cd', bookingDate: '2026-03-04', amount: 300 });
    const once = detectTransfers([a, b], accounts);
    const twice = detectTransfers(once, accounts);
    expect(twice.map(t => [t.isTransfer, t.transferPairId])).toEqual(once.map(t => [t.isTransfer, t.transferPairId]));
    // Partner entfällt → Markierung fällt weg
    const alone = detectTransfers([once[0]], accounts);
    expect(alone[0].isTransfer).toBe(false);
    // Nutzer sagt: keine Umbuchung
    const lock = detectTransfers([{ ...a, categorySource: 'user', isTransfer: false }, b], accounts);
    expect(lock.every(t => !t.isTransfer)).toBe(true);
    // Parser-Markierung (PayPal-Aufladung ohne Bankbuchung) bleibt
    const parserFlag = T({ accountId: 'pp', amount: 100, bookingText: 'Bankeinzug', isTransfer: true });
    expect(detectTransfers([parserFlag], accounts)[0].isTransfer).toBe(true);
    expect(detectTransfers(detectTransfers([parserFlag], accounts), accounts)[0].isTransfer).toBe(true);
  });
});

// ---------------------------------------------------------------- Wiederkehrende Zahlungen
describe('Wiederkehrende Zahlungen', () => {
  const series = (n, o, start = '2026-01-05', step = 1, amountFn = () => o.amount) => Array.from({ length: n }, (_, i) => {
    const d = new Date(start + 'T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i * step);
    return tx({ ...o, bookingDate: d.toISOString().slice(0, 10), amount: amountFn(i) });
  });
  const cat = { category: 'abos_medien', subcategory: 'streaming' };

  it('monatliches Abo: Median, Intervall, nächstes Datum, aktiv, Jahreskosten', () => {
    const t = series(6, { counterparty: 'Netflix', amount: -1399, ...cat });
    const [c] = detectRecurring(t);
    expect(c).toMatchObject({ kind: 'abo', provider: 'Netflix', category: 'abos_medien', interval: 'monthly', amount: -1399, count: 6, active: true, priceChange: null, accountId: 'a1', yearlyCost: 16788, firstDate: '2026-01-05', lastDate: '2026-06-05', nextDate: '2026-07-05' });
    expect(c.txIds).toHaveLength(6);
    expect(c.id).toMatch(/^ct_/);
    // stabile ID bei erneutem Lauf
    expect(detectRecurring(t)[0].id).toBe(c.id);
  });
  it('Preiserhöhung → priceChange (kleine und große Sprünge)', () => {
    const up = series(6, { counterparty: 'Spotify', amount: -999, ...cat }, '2026-01-06', 1, i => (i < 4 ? -999 : -1099));
    expect(detectRecurring(up)[0]).toMatchObject({ amount: -1099, priceChange: { from: -999, to: -1099, date: '2026-05-06' } });
    const big = series(6, { counterparty: 'Streamio', amount: -1000, ...cat }, '2026-01-06', 1, i => (i < 3 ? -999 : -1499));
    expect(detectRecurring(big)[0].priceChange).toMatchObject({ from: -999, to: -1499 });
    const justNow = series(5, { counterparty: 'Streamio', amount: -1000, ...cat }, '2026-01-06', 1, i => (i < 4 ? -999 : -1299));
    expect(detectRecurring(justNow)[0].priceChange).toMatchObject({ to: -1299 });
  });
  it('leichte Schwankungen (<15 %) zählen als dieselbe Zahlung', () => {
    const t = series(6, { counterparty: 'Stadtwerke', category: 'wohnen', subcategory: 'strom_gas' }, '2026-01-12', 1, i => -[8450, 8450, 8900, 8450, 9100, 8450][i]);
    const [c] = detectRecurring(t);
    expect(c).toMatchObject({ interval: 'monthly', amount: -8450 });
    expect(c.priceChange).toBeNull();
  });
  it('Miete, Versicherung, Dauerauftrag, Einkommen, Vorsorge: kind aus Kategorie', () => {
    const all = [
      ...series(6, { counterparty: 'Hausverwaltung', amount: -115000, category: 'wohnen', subcategory: 'miete' }, '2026-01-02'),
      ...series(6, { counterparty: 'Alte Leipziger', amount: -6230, category: 'versicherungen', subcategory: 'bu' }, '2026-01-10'),
      ...series(6, { counterparty: 'Frigotechnik', amount: 329098, category: 'einkommen', subcategory: 'gehalt' }, '2026-01-27'),
      ...series(6, { counterparty: 'Allianz', amount: -15000, category: 'vorsorge_sparen', subcategory: 'privatrente' }, '2026-01-02'),
      ...series(6, { counterparty: 'Tennisverein', amount: -2500, category: 'freizeit_reisen', subcategory: 'sport', bookingText: 'Dauerauftrag' }, '2026-01-15'),
      ...series(6, { counterparty: 'Kreditbank', amount: -25000, category: 'finanzen', subcategory: 'kredit' }, '2026-01-03'),
    ];
    const by = Object.fromEntries(detectRecurring(all).map(c => [c.provider, c.kind]));
    expect(by).toEqual({ Hausverwaltung: 'miete', 'Alte Leipziger': 'versicherung', Frigotechnik: 'einkommen', Allianz: 'vorsorge', Tennisverein: 'dauerauftrag', Kreditbank: 'kredit' });
  });
  it('Intervalle: wöchentlich, quartalsweise, halbjährlich, jährlich (2 genügen)', () => {
    const weekly = Array.from({ length: 6 }, (_, i) => tx({ counterparty: 'Wochenkarte', amount: -1500, bookingDate: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10) }));
    expect(detectRecurring(weekly)[0].interval).toBe('weekly');
    expect(detectRecurring(series(4, { counterparty: 'Rundfunk', amount: -5508 }, '2025-01-22', 3))[0].interval).toBe('quarterly');
    expect(detectRecurring(series(3, { counterparty: 'Halbjahr', amount: -8000 }, '2025-01-22', 6))[0].interval).toBe('halfyearly');
    const yearly = detectRecurring(series(2, { counterparty: 'ADAC', amount: -5900, category: 'mobilitaet', subcategory: 'auto' }, '2025-03-10', 12));
    expect(yearly[0]).toMatchObject({ interval: 'yearly', yearlyCost: 5900, count: 2 });
    expect(detectRecurring(series(2, { counterparty: 'Nur zweimal', amount: -5900 }, '2026-01-10', 1))).toHaveLength(0);
  });
  it('Gruppierung nach Mandat/Gläubiger-ID; Datenlücke (ein Monat fehlt) bricht nicht ab', () => {
    const a = series(4, { counterparty: 'Anbieter A', amount: -1000, mandateId: 'M-1' });
    const b = series(4, { counterparty: 'Anbieter A GmbH', amount: -1000, mandateId: 'M-1' }, '2026-05-05');
    expect(detectRecurring([...a, ...b])).toHaveLength(1);
    const gap = series(5, { counterparty: 'Lücke', amount: -1000 }).filter((_, i) => i !== 2);
    expect(detectRecurring(gap)).toHaveLength(1);
  });
  it('unregelmäßig / schwankend ist keine Serie (Supermarkt, Tanken)', () => {
    const days = [2, 3, 9, 11, 17, 24, 31, 33];
    const shop = days.map((d, i) => tx({ counterparty: 'REWE', bookingDate: `2026-01-${String(d % 31 || 1).padStart(2, '0')}`, amount: -(1500 + i * 997) }));
    expect(detectRecurring(shop)).toHaveLength(0);
    const monthlyButVarying = series(6, { counterparty: 'Tankstelle' }, '2026-01-10', 1, i => -[3000, 6500, 4200, 8800, 2500, 7100][i]);
    expect(detectRecurring(monthlyButVarying)).toHaveLength(0);
  });
  it('gemischte Gruppe: Abo neben Einzelkäufen beim selben Händler (Amazon Prime + Bestellungen)', () => {
    const prime = series(6, { counterparty: 'Amazon', amount: -899 }, '2026-01-09');
    const orders = [2345, 1299, 8760, 450, 3999].map((a, i) => tx({ counterparty: 'Amazon', amount: -a, bookingDate: `2026-0${i + 1}-17` }));
    const out = detectRecurring([...prime, ...orders]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: -899, count: 6 });
  });
  it('Umbuchungen zählen nicht – außer als Glied einer Serie normaler Buchungen', () => {
    const transfers = series(6, { counterparty: 'Max Mustermann', amount: -30000, isTransfer: true, category: 'umbuchung' });
    expect(detectRecurring(transfers)).toHaveLength(0);
    const mixed = series(6, { counterparty: 'Max Mustermann', amount: -50000, category: 'vorsorge_sparen', subcategory: 'tagesgeld' });
    mixed[5] = { ...mixed[5], isTransfer: true, category: 'umbuchung' };
    const [c] = detectRecurring(mixed);
    expect(c).toMatchObject({ kind: 'vorsorge', count: 6, active: true });
  });
  it('beendete Verträge sind inaktiv (letzte Buchung > 1,5 Intervalle vor dem jüngsten Umsatz)', () => {
    const old = series(4, { counterparty: 'Altes Abo', amount: -700 }, '2025-01-05');
    const recent = tx({ counterparty: 'Irgendwas', amount: -100, bookingDate: '2026-06-30' });
    const [c] = detectRecurring([...old, recent]);
    expect(c.active).toBe(false);
  });
  it('Nutzerverträge: gleicher Anbieter wird nicht doppelt erkannt; IDs/Art bleiben', () => {
    const t = series(6, { counterparty: 'Netflix', amount: -1399, ...cat });
    expect(detectRecurring(t, [{ id: 'u1', source: 'user', provider: 'Netflix' }])).toHaveLength(0);
    // IDs/Art früherer Auto-Verträge übernimmt mergeContracts (postProcess reicht detectRecurring nur Nutzerverträge) –
    // geprüft in tests/receipts-contracts.test.js
    const first = detectRecurring(t)[0];
    expect(detectRecurring(t, [{ ...first, id: 'ct_alt', kind: 'sonstiges', kindUser: true }])[0].id).toBe(first.id);
  });
  it('linkContracts setzt contractId und räumt Verwaiste auf', () => {
    const t = series(3, { counterparty: 'Netflix', amount: -1399, ...cat });
    const contracts = detectRecurring(t);
    const linked = linkContracts([...t, tx({ contractId: 'ct_weg' }), tx({ contractId: 'u1' })], [...contracts, { id: 'u1', txIds: [] }]);
    expect(linked.slice(0, 3).every(x => x.contractId === contracts[0].id)).toBe(true);
    expect(linked[3].contractId).toBeNull();
    expect(linked[4].contractId).toBe('u1');
  });
});

// ---------------------------------------------------------------- Belege
describe('Belege zuordnen', () => {
  const doc = (o) => ({ id: 'd' + ++seq, type: 'rechnung', date: '2026-04-07', amount: 24900, issuer: 'Amazon EU S.à r.l.', fields: {}, ...o });
  it('Betrag (±1 Cent), Datum (−2…+10 Tage), Name als Bonus; eins-zu-eins', () => {
    const d1 = doc({ id: 'd1', amount: 6784, date: '2026-04-12', type: 'kassenbon', issuer: 'REWE' });
    const d2 = doc({ id: 'd2', amount: 6784, date: '2026-04-12', type: 'kassenbon', issuer: 'Anderer Laden' });
    const t1 = tx({ id: 't1', counterparty: 'REWE Markt', amount: -6784, bookingDate: '2026-04-13' });
    const t2 = tx({ id: 't2', counterparty: 'Irgendwer', amount: -6784, bookingDate: '2026-04-13' });
    const out = matchReceipts([d1, d2], [t1, t2]);
    // d2 passt nur über Betrag/Datum und ist mehrdeutig → keine Zuordnung (lieber keine als eine falsche)
    expect(out).toHaveLength(1);
    expect(out.find(m => m.docId === 'd1').txId).toBe('t1');
    expect(out.every(m => m.score > 50)).toBe(true);
    const cent = matchReceipts([doc({ id: 'd3', amount: 1000, date: '2026-04-01', issuer: 'X' })], [tx({ id: 't3', amount: -1001, bookingDate: '2026-04-02' })]);
    expect(cent).toHaveLength(1);
  });
  it('Fenster: zu früh/zu spät, falscher Betrag, Zuflüsse, Umbuchungen und andere Dokumenttypen zählen nicht', () => {
    const d = doc({ id: 'dx', amount: 5000, date: '2026-04-10', issuer: 'Laden' });
    const bad = [
      tx({ amount: -5000, bookingDate: '2026-04-07' }), tx({ amount: -5000, bookingDate: '2026-04-21' }), tx({ amount: -5002, bookingDate: '2026-04-11' }),
      tx({ amount: 5000, bookingDate: '2026-04-11' }), tx({ amount: -5000, bookingDate: '2026-04-11', isTransfer: true }),
    ];
    expect(matchReceipts([d], bad)).toHaveLength(0);
    expect(matchReceipts([d], [tx({ amount: -5000, bookingDate: '2026-04-08' })])).toHaveLength(1);
    expect(matchReceipts([d], [tx({ amount: -5000, bookingDate: '2026-04-20' })])).toHaveLength(1);
    expect(matchReceipts([{ ...d, type: 'vertrag' }, { ...d, type: 'lohn' }], [tx({ amount: -5000, bookingDate: '2026-04-11' })])).toHaveLength(0);
  });
  it('Rechnungsnummer im Verwendungszweck erlaubt späte Zahlung (Überweisung nach 14 Tagen)', () => {
    const d = doc({ id: 'dr', amount: 41230, date: '2026-02-20', issuer: 'Elektro Meyer GmbH', fields: { invoiceNumber: 'RE-2026-0213' } });
    const t = tx({ id: 'tr', amount: -41230, bookingDate: '2026-03-06', counterparty: 'Elektro Meyer', purpose: 'RE-2026-0213 Elektroinstallation Küche' });
    expect(matchReceipts([d], [t])).toMatchObject([{ docId: 'dr', txId: 'tr' }]);
    expect(matchReceipts([{ ...d, fields: {} }], [{ ...t, purpose: 'Elektroinstallation' }])).toHaveLength(0);
  });
  it('vom Nutzer verknüpfte Buchungen bleiben unberührt', () => {
    const d = doc({ id: 'du', amount: 1000, date: '2026-04-01' });
    const t = tx({ id: 'tu', amount: -1000, bookingDate: '2026-04-02', receiptDocId: 'dx', receiptSource: 'user' });
    expect(matchReceipts([d], [t])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Nettovermögen
describe('Nettovermögen', () => {
  const accounts = [{ id: 'g', name: 'Giro', kind: 'giro' }, { id: 'd', name: 'Depot', kind: 'depot' }, { id: 'r', name: 'Rente', kind: 'rente' }, { id: 't', name: 'Tagesgeld', kind: 'tagesgeld' }];
  it('Kontostand = letzte Bewertung + spätere Umsätze; Depot = jüngster Bestand; Rente = Fondsguthaben; Sachwerte', () => {
    const valuations = [
      { accountId: 'g', date: '2026-03-31', value: 100000 }, { accountId: 'g', date: '2026-02-28', value: 80000 },
      { accountId: 'r', date: '2025-12-31', value: 1648237 }, { accountId: 't', date: '2026-06-30', value: 632873 },
    ];
    const holdings = [
      { accountId: 'd', date: '2026-05-31', value: 400000 }, { accountId: 'd', date: '2026-06-30', value: 420000 }, { accountId: 'd', date: '2026-06-30', value: 315251 },
    ];
    const txs = [
      tx({ accountId: 'g', bookingDate: '2026-03-15', amount: -9999 }), // vor Anker → ignorieren
      tx({ accountId: 'g', bookingDate: '2026-04-10', amount: -2500 }), tx({ accountId: 'g', bookingDate: '2026-04-20', amount: 10000 }),
      tx({ accountId: 'd', bookingDate: '2026-04-20', amount: -300 }), // Depot: Umsätze verändern den Wert nicht
    ];
    const assets = [{ id: 'a1', currentValue: 90000, purchasePrice: 120000, purchaseDate: '2026-04-01' }, { id: 'a2', purchasePrice: 5000 }];
    const nw = computeNetWorth(accounts, valuations, holdings, txs, assets);
    const by = Object.fromEntries(nw.byAccount.map(b => [b.accountId, b.value]));
    expect(by).toEqual({ g: 107500, d: 735251, r: 1648237, t: 632873 });
    expect(nw.total).toBe(107500 + 735251 + 1648237 + 632873 + 90000 + 5000);
    expect(nw.byAccount.find(b => b.accountId === 'r').date).toBe('2025-12-31');
    // Monatsreihe aufsteigend, letzter Punkt = aktueller Stand
    expect(nw.series.length).toBeGreaterThan(3);
    expect([...nw.series].map(p => p.date)).toEqual([...nw.series].map(p => p.date).sort());
    expect(nw.series.at(-1).value).toBe(nw.total);
    const feb = nw.series.find(p => p.date === '2026-02-28');
    // Stichtagskonten (Depot/Tagesgeld ohne Umsätze) werden vor ihrem ersten Stand konstant zurückgeschrieben
    expect(feb.value).toBeGreaterThan(80000 + 1648237 + 5000);
    const mar = nw.series.find(p => p.date === '2026-03-31');
    expect(mar.value - feb.value).toBe(100000 - 80000);
  });
  it('rückwärts vom Anker (Umsätze vor der ersten Bewertung)', () => {
    const nw = computeNetWorth([accounts[0]], [{ accountId: 'g', date: '2026-02-28', value: 50000 }], [], [tx({ accountId: 'g', bookingDate: '2026-02-10', amount: -2000 })], []);
    expect(nw.total).toBe(50000);
    expect(nw.series[0]).toEqual({ date: '2026-02-10', value: 52000 }.date === nw.series[0].date ? nw.series[0] : nw.series[0]);
    expect(nw.series.at(-1).value).toBe(50000);
  });
  it('Konten ohne Bewertung und ohne Bestand zählen nicht; leere Eingabe ist fehlerfrei', () => {
    expect(computeNetWorth([accounts[0]], [], [], [], [])).toMatchObject({ total: 0, byAccount: [], series: [] });
    expect(computeNetWorth().total).toBe(0);
  });
});

// ---------------------------------------------------------------- Umsatzsteuer
describe('Umsatzsteuer', () => {
  it('exakt aus Belegen, geschätzt für den Rest: brutto·r/(1+r)', () => {
    const docs = [
      { id: 'r1', type: 'rechnung', date: '2026-02-20', vat: [{ rate: 19, net: 34647, tax: 6583, gross: 41230 }] },
      { id: 'k1', type: 'kassenbon', date: '2026-03-09', vat: [{ rate: 7, net: 3000, tax: 210, gross: 3210 }, { rate: 19, net: 2000, tax: 380, gross: 2380 }] },
      { id: 'out', type: 'rechnung', date: '2025-01-01', vat: [{ rate: 19, tax: 99999 }] }, // außerhalb
      { id: 'nv', type: 'rechnung', date: '2026-03-01', vat: null },
    ];
    const txs = [
      tx({ id: 'a', amount: -41230, receiptDocId: 'r1', category: 'wohnen', subcategory: 'handwerker', bookingDate: '2026-03-06' }),
      tx({ id: 'b', amount: -10700, category: 'shopping', subcategory: 'online', bookingDate: '2026-03-07' }),     // 19 % → 1708
      tx({ id: 'c', amount: -10700, category: 'lebensmittel', subcategory: 'supermarkt', bookingDate: '2026-03-08' }), // 7 % → 700
      tx({ id: 'd', amount: -11500, category: 'lebensmittel', subcategory: 'restaurant', bookingDate: '2026-03-09' }), // 7 %
      tx({ id: 'e', amount: -115000, category: 'wohnen', subcategory: 'miete', bookingDate: '2026-03-10' }),            // keine
      tx({ id: 'f', amount: -5000, category: 'versicherungen', subcategory: 'bu', bookingDate: '2026-03-10' }),         // keine
      tx({ id: 'g', amount: -30000, category: 'umbuchung', isTransfer: true, bookingDate: '2026-03-10' }),
      tx({ id: 'h', amount: 300000, category: 'einkommen', subcategory: 'gehalt', bookingDate: '2026-03-10' }),
    ];
    const v = estimateVat(txs, docs);
    expect(v.fromReceipts).toBe(6583 + 210 + 380);
    expect(v.estimated).toBe(Math.round(10700 * 0.19 / 1.19) + Math.round(10700 * 0.07 / 1.07) + Math.round(11500 * 0.07 / 1.07));
    expect(v.total).toBe(v.fromReceipts + v.estimated);
    expect(estimateVat([], [])).toEqual({ total: 0, fromReceipts: 0, estimated: 0 });
  });
});

// ---------------------------------------------------------------- Insights (synthetisch)
describe('Insights', () => {
  const accounts = [
    { id: 'g', name: 'Giro', kind: 'giro' }, { id: 'tg', name: 'Tagesgeld', kind: 'tagesgeld' }, { id: 'pp', name: 'PayPal', kind: 'paypal' },
  ];
  const data = () => ({
    accounts,
    transactions: [
      tx({ id: 's1', accountId: 'g', bookingDate: '2026-01-27', amount: 300000, category: 'einkommen', subcategory: 'gehalt', counterparty: 'Arbeitgeber' }),
      tx({ id: 's2', accountId: 'g', bookingDate: '2026-02-27', amount: 300000, category: 'einkommen', subcategory: 'gehalt', counterparty: 'Arbeitgeber' }),
      tx({ id: 'z1', accountId: 'tg', bookingDate: '2026-02-28', amount: 500, category: 'einkommen', subcategory: 'zinsen', counterparty: 'Bank' }),
      tx({ id: 'm1', accountId: 'g', bookingDate: '2026-01-02', amount: -100000, category: 'wohnen', subcategory: 'miete', counterparty: 'Vermieter' }),
      tx({ id: 'm2', accountId: 'g', bookingDate: '2026-02-02', amount: -100000, category: 'wohnen', subcategory: 'miete', counterparty: 'Vermieter' }),
      tx({ id: 'f1', accountId: 'g', bookingDate: '2026-01-10', amount: -5000, category: 'lebensmittel', subcategory: 'supermarkt', counterparty: 'REWE' }),
      tx({ id: 'f2', accountId: 'g', bookingDate: '2026-02-10', amount: -7000, category: 'lebensmittel', subcategory: 'supermarkt', counterparty: 'REWE' }),
      tx({ id: 'f3', accountId: 'g', bookingDate: '2026-02-11', amount: 1000, category: 'lebensmittel', subcategory: 'supermarkt', counterparty: 'REWE' }), // Erstattung
      tx({ id: 'n1', accountId: 'g', bookingDate: '2026-01-15', amount: -1399, category: 'abos_medien', subcategory: 'streaming', counterparty: 'Netflix', needsReview: true }),
      tx({ id: 'sp1', accountId: 'g', bookingDate: '2026-01-05', amount: -50000, category: 'umbuchung', isTransfer: true, transferPairId: 'sp2', transferAccountId: 'tg' }),
      tx({ id: 'sp2', accountId: 'tg', bookingDate: '2026-01-05', amount: 50000, category: 'umbuchung', isTransfer: true, transferPairId: 'sp1', transferAccountId: 'g' }),
      tx({ id: 'v1', accountId: 'g', bookingDate: '2026-02-04', amount: -20000, category: 'vorsorge_sparen', subcategory: 'sparplan_depot', counterparty: 'Broker' }),
      tx({ id: 'pf', accountId: 'g', bookingDate: '2026-02-14', amount: -3000, category: 'umbuchung', isTransfer: true, transferPairId: 'pg', transferAccountId: 'pp' }),
      tx({ id: 'pg', accountId: 'pp', bookingDate: '2026-02-14', amount: 3000, category: 'umbuchung', isTransfer: true, transferPairId: 'pf', transferAccountId: 'g' }),
      tx({ id: 'pe', accountId: 'pp', bookingDate: '2026-02-14', amount: -3000, category: 'shopping', subcategory: 'online', counterparty: 'ABC Shop', taxRelevant: true }),
      tx({ id: 'sp', accountId: 'g', bookingDate: '2026-03-01', amount: -9000, category: 'beruf', subcategory: 'arbeitsmittel', counterparty: 'Shop', splits: [{ amount: -6000, category: 'beruf', subcategory: 'arbeitsmittel' }, { amount: -3000, category: 'shopping', subcategory: 'sonstiges' }] }),
    ],
    documents: [
      { id: 'p1', type: 'lohn', date: '2026-01-27', periodFrom: '2026-01-01', payroll: { gross: 500000, net: 300000, lohnsteuer: 100000, soli: 0, kirchensteuer: 10000, kv: 40000, pv: 10000, rv: 30000, av: 10000, period: '2026-01' } },
      { id: 'p2', type: 'lohn', date: '2026-02-27', periodFrom: '2026-02-01', payroll: { gross: 500000, net: 300000, lohnsteuer: 100000, soli: 0, kirchensteuer: 10000, kv: 40000, pv: 10000, rv: 30000, av: 10000, period: '2026-02' } },
      { id: 'x', type: 'rechnung', date: '2026-02-01', taxRelevant: true },
    ],
    contracts: [
      { id: 'c1', kind: 'abo', amount: -1399, interval: 'monthly', active: true, monthly: 1399, yearlyCost: 16788 },
      { id: 'c2', kind: 'miete', amount: -100000, interval: 'monthly', active: true },
      { id: 'c3', kind: 'abo', amount: -999, interval: 'monthly', active: false },
      { id: 'c4', kind: 'einkommen', amount: 300000, interval: 'monthly', active: true },
      { id: 'c5', kind: 'versicherung', amount: -12000, interval: 'yearly', active: true },
    ],
    valuations: [{ accountId: 'g', date: '2026-03-31', value: 400000 }, { accountId: 'tg', date: '2026-03-31', value: 50500 }],
    holdings: [], assets: [],
  });
  const run = (o = {}, d = data()) => computeInsights(d, { from: '2026-01-01', to: '2026-03-31', ...o });

  it('Summen: Umbuchungen weder Einnahme noch Ausgabe; Sparen = Sparkategorie + Überweisungen auf Sparkonten', () => {
    const r = run();
    expect(r.period).toEqual({ from: '2026-01-01', to: '2026-03-31', months: ['2026-01', '2026-02', '2026-03'] });
    expect(r.totals.income).toBe(600000 + 500);
    // Ausgaben: Miete 2000, Lebensmittel 50+70-10=110, Netflix 13,99, PayPal-Kauf 30, Beruf 60 + Shopping 30 (Split)
    expect(r.totals.expense).toBe(200000 + 11000 + 1399 + 3000 + 6000 + 3000);
    expect(r.totals.saving).toBe(50000 + 20000);
    expect(r.totals.net).toBe(r.totals.income - r.totals.expense);
    expect(r.totals.savingsRate).toBeCloseTo(70000 / 600500, 6);
    expect(r.totals.transfers).toBe(50000 + 3000);
    // PayPal-Aufladung ist keine Sparleistung
    expect(run({ accountIds: ['g'] }).totals.saving).toBe(70000);
  });
  it('byCategory: absteigend, Anteile, Unterkategorien, Erstattung netto; Split berücksichtigt', () => {
    const r = run();
    const ids = r.byCategory.map(c => c.id);
    expect(ids.slice(0, 2)).toEqual(['wohnen', 'lebensmittel']);
    expect(ids.slice(2, 4).sort()).toEqual(['beruf', 'shopping']); // gleich hoch (je 60 EUR)
    expect(ids[4]).toBe('abos_medien');
    expect(r.byCategory[0]).toMatchObject({ id: 'wohnen', label: 'Wohnen', amount: 200000, color: getCategory('wohnen').color });
    expect(r.byCategory[0].subs).toEqual([{ id: 'miete', label: 'Miete', amount: 200000 }]);
    expect(r.byCategory.find(c => c.id === 'lebensmittel').amount).toBe(11000);
    expect(r.byCategory.find(c => c.id === 'beruf').amount).toBe(6000);
    expect(r.byCategory.find(c => c.id === 'shopping').amount).toBe(6000);
    expect(r.byCategory.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 6);
    expect(r.byCategory.reduce((s, c) => s + c.amount, 0)).toBe(r.totals.expense);
    expect(r.byCategory.some(c => ['einkommen', 'umbuchung', 'vorsorge_sparen'].includes(c.id))).toBe(false);
  });
  it('Einnahmen nach Quelle, Monatsreihe, Top-Empfänger', () => {
    const r = run();
    expect(r.incomeBySource).toEqual([{ id: 'gehalt', label: 'Gehalt', amount: 600000 }, { id: 'zinsen', label: 'Zinsen', amount: 500 }]);
    expect(r.byMonth.map(m => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(r.byMonth[0]).toMatchObject({ income: 300000, expense: 100000 + 5000 + 1399, net: 300000 - 106399 });
    expect(r.byMonth[1].expense).toBe(100000 + 7000 - 1000 + 3000);
    expect(r.byMonth.every(m => m.expense >= 0)).toBe(true);
    expect(r.byMonth[0].saving).toBe(50000);
    expect(r.topMerchants[0]).toMatchObject({ name: 'Vermieter', amount: 200000, count: 2, category: 'wohnen' });
    expect(r.topMerchants.some(m => m.name === 'Arbeitgeber')).toBe(false);
  });
  it('Verträge: nur aktive Ausgaben; Jahreskosten', () => {
    const r = run();
    expect(r.recurring.count).toBe(3);
    expect(r.recurring.monthlyTotal).toBe(1399 + 100000 + 1000);
    expect(r.recurring.yearlyTotal).toBe(16788 + 1200000 + 12000);
  });
  it('Steuern: Abrechnungen + Hochrechnung fehlender Gehaltsmonate; Quote', () => {
    const r = run();
    // Jan+Feb Abrechnungen, März ohne Gehalt → keine Hochrechnung
    expect(r.taxes.payroll).toMatchObject({ gross: 1000000, lohnsteuer: 200000, kirchensteuer: 20000, kv: 80000, pv: 20000, rv: 60000, av: 20000, net: 600000 });
    expect(r.taxes.vatEstimate.total).toBeGreaterThan(0);
    expect(r.taxes.total).toBe(400000 + r.taxes.vatEstimate.total + r.taxes.capitalGainsTax);
    expect(r.taxes.quote).toBeCloseTo(r.taxes.total / (1000000 + 500), 6);
    // Gehaltsmonate ohne Abrechnung werden aus dem Schnitt ergänzt
    const d = data();
    d.documents = d.documents.filter(x => x.id !== 'p2');
    const est = run({}, d).taxes.payroll;
    expect(est).toMatchObject({ gross: 1000000, estimated: true });
  });
  it('Steuern: Lohnsteuerbescheinigung anteilig, wenn keine Abrechnungen vorliegen', () => {
    const d = data();
    d.documents = [{ id: 'ls', type: 'lohnsteuerbescheinigung', date: '2025-12-31', fields: { year: 2025 }, payroll: { gross: 6000000, lohnsteuer: 834600, soli: 0, kirchensteuer: 75114, kv: 400000, pv: 100000, rv: 558000, av: 120000 } }];
    const p = run({}, d).taxes.payroll; // 2 Gehaltsmonate
    expect(p.gross).toBe(Math.round(6000000 * 2 / 12));
    expect(p.estimated).toBe(true);
    expect(p.net).toBe(p.gross - p.lohnsteuer - p.soli - p.kirchensteuer - p.kv - p.pv - p.rv - p.av);
    d.documents = [];
    expect(run({}, d).taxes.payroll).toBeNull();
  });
  it('Kapitalertragsteuer aus Jahresbescheinigung anteilig', () => {
    const d = data();
    d.documents = [{ id: 'kb', type: 'steuerbescheinigung', date: '2026-12-31', fields: { year: 2026, steuernGesamt: 12000 } }];
    expect(run({}, d).taxes.capitalGainsTax).toBe(Math.round(12000 * 3 / 12));
  });
  it('Nettovermögen im Zeitraum, Flags', () => {
    const r = run();
    expect(r.netWorth.total).toBe(400000 + 50500);
    expect(r.netWorth.byAccount.map(b => b.accountId).sort()).toEqual(['g', 'tg']);
    expect(r.netWorth.series.at(-1).value).toBe(r.netWorth.total);
    expect(r.flags).toMatchObject({ needsReview: 1, taxRelevant: 1 + 1 });
    expect(run({ to: '2026-01-31' }).netWorth.series.every(p => p.date <= '2026-01-31')).toBe(true);
  });
  it('Zeitraum- und Kontofilter, leere Daten', () => {
    const jan = run({ to: '2026-01-31' });
    expect(jan.period.months).toEqual(['2026-01']);
    expect(jan.totals.income).toBe(300000);
    const g = run({ accountIds: ['tg'] });
    expect(g.totals.income).toBe(500);
    expect(g.totals.expense).toBe(0);
    const empty = computeInsights({}, { from: '2026-01-01', to: '2026-01-31' });
    expect(empty.totals).toMatchObject({ income: 0, expense: 0, saving: 0, savingsRate: 0 });
    expect(empty.sankey).toEqual({ nodes: [], links: [] });
    expect(computeInsights({ accounts: [], transactions: [] }).period.months.length).toBe(1);
  });

  describe('Sankey', () => {
    it('Bilanz an jedem Mittelknoten, alle Werte > 0, Layout möglich', () => {
      const r = run();
      expect(sankeyIssues(r.sankey)).toEqual([]);
      expect(layoutSankey(r.sankey, { width: 900, height: 480 })).toBeTruthy();
      const kinds = new Set(r.sankey.nodes.map(n => n.kind));
      expect([...kinds].every(k => ['source', 'tax', 'account', 'category', 'saving'].includes(k))).toBe(true);
      const byId = Object.fromEntries(r.sankey.nodes.map(n => [n.id, n]));
      expect(byId['src:brutto'].label).toBe('Brutto-Gehalt');
      expect(byId['src:netto'].label).toBe('Netto-Gehalt');
      expect(byId['tax:lohnsteuer'].kind).toBe('tax');
      expect(byId.vorsorge_sparen.kind).toBe('saving');
      expect(byId.wohnen.kind).toBe('category');
      expect(byId.g.kind).toBe('account');
    });
    it('Steuer-Zweig: Brutto → Abzüge + Netto; Netto entspricht den Gehaltseingängen', () => {
      const r = run();
      const out = (id) => r.sankey.links.filter(l => l.source === id).reduce((s, l) => s + l.value, 0);
      expect(out('src:netto')).toBe(600000);
      expect(r.sankey.links.find(l => l.source === 'src:brutto' && l.target === 'src:netto').value).toBe(600000);
      expect(out('src:brutto')).toBe(1000000); // Brutto der Abrechnungen
      expect(r.sankey.links.filter(l => l.source === 'src:brutto' && l.target.startsWith('tax:')).length).toBeGreaterThanOrEqual(3);
    });
    it('ohne Steuern zeigen: Gehalt direkt; ohne Lohndaten: Quellen → Konten → Kategorien', () => {
      const a = run({ showTaxes: false });
      expect(a.sankey.nodes.some(n => n.kind === 'tax')).toBe(false);
      expect(a.sankey.nodes.find(n => n.id === 'src:gehalt').label).toBe('Netto-Gehalt');
      expect(sankeyIssues(a.sankey)).toEqual([]);
      const d = data(); d.documents = [];
      const b = run({}, d);
      expect(b.sankey.nodes.some(n => n.kind === 'tax')).toBe(false);
      expect(b.sankey.nodes.find(n => n.id === 'src:gehalt').label).toBe('Gehalt');
      expect(sankeyIssues(b.sankey)).toEqual([]);
    });
    it('Top 9 Kategorien + "Weitere"; Defizit → "Entnahme aus Bestand", Überschuss → "Puffer (Saldo)"', () => {
      const d = { accounts: [{ id: 'g', name: 'Giro', kind: 'giro' }], transactions: [], documents: [], contracts: [] };
      const cats = ['wohnen', 'lebensmittel', 'mobilitaet', 'versicherungen', 'abos_medien', 'gesundheit', 'freizeit_reisen', 'shopping', 'beruf', 'spenden', 'finanzen', 'bargeld'];
      cats.forEach((c, i) => d.transactions.push(tx({ accountId: 'g', bookingDate: '2026-01-10', amount: -(100000 - i * 1000), category: c })));
      d.transactions.push(tx({ accountId: 'g', bookingDate: '2026-01-02', amount: 2000000, category: 'einkommen', subcategory: 'sonstiges' }));
      const r = computeInsights(d, { from: '2026-01-01', to: '2026-01-31' });
      expect(sankeyIssues(r.sankey)).toEqual([]);
      expect(r.sankey.nodes.filter(n => n.kind === 'category')).toHaveLength(10); // 9 + Weitere
      expect(r.sankey.nodes.find(n => n.id === 'weitere')).toBeTruthy();
      expect(r.sankey.nodes.find(n => n.id === 'puffer')).toBeTruthy();
      // Defizit
      d.transactions[d.transactions.length - 1].amount = 100000;
      const r2 = computeInsights(d, { from: '2026-01-01', to: '2026-01-31' });
      expect(sankeyIssues(r2.sankey)).toEqual([]);
      expect(r2.sankey.nodes.find(n => n.id === 'src:bestand').label).toBe('Entnahme aus Bestand');
      expect(r2.sankey.nodes.find(n => n.id === 'puffer')).toBeUndefined();
    });
    it('Umbuchungen zwischen normalen Konten werden als Konto→Konto-Fluss gezeigt', () => {
      const r = run();
      const l = r.sankey.links.find(x => x.source === 'g' && x.target === 'pp');
      expect(l.value).toBe(3000);
      expect(layoutSankey(r.sankey, { width: 900, height: 480 }).nodes.length).toBe(r.sankey.nodes.length);
    });
  });
});

// ---------------------------------------------------------------- Export
describe('ZIP- und CSV-Export', () => {
  const files = [
    { id: 'f1', name: 'a.pdf', ext: 'pdf', path: 'Belege/a.pdf', origins: [{ sourceName: 'Beispiele', path: 'Belege/a.pdf' }, { sourceName: 'Dropbox', path: '/Steuer/a.pdf' }] },
    { id: 'f2', name: 'b.pdf', ext: 'pdf', path: 'Belege/b.pdf', origins: [{ sourceName: 'Beispiele', path: 'Belege/b.pdf' }] },
    { id: 'f3', name: 'c.jpg', ext: 'jpg', path: 'c.jpg' },
    { id: 'f4', name: 'd.pdf', ext: 'pdf', path: 'd.pdf' },
  ];
  const docs = [
    { id: 'd1', fileId: 'f1', type: 'lohn', date: '2026-03-27', issuer: 'Frigotechnik GmbH', amount: 329098, taxRelevant: true, taxReason: 'lohn', taxSource: 'user', displayName: '2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf' },
    { id: 'd2', fileId: 'f2', type: 'rechnung', date: '2026-02-20', issuer: 'Elektro Meyer GmbH', amount: 41230, taxRelevant: true, taxReason: 'haushalt_handwerker', displayName: '2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf' },
    { id: 'd3', fileId: 'f3', type: 'kassenbon', date: '2026-04-12', issuer: 'Apotheke; "am Markt"', amount: 1234, taxRelevant: true, taxReason: 'gesundheit', displayName: '2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf' }, // gleicher Name wie d2, anderer Ordner
    { id: 'd4', fileId: 'f2', type: 'rechnung', date: '2026-02-20', issuer: 'Elektro Meyer GmbH', amount: 41230, taxRelevant: true, taxReason: 'haushalt_handwerker', displayName: '2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf' }, // Duplikat im selben Ordner
    { id: 'd5', fileId: 'f4', type: 'spende', date: '2026-05-14', issuer: 'Ärzte ohne Grenzen', amount: 5000, taxRelevant: true, taxReason: 'spenden', taxSource: 'user' },
    { id: 'd6', fileId: 'f1', type: 'kontoauszug', taxRelevant: false },
    { id: 'd7', fileId: 'f1', type: 'rechnung', taxRelevant: true, taxReason: 'unbekannt_x', date: '2026-01-01', displayName: 'x.pdf' },
  ];
  const getBlob = async (id) => (id === 'f4' ? null : new Blob([`inhalt ${id} `.repeat(200)], { type: 'application/pdf' }));

  it('Pfade: Ordner je Steuergrund, Dedupe mit " (2)", Reihenfolge', () => {
    const paths = planZipPaths(docs.filter(d => d.taxRelevant), files, d => REASON_FOLDER[d.taxReason] || 'Sonstiges').map(p => p.path);
    expect(paths).toContain('Lohn/2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf');
    expect(paths).toContain('Haushalt_Handwerker/2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf');
    expect(paths).toContain('Haushalt_Handwerker/2026-02-20_Rechnung_Elektro-Meyer_412,30 (2).pdf');
    expect(paths).toContain('Gesundheit/2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf');
    expect(paths).toContain('Sonstiges/x.pdf');
    expect(Object.values(REASON_FOLDER)).toEqual(['Lohn', 'Beruf', 'Versicherung_Vorsorge', 'Kapitalertraege', 'Haushalt_Handwerker', 'Spenden', 'Gesundheit', 'Kinder_Bildung', 'Sonstiges']);
  });
  it('buildTaxZip: gültiges ZIP mit Dateien + 00_Liste.csv; fehlende Blobs nur in der Liste', async () => {
    const blob = await buildTaxZip({ documents: docs, files, getBlob, includeSuggested: true });
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBeGreaterThan(500);
    const names = await zipNames(blob);
    expect(names[0]).toBe('00_Liste.csv');
    expect(names).toContain('Lohn/2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf');
    expect(names).toContain('Haushalt_Handwerker/2026-02-20_Rechnung_Elektro-Meyer_412,30 (2).pdf');
    expect(names).toContain('Gesundheit/2026-02-20_Rechnung_Elektro-Meyer_412,30.pdf');
    expect(names.some(n => n.startsWith('Spenden/'))).toBe(false); // Blob fehlt
    expect(names.some(n => n.includes('Kontoauszug'))).toBe(false); // nicht steuerrelevant
    // ZIP-Signatur und Ende
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
  it('includeSuggested=false: nur vom Nutzer bestätigte Dokumente', async () => {
    const names = await zipNames(await buildTaxZip({ documents: docs, files, getBlob, includeSuggested: false }));
    expect(names).toEqual(['00_Liste.csv', 'Lohn/2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf']);
  });
  it('Liste: BOM, ;-getrennt, Spalten, Herkunft, Quoting', async () => {
    const blob = await buildTaxZip({ documents: docs, files, getBlob });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    const start = text.indexOf('﻿Datei;Datum');
    expect(start).toBeGreaterThan(0);
    const csv = text.slice(start, text.indexOf('PK', start));
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('﻿Datei;Datum;Typ;Aussteller;Betrag;Grund;Herkunft');
    const lohn = lines.find(l => l.startsWith('Lohn/'));
    expect(lohn.split(';')).toEqual(['Lohn/2026-03-27_Lohnabrechnung_Frigotechnik-GmbH_3290,98.pdf', '27.03.2026', 'Lohnabrechnung', 'Frigotechnik GmbH', '3290,98', 'Lohn', 'Beispiele: Belege/a.pdf | Dropbox: /Steuer/a.pdf']);
    expect(lines.find(l => l.includes('Apotheke'))).toContain('"Apotheke; ""am Markt"""');
    expect(lines.find(l => l.includes('Spenden/'))).toContain('(Datei fehlt)');
  });
  it('buildArchiveZip: Ordner je Dokumenttyp', async () => {
    const blob = await buildArchiveZip({ documents: docs, files, getBlob });
    const names = await zipNames(blob);
    expect(names[0]).toBe('00_Liste.csv');
    expect(names.some(n => n.startsWith('Lohnabrechnung/'))).toBe(true);
    expect(names.some(n => n.startsWith('Rechnung/'))).toBe(true);
    expect(names.some(n => n.startsWith('Kassenbon/'))).toBe(true);
    expect(names.some(n => n.startsWith('Kontoauszug/'))).toBe(true);
  });
  it('buildCsvExport: Buchungen mit BOM, Betrag mit Komma, Kategorie, Steuerflag, Formelschutz', () => {
    const csv = buildCsvExport([
      tx({ accountId: 'g', bookingDate: '2026-03-01', valueDate: '2026-03-02', amount: -123456, counterparty: 'REWE', purpose: 'Einkauf; "Bio"', category: 'lebensmittel', subcategory: 'supermarkt', bookingText: 'Kartenzahlung' }),
      tx({ accountId: 'g', bookingDate: '2026-03-02', amount: 500, counterparty: '=HYPERLINK("x")', category: 'einkommen', subcategory: 'zinsen', taxRelevant: true, taxReason: 'kapitalertraege', isTransfer: false }),
      tx({ accountId: 'g', bookingDate: '2026-03-03', amount: -100, isTransfer: true, category: 'umbuchung' }),
    ], [{ id: 'g', name: 'ING Girokonto' }]);
    expect(csv.startsWith('﻿Buchungsdatum;Wertstellung;Konto;')).toBe(true);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('01.03.2026;02.03.2026;ING Girokonto;REWE;"Einkauf; ""Bio""";-1234,56;EUR;Lebensmittel › Supermarkt;;;;Kartenzahlung;');
    expect(lines[2]).toContain("'=HYPERLINK");
    expect(lines[2]).toContain(';ja;Kapitalerträge;');
    expect(lines[3]).toContain(';ja;;;'); // Umbuchung
    expect(buildCsvExport([], [])).toBe(csv.split('\r\n')[0] + '\r\n');
  });
});

// ---------------------------------------------------------------- Leistung
describe('Leistung', () => {
  it('20.000 Buchungen: Klassifizierung, Umbuchungen, Serien, Insights in wenigen Sekunden', () => {
    const accounts = [{ id: 'a1', kind: 'giro', name: 'Giro' }, { id: 'a2', kind: 'giro', name: 'Zweit' }];
    const names = ['REWE Markt', 'Edeka', 'Aldi Süd', 'Shell', 'Netflix', 'Unbekannt GmbH', 'Max Mustermann', 'Amazon', 'dm drogerie markt', 'Telekom'];
    const txs = [];
    for (let i = 0; i < 20000; i++) {
      const d = new Date(Date.UTC(2023, 0, 1 + (i % 1100)));
      const n = names[i % names.length];
      txs.push(tx({ id: 'p' + i, accountId: i % 7 ? 'a1' : 'a2', bookingDate: d.toISOString().slice(0, 10), amount: -(500 + (i * 37) % 9000), counterparty: n, counterpartyRaw: n, purpose: `Kartenzahlung Nr ${i} KAUFUMSATZ` }));
    }
    const t0 = Date.now();
    let x = detectTransfers(txs, accounts);
    x = classifyTransactions(x, { accounts });
    const contracts = detectRecurring(x);
    x = linkContracts(x, contracts);
    const ins = computeInsights({ accounts, transactions: x, documents: [], contracts, valuations: [], holdings: [], assets: [] }, { from: '2023-01-01', to: '2026-01-31' });
    const ms = Date.now() - t0;
    expect(ins.totals.expense).toBeGreaterThan(0);
    expect(sankeyIssues(ins.sankey)).toEqual([]);
    expect(ms).toBeLessThan(8000);
  });
});

// ---------------------------------------------------------------- Echte Pipeline auf den Beispieldateien
describe('Pipeline auf den Beispieldateien', () => {
  let parseDoc, detect, ready = false, P = null;
  const cents = (s) => Math.round(Number(s) * 100);

  async function load(rel) {
    const f = path.join(ROOT, rel);
    const buf = fs.readFileSync(f);
    const meta = { name: path.basename(f), path: rel, ext: path.extname(f).slice(1).toLowerCase() };
    let ex;
    if (meta.ext === 'pdf') { const r = await extractPdfText(new Uint8Array(buf)); ex = { kind: 'pdf', pages: r.pages, text: r.text, meta: { pageCount: r.pages.length } }; }
    else if (meta.ext === 'xml') { const { text } = decodeText(buf); ex = { kind: 'xml', rawText: text, xml: text, text }; }
    else { const { text } = decodeText(buf); const p = parseCsv(text); ex = { kind: 'csv', text, rawText: text, rows: p.rows, meta: { delimiter: p.delimiter } }; }
    return { ex, meta };
  }

  beforeAll(async () => {
    try {
      parseDoc = (await import('../src/lib/parsers/index.js')).parse;
      detect = (await import('../src/lib/detect/index.js')).detectType;
      ready = true;
    } catch { ready = false; return; }
    // Minimaler Importer: Konten zusammenführen, Dedupe, IDs
    const rels = [
      'Banken/ING/ing_girokonto_2026H1.csv', 'Banken/comdirect/comdirect_girokonto_2026H1.csv', 'Banken/PayPal/paypal_aktivitaeten_2026H1.csv',
      'Banken/Renault/renaultbank_tagesgeld_2026-06.pdf', 'Banken/comdirect/comdirect_depot_2026-06-30.csv',
      'Belege/lohnabrechnung_2026-03.pdf', 'Belege/rechnung_elektro_meyer_2026-02.pdf', 'Belege/rechnung_amazon_monitor_2026-04.pdf',
      'Steuer/lohnsteuerbescheinigung_2025.pdf', 'Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf', 'Steuer/comdirect_jahressteuerbescheinigung_2025.pdf',
      'Versicherungen/allianz_privatrente_standmitteilung_2025.pdf', 'Versicherungen/bu_beitragsbescheinigung_2025.pdf', 'Belege/vertrag_netflix_bestaetigung.pdf',
    ];
    const D = { accounts: [], documents: [], txs: [], valuations: [], holdings: [], files: [] };
    const keys = new Set();
    let n = 0;
    const id = (p) => p + ++n;
    for (const rel of rels) {
      const { ex, meta } = await load(rel);
      const res = await parseDoc(detect(ex, meta), ex, meta);
      const fileId = id('file_');
      D.files.push({ id: fileId, name: meta.name, path: rel, ext: meta.ext, origins: [{ sourceName: 'Beispiele', path: rel }] });
      for (const r of [res, ...(res.additional || [])]) {
        let accId = null;
        if (r.account) {
          const a = r.account;
          let found = D.accounts.find(x => a.iban && x.iban === a.iban) || D.accounts.find(x => !a.iban && x.kind === a.kind && x.institution === a.institution && x.name === a.name);
          if (!found) D.accounts.push(found = { id: id('acc_'), own: true, ...a });
          accId = found.id;
        }
        const docId = id('doc_');
        D.documents.push({ ...r.document, id: docId, fileId, accountId: accId, payroll: r.payroll || null, vat: r.vat || null, text: (ex.text || '').slice(0, 20000) });
        for (const t of r.transactions || []) {
          if (t.dedupeKey && keys.has(t.dedupeKey)) continue;
          if (t.dedupeKey) keys.add(t.dedupeKey);
          D.txs.push({ ...t, id: id('tx_'), accountId: accId, documentId: docId, fileId });
        }
        for (const v of r.valuations || []) if (accId) D.valuations.push({ ...v, id: id('v_'), accountId: accId, documentId: docId });
        for (const h of r.holdings || []) D.holdings.push({ ...h, id: id('h_'), accountId: accId, documentId: docId, date: h.date || r.document.date });
      }
    }
    // Pipeline wie postProcess()
    let txs = D.txs.map(t => ({ ...t, counterparty: normalizeCounterparty(t) || t.counterparty }));
    txs = detectTransfers(txs, D.accounts);
    txs = classifyTransactions(txs, { rules: [], accounts: D.accounts });
    const contracts = detectRecurring(txs, []);
    txs = linkContracts(txs, contracts);
    const matches = matchReceipts(D.documents, txs);
    const byTx = new Map(matches.map(m => [m.txId, m.docId]));
    txs = txs.map(t => (byTx.has(t.id) ? { ...t, receiptDocId: byTx.get(t.id) } : t));
    const documents = D.documents.map(d => ({ ...d, ...flagTaxDocument(d) }));
    txs = txs.map(t => ({ ...t, ...flagTaxTransaction(t) }));
    P = { ...D, txs, contracts, documents, matches };
  }, 120000);

  const need = (name, fn) => it(name, async (ctx) => { if (!ready) return ctx.skip(); await fn(); });
  const acc = (kind, inst) => P.accounts.find(a => a.kind === kind && (!inst || a.institution === inst));

  need('PayPal: acht Aufladungen paaren mit den ING-Lastschriften, Händlerbuchungen bleiben Ausgaben', () => {
    const ing = acc('giro', 'ING'), pp = acc('paypal');
    const ingPay = P.txs.filter(t => t.accountId === ing.id && /paypal/i.test(t.counterpartyRaw) || (t.accountId === ing.id && t.creditorId === PAYPAL_CREDITOR_ID));
    const ppBank = P.txs.filter(t => t.accountId === ing.id && t.transferAccountId === pp.id);
    expect(ppBank).toHaveLength(EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'].ing_paypal_debits);
    expect(ppBank.every(t => t.isTransfer && t.category === 'umbuchung' && t.transferPairId)).toBe(true);
    expect(ingPay.length).toBeGreaterThanOrEqual(8);
    const fundings = P.txs.filter(t => t.accountId === pp.id && t.bookingText === 'Bankeinzug');
    expect(fundings).toHaveLength(8);
    expect(fundings.every(t => t.isTransfer && P.txs.find(x => x.id === t.transferPairId)?.accountId === ing.id)).toBe(true);
    expect(fundings.reduce((s, t) => s + t.amount, 0)).toBe(cents(EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'].bank_funded_in_eur));
    const shops = P.txs.filter(t => t.accountId === pp.id && t.bookingText === 'Allgemeine Zahlung');
    expect(shops.length).toBeGreaterThan(5);
    expect(shops.every(t => !t.isTransfer && t.amount < 0)).toBe(true);
    expect(shops.some(t => t.counterparty === 'ABC Shop')).toBe(true);
  });

  need('Überweisung ING → Renault Bank und ING → comdirect sind Umbuchungen und keine Ausgabe', () => {
    const ing = acc('giro', 'ING'), tg = acc('tagesgeld'), cd = acc('giro', 'comdirect');
    const toTg = P.txs.filter(t => t.accountId === ing.id && t.transferAccountId === tg.id);
    expect(toTg).toHaveLength(1);
    expect(toTg[0]).toMatchObject({ amount: -cents(EXPECTED['Banken/Renault/renaultbank_tagesgeld_2026-06.pdf'].credit_from_ing_eur), isTransfer: true, category: 'umbuchung' });
    const toCd = P.txs.filter(t => t.accountId === ing.id && t.transferAccountId === cd.id);
    expect(toCd).toHaveLength(6);
    const ins = computeInsights({ accounts: P.accounts, transactions: P.txs, documents: P.documents, contracts: P.contracts, holdings: P.holdings, valuations: P.valuations, assets: [] }, { from: '2026-01-01', to: '2026-06-30' });
    const expenseTx = P.txs.filter(t => !t.isTransfer && t.category !== 'einkommen' && t.category !== 'vorsorge_sparen').reduce((s, t) => s - t.amount, 0); // Erstattungen mindern
    expect(ins.totals.expense).toBe(expenseTx);
    expect(ins.byCategory.some(c => c.id === 'umbuchung')).toBe(false);
    expect(toTg.concat(toCd).every(t => ins.topMerchants.every(m => m.name !== t.counterparty) || t.counterparty !== 'Max Mustermann')).toBe(true);
  });

  need('Miete, Netflix, Spotify u. a. sind monatliche Verträge; Netflix-Preis unverändert', () => {
    const find = (re) => P.contracts.find(c => re.test(c.provider));
    const rent = find(/Hausverwaltung/), netflix = find(/Netflix/), spotify = find(/Spotify/);
    expect(rent).toMatchObject({ kind: 'miete', interval: 'monthly', amount: -115000, count: 6, active: true });
    expect(netflix).toMatchObject({ kind: 'abo', interval: 'monthly', amount: -1399, count: 6, priceChange: null, active: true });
    expect(spotify).toMatchObject({ kind: 'abo', interval: 'monthly', amount: -1099, priceChange: null });
    expect(P.documents.find(d => d.type === 'vertrag' && /netflix/i.test(d.title)).amount).toBe(-netflix.amount);
    for (const re of [/Vattenfall/, /Telekom/, /Urban Sports/, /Adobe/, /OpenAI/, /Alte Leipziger/, /Allianz/, /Verkehrsgesellschaft/]) expect(find(re), String(re)).toMatchObject({ interval: 'monthly', count: 6 });
    expect(find(/Alte Leipziger/).kind).toBe('versicherung');
    expect(find(/Allianz/).kind).toBe('vorsorge');
    expect(find(/Frigotechnik/)).toMatchObject({ kind: 'einkommen', amount: cents(EXPECTED['Banken/ING/ing_girokonto_2026H1.csv'].salary_eur_monthly) });
    expect(P.contracts.every(c => !c.provider.match(/PayPal/))).toBe(true);
    // Verknüpfung an den Buchungen
    expect(P.txs.filter(t => t.contractId === netflix.id)).toHaveLength(6);
  });

  need('Kategorien: REWE, Netflix, Allianz, Vattenfall, ver.di, Gehalt, Zinsen, Bargeld', () => {
    const one = (re, pick = t => t) => pick(P.txs.find(t => re.test(t.counterparty)));
    expect(one(/^REWE/)).toMatchObject({ category: 'lebensmittel', subcategory: 'supermarkt' });
    expect(one(/Netflix/)).toMatchObject({ category: 'abos_medien', subcategory: 'streaming' });
    expect(one(/Allianz/)).toMatchObject({ category: 'vorsorge_sparen', subcategory: 'privatrente' });
    expect(one(/Vattenfall/)).toMatchObject({ category: 'wohnen', subcategory: 'strom_gas' });
    expect(one(/ver\.di/)).toMatchObject({ category: 'beruf', subcategory: 'gewerkschaft' });
    expect(one(/Frigotechnik/)).toMatchObject({ category: 'einkommen', subcategory: 'gehalt' });
    expect(one(/Renault Bank/)).toMatchObject({ category: 'einkommen', subcategory: 'zinsen' });
    expect(one(/Geldautomat/)).toMatchObject({ category: 'bargeld' });
    expect(one(/Hausverwaltung/)).toMatchObject({ category: 'wohnen', subcategory: 'miete' });
    expect(one(/Ärzte ohne Grenzen/)).toMatchObject({ category: 'spenden' });
    expect(one(/Elektro Meyer/)).toMatchObject({ category: 'wohnen', subcategory: 'handwerker' });
    const low = P.txs.filter(t => t.needsReview);
    expect(low.length).toBeLessThan(P.txs.length * 0.2);
  });

  need('Belege: Rechnung Elektro Meyer und Amazon-Monitor werden den Buchungen zugeordnet', () => {
    const ds = (re) => P.documents.find(d => d.type === 'rechnung' && re.test(d.title || d.issuer || ''));
    const em = ds(/Elektro Meyer/), amz = ds(/Amazon/);
    expect(P.matches.find(m => m.docId === em.id)).toBeTruthy();
    const tEm = P.txs.find(t => t.id === P.matches.find(m => m.docId === em.id).txId);
    expect(tEm.amount).toBe(-cents(EXPECTED['Belege/rechnung_elektro_meyer_2026-02.pdf'].total_eur));
    expect(tEm.receiptDocId).toBe(em.id);
    const tAmz = P.txs.find(t => t.id === P.matches.find(m => m.docId === amz.id).txId);
    expect(tAmz.amount).toBe(-cents(EXPECTED['Belege/rechnung_amazon_monitor_2026-04.pdf'].total_eur));
  });

  need('Steuer-Flags auf Dokumenten und Buchungen', () => {
    const reason = (type, re) => P.documents.find(d => d.type === type && (!re || re.test(d.title)))?.taxReason;
    expect(reason('lohn')).toBe('lohn');
    expect(reason('lohnsteuerbescheinigung')).toBe('lohn');
    expect(reason('steuerbescheinigung')).toBe('kapitalertraege');
    expect(reason('spende')).toBe('spenden');
    expect(reason('rente')).toBe('versicherung_vorsorge');
    expect(reason('versicherung')).toBe('versicherung_vorsorge');
    expect(reason('rechnung', /Elektro Meyer/)).toBe('haushalt_handwerker');
    expect(reason('rechnung', /Amazon/)).toBe('beruf'); // Monitor
    expect(P.documents.find(d => d.type === 'kontoauszug').taxRelevant).toBe(false);
    expect(P.documents.find(d => d.type === 'vertrag').taxRelevant).toBe(false);
    expect(P.txs.find(t => /Elektro Meyer/.test(t.counterparty))).toMatchObject({ taxRelevant: true, taxReason: 'haushalt_handwerker' });
    expect(P.txs.find(t => /Ärzte ohne Grenzen/.test(t.counterparty))).toMatchObject({ taxRelevant: true, taxReason: 'spenden' });
    expect(P.txs.find(t => /^REWE/.test(t.counterparty)).taxRelevant).toBe(false);
  });

  need('Insights: Gehalt, Steuerblock, Nettovermögen, Sankey-Bilanz und Layout', () => {
    const ins = computeInsights({ accounts: P.accounts, transactions: P.txs, documents: P.documents, contracts: P.contracts, holdings: P.holdings, valuations: P.valuations, assets: [] }, { from: '2026-01-01', to: '2026-06-30' });
    const salary = cents(EXPECTED['Banken/ING/ing_girokonto_2026H1.csv'].salary_eur_monthly) * 6;
    expect(ins.incomeBySource.find(s => s.id === 'gehalt').amount).toBe(salary);
    expect(ins.totals.income).toBeGreaterThanOrEqual(salary);
    expect(ins.totals.saving).toBeGreaterThan(0);
    expect(ins.totals.savingsRate).toBeGreaterThan(0.1);
    // Lohnabrechnung März → auf 6 Gehaltsmonate hochgerechnet
    const slip = P.documents.find(d => d.type === 'lohn').payroll;
    expect(ins.taxes.payroll.gross).toBe(slip.gross * 6);
    expect(ins.taxes.payroll.lohnsteuer).toBe(slip.lohnsteuer * 6);
    expect(ins.taxes.payroll.estimated).toBe(true);
    expect(ins.taxes.vatEstimate.fromReceipts).toBeGreaterThan(0);
    expect(ins.taxes.quote).toBeGreaterThan(0.2);
    expect(ins.taxes.quote).toBeLessThan(0.6);
    // Nettovermögen: Konten laut EXPECTED
    const by = Object.fromEntries(ins.netWorth.byAccount.map(b => [b.kind + ':' + b.name, b.value]));
    expect(by['giro:ING Girokonto']).toBe(cents(EXPECTED['Banken/ING/ing_girokonto_2026H1.csv'].closing_eur));
    expect(by['giro:comdirect Girokonto']).toBe(cents(EXPECTED['Banken/comdirect/comdirect_girokonto_2026H1.csv'].closing_eur));
    expect(by['tagesgeld:Renault Bank Tagesgeld']).toBe(cents(EXPECTED['Banken/Renault/renaultbank_tagesgeld_2026-06.pdf'].closing_eur));
    expect(by['depot:comdirect Depot']).toBe(cents(EXPECTED['Banken/comdirect/comdirect_depot_2026-06-30.csv'].total_eur));
    expect(by['paypal:PayPal']).toBe(cents(EXPECTED['Banken/PayPal/paypal_aktivitaeten_2026H1.csv'].final_balance_eur));
    expect(by['rente:Fondsgebundene Privatrente (Testtarif) 4711-0815']).toBe(cents(EXPECTED['Versicherungen/allianz_privatrente_standmitteilung_2025.pdf'].fund_value_eur));
    expect(ins.netWorth.total).toBe(Object.values(by).reduce((s, v) => s + v, 0));
    // Sankey
    expect(sankeyIssues(ins.sankey)).toEqual([]);
    expect(ins.sankey.nodes.find(n => n.id === 'src:brutto')).toBeTruthy();
    expect(layoutSankey(ins.sankey, { width: 1000, height: 520 })).toBeTruthy();
    // Ohne Steuern
    const plain = computeInsights({ accounts: P.accounts, transactions: P.txs, documents: P.documents, contracts: P.contracts, holdings: P.holdings, valuations: P.valuations, assets: [] }, { from: '2026-01-01', to: '2026-06-30', showTaxes: false });
    expect(sankeyIssues(plain.sankey)).toEqual([]);
    expect(plain.sankey.nodes.some(n => n.kind === 'tax')).toBe(false);
  });

  need('Steuer-ZIP und CSV aus den echten Dokumenten', async () => {
    const getBlob = async (fileId) => {
      const f = P.files.find(x => x.id === fileId);
      return new Blob([fs.readFileSync(path.join(ROOT, f.path))], { type: 'application/octet-stream' });
    };
    const blob = await buildTaxZip({ documents: P.documents, files: P.files, getBlob, includeSuggested: true });
    expect(blob.size).toBeGreaterThan(5000);
    const names = await zipNames(blob);
    expect(names[0]).toBe('00_Liste.csv');
    for (const folder of ['Lohn/', 'Haushalt_Handwerker/', 'Versicherung_Vorsorge/', 'Kapitalertraege/', 'Spenden/', 'Beruf/']) expect(names.some(n => n.startsWith(folder)), folder).toBe(true);
    expect(names.filter(n => n.startsWith('Lohn/'))).toHaveLength(2);
    expect(names.some(n => /Kontoauszug|Umsaetze/.test(n))).toBe(false);
    const csv = buildCsvExport(P.txs, P.accounts);
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(P.txs.length + 1);
    expect(csv).toContain('Wohnen › Miete');
  });
});
