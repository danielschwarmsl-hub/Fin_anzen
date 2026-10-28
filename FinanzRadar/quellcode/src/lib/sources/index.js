// Gemeinsame Definitionen für alle Quellen (Ordner, Dropbox, Google Drive, Outlook). DOM-frei.
import { extOf } from '../util/format.js';

export const SOURCE_KINDS = [
  { kind: 'local', label: 'Ordner' },
  { kind: 'dropbox', label: 'Dropbox' },
  { kind: 'gdrive', label: 'Google Drive' },
  { kind: 'outlook', label: 'Outlook' },
];

export const MAX_FILE_BYTES = 80 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'heic', 'heif', 'webp', 'tif', 'tiff',
  'csv', 'txt', 'tsv', 'xlsx', 'xls', 'xml', 'sta', 'mt940', 'md',
]);

/** Versteckte und Systemdateien/-ordner (.DS_Store, .git, Thumbs.db, ~$Office-Lockfiles …) */
export function isSkippedName(name) {
  if (!name) return true;
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  const lower = name.toLowerCase();
  return lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '__macosx';
}

/** Dateiname + optionale Größe (Bytes) → darf importiert werden? */
export function allowedFile(name, size) {
  if (isSkippedName(name)) return false;
  if (!ALLOWED_EXTENSIONS.has(extOf(name))) return false;
  if (size != null && size > MAX_FILE_BYTES) return false;
  return true;
}

/** Einheitliches Datei-Item für alle Quellen. mtime als ISO-String oder null. */
export function makeItem({ path, name, size, mtime, getFile }) {
  return {
    path,
    name,
    size: size ?? null,
    mtime: mtime ?? null,
    ext: extOf(name),
    getFile,
  };
}

/** Millisekunden-Zeitstempel → ISO-String (oder null) */
export function isoFromMillis(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---- Wiederholungen für Cloud-Aufrufe (Dropbox, Google Drive) ----
export const retryConfig = { retries: 4, baseMs: 1000, maxMs: 30000 };
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Abgebrochen', 'AbortError'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new DOMException('Abgebrochen', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * fetch mit Wiederholung bei Netzwerkfehlern, 429 (Rate-Limit) und 5xx – mit Retry-After bzw. exponentieller Wartezeit.
 * Beim Massen-Download vieler Dateien sonst scheitern ganze Läufe an einzelnen Limits.
 */
export async function fetchRetry(url, init = {}) {
  const { retries, baseMs, maxMs } = retryConfig;
  for (let attempt = 0; ; attempt++) {
    const wait = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    let res;
    try {
      res = await globalThis.fetch(url, init);
    } catch (e) {
      if (init.signal?.aborted || attempt >= retries) throw e;
      await sleep(wait, init.signal);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;
    const retryAfter = Number(res.headers?.get?.('Retry-After'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, maxMs) : wait, init.signal);
  }
}
