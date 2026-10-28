// Schlanker Ollama-Client (nur localhost). Keine Streams, klare Timeouts, Abbruch per AbortSignal.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const NOT_LOCAL_MSG = 'Nur lokale Ollama-Adressen sind erlaubt (localhost, 127.0.0.1 oder [::1]) – Daten verlassen dieses Gerät nicht.';

/** Nur http(s) auf diesem Gerät, beliebiger Port, keine Zugangsdaten in der Adresse */
export function isLocalUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return false; }
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
}

export class Ollama {
  constructor(baseUrl = 'http://localhost:11434') { this.base = String(baseUrl || '').trim().replace(/\/+$/, ''); this.local = isLocalUrl(this.base); }

  async #req(path, { method = 'GET', body, signal, timeout = 8000 } = {}) {
    if (!this.local) throw new Error(NOT_LOCAL_MSG); // kein fetch an fremde Rechner
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const t = timeout ? setTimeout(() => ctl.abort(new DOMException('Zeitüberschreitung', 'TimeoutError')), timeout) : null;
    try {
      const r = await fetch(this.base + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type': 'application/json' } : undefined, signal: ctl.signal });
      if (!r.ok) {
        let msg = r.statusText;
        try { msg = (await r.json()).error || msg; } catch { /* ignore */ }
        throw new Error(`Ollama ${r.status}: ${msg}`);
      }
      return await r.json();
    } finally {
      if (t) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  version() { return this.#req('/api/version', { timeout: 2500 }); }
  async tags() { return (await this.#req('/api/tags')).models || []; }
  async ps() { return (await this.#req('/api/ps')).models || []; }
  show(model) { return this.#req('/api/show', { method: 'POST', body: { model } }); }

  /**
   * Eine Aufgabe = ein Aufruf. format = JSON-Schema → strukturierte Antwort.
   * think: false | true | 'low' | 'medium' | 'high' | undefined (Modell-Default)
   */
  async chat({ model, system, user, images, format, think, signal, keepAlive = '10m', numCtx = 4096, timeout = 0 }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user, ...(images?.length ? { images } : {}) });
    const body = { model, messages, stream: false, keep_alive: keepAlive, options: { temperature: 0, num_ctx: numCtx } };
    if (format) body.format = format;
    if (think !== undefined) body.think = think;
    const res = await this.#req('/api/chat', { method: 'POST', body, signal, timeout });
    const content = res.message?.content || '';
    return {
      content,
      json: format ? safeJson(content) : null,
      evalCount: res.eval_count || 0,
      evalMs: (res.eval_duration || 0) / 1e6,
      promptCount: res.prompt_eval_count || 0,
      totalMs: (res.total_duration || 0) / 1e6,
    };
  }

  /** Modell entladen (Speicher freigeben) */
  unload(model) { return this.#req('/api/chat', { method: 'POST', body: { model, messages: [], keep_alive: 0 }, timeout: 5000 }).catch(() => null); }
}

export function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* weiter */ }
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

/** Fähigkeiten aus /api/show (capabilities: ['completion','vision','thinking',…]) */
export function capabilitiesOf(show) {
  const caps = show?.capabilities || [];
  const family = show?.details?.family || '';
  return {
    vision: caps.includes('vision'),
    thinking: caps.includes('thinking'),
    thinkLevels: /gpt-oss/i.test(family) || /gpt-oss/i.test(show?.modelfile || '') ? ['low', 'medium', 'high'] : null,
    family,
    parameterSize: show?.details?.parameter_size || '',
    quant: show?.details?.quantization_level || '',
  };
}
