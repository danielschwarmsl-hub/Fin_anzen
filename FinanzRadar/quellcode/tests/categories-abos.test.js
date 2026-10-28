// Miete/Wasser, Nutzerregeln mit Vorrang, Abo-Erkennung bekannter Anbieter, Händlerlisten (Reisen, Mobilität, Hamburg)
import { describe, it, expect } from 'vitest';
import { getSub } from '../src/lib/classify/categories.js';
import { MERCHANTS, findMerchant, fold } from '../src/lib/classify/merchants.de.js';
import { normalizeCounterparty } from '../src/lib/classify/normalize.js';
import { classifyTransactions } from '../src/lib/classify/rules.js';
import { detectRecurring } from '../src/lib/analyze/recurring.js';

let seq = 0;
const tx = (o = {}) => ({
  id: 'ca' + ++seq, accountId: 'a1', bookingDate: '2026-03-01', amount: -1000, currency: 'EUR',
  counterparty: '', counterpartyRaw: '', counterpartyIban: null, purpose: '', bookingText: null,
  mandateId: null, creditorId: null, category: null, subcategory: null, isTransfer: false, ...o,
});
/** wie im Import: Gegenpartei normalisieren, dann kategorisieren */
const prep = (list, rules = []) => classifyTransactions(list.map(t => ({ ...t, counterparty: normalizeCounterparty(t) })), { rules });
const C = (raw, purpose = '', amount = -1000, extra = {}) => prep([tx({ counterpartyRaw: raw, purpose, amount, ...extra })], extra.rules)[0];
const cat = (t) => `${t.category}/${t.subcategory}`;
const monthly = (n, o, start = '2026-01-05', jitter = []) => Array.from({ length: n }, (_, i) => {
  const d = new Date(start + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + i);
  d.setUTCDate(d.getUTCDate() + (jitter[i] || 0));
  return tx({ ...o, bookingDate: d.toISOString().slice(0, 10), amount: typeof o.amount === 'function' ? o.amount(i) : o.amount });
});

describe('Wasser', () => {
  it('neue Unterkategorie wohnen.wasser', () => {
    expect(getSub('wohnen', 'wasser')).toMatchObject({ label: 'Wasser' });
    expect(getSub('einkommen', 'mieteinnahmen')).toBeTruthy();
  });
  it('„wasser“ als Wortanfang im Text → Wohnen › Wasser, vor Händler- und Stichworttreffern', () => {
    expect(cat(C('Hamburg Wasser', 'Abschlag 03/2026', -4200))).toBe('wohnen/wasser');
    expect(cat(C('Stadtwerke Musterstadt', 'Wassergeld Abschlag', -3100))).toBe('wohnen/wasser');
    expect(cat(C('Zweckverband Nord', 'Abwasser Gebuehr 2026', -8800))).toBe('wohnen/wasser');
    expect(cat(C('Gemeinde Musterdorf', 'Trinkwasser Jahresabrechnung', -12000))).toBe('wohnen/wasser');
    expect(cat(C('Wasserversorgung Musterland GmbH', '', -2500))).toBe('wohnen/wasser');
    // Händler „Stadtwerke“ (Strom) verliert gegen „Wasser“ im Zweck
    expect(cat(C('Stadtwerke Kiel', 'Wasserwerk Abschlag', -2500))).toBe('wohnen/wasser');
  });
  it('Mineralwasser bei REWE/Getränkehändler bleibt Lebensmittel; Hochwasserhilfe bleibt Spende', () => {
    expect(cat(C('REWE Markt GmbH', 'Wasser still 6x1,5l', -499))).toBe('lebensmittel/supermarkt');
    expect(cat(C('Flaschenpost SE', 'Mineralwasser Kasten', -699))).toBe('lebensmittel/lieferdienst');
    expect(C('Lieschen Müller', 'Spende Hochwasserhilfe', -2000).category).toBe('spenden');
    expect(C('Media Markt', 'Wasserkocher', -3999).subcategory).not.toBe('wasser');
  });
});

describe('Miete', () => {
  it('Miete vor Barauszahlung und Händlern', () => {
    expect(cat(C('', 'Barauszahlung Geldautomat Miete Juni', -90000))).toBe('wohnen/miete');
    expect(cat(C('Max Vermieter', 'Miete Juni 2026', -90000))).toBe('wohnen/miete');
    expect(cat(C('Hansa Immobilien', 'Kaltmiete + NK 07/2026', -110000))).toBe('wohnen/miete');
    expect(cat(C('Peter Mustermann', 'Mietzahlung Wohnung 3 OG', -85000))).toBe('wohnen/miete');
  });
  it('Mietwagen, Mieterverein, Ferienwohnung sind keine Miete', () => {
    expect(C('Sixt GmbH', 'Mietwagen Rechnung 4711', -24000).subcategory).not.toBe('miete');
    expect(C('Mieterverein Hamburg', 'Mitgliedsbeitrag 2026', -9000).subcategory).not.toBe('miete');
    expect(C('Fewo Sonnenschein', 'Miete Ferienwohnung Juli', -60000).subcategory).not.toBe('miete');
  });
  it('Zufluss „Miete“/Vermietung → Mieteinnahmen', () => {
    expect(cat(C('Mieter Schulz', 'Miete Juni Whg 2', 75000))).toBe('einkommen/mieteinnahmen');
    expect(cat(C('Anna Mieterin', 'Vermietung Garage', 6000))).toBe('einkommen/mieteinnahmen');
  });
  it('Umbuchung aufs eigene Konto mit „Miete“ bleibt Umbuchung', () => {
    expect(C('Eigenes Konto', 'Miete', -90000, { isTransfer: true }).category).toBe('umbuchung');
  });
});

describe('Nutzerregeln', () => {
  const rule = (value, target, extra = {}) => {
    const [category, subcategory] = target.split('.');
    return { id: 'r_' + value, match: { field: 'text', op: 'contains', value }, set: { category, subcategory: subcategory || null }, ...extra };
  };
  it('„Text enthält“ schlägt Händler, Miete/Wasser, Bargeld und Umbuchung', () => {
    const rules = [rule('Projekt Alpha', 'beruf.arbeitsmittel')];
    expect(cat(C('REWE Markt', 'Projekt Alpha Material', -2000, { rules }))).toBe('beruf/arbeitsmittel');
    expect(cat(C('Hamburg Wasser', 'Projekt Alpha', -2000, { rules }))).toBe('beruf/arbeitsmittel');
    expect(cat(C('', 'Barauszahlung Miete Projekt Alpha', -2000, { rules }))).toBe('beruf/arbeitsmittel');
    // Buchungstext wird mit durchsucht
    expect(cat(C('Irgendwer', '', -2000, { rules, bookingText: 'Projekt Alpha Lastschrift' }))).toBe('beruf/arbeitsmittel');
    const t = C('Netflix', 'Projekt Alpha', -1399, { rules });
    expect(t).toMatchObject({ categorySource: 'rule', confidence: 1, ruleId: 'r_Projekt Alpha' });
  });
  it('selbst angelegte Regeln vor automatisch gelernten; Nutzerentscheidung bleibt', () => {
    const rules = [rule('Alpha', 'shopping.online', { auto: true }), rule('Alpha', 'beruf.fortbildung')];
    expect(cat(C('Alpha GmbH', '', -100, { rules }))).toBe('beruf/fortbildung');
    const manual = prep([tx({ counterpartyRaw: 'Alpha GmbH', category: 'sonstiges', subcategory: 'privat', categorySource: 'user' })], rules)[0];
    expect(cat(manual)).toBe('sonstiges/privat');
  });
});

describe('Abos bekannter Anbieter', () => {
  it('Audible per Debitkarte (Händler nur im Zweck, wechselnde Referenz) → ein Abo', () => {
    const t = prep([
      tx({ counterpartyRaw: 'VISA Debitkartenumsatz', purpose: 'AUDIBLE GMBH 4S7XK1 BERLIN', bookingText: 'Kartenzahlung', amount: -995, bookingDate: '2026-01-16' }),
      tx({ counterpartyRaw: 'VISA Debitkartenumsatz', purpose: 'AUDIBLE GMBH 9QQ2ZZ BERLIN', bookingText: 'Kartenzahlung', amount: -995, bookingDate: '2026-02-19' }),
      tx({ counterpartyRaw: 'VISA Debitkartenumsatz', purpose: 'REWE MARKT HAMBURG', bookingText: 'Kartenzahlung', amount: -2345, bookingDate: '2026-02-20' }),
      tx({ counterpartyRaw: 'AUDIBLE GMBH 1ABCD9', purpose: 'VISA Debitkartenumsatz', bookingText: 'Kartenzahlung', amount: -995, bookingDate: '2026-03-14' }),
    ]);
    expect(t.filter(x => x.subcategory === 'hoerbuch')).toHaveLength(3);
    const abos = detectRecurring(t);
    expect(abos).toHaveLength(1);
    expect(abos[0]).toMatchObject({ provider: 'Audible', kind: 'abo', interval: 'monthly', count: 3, amount: -995 });
  });
  it('Audible über Amazon und PayPal', () => {
    const viaAmazon = prep([
      tx({ counterpartyRaw: 'AMAZON PAYMENTS EUROPE S.C.A.', purpose: 'Audible Abo 302-111', amount: -995, bookingDate: '2026-01-16' }),
      tx({ counterpartyRaw: 'AMAZON PAYMENTS EUROPE S.C.A.', purpose: 'Audible Abo 302-222', amount: -995, bookingDate: '2026-02-16' }),
      tx({ counterpartyRaw: 'AMAZON PAYMENTS EUROPE S.C.A.', purpose: 'Bestellung 302-333', amount: -2399, bookingDate: '2026-02-20' }),
    ]);
    expect(viaAmazon.map(cat)).toEqual(['abos_medien/hoerbuch', 'abos_medien/hoerbuch', 'shopping/online']);
    expect(detectRecurring(viaAmazon).map(c => c.provider)).toEqual(['Audible']);
    const viaPaypal = prep([1, 2].map(i => tx({ counterpartyRaw: 'PayPal Europe S.a.r.l. et Cie S.C.A', purpose: `10${i} PP.10${i}.PP . Audible GmbH, Ihr Einkauf bei Audible GmbH`, amount: -995, bookingDate: `2026-0${i}-16` })));
    expect(detectRecurring(viaPaypal)[0]).toMatchObject({ provider: 'Audible', kind: 'abo' });
  });
  it('einzelne Netflix-Zahlung → Vertrag mit fromKnownProvider', () => {
    const [c] = detectRecurring(prep([tx({ counterpartyRaw: 'NETFLIX.COM', purpose: 'Netflix Standard', amount: -1399, bookingDate: '2026-03-02' })]));
    expect(c).toMatchObject({ kind: 'abo', interval: 'monthly', count: 1, amount: -1399, fromKnownProvider: true, nextDate: '2026-04-02' });
  });
  it('einzelner Steam-Kauf oder Spende ist kein Abo; unbekannter Händler braucht mehrere Zahlungen', () => {
    expect(detectRecurring(prep([tx({ counterpartyRaw: 'Steam Purchase', amount: -1999 })]))).toHaveLength(0);
    expect(detectRecurring(prep([tx({ counterpartyRaw: 'Greenpeace e.V.', amount: -5000 })]))).toHaveLength(0);
    expect(detectRecurring(prep([tx({ counterpartyRaw: 'Hans Meier', amount: -5000 })]))).toHaveLength(0);
  });
  it('Preiserhöhung (+18 %) und schwankendes Datum (±5 Tage) bleiben dasselbe Abo', () => {
    const t = prep(monthly(5, { counterpartyRaw: 'Spotify AB', purpose: 'Spotify Premium', amount: (i) => (i < 3 ? -1099 : -1299) }, '2026-01-05', [0, 4, -3, 5, -4]));
    const abos = detectRecurring(t);
    expect(abos).toHaveLength(1);
    expect(abos[0]).toMatchObject({ interval: 'monthly', amount: -1299, count: 5, priceChange: { from: -1099, to: -1299 } });
  });
  it('Preiserhöhung um 30 % bei nur zwei Zahlungen', () => {
    const t = prep([tx({ counterpartyRaw: 'Disney Plus', amount: -1000, bookingDate: '2026-01-10' }), tx({ counterpartyRaw: 'Disney Plus', amount: -1300, bookingDate: '2026-02-12' })]);
    expect(detectRecurring(t)).toHaveLength(1);
  });
  it('Deutschlandticket über DB Vertrieb → ÖPNV-Abo', () => {
    const t = prep(monthly(3, { counterpartyRaw: 'DB Vertrieb GmbH', purpose: 'Fahrkarte 12345', amount: -5800 }));
    expect(t.map(cat)).toEqual(Array(3).fill('mobilitaet/oepnv'));
    expect(detectRecurring(t)[0]).toMatchObject({ kind: 'abo', interval: 'monthly' });
    expect(cat(C('DB Vertrieb GmbH', 'ICE Hamburg-Berlin', -8990))).toBe('mobilitaet/bahn_fernverkehr');
  });
});

describe('Händlerlisten', () => {
  const M = (s) => findMerchant(fold(s), '');
  it('keine leeren Einträge', () => {
    expect(MERCHANTS.every(m => m.name && m.src)).toBe(true);
    expect(MERCHANTS.filter(m => m.re.test('') || m.re.test(' '))).toHaveLength(0);
  });
  it('Reisen: Flüge, Unterkunft, Kreuzfahrt, Reiseziele', () => {
    expect(cat(C('RYANAIR DAC', 'Buchung ABC123', -8999))).toBe('freizeit_reisen/fluege');
    expect(cat(C('airBaltic', 'Flight RIX', -15000))).toBe('freizeit_reisen/fluege');
    expect(cat(C('Airbnb Payments', 'Reservierung', -42000))).toBe('freizeit_reisen/hotel');
    expect(cat(C('MSC Cruises', '', -120000))).toBe('freizeit_reisen/kreuzfahrt');
    expect(cat(C('VISA Debitkartenumsatz', 'TIENDA LOPEZ TENERIFE ES', -1850, { bookingText: 'Kartenzahlung' }))).toBe('freizeit_reisen/urlaub');
    expect(cat(C('REWE Markt', 'PALMA DE MALLORCA ES', -1850, { bookingText: 'Kartenzahlung' }))).toBe('lebensmittel/supermarkt');
    expect(C('Restaurant Mykonos Hamburg', '', -4500).subcategory).toBe('restaurant');
    expect(cat(C('ERGO Reiseversicherung AG', 'Jahresbeitrag', -3900))).toBe('freizeit_reisen/urlaub');
  });
  it('Reise-Stichworte: Wortanfang, Urlaubsgeld bleibt Einkommen, „Preise“ ist keine Reise', () => {
    expect(cat(C('Arbeitgeber GmbH', 'Urlaubsgeld 2026', 120000))).toBe('einkommen/gehalt');
    expect(C('Max Muster', 'Preise Juni', -2000).category).not.toBe('freizeit_reisen');
    expect(cat(C('Max Muster', 'Flugticket Lissabon', -20000))).toBe('freizeit_reisen/fluege');
    expect(cat(C('Bezirksamt Nord', 'Reisepass Gebuehr', -7000))).toBe('sonstiges/behoerden');
  });
  it('Mobilität & Supermärkte', () => {
    expect(cat(C('MILES MOBILITY GMBH', '', -1290))).toBe('mobilitaet/taxi_sharing');
    expect(M('Miles & More')).toBeNull();
    expect(cat(C('ARAL STATION 123', '', -6500))).toBe('mobilitaet/tanken');
    expect(cat(C('EDEKA Tankstelle Meier', '', -6500))).toBe('mobilitaet/tanken');
    expect(cat(C('Shell Recharge', '', -1500))).toBe('mobilitaet/e_laden');
    expect(cat(C('EnBW mobility+', '', -1500))).toBe('mobilitaet/e_laden');
    expect(C('Arbeitgeber GmbH', 'NETTO-Gehalt 06/2026', 250000).category).toBe('einkommen');
    expect(cat(C('Linden Apotheke', '', -1290))).toBe('gesundheit/apotheke');
    expect(cat(C('Rossmann 1234', '', -790))).toBe('lebensmittel/drogerie');
    expect(M('Douglas Müller')).toBeNull();
  });
  it('Kartenzahlung: Händler, die sonst nur als Gegenpartei gelten, auch im Zweck (Wolt, Flink)', () => {
    expect(cat(C('VISA Debitkartenumsatz', 'WOLT BERLIN', -2350, { bookingText: 'Kartenzahlung' }))).toBe('lebensmittel/lieferdienst');
    expect(cat(C('VISA Debitkartenumsatz', 'FLINK SE', -1890, { bookingText: 'Kartenzahlung' }))).toBe('lebensmittel/lieferdienst');
    expect(C('Max Muster', 'flink erledigt danke', -1000).subcategory).not.toBe('lieferdienst');
  });
  it('Nachträge: WOW, chess.com, Liquid, Hamburg', () => {
    expect(M('WOWTV')).toMatchObject({ category: 'abos_medien', sub: 'streaming', recurringHint: 'monthly' });
    expect(M('Chess.com')).toMatchObject({ category: 'abos_medien', recurringHint: 'monthly' });
    expect(M('Lichess.org')).toMatchObject({ category: 'spenden' });
    expect(M('Dampfdorado')).toMatchObject({ category: 'lebensmittel', sub: 'kiosk' });
    expect(M('Liquidität Reserve')).toBeNull();
    expect(M('GitHub, Inc.')).toMatchObject({ recurringHint: 'monthly' });
    expect(M('Bäderland Hamburg')).toMatchObject({ category: 'freizeit_reisen', sub: 'sport' });
    expect(M('Lotto Hamburg')).toMatchObject({ category: 'freizeit_reisen' });
    expect(M('Too Good To Go')).toMatchObject({ category: 'lebensmittel' });
    expect(M('Jim Block')).toMatchObject({ sub: 'restaurant' });
    expect(M('Lidl Connect')).toMatchObject({ sub: 'internet_telefon' });
    expect(M('Tutanota GmbH')).toMatchObject({ category: 'abos_medien' });
    expect(M('Steam Purchase').recurringHint).toBeNull();
    expect(M('SQ *Kaffeebar')).toMatchObject({ intermediary: true });
  });
});

describe('Gegenpartei bei Debitkarten-Umsätzen', async () => {
  const { normalizeCounterparty } = await import('../src/lib/classify/normalize.js');
  it('„VISA Debitkartenumsatz“ wird nicht zu „VISA artenumsatz“, der Händler bleibt', () => {
    expect(normalizeCounterparty({ counterpartyRaw: 'VISA Debitkartenumsatz vom 27.12.2025 WOLT HAMBURG', purpose: '' })).toBe('Wolt Hamburg');
    expect(normalizeCounterparty({ counterpartyRaw: 'REWE Markt GmbH Debitk. 12', purpose: '' })).toBe('REWE Markt');
  });
});
