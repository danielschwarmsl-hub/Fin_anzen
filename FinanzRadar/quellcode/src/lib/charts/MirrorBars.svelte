<script>
  // Einnahmen (oben) vs. Ausgaben (unten) je Monat, mit Netto-Linie.
  import { line, curveMonotoneX } from 'd3-shape';
  import { fmtEUR, fmtMonth } from '../util/format.js';
  import { niceTicks, fmtAxis } from './scale.js';
  import ChartTip from './ChartTip.svelte';

  let { data = [], height = 270, onselect = null } = $props();

  let W = $state(0);
  let wrap = $state(null);
  let hi = $state(-1);
  let tip = $state({ x: 0, y: 0 });

  const rows = $derived((data || []).filter((r) => r && r.month));
  const m = $derived({ l: W < 480 ? 38 : 48, r: 8, t: 10, b: 26 });

  const G = $derived.by(() => {
    if (!W || !rows.length) return null;
    const iw = Math.max(10, W - m.l - m.r), ih = height - m.t - m.b;
    const maxI = Math.max(1, ...rows.map((r) => r.income || 0));
    const maxE = Math.max(1, ...rows.map((r) => r.expense || 0));
    const nets = rows.map((r) => r.net ?? (r.income || 0) - (r.expense || 0));
    const top = Math.max(maxI, ...nets, 1), bot = Math.max(maxE, ...nets.map((n) => -n), 1);
    const k = ih / (top + bot);
    const y0 = m.t + top * k;
    const step = iw / rows.length;
    const bw = Math.max(3, Math.min(34, step * 0.62));
    const bars = rows.map((r, i) => {
      const cx = m.l + step * (i + 0.5);
      return { r, i, cx, x: cx - bw / 2, hi: (r.income || 0) * k, he: (r.expense || 0) * k, ny: y0 - nets[i] * k, band: m.l + step * i };
    });
    const ticks = niceTicks(-bot, top, 4).map((v) => ({ v, y: y0 - v * k }));
    const net = line().curve(curveMonotoneX)(bars.map((b) => [b.cx, b.ny]));
    const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(iw / (W < 480 ? 46 : 54)))));
    return { bars, y0, bw, step, ticks, net, every, ih };
  });

  // oben gerundete Balken
  function barPath(x, y0, w, h, up) {
    if (h <= 0.4) return '';
    const r = Math.min(4, w / 2, h);
    return up
      ? `M${x},${y0}V${y0 - h + r}Q${x},${y0 - h} ${x + r},${y0 - h}H${x + w - r}Q${x + w},${y0 - h} ${x + w},${y0 - h + r}V${y0}Z`
      : `M${x},${y0}V${y0 + h - r}Q${x},${y0 + h} ${x + r},${y0 + h}H${x + w - r}Q${x + w},${y0 + h} ${x + w},${y0 + h - r}V${y0}Z`;
  }
  function setHi(i, e) {
    hi = i;
    if (e && wrap) { const r = wrap.getBoundingClientRect(); tip = { x: G.bars[i].cx, y: Math.max(50, e.clientY - r.top) }; }
    else if (G) tip = { x: G.bars[i].cx, y: G.y0 - 20 };
  }
  function onMove(e) {
    if (!G || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - m.l) / G.step);
    if (i < 0 || i >= G.bars.length) { hi = -1; return; }
    setHi(i, e);
  }
  // Klick/Tippen berechnet den Monat aus der Position (bei Touch ist hi nach pointerleave schon zurückgesetzt)
  function onClick(e) {
    if (!G || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - m.l) / G.step);
    if (i >= 0 && i < G.bars.length) onselect?.(rows[i].month);
  }
  function onKey(e) {
    if (!G) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setHi(Math.max(0, Math.min(G.bars.length - 1, (hi < 0 ? G.bars.length - 1 : hi) + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if ((e.key === 'Enter' || e.key === ' ') && hi >= 0) { e.preventDefault(); onselect?.(rows[hi].month); }
  }
  const sel = $derived(hi >= 0 ? rows[hi] : null);
</script>

<div class="mb" bind:this={wrap} bind:clientWidth={W} style="min-height:{height}px">
  <div class="legend small muted">
    <span><i class="dot" style="background:var(--good)"></i>Einnahmen</span>
    <span><i class="dot" style="background:var(--bad)"></i>Ausgaben</span>
    <span><i class="dot" style="background:var(--text)"></i>Netto</span>
  </div>
  {#if G}
    <svg width={W} {height} viewBox="0 0 {W} {height}" role="img" aria-label="Einnahmen und Ausgaben je Monat" tabindex="0"
      onpointermove={onMove} onpointerleave={() => (hi = -1)} onkeydown={onKey} onblur={() => (hi = -1)}
      onclick={onClick}>
      {#each G.ticks as t}
        <line x1={m.l} x2={W - m.r} y1={t.y} y2={t.y} class={t.v === 0 ? 'zero' : 'grid'} />
        <text x={m.l - 8} y={t.y + 4} text-anchor="end" class="ax">{fmtAxis(t.v)}</text>
      {/each}
      {#if hi >= 0}<rect x={G.bars[hi].band} y={m.t} width={G.step} height={G.ih} rx="6" class="band" />{/if}
      {#each G.bars as b (b.r.month)}
        <g class:fade={hi >= 0 && hi !== b.i} style="--d:{Math.min(b.i, 24) * 22}ms">
          <path d={barPath(b.x, G.y0, G.bw, b.hi, true)} class="up" fill="var(--good)" />
          <path d={barPath(b.x, G.y0, G.bw, b.he, false)} class="dn" fill="var(--bad)" fill-opacity=".72" />
        </g>
      {/each}
      <path d={G.net} fill="none" stroke="var(--text)" stroke-width="1.8" stroke-linecap="round" class="net" pathLength="1" />
      {#each G.bars as b (b.r.month)}
        <circle cx={b.cx} cy={b.ny} r={hi === b.i ? 4.5 : G.bars.length > 24 ? 0 : 3} class="ndot" />
      {/each}
      {#each G.bars as b (b.r.month)}
        {#if b.i % G.every === 0 || b.i === hi}
          <text x={b.cx} y={height - 8} text-anchor="middle" class="ax" class:strong={b.i === hi}>{fmtMonth(b.r.month)}</text>
        {/if}
      {/each}
    </svg>
    <ChartTip show={!!sel} x={tip.x} y={tip.y} width={W}>
      {#if sel}
        <div class="tt-h"><b>{fmtMonth(sel.month)}</b></div>
        <div class="tt-r"><span class="muted"><i class="dot" style="background:var(--good)"></i> Einnahmen</span><span class="num">{fmtEUR(sel.income || 0)}</span></div>
        <div class="tt-r"><span class="muted"><i class="dot" style="background:var(--bad)"></i> Ausgaben</span><span class="num">{fmtEUR(sel.expense || 0)}</span></div>
        {@const n = sel.net ?? (sel.income || 0) - (sel.expense || 0)}
        <div class="tt-r tot"><span class="muted"><i class="dot" style="background:var(--text)"></i> Netto</span><span class="num" class:pos={n > 0} class:negc={n < 0}>{fmtEUR(n, { sign: true })}</span></div>
      {/if}
    </ChartTip>
  {:else}
    <div class="faint small none">Keine Monatsdaten</div>
  {/if}
</div>

<style>
  .mb { position: relative; width: 100%; }
  .legend { display: flex; gap: 14px; margin-bottom: 4px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  svg { display: block; overflow: visible; outline: none; cursor: default; }
  svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 8px; }
  .grid { stroke: var(--border); stroke-dasharray: 2 4; }
  .zero { stroke: var(--text-3); stroke-opacity: .5; }
  .ax { font-size: 11px; fill: var(--text-3); font-variant-numeric: tabular-nums; font-family: var(--font); }
  .ax.strong { fill: var(--text); font-weight: 600; }
  .band { fill: var(--surface-2); }
  .up, .dn { transform-box: fill-box; animation: grow .65s cubic-bezier(.3,.8,.3,1) both; animation-delay: var(--d, 0ms); transition: opacity .15s; }
  .up { transform-origin: bottom; } .dn { transform-origin: top; }
  g.fade { opacity: .45; transition: opacity .15s; }
  .net { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1s ease .35s forwards; }
  .ndot { fill: var(--surface); stroke: var(--text); stroke-width: 1.8; transition: r .12s; }
  @keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  .tt-h { margin-bottom: 4px; }
  .tt-r { display: flex; justify-content: space-between; gap: 14px; margin-top: 2px; }
  .tt-r.tot { border-top: 1px solid var(--border); padding-top: 4px; margin-top: 5px; font-weight: 600; }
  .dot { vertical-align: 0; }
  .none { display: grid; place-items: center; min-height: 160px; }
  @media (prefers-reduced-motion: reduce) { .up, .dn { animation: none; } .net { animation: none; stroke-dashoffset: 0; } }
</style>
