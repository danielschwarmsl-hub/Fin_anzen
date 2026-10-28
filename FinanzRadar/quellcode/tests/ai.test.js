import { describe, it, expect, vi } from 'vitest';
import { Ollama, safeJson, capabilitiesOf } from '../src/lib/ai/ollama.js';
import { smallerModel, recommend, paramsOf } from '../src/lib/ai/models.js';

describe('ollama client', () => {
  it('sends schema, think:false, temperature 0 and parses json', async () => {
    const fetchMock = vi.fn(async (url, init) => ({ ok: true, json: async () => ({ message: { content: '{"typ":"rechnung","sicherheit":0.9}' }, eval_count: 20, eval_duration: 1e9 }) }));
    globalThis.fetch = fetchMock;
    const c = new Ollama('http://localhost:11434/');
    const r = await c.chat({ model: 'qwen3:4b', user: 'x', format: { type: 'object' }, think: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.format).toEqual({ type: 'object' });
    expect(r.json.typ).toBe('rechnung');
    expect(r.evalMs).toBe(1000);
  });
  it('omits think when undefined', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ message: { content: 'ok' } }) }));
    globalThis.fetch = fetchMock;
    await new Ollama().chat({ model: 'm', user: 'x' });
    expect('think' in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false);
  });
  it('safeJson tolerates wrapped output', () => {
    expect(safeJson('Antwort: {"a":1} fertig')).toEqual({ a: 1 });
    expect(safeJson('kaputt')).toBe(null);
  });
  it('capabilities', () => {
    expect(capabilitiesOf({ capabilities: ['completion', 'thinking'] }).thinking).toBe(true);
    expect(capabilitiesOf({ capabilities: ['completion', 'vision'] }).vision).toBe(true);
  });
});

describe('model ladder', () => {
  const installed = [{ name: 'qwen3:8b', details: { parameter_size: '8.2B' } }, { name: 'qwen3:4b', details: { parameter_size: '4.0B' } }, { name: 'llama3.2:3b', details: { parameter_size: '3.2B' } }];
  it('suggests next smaller installed model', () => {
    expect(smallerModel('qwen3:8b', installed)).toEqual({ name: 'qwen3:4b', installed: true });
    expect(smallerModel('qwen3:4b', installed)).toEqual({ name: 'llama3.2:3b', installed: true });
  });
  it('falls back to ladder when nothing smaller is installed', () => {
    const r = smallerModel('llama3.2:3b', installed);
    expect(r.installed).toBe(false);
    expect(paramsOf({ name: r.name })).toBeLessThan(3.2);
  });
  it('recommends by hardware', () => {
    expect(recommend({ appleSilicon: true, memoryGB: 8 }, null).text).toBe('qwen3:8b');
    expect(recommend({ os: 'windows' }, { mode: 'cpu' }).vision).toBe(null);
    expect(recommend({ os: 'windows', dedicatedGpu: true }, null).text).toBe('qwen3:8b');
  });
});
