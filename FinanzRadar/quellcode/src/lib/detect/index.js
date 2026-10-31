// Dokumenttyp-Erkennung: erst Kontoauszug/Umsatzformate (statements-Modul), dann Stichwort-Scoring.
import { detectStatementFormat } from '../parsers/docs/_statements.js';
import { STORES, INSURERS, PROVIDERS, BROKERS, matchFirst } from '../parsers/docs/known.js';
import { securitySubtype } from '../parsers/docs/securities.js';

/** lowercase, Umlaute → ae/oe/ue/ss, NBSP → Leerzeichen */
export function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/ /g, ' ').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

// [Muster (auf normalisiertem Text), Gewicht]. Treffer in den ersten Zeilen zählen anderthalbfach.
const RULES = {
  lohn: [
    [/gehaltsabrechnung|entgeltabrechnung|verdienstabrechnung|lohnabrechnung|lohn\/gehaltsabrechnung|bezuegeabrechnung/, 6],
    [/\bbrutto/, 1.5], [/\bnetto/, 1], [/lohnsteuer/, 2], [/steuerklasse/, 1.5], [/personalnummer|personal-?nr/, 2],
    [/sozialversicherung|krankenversicherung|rentenversicherung|arbeitslosenversicherung|pflegeversicherung/, 1],
    [/auszahlungsbetrag|auszahlung/, 1], [/abrechnungszeitraum|abrechnungsmonat/, 2], [/arbeitnehmeranteil/, 1],
  ],
  lohnsteuerbescheinigung: [
    [/ausdruck der elektronischen lohnsteuerbescheinigung/, 9], [/lohnsteuerbescheinigung/, 7], [/bruttoarbeitslohn/, 6],
    [/einbehaltene lohnsteuer/, 3], [/arbeitgeber/, 0.5],
  ],
  steuerbescheinigung: [
    [/jahressteuerbescheinigung/, 9], [/(?<!lohn)steuerbescheinigung/, 6], [/ertraegnisaufstellung/, 8], [/verlustbescheinigung/, 8],
    [/kapitalertragsteuer|kapitalertragssteuer|abgeltungsteuer|abgeltungssteuer/, 4], [/kapitalertraege/, 2.5], [/freistellungsauftrag/, 2.5],
    [/steuerliche bescheinigung|steuerbescheinigung nach/, 3],
  ],
  rente: [
    [/standmitteilung/, 8], [/renteninformation/, 8], [/fondsguthaben/, 5], [/rueckkaufswert/, 5],
    [/garantierte[rn]? (?:monatliche )?rente/, 4], [/privatrente/, 4], [/riester/, 4], [/ruerup/, 4], [/basisrente/, 4],
    [/deutsche rentenversicherung/, 5], [/rentenanwartschaft|rentenbeginn|ablaufleistung/, 2], [/altersvorsorge/, 1.5],
  ],
  versicherung: [
    [/versicherungsschein/, 6], [/beitragsbescheinigung/, 7], [/berufsunfaehigkeit/, 4], [/haftpflicht/, 4], [/hausrat/, 4],
    [/kfz-?versicherung|vollkasko|teilkasko/, 4], [/beitragsrechnung/, 7], [/\bpolice\b|\bpolicen\b/, 4], [/versicherungsnehmer/, 3],
    [/versicherungsbeitrag|jahresbeitrag/, 2], [/vertragsnummer|versicherungsnummer/, 1], [/versicherung/, 1.5],
    [/rechtsschutz|unfallversicherung|wohngebaeudeversicherung|lebensversicherung/, 3],
  ],
  spende: [
    [/zuwendungsbestaetigung/, 9], [/spendenbescheinigung|spendenquittung|spendenbestaetigung/, 9], [/sammelbestaetigung/, 3],
    [/gemeinnuetzig/, 2], [/freistellungsbescheid/, 2], [/spende\b/, 1.5],
  ],
  kassenbon: [
    [/kassenbon|kassenbeleg/, 7], [/\bbon-?\s?nr/, 4], [/\btse\b|signaturzaehler|tse-transaktion|tse-signatur/, 6],
    [/kartenzahlung|girocard|ec-karte|barzahlung|ruckgeld|rueckgeld|\bgegeben\b/, 2], [/summe\s+(?:eur|€)/, 3],
    [/code\s+satz\s+netto/, 4], [/\bkasse\s+\d+/, 2], [/vielen dank fuer ihren einkauf/, 3], [/\bust-?\s?id/, 0.5],
    [/mwst\s+(?:brutto|netto)/, 1],
  ],
  rechnung: [
    [/\brechnung\b/, 3], [/rechnungs-?\s?(?:nummer|nr)\b/, 5], [/rechnungsdatum/, 3], [/rechnungsbetrag/, 3.5], [/\binvoice\b/, 3],
    [/\bust-?\s?id|umsatzsteuer-?id|steuernummer/, 1], [/nettobetrag|summe netto|zzgl\.?\s*\d+\s*%|\d+\s*%\s*(?:mwst|ust|umsatzsteuer)/, 2.5],
    [/zahlbar|faellig|zahlungsziel|zahlungsbedingung/, 2], [/gesamtbetrag|endbetrag/, 1.5], [/leistungszeitraum|lieferdatum/, 1],
  ],
  // Wertpapier-Abrechnungen, Erträge, MiFID-Kosteninformation, Depot-Reporting
  wertpapier: [
    [/geschaeftsabrechnung|wertpapierabrechnung/, 7], [/wertpapier-?(?:kauf|verkauf)\b/, 6], [/ordernummer|order-?nr\b/, 3],
    [/ausfuehrungsplatz|ausfuehrungsort|handelsplatz/, 3], [/\bkurswert\b/, 2], [/zu ihren (?:lasten|gunsten)/, 3],
    [/dividendengutschrift|gutschrift faelliger wertpapier-?ertraege/, 9], [/ertragsgutschrift|ertraegnisgutschrift|ausschuettungsgutschrift/, 6],
    [/\bdividende\b|\bausschuettung\b/, 2], [/quellensteuer/, 1.5], [/\bwkn\b|\bisin\b|wpknr/, 1.5], [/\bstk\.?\s+\d/, 1],
    [/kosteninformation zum wertpapiergeschaeft/, 10], [/markets in financial instruments directive|\bmifid\b/, 4], [/kostensimulation/, 3],
    [/reporting fuer ihre konten und depots/, 10], [/depotuebersicht|depotauszug|depot-?reporting|jahresdepotauszug/, 5],
    [/vermoegensdepot/, 4], [/depotbestand/, 2],
  ],
  vertrag: [
    [/\bvertrag\b|vertragsabschluss|vertragsbestaetigung/, 3], [/mitgliedschaft/, 4], [/bestaetigung ihres abonnements|abonnement/, 5],
    [/\babo\b/, 3], [/kuendigungsfrist|kuendigung/, 2.5], [/\blaufzeit\b|mindestlaufzeit|vertragslaufzeit/, 2.5],
    [/\btarif\b/, 1], [/pro monat|monatlich/, 1], [/vertragsbeginn/, 2],
  ],
};

// Dateiname-Hinweise (nur Dateiname, nicht der Ordner)
const NAME_HINTS = [
  [/lohnsteuerbescheinigung/, 'lohnsteuerbescheinigung', 5], [/steuerbescheinigung|ertraegnis/, 'steuerbescheinigung', 5],
  [/lohn|gehalt|entgelt|payslip/, 'lohn', 3], [/rechnung|invoice|\bre[-_ ]?\d/, 'rechnung', 3],
  [/kassenbon|\bbon[-_ ]|kassenzettel/, 'kassenbon', 3], [/spende|zuwendung/, 'spende', 4],
  [/versicherung|police|beitragsbescheinigung/, 'versicherung', 3], [/rente|standmitteilung/, 'rente', 3],
  [/vertrag|abo|mitgliedschaft|bestaetigung/, 'vertrag', 2], [/einkauf/, 'einkaufszettel', 5],
  [/wertpapier|dividende|ertragsgutschrift|kosteninfo|depotauszug|depotreport|orderabrechnung/, 'wertpapier', 3],
];

// Verneinte Bescheinigungen („KEINE STEUERBESCHEINIGUNG“ auf Wertpapierabrechnungen) zählen nicht als Signal
const NEGATED_RE = /\b(?:keine|kein|nicht\s+um\s+eine|nicht\s+als)\s+(?:jahres-?)?steuerbescheinigung\w*/g;
// Kontoauszug/Finanzreport mit Wertpapier-Buchungszeilen ist kein Wertpapier-Dokument
const STATEMENT_HINT_RE = /finanzreport|kontoauszug|kontouebersicht|rechnungsabschluss/;

const GROCERY = ['milch', 'brot', 'eier', 'butter', 'kaese', 'aepfel', 'apfel', 'bananen', 'kaffee', 'zahnpasta', 'nudeln', 'reis', 'mehl',
  'zucker', 'joghurt', 'tomaten', 'kartoffeln', 'gurke', 'wasser', 'bier', 'wurst', 'schinken', 'salat', 'zwiebeln', 'obst', 'gemuese',
  'haferflocken', 'muesli', 'broetchen', 'quark', 'sahne', 'toilettenpapier', 'spuelmittel', 'orangensaft', 'honig'];
const FINANCE_WORDS = ['betrag', 'summe', 'iban', 'konto', 'saldo', 'beitrag', 'steuer', 'euro', 'zahlung', 'mwst', 'umsatz', 'brutto',
  'netto', 'rechnung', 'versicherung', 'gehalt', 'bank', 'vertrag', 'gebuehr', 'kosten', 'preis'];
const MONEY = /\d+[.,]\d{2}(?!\d)/;
// Kurze Stämme brauchen eine rechte Wortgrenze (sonst zählen „Europa“, „Reisekosten“ …); erlaubt sind nur übliche Endungen
const RIGHT_BOUND = { euro: '(?:s)?', reis: '(?:es)?' };
const wordRe = (w) => new RegExp(`(?<![a-z])${w}${w in RIGHT_BOUND ? `${RIGHT_BOUND[w]}(?![a-z])` : ''}`);
const OCR_MIN_CONFIDENCE = 55; // darunter gilt ein OCR-Ergebnis als unsicher

const unique = (a) => [...new Set(a)];

/** Punkte je Typ + Treffer-Signale. */
// Belege, Abrechnungen und Bescheinigungen haben wenige Seiten; bei langen Dokumenten (z. B. Kontoauszug über 69 Seiten)
// zählen Stichwörter nur auf den ersten Seiten – sonst machen Buchungstexte wie „Gehalt“ daraus eine Lohnabrechnung.
const KEYWORD_PAGES = 2;
const LONG_DOC_PAGES = 3;

export function scoreTypes(extracted, fileMeta) {
  const pages = extracted?.pages || [];
  const full = normalize(extracted?.text || extracted?.rawText || '');
  const text = (pages.length > LONG_DOC_PAGES ? normalize(pages.slice(0, KEYWORD_PAGES).map((p) => p.text || '').join('\n')) : full)
    .replace(NEGATED_RE, ' ');
  const head = text.slice(0, 350);
  const name = normalize(fileMeta?.name || '');
  const scores = {}, signals = {};
  const add = (type, w, sig) => { scores[type] = (scores[type] || 0) + w; if (sig) (signals[type] ||= []).push(sig); };

  for (const [type, rules] of Object.entries(RULES)) {
    for (const [re, w] of rules) {
      const m = re.exec(text);
      if (!m) continue;
      add(type, w + (re.test(head) ? w * 0.5 : 0), m[0].trim());
    }
  }
  for (const [re, type, w] of NAME_HINTS) if (re.test(name)) add(type, w, `Dateiname:${re.exec(name)[0]}`);
  if ((scores.wertpapier || 0) > 0 && STATEMENT_HINT_RE.test(text)) add('wertpapier', -Math.min(scores.wertpapier, 8), null);
  // Ertrags-/Wertpapierabrechnung: „zahlbar ab“, „Rechnungsnummer“ o. Ä. machen daraus keine Rechnung
  if ((scores.wertpapier || 0) >= 12 && scores.rechnung) add('rechnung', -Math.min(scores.rechnung, 4), null);

  // Kassenbon: kurzes Bildlayout mit Beträgen (nur zusätzlich zu echten Bon-Signalen)
  const lineCount = text ? text.split('\n').filter((l) => l.trim()).length : 0;
  if ((scores.kassenbon || 0) > 0 && extracted?.kind === 'image' && lineCount < 70) add('kassenbon', 1.5, 'Bildbeleg');

  // E-Rechnung im XML
  const xml = extracted?.xml || '';
  if (/CrossIndustryInvoice/.test(xml)) add('rechnung', 30, 'ZUGFeRD/CII');
  else if (/<(?:\w+:)?Invoice[\s>]|urn:oasis:names:specification:ubl:schema:xsd:Invoice/.test(xml)) add('rechnung', 30, 'XRechnung/UBL');

  // Einkaufszettel: kurze Liste von Lebensmitteln ohne Preise (keine Rezepte)
  const isRecipe = /rezept|zutaten|zubereitung|backofen|minuten (?:kochen|backen)/.test(text);
  const grocery = unique(GROCERY.filter((g) => wordRe(g).test(text)));
  const shortLines = text.split('\n').filter((l) => l.trim());
  if (!isRecipe && !MONEY.test(text) && grocery.length >= 3 && shortLines.length <= 30 && shortLines.filter((l) => l.length <= 45).length >= shortLines.length * 0.8) {
    add('einkaufszettel', 6 + Math.min(3, grocery.length * 0.3), `Lebensmittel:${grocery.slice(0, 5).join(',')}`);
  }
  if (/einkaufszettel|einkaufsliste/.test(text)) add('einkaufszettel', 5, 'Einkaufszettel');
  if (isRecipe) delete scores.einkaufszettel;

  return { scores, signals, text, grocery };
}

function confidenceFor(top, second) {
  const base = Math.min(0.97, 0.45 + 0.04 * top);
  const margin = second > 0 ? Math.min(1, (top - second) / top) : 1;
  return Math.round(Math.max(0.3, base * (0.65 + 0.35 * margin)) * 100) / 100;
}

const UNCERTAIN_CONFIDENCE = 0.55; // darunter: Typ unsicher
const UNCERTAIN_MARGIN = 0.15;     // Zweitbester liegt weniger als 15 % hinter dem Besten: Typ unsicher

/** Zweit-/Drittbeste Typen mit grober Sicherheit: Anteil an der Punktzahl des Besten, immer unter dessen Sicherheit. */
function alternativesFor(ranked, best) {
  const top = ranked[0]?.[1] || 0;
  return ranked.slice(1, 3).filter(([, s]) => s >= 2).map(([type, s]) => ({
    type, confidence: Math.round(Math.max(0.05, best * (s / top) * 0.9) * 100) / 100,
  }));
}

function institutionFor(type, text, extracted) {
  const raw = String(extracted?.text || '');
  const head = raw.split('\n').slice(0, 10).join('\n');
  if (type === 'kassenbon') return matchFirst(STORES, head);
  if (type === 'versicherung' || type === 'rente') return matchFirst(INSURERS, head) || matchFirst(INSURERS, raw);
  if (type === 'vertrag') return PROVIDERS.find((p) => raw.includes(p)) || null;
  if (type === 'wertpapier') return matchFirst(BROKERS, raw);
  return null;
}

function subtypeFor(type, extracted, signals) {
  if (type === 'rechnung') {
    if (/CrossIndustryInvoice/.test(extracted?.xml || '')) return 'zugferd';
    if (/Invoice/.test(extracted?.xml || '')) return 'xrechnung';
    return extracted?.ocr ? 'scan' : null;
  }
  if (type === 'wertpapier') return securitySubtype(extracted?.text || extracted?.rawText || '');
  if (type === 'versicherung') {
    const s = (signals || []).join(' ');
    return /berufsunf/.test(s) ? 'bu' : /haftpflicht/.test(s) ? 'haftpflicht' : /hausrat/.test(s) ? 'hausrat' : /kfz|kasko/.test(s) ? 'kfz' : null;
  }
  return null;
}

const det = (type, o = {}) => ({ type, subtype: null, institution: null, format: null, confidence: 0.5, signals: [], alternatives: [], ...o });

/** Bild/Scan, dessen Text nicht verwertbar ist: kein Verwerfen, sondern ein Prüf-Dokument „unlesbar“. */
const unreadable = (signal) => det('finanz_sonstiges', { subtype: 'unlesbar', confidence: 0.3, signals: [signal], unreadable: true });
const isScan = (extracted) => extracted?.kind === 'image' || (extracted?.kind === 'pdf' && (extracted.ocr || !String(extracted.text || '').trim()));
const lowOcr = (extracted) => !!extracted?.ocr && typeof extracted.ocrConfidence === 'number' && extracted.ocrConfidence < OCR_MIN_CONFIDENCE;

/** Nur Dokument-Erkennung (ohne Kontoauszug-Formate) – synchron, DOM-frei. */
export function detectDocumentType(extracted, fileMeta) {
  const kind = extracted?.kind;
  const rawText = String(extracted?.text || extracted?.rawText || '');
  if (kind === 'unsupported') return det('irrelevant', { subtype: 'unsupported', confidence: 0.6, signals: ['nicht unterstütztes Format'] });
  if (!extracted?.xml && rawText.replace(/\s+/g, '').length < 12) {
    const nm = normalize(fileMeta?.name);
    if (/einkauf/.test(nm)) return det('einkaufszettel', { confidence: 0.4, signals: ['Dateiname:einkauf'] });
    // Bild/Scan ohne Text: unlesbar – außer die OCR hat sicher nur ein paar Zeichen gefunden (Foto mit Schild o. Ä.)
    const confidentFewChars = extracted?.ocr && rawText.trim() && !lowOcr(extracted);
    if (isScan(extracted) && !confidentFewChars) return unreadable(kind === 'image' ? 'Bild ohne erkennbaren Text' : 'Scan ohne erkennbaren Text');
    return det('irrelevant', { subtype: kind === 'image' ? 'kein_text' : 'leer', confidence: kind === 'image' ? 0.8 : 0.7, signals: [kind === 'image' ? 'Bild ohne erkennbaren Text' : 'kein Text'] });
  }
  const { scores, signals, text } = scoreTypes(extracted, fileMeta);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, top] = ranked[0] || [null, 0];
  const second = ranked[1]?.[1] || 0;

  if (bestType && top >= 4) {
    // Abgrenzung: Lohnsteuerbescheinigung enthält auch Lohn-Stichwörter, Standmitteilung auch Versicherungs-Stichwörter
    const confidence = confidenceFor(top, second);
    const alternatives = alternativesFor(ranked, confidence);
    const uncertain = alternatives.length > 0 && (confidence < UNCERTAIN_CONFIDENCE || (top - second) / top < UNCERTAIN_MARGIN);
    return det(bestType, {
      subtype: subtypeFor(bestType, extracted, signals[bestType]),
      institution: institutionFor(bestType, text, extracted),
      confidence, signals: unique(signals[bestType] || []), alternatives, uncertain,
    });
  }
  const fin = unique(FINANCE_WORDS.filter((w) => wordRe(w).test(text)));
  if (fin.length >= 2 || (bestType && top >= 2.5)) {
    return det('finanz_sonstiges', {
      confidence: Math.min(0.6, 0.3 + fin.length * 0.06), signals: unique([...(signals[bestType] || []), ...fin]),
      alternatives: bestType ? [{ type: bestType, confidence: Math.round(Math.min(0.5, 0.2 + 0.04 * top) * 100) / 100 }] : [],
    });
  }
  // Kein Finanzbezug erkennbar – bei unsicherer OCR kann das aber am Lesen liegen
  if (isScan(extracted) && lowOcr(extracted)) return unreadable(`OCR-Sicherheit ${Math.round(extracted.ocrConfidence)} %`);
  return det('irrelevant', { subtype: 'kein_finanzbezug', confidence: text.length > 40 ? 0.8 : 0.6, signals: fin });
}

/**
 * detectType(extracted, fileMeta) → Detection { type, subtype, institution, format, confidence, signals, alternatives }.
 * alternatives: zweit-/drittbeste Dokumenttypen [{ type, confidence }]; uncertain: true, wenn der Typ wirklich unsicher ist.
 * Unlesbare Bilder/Scans: type 'finanz_sonstiges', subtype 'unlesbar', unreadable: true.
 * Kontoauszüge/Umsatzdateien erkennt das statements-Modul; es gewinnt, außer bei schwachem PDF-/CSV-Treffer gegen sehr
 * eindeutige Dokument-Stichwörter.
 */
export function detectType(extracted, fileMeta) {
  const st = detectStatementFormat(extracted, fileMeta);
  const doc = detectDocumentType(extracted, fileMeta);
  if (st) {
    // Viele erkannte Buchungen: Kontoumsätze, egal welche Stichwörter in den Buchungstexten stehen
    const weak = (st.format === 'pdf_statement' || st.format === 'generic_csv') && (st.confidence ?? 1) < 0.7 && !((st.bookings || 0) >= 8);
    const strongDoc = !['irrelevant', 'finanz_sonstiges'].includes(doc.type) && doc.confidence >= 0.85
      && (scoreTypes(extracted, fileMeta).scores[doc.type] || 0) >= 9;
    if (!(weak && strongDoc)) {
      return { type: 'kontoauszug', subtype: null, institution: null, format: null, confidence: 0.8, signals: [], alternatives: [], ...st };
    }
  }
  return doc;
}
