<script>
  // Animiertes Sankey-Diagramm (Geldfluss) mit fließenden Partikeln.
  import { tick, untrack } from 'svelte';
  import { fmtEUR } from '../util/format.js';
  import { layoutSankey, chainOfNode, chainOfLink } from './sankeyLayout.js';
  import ChartTip from './ChartTip.svelte';
  import Empty from '../ui/Empty.svelte';

  let { data = null, height = 460, onselect = null } = $props();

  const uid = 'mf' + Math.random().toString(36).slice(2, 8);
  let W = $state(0);
  let wrap = $state(null);
  let svgEl = $state(null);
  let pgroup = $state(null);
  let linkEls = [];
  function reg(node, i) {
    linkEls[i] = node;
    return { update(ni) { linkEls[ni] = node; }, destroy() { if (linkEls[i] === node) linkEls[i] = null; } };
  }
  let hover = $state(null); // { type:'node'|'link', key }
  let tip = $state({ x: 0, y: 0 });
  let phase = $state('measure'); // measure -> init -> run -> done
  let lens = $state([]);

  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const LW = $derived(Math.max(W, 520)); // darunter horizontal scrollen statt quetschen
  const narrow = $derived(LW < 560);
  const mid = $derived(LW < 820);
  const marginL = $derived(narrow ? 98 : mid ? 118 : 150);
  const marginR = $derived(narrow ? 96 : mid ? 140 : 176);

  // Höhe wächst mit der Zahl der Knoten in der vollsten Spalte, damit Labels Platz haben
  const effHeight = $derived.by(() => {
    const nodes = data?.nodes || [];
    const counts = {};
    for (const n of nodes) { const g = n.kind === 'category' || n.kind === 'saving' ? 't' : n.kind; counts[g] = (counts[g] || 0) + 1; }
    const maxN = Math.max(1, ...Object.values(counts));
    return Math.min(820, Math.max(height, maxN * 26 + 20));
  });

  const L = $derived.by(() => {
    if (!W) return null;
    try {
      return layoutSankey(data, { width: LW, height: effHeight, nodeWidth: narrow ? 10 : 13, padding: 9, margin: { l: marginL, r: marginR, t: 6, b: 6 } });
    } catch (e) {
      console.warn('sankey', e);
      return null;
    }
  });

  const sig = $derived(L ? L.links.length + ':' + Math.round(L.total) + ':' + L.nodes.length : '');

  // ---- Hover-Kette ----
  const hl = $derived.by(() => {
    if (!L || !hover) return null;
    if (hover.type === 'node') { const n = L.nodes.find((x) => x.id === hover.key); return n ? chainOfNode(n) : null; }
    const l = L.links[hover.key];
    return l ? chainOfLink(l) : null;
  });
  const linkOpacity = (l) => (hl ? (hl.links.has(l.index) ? 0.78 : 0.07) : 0.36);
  let hlRef = null; // für die Animationsschleife (nicht reaktiv)
  $effect(() => { hlRef = hl; });

  const gradId = (l) => `${uid}-g${l.index}`;
  const pct = (v) => (L && L.total ? (v / L.total) * 100 : 0);
  const fmtPct = (p) => (p >= 10 ? p.toFixed(0) : p.toFixed(1).replace('.', ',')) + ' %';

  const tipData = $derived.by(() => {
    if (!L || !hover) return null;
    if (hover.type === 'node') {
      const n = L.nodes.find((x) => x.id === hover.key);
      if (!n) return null;
      return { title: n.label, color: n.color, value: n.value, share: pct(n.value), rows: [
        ...(n.in.length > 1 ? n.in.slice(0, 4).map((l) => [`← ${l.source.label}`, l.value]) : []),
        ...(n.out.length > 1 ? n.out.slice(0, 5).map((l) => [`→ ${l.target.label}`, l.value]) : []),
      ] };
    }
    const l = L.links[hover.key];
    if (!l) return null;
    const of = l.source.value ? (l.value / l.source.value) * 100 : 0;
    return { title: `${l.source.label} → ${l.target.label}`, color: l.target.color, value: l.value, share: pct(l.value), sub: `${fmtPct(of)} von ${l.source.label}`, rows: [] };
  });

  function move(e) {
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    tip = { x: e.clientX - r.left, y: Math.max(40, Math.min(e.clientY - r.top, r.height - 40)) };
  }
  const enterNode = (n, e) => { hover = { type: 'node', key: n.id }; move(e); };
  const enterLink = (l, e) => { hover = { type: 'link', key: l.index }; move(e); };
  const leave = () => { hover = null; };
  function focusNode(n) {
    hover = { type: 'node', key: n.id };
    tip = { x: Math.min(n.x1 + 10, LW - 20), y: (n.y0 + n.y1) / 2 };
  }
  function keyNode(n, e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect?.(plainNode(n)); }
  }
  const plainNode = (n) => ({ id: n.id, label: n.label, kind: n.kind, color: n.color, value: n.value });

  // ---- Labels ----
  const ellip = (s, max) => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s);
  const CH = 6.4;
  function labelFor(n) {
    if (!L || n.h < 14) return null;
    const first = n.col === 0, last = n.col === L.ncols - 1;
    const amt = fmtEUR(n.value, { compact: true });
    const share = fmtPct(pct(n.value));
    const gap = L.ncols > 1 ? (L.nodes.find((x) => x.col === 1)?.x0 ?? 0) - (L.nodes.find((x) => x.col === 0)?.x1 ?? 0) : 200;
    if (!first && !last && gap < 120) return null; // mittlere Labels nur wenn Platz
    const room = first ? marginL - 10 : last ? marginR - 14 : Math.min(150, gap - 26);
    const max = Math.max(4, Math.floor(room / CH));
    const anchor = first ? 'end' : 'start';
    const x = first ? n.x0 - 8 : n.x1 + 8;
    const cy = (n.y0 + n.y1) / 2;
    if (n.h >= 30) return { x, anchor, mid: first || last ? false : true, lines: [{ t: ellip(n.label, max), cls: 'l1', y: cy - 5 }, { t: `${amt} · ${share}`, cls: 'l2', y: cy + 9 }] };
    return { x, anchor, lines: [{ t: ellip(`${n.label}  ${amt}`, max + 6), cls: 'l1', y: cy + 4 }] };
  }
  const labels = $derived(L ? L.nodes.map((n) => ({ n, lab: labelFor(n) })) : []);

  // ---- Einzeichnen ----
  let drawKey = '';
  $effect(() => {
    const key = sig;
    if (!key || key === drawKey || !L) return;
    drawKey = key;
    untrack(() => startDraw());
  });
  let timers = [];
  async function startDraw() {
    timers.forEach(clearTimeout); timers = [];
    if (reduced) { phase = 'done'; return; }
    phase = 'measure';
    await tick();
    lens = linkEls.map((el) => (el ? Math.ceil(el.getTotalLength()) + 2 : 0));
    phase = 'init';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      phase = 'run';
      timers.push(setTimeout(() => { phase = 'done'; }, 1700));
    }));
  }
  const dashStyle = (l) => {
    if (phase === 'done') return '';
    if (phase === 'measure') return 'opacity:0';
    const len = lens[l.index] || 0;
    const delay = 80 + l.source.col * 260 + (l.index % 7) * 25;
    return `stroke-dasharray:${len};stroke-dashoffset:${phase === 'init' ? len : 0};transition:stroke-dashoffset 1.05s cubic-bezier(.4,.1,.2,1) ${delay}ms, opacity .25s`;
  };

  // ---- Partikel ----
  const CAP = 250;
  let parts = []; // { li, t, speed, lat, el }
  let running = false, raf = 0, last = 0, inView = true;
  const SVGNS = 'http://www.w3.org/2000/svg';

  function buildParticles() {
    if (!pgroup) return;
    pgroup.replaceChildren();
    parts = [];
    if (!L) return;
    const ls = L.links;
    const sumW = ls.reduce((a, l) => a + Math.sqrt(l.value), 0) || 1;
    const vmax = Math.max(...ls.map((l) => l.value));
    for (const l of ls) {
      if (l.value < vmax * 0.004) continue;
      const share = Math.sqrt(l.value) / sumW;
      const cnt = Math.max(1, Math.round(share * CAP));
      const speed = 34 + 62 * Math.sqrt(l.value / vmax); // px/s
      const color = l.target.color || 'var(--accent)';
      for (let i = 0; i < cnt; i++) {
        const el = document.createElementNS(SVGNS, 'circle');
        el.setAttribute('r', (1.5 + Math.min(1.4, l.w / 24)).toFixed(2));
        el.setAttribute('fill', color);
        el.setAttribute('opacity', '0');
        pgroup.appendChild(el);
        parts.push({ len: linkEls[l.index]?.getTotalLength() || 1, li: l.index, t: (i + Math.random() * 0.8) / cnt, speed, lat: (Math.random() - 0.5) * 0.62, el, w: l.w });
      }
    }
  }
  function frame(ts) {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    const h = hlRef;
    for (const p of parts) {
      const path = linkEls[p.li];
      if (!path) continue;
      const len = p.len;
      p.t += (p.speed * dt) / len;
      if (p.t >= 1) p.t -= 1;
      const dist = p.t * len;
      const a = path.getPointAtLength(dist);
      let x = a.x, y = a.y;
      if (p.w > 5) {
        const b = path.getPointAtLength(Math.min(len, dist + 2));
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        x += (-dy / d) * p.lat * p.w; y += (dx / d) * p.lat * p.w;
      }
      p.el.setAttribute('cx', x.toFixed(1));
      p.el.setAttribute('cy', y.toFixed(1));
      const edge = Math.sin(Math.PI * p.t);
      const o = (h ? (h.links.has(p.li) ? 1 : 0.1) : 0.85) * Math.min(1, edge * 2.2);
      p.el.setAttribute('opacity', o.toFixed(2));
    }
    raf = requestAnimationFrame(frame);
  }
  function setRunning(on) {
    if (on && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!on && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  }
  const shouldRun = () => !reduced && phase === 'done' && inView && typeof document !== 'undefined' && !document.hidden && parts.length > 0;

  $effect(() => {
    // Partikel neu aufbauen, wenn Layout fertig ist
    if (!L || !pgroup) return;
    void L;
    untrack(() => buildParticles());
  });
  $effect(() => {
    void phase; void L;
    untrack(() => setRunning(shouldRun()));
  });
  $effect(() => {
    if (!wrap) return;
    const onVis = () => setRunning(shouldRun());
    document.addEventListener('visibilitychange', onVis);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => { inView = es[0]?.isIntersecting ?? true; setRunning(shouldRun()); }) : null;
    io?.observe(wrap);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
      setRunning(false);
      timers.forEach(clearTimeout);
    };
  });
</script>

<div class="mf" bind:clientWidth={W} style="min-height:{Math.min(effHeight, 200)}px">
  <div class="inner" bind:this={wrap} style="width:{L ? LW + 'px' : '100%'}">
  {#if !data || !L}
    {#if W > 0 || !data}
      <Empty icon="flow" title="Noch keine Geldflüsse" />
    {/if}
  {:else}
    <svg bind:this={svgEl} width={LW} height={effHeight} viewBox="0 0 {LW} {effHeight}" role="img" aria-label="Geldfluss von Einnahmen zu Konten und Kategorien" onpointerleave={leave}>
      <defs>
        {#each L.links as l (l.index)}
          <linearGradient id={gradId(l)} gradientUnits="userSpaceOnUse" x1={l.x0} x2={l.x1} y1="0" y2="0">
            <stop offset="0" stop-color={l.source.color || 'var(--accent)'} />
            <stop offset="1" stop-color={l.target.color || 'var(--accent)'} />
          </linearGradient>
        {/each}
        <filter id="{uid}-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <g class="links">
        {#each L.links as l (l.index)}
          <path use:reg={l.index} d={l.d} fill="none" stroke="url(#{gradId(l)})" stroke-width={Math.max(1, l.w)}
            style="opacity:{linkOpacity(l)};{dashStyle(l)}" class="lk"
            onpointerenter={(e) => enterLink(l, e)} onpointermove={move} onpointerleave={leave} role="presentation" />
        {/each}
      </g>

      <g class="particles" bind:this={pgroup} filter="url(#{uid}-glow)" pointer-events="none"></g>

      <g class="nodes">
        {#each L.nodes as n (n.id)}
          <rect x={n.x0} y={n.y0} width={n.x1 - n.x0} height={n.h} rx="3" fill={n.color || 'var(--accent)'}
            class="nd" class:dim={hl && !hl.nodes.has(n.id)} class:clickable={!!onselect}
            tabindex="0" role="button" aria-label="{n.label}: {fmtEUR(n.value)}"
            onpointerenter={(e) => enterNode(n, e)} onpointermove={move} onpointerleave={leave}
            onfocus={() => focusNode(n)} onblur={leave} onkeydown={(e) => keyNode(n, e)}
            onclick={() => onselect?.(plainNode(n))} />
        {/each}
      </g>

      <g class="labels" pointer-events="none">
        {#each labels as { n, lab } (n.id)}
          {#if lab}
            <g class="lab" class:dim={hl && !hl.nodes.has(n.id)} class:halo={lab.mid}>
              {#each lab.lines as ln}
                <text x={lab.x} y={ln.y} text-anchor={lab.anchor} class={ln.cls}>{ln.t}</text>
              {/each}
            </g>
          {/if}
        {/each}
      </g>
    </svg>
    <ChartTip show={!!tipData} x={tip.x} y={tip.y} width={LW}>
      {#if tipData}
        <div class="tt-h"><span class="dot" style="background:{tipData.color}"></span><b>{tipData.title}</b></div>
        <div class="tt-v num">{fmtEUR(tipData.value)} <span class="muted small">{fmtPct(tipData.share)}</span></div>
        {#if tipData.sub}<div class="muted small">{tipData.sub}</div>{/if}
        {#each tipData.rows as r}
          <div class="tt-r small"><span class="muted ellipsis">{r[0]}</span><span class="num">{fmtEUR(r[1], { compact: true })}</span></div>
        {/each}
      {/if}
    </ChartTip>
  {/if}
  </div>
</div>

<style>
  .mf { width: 100%; overflow-x: auto; overflow-y: hidden; }
  .inner { position: relative; max-width: none; }
  svg { display: block; overflow: visible; }
  .lk { transition: opacity .2s ease; cursor: default; mix-blend-mode: normal; }
  .nd { transition: opacity .2s ease, filter .2s; outline: none; }
  .nd.clickable { cursor: pointer; }
  .nd.dim { opacity: .3; }
  .nd:hover, .nd:focus-visible { filter: brightness(1.12) drop-shadow(0 0 4px color-mix(in srgb, currentColor 40%, transparent)); }
  .nd:focus-visible { stroke: var(--text); stroke-width: 1.5; }
  .lab { transition: opacity .2s; }
  .lab.dim { opacity: .3; }
  text { font-family: var(--font); font-variant-numeric: tabular-nums; }
  .l1 { font-size: 12.5px; font-weight: 600; fill: var(--text); }
  .l2 { font-size: 11px; fill: var(--text-2); }
  .halo text { paint-order: stroke; stroke: var(--surface); stroke-width: 3.5px; stroke-linejoin: round; }
  .tt-h { display: flex; align-items: center; gap: 7px; margin-bottom: 2px; }
  .tt-v { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
  .tt-r { display: flex; justify-content: space-between; gap: 12px; margin-top: 2px; }
  .tt-r:first-of-type { margin-top: 6px; }
</style>
