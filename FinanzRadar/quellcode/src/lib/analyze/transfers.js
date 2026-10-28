// Umbuchungen erkennen: eigene Konten, PayPal-Aufladungen und -Einzüge, Kreditkartenausgleich, Depot-Käufe.
// detectTransfers(txs, accounts) → Buchungen mit isTransfer / transferPairId / transferAccountId / transferConfidence.
// Idempotent: automatisch gesetzte Markierungen (transferSource 'auto') werden bei jedem Lauf neu berechnet,
// Parser-Markierungen bleiben, Nutzerentscheidungen (categorySource 'user' bzw. transferSource 'user') werden nie geändert.
// Außerdem: detectStornos (Zahlung + gleich hohe Gutschrift desselben Händlers) und computeFlowChecks (Prüfliste).
import { normalizeIban } from '../util/format.js';
import { fold } from '../classify/merchants.de.js';

export const PAYPAL_CREDITOR_ID = 'LU96ZZZ0000000000000000058';
const WINDOW = 5; // Tage

const EVIDENCE = /umbuchung|uebertrag|eigenes konto|eigene konten|tagesgeld|festgeld|sparen|sparplan|aufladung|ausgleich|verrechnungskonto|kreditkarte|geldanlage|rueckueberweisung|auszahlung paypal/;
const CARD_SETTLEMENT = /kreditkartenabrechnung|ausgleich kreditkarte|kartenabrechnung|kk abrechnung|abrechnung kreditkarte|visa abrechnung|mastercard abrechnung/;
const PAYPAL_DEBIT_ROW = /einzugsverfahren|direct debit|zahlung per lastschrift|bank ?einzug zahlung/;
// Wertpapierhandel (Depot-Umsatz bzw. Giro-Seite eines Kaufs/Sparplans) – gefalteter Text
const TRADE = /wertpapierkauf|wertpapierverkauf|wertpapier kauf|wertpapier verkauf|wp kauf|wp verkauf|wp abrechnung|sparplanausfuehrung|sparplan ausfuehrung|ausfuehrung sparplan/;
const DEPOT_HINT = /wertpapier|depot|sparplan|wp kauf|verrechnungskonto|trade republic|scalable|consorsbank|flatex|onvista|smartbroker|justtrade|baader/;
const MIX_STOP = new Set(['paypal', 'europe', 'sarl', 'zahlung', 'einkauf', 'gmbh', 'lastschrift', 'payment', 'express', 'checkout']);
const REFUND = /rueckerstattung|erstattung|refund|storno|retoure|rueckzahlung|gutschrift|ruecklastschrift|rueckbuchung|zurueck/;
const STORNO_WINDOW = 60; // Tage
const FLOW_KINDS = new Set(['transfer', 'paypal', 'depot', 'storno']);

const dayCache = new Map();
function dayNum(iso) {
  let d = dayCache.get(iso);
  if (d === undefined) { d = Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5); dayCache.set(iso, d); }
  return d;
}

/** Sichere Umbuchung: mittel sichere, unbestätigte Paare bleiben für Steuer-Flag und USt-Schätzung sichtbar. */
export function isFirmTransfer(t) {
  return !!t?.isTransfer && !(t.transferConfidence === 'medium' && t.transferSource !== 'user');
}
/** Wertpapierkauf/-verkauf bzw. Sparplanausführung (Giro- oder Depotseite) */
export function isSecuritiesTrade(t) {
  return TRADE.test(fold(`${t?.bookingText || ''} ${t?.purpose || ''}`));
}
/** Lastschrift von PayPal auf einem Bankkonto */
export function isPaypalBankDebit(t) {
  return t.amount < 0 && (t.creditorId === PAYPAL_CREDITOR_ID || /paypal/.test(fold(`${t.counterpartyRaw || ''} ${t.counterparty || ''}`)));
}

export function detectTransfers(txs, accounts = []) {
  const accById = new Map(accounts.map(a => [a.id, a]));
  const ibanToAcc = new Map();
  for (const a of accounts) { const i = normalizeIban(a.iban); if (i) ibanToAcc.set(i, a); }

  // Arbeitskopien (nur geänderte Objekte werden am Ende ersetzt)
  const work = txs.map(t => {
    const locked = t.categorySource === 'user' || t.transferSource === 'user';
    let isTransfer = !!t.isTransfer;
    let source = t.transferSource || null;
    let pair = t.transferPairId || null, targetAcc = t.transferAccountId || null;
    let conf = t.transferConfidence || null;
    if (!locked) {
      if (isTransfer && !source) source = t.transferPairId ? 'auto' : 'parser';
      if (source === 'auto') { isTransfer = false; pair = null; targetAcc = null; source = null; conf = null; }
      if (source === 'parser') { pair = null; targetAcc = null; conf = 'high'; }
    }
    return {
      t, locked, isTransfer, source, pair, targetAcc, conf, funded: 0, half: false,
      day: t.bookingDate ? dayNum(t.bookingDate) : null,
      cp: fold(`${t.counterpartyRaw || ''} ${t.counterparty || ''}`),
      text: fold(`${t.purpose || ''} ${t.bookingText || ''} ${t.counterpartyRaw || ''} ${t.counterparty || ''}`),
      acc: accById.get(t.accountId) || null,
    };
  });
  // Nutzerseite mit automatisch verknüpfter Gegenseite: Paar wird wie diese neu gesucht (sonst ginge es nach einem Lauf verloren)
  const byId = new Map(work.map(w => [w.t.id, w]));
  for (const w of work) if (w.locked && w.pair && !byId.get(w.pair)?.locked) w.pair = null;
  const free = (w) => !w.pair && !w.half && w.day != null && w.t.accountId && !(w.locked && !w.isTransfer);
  const userSide = (w) => w.locked && w.isTransfer;

  const link = (a, b, conf = 'high') => {
    a.pair = b.t.id; b.pair = a.t.id;
    a.targetAcc = b.t.accountId; b.targetAcc = a.t.accountId;
    for (const w of [a, b]) { if (!w.locked) { w.isTransfer = true; if (w.source !== 'parser') w.source = 'auto'; w.conf = conf; } }
  };
  // Halbe Verknüpfung (PayPal-Einzug): nur die Bankseite ist Gegenbuchung, die PayPal-Zahlung mit Händler zählt
  const linkHalf = (bank, pp) => {
    bank.pair = pp.t.id; bank.targetAcc = pp.t.accountId;
    if (!bank.locked) { bank.isTransfer = true; bank.source = 'auto'; bank.conf = 'high'; }
    pp.funded += -bank.t.amount; pp.half = true;
  };

  const kindOf = (w) => w.acc?.kind;

  // Kandidaten nach Betrag gruppieren: Map<abs(Cent), {neg:[], pos:[]}>
  const groups = new Map();
  for (const w of work) {
    if (!free(w) || !w.t.amount) continue;
    const k = Math.abs(w.t.amount);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { neg: [], pos: [] });
    (w.t.amount < 0 ? g.neg : g.pos).push(w);
  }

  const candidates = [];
  const push = (a, b, score, conf = 'high', half = false) => candidates.push({ a, b, score, conf, half });

  for (const g of groups.values()) {
    // (c) PayPal: Bank-Lastschrift ↔ PayPal-Aufladung (Bankeinzug)
    for (const bank of g.neg) {
      if (kindOf(bank) === 'paypal') continue;
      const isPaypalDebit = bank.t.creditorId === PAYPAL_CREDITOR_ID || /paypal/.test(bank.cp);
      for (const pp of g.pos) {
        if (kindOf(pp) !== 'paypal') continue;
        const dd = Math.abs(bank.day - pp.day);
        if (dd > WINDOW) continue;
        const funding = /bankeinzug/i.test(pp.t.bookingText || '') || (pp.t.isTransfer && pp.source === 'parser');
        if (isPaypalDebit && funding) push(bank, pp, 300 - dd * 10);
        else if (kindOf(pp) === 'paypal' && funding && /paypal/.test(bank.text)) push(bank, pp, 280 - dd * 10);
      }
    }
    // PayPal-Auszahlung auf das Bankkonto: PayPal-Abfluss (Bankeinzug) ↔ Gutschrift auf dem Konto
    for (const pp of g.neg) {
      if (kindOf(pp) !== 'paypal' || !/bankeinzug/i.test(pp.t.bookingText || '')) continue;
      for (const bank of g.pos) {
        if (kindOf(bank) === 'paypal') continue;
        const dd = Math.abs(bank.day - pp.day);
        if (dd <= WINDOW && /paypal/.test(bank.text)) push(bank, pp, 290 - dd * 10);
      }
    }
    // PayPal-Zahlung im Einzugsverfahren: Bank-Lastschrift = Zahlung auf dem PayPal-Konto (gleiches Vorzeichen).
    // Dann zählt die PayPal-Buchung (mit Händler), die Bankbuchung ist die Gegenbuchung.
    // Gibt es dazu eine eigene Zahlungszeile (Zwilling), ist die Einzugs-Zeile nur ein Hinweis und zählt ebenfalls nicht.
    for (const bank of g.neg) {
      if (kindOf(bank) === 'paypal' || !(bank.t.creditorId === PAYPAL_CREDITOR_ID || /paypal/.test(bank.cp))) continue;
      for (const pp of g.neg) {
        if (kindOf(pp) !== 'paypal' || !PAYPAL_DEBIT_ROW.test(fold(pp.t.bookingText || ''))) continue;
        const dd = Math.abs(bank.day - pp.day);
        if (dd > WINDOW) continue;
        const twin = g.neg.some(o => o !== pp && o.t.accountId === pp.t.accountId && Math.abs(o.day - pp.day) <= 1
          && !PAYPAL_DEBIT_ROW.test(fold(o.t.bookingText || '')) && !/bankeinzug/i.test(o.t.bookingText || ''));
        push(bank, pp, 260 - dd * 10, 'high', !twin);
      }
    }
    // Depot: Wertpapierkauf/-verkauf im Depot ↔ Giro-Buchung gleichen Betrags und Vorzeichens (Kauf: beide Abfluss)
    for (const side of [g.neg, g.pos]) {
      for (const d of side) {
        if (kindOf(d) !== 'depot' || !TRADE.test(fold(d.t.bookingText || ''))) continue;
        for (const o of side) {
          if (o.t.accountId === d.t.accountId || ['depot', 'paypal', 'kreditkarte'].includes(kindOf(o))) continue;
          const dd = Math.abs(o.day - d.day);
          if (dd > WINDOW + 2) continue;
          const oi = normalizeIban(o.t.counterpartyIban);
          const hint = DEPOT_HINT.test(o.text) || o.t.ownTransfer || (oi && oi === normalizeIban(d.acc?.iban));
          if (!hint && dd > 2) continue;
          push(o, d, 250 - dd * 10, hint && dd <= 3 ? 'high' : 'medium');
        }
      }
    }
    // (a) gegenläufige Beträge zwischen zwei verschiedenen eigenen Konten
    for (const n of g.neg) {
      for (const p of g.pos) {
        if (n.t.accountId === p.t.accountId) continue;
        const dd = Math.abs(n.day - p.day);
        if (dd > WINDOW) continue;
        let score = 100 - dd * 10;
        // Vom Nutzer als Umbuchung markierte Seite gilt als Hinweis: die Gegenseite wird mit verknüpft
        const evidence = EVIDENCE.test(n.text) || EVIDENCE.test(p.text) || n.t.ownTransfer || p.t.ownTransfer || userSide(n) || userSide(p);
        if (evidence) score += 40;
        const ni = normalizeIban(n.t.counterpartyIban), pi = normalizeIban(p.t.counterpartyIban);
        const ibanHit = (ni && n.targetAcc == null && ibanToAcc.get(ni)?.id === p.t.accountId) || (pi && ibanToAcc.get(pi)?.id === n.t.accountId);
        if (ibanHit) score += 60;
        const card = CARD_SETTLEMENT.test(n.text) || CARD_SETTLEMENT.test(p.text);
        if (card) score += 40;
        // Ohne jeden Hinweis nur bei engem Datum und „unrundem“ bzw. großem Betrag – sonst wären z. B. zwei 50-€-Buchungen zufällig ein Paar.
        // Solche Paare gelten als „mittel sicher“: Prüfliste, Steuer-Flag und USt-Schätzung bleiben bis zur Bestätigung.
        const weak = !evidence && !ibanHit && !card;
        if (weak) {
          const abs = Math.abs(n.t.amount);
          const roundSmall = abs < 50000 && abs % 500 === 0;
          if (dd > 2 || roundSmall) continue;
        }
        push(n, p, score, weak ? 'medium' : 'high');
      }
    }
  }

  // PayPal-Mischzahlung bzw. Einzug ohne Aufladungszeile: Bank-Lastschrift mit (Teil-)Betrag ≤ PayPal-Zahlung, kurz danach.
  // Nötig ist ein Hinweis (Händlername oder Transaktionscode im Verwendungszweck); bei gleichem Betrag reicht ein enges Datum.
  const ppPayments = new Map(); // Tag → PayPal-Zahlungen
  for (const w of work) {
    if (kindOf(w) !== 'paypal' || !(w.t.amount < 0) || w.day == null || w.isTransfer || w.locked) continue;
    const bt = fold(w.t.bookingText || '');
    if (/bankeinzug|waehrungsumrechnung/.test(bt) || PAYPAL_DEBIT_ROW.test(bt)) continue;
    let l = ppPayments.get(w.day);
    if (!l) ppPayments.set(w.day, l = []);
    l.push(w);
  }
  if (ppPayments.size) {
    for (const bank of work) {
      if (!free(bank) || kindOf(bank) === 'paypal' || !isPaypalBankDebit(bank.t)) continue;
      for (let dd = -1; dd <= WINDOW; dd++) {
        for (const pp of ppPayments.get(bank.day - dd) || []) {
          if (-bank.t.amount > -pp.t.amount) continue;
          const ref = fold(pp.t.endToEndId || '').replace(/ /g, '');
          const refHit = ref.length >= 8 && bank.text.replace(/ /g, '').includes(ref);
          const words = fold(pp.t.counterparty || pp.t.counterpartyRaw).split(' ').filter(x => x.length >= 4 && !MIX_STOP.has(x));
          const nameHit = words.length > 0 && words.some(x => bank.text.includes(x));
          const same = bank.t.amount === pp.t.amount;
          if (!refHit && !nameHit && !(same && dd >= 0 && dd <= 3)) continue;
          push(bank, pp, 200 - Math.abs(dd) * 10 + (refHit ? 60 : 0) + (nameHit ? 20 : 0) + (same ? 10 : 0), 'high', true);
        }
      }
    }
  }

  // Gierig nach Punktzahl, eins-zu-eins (halbe Verknüpfungen: Summe der Einzüge ≤ PayPal-Zahlung)
  candidates.sort((x, y) => y.score - x.score || x.a.day - y.a.day);
  for (const c of candidates) {
    if (c.half) {
      if (c.a.pair || c.a.half || c.b.pair || c.b.funded + -c.a.t.amount > -c.b.t.amount) continue;
      linkHalf(c.a, c.b);
      continue;
    }
    if (c.a.pair || c.b.pair || c.a.half || c.b.half) continue;
    link(c.a, c.b, c.conf);
  }

  // (b) Gegenkonto-IBAN ist ein eigenes Konto (auch ohne importierte Gegenbuchung)
  for (const w of work) {
    if (w.isTransfer || w.locked || w.pair) continue;
    const iban = normalizeIban(w.t.counterpartyIban);
    const own = iban && ibanToAcc.get(iban);
    if (own && own.id !== w.t.accountId) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = own.id; w.conf = 'high'; }
  }

  // (e) Depot: Wertpapierhandel im Depot ohne Gegenbuchung ist neutral (Vermögensumschichtung, kein Konsum);
  //     Giro-Seite eines Kaufs/Sparplans bei genau einem bekannten Depot → Umbuchung dorthin (zählt als Sparen)
  const depots = accounts.filter(a => a.kind === 'depot');
  for (const w of work) {
    if (w.isTransfer || w.locked || w.pair || w.half) continue;
    if (kindOf(w) === 'depot') { if (TRADE.test(fold(w.t.bookingText || ''))) { w.isTransfer = true; w.source = 'auto'; w.conf = 'high'; } }
    else if (depots.length === 1 && kindOf(w) !== 'paypal' && TRADE.test(w.text)) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = depots[0].id; w.conf = 'high'; }
  }

  // (d) Kreditkartenausgleich ohne Gegenbuchung: nur wenn die Karte als eigenes Konto bekannt ist
  const cards = accounts.filter(a => a.kind === 'kreditkarte');
  if (cards.length) {
    for (const w of work) {
      if (w.isTransfer || w.locked || w.pair || w.half || !CARD_SETTLEMENT.test(w.text) || kindOf(w) === 'kreditkarte') continue;
      const card = cards.find(c => {
        const i = normalizeIban(c.iban);
        return (i && normalizeIban(w.t.counterpartyIban) === i) || (c.institution && w.cp.includes(fold(c.institution)));
      });
      if (card) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = card.id; w.conf = 'high'; }
      // ohne Namens-/IBAN-Treffer: genau eine Karte bekannt → dorthin, aber zur Prüfung (es könnte eine nicht importierte Karte sein)
      else if (cards.length === 1 && w.t.amount < 0) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = cards[0].id; w.conf = 'medium'; }
    }
  }

  return work.map(w => {
    const t = w.t;
    if (w.locked) {
      // Nutzer: Flag bleibt, nur Paar-Verknüpfung ergänzen bzw. lösen, wenn der Partner (nicht) mehr passt
      if ((w.pair || null) !== (t.transferPairId || null) && w.isTransfer) return { ...t, transferPairId: w.pair || null, transferAccountId: w.targetAcc || t.transferAccountId || null };
      return t;
    }
    const conf = w.isTransfer ? w.conf || 'high' : null;
    if (w.isTransfer === !!t.isTransfer && (w.pair || null) === (t.transferPairId || null) && (w.targetAcc || null) === (t.transferAccountId || null)
      && (w.source || null) === (t.transferSource || null) && conf === (t.transferConfidence || null)) return t;
    return { ...t, isTransfer: w.isTransfer, transferPairId: w.pair || null, transferAccountId: w.targetAcc || null, transferSource: w.source || null, transferConfidence: conf };
  });
}

/**
 * Storno/Erstattung: Zahlung und gleich hohe Gutschrift desselben Händlers (≤ 60 Tage danach) heben sich auf.
 * Beide bekommen stornoPairId und zählen weder als Einnahme noch als Ausgabe. Ohne Erstattungs-Stichwort: stornoConfidence 'medium'.
 * stornoSource 'user' (Nutzer hat bestätigt oder gelöst) bleibt unverändert.
 */
export function detectStornos(txs) {
  const work = txs.map(t => {
    const locked = t.stornoSource === 'user';
    return { t, locked, pair: locked ? t.stornoPairId || null : null, conf: locked ? t.stornoConfidence || null : null };
  });
  const groups = new Map();
  for (const w of work) {
    const t = w.t;
    if (w.locked || !t.amount || !t.bookingDate || t.isTransfer || t.ownTransfer || t.category === 'umbuchung') continue;
    const key = fold(t.counterparty || t.counterpartyRaw);
    if (key.length < 3 || /^eigenes konto/.test(key)) continue;
    const k = key + '|' + Math.abs(t.amount);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { neg: [], pos: [] });
    w.day = dayNum(t.bookingDate);
    w.refund = REFUND.test(fold(`${t.purpose || ''} ${t.bookingText || ''}`));
    (t.amount < 0 ? g.neg : g.pos).push(w);
  }
  const cands = [];
  for (const g of groups.values()) {
    if (!g.neg.length || !g.pos.length) continue;
    for (const n of g.neg) for (const p of g.pos) {
      const dd = p.day - n.day;
      if (dd < 0 || dd > STORNO_WINDOW) continue;
      cands.push({ n, p, score: (p.refund || n.refund ? 100 : 0) + (n.t.accountId === p.t.accountId ? 20 : 0) - dd / 10 });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  for (const c of cands) {
    if (c.n.pair || c.p.pair) continue;
    c.n.pair = c.p.t.id; c.p.pair = c.n.t.id;
    c.n.conf = c.p.conf = c.p.refund || c.n.refund ? 'high' : 'medium';
  }
  return work.map(w => {
    const t = w.t;
    if (w.locked || ((w.pair || null) === (t.stornoPairId || null) && (w.conf || null) === (t.stornoConfidence || null))) return t;
    return { ...t, stornoPairId: w.pair, stornoConfidence: w.conf };
  });
}

/**
 * Prüfliste für Geldfluss (kinds transfer/paypal/depot/storno) bei jedem Lauf neu berechnen.
 * Andere Arten (receipt, split …) bleiben unberührt. Unverändert → dasselbe Objekt.
 */
export function computeFlowChecks(txs, accounts = []) {
  const accById = new Map(accounts.map(a => [a.id, a]));
  const kindOfAcc = (id) => accById.get(id)?.kind;
  // Zeitraum, den importierte PayPal-Konten abdecken (nur dort fehlt einer Bank-Lastschrift wirklich der Partner)
  let pp = null;
  for (const t of txs) {
    if (kindOfAcc(t.accountId) !== 'paypal' || !t.bookingDate) continue;
    const d = dayNum(t.bookingDate);
    if (!pp) pp = { lo: d, hi: d }; else { pp.lo = Math.min(pp.lo, d); pp.hi = Math.max(pp.hi, d); }
  }
  const txById = new Map(txs.map(t => [t.id, t]));

  return txs.map(t => {
    const mine = [];
    if (t.isTransfer && t.transferConfidence === 'medium' && t.transferSource !== 'user' && t.categorySource !== 'user') {
      const other = t.transferPairId ? txById.get(t.transferPairId) : null;
      const depot = kindOfAcc(t.accountId) === 'depot' || kindOfAcc(other?.accountId || t.transferAccountId) === 'depot';
      if (depot) mine.push({ kind: 'depot', reason: 'Depot-Umsatz und Kontobuchung nur über Betrag und Datum verknüpft – bitte bestätigen', refId: t.transferPairId || undefined });
      else if (t.transferPairId) mine.push({ kind: 'transfer', reason: 'Umbuchung nur über Betrag und Datum erkannt – bitte bestätigen', refId: t.transferPairId });
      else mine.push({ kind: 'transfer', reason: `Kartenabrechnung dem Konto „${accById.get(t.transferAccountId)?.name || 'Kreditkarte'}“ zugeordnet – bitte bestätigen` });
    }
    if (pp && !t.isTransfer && !t.reviewed && t.transferSource !== 'user' && kindOfAcc(t.accountId) !== 'paypal' && t.bookingDate && isPaypalBankDebit(t)) {
      const d = dayNum(t.bookingDate);
      if (d >= pp.lo - WINDOW && d <= pp.hi + WINDOW) mine.push({ kind: 'paypal', reason: 'PayPal-Abbuchung ohne passende Buchung im PayPal-Konto – zählt als Ausgabe' });
    }
    if (t.stornoPairId && t.stornoConfidence === 'medium' && t.stornoSource !== 'user' && !t.reviewed) {
      mine.push({ kind: 'storno', reason: 'Zahlung und gleich hohe Gutschrift desselben Empfängers heben sich auf – Erstattung?', refId: t.stornoPairId });
    }
    const keep = (t.checks || []).filter(c => !FLOW_KINDS.has(c.kind));
    const next = [...keep, ...mine.map(c => (c.refId ? c : { kind: c.kind, reason: c.reason }))];
    if (!next.length && !t.checks?.length) return t;
    if (JSON.stringify(next) === JSON.stringify(t.checks || [])) return t;
    return { ...t, checks: next };
  });
}
