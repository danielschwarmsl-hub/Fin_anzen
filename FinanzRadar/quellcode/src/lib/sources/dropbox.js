// Dropbox ohne SDK: OAuth2 PKCE im Popup, Auflistung und Download über die HTTP-API.
import { allowedFile, isSkippedName, makeItem, fetchRetry } from './index.js';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Zufälliger URL-sicherer String (32 Bytes → 43 Zeichen). */
export function randomString(byteLength = 32) {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE-Paar: verifier (43 Zeichen) und challenge = BASE64URL(SHA-256(verifier)). */
export async function generatePkce() {
  const verifier = randomString(32);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Redirect-URI: oauth.html neben der App (muss in der Dropbox-App-Konsole eingetragen sein). */
export function oauthRedirectUri() {
  return new URL('oauth.html', globalThis.location.href).href;
}

export function buildAuthUrl({ appKey, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    token_access_type: 'offline',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

/** Popup öffnen, auf das Ergebnis aus oauth.html warten, Code gegen Token tauschen. */
export async function connect({ appKey }) {
  if (!appKey) throw new Error('App-Key fehlt.');
  // Popup synchron (in der Nutzergeste) öffnen, sonst blockiert der Browser es.
  const popup = globalThis.window.open('about:blank', 'finanzradar-dropbox', 'width=640,height=760');
  if (!popup) throw new Error('Popup wurde blockiert. Bitte Popups für diese Seite erlauben.');

  try {
    const { verifier, challenge } = await generatePkce();
    const state = randomString(16);
    const redirectUri = oauthRedirectUri();
    popup.location.href = buildAuthUrl({ appKey, redirectUri, codeChallenge: challenge, state });
    const code = await waitForOAuthCode(popup, state);
    return await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: appKey,
      redirect_uri: redirectUri,
    });
  } finally {
    try { popup.close(); } catch { /* Popup bereits geschlossen */ }
  }
}

function waitForOAuthCode(popup, expectedState) {
  const win = globalThis.window;
  return new Promise((resolve, reject) => {
    let closedTimer = null;
    const finish = () => {
      win.removeEventListener('message', onMessage);
      clearInterval(poll);
      clearTimeout(timeout);
      clearTimeout(closedTimer);
    };
    const onMessage = (ev) => {
      if (ev.origin !== win.location.origin) return;
      const data = ev.data;
      if (!data || data.type !== 'finanzradar-oauth') return;
      finish();
      const params = new URLSearchParams(data.search || '');
      if (params.get('error')) {
        return reject(new Error(`Anmeldung abgebrochen: ${params.get('error_description') || params.get('error')}`));
      }
      if (params.get('state') !== expectedState) return reject(new Error('OAuth-Status stimmt nicht überein.'));
      const code = params.get('code');
      if (!code) return reject(new Error('Kein Autorisierungscode erhalten.'));
      resolve(code);
    };
    // Fenster geschlossen ohne Ergebnis – kurz nachwarten, falls die Nachricht noch unterwegs ist.
    const poll = setInterval(() => {
      if (popup.closed && !closedTimer) {
        closedTimer = setTimeout(() => {
          finish();
          reject(new Error('Anmeldefenster wurde geschlossen.'));
        }, 1000);
      }
    }, 500);
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('Zeitüberschreitung bei der Anmeldung.'));
    }, POPUP_TIMEOUT_MS);
    win.addEventListener('message', onMessage);
  });
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Dropbox-Anmeldung fehlgeschlagen: ${json.error_description || json.error || res.status}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? params.refresh_token ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 14400) * 1000,
  };
}

/** Access-Token mit Refresh-Token erneuern. */
export function refresh({ appKey, refreshToken }) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey });
}

/** Dropbox erwartet '' für den Wurzelordner, sonst '/pfad' ohne Schluss-Slash. */
function normalizePath(path) {
  if (!path || path === '/') return '';
  const p = path.startsWith('/') ? path : '/' + path;
  return p.replace(/\/+$/, '');
}

async function rpc(token, endpoint, body, signal) {
  const res = await fetchRetry(`${API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function apiError(res) {
  let detail = res.statusText;
  try {
    const json = await res.json();
    detail = json.error_summary || json.error?.['.tag'] || detail;
  } catch { /* kein JSON */ }
  return new Error(`Dropbox-Fehler ${res.status}: ${detail || 'unbekannt'}`);
}

/** Nur Ordner eines Pfads (für den Ordner-Wähler), alle Seiten gelesen. */
export async function listFolders(token, path = '') {
  const folders = [];
  let page = await rpc(token, '/files/list_folder', { path: normalizePath(path), recursive: false });
  for (;;) {
    for (const e of page.entries) {
      if (e['.tag'] === 'folder') folders.push({ id: e.id, name: e.name, path: e.path_display });
    }
    if (!page.has_more) break;
    page = await rpc(token, '/files/list_folder/continue', { cursor: page.cursor });
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

/**
 * Dropbox-API-Arg: JSON mit ASCII-only-Escaping (alle Zeichen ab U+007F als \uXXXX),
 * wie von der Dropbox-API verlangt.
 */
export function dropboxApiArg(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function download(token, fileId, signal) {
  const res = await fetchRetry(`${CONTENT}/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': dropboxApiArg({ path: fileId }) },
    signal,
  });
  if (!res.ok) throw await apiError(res);
  return res.blob();
}

/** Rekursiv alle erlaubten Dateien unter `path` (Standard: Wurzel). Pfade ab Dropbox-Wurzel. */
export async function* enumerate({ token, path = '', signal } = {}) {
  let page = await rpc(token, '/files/list_folder', { path: normalizePath(path), recursive: true, limit: 2000 }, signal);
  for (;;) {
    for (const e of page.entries) {
      signal?.throwIfAborted();
      if (e['.tag'] !== 'file') continue;
      const full = e.path_display ?? e.path_lower ?? e.name;
      const rel = full.replace(/^\//, '');
      if (rel.split('/').some(isSkippedName)) continue;
      if (!allowedFile(e.name, e.size)) continue;
      yield makeItem({
        path: rel,
        name: e.name,
        size: e.size,
        mtime: e.server_modified ?? null,
        getFile: () => download(token, e.id, signal),
      });
    }
    if (!page.has_more) break;
    page = await rpc(token, '/files/list_folder/continue', { cursor: page.cursor }, signal);
  }
}
