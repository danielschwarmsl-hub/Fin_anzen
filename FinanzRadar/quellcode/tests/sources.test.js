import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { allowedFile, isSkippedName, MAX_FILE_BYTES, SOURCE_KINDS } from '../src/lib/sources/index.js';
import { isDirectoryPickerSupported, filesFromInput, itemsFromDataTransfer, enumerateHandle, ensurePermission } from '../src/lib/sources/local.js';
import { generatePkce, buildAuthUrl, dropboxApiArg, listFolders as dbxList, enumerate as dbxEnumerate } from '../src/lib/sources/dropbox.js';
import { enumerate as driveEnumerate, listFolders as driveList } from '../src/lib/sources/gdrive.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

function fakeFile(name, { size = 10, lastModified = 1767225600000, content = 'x' } = {}) {
  return { name, size, lastModified, text: async () => content };
}

/** Fake FileSystemDirectoryHandle: children = { name: handle | fileObject } (fileObject → kind 'file') */
function fakeDir(name, children) {
  const handles = Object.entries(children).map(([n, c]) => [n, c.kind ? c : { kind: 'file', name: n, getFile: async () => c.file ?? c }]);
  return {
    kind: 'directory',
    name,
    entries: async function* () { for (const [n, h] of handles) yield [n, h]; },
    queryPermission: async () => 'prompt',
    requestPermission: async () => 'granted',
  };
}
function fileHandle(name, file) {
  return { kind: 'file', name, getFile: async () => file };
}

describe('allowedFile / isSkippedName', () => {
  it('erlaubt die vorgesehenen Endungen (case-insensitive)', () => {
    for (const n of ['a.pdf', 'b.PDF', 'c.jpeg', 'd.heic', 'e.tif', 'f.csv', 'g.tsv', 'h.xlsx', 'i.xls', 'j.xml', 'k.sta', 'l.mt940', 'm.md', 'n.txt', 'o.webp', 'p.heif']) {
      expect(allowedFile(n, 100), n).toBe(true);
    }
  });

  it('lehnt andere Endungen ab, insbesondere json', () => {
    for (const n of ['a.json', 'b.docx', 'c.exe', 'noext']) expect(allowedFile(n, 100), n).toBe(false);
  });

  it('überspringt versteckte und Systemdateien', () => {
    for (const n of ['.DS_Store', '.hidden.pdf', 'Thumbs.db', '~$Vertrag.docx', '~$x.xlsx', 'desktop.ini', '.git']) {
      expect(isSkippedName(n), n).toBe(true);
    }
    expect(allowedFile('.DS_Store', 10)).toBe(false);
    expect(allowedFile('Thumbs.db', 10)).toBe(false);
    expect(allowedFile('~$Liste.xlsx', 10)).toBe(false);
  });

  it('lehnt Dateien über 80 MB ab, akzeptiert genau 80 MB', () => {
    expect(MAX_FILE_BYTES).toBe(80 * 1024 * 1024);
    expect(allowedFile('gross.pdf', MAX_FILE_BYTES + 1)).toBe(false);
    expect(allowedFile('genau.pdf', MAX_FILE_BYTES)).toBe(true);
  });

  it('exportiert SOURCE_KINDS', () => {
    expect(SOURCE_KINDS.map((s) => s.kind)).toEqual(['local', 'dropbox', 'gdrive']);
  });
});

describe('dropbox PKCE and auth url', () => {
  it('generatePkce liefert 43-Zeichen-Verifier und korrekte S256-Challenge', async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = b64url(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it('generatePkce liefert jedes Mal neue Werte', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('buildAuthUrl setzt alle PKCE- und OAuth-Parameter', () => {
    const url = new URL(buildAuthUrl({
      appKey: 'abc123',
      redirectUri: 'http://localhost:5173/oauth.html',
      codeChallenge: 'CHALLENGE',
      state: 'STATE',
    }));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'abc123',
      response_type: 'code',
      token_access_type: 'offline',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      redirect_uri: 'http://localhost:5173/oauth.html',
      state: 'STATE',
    });
  });

  it('dropboxApiArg escaped Nicht-ASCII als \\uXXXX und ist wieder lesbar', () => {
    const obj = { path: 'id:abc/Müll €/Ärzte 😀.pdf' };
    const arg = dropboxApiArg(obj);
    // nur ASCII im Header
    expect(/^[\x00-\x7f]*$/.test(arg)).toBe(true);
    expect(arg).toContain('\\u00fc');
    expect(arg).toContain('\\u20ac');
    expect(arg).toContain('\\ud83d\\ude00');
    expect(JSON.parse(arg)).toEqual(obj);
  });
});

describe('local filesFromInput', () => {
  it('übernimmt webkitRelativePath, filtert Systemdateien und unerlaubte Endungen', async () => {
    const make = (rel, size = 5) => {
      const f = new File(['abc'], rel.split('/').pop(), { lastModified: 1767225600000 });
      Object.defineProperty(f, 'size', { value: size });
      Object.defineProperty(f, 'webkitRelativePath', { value: rel });
      return f;
    };
    const list = [
      make('Banken/ING/ing.csv'),
      make('Banken/.DS_Store'),
      make('Banken/Thumbs.db'),
      make('Banken/ING/~$tmp.xlsx'),
      make('Banken/config.json'),
      make('Banken/.git/objects.pdf'),
      make('Banken/gross.pdf', MAX_FILE_BYTES + 1),
      make('Banken/rechnung.PDF'),
    ];
    const items = filesFromInput(list);
    expect(items.map((i) => i.path)).toEqual(['Banken/ING/ing.csv', 'Banken/rechnung.PDF']);
    const first = items[0];
    expect(first).toMatchObject({ name: 'ing.csv', ext: 'csv', size: 5, path: 'Banken/ING/ing.csv' });
    expect(first.mtime).toBe(new Date(1767225600000).toISOString());
    const blob = await first.getFile();
    expect(await blob.text()).toBe('abc');
  });

  it('akzeptiert leere Liste', () => {
    expect(filesFromInput(null)).toEqual([]);
  });
});

describe('local handles', () => {
  it('enumerateHandle geht rekursiv, überspringt Versteckte und liefert getFile', async () => {
    const dir = fakeDir('Banken', {
      '.DS_Store': fileHandle('.DS_Store', fakeFile('.DS_Store')),
      'kontoauszug.pdf': fileHandle('kontoauszug.pdf', fakeFile('kontoauszug.pdf', { size: 2000 })),
      'notes.json': fileHandle('notes.json', fakeFile('notes.json')),
      '.versteckt': fakeDir('.versteckt', { 'x.pdf': fileHandle('x.pdf', fakeFile('x.pdf')) }),
      ING: fakeDir('ING', {
        'ing.csv': fileHandle('ing.csv', fakeFile('ing.csv', { size: 300 })),
        'riesig.pdf': fileHandle('riesig.pdf', fakeFile('riesig.pdf', { size: MAX_FILE_BYTES + 1 })),
      }),
    });
    const items = await collect(enumerateHandle(dir));
    expect(items.map((i) => i.path).sort()).toEqual(['Banken/ING/ing.csv', 'Banken/kontoauszug.pdf']);
    const csv = items.find((i) => i.name === 'ing.csv');
    expect(csv.size).toBe(300);
    expect(csv.ext).toBe('csv');
    expect(await (await csv.getFile()).text()).toBe('x');
  });

  it('enumerateHandle respektiert basePath und AbortSignal', async () => {
    const dir = fakeDir('Root', { 'a.pdf': fileHandle('a.pdf', fakeFile('a.pdf')) });
    const items = await collect(enumerateHandle(dir, { basePath: 'X/' }));
    expect(items.map((i) => i.path)).toEqual(['X/a.pdf']);

    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collect(enumerateHandle(dir, { signal: ctrl.signal }))).rejects.toBeDefined();
  });

  it('ensurePermission fragt nur an, wenn nötig', async () => {
    const handle = { queryPermission: vi.fn(async () => 'prompt'), requestPermission: vi.fn(async () => 'granted') };
    expect(await ensurePermission(handle)).toBe(true);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
    const granted = { queryPermission: async () => 'granted', requestPermission: vi.fn() };
    expect(await ensurePermission(granted)).toBe(true);
    expect(granted.requestPermission).not.toHaveBeenCalled();
  });

  it('isDirectoryPickerSupported ist in Node false', () => {
    expect(isDirectoryPickerSupported()).toBe(false);
  });
});

/** Fake webkitGetAsEntry-Einträge mit batchweisem readEntries (max. 2 pro Batch) */
function fakeEntry(name, { file, children } = {}) {
  if (children) {
    return {
      isDirectory: true, isFile: false, name,
      createReader: () => {
        let pending = children.slice();
        return {
          readEntries: (cb) => {
            const batch = pending.splice(0, 2);
            setTimeout(() => cb(batch), 0);
          },
        };
      },
    };
  }
  return {
    isDirectory: false, isFile: true, name,
    file: (ok) => setTimeout(() => ok(file), 0),
  };
}

describe('local itemsFromDataTransfer', () => {
  it('liest Ordner rekursiv über webkitGetAsEntry (Firefox-Pfad)', async () => {
    const dt = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => fakeEntry('Belege', { children: [
          fakeEntry('a.pdf', { file: new File(['1'], 'a.pdf') }),
          fakeEntry('sub', { children: [
            fakeEntry('b.png', { file: new File(['22'], 'b.png') }),
            fakeEntry('.DS_Store', { file: new File(['x'], '.DS_Store') }),
            fakeEntry('c.json', { file: new File(['x'], 'c.json') }),
          ] }),
          fakeEntry('d.csv', { file: new File(['33'], 'd.csv') }),
        ] }) },
        { kind: 'string', webkitGetAsEntry: () => null },
      ],
    };
    const items = await itemsFromDataTransfer(dt);
    expect(items.map((i) => i.path).sort()).toEqual(['Belege/a.pdf', 'Belege/d.csv', 'Belege/sub/b.png']);
    const b = items.find((i) => i.name === 'b.png');
    expect(b.size).toBe(2);
    expect(await (await b.getFile()).text()).toBe('22');
  });

  it('nutzt getAsFileSystemHandle (Chrome), wenn vorhanden', async () => {
    const dir = fakeDir('Steuer', { 'lohn.pdf': fileHandle('lohn.pdf', fakeFile('lohn.pdf', { size: 9 })) });
    const dt = { items: [{ kind: 'file', getAsFileSystemHandle: async () => dir, webkitGetAsEntry: () => null }] };
    const items = await itemsFromDataTransfer(dt);
    expect(items.map((i) => i.path)).toEqual(['Steuer/lohn.pdf']);
  });

  it('fällt auf dataTransfer.files zurück, wenn keine Items vorhanden', async () => {
    const f = new File(['z'], 'einkauf.txt');
    const items = await itemsFromDataTransfer({ items: [], files: [f] });
    expect(items.map((i) => i.path)).toEqual(['einkauf.txt']);
  });
});

/** Mock fetch mit Routing nach URL-Teil; liefert Antworten in der Reihenfolge der Routen */
function mockFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => r.match(String(url), init));
    if (!route) return new Response('not mocked: ' + url, { status: 500 });
    const res = route.respond(String(url), init);
    return res instanceof Response ? res : new Response(res.body, { status: res.status ?? 200, headers: res.headers });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

describe('dropbox enumerate and listFolders', () => {
  it('paginiert list_folder/continue, filtert und lädt mit Dropbox-API-Arg', async () => {
    const { calls } = mockFetch([
      {
        match: (u) => u.endsWith('/2/files/list_folder') && u.startsWith('https://api.dropboxapi.com'),
        respond: (u, init) => json({
          entries: [
            { '.tag': 'folder', name: 'ING', path_display: '/Banken/ING', id: 'id:f1' },
            { '.tag': 'file', name: 'ing.csv', path_display: '/Banken/ING/ing.csv', id: 'id:a1', size: 120, server_modified: '2026-03-01T10:00:00Z' },
          ],
          has_more: true,
          cursor: 'CUR1',
        }),
      },
      {
        match: (u) => u.endsWith('/2/files/list_folder/continue'),
        respond: (u, init) => json({
          entries: [
            { '.tag': 'file', name: 'Ärzte Rechnung.pdf', path_display: '/Banken/Ärzte Rechnung.pdf', id: 'id:a2', size: 50, server_modified: '2026-04-01T00:00:00Z' },
            { '.tag': 'file', name: '.DS_Store', path_display: '/Banken/.DS_Store', id: 'id:a3', size: 5 },
            { '.tag': 'file', name: 'x.json', path_display: '/Banken/x.json', id: 'id:a4', size: 5 },
          ],
          has_more: false,
          cursor: 'CUR2',
        }),
      },
      {
        match: (u) => u.startsWith('https://content.dropboxapi.com/2/files/download'),
        respond: () => new Response('PDFDATA', { status: 200 }),
      },
    ]);

    const items = await collect(dbxEnumerate({ token: 'TOK', path: '/Banken' }));
    expect(items.map((i) => i.path)).toEqual(['Banken/ING/ing.csv', 'Banken/Ärzte Rechnung.pdf']);
    expect(items[0]).toMatchObject({ name: 'ing.csv', ext: 'csv', size: 120, mtime: '2026-03-01T10:00:00Z' });

    // erster Aufruf: recursive, Token im Header
    const first = JSON.parse(calls[0].init.body);
    expect(first).toMatchObject({ path: '/Banken', recursive: true });
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOK');
    expect(JSON.parse(calls[1].init.body)).toEqual({ cursor: 'CUR1' });

    // Download: Dropbox-API-Arg ist ASCII und enthält die Datei-ID
    const blob = await items[1].getFile();
    expect(await blob.text()).toBe('PDFDATA');
    const dl = calls.find((c) => c.url.includes('/files/download'));
    expect(/^[\x00-\x7f]*$/.test(dl.init.headers['Dropbox-API-Arg'])).toBe(true);
    expect(JSON.parse(dl.init.headers['Dropbox-API-Arg'])).toEqual({ path: 'id:a2' });
    expect(dl.init.headers.Authorization).toBe('Bearer TOK');
  });

  it('listFolders liefert nur Ordner über alle Seiten', async () => {
    mockFetch([
      {
        match: (u) => u.endsWith('/2/files/list_folder'),
        respond: (u, init) => {
          expect(JSON.parse(init.body).path).toBe(''); // Wurzel ohne Slash
          return json({ entries: [
            { '.tag': 'file', name: 'a.pdf', path_display: '/a.pdf', id: 'id:1' },
            { '.tag': 'folder', name: 'Steuer', path_display: '/Steuer', id: 'id:2' },
          ], has_more: true, cursor: 'C' });
        },
      },
      {
        match: (u) => u.endsWith('/2/files/list_folder/continue'),
        respond: () => json({ entries: [{ '.tag': 'folder', name: 'Banken', path_display: '/Banken', id: 'id:3' }], has_more: false }),
      },
    ]);
    const folders = await dbxList('TOK', '');
    expect(folders.map((f) => f.name)).toEqual(['Banken', 'Steuer']);
    expect(folders[0].path).toBe('/Banken');
  });
});

describe('gdrive enumerate and listFolders', () => {
  const qOf = (u) => new URL(u).searchParams.get('q') ?? '';
  const pageOf = (u) => new URL(u).searchParams.get('pageToken');

  it('paginiert files.list, steigt in Unterordner, überspringt Google-Dokumente und lädt alt=media', async () => {
    const { calls } = mockFetch([
      {
        match: (u) => u.includes('/drive/v3/files?') && qOf(u) === "'root' in parents and trashed=false" && !pageOf(u),
        respond: () => json({
          files: [
            { id: 'f-sub', name: 'Banken', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'd1', name: 'Notizen', mimeType: 'application/vnd.google-apps.document' },
            { id: 'd2', name: 'Tabelle', mimeType: 'application/vnd.google-apps.spreadsheet' },
            { id: 'p1', name: 'lohn.pdf', mimeType: 'application/pdf', size: '2048', modifiedTime: '2026-02-02T08:00:00.000Z' },
          ],
          nextPageToken: 'PT2',
        }),
      },
      {
        match: (u) => u.includes('/drive/v3/files?') && pageOf(u) === 'PT2',
        respond: () => json({ files: [{ id: 'p2', name: 'bild.PNG', mimeType: 'image/png', size: '10', modifiedTime: '2026-02-03T08:00:00.000Z' }] }),
      },
      {
        match: (u) => u.includes('/drive/v3/files?') && qOf(u) === "'f-sub' in parents and trashed=false",
        respond: () => json({ files: [
          { id: 'c1', name: 'ing.csv', mimeType: 'text/csv', size: '99', modifiedTime: '2026-01-01T00:00:00.000Z' },
          { id: 'c2', name: 'data.json', mimeType: 'application/json', size: '1', modifiedTime: '2026-01-01T00:00:00.000Z' },
        ] }),
      },
      {
        match: (u) => u.includes('alt=media'),
        respond: () => new Response('CSVDATA'),
      },
    ]);

    const items = await collect(driveEnumerate({ token: 'GT', folderId: 'root' }));
    expect(items.map((i) => i.path).sort()).toEqual(['Banken/ing.csv', 'bild.PNG', 'lohn.pdf']);
    const lohn = items.find((i) => i.name === 'lohn.pdf');
    expect(lohn).toMatchObject({ size: 2048, mtime: '2026-02-02T08:00:00.000Z', ext: 'pdf' });

    // Pagination: zweite Seite mit pageToken aufgerufen
    expect(calls.filter((c) => pageOf(c.url) === 'PT2').length).toBe(1);
    expect(calls[0].init.headers.Authorization).toBe('Bearer GT');
    // Google-Dokumente werden nie als Datei geladen
    expect(calls.some((c) => c.url.includes('alt=media') && c.url.includes('d1'))).toBe(false);

    const blob = await lohn.getFile();
    expect(await blob.text()).toBe('CSVDATA');
    expect(calls.at(-1).url).toBe('https://www.googleapis.com/drive/v3/files/p1?alt=media');
  });

  it('listFolders liefert nur Ordner und paginiert', async () => {
    const { calls } = mockFetch([
      {
        match: (u) => u.includes('/drive/v3/files?'),
        respond: (u) => {
          const q = new URL(u).searchParams.get('q');
          expect(q).toContain("mimeType='application/vnd.google-apps.folder'");
          return json(u.includes('pageToken=P2')
            ? { files: [{ id: 'b', name: 'Banken' }] }
            : { files: [{ id: 'a', name: 'Steuer' }], nextPageToken: 'P2' });
        },
      },
    ]);
    const folders = await driveList('GT', 'root');
    expect(folders).toEqual([{ id: 'a', name: 'Steuer' }, { id: 'b', name: 'Banken' }]);
    expect(calls.length).toBe(2);
  });

  it('wirft bei 401 einen Hinweis zum erneuten Verbinden', async () => {
    mockFetch([{ match: () => true, respond: () => json({ error: { message: 'Invalid Credentials' } }, 401) }]);
    await expect(collect(driveEnumerate({ token: 'bad' }))).rejects.toThrow(/erneut verbinden/);
  });
});
