// Dokumenttyp-Erkennung: erst Kontoauszug/Umsatzformate (statements-Modul), dann Stichwort-Scoring.
import { detectStatementFormat } from '../parsers/docs/_statements.js';
import { STORES, INSURERS, PROVIDERS, matchFirst } from '../parsers/docs/known.js';

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
    [/kassenbon|kassenbeleg/, 7], [/bon-?\s?nr/, 4], [/\btse\b|signaturzaehler|tse-transaktion|tse-signatur/, 6],
    [/kartenzahlung|girocard|ec-karte|barzahlung|ruckgeld|rueckgeld|\bgegeben\b/, 2], [/summe\s+(?:eur|€)/, 3],
    [/code\s+satz\s+netto/, 4], [/\bkasse\s+\d+/, 2], [/vielen dank fuer ihren einkauf/, 3], [/ust-?\s?id/, 0.5],
    [/mwst\s+(?:brutto|netto)/, 1],
  ],
  rechnung: [
    [/\brechnung\b/, 3], [/rechnungs-?\s?(?:nummer|nr)\b/, 5], [/rechnungsdatum/, 3], [/rechnungsbetrag/, 3.5], [/\binvoice\b/, 3],
    [/ust-?\s?id|umsatzsteuer-?id|steuernummer/, 1], [/nettobetrag|summe netto|zzgl\.?\s*\d+\s*%|\d+\s*%\s*(?:mwst|ust|umsatzsteuer)/, 2.5],
    [/zahlbar|faellig|zahlungsziel|zahlungsbedingung/, 2], [/gesamtbetrag|endbetrag/, 1.5], [/leistungszeitraum|lieferdatum/, 1],
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
];

const GROCERY = ['milch', 'brot', 'eier', 'butter', 'kaese', 'aepfel', 'apfel', 'bananen', 'kaffee', 'zahnpasta', 'nudeln', 'reis', 'mehl',
  'zucker', 'joghurt', 'tomaten', 'kartoffeln', 'gurke', 'wasser', 'bier', 'wurst', 'schinken', 'salat', 'zwiebeln', 'obst', 'gemuese',
  'haferflocken', 'muesli', 'broetchen', 'quark', 'sahne', 'toilettenpapier', 'spuelmittel', 'orangensaft', 'honig'];
const FINANCE_WORDS = ['betrag', 'summe', 'iban', 'konto', 'saldo', 'beitrag', 'steuer', 'euro', 'zahlung', 'mwst', 'umsatz', 'brutto',
  'netto', 'rechnung', 'versicherung', 'gehalt', 'bank', 'vertrag', 'gebuehr', 'kosten', 'preis'];
const MONEY = /\d+[.,]\d{2}(?!\d)/;

const unique = (a) => [...new Set(a)];

/** Punkte je Typ + Treffer-Signale. */
export function scoreTypes(extracted, fileMeta) {
  const text = normalize(extracted?.text || extracted?.rawText || '');
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

  // Kassenbon: kurzes Bildlayout mit Beträgen (nur zusätzlich zu echten Bon-Signalen)
  const lineCount = text ? text.split('\n').filter((l) => l.trim()).length : 0;
  if ((scores.kassenbon || 0) > 0 && extracted?.kind === 'image' && lineCount < 70) add('kassenbon', 1.5, 'Bildbeleg');

  // E-Rechnung im XML
  const xml = extracted?.xml || '';
  if (/CrossIndustryInvoice/.test(xml)) add('rechnung', 30, 'ZUGFeRD/CII');
  else if (/<(?:\w+:)?Invoice[\s>]|urn:oasis:names:specification:ubl:schema:xsd:Invoice/.test(xml)) add('rechnung', 30, 'XRechnung/UBL');

  // Einkaufszettel: kurze Liste von Lebensmitteln ohne Preise (keine Rezepte)
  const isRecipe = /rezept|zutaten|zubereitung|backofen|minuten (?:kochen|backen)/.test(text);
  const grocery = unique(GROCERY.filter((g) => new RegExp(`(?<![a-z])${g}`).test(text)));
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

function institutionFor(type, text, extracted) {
  const raw = String(extracted?.text || '');
  const head = raw.split('\n').slice(0, 10).join('\n');
  if (type === 'kassenbon') return matchFirst(STORES, head);
  if (type === 'versicherung' || type === 'rente') return matchFirst(INSURERS, head) || matchFirst(INSURERS, raw);
  if (type === 'vertrag') return PROVIDERS.find((p) => raw.includes(p)) || null;
  return null;
}

function subtypeFor(type, extracted, signals) {
  if (type === 'rechnung') {
    if (/CrossIndustryInvoice/.test(extracted?.xml || '')) return 'zugferd';
    if (/Invoice/.test(extracted?.xml || '')) return 'xrechnung';
    return extracted?.ocr ? 'scan' : null;
  }
  if (type === 'versicherung') {
    const s = (signals || []).join(' ');
    return /berufsunf/.test(s) ? 'bu' : /haftpflicht/.test(s) ? 'haftpflicht' : /hausrat/.test(s) ? 'hausrat' : /kfz|kasko/.test(s) ? 'kfz' : null;
  }
  return null;
}

const det = (type, o = {}) => ({ type, subtype: null, institution: null, format: null, confidence: 0.5, signals: [], ...o });

/** Nur Dokument-Erkennung (ohne Kontoauszug-Formate) – synchron, DOM-frei. */
export function detectDocumentType(extracted, fileMeta) {
  const kind = extracted?.kind;
  const rawText = String(extracted?.text || extracted?.rawText || '');
  if (kind === 'unsupported') return det('irrelevant', { subtype: 'unsupported', confidence: 0.6, signals: ['nicht unterstütztes Format'] });
  if (!extracted?.xml && rawText.replace(/\s+/g, '').length < 12) {
    const nm = normalize(fileMeta?.name);
    if (/einkauf/.test(nm)) return det('einkaufszettel', { confidence: 0.4, signals: ['Dateiname:einkauf'] });
    return det('irrelevant', { subtype: kind === 'image' ? 'kein_text' : 'leer', confidence: kind === 'image' ? 0.8 : 0.7, signals: [kind === 'image' ? 'Bild ohne erkennbaren Text' : 'kein Text'] });
  }
  const { scores, signals, text } = scoreTypes(extracted, fileMeta);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, top] = ranked[0] || [null, 0];
  const second = ranked[1]?.[1] || 0;

  if (bestType && top >= 4) {
    // Abgrenzung: Lohnsteuerbescheinigung enthält auch Lohn-Stichwörter, Standmitteilung auch Versicherungs-Stichwörter
    return det(bestType, {
      subtype: subtypeFor(bestType, extracted, signals[bestType]),
      institution: institutionFor(bestType, text, extracted),
      confidence: confidenceFor(top, second), signals: unique(signals[bestType] || []),
    });
  }
  const fin = unique(FINANCE_WORDS.filter((w) => new RegExp(`(?<![a-z])${w}`).test(text)));
  if (fin.length >= 2 || (bestType && top >= 2.5)) {
    return det('finanz_sonstiges', { confidence: Math.min(0.6, 0.3 + fin.length * 0.06), signals: unique([...(signals[bestType] || []), ...fin]) });
  }
  return det('irrelevant', { subtype: 'kein_finanzbezug', confidence: text.length > 40 ? 0.8 : 0.6, signals: fin });
}

/**
 * detectType(extracted, fileMeta) → Detection { type, subtype, institution, format, confidence, signals }.
 * Kontoauszüge/Umsatzdateien erkennt das statements-Modul; es gewinnt, außer bei schwachem PDF-/CSV-Treffer gegen sehr
 * eindeutige Dokument-Stichwörter.
 */
export function detectType(extracted, fileMeta) {
  const st = detectStatementFormat(extracted, fileMeta);
  const doc = detectDocumentType(extracted, fileMeta);
  if (st) {
    const weak = (st.format === 'pdf_statement' || st.format === 'generic_csv') && (st.confidence ?? 1) < 0.7;
    const strongDoc = !['irrelevant', 'finanz_sonstiges'].includes(doc.type) && doc.confidence >= 0.85
      && (scoreTypes(extracted, fileMeta).scores[doc.type] || 0) >= 9;
    if (!(weak && strongDoc)) {
      return { type: 'kontoauszug', subtype: null, institution: null, format: null, confidence: 0.8, signals: [], ...st };
    }
  }
  return doc;
}
