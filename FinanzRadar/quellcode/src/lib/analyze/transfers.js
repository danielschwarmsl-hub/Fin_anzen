// Umbuchungen erkennen: eigene Konten, PayPal-Aufladungen, Kreditkartenausgleich.
// detectTransfers(txs, accounts) → Buchungen mit isTransfer / transferPairId / transferAccountId.
// Idempotent: automatisch gesetzte Markierungen (transferSource 'auto') werden bei jedem Lauf neu berechnet,
// Parser-Markierungen bleiben, Nutzerentscheidungen (categorySource 'user') werden nie geändert.
import { normalizeIban } from '../util/format.js';
import { fold } from '../classify/merchants.de.js';

export const PAYPAL_CREDITOR_ID = 'LU96ZZZ0000000000000000058';
const WINDOW = 5; // Tage

const EVIDENCE = /umbuchung|uebertrag|eigenes konto|eigene konten|tagesgeld|festgeld|sparen|sparplan|aufladung|ausgleich|verrechnungskonto|kreditkarte|geldanlage|rueckueberweisung|auszahlung paypal/;
const CARD_SETTLEMENT = /kreditkartenabrechnung|ausgleich kreditkarte|kartenabrechnung|kk abrechnung|abrechnung kreditkarte|visa abrechnung|mastercard abrechnung/;
const PAYPAL_DEBIT_ROW = /einzugsverfahren|direct debit|zahlung per lastschrift|bank ?einzug zahlung/;

const dayCache = new Map();
function dayNum(iso) {
  let d = dayCache.get(iso);
  if (d === undefined) { d = Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5); dayCache.set(iso, d); }
  return d;
}

export function detectTransfers(txs, accounts = []) {
  const accById = new Map(accounts.map(a => [a.id, a]));
  const ibanToAcc = new Map();
  for (const a of accounts) { const i = normalizeIban(a.iban); if (i) ibanToAcc.set(i, a); }

  // Arbeitskopien (nur geänderte Objekte werden am Ende ersetzt)
  const work = txs.map(t => {
    const locked = t.categorySource === 'user';
    let isTransfer = !!t.isTransfer;
    let source = t.transferSource || null;
    let pair = t.transferPairId || null, targetAcc = t.transferAccountId || null;
    if (!locked) {
      if (isTransfer && !source) source = t.transferPairId ? 'auto' : 'parser';
      if (source === 'auto') { isTransfer = false; pair = null; targetAcc = null; source = null; }
      if (source === 'parser') { pair = null; targetAcc = null; }
    }
    return {
      t, locked, isTransfer, source, pair, targetAcc,
      day: t.bookingDate ? dayNum(t.bookingDate) : null,
      cp: fold(`${t.counterpartyRaw || ''} ${t.counterparty || ''}`),
      text: fold(`${t.purpose || ''} ${t.bookingText || ''} ${t.counterpartyRaw || ''} ${t.counterparty || ''}`),
      acc: accById.get(t.accountId) || null,
    };
  });
  const free = (w) => !w.pair && w.day != null && w.t.accountId && !(w.locked && !w.isTransfer);

  const link = (a, b, source = 'auto') => {
    a.pair = b.t.id; b.pair = a.t.id;
    a.targetAcc = b.t.accountId; b.targetAcc = a.t.accountId;
    for (const w of [a, b]) { if (!w.locked) { w.isTransfer = true; if (w.source !== 'parser') w.source = source; } }
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
  const push = (a, b, score) => candidates.push({ a, b, score });

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
    for (const bank of g.neg) {
      if (kindOf(bank) === 'paypal' || !(bank.t.creditorId === PAYPAL_CREDITOR_ID || /paypal/.test(bank.cp))) continue;
      for (const pp of g.neg) {
        if (kindOf(pp) !== 'paypal' || !PAYPAL_DEBIT_ROW.test(fold(pp.t.bookingText || ''))) continue;
        const dd = Math.abs(bank.day - pp.day);
        if (dd <= WINDOW) push(bank, pp, 260 - dd * 10);
      }
    }
    // (a) gegenläufige Beträge zwischen zwei verschiedenen eigenen Konten
    for (const n of g.neg) {
      for (const p of g.pos) {
        if (n.t.accountId === p.t.accountId) continue;
        const dd = Math.abs(n.day - p.day);
        if (dd > WINDOW) continue;
        let score = 100 - dd * 10;
        const evidence = EVIDENCE.test(n.text) || EVIDENCE.test(p.text) || n.t.ownTransfer || p.t.ownTransfer;
        if (evidence) score += 40;
        const ni = normalizeIban(n.t.counterpartyIban), pi = normalizeIban(p.t.counterpartyIban);
        const ibanHit = (ni && n.targetAcc == null && ibanToAcc.get(ni)?.id === p.t.accountId) || (pi && ibanToAcc.get(pi)?.id === n.t.accountId);
        if (ibanHit) score += 60;
        const card = CARD_SETTLEMENT.test(n.text) || CARD_SETTLEMENT.test(p.text);
        if (card) score += 40;
        // Ohne jeden Hinweis nur bei engem Datum und „unrundem“ bzw. großem Betrag – sonst wären z. B. zwei 50-€-Buchungen zufällig ein Paar
        if (!evidence && !ibanHit && !card) {
          const abs = Math.abs(n.t.amount);
          const roundSmall = abs < 50000 && abs % 500 === 0;
          if (dd > 2 || roundSmall) continue;
        }
        push(n, p, score);
      }
    }
  }

  // Gierig nach Punktzahl, eins-zu-eins
  candidates.sort((x, y) => y.score - x.score || x.a.day - y.a.day);
  for (const c of candidates) {
    if (c.a.pair || c.b.pair) continue;
    link(c.a, c.b);
  }

  // (b) Gegenkonto-IBAN ist ein eigenes Konto (auch ohne importierte Gegenbuchung)
  for (const w of work) {
    if (w.isTransfer || w.locked || w.pair) continue;
    const iban = normalizeIban(w.t.counterpartyIban);
    const own = iban && ibanToAcc.get(iban);
    if (own && own.id !== w.t.accountId) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = own.id; }
  }

  // (d) Kreditkartenausgleich ohne Gegenbuchung: nur wenn die Karte als eigenes Konto bekannt ist
  const cards = accounts.filter(a => a.kind === 'kreditkarte');
  if (cards.length) {
    for (const w of work) {
      if (w.isTransfer || w.locked || w.pair || !CARD_SETTLEMENT.test(w.text) || kindOf(w) === 'kreditkarte') continue;
      const card = cards.find(c => {
        const i = normalizeIban(c.iban);
        return (i && normalizeIban(w.t.counterpartyIban) === i) || (c.institution && w.cp.includes(fold(c.institution)));
      });
      if (card) { w.isTransfer = true; w.source = 'auto'; w.targetAcc = card.id; }
    }
  }

  return work.map(w => {
    const t = w.t;
    if (w.locked) {
      // Nutzer: Flag bleibt, nur Paar-Verknüpfung ergänzen, wenn der Partner passt
      if (w.pair !== (t.transferPairId || null) && w.isTransfer) return { ...t, transferPairId: w.pair, transferAccountId: w.targetAcc || t.transferAccountId || null };
      return t;
    }
    if (w.isTransfer === !!t.isTransfer && (w.pair || null) === (t.transferPairId || null) && (w.targetAcc || null) === (t.transferAccountId || null) && (w.source || null) === (t.transferSource || null)) return t;
    return { ...t, isTransfer: w.isTransfer, transferPairId: w.pair || null, transferAccountId: w.targetAcc || null, transferSource: w.source || null };
  });
}
