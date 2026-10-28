<script>
  // Kleine Verlaufslinie. values: number[] oder [{value}] / [{net}] …
  import { line, area, curveMonotoneX } from 'd3-shape';
  let { values = [], height = 28, width = null, color = 'var(--accent)', fill = true, strokeWidth = 1.6, key = 'value', dot = true } = $props();

  const uid = 'sp' + Math.random().toString(36).slice(2, 8);
  const nums = $derived((values || []).map((v) => (typeof v === 'number' ? v : Number(v?.[key] ?? v?.value ?? 0))).filter(Number.isFinite));
  const VW = 100;
  const geo = $derived.by(() => {
    if (nums.length < 2) return null;
    const mn = Math.min(...nums), mx = Math.max(...nums);
    const span = mx - mn || 1;
    const pad = 3;
    const x = (i) => (i / (nums.length - 1)) * VW;
    const y = (v) => pad + (1 - (v - mn) / span) * (height - pad * 2);
    const pts = nums.map((v, i) => [x(i), y(v)]);
    const l = line().curve(curveMonotoneX)(pts);
    const a = area().x((d) => d[0]).y0(height).y1((d) => d[1]).curve(curveMonotoneX)(pts);
    return { l, a, last: pts[pts.length - 1] };
  });
</script>
{#if geo}
  <svg class="sp" style={width ? `width:${width}px` : 'width:100%'} {height} viewBox="0 0 {VW} {height}" preserveAspectRatio="none" aria-hidden="true">
    {#if fill}
      <defs><linearGradient id="{uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color={color} stop-opacity=".28" /><stop offset="1" stop-color={color} stop-opacity="0" /></linearGradient></defs>
      <path d={geo.a} fill="url(#{uid})" />
    {/if}
    <path d={geo.l} fill="none" stroke={color} stroke-width={strokeWidth} stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  </svg>
{:else}
  <svg class="sp" style={width ? `width:${width}px` : 'width:100%'} {height} aria-hidden="true"></svg>
{/if}
<style>
  .sp { display: block; overflow: visible; }
</style>
