// Gemeinsame Hilfsfunktionen – DOM-frei, auch in Node nutzbar.

/** "1.234,56" | "-1.234,56" | "1234.56" | "+500,00" | "12,30 EUR" | "12,30-" → Cent (Integer) oder null */
export function parseGermanAmount(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Math.round(input * 100);
  let s = String(input).trim().replace(/ /g, ' ').replace(/EUR|€/gi, '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.endsWith('+')) s = s.slice(0, -1);
  s = s.replace(/\s/g, '');
  if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (/S$|Soll$/i.test(s)) { neg = true; s = s.replace(/S$|Soll$/i, ''); }
  s = s.replace(/H$|Haben$/i, '');
  if (!/^[\d.,']+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let norm;
  if (lastComma > lastDot) norm = s.replace(/[.']/g, '').replace(',', '.');
  else if (lastDot > lastComma) {
    const decimals = s.length - lastDot - 1;
    // "1.234" (Tausender) vs "12.34" (Dezimal)
    if (lastComma === -1 && decimals === 3 && (s.match(/\./g) || []).length >= 1 && !/^0\./.test(s)) norm = s.replace(/\./g, '');
    else norm = s.replace(/[,']/g, '');
  } else norm = s;
  const v = Number(norm);
  if (!Number.isFinite(v)) return null;
  const cents = Math.round(v * 100);
  return neg ? -cents : cents;
}

/** "31.12.2025" | "31.12.25" | "2025-12-31" | "31.12." (mit fallbackYear) → "YYYY-MM-DD" oder null */
export function parseGermanDate(input, fallbackYear) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (m) {
    let y = m[3] ? Number(m[3]) : fallbackYear;
    if (!y) return null;
    if (y < 100) y += y > 70 ? 1900 : 2000;
    const d = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // PayPal englisch MM/DD/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
/** Cent → "1.234,56 €" */
export function fmtEUR(cents, { compact = false, sign = false } = {}) {
  if (cents == null || Number.isNaN(cents)) return '–';
  const v = cents / 100;
  const s = (compact && Math.abs(v) >= 1000 ? eur0 : eur).format(v);
  return sign && cents > 0 ? '+' + s : s;
}
/** "2026-03-14" → "14.03.2026" */
export function fmtDate(iso, { short = false } = {}) {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return short ? `${d}.${m}.` : `${d}.${m}.${y}`;
}
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
/** "2026-03" → "Mär 26" */
export function fmtMonth(ym) { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`; }

export function normalizeIban(s) { return s ? String(s).replace(/\s+/g, '').toUpperCase() : null; }
export function maskIban(s) { const i = normalizeIban(s); return i ? i.slice(0, 4) + ' •••• ' + i.slice(-4) : ''; }

export function slug(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function uid(prefix = '') {
  const r = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
  return prefix + r.replace(/-/g, '').slice(0, 16);
}

export async function sha256Hex(buf) {
  const data = buf instanceof ArrayBuffer ? buf : buf.buffer ? buf : await buf.arrayBuffer();
  const h = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function monthKey(iso) { return iso ? iso.slice(0, 7) : null; }
export function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }

/** Dateiname-sicher, max 60 Zeichen */
export function safeName(s, max = 60) {
  return String(s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
/** Cent → "412,30" für Dateinamen */
export function amountForName(cents) { return cents == null ? '' : (Math.abs(cents) / 100).toFixed(2).replace('.', ','); }

export function extOf(name) { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
