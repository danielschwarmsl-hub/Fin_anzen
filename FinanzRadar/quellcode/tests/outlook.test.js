import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { retryConfig } from '../src/lib/sources/index.js';
import * as outlook from '../src/lib/sources/outlook.js';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, 'fixtures', 'outlook-mock.json');
const DATA = JSON.parse(readFileSync(MOCK, 'utf8'));

beforeEach(() => { Object.assign(retryConfig, { retries: 1, baseMs: 1, maxMs: 2 }); });
afterEach(() => { vi.unstubAllGlobals(); Object.assign(retryConfig, { retries: 4, baseMs: 1000, maxMs: 30000 }); });

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** Nachbau der Brücken-API auf Basis der Mock-Datei (für die Quelle ohne Server) */
function fakeBridge() {
  const calls = [];
  const f = vi.fn(async (u, init) => {
    if (init?.signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    const url = new URL(u, 'http://localhost');
    calls.push(url.pathname + url.search);
    const q = url.searchParams;
    const msg = (id) => DATA.messages.find((m) => m.id === id);
    switch (url.pathname) {
      case '/api/outlook/status': return json({ available: true, platform: 'mac' });
      case '/api/outlook/folders': return json(DATA.folders);
      case '/api/outlook/messages':
        if (!DATA.folders.some((x) => x.id === q.get('folder'))) return json({ error: 'Ordner nicht gefunden' }, 404);
        return json(DATA.messages.filter((m) => m.folder === q.get('folder') && m.date.slice(0, 10) >= q.get('since'))
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .map((m) => ({ id: m.id, subject: m.subject, from: m.from, date: m.date, hasBody: true, attachments: (m.attachments || []).map((a, i) => ({ index: i + 1, name: a.name, size: 10 })) })));
      case '/api/outlook/body': { const m = msg(q.get('id')); return new Response(`Von: ${m.from}\nBetreff: ${m.subject}\n\n${m.body || ''}`); }
      case '/api/outlook/attachment': return new Response(`ANHANG ${q.get('id')}#${q.get('index')}`);
      default: return json({ error: 'Unbekannter Endpunkt' }, 404);
    }
  });
  return { f, calls };
}

const FOLDERS = [{ id: '11', path: 'Posteingang' }, { id: '12', path: 'Posteingang/Rechnungen' }];

describe('Outlook-Quelle', () => {
  it('liefert Anhänge und Mailtexte mit Finanzbezug als Items', async () => {
    const { f, calls } = fakeBridge();
    vi.stubGlobal('fetch', f);
    const items = [];
    for await (const it of outlook.enumerate({ folders: FOLDERS, since: '2026-01-01' })) items.push(it);
    expect(items.map((i) => i.path)).toEqual([
      'Outlook/Posteingang/2026-09-30 Rechnung September/Rechnung_2026-09.pdf',
      'Outlook/Posteingang/2026-09-30 Rechnung September/Rechnung September.txt',
      'Outlook/Posteingang/2026-09-14 Ihre Bestellung 302-1234567/Ihre Bestellung 302-1234567.txt',
      'Outlook/Posteingang/Rechnungen/2026-02-01 Beitragsrechnung 2026/Beitrag 2026.pdf',
      'Outlook/Posteingang/Rechnungen/2026-02-01 Beitragsrechnung 2026/Beitragsrechnung 2026.txt',
    ]);
    const [pdf, txt] = items;
    expect(pdf).toMatchObject({ name: 'Rechnung_2026-09.pdf', ext: 'pdf', size: 10, mtime: new Date('2026-09-30T08:00:00').toISOString() });
    expect(txt.ext).toBe('txt');
    expect(await (await pdf.getFile()).text()).toBe('ANHANG 102#1');
    expect(await (await txt.getFile()).text()).toContain('Anbei Ihre Rechnung.');
    // GIF-Anhang (nicht erlaubt) und die Privatmail ohne Finanzbezug fehlen; deren Text wird gar nicht erst geholt
    expect(items.some((i) => i.name === 'logo.gif')).toBe(false);
    expect(calls).not.toContain('/api/outlook/body?id=103');
    expect(calls.find((c) => c.startsWith('/api/outlook/messages'))).toBe('/api/outlook/messages?folder=11&since=2026-01-01&limit=2000');
  });

  it('allBodies prüft auch Mails ohne passenden Betreff', async () => {
    const { f, calls } = fakeBridge();
    vi.stubGlobal('fetch', f);
    const items = [];
    for await (const it of outlook.enumerate({ folders: [FOLDERS[0]], since: '2026-01-01', allBodies: true })) items.push(it);
    expect(calls).toContain('/api/outlook/body?id=103');
    expect(items.some((i) => i.path.includes('Wochenende'))).toBe(false);
  });

  it('bricht per Signal ab', async () => {
    const { f } = fakeBridge();
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    const seen = [];
    await expect((async () => {
      for await (const it of outlook.enumerate({ folders: FOLDERS, since: '2026-01-01', signal: ac.signal })) { seen.push(it.path); ac.abort(); }
    })()).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(f.mock.calls.every(([, init]) => init.signal === ac.signal)).toBe(true);
  });

  it('meldet Fehler der Brücke verständlich', async () => {
    const { f } = fakeBridge();
    vi.stubGlobal('fetch', f);
    const it = outlook.enumerate({ folders: [{ id: '99', path: 'Weg' }], since: '2026-01-01' });
    await expect(it.next()).rejects.toThrow('Outlook: Ordner nicht gefunden');
  });

  it('status: ohne Brücke nicht verfügbar statt Fehler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await outlook.status()).toMatchObject({ available: false, reason: expect.stringContaining('Start-Skript') });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })));
    expect((await outlook.status()).available).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ available: false, platform: 'mac', reason: 'Neues Outlook' })));
    expect(await outlook.status()).toEqual({ available: false, platform: 'mac', reason: 'Neues Outlook' });
  });

  it('Finanzbezug, Namen, Standardwerte', () => {
    expect(outlook.isFinanceMail('Ihre Bestellung bei Shop\nGesamt 12,99 €')).toBe(true);
    expect(outlook.isFinanceMail('Zahlungsbestätigung – vielen Dank')).toBe(true);
    expect(outlook.isFinanceMail('Nur heute: alles 19,99 € – jetzt bestellen! Newsletter abmelden')).toBe(false);
    expect(outlook.isFinanceMail('Berechnung der Fahrzeit für Samstag')).toBe(false);
    expect(outlook.isFinanceMail('Hallo, hast du Zeit?')).toBe(false);
    expect(outlook.isCandidateMail({ subject: 'Ihre Amazon.de Bestellung', from: '' })).toBe(true);
    expect(outlook.isCandidateMail({ subject: 'Wochenende?', from: 'Anna' })).toBe(false);
    expect(outlook.safeName('AW: Re/Fwd: <Rechnung> 1:2 ')).toBe('AW Re Fwd Rechnung 1 2');
    expect(outlook.defaultFolders(DATA.folders).map((f) => f.id)).toEqual(['11']);
    expect(outlook.defaultFolders([{ id: 'a', name: 'Archiv' }, { id: 'b', name: 'Inbox' }]).map((f) => f.id)).toEqual(['b']);
    expect(outlook.sinceMonths(12, new Date(2026, 9, 28))).toBe('2025-10-28');
  });
});

// ---- Start-Server im Testmodus (FINANZRADAR_OUTLOOK_MOCK) ----

function hasPython() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function startServer(cmd, args) {
  const proc = spawn(cmd, args, { env: { ...process.env, FINANZRADAR_OUTLOOK_MOCK: MOCK, FINANZRADAR_APP_DIR: join(here, 'fixtures'), FINANZRADAR_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => { proc.kill(); reject(new Error('Server startet nicht: ' + out)); }, 15000);
    const onData = (b) => {
      out += b;
      const m = /localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve({ proc, port: Number(m[1]) }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (b) => { out += b; });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`Server beendet (${code}): ${out}`)); });
  });
}

/** Roh-Anfrage mit frei wählbaren Headern (fetch erlaubt keinen eigenen Host-Header) */
function raw(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SERVERS = [
  ['server.mjs (Node)', 'node', [join(here, '..', 'launcher', 'server.mjs'), '0'], true],
  ['server.py (Python)', 'python3', [join(here, '..', 'launcher', 'server.py'), '0'], hasPython()],
];

describe.each(SERVERS)('Start-Server %s im Testmodus', (_label, cmd, args, enabled) => {
  let srv;
  beforeAll(async () => { if (enabled) srv = await startServer(cmd, args); });
  afterAll(() => { srv?.proc.kill(); });

  it.skipIf(!enabled)('beantwortet die Outlook-API', async () => {
    const st = await raw(srv.port, '/api/outlook/status');
    expect(st.status).toBe(200);
    expect(st.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(st.body)).toMatchObject({ available: true, platform: 'mac' });
    expect(JSON.parse((await raw(srv.port, '/api/outlook/folders')).body).map((f) => f.id)).toEqual(['11', '12']);
    const msgs = JSON.parse((await raw(srv.port, '/api/outlook/messages?folder=11&since=2026-01-01&limit=2')).body);
    expect(msgs.map((m) => m.id)).toEqual(['103', '102']);
    expect(msgs[1].attachments).toEqual([{ index: 1, name: 'Rechnung_2026-09.pdf', size: 19 }, { index: 2, name: 'logo.gif', size: 6 }]);
    const body = await raw(srv.port, '/api/outlook/body?id=103');
    expect(body.type).toContain('text/plain');
    expect(String(body.body)).toBe('Von: Anna <anna@privat.example>\nBetreff: Wochenende?\nDatum: 02.10.2026 19:00\n\nHast du Zeit?');
    const att = await raw(srv.port, '/api/outlook/attachment?id=102&index=1');
    expect(att.type).toBe('application/pdf');
    expect(att.body.subarray(0, 8).toString()).toBe('%PDF-1.4');
  });

  it.skipIf(!enabled)('prüft Host, Herkunft und Parameter', async () => {
    expect((await raw(srv.port, '/api/outlook/status', { Host: `evil.example:${srv.port}` })).status).toBe(403);
    expect((await raw(srv.port, '/api/outlook/status', { Host: `127.0.0.1:${srv.port}` })).status).toBe(200);
    expect((await raw(srv.port, '/api/outlook/status', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await raw(srv.port, '/api/outlook/status', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await raw(srv.port, '/api/outlook/status', { Origin: `http://localhost:${srv.port}`, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    for (const [path, status] of [
      ['/api/outlook/messages?folder=11%3Brm%20-rf&since=2026-01-01', 400],
      ['/api/outlook/messages?folder=11&since=2026-02-30', 400],
      ['/api/outlook/messages?folder=11&limit=0', 400],
      ['/api/outlook/messages?folder=99', 404],
      ['/api/outlook/attachment?id=102', 400],
      ['/api/outlook/attachment?id=102&index=9', 404],
      ['/api/outlook/nix', 404],
    ]) {
      const r = await raw(srv.port, path);
      expect([path, r.status]).toEqual([path, status]);
      expect(JSON.parse(r.body).error).toBeTruthy();
    }
    // statische Dateien weiter erreichbar, aber nicht außerhalb des App-Ordners
    expect((await raw(srv.port, '/outlook-mock.json')).status).toBe(200);
    expect((await raw(srv.port, '/../outlook.test.js')).status).not.toBe(200);
  });

  it.skipIf(!enabled)('Quelle läuft Ende-zu-Ende gegen den Server', async () => {
    const items = [];
    for await (const it of outlook.enumerate({ folders: FOLDERS, since: '2026-01-01', base: `http://127.0.0.1:${srv.port}/api/outlook` })) items.push(it);
    expect(items.map((i) => i.name)).toEqual(['Rechnung_2026-09.pdf', 'Rechnung September.txt', 'Ihre Bestellung 302-1234567.txt', 'Beitrag 2026.pdf', 'Beitragsrechnung 2026.txt']);
    const pdf = await items[0].getFile();
    expect(pdf.type).toBe('application/pdf');
    expect(await (await items[2].getFile()).text()).toContain('Gesamtsumme: 49,99 €');
  });
});

describe('server.py', () => {
  it.skipIf(!hasPython())('kompiliert (Syntaxprüfung ohne .pyc)', () => {
    const src = join(here, '..', 'launcher', 'server.py');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")', src])).not.toThrow();
  });
});
