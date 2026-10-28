// Gegenpartei-Normalisierung: Anzeigename aus Rohtext, Zahlungsdienstleister auflösen.
// resolveCounterparty(tx) → { name, intermediary }   normalizeCounterparty(tx) → name

const LEGAL = [
  /\bGmbH\s*&\s*Co\.?\s*(?:KGaA|KG|OHG)?\b\.?/gi,
  /\bS\.?\s?[aà]\.?\s?r\.?\s?l\.?(?![\w])(?:\s*et\s*Cie\.?)?(?:\s*S\.?\s?C\.?\s?[AÀ]\.?)?/gi,
  /\bet\s+Cie\.?(?:\s*S\.?\s?C\.?\s?A\.?)?/gi,
  /\bS\.C\.A\.?(?![\w])/g,
  /\b(?:GmbH|mbH|gGmbH|Ltd\.?|Limited|Inc\.?|LLC|LLP|PLC|B\.\s?V\.|N\.\s?V\.|S\.\s?A\.|SARL|S\.\s?p\.\s?A\.|e\.\s?K\.|e\.\s?V\.|GbR|Corp\.?|UG\s*\(haftungsbeschränkt\))(?=[\s,.;)]|$)/gi,
  /(?<![-\w])(?:AG|SE|KG|KGaA|OHG|UG|eG|AB|AS|SAS|A\/S|ApS|Oy|Co\.|PartG(?:mbB)?)(?=[\s,.;)]|$)/g,
];

// Rauschen aus Kartenzahlungen u. Ä.
const NOISE = [
  /\b(?:VISA\s+|Mastercard\s+)?(?:Debit|Kredit)kartenumsatz(?:\s+vom)?\b/gi, /\bVISA\s+Debitkarte\b/gi, /\bMastercard(?:\s+Debitkarte)?\b/gi, /\bgirocard\b/gi, /\bDebitkarte\b/gi, /\bKreditkarte\b/gi, /\bKAUFUMSATZ\b/gi,
  /\bKartenzahlung\b/gi, /\bKARTENZAHLUNG\b/g, /\bSAGT\s+DANKE\b/gi, /\bvielen\s+dank\b/gi, /\bNR\s*X{2,}\d*\b/gi, /\bX{4,}\d*\b/gi, /\*{2,}\d*/g,
  /\b(?:Terminal|TA|Trace|Beleg|Belegnr|Bon)\s*[-.:]?\s*(?:Nr\.?)?\s*\d+\b/gi, /\bEC[- ]?Karte\b/gi, /\bLastschrift\b/gi, /\bOnline[- ]?Shopping\b/gi,
  /(?<=\S\s)VISA\s*$/g, /\bKd\.?-?\s*Nr\.?\s*\S*/gi, /\bKundennummer\s*\S*/gi, /\bMandat(?:s(?:referenz)?)?\s*\S*/gi, /\bREF[:.]?\s*\S+/g,
];
// Kartenzahlung bei comdirect/Sparkasse & Co.: "… KARTE 4999 2026-10-14 KURS 1,0000 …" – ab "KARTE <Nr>" folgt nur Rauschen
const CARD_TAIL = /\s+KARTE\s+(?:NR\.?\s*)?[\dX*]{3,}\b.*$/i;
const ISO_STAMP = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?\b|(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)|\bKURS\s+[\d.,]+|\bDebitk\.?(?![a-zäöü])\s*\d*/gi;
const DATE = /(?<!\d)\d{1,2}\.\d{1,2}\.(?:\d{2,4})?(?!\d)/g;
const LONGNUM = /\b\d{6,}\b/g;

// Bekannte Städte/Stadtteile am Ende des Händlernamens (kleine Auswahl, Rest über Heuristik)
const CITY_TAIL = /\s+(?:Hamburg|Berlin|München|Muenchen|Köln|Koeln|Frankfurt|Stuttgart|Düsseldorf|Duesseldorf|Dortmund|Essen|Leipzig|Bremen|Dresden|Hannover|Nürnberg|Nuernberg|Bonn|Münster|Muenster|Karlsruhe|Mannheim|Augsburg|Wiesbaden|Kiel|Lübeck|Luebeck|Musterstadt)(?:[-\s][\wäöüÄÖÜß-]+)?$/i;

/** SCREAMING CASE → Title Case; gemischte Schreibung bleibt */
export function titleCase(s) {
  if (!s) return s;
  const letters = s.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
  if (letters.length < 3) return s;
  const upper = letters.replace(/[^A-ZÄÖÜ]/g, '').length;
  if (upper / letters.length < 0.8) return s;
  return s.toLowerCase().replace(/(^|[\s\-/(.&])([a-zäöüß])/g, (_, a, b) => a + b.toUpperCase())
    .replace(/\b(?:Gmbh|Ag|Se|Kg|Ohg|Ug|Ev|Eg|Dm|Dkb|Ing|Hvv|Bvg|Mvv|Db|Dhl|Dpd|Ups|Adac|Tui|Kfc|Ard|Zdf|Rwe|Huk|Axa|Dkv|Pp)\b/g, m => m.toUpperCase().replace('GMBH', 'GmbH'));
}

function stripLegal(s) {
  let out = s;
  for (const re of LEGAL) out = out.replace(re, ' ');
  return out;
}

function stripNoise(s) {
  let out = s.replace(CARD_TAIL, '');
  for (const re of NOISE) out = out.replace(re, ' ');
  return out.replace(ISO_STAMP, ' ').replace(DATE, ' ').replace(LONGNUM, ' ').replace(/(^|\s)\.(?=\s|$)/g, ' ');
}

/** Aufräumen: Doppelzeichen, Satzzeichen an Rändern */
function tidy(s) {
  return s.replace(/\s*\/\/+\s*/g, ' ').replace(/[|;]+/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s,.:\-–*/&+]+|[\s,.:\-–*/&+]+$/g, '').trim();
}

/** Ein Händlername, wenn derselbe Teil zweimal hintereinander steht ("REWE Markt Hamburg REWE Markt Hamburg") */
function dedupeRepeat(s) {
  const w = s.split(' ');
  for (let n = 1; n <= Math.floor(w.length / 2); n++) {
    if (w.slice(0, n).join(' ').toLowerCase() === w.slice(n, 2 * n).join(' ').toLowerCase()) return w.slice(0, n).join(' ');
  }
  // Name + Ort/Zusatz + Name wiederholt: "REWE Markt Hamburg-Eimsbüttel REWE Markt" → "REWE Markt"
  for (let m = Math.floor(w.length / 2); m >= 2; m--) {
    if (w.slice(0, m).join(' ').toLowerCase() === w.slice(w.length - m).join(' ').toLowerCase()) return w.slice(0, m).join(' ');
  }
  return s;
}

function cleanName(raw, card = false) {
  let s = String(raw || '').replace(/ /g, ' ');
  s = stripNoise(s);
  s = stripLegal(s);
  s = tidy(s);
  const dropCardNumbers = () => { if (card) s = s.replace(/(?:\s+(?:NR\.?|X{3,}|\*{2,}|\d{3,}))+\s*$/i, '') || s; };
  dropCardNumbers();
  const dropCity = () => {
    if (!card) return;
    const noCity = s.replace(CITY_TAIL, '');
    if (noCity && noCity.length >= 3) { s = noCity; dropCardNumbers(); }
  };
  // Stadt am Ende entfernen, solange noch Name übrig bleibt (vor und nach dem Zusammenfassen doppelter Namen)
  dropCity();
  s = dedupeRepeat(s);
  dropCity();
  return titleCase(tidy(s));
}

// ---------------------------------------------------------------- Zahlungsdienstleister
const RX_PAYPAL = /paypal/i;
const RX_PP_REF = /PP\.\s?\d+\.\s?PP\s*\.?\s*/i;
const RX_EINKAUF = /(?:Ihr\s+Einkauf\s+bei|Your\s+purchase\s+(?:at|from)|Zahlung\s+an|Payment\s+to)\s+(.+?)\s*$/i;

/** Händler aus PayPal-Lastschrift-Zweck: "1234 PP.1234.PP . ABC Shop, Ihr Einkauf bei ABC Shop" */
function paypalMerchant(purpose) {
  const p = String(purpose || '').replace(/\s+/g, ' ').trim();
  let m = RX_EINKAUF.exec(p);
  if (m) return m[1];
  const i = p.search(RX_PP_REF);
  if (i >= 0) {
    let rest = p.slice(i).replace(RX_PP_REF, '');
    rest = rest.split(/,\s*(?:Ihr|Your)\b/i)[0].split(/\s*(?:Ihr Einkauf bei|Your purchase at)\b/i)[0].split(',')[0].replace(/^[\s./,]+|[\s./,]+$/g, '');
    if (rest && /[a-z]{2}/i.test(rest) && !/^paypal\b/i.test(rest)) return rest;
  }
  return null;
}

/** "SumUp *Cafe X" | "SUMUP  *CAFE X" | "SQ *Kiosk" */
const RX_SUMUP = /\b(?:sum\s?up|sq|zettle_?\*?|izettle|payone)\s*\*+\s*([^*]+)/i;
const RX_AMAZON = /\b(?:amazon\s+payments|amzn\s+mktp|amazon\.[a-z]{2,3}|amazon\s+eu|amzn\.com|amazon\s+marketplace|amazon\s+prime|amazon\s+digital|amazon)\b/i;
const RX_KLARNA = /\bklarna\b/i;

/**
 * Normalisierter Anzeigename + ggf. Zwischenhändler.
 * @returns {{ name: string, intermediary: string|null }}
 */
export function resolveCounterparty(tx) {
  const raw = String(tx.counterpartyRaw ?? tx.counterparty ?? '').trim();
  const purpose = String(tx.purpose || '');
  const hay = `${raw} ${purpose}`;

  // PayPal-Bankeinzug auf dem Bankkonto
  if (RX_PAYPAL.test(raw) && !/aufladung|auszahlung/i.test(raw)) {
    const merchant = paypalMerchant(purpose);
    if (merchant) return { name: cleanName(merchant) || 'PayPal', intermediary: 'PayPal' };
    return { name: 'PayPal', intermediary: 'PayPal' };
  }
  // SumUp / Square etc.
  const sum = RX_SUMUP.exec(raw) || RX_SUMUP.exec(purpose);
  if (sum && !/^\s*$/.test(sum[1])) {
    const via = /sum\s?up/i.test(sum[0]) ? 'SumUp' : /zettle/i.test(sum[0]) ? 'Zettle' : /payone/i.test(sum[0]) ? 'Payone' : 'Square';
    return { name: cleanName(sum[1]) || via, intermediary: via };
  }
  // Klarna: Händler aus "Einkauf bei X"
  if (RX_KLARNA.test(raw)) {
    const m = RX_EINKAUF.exec(purpose.replace(/\s+/g, ' ').trim());
    if (m) return { name: cleanName(m[1]) || 'Klarna', intermediary: 'Klarna' };
    return { name: 'Klarna', intermediary: 'Klarna' };
  }
  // Amazon Payments / AMZN Mktp → Amazon
  if (RX_AMAZON.test(raw) || (/^amzn\b/i.test(raw))) return { name: 'Amazon', intermediary: /payments/i.test(hay) ? 'Amazon Payments' : null };
  if (!raw && /amzn\s+mktp|amazon\s+payments/i.test(purpose)) return { name: 'Amazon', intermediary: 'Amazon Payments' };

  const card = /karte|debitkarte|kaufumsatz|girocard/i.test(`${tx.bookingText || ''} ${purpose}`);
  const name = cleanName(raw, card);
  if (name) return { name, intermediary: null };
  // Kein Name vorhanden (z. B. Gutschrift ohne Auftraggeber): Rohtext kürzen
  return { name: cleanName(purpose).slice(0, 40) || raw, intermediary: null };
}

// Namen, die keinen Händler bezeichnen (Zahlungsdienste, Kartenarten, Buchungsarten): taugen weder für „ähnliche Buchungen“
// noch als Regel-Muster – „PayPal“ steht vor hunderten verschiedenen Händlern.
const GENERIC_NAMES = new Set(['paypal', 'paypal europe', 'klarna', 'sofort', 'amazon', 'amazon payments', 'amazon pay', 'amzn', 'sumup', 'zettle',
  'square', 'payone', 'stripe', 'adyen', 'mollie', 'unzer', 'computop', 'wirecard', 'ratepay', 'riverty', 'afterpay', 'google', 'google pay',
  'apple', 'apple pay', 'visa', 'mastercard', 'maestro', 'girocard', 'debitkarte', 'kreditkarte', 'kartenzahlung', 'lastschrift', 'ueberweisung',
  'gutschrift', 'dauerauftrag', 'eigenes konto', 'bargeld', 'geldautomat', 'bargeldauszahlung', 'auszahlung', 'einzahlung', 'unbekannt']);
export function isGenericCounterparty(name) {
  const f = String(name || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  if (f.length < 3) return true;
  if (GENERIC_NAMES.has(f)) return true;
  return /^(?:paypal|klarna|eigenes konto|visa|mastercard)\b/.test(f) && f.split(' ').length <= 3;
}

export function normalizeCounterparty(tx) {
  return resolveCounterparty(tx).name;
}
