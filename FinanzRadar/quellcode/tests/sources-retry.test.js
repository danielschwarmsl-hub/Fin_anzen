import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchRetry, retryConfig } from '../src/lib/sources/index.js';
import { enumerate as driveEnumerate } from '../src/lib/sources/gdrive.js';

beforeEach(() => { Object.assign(retryConfig, { retries: 3, baseMs: 1, maxMs: 5 }); });
afterEach(() => { vi.unstubAllGlobals(); Object.assign(retryConfig, { retries: 4, baseMs: 1000, maxMs: 30000 }); });

const res = (status, headers = {}) => new Response(status === 200 ? 'ok' : 'err', { status, headers });

describe('fetchRetry', () => {
  it('wiederholt bei 429/5xx und Netzwerkfehlern, liefert dann das Ergebnis', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { 'Retry-After': '0' })).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    vi.stubGlobal('fetch', f);
    const r = await fetchRetry('https://x/y');
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(4);
  });
  it('gibt nach den Versuchen die letzte Antwort bzw. den Fehler zurück', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500)));
    expect((await fetchRetry('https://x')).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(4);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchRetry('https://x')).rejects.toThrow('Failed to fetch');
  });
  it('wiederholt nicht bei 401/404 und bricht bei Abbruch sofort ab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404)));
    expect((await fetchRetry('https://x')).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
    const ac = new AbortController();
    retryConfig.baseMs = 5000; retryConfig.maxMs = 5000;
    vi.stubGlobal('fetch', vi.fn(async () => res(503)));
    const p = fetchRetry('https://x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('Google Drive überlebt ein Rate-Limit beim Auflisten', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? res(429) : new Response(JSON.stringify({ files: [{ id: '1', name: 'a.pdf', mimeType: 'application/pdf', size: '5', modifiedTime: '2026-01-01T00:00:00Z' }] }), { status: 200 }))));
    const out = [];
    for await (const it of driveEnumerate({ token: 't', folderId: 'root' })) out.push(it.path);
    expect(out).toEqual(['a.pdf']);
  });
});
