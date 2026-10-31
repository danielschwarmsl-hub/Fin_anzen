// Kategorisierung von Buchungen.
// Reihenfolge: Nutzerregeln → Umbuchung → Miete/Wasser → Einkommens-Stichworte → Händlerliste (0,9) → Stichwortregeln (≈0,7) → Vorzeichen-Standard.
// Nutzerentscheidungen (categorySource 'user') werden nie überschrieben.
import { fold, findMerchant, findSubscription } from './merchants.de.js';
import { getCategory, getSub } from './categories.js';
import { resolveCounterparty, isGenericCounterparty } from './normalize.js';
import { normalizeIban, uid } from '../util/format.js';

// ---------------------------------------------------------------- Stichwortregeln
// dir: 'in' nur Zuflüsse, 'out' nur Abflüsse, null beides. Text ist gefaltet (klein, ohne Umlaute).
const R = (re, category, sub, conf, dir = null) => ({ re, category, sub, conf, dir });

// Starke Einkommens-Stichworte: gelten vor der Händlerliste (z. B. Zinsgutschrift der Renault Bank)
const INCOME_FIRST = [
  R(/(?<![a-z])(?:gehalt|lohn|loehne|bezuege|besoldung|gehaltszahlung|lohnzahlung|arbeitsentgelt|verguetung|urlaubsgeld|urlaubsentgelt|weihnachtsgeld)(?![a-z])/, 'einkommen', 'gehalt', 0.85, 'in'),
  R(/(?<![a-z])(?:erstattung|rueckerstattung|gutschrift)[a-z ]{0,30}(?:finanzamt|steuer)|finanzamt[a-z ]{0,30}erstattung|steuererstattung|einkommensteuererstattung/, 'einkommen', 'erstattung', 0.85, 'in'),
  // Dividende, Ausschüttung, Erträgnis-/Ertragsgutschrift, Kupon (comdirect: „ERTRAEGNISGUTSCHRIFT“, „Kupon“)
  R(/(?<![a-z])(?:dividende[a-z]*|ausschuettung[a-z]*|ertr(?:ag|aeg)(?:nis|s)?gutschrift|ertraegnis[a-z]*|fondsertrag|kupon[a-z]*)(?![a-z])/, 'einkommen', 'dividenden', 0.85, 'in'),
  R(/(?<![a-z])(?:zinsen|zinsgutschrift|habenzinsen|guthabenzinsen|zinsertrag|zinszahlung|zins)(?![a-z])/, 'einkommen', 'zinsen', 0.85, 'in'),
  R(/deutsche rentenversicherung|rentenzahlung|altersrente|erwerbsminderungsrente|versorgungsbezuege|rentenbezug|(?<![a-z])rente(?![a-z])/, 'einkommen', 'rente', 0.8, 'in'),
  R(/(?<![a-z])(?:kindergeld|elterngeld|kinderzuschlag|wohngeld|buergergeld|bafoeg|arbeitslosengeld|krankengeld)(?![a-z])/, 'einkommen', 'sonstiges', 0.8, 'in'),
];

const KEYWORDS = [
  // Reisepass/Visum: Behörde (vor Gebühren und dem allgemeinen „Reise“)
  R(/(?<![a-z])(?:reisepass[a-z]*|visum|visumantrag|einreise(?:gebuehr)?|evisa|e visa)(?![a-z])/, 'sonstiges', 'behoerden', 0.7, 'out'),
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
  // Gerichts-/Justizkasse, Bußgeld: Behörde
  R(/gerichtskasse|justizkasse|gerichtskosten|(?<![a-z])(?:bussgeld[a-z]*|verwarnungsgeld)(?![a-z])/, 'sonstiges', 'behoerden', 0.75, 'out'),
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
  // „visa“ allein nie (Kreditkarte), „pension“/„lounge“ allein nie (Reisepass/Visum steht oben)
  R(/(?<![a-z])(?:mietwagen|mietauto|autovermietung|mietfahrzeug|car rental|rent a car)/, 'mobilitaet', 'taxi_sharing', 0.7, 'out'),
  R(/(?<![a-z])(?:faehre|faehrticket|faehrverbindung|faehrfahrt|ferry)(?![a-z])/, 'mobilitaet', 'bahn_fernverkehr', 0.65, 'out'),
  R(/(?<![a-z])(?:flug(?!hafen)[a-z]*|fluege|boarding|bordkarte|gepaeck[a-z]*|zusatzgepaeck|sperrgepaeck)(?![a-z])/, 'freizeit_reisen', 'fluege', 0.6, 'out'),
  R(/(?<![a-z])(?:kreuzfahrt[a-z]*|flusskreuzfahrt|cruise)(?![a-z])/, 'freizeit_reisen', 'kreuzfahrt', 0.6, 'out'),
  R(/(?<![a-z])(?:hotel[a-z]*|ferienwohnung[a-z]*|ferienhaus[a-z]*|ferienpark|unterkunft|uebernachtung(?:en)?|hostels?|jugendherberge|herberge|gaestehaus|halbpension|vollpension|kurtaxe|city ?tax|tourist tax|touristensteuer|bettensteuer|uebernachtungssteuer|kurabgabe|kurbeitrag)(?![a-z])/, 'freizeit_reisen', 'hotel', 0.6, 'out'),
  R(/(?<![a-z])(?:urlaub(?!sgeld|sentgelt|skasse)[a-z]*|reise(?!kosten|pass)[a-z]*|staedtereise|strandurlaub|badeurlaub|wellnessurlaub|all inclusive|pauschalreise|last minute|flughafen[a-z]*|airport|aeroport|airport lounge|duty ?free|reiseversicherung|auslandskranken[a-z]*)(?![a-z])/, 'freizeit_reisen', 'urlaub', 0.6, 'out'),
  R(/(?<![a-z])(?:kino|theater|konzert|eintritt|museum|veranstaltung)(?![a-z])/, 'freizeit_reisen', 'kultur', 0.6, 'out'),
  // Abos / Mitgliedschaften
  R(/(?<![a-z])(?:abo|abonnement|subscription|membership)(?![a-z])/, 'abos_medien', null, 0.55, 'out'),
  R(/mitgliedsbeitrag|mitgliedschaft/, 'freizeit_reisen', 'hobby', 0.55, 'out'),
  // Shopping
  R(/(?<![a-z])(?:bestellung|onlinekauf|online kauf|warenbestellung|retoure)(?![a-z])/, 'shopping', 'online', 0.55),
];

// Urlaubsziele (nur eindeutige; Städte wie Paris/London/Porto zu mehrdeutig). Schwaches Signal, nur bei Kartenumsatz im Ausland
// (Länderkürzel/Fremdwährung) – sonst wäre jedes „Restaurant Mykonos“ in Hamburg Urlaub. Händlertreffer haben Vorrang.
const DESTINATION = /(?<![a-z])(?:teneriffa|tenerife|gran canaria|lanzarote|fuerteventura|mallorca|majorca|ibiza|eivissa|menorca|minorca|costa del sol|costa brava|costa blanca|algarve|madeira|kreta|crete|heraklion|iraklio|chania|rhodos|rhodes|rodos|korfu|corfu|kerkyra|santorini?|thira|mykonos|zakynthos|zante|kos island|insel kos|chalkidiki|halkidiki|antalya|alanya|belek|bodrum|marmaris|kusadasi|hurghada|hurgada|sharm el sh[a-z]*|marsa alam|marrakesc?h|marrakech|agadir|djerba|jerba|hammamet|kapverden|kap verden|sal island|boa vista|bangkok|krung thep|phuket|krabi|pattaya|ko(?:h)? samui|chiang ?mai|bali|denpasar|dubai|malediven|maldives|sri lanka|tokio|tokyo|hanoi|ho chi minh|las vegas|punta cana|dominikanische republik|dominican republic|varadero|cancun|playa del carmen|venedig|venice|venezia|sizilien|sicily|sicilia|sardinien|sardinia|sardegna|amalfi|positano|gardasee|lake garda|dubrovnik|zypern|cyprus|paphos|limassol|larnaka|malta)(?![a-z])/;
const ABROAD = /(?<![a-z])(?:es|pt|gr|it|hr|cy|mt|tr|eg|ma|tn|cv|th|id|ae|mv|lk|jp|vn|us|usa|do|cu|mx|esp|prt|grc|ita|hrv|cyp|mlt|tur|egy|mar|tha|idn|are|jpn|usd|thb|try|aed|egp|mad|jpy|vnd|idr|kurs|wechselkurs|fremdwaehrung[a-z]*|waehrungsumrechnung)(?![a-z])/;
// Reiseziel + Reise-Stichwort im Text („Teneriffa April 2024 Wohnung booking“): eindeutig Reise – auch ohne Auslandshinweis
const TRIP_STAY = /(?<![a-z])(?:booking|airbnb|fewo|ferienwohnung|ferienhaus|ferienapartment|apartment|appartement|wohnung|unterkunft|hotel|hostel|finca|villa|resort|pension)(?![a-z])/;
const TRIP_FLIGHT = /(?<![a-z])(?:flug|fluege|flight|flugticket|boarding)(?![a-z])/;
const TRIP_ANY = /(?<![a-z])(?:urlaub|reise|reisen|trip|mietwagen|transfer|ausflug|tour)(?![a-z])/;
const CARD = /kartenzahlung|kartenumsatz|debitkartenumsatz|kreditkartenumsatz|girocard|(?<![a-z])(?:visa|mastercard|maestro)(?![a-z])|apple pay|google pay|kaufumsatz/;

// ---------------------------------------------------------------- Miete & Wasser (vor Händlerliste, Bargeld und Stichworten)
// „Miete“ als eigenes Wort bzw. Wortanfang fester Formen – nicht Mietwagen, Mieterverein, Vermietung (Ausgabe), Mietkaution
const MIETE = /(?<![a-z])(?:kalt|warm|monats|wohnungs|netto|brutto|garagen|stellplatz)?(?:miete|mietzahlung|mietzins|mieteinnahmen?)(?![a-z])/;
const VERMIETUNG = /(?<![a-z])vermietung(?![a-z])/;
// „Wasser“ als Wortanfang (Wasserwerk, Wasserversorgung, Wassergeld …) sowie Abwasser/Trinkwasser & Co.; kein Mineralwasser, Wasserkocher …
const WASSER = /(?<![a-z])(?<!mineral )(?:ab|trink|schmutz|niederschlags|regen|frisch|kalt|warm)?wasser(?!kocher|filter|sport|pistole|flasche|bett|ski|ball|farbe|spiel|strasse|str(?![a-z])|weg|gasse|turm|burg|kante|tank|pfeife|uhr|dicht|fest)[a-z]*/;
// Gegenpartei mit Wasser auf dem Kassenbon (Supermarkt, Drogerie, Getränke, Tankstelle, Apotheke …)
const WATER_SELLER = new Set(['lebensmittel', 'shopping', 'freizeit_reisen', 'gesundheit', 'mobilitaet']);
// „Miete“ bei Mietwagen, Ferienwohnung & Co. ist keine Wohnungsmiete
const RENT_NOT = new Set(['mobilitaet', 'freizeit_reisen']);
const RENT_NOT_TEXT = /ferienwohnung|ferienhaus|(?<![a-z])fewo|mietwagen|autovermietung|(?<![a-z])hotel|urlaub/;

/** Händler im Verwendungszweck – bei Kartenzahlungen auch Einträge, die sonst nur für die Gegenpartei gelten */
function purposeMerchant(purposeFold, card) {
  return card ? findMerchant(purposeFold, '') : findMerchant('', purposeFold);
}

function wohnenFirst(tx, { pos, text, cpMerchant }) {
  if (MIETE.test(text) || (pos && VERMIETUNG.test(text))) {
    if (!(cpMerchant && RENT_NOT.has(cpMerchant.category)) && !RENT_NOT_TEXT.test(text)) {
      return pos
        ? { category: 'einkommen', subcategory: 'mieteinnahmen', categorySource: 'keyword', confidence: 0.85 }
        : { category: 'wohnen', subcategory: 'miete', categorySource: 'keyword', confidence: 0.9 };
    }
  }
  if (WASSER.test(text) && !(cpMerchant && WATER_SELLER.has(cpMerchant.category))) {
    return { category: 'wohnen', subcategory: 'wasser', categorySource: 'keyword', confidence: 0.9 };
  }
  return null;
}

// ---------------------------------------------------------------- Verfeinerung der Unterkategorie
// Rentenbausteine (Nutzerwunsch: immer „Vorsorge & Sparen“, nie „Versicherungen“ – auch beim Versicherer als Empfänger).
// Reihenfolge = Vorrang: Riester/Rürup vor Bausparen vor bAV vor Privatrente vor Depot/Sparplan. Text ist gefaltet.
const PENSION = [
  [/riester|ruerup|basisrente/, 'riester_ruerup'],
  [/(?<![a-z])(?:bausparen|bausparvertrag|bausparkasse|bausparrate|bauspar[a-z]*)(?![a-z])/, 'bausparen'],
  [/betriebsrente|betriebliche altersversorgung|direktversicherung|entgeltumwandlung|pensionskasse|pensionsfonds|unterstuetzungskasse|(?<![a-z])bav(?![a-z])/, 'betriebsrente'],
  [/privatrente|private rente|privat rente|rentenversicherung|altersvorsorge[a-z]*|fondsrente|fondspolice|fondsgebundene|rentenpolice|rentenbaustein[a-z]*|zukunftsrente|generation (?:basic|business|private)/, 'privatrente'],
  [/vermoegensdepot|investmentdepot|fondsdepot|vermoegensverwaltung|kapitalanlage|vermoegenswirksam[a-z]*|(?<![a-z])vl (?:sparen|sparplan|vertrag|leistung[a-z]*|beitrag|anlage)(?![a-z])|(?:etf|fonds|wertpapier)sparplan|(?:etf|fonds) sparplan|(?<![a-z])sparplan(?![a-z])/, 'sparplan_depot'],
];
// Gesetzliche Rente (DRV) und Depotgebühren sind keine Rentenbausteine im obigen Sinn
const PENSION_NOT = /deutsche rentenversicherung|(?<![a-z])drv(?![a-z])|depotentgelt|depotgebuehr|verwahrentgelt|kontofuehrung/;
// Versicherer-Name mit „Vorsorge“/„Pension“ (z. B. „ERGO Vorsorge Lebensversicherung AG“, „Allianz Pensionskasse“)
const PENSION_CP = /(?<![a-z])vorsorge(?![a-z])|pensionskasse|pensionsfonds|unterstuetzungskasse|versorgungswerk/;

/** Rentenbaustein-Unterkategorie aus dem Text oder null */
function pensionSub(text) {
  if (PENSION_NOT.test(text)) return null;
  for (const [re, sub] of PENSION) if (re.test(text)) return sub;
  return null;
}

function refineInsurance(text, cpText) {
  const t = `${text} ${cpText}`;
  // Privatrente & Co. gehören zur Vorsorge, nicht zu den Versicherungen
  const p = pensionSub(text);
  if (p) return { category: 'vorsorge_sparen', sub: p };
  // reine Risikoversicherungen bleiben Versicherungen
  if (/haftpflicht/.test(t)) return { category: 'versicherungen', sub: 'haftpflicht' };
  if (/hausrat/.test(t)) return { category: 'versicherungen', sub: 'hausrat' };
  if (/berufsunfaehig|(?<![a-z])bu(?![a-z])/.test(t)) return { category: 'versicherungen', sub: 'bu' };
  if (/zusatz|krankenzusatz|zahnzusatz|krankenversicherung/.test(t)) return { category: 'versicherungen', sub: 'kranken_zusatz' };
  if (/kfz|(?<![a-z])auto(?![a-z])|vollkasko|teilkasko|fahrzeug/.test(t)) return { category: 'versicherungen', sub: 'kfz' };
  if (/rechtsschutz/.test(t)) return { category: 'versicherungen', sub: 'rechtsschutz' };
  if (/unfall/.test(t)) return { category: 'versicherungen', sub: 'unfall' };
  if (/risikoleben|risiko lebens/.test(t)) return { category: 'versicherungen', sub: 'leben' };
  // Name des Versicherers: „… Vorsorge …“, Pensionskasse → Vorsorge; sonst Lebensversicherung
  const cp = pensionSub(cpText) || (PENSION_CP.test(cpText) ? (/pension|unterstuetzungskasse/.test(cpText) ? 'betriebsrente' : 'privatrente') : null);
  if (cp) return { category: 'vorsorge_sparen', sub: cp };
  if (/lebensversicherung|kapitallebens|(?<![a-z])leben(?![a-z])/.test(t)) return { category: 'versicherungen', sub: 'leben' };
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
// Wertpapier-Girobuchung (comdirect: „Wertpapiere … WPKNR … ISIN“; auch WKN/ISIN neben „Wertpapier“)
const SECURITIES = /wpknr|(?<![a-z])(?:wertpapiere?|wp)(?![a-z]).*(?:(?<![a-z])wkn(?![a-z])|(?<![a-z])isin(?![a-z]))|(?<![a-z])(?:wertpapierverkauf|wertpapier verkauf|wp verkauf|wertpapierabrechnung|wp abrechnung)(?![a-z])/;
const SECURITIES_SELL = /verkauf|(?<![a-z])vk(?![a-z])|tilgung|rueckzahlung|endfaelligkeit|einloesung|sell/;
// DKB-Buchungsart „Lohn, Gehalt, Rente“ (in Buchungstext oder Verwendungszweck)
const BT_SALARY = / lohn gehalt rente /;
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

  const card = CARD.test(`${btFold} ${purposeFold} ${rawFold}`);
  // Händler der Gegenpartei (gecacht; auch für Miete/Wasser-Ausnahmen)
  const mkey = cpFold + '|' + rawFold;
  let cpMerchant = cache.cp.get(mkey);
  if (cpMerchant === undefined) { cpMerchant = findMerchant(cpFold, '') || (rawFold && rawFold !== cpFold ? findMerchant(rawFold, '') : null); cache.cp.set(mkey, cpMerchant); }

  // 2a'. Reiseziel + Unterkunft/Flug/Urlaub im Text: Reise (vor Miete/Wasser – „Miete Ferienwohnung Teneriffa“ ist Urlaub)
  if (!pos && !tx.ownTransfer && DESTINATION.test(text)) {
    const sub = TRIP_FLIGHT.test(text) ? 'fluege' : TRIP_STAY.test(text) ? 'hotel' : TRIP_ANY.test(text) ? 'urlaub' : null;
    if (sub) return { category: 'freizeit_reisen', subcategory: sub, categorySource: 'keyword', confidence: 0.85 };
  }

  // 2b'. Miete und Wasser: direkt nach den Nutzerregeln – vor Bargeld, Händlern und Stichworten
  //      (eigene Überweisungen ausgenommen, sonst zählte das Umbuchen fürs Mietkonto als Ausgabe)
  if (!tx.ownTransfer) {
    const sellerOf = cpMerchant && !cpMerchant.intermediary ? cpMerchant : purposeMerchant(purposeFold, card);
    const w = wohnenFirst(tx, { pos, text, cpMerchant: sellerOf && !sellerOf.intermediary ? sellerOf : null });
    if (w) return w;
  }

  // 2c. Rentenbausteine (Abfluss): Riester/Rürup, bAV, Privat-/Fondsrente, Vermögensdepot, Sparplan, VL, Bausparen →
  //     immer Vorsorge & Sparen – vor Händlerliste (Versicherer-Namen) und allgemeiner Versicherungsregel
  if (!pos && !tx.ownTransfer) {
    const ps = pensionSub(text);
    if (ps) {
      const out = { category: 'vorsorge_sparen', subcategory: ps, categorySource: 'keyword', confidence: 0.85 };
      if (cpMerchant && !cpMerchant.intermediary) out.merchant = cpMerchant.name;
      return out;
    }
  }

  // 2d. Wertpapierkauf / Sparplan (Abfluss) – vor der Händlerliste, damit „comdirect“ & Co. nicht als Bankgebühr enden
  if (!pos && !DEPOT_NOT.test(text)) {
    const depotAcc = cache.depot.has(tx.accountId) && /(?<![a-z])kauf(?![a-z])|sparplan|ausfuehrung|wertpapier/.test(`${btFold} ${purposeFold}`);
    if (depotAcc || DEPOT_BUY.test(text) || SECURITIES.test(text)) return { category: 'vorsorge_sparen', subcategory: 'sparplan_depot', categorySource: 'keyword', confidence: 0.85 };
  }

  // 3a. Einkommens-Stichworte (Zufluss) und Gehaltsbuchung der Bank
  if (pos) {
    if (tx.bookingText === 'Gehalt/Lohn' || tx.gvc === '053') return { category: 'einkommen', subcategory: 'gehalt', categorySource: 'keyword', confidence: 0.95 };
    // DKB „Lohn, Gehalt, Rente“: Rente erkennt man nur an Zweck/Auftraggeber, sonst Gehalt
    if (BT_SALARY.test(` ${btFold} ${purposeFold} `)) {
      const rest = `${purposeFold} ${cpFold} ${rawFold}`.replace(/lohn gehalt rente/g, ' ');
      const k = INCOME_FIRST.find(r => r.sub !== 'gehalt' && r.re.test(rest));
      if (k?.sub === 'rente') return { category: 'einkommen', subcategory: 'rente', categorySource: 'keyword', confidence: 0.9 };
      return { category: 'einkommen', subcategory: 'gehalt', categorySource: 'keyword', confidence: 0.9 };
    }
    for (const k of INCOME_FIRST) if (k.re.test(`${purposeFold} ${btFold}`)) return { category: k.category, subcategory: k.sub, categorySource: 'keyword', confidence: k.conf };
    // Wertpapierverkauf / Rückzahlung auf dem Girokonto: Umschichtung aus dem Depot – weder Einkommen noch Ausgabe
    if (SECURITIES.test(text) && (SECURITIES_SELL.test(text) || !/gutschrift|erstattung/.test(text))) {
      return { category: 'vorsorge_sparen', subcategory: 'sparplan_depot', categorySource: 'keyword', confidence: 0.8 };
    }
  }

  // 3a'. Zufluss vom eigenen Konto (Gegenkonto nicht importiert): weder Einnahme noch Entnahme aus Sparen
  if (pos && tx.ownTransfer) return { category: 'umbuchung', subcategory: transferSub(tx, cpFold + ' ' + rawFold, purposeFold), categorySource: 'transfer', confidence: 0.7 };

  // 3b. Händlerliste (gefaltete Gegenpartei, dann Verwendungszweck)
  let weak = null;
  let m = cpMerchant;
  if (!m || m.intermediary) m = purposeMerchant(purposeFold, card) || m;
  // Plattform (Amazon): ein Abo-Anbieter in Rohtext/Zweck (Audible, Prime Video …) ist genauer
  if (m?.platform) m = findSubscription('', `${rawFold} ${purposeFold}`) || m;
  if (m && !m.intermediary) {
    if (m.conf < 0.6) weak = m;
    else {
      let category = m.category, sub = m.sub || null;
      if (m.refine === 'insurance') { const r = refineInsurance(`${purposeFold} ${btFold}`, `${cpFold} ${rawFold}`); if (r.category) category = r.category; sub = r.sub ?? sub; }
      else if (m.refine === 'wohnen') { const r = refineWohnen(`${purposeFold} ${btFold}`); sub = r.sub ?? sub; }
      // Steuerbehörde: Zufluss = Erstattung
      if (pos && category === 'steuern_abgaben') { category = 'einkommen'; sub = 'erstattung'; }
      // Rückfluss von Sparprodukten mit Zinsen/Ausschüttung
      if (pos && category === 'vorsorge_sparen' && /zins/.test(purposeFold)) { category = 'einkommen'; sub = 'zinsen'; }
      // DB-Abbuchung in Höhe des Deutschlandtickets (49 / 58 / 63 €) bzw. mit Ticketnamen: ÖPNV-Abo statt Fernverkehr
      if (m.name === 'Deutsche Bahn' && !pos && (/deutschland ?ticket|d ticket|deutschlandabo/.test(text) || [4900, 5800, 6300].includes(-tx.amount))) sub = 'oepnv';
      if (sub && !getSub(category, sub)) sub = null;
      const conf = !sub && category === 'versicherungen' ? Math.min(m.conf, 0.75) : m.conf;
      return { category, subcategory: sub, categorySource: 'merchant', confidence: conf, merchant: m.name };
    }
  }

  // 4. Stichwortregeln
  for (const k of KEYWORDS) {
    if (k.dir === 'in' && !pos) continue;
    if (!k.re.test(text)) continue;
    if (k.sub === 'miete' && RENT_NOT_TEXT.test(text)) continue;
    let category = k.category, sub = k.sub;
    if (category === 'versicherungen') {
      const r = refineInsurance(`${purposeFold} ${btFold}`, `${cpFold} ${rawFold}`);
      if (r.category) category = r.category;
      sub = r.sub ?? null;
    }
    if (pos && category === 'steuern_abgaben') { category = 'einkommen'; sub = 'erstattung'; }
    return { category, subcategory: sub, categorySource: 'keyword', confidence: k.conf };
  }

  // 4a. Urlaubsziel im Kartenumsatz im Ausland (schwach)
  if (!pos && DESTINATION.test(text) && (ABROAD.test(text) || (tx.currency && tx.currency !== 'EUR') || tx.originalCurrency)) {
    return { category: 'freizeit_reisen', subcategory: 'urlaub', categorySource: 'keyword', confidence: 0.55 };
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
  // Nutzerregeln greifen vor allem anderen; selbst angelegte vor automatisch gelernten
  const userRules = (rules || []).filter(r => r && r.enabled !== false && r.match && r.set)
    .map((r, i) => ({ r, i })).sort((a, b) => (!!a.r.auto - !!b.r.auto) || (a.i - b.i)).map(x => x.r);
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
  // Nur Zahlungsdienst bekannt (PayPal ohne Shop, Klarna, „VISA“ …): keine Regel – Gläubiger-ID/IBAN/Zweck gehören
  // dann dem Zahlungsdienst und würden alle seine Buchungen treffen
  if (name && isGenericCounterparty(name)) return null;
  let match;
  const iban = normalizeIban(tx.counterpartyIban);
  if (name && name.length >= 3 && fold(name).length >= 3 && !isGenericCounterparty(name)) match = { field: 'counterparty', op: 'contains', value: name };
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
