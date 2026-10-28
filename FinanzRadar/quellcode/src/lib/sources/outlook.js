// Klassisches Outlook (Mac: Legacy-Outlook per AppleScript, Windows: Outlook-Desktop per COM).
// Der Browser erreicht Outlook nicht direkt – die Brücke ist der lokale Start-Server (/api/outlook/*,
// siehe launcher/server.py, server.mjs, server.ps1). Es verlässt nichts das Gerät.
// Je Mail: Anhänge mit erlaubter Endung als Items, dazu der Mailtext als .txt, wenn er Finanzbezug hat
// (Bestellbestätigungen kommen oft ohne Anhang).
import { allowedFile, makeItem, fetchRetry } from './index.js';

export const API_BASE = '/api/outlook';
export const DEFAULT_MONTHS = 12;
export const DEFAULT_LIMIT = 2000;

const NO_BRIDGE = 'Start-Server ohne Outlook-Brücke – FinanzRadar über das Start-Skript öffnen.';

function url(base, path, params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  ).toString();
  return `${base}/${path}${search ? `?${search}` : ''}`;
}

async function apiError(res) {
  let detail = res.statusText;
  try {
    const json = await res.json();
    detail = json.error || detail;
  } catch { /* kein JSON */ }
  return new Error(`Outlook: ${detail || `Fehler ${res.status}`}`);
}

async function get(path, params, { signal, base = API_BASE } = {}) {
  const res = await fetchRetry(url(base, path, params), { signal });
  if (!res.ok) throw await apiError(res);
  return res;
}

/** Brücke erreichbar und Outlook nutzbar? → { available, platform, reason? } (wirft nie, außer bei Abbruch) */
export async function status({ signal, base = API_BASE } = {}) {
  let res;
  try {
    res = await globalThis.fetch(url(base, 'status'), { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    return { available: false, platform: null, reason: NO_BRIDGE };
  }
  if (!res.ok || !(res.headers.get('Content-Type') || '').includes('json')) {
    return { available: false, platform: null, reason: NO_BRIDGE };
  }
  try {
    return await res.json();
  } catch {
    return { available: false, platform: null, reason: NO_BRIDGE };
  }
}

/** Alle Mail-Ordner: [{ id, name, path, count, inbox? }] */
export async function listFolders(opts = {}) {
  return (await get('folders', {}, opts)).json();
}

/** Mails eines Ordners ab Datum (neueste zuerst): [{ id, subject, from, date, hasBody, attachments }] */
export async function listMessages(folderId, { since, limit = DEFAULT_LIMIT, ...opts } = {}) {
  return (await get('messages', { folder: folderId, since, limit }, opts)).json();
}

export async function fetchBody(id, opts = {}) {
  return (await get('body', { id }, opts)).text();
}

export async function fetchAttachment(id, index, opts = {}) {
  return (await get('attachment', { id, index }, opts)).blob();
}

/** Standard-Ordnerwahl: Posteingang (Markierung der Brücke, sonst am Namen erkannt) */
export function defaultFolders(folders) {
  const marked = folders.filter((f) => f.inbox);
  if (marked.length) return marked;
  return folders.filter((f) => /^(posteingang|inbox)$/i.test(f.name)).slice(0, 1);
}

/** Datum vor `months` Monaten als JJJJ-MM-TT (lokal) */
export function sinceMonths(months = DEFAULT_MONTHS, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const STRONG = /bestellbest[äa]tigung|ihre bestellung|auftragsbest[äa]tigung|(?<!be)rechnung|quittung|kaufbeleg|zahlungsbest[äa]tigung|zahlungseingang|zahlungserinnerung|mahnung|buchungsbest[äa]tigung|lastschrift|abbuchung|gutschrift|erstattung|invoice|receipt|order confirmation|payment (?:received|confirmation)/i;
const WEAK = /bestell|zahlung|bezahl|überweis|betrag|gesamtsumme|summe|mwst|\bust\.|umsatzsteuer|preis|versandkosten|\border\b|\bpayment\b|\btotal\b/i;
const AMOUNT = /\d[\d.]*,\d{2}\s?(?:€|eur\b)|(?:€|eur)\s?\d[\d.]*,\d{2}|\d+\.\d{2}\s?(?:€|eur\b)/i;
const NEWSLETTER = /newsletter|abmelden|unsubscribe|abbestellen/i;
// Vorauswahl über Betreff/Absender – nur diese Mailtexte werden geholt (auf dem Mac kostet jeder Abruf spürbar Zeit)
const CANDIDATE = /bestell|rechnung|quittung|beleg|zahlung|bezahl|kauf|auftrag|versand|lieferung|buchung|vertrag|beitrag|abo\b|abonnement|konto|lastschrift|gutschrift|erstattung|mahnung|spende|steuer|order|invoice|receipt|payment|purchase|paypal|€/i;

/** Hat der Mailtext (inkl. Betreff) erkennbaren Finanzbezug? Werbung zählt nur mit starkem Signal. */
export function isFinanceMail(text) {
  const t = String(text || '');
  const strong = STRONG.test(t);
  const score = (strong ? 2 : 0) + (AMOUNT.test(t) ? 1 : 0) + (WEAK.test(t) ? 1 : 0);
  if (NEWSLETTER.test(t) && !strong) return false;
  return score >= 2;
}

/** Lohnt es, den Mailtext zu holen? (Betreff/Absender deuten auf Kauf, Rechnung, Zahlung …) */
export function isCandidateMail(msg) {
  return CANDIDATE.test(`${msg?.subject || ''} ${msg?.from || ''}`);
}

/** Datei-/Ordnernamen aus Mail-Betreffs: keine Pfadtrenner/Steuerzeichen, gekürzt */
export function safeName(s, max = 80) {
  const clean = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return clean.slice(0, max).trim();
}

/** Maildatum (lokale Zeit ohne Zone oder ISO) → ISO-String bzw. null */
function mailDate(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Alle Items der gewählten Ordner. `folders`: [{ id, path|name }], `since`: JJJJ-MM-TT (Standard: vor `months` Monaten).
 * Pfad: Outlook/<Ordner>/<Datum> <Betreff>/<Anhang> bzw. …/<Betreff>.txt für den Mailtext.
 * Mailtexte werden nur bei passendem Betreff/Absender geholt (`allBodies: true` = alle prüfen).
 */
export async function* enumerate({ folders = [], since, months = DEFAULT_MONTHS, limit = DEFAULT_LIMIT, allBodies = false, signal, base = API_BASE } = {}) {
  const opts = { signal, base };
  const from = since || sinceMonths(months);
  for (const folder of folders) {
    signal?.throwIfAborted();
    const folderPath = String(folder.path || folder.name || 'Ordner').split('/').map((p) => safeName(p)).filter(Boolean).join('/') || 'Ordner';
    const messages = await listMessages(folder.id, { since: from, limit, ...opts });
    for (const msg of messages) {
      signal?.throwIfAborted();
      const mtime = mailDate(msg.date);
      const day = String(msg.date || '').slice(0, 10);
      const subject = safeName(msg.subject) || 'Ohne Betreff';
      const dir = `Outlook/${folderPath}/${safeName(`${day} ${subject}`)}`;

      const names = new Set();
      for (const att of msg.attachments ?? []) {
        const name = safeName(att.name, 120);
        if (!name || names.has(name) || !allowedFile(name, att.size ?? null)) continue;
        names.add(name);
        yield makeItem({
          path: `${dir}/${name}`,
          name,
          size: att.size ?? null,
          mtime,
          getFile: () => fetchAttachment(msg.id, att.index, opts),
        });
      }

      if (msg.hasBody === false || (!allBodies && !isCandidateMail(msg))) continue;
      const text = await fetchBody(msg.id, opts);
      if (!isFinanceMail(`${msg.subject}\n${text}`)) continue;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      let name = `${subject}.txt`;
      if (names.has(name)) name = `Mail ${name}`;
      yield makeItem({
        path: `${dir}/${name}`,
        name,
        size: blob.size,
        mtime,
        getFile: async () => blob,
      });
    }
  }
}
