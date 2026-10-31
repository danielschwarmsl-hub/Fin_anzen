// Anonymisierter Erkennungsbericht – DOM-frei. Ziel: echte Problemfälle (Textstruktur, Spalten, Fachwörter) ohne
// persönliche Daten an den Entwickler weitergeben. Nichts wird gesendet; der Nutzer kopiert den Text selbst.
//
// anonymizeText: Ziffern → 0 (Format bleibt: „1.077,30“ → „0.000,00“), IBAN/E-Mail/URL ersetzt, BIC/Namen/Orte über die
// Wortregel: Wörter mit Großbuchstaben, die weder Fach-/Strukturwort noch bekannter Bank-/Händlername sind, werden zu
// „Xxxxx“ (gleiche Länge, damit Spalten stehen bleiben). Die Prüfung läuft auf der Kleinschreibung – ein Wort am
// Satzanfang („Bitte“, „Die“) bleibt also lesbar, ein Name am Zeilenanfang nicht.

const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const set = (s) => new Set(s.split(/\s+/).filter(Boolean).map(norm));

// Fach- und Strukturwörter (Bank, Depot, Steuer, Versicherung, Belege) und häufige Wörter – Kleinschreibung, mit Umlauten
const DICT = set(`
  konto kontoauszug kontoauszüge auszug auszüge kontonummer kontostand kontoinhaber kontoinhaberin girokonto tagesgeld festgeld
  sparkonto depot depotkonto depotnummer verrechnungskonto liquiditätskonto kreditkarte karte karten kartennummer girocard visa
  mastercard debit bank banken sparkasse filiale bankleitzahl blz iban bic swift sepa sepa-lastschrift lastschrift lastschriften
  gutschrift gutschriften überweisung überweisungen dauerauftrag daueraufträge auftrag aufträge buchung buchungen buchungstag
  buchungsdatum buchungstext buchungsart buchungsinformation wertstellung valuta datum betrag beträge eur euro usd chf gbp
  währung soll haben saldo salden alter neuer alt neu anfangssaldo endsaldo kontostand vortrag übertrag summe summen gesamt
  gesamtbetrag gesamtumsatz gesamtumsatzsummen zwischensumme umsatz umsätze umsatzanzeige erläuterung erläuterungen
  verwendungszweck zweck empfänger auftraggeber zahlungsempfänger zahlungspflichtiger begünstigter gläubiger gläubiger-id
  mandat mandatsreferenz referenz end-to-end-referenz kundenreferenz abbuchung einzahlung auszahlung abhebung bargeld
  bargeldauszahlung geldautomat kartenzahlung kartenumsatz zahlung zahlungen zahlungseingang zahlungsausgang eingang ausgang
  entgelt entgelte gebühr gebühren kontoführung kontoführungsentgelt zinsen zins zinssatz sollzins habenzins dispo dispositionskredit
  kredit kreditrahmen verfügungsrahmen limit rechnungsabschluss abschluss abschlussposten finanzreport kontoübersicht übersicht
  wertpapier wertpapiere wertpapierkauf wertpapierverkauf wertpapierabrechnung geschäftsabrechnung abrechnung abrechnungen
  kauf verkauf order ordernummer auftragsnummer handelsplatz börsenplatz ausführungsplatz ausführungsort börse handel xetra
  tradegate kurs kurswert stück stk nominal anteile anteil fonds fondsname etf aktie aktien anleihe isin wkn wpknr depotbestand
  bestand bestände bezeichnung dividende dividenden dividendengutschrift ausschüttung ertrag erträge ertragsgutschrift
  quellensteuer devisenkurs kapitalertrag kapitalerträge kapitalertragsteuer abgeltungsteuer solidaritätszuschlag kirchensteuer
  freistellungsauftrag verlustverrechnung verlusttopf steuer steuern steuerlich steuerliche steuerbescheinigung jahressteuerbescheinigung
  steuerbemessungsgrundlage provision courtage spesen fremde eigene kosten kosteninformation kostenübersicht dienstleistungskosten
  produktkosten laufende einmalige rendite renditeminderung wertentwicklung vermögen vermögensdepot vermögensübersicht reporting
  sparplan sparrate depotwert stichtag zeitraum periode quartal monat monate jahr jahre tag tage woche
  januar februar märz april mai juni juli august september oktober november dezember
  montag dienstag mittwoch donnerstag freitag samstag sonntag
  lohn gehalt gehaltsabrechnung entgeltabrechnung brutto netto auszahlungsbetrag steuerklasse lohnsteuer sozialversicherung
  krankenversicherung pflegeversicherung rentenversicherung arbeitslosenversicherung arbeitgeber arbeitnehmer personalnummer
  versicherung versicherungen versicherungsschein versicherungsnummer versicherungsnehmer versicherte beitrag beiträge police
  rente renten vorsorge altersvorsorge standmitteilung vertrag verträge vertragsnummer laufzeit tarif kündigung abo abonnement
  rechnung rechnungen rechnungsnummer rechnungsdatum rechnungsbetrag kassenbon bon beleg belege quittung mwst ust umsatzsteuer
  ust-id steuernummer nettobetrag bruttobetrag zahlbar fällig fälligkeit zahlungsziel lieferung lieferdatum leistungszeitraum
  menge preis einzelpreis position positionen artikel rabatt pfand rückgeld gegeben bar
  kunde kunden kundennummer nummer nr seite seiten blatt von bis vom zum zur am im in an auf aus bei mit nach über unter für
  per pro je und oder der die das den dem des ein eine einer eines einem einen kein keine nicht nur auch als wie wird werden
  wurde wurden ist sind war hat haben bitte vielen dank ihr ihre ihren ihrem ihres ihnen sie wir uns unser unsere unseren
  unserem dieser diese dieses diesen hiermit gemäß laut zu zum sowie bzw ggf inkl zzgl abzgl ca evtl
  herr herrn frau firma gmbh ag kg eg ev se co ohg mbh
  anschrift adresse straße postfach telefon tel fax e-mail email internet web www service kundenservice hotline
  wert vorgang vorgänge art text beschreibung details kategorie notiz betreff gegenkonto ort land
  datei dateien erstellt erstellung info information informationen hinweis hinweise mitteilung bestätigung bescheinigung erklärung angaben
  lasten gunsten belastet ja nein alle neue neuen neues erhalten gesamtsumme anzahl transaktionen transaktion umsatzliste
  deutschland germany europa zahlungsweg miete nebenkosten strom gas wasser versand porto gutschein erstattung rückerstattung
  storno rücklastschrift rückbuchung einkauf tankstelle apotheke supermarkt restaurant reise ticket bahn fahrkarte
  date description amount balance payment payments fee fees total currency transaction transactions status type name gross net
  invoice receipt reference account statement opening closing credit debit card from to of the and for
  mail sehr geehrte geehrter freundlichen grüßen grüße fragen mehr jetzt hier heute original europe inc ltd llc sarl cie
  geschäftstag schlusstag handelstag handelszeit ausführungszeit ausführung uhrzeit zeit stückzinsen nennwert richtlinie
`);

// Bank-, Broker-, Versicherer- und Händlernamen bleiben lesbar (keine Personen)
const BRANDS = set(`
  comdirect dkb mlp paypal ing ing-diba diba commerzbank deutsche postbank targobank santander hanseatic barclays norisbank
  n26 volksbank raiffeisenbank sparkasse consorsbank consors cortal trade republic scalable capital smartbroker flatex degiro
  onvista justtrade maxblue broker dadat baader ebase fidelity fondsbank fondsdepot union investment dws deka dekabank
  hypovereinsbank renault kreditbank apobank gls triodos psd sparda bnp paribas amex american express klarna
  allianz axa generali ergo debeka huk huk-coburg coburg hdi zurich swiss life canada gothaer barmenia devk concordia
  continentale hannoversche cosmos direkt techniker krankenkasse aok barmer
  rewe edeka aldi lidl kaufland globus tegut budni rossmann famila marktkauf alnatura shell aral esso
  amazon ebay zalando ikea netflix spotify apple google microsoft adobe dropbox vodafone telekom congstar strato
  sky dazn audible youtube adac
`);

// Wortteile für zusammengesetzte Fachwörter („Kontoführungsentgelt“, „Sammelüberweisung“) – am Wortanfang oder -ende
const STEMS = ['konto', 'bank', 'buchung', 'betrag', 'saldo', 'zahlung', 'ueberweisung', 'lastschrift', 'gutschrift', 'belastung',
  'rechnung', 'steuer', 'zins', 'gebuehr', 'entgelt', 'kosten', 'preis', 'summe', 'umsatz', 'datum', 'valuta', 'wertstellung',
  'auszug', 'abrechnung', 'karte', 'kredit', 'depot', 'wertpapier', 'kurs', 'dividende', 'ertrag', 'ertraege', 'ausschuettung',
  'fonds', 'aktie', 'anleihe', 'versicherung', 'beitrag', 'rente', 'vertrag', 'leistung', 'gehalt', 'brutto', 'netto', 'gesamt',
  'vermoegen', 'anlage', 'sparplan', 'guthaben', 'transaktion', 'mandat', 'glaeubiger', 'referenz', 'empfaenger', 'auftrag',
  'waehrung', 'devisen', 'provision', 'boerse', 'verkauf', 'nummer', 'bescheinigung', 'mitteilung', 'information', 'uebersicht',
  'bestand', 'zeitraum', 'quartal', 'stichtag', 'kuendigung', 'laufzeit', 'tarif', 'posten', 'position', 'einzahlung',
  'auszahlung', 'abhebung', 'geldautomat', 'bestellung', 'lieferung', 'kunden', 'inhaber', 'kapital', 'verlust', 'gewinn'];
const STREET_RE = /(?:strasse|str|weg|allee|platz|gasse|ring|damm|ufer|chaussee|steig|pfad|mann)$/;
const NOUN_RE = /(?:ung|ungen|heit|heiten|keit|keiten|schaft|schaften|tion|tionen|taet|nis|nisse|ismus)$/;
const ENDINGS = /(?:en|ern|er|es|em|e|n|s)$/;

const inDict = (n) => DICT.has(n) || BRANDS.has(n) || DICT.has(n.replace(ENDINGS, '')) || BRANDS.has(n.replace(ENDINGS, ''));
const hasStem = (n) => {
  const base = n.replace(ENDINGS, '');
  return STEMS.some((s) => n.startsWith(s) || n.endsWith(s) || base.endsWith(s) || (s.length >= 7 && n.includes(s)));
};

/** Bleibt das Wort lesbar? Kleingeschriebene und sehr kurze Wörter immer; sonst Fachwort, Marke oder Fach-Kompositum. */
export function keepWord(w) {
  if (!/\p{Lu}/u.test(w) || w.length <= 2) return true;
  const n = norm(w);
  if (inDict(n)) return true;
  if (STREET_RE.test(n)) return false; // Straßen, Orte auf -weg/-platz, Namen auf -mann
  if (hasStem(n)) return true;
  return n.length >= 8 && NOUN_RE.test(n);
}
const mask = (w) => [...w].map((c) => (/\p{Lu}/u.test(c) ? 'X' : 'x')).join('').replace(/^x/, 'X');

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const EMAIL_RE = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BIC_RE = /\b(BIC|SWIFT(?:-Code)?)(\s*:?\s*)([A-Z0-9]{8,11})\b/g;

function anonUrl(u) {
  const host = u.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
  const parts = host.split('.');
  const known = parts.some((p) => BRANDS.has(p));
  const scheme = /^https?:\/\//i.test(u) ? u.match(/^https?:\/\//i)[0] : '';
  return known ? `${scheme}${host}${host.length < u.length - scheme.length ? '/…' : ''}` : `${scheme}xxxx.xx/…`;
}

/** Text anonymisieren; Zeilen, Leerzeichen und Zeichenbreite der Zahlen bleiben erhalten. */
export function anonymizeText(text) {
  return String(text || '')
    .replace(URL_RE, anonUrl)
    .replace(EMAIL_RE, 'name@example.org')
    .replace(IBAN_RE, (m) => m.slice(0, 2) + m.slice(2).replace(/[A-Z0-9]/g, '0'))
    .replace(BIC_RE, (m, label, sep, code) => label + sep + 'X'.repeat(code.length))
    .replace(/\d/g, '0')
    .replace(/\p{L}[\p{L}\p{M}]*/gu, (w) => (keepWord(w) ? w : mask(w)));
}

const zero = (m) => m.replace(/\d/g, '0');
/**
 * Von der App erzeugter Satz (Diagnose, Begründung): Zählungen und Seitenzahlen bleiben, Zitate aus dem Dokument
 * („…“, ‚…‘) werden anonymisiert, Beträge, Datumsangaben, IBAN und E-Mail genullt.
 */
export function anonymizeNote(s) {
  return String(s || '')
    .replace(/([„"‚])([^“"‘]*)([“"‘])/g, (m, a, b, c) => a + anonymizeText(b) + c)
    .replace(EMAIL_RE, 'name@example.org')
    .replace(IBAN_RE, (m) => m.slice(0, 2) + m.slice(2).replace(/[A-Z0-9]/g, '0'))
    .replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, zero)
    .replace(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g, zero);
}

/** Auf max Zeichen kürzen, an einer Zeilengrenze; Hinweis auf die Kürzung anhängen. */
export function clipText(text, max = 15000) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const cut = s.lastIndexOf('\n', max);
  return s.slice(0, cut > max * 0.8 ? cut : max) + `\n… (gekürzt, insgesamt ${s.length.toLocaleString('de-DE')} Zeichen)`;
}

const pct = (v) => (v == null ? '–' : `${Math.round(v <= 1 ? v * 100 : v)} %`);

/**
 * Erkennungsbericht als Text. Der Dokumenttext läuft durch anonymizeText, Begründung und Diagnose durch anonymizeNote.
 * info: { appVersion, parserVersion, fileExt, mime, pages, ocr, ocrConfidence, type, typeName, subtype, confidence,
 *         typeSource, alternatives: [{ name, confidence }], explanation: string[], problems: string[], text, maxText }
 */
export function detectionReport(info) {
  const i = info || {};
  const out = [
    'FinanzRadar – Erkennungsbericht (anonymisiert)',
    `App ${i.appVersion || '?'} · Parser-Version ${i.parserVersion ?? '?'}`,
    `Datei: ${i.fileExt ? '.' + i.fileExt : '?'}${i.mime ? ` (${i.mime})` : ''} · Seiten: ${i.pages ?? '?'} · OCR: ${i.ocr ? `ja, Sicherheit ${pct(i.ocrConfidence)}` : 'nein'}`,
    `Erkannt: ${i.typeName || i.type || '?'}${i.subtype ? ` › ${i.subtype}` : ''} · Sicherheit ${pct(i.confidence)}${i.typeSource ? ` · Typ gesetzt von: ${i.typeSource === 'user' ? 'Nutzer' : i.typeSource === 'ai' ? 'KI' : i.typeSource}` : ''}`,
  ];
  if (i.alternatives?.length) out.push(`Alternativen: ${i.alternatives.map((a) => `${a.name} ${pct(a.confidence)}`).join(', ')}`);
  if (i.explanation?.length) out.push('', 'Warum dieser Typ:', ...i.explanation.map((l) => '- ' + anonymizeNote(l)));
  if (i.problems?.length) out.push('', 'Diagnose beim Einlesen:', ...i.problems.map((p) => '- ' + anonymizeNote(p)));
  const body = anonymizeText(i.text || '');
  out.push('', `Text (anonymisiert, ${body.length.toLocaleString('de-DE')} Zeichen):`, '-----', clipText(body, i.maxText ?? 15000), '-----');
  return out.join('\n');
}
