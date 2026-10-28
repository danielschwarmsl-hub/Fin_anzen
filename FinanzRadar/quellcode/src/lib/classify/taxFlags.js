// Schlanke Steuer-Markierung: nur Flag + Grund, keine Steuerberechnung.
// taxReason ∈ lohn | beruf | versicherung_vorsorge | kapitalertraege | haushalt_handwerker | spenden | gesundheit | kinder_bildung | sonstiges
import { fold } from './merchants.de.js';

export const TAX_REASONS = [
  { id: 'lohn', label: 'Lohn' },
  { id: 'beruf', label: 'Beruf' },
  { id: 'versicherung_vorsorge', label: 'Versicherung & Vorsorge' },
  { id: 'kapitalertraege', label: 'Kapitalerträge' },
  { id: 'haushalt_handwerker', label: 'Haushalt & Handwerker' },
  { id: 'spenden', label: 'Spenden' },
  { id: 'gesundheit', label: 'Gesundheit' },
  { id: 'kinder_bildung', label: 'Kinder & Bildung' },
  { id: 'sonstiges', label: 'Sonstiges' },
];

const NO = { taxRelevant: false, taxReason: null };
const yes = (taxReason) => ({ taxRelevant: true, taxReason });
// 'ai': KI-Markierung bleibt, bis der Nutzer entscheidet (dann taxSource 'user')
const isLocked = (x) => x?.taxSource === 'user' || x?.taxSource === 'rule' || x?.taxSource === 'ai';
const keep = (x) => ({ taxRelevant: !!x.taxRelevant, taxReason: x.taxReason ?? null });

// Stichworte (auf gefaltetem Text)
const KW_HAUSHALT = /(?<![a-z])(?:handwerker|handwerk|reinigung|gebaeudereinigung|fensterreinigung|hausmeister|gartenpflege|gartenarbeit|winterdienst|schornsteinfeger|nebenkostenabrechnung|renovierung|sanierung|elektroinstallation|installateur|sanitaer|klempner|malerarbeiten|maler|tischler|schreiner|dachdecker|montage|wartung|arbeitskosten|lohnkosten|fahrtkosten)(?![a-z])/;
const KW_GESUNDHEIT = /(?<![a-z])(?:[a-z]*arzt|aerzt[a-z]*|apotheke|brille|brillen|optiker|optik|zahnarzt|zahnklinik|zahnreinigung|zahnersatz|physiotherapie|rezept|zuzahlung|krankenhaus|klinik|heilpraktiker|kontaktlinsen|medikament[a-z]*)(?![a-z])/;
const KW_KINDER = /(?<![a-z])(?:kita|kindergarten|schulgeld|hort|krippe|tagesmutter|betreuungsgebuehr[a-z]*|kinderbetreuung|nachhilfe|musikschule|schulessen)(?![a-z])/;
const KW_BERUF = /(?<![a-z])(?:arbeitsmittel|fachbuch|fachbuecher|fortbildung|seminar|weiterbildung|lehrgang|schulung|laptop|notebook|monitor|buerostuhl|schreibtisch|arbeitszimmer|berufskleidung|gewerkschaft|bewerbung|headset|tastatur|buerobedarf|drucker)(?![a-z])/;
const KW_SPENDE = /(?<![a-z])(?:spende|spenden|spendenquittung|zuwendungsbestaetigung)(?![a-z])/;

function docText(doc) {
  const f = doc.fields || {};
  // Kassenbons: nur die erste Zeile (Händler), sonst treffen Warenpositionen wie "Zahncreme"
  const body = doc.type === 'kassenbon' ? String(doc.text || '').split(/\r?\n/, 1)[0].slice(0, 80) : (doc.text || '').slice(0, 4000);
  return fold([doc.title, doc.issuer, doc.institution, doc.subtype, f.purpose, f.productKindLabel, f.productName, body].filter(Boolean).join(' '));
}

/** Steuer-Vorschlag für ein Dokument */
export function flagTaxDocument(doc) {
  if (!doc) return NO;
  if (isLocked(doc)) return keep(doc);
  switch (doc.type) {
    case 'lohn': case 'lohnsteuerbescheinigung': return yes('lohn');
    case 'steuerbescheinigung': return yes('kapitalertraege');
    case 'spende': return yes('spenden');
    case 'versicherung': case 'rente': return yes('versicherung_vorsorge');
    case 'rechnung': case 'kassenbon': case 'vertrag': case 'finanz_sonstiges': {
      if (doc.type === 'rechnung' && doc.fields?.isCraftsman) return yes('haushalt_handwerker');
      const t = docText(doc);
      if (doc.type !== 'vertrag' && KW_HAUSHALT.test(t) && doc.type === 'rechnung') return yes('haushalt_handwerker');
      if (KW_GESUNDHEIT.test(t)) return yes('gesundheit');
      if (KW_KINDER.test(t)) return yes('kinder_bildung');
      if (KW_BERUF.test(t)) return yes('beruf');
      if (KW_SPENDE.test(t)) return yes('spenden');
      return NO;
    }
    default: return NO;
  }
}

// Kategorie → Steuergrund
const BY_SUB = {
  'versicherungen.haftpflicht': 'versicherung_vorsorge', 'versicherungen.bu': 'versicherung_vorsorge', 'versicherungen.unfall': 'versicherung_vorsorge',
  'versicherungen.leben': 'versicherung_vorsorge', 'versicherungen.kranken_zusatz': 'versicherung_vorsorge',
  'vorsorge_sparen.privatrente': 'versicherung_vorsorge', 'vorsorge_sparen.riester_ruerup': 'versicherung_vorsorge', 'vorsorge_sparen.betriebsrente': 'versicherung_vorsorge',
  'steuern_abgaben.kv': 'versicherung_vorsorge', 'steuern_abgaben.pv': 'versicherung_vorsorge', 'steuern_abgaben.rv': 'versicherung_vorsorge', 'steuern_abgaben.av': 'versicherung_vorsorge',
  'steuern_abgaben.kirchensteuer': 'sonstiges', 'steuern_abgaben.kapitalertragsteuer': 'kapitalertraege',
  'einkommen.zinsen': 'kapitalertraege', 'einkommen.dividenden': 'kapitalertraege', 'einkommen.rente': 'sonstiges',
  'wohnen.handwerker': 'haushalt_handwerker', 'wohnen.nebenkosten': 'haushalt_handwerker',
  'gesundheit.apotheke': 'gesundheit', 'gesundheit.arzt': 'gesundheit', 'gesundheit.zahnarzt': 'gesundheit', 'gesundheit.brille': 'gesundheit', 'gesundheit.krankenkasse': 'gesundheit',
  'beruf.arbeitsmittel': 'beruf', 'beruf.fortbildung': 'beruf', 'beruf.gewerkschaft': 'beruf', 'beruf.kinderbetreuung': 'kinder_bildung', 'beruf.schule': 'kinder_bildung',
};

/** Steuer-Vorschlag für eine Buchung */
export function flagTaxTransaction(tx) {
  if (!tx) return NO;
  if (isLocked(tx)) return keep(tx);
  if (tx.isTransfer || tx.category === 'umbuchung') return NO;
  if (tx.category === 'spenden') return yes('spenden');
  const sub = BY_SUB[`${tx.category}.${tx.subcategory}`];
  if (sub) return yes(sub);
  if (tx.category === 'gesundheit') return yes('gesundheit');
  if (tx.amount < 0) {
    const t = fold(`${tx.purpose || ''} ${tx.counterparty || ''}`);
    if (KW_BERUF.test(t)) return yes('beruf');
    if (KW_SPENDE.test(t)) return yes('spenden');
    if (/(?<![a-z])(?:hausmeister|gartenpflege|schornsteinfeger|reinigung|handwerker|nebenkostenabrechnung)(?![a-z])/.test(t)) return yes('haushalt_handwerker');
  }
  return NO;
}
