// Volltextsuche (Orama, deutscher Stemmer) + Filter-Syntax
// Syntax: konto:ing  typ:rechnung  kat:wohnen  steuer  abo  >100  <50  2026  03.2026  "exakter text"
import { create, insertMultiple, search as oramaSearch } from '@orama/orama';
import { stemmer, language } from '@orama/stemmers/german';
import { parseGermanAmount, slug } from '../util/format.js';

let index = null;
let snapshot = { documents: [], transactions: [], contracts: [], accounts: [] };
let lookup = null;       // Id → Datensatz je Art (zum Index passend)
let buildToken = 0;
const CHUNK = 1500;
const CHUNK_CHARS = 400000;

/** Baut den Index in Häppchen (die Oberfläche friert nicht ein). Der alte Index bleibt bis zum Tausch nutzbar. */
export async function buildIndex(data) {
  const token = ++buildToken;
  const next = create({
    schema: { kind: 'string', title: 'string', body: 'string', extra: 'string' },
    components: { tokenizer: { stemming: true, stemmer, language } },
  });
  const docs = [];
  for (const d of data.documents || []) {
    if (d.type === 'irrelevant') continue;
    docs.push({ id: 'd:' + d.id, kind: 'doc', title: [d.title, d.issuer, d.displayName].filter(Boolean).join(' '), body: (d.text || '').slice(0, 20000), extra: [d.type, d.subtype, d.institution, ...(d.tags || [])].filter(Boolean).join(' ') });
  }
  for (const t of data.transactions || []) {
    docs.push({ id: 't:' + t.id, kind: 'tx', title: [t.counterparty, t.counterpartyRaw].filter(Boolean).join(' '), body: [t.purpose, t.bookingText].filter(Boolean).join(' '), extra: [t.category, t.subcategory].filter(Boolean).join(' ') });
  }
  for (const c of data.contracts || []) {
    docs.push({ id: 'c:' + c.id, kind: 'contract', title: c.provider || '', body: [c.kind, c.category].filter(Boolean).join(' '), extra: c.interval || '' });
  }
  // Häppchen nach Anzahl UND Textmenge (Dokumente mit langen Texten kosten mehr als Buchungen)
  for (let i = 0; i < docs.length;) {
    let j = i, chars = 0;
    while (j < docs.length && j - i < CHUNK && chars < CHUNK_CHARS) { chars += docs[j].body.length + docs[j].title.length; j++; }
    insertMultiple(next, docs.slice(i, j));
    i = j;
    await new Promise(r => setTimeout(r, 0));
    if (token !== buildToken) return; // neuerer Aufbau läuft
  }
  index = next;
  snapshot = data;
  lookup = {
    doc: new Map((data.documents || []).map(d => [d.id, d])),
    tx: new Map((data.transactions || []).map(t => [t.id, t])),
    contract: new Map((data.contracts || []).map(c => [c.id, c])),
  };
}

export function parseQuery(q) {
  const f = { terms: [], account: null, type: null, cat: null, tax: false, abo: false, min: null, max: null, year: null, month: null };
  const re = /"([^"]+)"|(\S+)/g; let m;
  while ((m = re.exec(q || ''))) {
    const tok = m[1] || m[2];
    let mm;
    if (m[1]) f.terms.push(tok);
    else if ((mm = tok.match(/^konto:(.+)$/i))) f.account = mm[1].toLowerCase();
    else if ((mm = tok.match(/^typ:(.+)$/i))) f.type = mm[1].toLowerCase();
    else if ((mm = tok.match(/^kat:(.+)$/i))) f.cat = mm[1].toLowerCase();
    else if (/^steuer(:.*)?$/i.test(tok)) f.tax = true;
    else if (/^abos?$/i.test(tok)) f.abo = true;
    else if ((mm = tok.match(/^>(=)?(.+)$/))) f.min = Math.abs(parseGermanAmount(mm[2]) ?? 0);
    else if ((mm = tok.match(/^<(=)?(.+)$/))) f.max = Math.abs(parseGermanAmount(mm[2]) ?? 0);
    else if (/^(19|20)\d{2}$/.test(tok)) f.year = tok;
    else if ((mm = tok.match(/^(\d{1,2})[./](\d{4})$/))) f.month = `${mm[2]}-${mm[1].padStart(2, '0')}`;
    else f.terms.push(tok);
  }
  return f;
}

function passes(item, kind, f) {
  const date = kind === 'tx' ? item.bookingDate : kind === 'doc' ? item.date : item.lastDate;
  const amt = Math.abs(item.amount ?? 0);
  if (f.year && !(date || '').startsWith(f.year)) return false;
  if (f.month && !(date || '').startsWith(f.month)) return false;
  if (f.min != null && amt < f.min) return false;
  if (f.max != null && amt > f.max) return false;
  if (f.tax && !item.taxRelevant) return false;
  if (f.abo && kind === 'tx' && !item.contractId) return false;
  if (f.abo && kind === 'doc') return false;
  if (f.type && kind === 'doc' && !slug(item.type).includes(slug(f.type))) return false;
  if (f.type && kind !== 'doc') return false;
  if (f.cat && !slug(item.category || '').includes(slug(f.cat))) return false;
  if (f.account) {
    const acc = (snapshot.accounts || []).find(a => a.id === item.accountId);
    const name = slug([acc?.institution, acc?.name].join(' '));
    if (!name.includes(slug(f.account))) return false;
  }
  return true;
}

/** Liefert { documents, transactions, contracts, total } – max. limit je Gruppe */
export function search(q, { limit = 50 } = {}) {
  const f = parseQuery(q);
  const term = f.terms.join(' ');
  const out = { documents: [], transactions: [], contracts: [], total: 0, filter: f };
  if (!index) return out;
  const byId = lookup;
  let candidates;
  if (term) {
    const r = oramaSearch(index, { term, tolerance: term.length > 4 ? 1 : 0, limit: 2000, boost: { title: 3, extra: 1.5 } });
    candidates = r.hits.map(h => ({ id: h.id, score: h.score }));
  } else {
    candidates = [
      ...[...byId.doc.keys()].map(id => ({ id: 'd:' + id, score: 0 })),
      ...[...byId.tx.keys()].map(id => ({ id: 't:' + id, score: 0 })),
      ...[...byId.contract.keys()].map(id => ({ id: 'c:' + id, score: 0 })),
    ];
  }
  for (const c of candidates) {
    const [p, id] = [c.id.slice(0, 1), c.id.slice(2)];
    const kind = p === 'd' ? 'doc' : p === 't' ? 'tx' : 'contract';
    const item = byId[kind].get(id);
    if (!item || !passes(item, kind, f)) continue;
    const bucket = kind === 'doc' ? out.documents : kind === 'tx' ? out.transactions : out.contracts;
    out.total++;
    if (bucket.length < limit) bucket.push(item);
  }
  if (!term) {
    out.transactions.sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''));
    out.documents.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  return out;
}

/** Markiert Suchbegriffe in einem Text-Ausschnitt (gibt Segmente zurück) */
export function snippet(text, q, len = 140) {
  if (!text) return '';
  const terms = parseQuery(q).terms.map(t => t.toLowerCase()).filter(t => t.length > 1);
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of terms) { const i = low.indexOf(t.slice(0, Math.max(3, t.length - 2))); if (i >= 0) { pos = i; break; } }
  const start = Math.max(0, pos - len / 2);
  return (start > 0 ? '…' : '') + text.slice(start, start + len).replace(/\s+/g, ' ') + (start + len < text.length ? '…' : '');
}
