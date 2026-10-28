<script>
  // Flächen-/Linienchart für [{ date, value }] (Cent)
  import { line, area, curveMonotoneX } from 'd3-shape';
  import { fmtEUR, fmtDate } from '../util/format.js';
  import { niceTicks, fmtAxis } from './scale.js';
  import ChartTip from './ChartTip.svelte';

  let { series = [], height = 220, color = 'var(--accent)', label = 'Nettovermögen' } = $props();

  const uid = 'nw' + Math.random().toString(36).slice(2, 8);
  let W = $state(0);
  let wrap = $state(null);
  let hi = $state(-1);
  let tip = $state({ x: 0, y: 0 });

  const pts = $derived.by(() => {
    let s = (series || []).filter((p) => p && p.date && Number.isFinite(p.value)).map((p) => ({ date: p.date, value: p.value, t: Date.parse(p.date + 'T12:00:00Z') }));
    s.sort((a, b) => a.t - b.t);
    if (s.length > 480) { const k = Math.ceil(s.length / 480); const last = s[s.length - 1]; s = s.filter((_, i) => i % k === 0); if (s[s.length - 1] !== last) s.push(last); }
    return s;
  });

  const m = $derived({ l: W < 480 ? 40 : 52, r: 70, t: 14, b: 24 });
  const G = $derived.by(() => {
    if (!W || pts.length < 2) return null;
    const iw = Math.max(10, W - m.l - m.r), ih = height - m.t - m.b;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    let mn = Math.min(...pts.map((p) => p.value)), mx = Math.max(...pts.map((p) => p.value));
    if (mn === mx) { mn -= Math.abs(mn) * 0.05 + 100; mx += Math.abs(mx) * 0.05 + 100; }
    const padv = (mx - mn) * 0.12;
    const lo = mn >= 0 && mn - padv < 0 ? 0 : mn - padv, hiV = mx + padv;
    const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * iw;
    const y = (v) => m.t + (1 - (v - lo) / (hiV - lo)) * ih;
    const P = pts.map((p) => [x(p.t), y(p.value)]);
    const d = line().curve(curveMonotoneX)(P);
    const a = area().x((q) => q[0]).y0(m.t + ih).y1((q) => q[1]).curve(curveMonotoneX)(P);
    const ticks = niceTicks(lo, hiV, 3).map((v) => ({ v, y: y(v) }));
    const nx = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    const xt = Array.from({ length: nx }, (_, i) => { const t = t0 + ((t1 - t0) * i) / (nx - 1); const d = new Date(t).toISOString().slice(0, 10); return { x: x(t), label: t1 - t0 > 86400000 * 200 ? d.slice(5, 7) + '/' + d.slice(2, 4) : fmtDate(d, { short: true }), anchor: i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle' }; });
    return { P, d, a, ticks, xt, ih, last: P[P.length - 1] };
  });

  function onMove(e) {
    if (!G || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0, bd = Infinity;
    for (let i = 0; i < G.P.length; i++) { const dd = Math.abs(G.P[i][0] - px); if (dd < bd) { bd = dd; best = i; } }
    hi = best; tip = { x: G.P[best][0], y: Math.max(40, G.P[best][1] - 18) };
  }
  function onKey(e) {
    if (!G) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      hi = Math.max(0, Math.min(G.P.length - 1, (hi < 0 ? G.P.length - 1 : hi) + (e.key === 'ArrowLeft' ? -1 : 1)));
      tip = { x: G.P[hi][0], y: Math.max(40, G.P[hi][1] - 18) };
    }
  }
  const first = $derived(pts[0]);
  const lastP = $derived(pts[pts.length - 1]);
</script>

<div class="nw" bind:this={wrap} bind:clientWidth={W} style="min-height:{height}px">
  {#if G}
    <svg width={W} {height} viewBox="0 0 {W} {height}" role="img" aria-label="{label} im Zeitverlauf" tabindex="0"
      onpointermove={onMove} onpointerleave={() => (hi = -1)} onkeydown={onKey} onblur={() => (hi = -1)}>
      <defs>
        <linearGradient id="{uid}-f" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={color} stop-opacity=".32" /><stop offset="1" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      {#each G.ticks as t}
        <line x1={m.l} x2={W - m.r} y1={t.y} y2={t.y} class="grid" />
        <text x={m.l - 8} y={t.y + 4} text-anchor="end" class="ax">{fmtAxis(t.v)}</text>
      {/each}
      {#each G.xt as t}
        <text x={t.x} y={height - 6} text-anchor={t.anchor} class="ax">{t.label}</text>
      {/each}
      <path d={G.a} fill="url(#{uid}-f)" class="area" />
      <path d={G.d} fill="none" stroke={color} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="ln" pathLength="1" />
      {#if hi >= 0}
        <line x1={G.P[hi][0]} x2={G.P[hi][0]} y1={m.t} y2={m.t + G.ih} class="cross" />
        <circle cx={G.P[hi][0]} cy={G.P[hi][1]} r="5" fill={color} stroke="var(--surface)" stroke-width="2" />
      {:else}
        <circle cx={G.last[0]} cy={G.last[1]} r="4.5" fill={color} stroke="var(--surface)" stroke-width="2" />
        <g class="pill" transform="translate({Math.min(G.last[0] + 10, W - 4)},{G.last[1]})">
          <text x="0" y="4" class="lastv">{fmtEUR(lastP.value, { compact: true })}</text>
        </g>
      {/if}
    </svg>
    <ChartTip show={hi >= 0} x={tip.x} y={tip.y} width={W}>
      {#if hi >= 0}
        <div class="muted small">{fmtDate(pts[hi].date)}</div>
        <div class="tv num">{fmtEUR(pts[hi].value)}</div>
        {#if hi > 0}<div class="small num" class:pos={pts[hi].value - first.value >= 0} class:negc={pts[hi].value - first.value < 0}>{fmtEUR(pts[hi].value - first.value, { sign: true, compact: true })} seit Beginn</div>{/if}
      {/if}
    </ChartTip>
  {:else if pts.length === 1}
    <div class="one"><span class="num big">{fmtEUR(pts[0].value)}</span><span class="faint small">{fmtDate(pts[0].date)}</span></div>
  {:else}
    <div class="faint small none">Kein Verlauf</div>
  {/if}
</div>

<style>
  .nw { position: relative; width: 100%; }
  svg { display: block; overflow: visible; outline: none; }
  svg:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 8px; }
  .grid { stroke: var(--border); stroke-dasharray: 2 4; }
  .ax { font-size: 11px; fill: var(--text-3); font-variant-numeric: tabular-nums; font-family: var(--font); }
  .cross { stroke: var(--text-3); stroke-dasharray: 3 3; }
  .lastv { font-size: 12px; font-weight: 700; fill: var(--text); font-variant-numeric: tabular-nums; font-family: var(--font); }
  .ln { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.1s cubic-bezier(.4,.1,.2,1) .05s forwards; }
  .area { opacity: 0; animation: fade .8s ease .5s forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes fade { to { opacity: 1; } }
  .tv { font-size: 15px; font-weight: 700; }
  .one { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; height: 100%; min-height: inherit; }
  .big { font-size: 24px; font-weight: 700; }
  .none { display: grid; place-items: center; min-height: inherit; }
  @media (prefers-reduced-motion: reduce) { .ln, .area { animation: none; stroke-dashoffset: 0; opacity: 1; } }
</style>
