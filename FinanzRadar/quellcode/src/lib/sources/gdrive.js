// Google Drive ohne SDK: Google Identity Services (Token-Client) und Drive-v3-REST.
// Google-eigene Dokumente (Docs, Sheets, …) werden übersprungen – sie sind keine Binärdateien.
import { allowedFile, isSkippedName, makeItem, fetchRetry } from './index.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NATIVE_PREFIX = 'application/vnd.google-apps.';

let gisPromise = null;

/** Google-Identity-Services-Skript genau einmal laden. */
export function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        gisPromise = null;
        script.remove();
        reject(new Error('Google-Anmeldeskript konnte nicht geladen werden.'));
      };
      document.head.appendChild(script);
    });
  }
  return gisPromise;
}

/** Token-Client öffnet den Google-Anmelde-Dialog; kein Refresh-Token (bei Ablauf erneut verbinden). */
export async function connect({ clientId }) {
  if (!clientId) throw new Error('Client-ID fehlt.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(`Google-Anmeldung fehlgeschlagen: ${resp.error}`));
        resolve({
          accessToken: resp.access_token,
          refreshToken: null,
          expiresAt: Date.now() + Number(resp.expires_in ?? 3600) * 1000,
        });
      },
      error_callback: (err) => reject(new Error(`Google-Anmeldung abgebrochen: ${err?.type || 'unbekannt'}`)),
    });
    client.requestAccessToken();
  });
}

/** Drive-Abfragewert in einfache Anführungszeichen setzen (Escaping für q). */
function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function driveGet(token, resource, params, signal) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  );
  const res = await fetchRetry(`${API}/${resource}?${search}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) throw await driveError(res);
  return res.json();
}

async function driveError(res) {
  let detail = res.statusText;
  try {
    const json = await res.json();
    detail = json.error?.message || detail;
  } catch { /* kein JSON */ }
  const hint = res.status === 401 ? ' – bitte erneut verbinden' : '';
  return new Error(`Google Drive ${res.status}: ${detail || 'unbekannt'}${hint}`);
}

/** Unterordner eines Ordners (für den Ordner-Wähler), alle Seiten gelesen. */
export async function listFolders(token, parentId = 'root') {
  const folders = [];
  let pageToken;
  do {
    const data = await driveGet(token, 'files', {
      q: `${quote(parentId)} in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'nextPageToken,files(id,name)',
      pageSize: 1000,
      orderBy: 'name',
      pageToken,
    });
    for (const f of data.files ?? []) folders.push({ id: f.id, name: f.name });
    pageToken = data.nextPageToken;
  } while (pageToken);
  return folders;
}

async function downloadFile(token, fileId, signal) {
  const res = await fetchRetry(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) throw await driveError(res);
  return res.blob();
}

/**
 * Rekursiv alle erlaubten Dateien ab folderId (Breitensuche). `basePath` wird Präfix der Pfade
 * (z. B. "Banken/"), da Drive keine Ordnerpfade kennt.
 */
export async function* enumerate({ token, folderId = 'root', signal, basePath = '' } = {}) {
  const queue = [{ id: folderId, prefix: basePath }];
  while (queue.length) {
    const { id, prefix } = queue.shift();
    let pageToken;
    do {
      signal?.throwIfAborted();
      const data = await driveGet(token, 'files', {
        q: `${quote(id)} in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
        pageSize: 1000,
        pageToken,
      }, signal);
      for (const f of data.files ?? []) {
        if (isSkippedName(f.name)) continue;
        const path = prefix + f.name;
        if (f.mimeType === FOLDER_MIME) {
          queue.push({ id: f.id, prefix: path + '/' });
          continue;
        }
        if (f.mimeType?.startsWith(NATIVE_PREFIX)) continue;
        const size = f.size != null ? Number(f.size) : null;
        if (!allowedFile(f.name, size)) continue;
        yield makeItem({
          path,
          name: f.name,
          size,
          mtime: f.modifiedTime ?? null,
          getFile: () => downloadFile(token, f.id, signal),
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
}
