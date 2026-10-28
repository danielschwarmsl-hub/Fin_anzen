// Mock-Ollama für E2E-Tests: node tests/mock-ollama.mjs [port] [delayMs] [mode]
// mode: ok | invalid (kein JSON) | shape (falsche Struktur) | error (HTTP 500) – zur Laufzeit umschaltbar per POST /__mode/<mode>
import { createServer } from 'node:http';
const port = Number(process.argv[2] || 11434);
const delay = Number(process.argv[3] || 50);
let mode = process.argv[4] || 'ok';
const models = [
  { name: 'qwen3:8b', size: 5.2e9, details: { parameter_size: '8.2B', family: 'qwen3' } },
  { name: 'qwen3:4b', size: 2.5e9, details: { parameter_size: '4.0B', family: 'qwen3' } },
  { name: 'qwen2.5vl:7b', size: 6e9, details: { parameter_size: '8.3B', family: 'qwen25vl' } },
];
let calls = 0;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Content-Type': 'application/json' };
createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', async () => {
    const j = body ? JSON.parse(body) : {};
    const send = (o) => res.writeHead(200, cors).end(JSON.stringify(o));
    if (req.url?.startsWith('/__mode/')) { mode = req.url.slice(8); return send({ mode, calls }); }
    if (req.url === '/__stats') return send({ mode, calls });
    if (req.url === '/api/version') return send({ version: '0.12.0-mock' });
    if (req.url === '/api/tags') return send({ models });
    if (req.url === '/api/ps') return send({ models: [{ name: 'qwen3:8b', size: 5.2e9, size_vram: 5.2e9 }] });
    if (req.url === '/api/show') return send({ capabilities: j.model.includes('vl') ? ['completion', 'vision'] : ['completion', 'thinking'], details: models.find(m => m.name === j.model)?.details || {} });
    if (req.url === '/api/chat') {
      calls++;
      await new Promise(r => setTimeout(r, delay));
      const user = j.messages?.at(-1)?.content || '';
      const sys = j.messages?.[0]?.content || '';
      if (mode === 'error') return res.writeHead(500, cors).end(JSON.stringify({ error: 'model failed to load' }));
      let out = {};
      if (/Kategorie/.test(sys)) out = { ergebnisse: user.split('\n').map(l => ({ id: l.split(' | ')[0].trim(), kategorie: /rewe|edeka|penny/i.test(l) ? 'lebensmittel' : 'shopping', sicherheit: 0.8 })) };
      else if (/Dokumenttyp/.test(sys)) out = { typ: 'rechnung', aussteller: 'Mock GmbH', sicherheit: 0.8 };
      else if (/Kernfelder/.test(sys)) out = { datum: '2026-01-15', aussteller: 'Mock GmbH', gesamtbetrag: 12.5, mwst: [] };
      else if (/Einkommensteuer/.test(sys)) out = { relevant: false, grund: 'sonstiges' };
      else if (/Kassenbon/.test(sys)) out = { haendler: 'REWE', summe: 10, positionen: [{ text: 'Milch', preis: 1.29, mwst_satz: 7 }] };
      else out = { ok: true };
      if (j.format && mode === 'invalid') return send({ message: { role: 'assistant', content: 'Das sind meine Gedanken zu Ihren Buchungen, aber kein JSON.' }, eval_count: 40, eval_duration: 1e9 });
      if (j.format && mode === 'shape') return send({ message: { role: 'assistant', content: JSON.stringify({ ergebnisse: 'viele', typ: 42 }) }, eval_count: 40, eval_duration: 1e9 });
      return send({ message: { role: 'assistant', content: j.format ? JSON.stringify(out) : '1, 2, 3' }, eval_count: 40, eval_duration: 1e9, total_duration: delay * 1e6 });
    }
    res.writeHead(404, cors).end('{}');
  });
}).listen(port, '127.0.0.1', () => console.log('mock ollama on', port, 'delay', delay));
