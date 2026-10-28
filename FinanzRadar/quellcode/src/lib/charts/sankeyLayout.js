// Eigenes, spaltenfestes Sankey-Layout (DOM-frei). Spalten kommen aus der Knotenart.
// layoutSankey(sankey, { width, height, nodeWidth, padding, margin:{l,r,t,b} }) -> { nodes, links, total, ky } | null

const COL_ORDER = ['source', 'tax', 'account', 'target'];
const kindGroup = (k) => (k === 'category' || k === 'saving' ? 'target' : COL_ORDER.includes(k) ? k : 'account');

export function layoutSankey(sk, opts = {}) {
  const { width = 800, height = 400, nodeWidth = 12, padding = 10, margin = {} } = opts;
  const mL = margin.l ?? 0, mR = margin.r ?? 0, mT = margin.t ?? 4, mB = margin.b ?? 4;
  if (!sk || !Array.isArray(sk.nodes) || !Array.isArray(sk.links)) return null;

  const byId = new Map();
  sk.nodes.forEach((n, i) => byId.set(n.id ?? i, { ...n, id: n.id ?? i, _i: i, in: [], out: [] }));
  const links = [];
  for (const l of sk.links) {
    const s = byId.get(l.source) ?? (typeof l.source === 'number' ? [...byId.values()][l.source] : null);
    const t = byId.get(l.target) ?? (typeof l.target === 'number' ? [...byId.values()][l.target] : null);
    const v = Number(l.value);
    if (!s || !t || s === t || !(v > 0)) continue;
    const link = { source: s, target: t, value: v, index: links.length };
    links.push(link); s.out.push(link); t.in.push(link);
  }
  let nodes = [...byId.values()].filter((n) => n.in.length || n.out.length);
  if (!nodes.length || !links.length) return null;
  for (const n of nodes) {
    n.sumIn = n.in.reduce((a, l) => a + l.value, 0);
    n.sumOut = n.out.reduce((a, l) => a + l.value, 0);
    n.value = Math.max(n.sumIn, n.sumOut);
  }

  // Spalten: nach Art, dann auf vorhandene Gruppen verdichtet
  const present = COL_ORDER.filter((g) => nodes.some((n) => kindGroup(n.kind) === g));
  for (const n of nodes) n.col = present.indexOf(kindGroup(n.kind));
  // Sicherstellen, dass Links nie nach links laufen (zyklenfrei): bei Konflikt Ziel nach rechts schieben
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const l of links) if (l.target.col <= l.source.col) { l.target.col = l.source.col + 1; changed = true; }
    if (!changed) break;
  }
  const ncols = Math.max(...nodes.map((n) => n.col)) + 1;
  const cols = Array.from({ length: ncols }, () => []);
  for (const n of nodes) cols[n.col].push(n);
  cols.forEach((c) => c.sort((a, b) => b.value - a.value));

  const H = Math.max(40, height - mT - mB);
  let ky = Infinity;
  for (const c of cols) {
    if (!c.length) continue;
    const sum = c.reduce((a, n) => a + n.value, 0);
    const pad = Math.min(padding, Math.max(2, (H * 0.35) / Math.max(1, c.length - 1)));
    c.pad = pad;
    ky = Math.min(ky, (H - (c.length - 1) * pad) / sum);
  }
  if (!Number.isFinite(ky) || ky <= 0) return null;
  for (const n of nodes) n.h = Math.max(n.value * ky, 2);

  // Startposition: Spalten vertikal zentriert gestapelt
  for (const c of cols) {
    const tot = c.reduce((a, n) => a + n.h, 0) + (c.length - 1) * c.pad;
    let y = (H - tot) / 2;
    for (const n of c) { n.y = y; y += n.h + c.pad; }
  }

  const resolve = (c) => {
    c.sort((a, b) => a.y - b.y || a._i - b._i);
    let y = 0;
    for (const n of c) { if (n.y < y) n.y = y; y = n.y + n.h + c.pad; }
    let over = y - c.pad - H;
    if (over > 0) {
      let yy = H;
      for (let i = c.length - 1; i >= 0; i--) { const n = c[i]; if (n.y + n.h > yy) n.y = yy - n.h; yy = n.y - c.pad; }
      // evtl. oben überstehend (sollte durch ky nicht passieren)
      let y0 = 0; for (const n of c) { if (n.y < y0) n.y = y0; y0 = n.y + n.h + c.pad; }
    }
  };
  const center = (n) => n.y + n.h / 2;
  for (let it = 0; it < 12; it++) {
    const alpha = Math.pow(0.9, it) * 0.9 + 0.1;
    for (let c = 1; c < ncols; c++) {
      for (const n of cols[c]) {
        if (!n.in.length) continue;
        const w = n.in.reduce((a, l) => a + l.value, 0);
        const t = n.in.reduce((a, l) => a + center(l.source) * l.value, 0) / w - n.h / 2;
        n.y += (t - n.y) * alpha;
      }
      resolve(cols[c]);
    }
    for (let c = ncols - 2; c >= 0; c--) {
      for (const n of cols[c]) {
        if (!n.out.length) continue;
        const w = n.out.reduce((a, l) => a + l.value, 0);
        const t = n.out.reduce((a, l) => a + center(l.target) * l.value, 0) / w - n.h / 2;
        n.y += (t - n.y) * alpha;
      }
      resolve(cols[c]);
    }
  }
  for (const c of cols) resolve(c);

  // Spalten-X
  const innerW = Math.max(1, width - mL - mR - nodeWidth);
  for (const n of nodes) {
    n.x0 = mL + (ncols === 1 ? innerW / 2 : (n.col * innerW) / (ncols - 1));
    n.x1 = n.x0 + nodeWidth;
    n.y0 = mT + n.y; n.y1 = n.y0 + n.h;
  }

  // Link-Offsets
  for (const n of nodes) {
    n.out.sort((a, b) => center(a.target) - center(b.target) || a.target.col - b.target.col);
    n.in.sort((a, b) => center(a.source) - center(b.source));
    let o = 0; for (const l of n.out) { l.w = l.value * ky; l.sy = n.y0 + o + l.w / 2; o += l.w; }
    let i = 0; for (const l of n.in) { l.w = l.value * ky; l.ty = n.y0 + i + l.w / 2; i += l.w; }
  }
  for (const l of links) {
    const x0 = l.source.x1, x1 = l.target.x0, xm = (x0 + x1) / 2;
    l.x0 = x0; l.x1 = x1;
    l.d = `M${x0.toFixed(1)},${l.sy.toFixed(1)}C${xm.toFixed(1)},${l.sy.toFixed(1)} ${xm.toFixed(1)},${l.ty.toFixed(1)} ${x1.toFixed(1)},${l.ty.toFixed(1)}`;
  }
  const total = nodes.filter((n) => !n.in.length).reduce((a, n) => a + n.value, 0) || nodes.reduce((a, n) => Math.max(a, n.value), 0);
  return { nodes, links, total, ky, ncols, cols };
}

/** Alle Knoten/Links vor und hinter einem Knoten (für Hover-Kette). */
export function chainOfNode(node) {
  const ln = new Set(), nn = new Set([node.id]);
  const up = (n) => { for (const l of n.in) { if (!ln.has(l.index)) { ln.add(l.index); nn.add(l.source.id); up(l.source); } } };
  const down = (n) => { for (const l of n.out) { if (!ln.has(l.index)) { ln.add(l.index); nn.add(l.target.id); down(l.target); } } };
  up(node); down(node);
  return { links: ln, nodes: nn };
}
export function chainOfLink(link) {
  // nur Vorfahren der Quelle + Nachfahren des Ziels (nicht Geschwister-Zweige)
  const ln = new Set([link.index]), nn = new Set([link.source.id, link.target.id]);
  const up = (n) => { for (const l of n.in) { if (!ln.has(l.index)) { ln.add(l.index); nn.add(l.source.id); up(l.source); } } };
  const down = (n) => { for (const l of n.out) { if (!ln.has(l.index)) { ln.add(l.index); nn.add(l.target.id); down(l.target); } } };
  up(link.source); down(link.target);
  return { links: ln, nodes: nn };
}
