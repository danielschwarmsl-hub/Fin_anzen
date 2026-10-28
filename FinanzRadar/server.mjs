// Fallback-Server (Node), falls vorhanden: node server.mjs [port]
// Statische App aus ./app plus Outlook-Brücke unter /api/outlook/* (Mac, klassisches Outlook per osascript –
// gleiches AppleScript wie server.py). Nur 127.0.0.1, Host-Header-Prüfung, keine CORS-Header.
// Testmodus ohne Outlook: FINANZRADAR_OUTLOOK_MOCK=<json-datei>.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.FINANZRADAR_APP_DIR || join(here, 'app');
const script = join(here, 'outlook.applescript');
const port = Number(process.argv[2] ?? 8765);
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.ttf': 'font/ttf', '.gz': 'application/gzip' };
const RS = '\x1e', US = '\x1f';
const TIMEOUTS = { folders: 120, messages: 180, attachments: 180, body: 60, save: 120 };

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---- Hilfen ----
function htmlToText(src) {
  return String(src)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<\/?(br|p|div|tr|li|h\d|table|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const deDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : iso; };
const bodyText = (subject, from, date, text) => `Von: ${from}\nBetreff: ${subject}\nDatum: ${deDate(date)}\n\n${text}`;

// ---- Testdaten-Backend ----
function mockBackend(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const platform = data.platform || 'mac';
  const attBytes = (a) => (a.base64 != null ? Buffer.from(a.base64, 'base64') : Buffer.from(a.text || '', 'utf8'));
  const msg = (id) => { const m = (data.messages || []).find((x) => String(x.id) === id); if (!m) throw new ApiError(404, 'Mail nicht gefunden'); return m; };
  return {
    status: async () => ({ available: true, platform, ...(data.status || {}) }),
    folders: async () => (data.folders || []).map((f) => ({ id: String(f.id), name: f.name, path: f.path ?? f.name, count: f.count ?? 0, inbox: !!f.inbox })),
    async messages(folder, since, limit) {
      if (!(data.folders || []).some((f) => String(f.id) === folder)) throw new ApiError(404, 'Ordner nicht gefunden');
      return (data.messages || []).filter((m) => String(m.folder) === folder && m.date.slice(0, 10) >= since)
        .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit)
        .map((m) => ({ id: String(m.id), subject: m.subject || '', from: m.from || '', date: m.date, hasBody: !!(m.body || m.html), attachments: (m.attachments || []).map((a, i) => ({ index: i + 1, name: a.name, size: a.size ?? attBytes(a).length })) }));
    },
    async body(id) { const m = msg(id); return bodyText(m.subject || '', m.from || '', m.date, m.body || htmlToText(m.html || '')); },
    async attachment(id, index) { const a = (msg(id).attachments || [])[index - 1]; if (!a) throw new ApiError(404, 'Anhang nicht gefunden'); return { name: a.name, data: attBytes(a) }; },
  };
}

// ---- Mac: klassisches Outlook per AppleScript ----
const NEW_OUTLOOK = '„Neues Outlook“ ist aktiv – es unterstützt keine Skript-Anbindung. In Outlook im Menü „Outlook“ das „Neue Outlook“ ausschalten (Legacy-Outlook).';

function run(cmd, args, timeoutSec) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutSec * 1000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ err, code: err ? (err.code ?? 1) : 0, killed: !!err?.killed, stdout: stdout?.toString('utf8') ?? '', stderr: stderr?.toString('utf8') ?? '' });
    });
  });
}

function osaError(stderr) {
  const s = stderr || '';
  if (/-1743|Not authorized|nicht berechtigt/.test(s)) return new ApiError(403, 'Zugriff auf Outlook nicht erlaubt: Systemeinstellungen → Datenschutz & Sicherheit → Automation → Terminal (bzw. Node) → „Microsoft Outlook“ aktivieren.');
  if (/-1728|-1700/.test(s)) return new ApiError(404, 'Objekt in Outlook nicht gefunden (Mail oder Ordner gelöscht/verschoben?)');
  if (/-1708|-10000/.test(s)) return new ApiError(503, NEW_OUTLOOK);
  if (/-600|-609/.test(s)) return new ApiError(503, 'Outlook läuft nicht bzw. antwortet nicht.');
  return new ApiError(502, 'Outlook-Fehler: ' + (s.trim().split('\n').pop() || 'unbekannter Fehler').slice(0, 300));
}

function macBackend() {
  let queue = Promise.resolve(); // Outlook beantwortet Apple Events ohnehin nacheinander
  let saveBase = null;
  const osa = (cmd, ...args) => {
    const job = queue.then(async () => {
      const r = await run('/usr/bin/osascript', [script, cmd, ...args], TIMEOUTS[cmd] || 60);
      if (r.killed) throw new ApiError(504, 'Outlook antwortet nicht (Zeitlimit überschritten).');
      if (r.code !== 0) throw osaError(r.stderr);
      return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
    });
    queue = job.catch(() => {});
    return job;
  };
  const records = async (cmd, ...args) => { const out = await osa(cmd, ...args); return out ? out.split(RS).filter((r) => r.trim()).map((r) => r.split(US)) : []; };
  const num = (v) => { if (!/^\d{1,15}$/.test(v)) throw new ApiError(400, 'Ungültige ID'); return v; };
  const newOutlook = async () => { const r = await run('/usr/bin/defaults', ['read', 'com.microsoft.Outlook', 'IsRunningNewOutlook'], 10); return r.code === 0 && /^(1|true|YES)$/.test(r.stdout.trim()); };
  async function installed() {
    if (['/Applications/Microsoft Outlook.app', join(homedir(), 'Applications/Microsoft Outlook.app')].some((p) => existsSync(p))) return true;
    const r = await run('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.microsoft.Outlook'"], 10);
    return !!r.stdout.trim();
  }
  async function attachments(ids) {
    const map = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      for (const a of await records('attachments', ...ids.slice(i, i + 200))) {
        if (a.length < 4 || !/^\d+$/.test(a[1])) continue;
        if (!map.has(a[0])) map.set(a[0], []);
        map.get(a[0]).push({ index: Number(a[1]), name: a[2], size: /^\d+$/.test(a[3]) ? Number(a[3]) : null });
      }
    }
    return map;
  }
  return {
    async status() {
      if (!existsSync('/usr/bin/osascript')) return { available: false, platform: 'mac', reason: 'osascript fehlt auf diesem System.' };
      if (!existsSync(script)) return { available: false, platform: 'mac', reason: 'outlook.applescript fehlt neben server.mjs.' };
      if (!(await installed())) return { available: false, platform: 'mac', reason: 'Microsoft Outlook ist nicht installiert.' };
      if (await newOutlook()) return { available: false, platform: 'mac', reason: NEW_OUTLOOK };
      return { available: true, platform: 'mac' };
    },
    async folders() {
      const res = (await records('folders')).filter((f) => f.length >= 5).map((f) => ({ id: f[0], name: f[1], path: f[2], count: Number(f[3]) || 0, inbox: f[4] === '1' }));
      if (!res.length && await newOutlook()) throw new ApiError(503, NEW_OUTLOOK);
      return res;
    },
    async messages(folder, since, limit) {
      const msgs = (await records('messages', num(folder), since)).filter((m) => m.length >= 4)
        .map((m) => ({ id: m[0], subject: m[1], from: m[2], date: m[3], hasBody: true }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
      const atts = msgs.length ? await attachments(msgs.map((m) => m.id)) : new Map();
      for (const m of msgs) m.attachments = atts.get(m.id) || [];
      return msgs;
    },
    async body(id) {
      const parts = (await osa('body', num(id))).split(US);
      if (parts.length < 5) throw new ApiError(502, 'Unerwartete Antwort von Outlook');
      const [subject, from, date, isHtml, ...rest] = parts;
      const text = rest.join(US);
      return bodyText(subject, from, date, isHtml === '1' ? htmlToText(text) : text.trim());
    },
    async attachment(id, index) {
      num(id);
      const found = ((await attachments([id])).get(id) || []).find((a) => a.index === index);
      if (!found) throw new ApiError(404, 'Anhang nicht gefunden');
      const name = found.name || `Anhang${index}`;
      const safe = name.replace(/[\\/:\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || `Anhang${index}`;
      // Outlook ist sandboxed und darf nicht überall schreiben: System-Temp, sonst Outlooks eigener Container,
      // sonst Downloads. Der erste funktionierende Ordner wird gemerkt.
      let last = null;
      const bases = [tmpdir(), join(homedir(), 'Library/Containers/com.microsoft.Outlook/Data/tmp'), join(homedir(), 'Downloads')];
      for (const base of saveBase ? [saveBase, ...bases.filter((b) => b !== saveBase)] : bases) {
        if (!existsSync(base)) continue;
        const dir = await mkdtemp(join(base, 'finanzradar-'));
        try {
          const dest = join(dir, safe);
          await osa('save', id, String(index), dest);
          if ((await stat(dest).catch(() => null))?.isFile()) {
            const data = await readFile(dest);
            saveBase = base;
            return { name, data };
          }
          last = new ApiError(502, 'Outlook hat den Anhang nicht gespeichert.');
        } catch (e) {
          last = e;
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      throw last || new ApiError(500, 'Kein Temp-Ordner verfügbar');
    },
  };
}

function unsupportedBackend() {
  const platform = process.platform === 'win32' ? 'windows' : 'other';
  const reason = platform === 'windows' ? 'Unter Windows FinanzRadar über „FinanzRadar starten (Windows).bat“ öffnen.' : 'Outlook-Anbindung gibt es nur auf Mac und Windows.';
  const no = async () => { throw new ApiError(503, reason); };
  return { status: async () => ({ available: false, platform, reason }), folders: no, messages: no, body: no, attachment: no };
}

const backend = process.env.FINANZRADAR_OUTLOOK_MOCK ? mockBackend(process.env.FINANZRADAR_OUTLOOK_MOCK)
  : process.platform === 'darwin' ? macBackend() : unsupportedBackend();

// ---- Parameter ----
const bad = (name) => { throw new ApiError(400, `Ungültiger Parameter: ${name}`); };
function idParam(q, name = 'id') { const v = q.get(name); if (!v || !/^[A-Za-z0-9._:-]{1,4096}$/.test(v)) bad(name); return v; }
function sinceParam(q) {
  const v = q.get('since');
  if (!v) { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) bad('since');
  return v;
}
function intParam(q, name, def, lo, hi) {
  const v = q.get(name);
  if (v == null) { if (def == null) bad(name); return def; }
  if (!/^\d{1,6}$/.test(v) || Number(v) < lo || Number(v) > hi) bad(name);
  return Number(v);
}

// ---- HTTP ----
function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

async function api(req, res, url, hosts) {
  // Nur die eigene Seite darf fragen (keine CORS-Header; zusätzlich Fetch-Metadaten/Origin prüfen)
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  if ((site && site !== 'same-origin' && site !== 'none') || (origin && !hosts.has(origin.toLowerCase().replace(/^http:\/\//, '')))) {
    return json(res, 403, { error: 'Nur von FinanzRadar selbst erlaubt' });
  }
  const q = url.searchParams;
  try {
    switch (url.pathname) {
      case '/api/outlook/status': return json(res, 200, await backend.status());
      case '/api/outlook/folders': return json(res, 200, await backend.folders());
      case '/api/outlook/messages': return json(res, 200, await backend.messages(idParam(q, 'folder'), sinceParam(q), intParam(q, 'limit', 500, 1, 5000)));
      case '/api/outlook/body': return send(res, 200, await backend.body(idParam(q)), 'text/plain; charset=utf-8');
      case '/api/outlook/attachment': {
        const { name, data } = await backend.attachment(idParam(q), intParam(q, 'index', null, 1, 999));
        return send(res, 200, data, T[extname(name).toLowerCase()] || 'application/octet-stream');
      }
      default: throw new ApiError(404, 'Unbekannter Endpunkt');
    }
  } catch (e) {
    if (e instanceof ApiError) return json(res, e.status, { error: e.message });
    console.error('API-Fehler', e);
    return json(res, 500, { error: `Interner Fehler: ${e?.name || 'Error'}` });
  }
}

const server = createServer(async (req, res) => {
  const p0 = server.address().port;
  const hosts = new Set([`localhost:${p0}`, `127.0.0.1:${p0}`]);
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) { res.writeHead(403).end('forbidden'); return; }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') { json(res, 405, { error: 'Nur GET' }); return; }
    await api(req, res, url, hosts);
    return;
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(join(root, p));
  if (!f.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'Content-Type': T[extname(f)] || 'application/octet-stream' }).end(b); }
  catch { res.writeHead(404).end('not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`FinanzRadar: http://localhost:${server.address().port}/`));
