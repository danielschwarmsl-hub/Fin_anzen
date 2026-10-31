// KI-Aufgaben: je Aufruf GENAU eine kleine Aufgabe, kurzer System-Prompt, festes JSON-Schema, kein Verlauf.
import { CATEGORIES } from '../classify/categories.js';

export const DOC_TYPES = ['kontoauszug', 'kreditkarte', 'paypal', 'depot', 'lohn', 'lohnsteuerbescheinigung', 'rechnung', 'kassenbon', 'versicherung', 'rente', 'steuerbescheinigung', 'wertpapier', 'spende', 'vertrag', 'einkaufszettel', 'finanz_sonstiges', 'irrelevant'];
export const TAX_REASONS = ['lohn', 'beruf', 'versicherung_vorsorge', 'kapitalertraege', 'haushalt_handwerker', 'spenden', 'gesundheit', 'kinder_bildung', 'sonstiges'];

const BASE = 'Du bist ein präziser Assistent für deutsche Privatfinanzen. Antworte ausschließlich mit JSON nach Schema. Erfinde nichts; unbekannt = null.';

function clip(s, n) { s = String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + ' …' : s; }
// Umbuchungen erkennt nur die Paar-Logik (beide Konten), nie die KI
const catKeys = () => CATEGORIES.filter(c => c.id !== 'umbuchung').flatMap(c => [c.id, ...(c.subs || []).map(s => `${c.id}.${s.id}`)]);
const REASON = { type: 'string', description: 'kurze Begründung, höchstens 12 Wörter' };

export const TASKS = {
  /** 1. Dokumenttyp bestimmen */
  docType: {
    label: 'Dokumenttyp',
    build: ({ text, name }) => ({
      system: `${BASE} Bestimme den Dokumenttyp eines privaten Finanzdokuments.`,
      user: `Dateiname: ${name}\nText (Anfang):\n${clip(text, 1500)}`,
      format: { type: 'object', properties: { typ: { type: 'string', enum: DOC_TYPES }, aussteller: { type: ['string', 'null'] }, sicherheit: { type: 'number' }, begruendung: REASON }, required: ['typ', 'sicherheit'] },
    }),
  },

  /** 2. Kernfelder extrahieren */
  fields: {
    label: 'Felder',
    build: ({ text, type }) => ({
      system: `${BASE} Extrahiere die Kernfelder aus einem Dokument vom Typ „${type}“. Beträge als Zahl in Euro (Punkt als Dezimaltrenner), Datum als JJJJ-MM-TT.`,
      user: clip(text, 3500),
      format: {
        type: 'object',
        properties: {
          datum: { type: ['string', 'null'] }, aussteller: { type: ['string', 'null'] }, titel: { type: ['string', 'null'] },
          gesamtbetrag: { type: ['number', 'null'] }, nettobetrag: { type: ['number', 'null'] },
          mwst: { type: 'array', items: { type: 'object', properties: { satz: { type: 'number' }, betrag: { type: 'number' } }, required: ['satz', 'betrag'] } },
          rechnungsnummer: { type: ['string', 'null'] }, vertragsnummer: { type: ['string', 'null'] },
        },
        required: ['datum', 'aussteller', 'gesamtbetrag'],
      },
    }),
  },

  /** 3. Buchungen kategorisieren (Batch ≤ 20) */
  categorize: {
    label: 'Kategorien',
    build: ({ txs }) => ({
      system: `${BASE} Ordne jede Banktransaktion genau einer Kategorie zu. Erlaubt: ${catKeys().join(', ')}. Negativer Betrag = Ausgabe, positiver = Einnahme oder Erstattung. sicherheit 0–1 ehrlich schätzen.`,
      user: txs.map(t => `${t.id} | ${clip(t.counterparty || t.counterpartyRaw, 60)} | ${clip(t.purpose, 120)} | ${clip(t.bookingText, 30)} | ${(t.amount / 100).toFixed(2)}`).join('\n'),
      format: { type: 'object', properties: { ergebnisse: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kategorie: { type: 'string', enum: catKeys() }, sicherheit: { type: 'number' }, begruendung: REASON }, required: ['id', 'kategorie', 'sicherheit'] } } }, required: ['ergebnisse'] },
    }),
  },

  /** 4. Ggf. steuerrelevant? */
  tax: {
    label: 'Steuer',
    build: ({ doc }) => ({
      system: `${BASE} Entscheide nur grob, ob ein Beleg für die deutsche Einkommensteuererklärung eines Arbeitnehmers relevant sein KÖNNTE (Werbungskosten, Vorsorge, Spenden, Handwerker/Haushalt, Gesundheit, Kinder, Kapitalerträge, Lohn).`,
      user: `Typ: ${doc.type}\nAussteller: ${doc.issuer || '-'}\nTitel: ${doc.title || '-'}\nText:\n${clip(doc.text, 1200)}`,
      format: { type: 'object', properties: { relevant: { type: 'boolean' }, grund: { type: 'string', enum: TAX_REASONS }, sicherheit: { type: 'number' }, begruendung: REASON }, required: ['relevant', 'grund', 'sicherheit'] },
    }),
  },

  /** 5. Kassenbon-Positionen per Bild (Vision) */
  receiptItems: {
    label: 'Bon (Bild)',
    vision: true,
    build: ({ image }) => ({
      system: `${BASE} Lies einen deutschen Kassenbon. Positionen mit Preis in Euro, MwSt-Satz 7 oder 19.`,
      user: 'Lies Händler, Datum, alle Positionen und die Summe.',
      images: [image],
      format: { type: 'object', properties: { haendler: { type: ['string', 'null'] }, datum: { type: ['string', 'null'] }, summe: { type: ['number', 'null'] }, positionen: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, preis: { type: 'number' }, mwst_satz: { type: ['number', 'null'] } }, required: ['text', 'preis'] } } }, required: ['summe', 'positionen'] },
    }),
  },

  /** 6. Gehören Beleg und Buchung zusammen? (nur Hinweis, bestätigt wird nie automatisch) */
  receiptMatch: {
    label: 'Beleg ↔ Buchung',
    build: ({ tx, doc }) => ({
      system: `${BASE} Entscheide, ob ein Beleg zu einer Kontobuchung gehört (gleicher Kauf). Achte auf Händler, Datum (Buchung meist 0–5 Tage nach Beleg) und Betrag.`,
      user: `Buchung: ${tx.bookingDate} | ${(tx.amount / 100).toFixed(2)} EUR | ${clip(tx.counterparty || tx.counterpartyRaw, 60)} | ${clip(tx.purpose, 140)}\n`
        + `Beleg: ${doc.date || '-'} | ${doc.amount != null ? (doc.amount / 100).toFixed(2) + ' EUR' : '-'} | ${clip(doc.issuer || doc.title, 60)} | ${doc.type}\nText (Anfang):\n${clip(doc.text, 800)}`,
      format: { type: 'object', properties: { passt: { type: 'boolean' }, sicherheit: { type: 'number' }, begruendung: REASON }, required: ['passt', 'sicherheit'] },
    }),
  },
};

const CATEGORY_SUBS = new Map(CATEGORIES.map(c => [c.id, new Set((c.subs || []).map(s => s.id))]));
/** „Kategorie“ oder „Kategorie.Unterkategorie“ aus einer Modellantwort prüfen; unbekannte Werte → null */
export function parseCategory(value) {
  if (typeof value !== 'string') return null;
  const [category, sub] = value.trim().split('.');
  const subs = CATEGORY_SUBS.get(category);
  if (!subs) return null;
  return { category, subcategory: sub && subs.has(sub) ? sub : null };
}

export const euroToCents = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));
