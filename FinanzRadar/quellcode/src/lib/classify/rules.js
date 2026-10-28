// Kategorisierung von Buchungen.
// Reihenfolge: Nutzerregeln → Umbuchung → Einkommens-Stichworte → Händlerliste (0,9) → Stichwortregeln (≈0,7) → Vorzeichen-Standard.
// Nutzerentscheidungen (categorySource 'user') werden nie überschrieben.
import { fold, findMerchant } from './merchants.de.js';
import { getCategory, getSub } from './categories.js';
import { resolveCounterparty } from './normalize.js';
import { normalizeIban, uid } from '../util/format.js';

// ---------------------------------------------------------------- Stichwortregeln
// dir: 'in' nur Zuflüsse, 'out' nur Abflüsse, null beides. Text ist gefaltet (klein, ohne Umlaute).
const R = (re, category, sub, conf, dir = null) => ({ re, category, sub, conf, dir });

// Starke Einkommens-Stichworte: gelten vor der Händlerliste (z. B. Zinsgutschrift der Renault Bank)
const INCOME_FIRST = [
  R(/(?<![a-z])(?:gehalt|lohn|loehne|bezuege|besoldung|gehaltszahlung|lohnzahlung|arbeitsentgelt|verguetung)(?![a-z])/, 'einkommen', 'gehalt', 0.85, 'in'),
  R(/(?<![a-z])(?:erstattung|rueckerstattung|gutschrift)[a-z ]{0,30}(?:finanzamt|steuer)|finanzamt[a-z ]{0,30}erstattung|steuererstattung|einkommensteuererstattung/, 'einkommen', 'erstattung', 0.85, 'in'),
  R(/(?<![a-z])(?:dividende|dividenden|ausschuettung|ertragsgutschrift|fondsertrag|kuponzahlung|kupon)(?![a-z])/, 'einkommen', 'dividenden', 0.85, 'in'),
  R(/(?<![a-z])(?:zinsen|zinsgutschrift|habenzinsen|guthabenzinsen|zinsertrag|zinszahlung|zins)(?![a-z])/, 'einkommen', 'zinsen', 0.85, 'in'),
  R(/deutsche rentenversicherung|rentenzahlung|altersrente|erwerbsminderungsrente|versorgungsbezuege|rentenbezug|(?<![a-z])rente(?![a-z])/, 'einkommen', 'rente', 0.8, 'in'),
  R(/(?<![a-z])(?:kindergeld|elterngeld|kinderzuschlag|wohngeld|buergergeld|bafoeg|arbeitslosengeld|krankengeld)(?![a-z])/, 'einkommen', 'sonstiges', 0.8, 'in'),
];

const KEYWORDS = [
  // Bargeld
  R(/bargeldauszahlung|geldautomat|(?<![a-z])gaa(?![a-z])|bargeldabhebung|cash ?withdrawal|(?<![a-z])atm(?![a-z])|geldausgabeautomat|bargeldeinzahlung|einzahlung bar/, 'bargeld', 'auszahlung', 0.85),
  // Gebühren / Zinsen auf dem Konto
  R(/sollzinsen|debetzinsen|ueberziehungszinsen|dispozinsen|dispo zinsen|kreditzinsen|negativzins|verwahrentgelt/, 'finanzen', 'zinsen_kredit', 0.8),
  R(/kontofuehrung|kontoentgelt|kontogebuehr|girokonto entgelt|depotentgelt|depotgebuehr/, 'finanzen', 'kontofuehrung', 0.8),
  R(/jahresgebuehr|kartengebuehr|kreditkartengebuehr|bankgebuehr|auslandseinsatzentgelt|fremdwaehrungsentgelt|ruecklastschriftgebuehr|mahngebuehr|abschlussgebuehr|bearbeitungsgebuehr|provision|(?<![a-z])entgelt(?![a-z])|(?<![a-z])gebuehr(?:en)?(?![a-z])/, 'finanzen', 'gebuehren', 0.7, 'out'),
  // Kredit
  R(/kreditrate|darlehen|tilgung|annuitaet|finanzierungsrate|baufinanzierung|ratenkredit|autokredit|rate kredit/, 'finanzen', 'kredit', 0.75, 'out'),
  // Kreditkartenabrechnung ohne importierte Karte → muss geprüft werden
  R(/kreditkartenabrechnung|ausgleich kreditkarte|kk abrechnung|kartenabrechnung|abrechnung kreditkarte|visa abrechnung|mastercard abrechnung/, 'sonstiges', 'unbekannt', 0.5),
  // Sparen / Vorsorge
  R(/(?<![a-z])(?:bausparen|bausparvertrag|bausparkasse|bausparrate)(?![a-z])|bauspar/, 'vorsorge_sparen', 'bausparen', 0.8),
  R(/riester|ruerup|basisrente/, 'vorsorge_sparen', 'riester_ruerup', 0.8),
  R(/betriebsrente|direktversicherung|entgeltumwandlung|bav beitrag/, 'vorsorge_sparen', 'betriebsrente', 0.75),
  R(/privatrente|rentenversicherung|altersvorsorge|fondspolice|fondsgebundene|rentenpolice/, 'vorsorge_sparen', 'privatrente', 0.75),
  R(/wertpapierkauf|wertpapier kauf|wertpapierabrechnung|wertpapiersparplan|kauf wertpapier|sparplan|(?<![a-z])etf(?![a-z])|fondskauf|fondssparplan|depotuebertrag/, 'vorsorge_sparen', 'sparplan_depot', 0.75),
  R(/tagesgeld|festgeld|sparbuch|sparkonto|(?<![a-z])sparen(?![a-z])|ruecklage|anlagekonto/, 'vorsorge_sparen', 'tagesgeld', 0.65, 'out'),
  // Steuern & Abgaben
  R(/lohnsteuer(?!bescheinigung)/, 'steuern_abgaben', 'lohnsteuer', 0.8),
  R(/kirchensteuer/, 'steuern_abgaben', 'kirchensteuer', 0.8),
  R(/solidaritaetszuschlag|(?<![a-z])soli(?![a-z])/, 'steuern_abgaben', 'soli', 0.8),
  R(/kapitalertragsteuer|abgeltungsteuer|abgeltungssteuer/, 'steuern_abgaben', 'kapitalertragsteuer', 0.8),
  R(/kfz ?steuer|kraftfahrzeugsteuer/, 'steuern_abgaben', 'kfz_steuer', 0.8),
  R(/grundsteuer|muellgebuehr|abfallgebuehr|abwassergebuehr|strassenreinigung/, 'wohnen', 'nebenkosten', 0.75),
  R(/einkommensteuer|steuervorauszahlung|vorauszahlung steuer|umsatzsteuer|gewerbesteuer|nachzahlung steuer|steuernachzahlung|hundesteuer|finanzamt|steuernummer/, 'steuern_abgaben', 'einkommensteuer', 0.75),
  R(/(?<![a-z])(?:krankenkasse|krankenversicherung)[a-z ]{0,20}beitrag|beitrag[a-z ]{0,20}krankenkasse|pflegeversicherung|sozialversicherungsbeitrag/, 'steuern_abgaben', 'kv', 0.7),
  // Versicherung (Beitrag + Vertragsnummer)
  R(/versicherung|versicherungsbeitrag|versicherungsschein|(?<![a-z])police(?![a-z])|vers ?nr|versicherungsnr/, 'versicherungen', null, 0.7, 'out'),
  R(/(?:vertragsnr|vertrag nr|vertragsnummer)[a-z. :]*[0-9][0-9a-z-]*[a-z ]{0,25}beitrag|beitrag[a-z ]{0,25}(?:vertragsnr|vertrag nr|vertragsnummer)/, 'versicherungen', null, 0.65, 'out'),
  // Spenden
  R(/(?<![a-z])(?:spende|spenden|spendenquittung|zuwendung)(?![a-z])/, 'spenden', 'organisation', 0.75, 'out'),
  // Wohnen
  R(/rundfunk|beitragsservice/, 'wohnen', 'rundfunk', 0.85),
  R(/(?<![a-z])(?:miete|kaltmiete|warmmiete|mietzahlung|monatsmiete|wohnungsmiete|mietkaution|kaution)(?![a-z])/, 'wohnen', 'miete', 0.8),
  R(/nebenkosten|betriebskosten|hausgeld|heizkosten|nebenkostenabrechnung|wassergeld/, 'wohnen', 'nebenkosten', 0.75),
  R(/(?<![a-z])(?:strom|gas|erdgas|fernwaerme|energie)(?![a-z])/, 'wohnen', 'strom_gas', 0.7, 'out'),
  R(/(?<![a-z])(?:internet|dsl|mobilfunk|handyvertrag|festnetz|glasfaser|telefonrechnung)(?![a-z])/, 'wohnen', 'internet_telefon', 0.65, 'out'),
  R(/handwerker|reparatur|elektroinstallation|installation|sanitaer|klempner|maler|tischler|schreiner|dachdecker|reinigung|hausmeister|gartenpflege|renovierung|sanierung|montage/, 'wohnen', 'handwerker', 0.65, 'out'),
  // Kinder / Beruf
  R(/(?<![a-z])(?:kita|kindergarten|kinderkrippe|krippe|hort|schulgeld|tagesmutter|betreuungsgebuehr)(?![a-z])/, 'beruf', 'kinderbetreuung', 0.7),
  R(/gewerkschaft|berufsverband|mitgliedsbeitrag gewerkschaft/, 'beruf', 'gewerkschaft', 0.75),
  R(/fortbildung|seminar|weiterbildung|lehrgang|schulung|kursgebuehr/, 'beruf', 'fortbildung', 0.7),
  R(/fachbuch|arbeitsmittel|arbeitszimmer|berufskleidung|buerobedarf|buerostuhl|laptop|monitor|schreibtisch/, 'beruf', 'arbeitsmittel', 0.65, 'out'),
  // Mobilität
  R(/tankstelle|kraftstoff|diesel|super e10|benzin|tankquittung/, 'mobilitaet', 'tanken', 0.7, 'out'),
  R(/fahrkarte|monatskarte|jahreskarte|semesterticket|deutschlandticket|d ticket/, 'mobilitaet', 'oepnv', 0.75),
  R(/(?<![a-z])(?:parken|parkgebuehr|parkhaus|parkticket)(?![a-z])/, 'mobilitaet', 'auto', 0.7, 'out'),
  R(/werkstatt|hauptuntersuchung|inspektion|reifenwechsel|autowaesche|(?<![a-z])tuev(?![a-z])/, 'mobilitaet', 'auto', 0.65, 'out'),
  // Gesundheit
  R(/apotheke|medikament/, 'gesundheit', 'apotheke', 0.75),
  R(/zahnarzt|zahnreinigung|kieferorth/, 'gesundheit', 'zahnarzt', 0.75),
  R(/optiker|brille|kontaktlinsen/, 'gesundheit', 'brille', 0.75),
  R(/(?<![a-z])(?:arzt|aerztin|praxis|physiotherapie|heilpraktiker|klinik|krankenhaus|zuzahlung|eigenanteil|rezeptgebuehr)(?![a-z])/, 'gesundheit', 'arzt', 0.65, 'out'),
  // Essen & Trinken
  R(/restaurant|(?<![a-z])cafe(?![a-z])|bistro|pizzeria|gaststaette|imbiss|lieferdienst|biergarten/, 'lebensmittel', 'restaurant', 0.65, 'out'),
  R(/supermarkt|lebensmittel|wochenmarkt|baeckerei|metzgerei/, 'lebensmittel', 'supermarkt', 0.6, 'out'),
  // Freizeit / Reisen
  R(/urlaub|reisebuero|reisebuchung|(?<![a-z])flug(?![a-z])|ferienwohnung|(?<![a-z])hotel(?![a-z])/, 'freizeit_reisen', 'urlaub', 0.6, 'out'),
  R(/(?<![a-z])(?:kino|theater|konzert|eintritt|museum|veranstaltung)(?![a-z])/, 'freizeit_reisen', 'kultur', 0.6, 'out'),
  // Abos / Mitgliedschaften
  R(/(?<![a-z])(?:abo|abonnement|subscription|membership)(?![a-z])/, 'abos_medien', null, 0.55, 'out'),
  R(/mitgliedsbeitrag|mitgliedschaft/, 'freizeit_reisen', 'hobby', 0.55, 'out'),
  // Shopping
  R(/(?<![a-z])(?:bestellung|onlinekauf|online kauf|warenbestellung|retoure)(?![a-z])/, 'shopping', 'online', 0.55),
];

// ---------------------------------------------------------------- Verfeinerung der Unterkategorie
function refineInsurance(text, cpText) {
  const t = `${text} ${cpText}`;
  // Privatrente & Co. gehören zur Vorsorge, nicht zu den Versicherungen
  if (/riester|ruerup|basisrente/.test(text)) return { category: 'vorsorge_sparen', sub: 'riester_ruerup' };
  if (/privatrente|altersvorsorge|fondspolice|fondsgebundene|rentenversicherung|rentenpolice/.test(text)) return { category: 'vorsorge_sparen', sub: 'privatrente' };
  if (/betriebsrente|direktversicherung|entgeltumwandlung/.test(text)) return { category: 'vorsorge_sparen', sub: 'betriebsrente' };
  if (/haftpflicht/.test(t)) return { sub: 'haftpflicht' };
  if (/hausrat/.test(t)) return { sub: 'hausrat' };
  if (/berufsunfaehig|(?<![a-z])bu(?![a-z])/.test(t)) return { sub: 'bu' };
  if (/zusatz|krankenzusatz|zahnzusatz|krankenversicherung/.test(t)) return { sub: 'kranken_zusatz' };
  if (/kfz|(?<![a-z])auto(?![a-z])|vollkasko|teilkasko|fahrzeug/.test(t)) return { sub: 'kfz' };
  if (/rechtsschutz/.test(t)) return { sub: 'rechtsschutz' };
  if (/unfall/.test(t)) return { sub: 'unfall' };
  if (/risikoleben|lebensversicherung|kapitallebens|(?<![a-z])leben(?![a-z])/.test(t)) return { sub: 'leben' };
  return {};
}
function refineWohnen(text) {
  if (/nebenkosten|betriebskosten|hausgeld|abrechnung/.test(text)) return { sub: 'nebenkosten' };
  if (/(?<![a-z])miete|kaution/.test(text)) return { sub: 'miete' };
  return {};
}

// ---------------------------------------------------------------- Nutzerregeln
function ruleMatches(rule, tx, ctx) {
  const m = rule?.match;
  if (!m || m.value == null || m.value === '') return false;
  let hay;
  switch (m.field) {
    case 'counterparty': hay = `${tx.counterparty || ''} ${tx.counterpartyRaw || ''}`; break;
    case 'purpose': hay = tx.purpose || ''; break;
    case 'iban': hay = tx.counterpartyIban || ''; break;
    case 'creditorId': hay = tx.creditorId || ''; break;
    default: hay = `${tx.counterparty || ''} ${tx.counterpartyRaw || ''} ${tx.purpose || ''} ${tx.bookingText || ''} ${tx.counterpartyIban || ''} ${tx.creditorId || ''}`;
  }
  const op = m.op || 'contains';
  if (op === 'regex') {
    try { return ctx.regex(m.value).test(hay); } catch { return false; }
  }
  if (m.field === 'iban') {
    const a = normalizeIban(hay), b = normalizeIban(m.value);
    return op === 'equals' ? a === b : !!a && !!b && a.includes(b);
  }
  if (m.field === 'creditorId') {
    const a = String(hay).trim().toUpperCase(), b = String(m.value).trim().toUpperCase();
    return op === 'equals' ? a === b : a.includes(b);
  }
  const a = fold(hay), b = fold(m.value);
  if (!b) return false;
  if (op === 'equals') return fold(tx.counterparty) === b || fold(tx.counterpartyRaw) === b || a === b;
  return containsWord(a, b);
}

/**
 * „enthält“ mit Wortgrenze: der Suchtext muss an einem Wortanfang beginnen („ING“ trifft „ING-DiBa“,
 * aber nicht „Shopping“; „Rewe“ trifft „Rewe Markt“ und „Rewemarkt“). Beide Texte sind gefaltet (fold).
 */
export function containsWord(hayFold, needleFold) {
  if (!needleFold) return false;
  return (' ' + hayFold).includes(' ' + needleFold);
}

function makeCtx() {
  const rx = new Map();
  return { regex(src) { let r = rx.get(src); if (!r) { r = new RegExp(src, 'i'); rx.set(src, r); } return r; } };
}

// ---------------------------------------------------------------- Kern
function transferSub(tx, cp, purpose) {
  const t = `${cp} ${purpose}`;
  if (/paypal/.test(t)) return 'paypal';
  if (/kreditkarte|kartenabrechnung|kk abrechnung/.test(t)) return 'kreditkarte';
  return 'eigene_konten';
}

const hasCat = (c, s) => !!getCategory(c) && (!s || !!getSub(c, s));

// Wertpapierkauf / Sparplanausführung (Giro- oder Depotseite): Sparen, kein Konsum
const DEPOT_BUY = /wertpapierkauf|wertpapier ?kauf|kauf wertpapier|wertpapierabrechnung kauf|(?<![a-z])(?:etf|fonds|wertpapier)sparplan|(?<![a-z])sparplan(?:ausfuehrung| ausfuehrung)?(?![a-z])|sparplanausfuehrung|fondskauf|etf kauf|kauf etf|(?<![a-z])depotkauf/;
const DEPOT_NOT = /riester|ruerup|bauspar|basisrente/;
// PayPal-Währungsumrechnung: Gegenstück zur Fremdwährungszahlung, kein eigener Einkauf
const CONVERSION = /waehrungsumrechnung|currency conversion|general currency conversion/;

function decide(tx, ctx, userRules, cache) {
  // 1. Nutzerregeln
  for (const r of userRules) {
    if (ruleMatches(r, tx, ctx) && r.set?.category && hasCat(r.set.category, null)) {
      const out = { category: r.set.category, subcategory: r.set.subcategory || null, categorySource: 'rule', confidence: 1, ruleId: r.id };
      if (r.set.taxRelevant != null) { out.taxRelevant = !!r.set.taxRelevant; out.taxReason = r.set.taxRelevant ? (r.set.taxReason || 'sonstiges') : null; out.taxSource = 'rule'; }
      return out;
    }
  }
  const pos = tx.amount > 0;
  const cpName = tx.counterparty || '';
  const cpFold = fold(cpName);
  const rawFold = fold(tx.counterpartyRaw);
  const purposeFold = fold(tx.purpose);
  const btFold = fold(tx.bookingText);
  const text = `${purposeFold} ${btFold} ${cpFold}${rawFold && rawFold !== cpFold ? ' ' + rawFold : ''}`;

  // 2. Umbuchung – ein nur mittel sicheres, unbestätigtes Paar behält seine eigentliche Kategorie (Steuer/USt greifen weiter)
  if (tx.isTransfer && !(tx.transferConfidence === 'medium' && tx.transferSource !== 'user')) {
    return { category: 'umbuchung', subcategory: transferSub(tx, cpFold + ' ' + rawFold, purposeFold), categorySource: 'transfer', confidence: 1 };
  }

  // 2b. Währungsumrechnung (PayPal): Finanzen statt Händlerkategorie (sonst zählt der Einkauf doppelt als Konsum)
  if (CONVERSION.test(btFold) || (tx.bookingText === 'Währungsumrechnung')) {
    return { category: 'finanzen', subcategory: null, categorySource: 'keyword', confidence: 0.8 };
  }

  // 2c. Wertpapierkauf / Sparplan (Abfluss) – vor der Händlerliste, damit „comdirect“ & Co. nicht als Bankgebühr enden
  if (!pos && !DEPOT_NOT.test(text)) {
    const depotAcc = cache.depot.has(tx.accountId) && /(?<![a-z])kauf(?![a-z])|sparplan|ausfuehrung|wertpapier/.test(`${btFold} ${purposeFold}`);
    if (depotAcc || DEPOT_BUY.test(text)) return { category: 'vorsorge_sparen', subcategory: 'sparplan_depot', categorySource: 'keyword', confidence: 0.85 };
  }

  // 3a. Einkommens-Stichworte (Zufluss) und Gehaltsbuchung der Bank
  if (pos) {
    if (tx.bookingText === 'Gehalt/Lohn' || tx.gvc === '053') return { category: 'einkommen', subcategory: 'gehalt', categorySource: 'keyword', confidence: 0.95 };
    for (const k of INCOME_FIRST) if (k.re.test(`${purposeFold} ${btFold}`)) return { category: k.category, subcategory: k.sub, categorySource: 'keyword', confidence: k.conf };
  }

  // 3a'. Zufluss vom eigenen Konto (Gegenkonto nicht importiert): weder Einnahme noch Entnahme aus Sparen
  if (pos && tx.ownTransfer) return { category: 'umbuchung', subcategory: transferSub(tx, cpFold + ' ' + rawFold, purposeFold), categorySource: 'transfer', confidence: 0.7 };

  // 3b. Händlerliste (gefaltete Gegenpartei, dann Verwendungszweck)
  let weak = null;
  const mkey = cpFold + '|' + rawFold;
  let m = cache.cp.get(mkey);
  if (m === undefined) { m = findMerchant(cpFold, '') || (rawFold && rawFold !== cpFold ? findMerchant(rawFold, '') : null); cache.cp.set(mkey, m); }
  if (!m) m = findMerchant('', purposeFold);
  if (m && !m.intermediary) {
    if (m.conf < 0.6) weak = m;
    else {
      let category = m.category, sub = m.sub || null;
      if (m.refine === 'insurance') { const r = refineInsurance(`${purposeFold} ${btFold}`, `${cpFold} ${rawFold}`); if (r.category) { category = r.category; } sub = r.sub ?? sub; }
      else if (m.refine === 'wohnen') { const r = refineWohnen(`${purposeFold} ${btFold}`); sub = r.sub ?? sub; }
      // Steuerbehörde: Zufluss = Erstattung
      if (pos && category === 'steuern_abgaben') { category = 'einkommen'; sub = 'erstattung'; }
      // Rückfluss von Sparprodukten mit Zinsen/Ausschüttung
      if (pos && category === 'vorsorge_sparen' && /zins/.test(purposeFold)) { category = 'einkommen'; sub = 'zinsen'; }
      if (sub && !getSub(category, sub)) sub = null;
      const conf = !sub && category === 'versicherungen' ? Math.min(m.conf, 0.75) : m.conf;
      return { category, subcategory: sub, categorySource: 'merchant', confidence: conf, merchant: m.name };
    }
  }

  // 4. Stichwortregeln
  for (const k of KEYWORDS) {
    if (k.dir === 'in' && !pos) continue;
    if (!k.re.test(text)) continue;
    let category = k.category, sub = k.sub;
    if (category === 'versicherungen') {
      const r = refineInsurance(`${purposeFold} ${btFold}`, `${cpFold} ${rawFold}`);
      if (r.category) category = r.category;
      sub = r.sub ?? null;
    }
    if (pos && category === 'steuern_abgaben') { category = 'einkommen'; sub = 'erstattung'; }
    return { category, subcategory: sub, categorySource: 'keyword', confidence: k.conf };
  }

  // 4b. Schwache Händlertreffer (Banken u. Ä.)
  if (weak) return { category: weak.category, subcategory: weak.sub || null, categorySource: 'merchant', confidence: weak.conf, merchant: weak.name };

  // 4c. Überweisung an/von sich selbst ohne erkennbares Ziel (Gegenkonto nicht importiert): weder Ausgabe noch Einnahme
  if (tx.ownTransfer) return { category: 'umbuchung', subcategory: transferSub(tx, cpFold + ' ' + rawFold, purposeFold), categorySource: 'transfer', confidence: 0.7 };

  // 5. Standard nach Vorzeichen
  return pos
    ? { category: 'einkommen', subcategory: 'sonstiges', categorySource: 'keyword', confidence: 0.4, fallback: true }
    : { category: 'sonstiges', subcategory: 'unbekannt', categorySource: 'keyword', confidence: 0.3, fallback: true };
}

/**
 * Kategorisiert alle Buchungen. Rein funktional: gibt neue Objekte zurück.
 * @param {object[]} txs
 * @param {{ rules?: object[], accounts?: object[] }} opts
 */
export function classifyTransactions(txs, { rules = [], accounts = [] } = {}) {
  const ctx = makeCtx();
  const cache = { cp: new Map(), depot: new Set((accounts || []).filter(a => a?.kind === 'depot').map(a => a.id)) };
  const userRules = (rules || []).filter(r => r && r.enabled !== false && r.match && r.set);
  const out = txs.map(tx => {
    if (tx.categorySource === 'user') return tx;
    const d = decide(tx, ctx, userRules, cache);
    // KI-Vorschlag behalten, solange die Regeln nur raten
    if (tx.categorySource === 'ai' && tx.category && (d.confidence < 0.6 || d.fallback)) return tx;
    const { merchant, fallback, ruleId, ...rest } = d;
    const next = { ...tx, ...rest, needsReview: rest.confidence < 0.6 && !tx.reviewed };
    if (merchant) next.merchant = merchant;
    // Für „Warum?“: welche Nutzerregel gegriffen hat
    if (ruleId) next.ruleId = ruleId; else if (next.ruleId) delete next.ruleId;
    return next;
  });
  inferRefunds(out);
  return out;
}

const REFUND = /rueckerstattung|erstattung|refund|storno|retoure|rueckzahlung|gutschrift|ruecklastschrift|zahlungsrueckerstattung/;

/** Rückerstattungen ohne eigene Kategorie übernehmen die Kategorie früherer Ausgaben beim selben Empfänger */
function inferRefunds(out) {
  const byCp = new Map();
  for (const t of out) {
    if (t.amount >= 0 || t.isTransfer || !t.category) continue;
    const k = fold(t.counterparty);
    if (!k) continue;
    let m = byCp.get(k);
    if (!m) byCp.set(k, m = new Map());
    const ck = `${t.category}|${t.subcategory || ''}`;
    m.set(ck, (m.get(ck) || 0) + 1);
  }
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t.amount <= 0 || t.isTransfer || t.categorySource === 'user') continue;
    if (!(t.confidence <= 0.4 && t.category === 'einkommen' && t.subcategory === 'sonstiges')) continue;
    if (!REFUND.test(fold(`${t.purpose || ''} ${t.bookingText || ''}`))) continue;
    const m = byCp.get(fold(t.counterparty));
    if (!m) continue;
    const [category, sub] = [...m].sort((a, b) => b[1] - a[1])[0][0].split('|');
    out[i] = { ...t, category, subcategory: sub || null, categorySource: 'keyword', confidence: 0.6, needsReview: false };
  }
}
/**
 * Regelvorschlag aus einer manuellen Korrektur ("Immer so").
 * @param {object} tx Buchung (ggf. schon mit neuer Kategorie)
 * @param {string} newCategory "wohnen" oder "wohnen.miete"
 */
export function suggestRuleFromCorrection(tx, newCategory) {
  if (!tx || !newCategory) return null;
  const [cat, subIn] = String(newCategory).split('.');
  if (!getCategory(cat)) return null;
  const sub = subIn || (tx.category === cat ? tx.subcategory : null) || null;
  const name = resolveCounterparty(tx).name || tx.counterparty || tx.counterpartyRaw || '';
  let match;
  const iban = normalizeIban(tx.counterpartyIban);
  if (name && name.length >= 3 && fold(name).length >= 3) match = { field: 'counterparty', op: 'contains', value: name };
  else if (tx.creditorId) match = { field: 'creditorId', op: 'equals', value: tx.creditorId };
  else if (iban) match = { field: 'iban', op: 'equals', value: iban };
  else {
    const words = fold(tx.purpose).split(' ').filter(w => w.length > 3 && !/^\d/.test(w)).slice(0, 3);
    if (!words.length) return null;
    match = { field: 'purpose', op: 'contains', value: words.join(' ') };
  }
  return { id: uid('rule_'), match, set: { category: cat, subcategory: sub }, createdAt: new Date().toISOString() };
}

/** Buchungen, die eine Regel treffen würde (ohne Nutzerentscheidungen – die bleiben unangetastet) */
export function ruleHits(rule, txs) {
  if (!rule?.match) return [];
  const ctx = makeCtx();
  return (txs || []).filter(t => t && t.categorySource !== 'user' && ruleMatches(rule, t, ctx));
}

/** Greift schon eine aktive Nutzerregel für diese Buchung? */
export function matchingRule(tx, rules) {
  const ctx = makeCtx();
  return (rules || []).find(r => r && r.enabled !== false && r.match && r.set && ruleMatches(r, tx, ctx)) || null;
}

const cpKey = (t) => fold(t?.counterparty || t?.counterpartyRaw || '');

/**
 * Automatisches Lernen: korrigiert der Nutzer dieselbe Gegenpartei zum zweiten Mal auf dieselbe Kategorie,
 * entsteht daraus eine Regel. Gibt die neue Regel zurück (mit `auto: true`) oder null.
 * @param {object} tx korrigierte Buchung (Stand vor oder nach der Korrektur)
 * @param {string} category neue Kategorie
 * @param {string|null} subcategory neue Unterkategorie
 * @param {object[]} txs alle Buchungen (inkl. früherer Nutzerentscheidungen)
 * @param {object[]} rules vorhandene Regeln
 */
export function learnRuleFromCorrection(tx, category, subcategory, txs, rules) {
  if (!tx || !category || !getCategory(category) || category === 'umbuchung') return null;
  const key = cpKey(tx);
  if (key.length < 3) return null;
  const earlier = (txs || []).some(x => x && x.id !== tx.id && x.categorySource === 'user' && !x.isTransfer && x.category === category && cpKey(x) === key);
  if (!earlier) return null;
  // Gibt es schon eine Regel, die greift, bleibt es bei ihr (der Nutzer kann sie in den Einstellungen ändern)
  if (matchingRule(tx, rules)) return null;
  const rule = suggestRuleFromCorrection({ ...tx, category, subcategory: subcategory || null }, subcategory ? `${category}.${subcategory}` : category);
  if (!rule) return null;
  rule.auto = true;
  return rule;
}

export { INCOME_FIRST as _INCOME_FIRST, KEYWORDS as _KEYWORDS };
