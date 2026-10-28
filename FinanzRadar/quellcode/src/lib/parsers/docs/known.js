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

export function matchFirst(list, text) {
  for (const [name, re] of list) if (re.test(text)) return name;
  return null;
}
