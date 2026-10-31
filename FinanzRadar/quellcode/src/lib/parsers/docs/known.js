// Bekannte Aussteller (Händler, Versicherer, Anbieter) – für Erkennung und Parser.
export const STORES = [
  ['REWE', /\brewe\b/i], ['EDEKA', /\bedeka\b/i], ['ALDI', /\baldi\b/i], ['LIDL', /\blidl\b/i],
  ['dm', /\bdm[- ]drogerie|\bdm\b/i], ['Rossmann', /\brossmann\b/i], ['Penny', /\bpenny\b/i],
  ['Netto', /\bnetto marken|\bnetto\b(?!\s*(?:eur|mwst|betrag))/i], ['Kaufland', /\bkaufland\b/i], ['Real', /\breal,?\s*-/i],
  ['Globus', /\bglobus\b/i], ['Norma', /\bnorma\b/i], ['Tegut', /\btegut\b/i], ['Budni', /\bbudni\b/i],
  ['Müller', /\bm[uü]ller\s+(?:drogerie|markt)/i], ['Famila', /\bfamila\b/i], ['Marktkauf', /\bmarktkauf\b/i],
  ['Alnatura', /\balnatura\b/i], ['Denns', /\bdenn'?s\b/i], ['Shell', /\bshell\b/i], ['Aral', /\baral\b/i],
  ['Esso', /\besso\b/i], ['Jet', /\bjet tankstelle/i], ['Bäckerei', /\bb[aä]ckerei\b/i],
];

// [Anzeigename/Institution, Muster]
export const INSURERS = [
  ['Allianz', /\ballianz\b/i], ['Alte Leipziger', /\balte leipziger\b/i], ['HUK-Coburg', /\bhuk[- ]?(?:coburg|24)?\b/i],
  ['AXA', /\baxa\b/i], ['Generali', /\bgenerali\b/i], ['ERGO', /\bergo\b/i], ['R+V', /\br\s?\+\s?v\b/i],
  ['Debeka', /\bdebeka\b/i], ['Signal Iduna', /\bsignal iduna\b/i], ['LV 1871', /\blv 1871\b/i], ['HDI', /\bhdi\b/i],
  ['Zurich', /\bzurich\b/i], ['Swiss Life', /\bswiss life\b/i], ['Canada Life', /\bcanada life\b/i],
  ['Deutsche Rentenversicherung', /\bdeutsche rentenversicherung\b/i], ['Gothaer', /\bgothaer\b/i],
  ['Nürnberger', /\bn[uü]rnberger\b/i], ['Württembergische', /\bw[uü]rttembergische\b/i], ['Barmenia', /\bbarmenia\b/i],
  ['DEVK', /\bdevk\b/i], ['Concordia', /\bconcordia\b/i], ['Volkswohl Bund', /\bvolkswohl\b/i],
  ['Continentale', /\bcontinentale\b/i], ['Hannoversche', /\bhannoversche\b/i], ['Cosmos Direkt', /\bcosmos ?direkt\b/i],
  ['Techniker Krankenkasse', /\btechniker krankenkasse\b/i], ['AOK', /\baok\b/i], ['Barmer', /\bbarmer\b/i],
];

export const PROVIDERS = [
  'Netflix', 'Spotify', 'Amazon Prime', 'Disney+', 'DAZN', 'Sky', 'Apple', 'YouTube Premium', 'Audible', 
  'Vodafone', 'Telekom', 'O2', '1&1', 'Congstar', 'Strato', 'McFit', 'FitX', 'Urban Sports Club', 'Fitness First',
  'ADAC', 'Spiegel', 'Dropbox', 'Microsoft', 'Google', 'Adobe', 'Paramount+', 'RTL+', 'Deezer',
];

// Banken/Broker für Wertpapier-Dokumente. Reihenfolge zählt: comdirect ist „eine Marke der Commerzbank AG“,
// OCR liest den Namen gern als „comdırect“ oder „COomdırec“.
export const BROKERS = [
  ['comdirect', /\bco\s?o?m\s?d[iı]\s?rec/i], ['MLP', /\bmlp\b/i], ['Trade Republic', /\btrade\s?republic\b/i],
  ['Scalable Capital', /\bscalable\b/i], ['Smartbroker', /\bsmartbroker\b/i], ['flatex', /\bflatex/i],
  ['DEGIRO', /\bdegiro\b/i], ['onvista', /\bonvista\b/i], ['Consorsbank', /\bconsors\s?bank\b|\bcortal consors\b/i],
  ['DKB', /\bdkb\b|deutsche kreditbank/i], ['justTRADE', /\bjusttrade\b/i], ['finanzen.net zero', /\bfinanzen\.net zero\b/i],
  ['maxblue', /\bmaxblue\b/i], ['S Broker', /\bs\s?broker\b/i], ['1822direkt', /\b1822\s?direkt\b/i], ['DADAT', /\bdadat\b/i],
  ['Baader Bank', /\bbaader\b/i], ['ebase', /\bebase\b/i], ['FIL Fondsbank', /\bfil fondsbank\b|\bfidelity\b/i],
  ['fondsdepot bank', /\bfondsdepot bank\b/i], ['Union Investment', /\bunion investment\b/i], ['DWS', /\bdws\b/i],
  ['Deka', /\bdeka(?:bank)?\b/i], ['Targobank', /\btargo\s?bank\b/i], ['Postbank', /\bpostbank\b/i],
  ['Deutsche Bank', /\bdeutsche bank\b/i], ['Commerzbank', /\bcommerzbank\b/i], ['HypoVereinsbank', /\bhypovereinsbank\b/i],
  ['Sparkasse', /\bsparkasse\b/i], ['Volksbank', /\bvolksbank\b|\braiffeisenbank\b/i], ['ING', /\bING(?:-DiBa)?\b/],
];

export function matchFirst(list, text) {
  for (const [name, re] of list) if (re.test(text)) return name;
  return null;
}
