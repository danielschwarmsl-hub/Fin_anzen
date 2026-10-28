// Anzeigenamen und Typ-Beschriftungen. Dateiname: "YYYY-MM-DD_Typ_Aussteller_Betrag.ext" (ZIP-sicher, ASCII).
import { amountForName } from '../util/format.js';

/** icon = Name in ui/Icon.svelte; label = Dateiname-Typ; name = Anzeigename in der UI */
export const TYPE_LABELS = {
  kontoauszug: { label: 'Kontoauszug', name: 'Kontoauszug', icon: 'bank' },
  kreditkarte: { label: 'Kontoauszug', name: 'Kreditkartenabrechnung', icon: 'bank' },
  paypal: { label: 'Umsaetze', name: 'PayPal-Umsätze', icon: 'bank' },
  depot: { label: 'Umsaetze', name: 'Depot', icon: 'bank' },
  lohn: { label: 'Lohnabrechnung', name: 'Lohnabrechnung', icon: 'payslip' },
  lohnsteuerbescheinigung: { label: 'Lohnsteuerbescheinigung', name: 'Lohnsteuerbescheinigung', icon: 'tax' },
  steuerbescheinigung: { label: 'Steuerbescheinigung', name: 'Steuerbescheinigung', icon: 'tax' },
  rechnung: { label: 'Rechnung', name: 'Rechnung', icon: 'invoice' },
  kassenbon: { label: 'Kassenbon', name: 'Kassenbon', icon: 'receipt' },
  versicherung: { label: 'Versicherung', name: 'Versicherung', icon: 'shield' },
  rente: { label: 'Rente', name: 'Rente / Vorsorge', icon: 'piggy' },
  spende: { label: 'Spende', name: 'Spende', icon: 'heart' },
  vertrag: { label: 'Vertrag', name: 'Vertrag / Abo', icon: 'contract' },
  einkaufszettel: { label: 'Einkaufszettel', name: 'Einkaufszettel', icon: 'list' },
  finanz_sonstiges: { label: 'Dokument', name: 'Sonstiges Finanzdokument', icon: 'file' },
  irrelevant: { label: 'Dokument', name: 'Nicht relevant', icon: 'ban' },
};

const FALLBACK = TYPE_LABELS.finanz_sonstiges;

/** Typ-Beschriftung für den Dateinamen; CSV-Exporte heißen "Umsaetze", PDF-/camt-Auszüge "Kontoauszug". */
export function typeLabel(doc) {
  const t = TYPE_LABELS[doc?.type] || FALLBACK;
  if (doc?.type === 'kontoauszug') {
    const f = String(doc.fields?.format || doc.format || '');
    if (/csv|mt940/i.test(f)) return 'Umsaetze';
  }
  return t.label;
}

/** ä→ae … , Akzente weg, Leerzeichen → '-', nur [A-Za-z0-9.&+-] */
export function asciiPart(s, max = 40) {
  let out = String(s || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.&+]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (out.length > max) out = out.slice(0, max).replace(/[-.]+$/, '');
  return out;
}

const ACCOUNT_TYPES = new Set(['kontoauszug', 'kreditkarte', 'paypal', 'depot']);
/** Kontobezeichnung ohne Bankname ("ING Extra-Konto" → "Extra-Konto"), damit Auszüge mehrerer Konten derselben Bank unterscheidbar bleiben */
function accountPart(doc) {
  if (!doc || !ACCOUNT_TYPES.has(doc.type)) return '';
  const bank = String(doc.issuer || doc.institution || '');
  let label = String(doc.fields?.accountName || '').trim();
  if (bank && label.toLowerCase().startsWith(bank.toLowerCase())) label = label.slice(bank.length).trim();
  if (!label || label.toLowerCase() === bank.toLowerCase()) return '';
  return asciiPart(label, 30);
}

/** "2026-04-12_Kassenbon_REWE_67,84.png"; leere Teile entfallen. */
export function displayName(doc, ext) {
  const parts = [
    doc?.date || doc?.periodFrom || '',
    typeLabel(doc),
    asciiPart(doc?.issuer || doc?.institution || ''),
    accountPart(doc),
    doc?.amount != null ? amountForName(doc.amount) : '',
  ].filter(Boolean);
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return parts.join('_') + (e ? '.' + e : '');
}

/** Kurztitel für Listen, falls ein Parser keinen gesetzt hat. */
export function titleFor(doc) {
  const t = TYPE_LABELS[doc?.type] || FALLBACK;
  const who = doc?.issuer || doc?.institution || '';
  const when = doc?.date ? ` ${doc.date.split('-').reverse().join('.')}` : '';
  return `${t.name}${who ? ' ' + who : ''}${when}`.trim();
}
