<script>
  // Brutto -> Abgaben -> Netto als gestapelter Balken, plus USt-/Kapitalertragsteuer-Schätzung.
  import { fmtEUR } from '../util/format.js';
  import Tip from '../ui/Tip.svelte';

  // taxes: insights.taxes
  let { taxes = null, compact = false } = $props();

  const SEGS = [
    ['lohnsteuer', 'Lohnsteuer'], ['soli', 'Solidaritätszuschlag'], ['kirchensteuer', 'Kirchensteuer'],
    ['kv', 'Krankenversicherung'], ['pv', 'Pflegeversicherung'], ['rv', 'Rentenversicherung'], ['av', 'Arbeitslosenversicherung'],
  ];
  const shade = (i, n) => `color-mix(in srgb, var(--tax) ${Math.round(100 - (i / Math.max(1, n - 1)) * 52)}%, var(--surface))`;

  const pay = $derived(taxes?.payroll || null);
  const parts = $derived.by(() => {
    if (!pay) return [];
    const base = SEGS.map(([k, label]) => ({ k, label, value: Math.max(0, pay[k] || 0) })).filter((s) => s.value > 0);
    const out = base.map((s, i) => ({ ...s, color: shade(i, base.length) }));
    const net = pay.net ?? Math.max(0, (pay.gross || 0) - base.reduce((a, s) => a + s.value, 0));
    if (net > 0) out.push({ k: 'net', label: 'Netto', value: net, color: 'var(--good)' });
    return out;
  });
  const gross = $derived(pay?.gross || parts.reduce((a, s) => a + s.value, 0));
  const deductions = $derived(parts.filter((s) => s.k !== 'net').reduce((a, s) => a + s.value, 0));
  const pct = (v) => (gross ? (v / gross) * 100 : 0);
  const fmtPct = (p) => (p >= 10 ? p.toFixed(0) : p.toFixed(1).replace('.', ',')) + ' %';

  const vat = $derived(taxes?.vatEstimate?.total || 0);
  const cg = $derived(taxes?.capitalGainsTax || 0);
  let hover = $state(null);
</script>

<div class="tb" class:compact>
  {#if pay && parts.length}
    <div class="sum">
      <div class="s1"><span class="muted small">Brutto</span><b class="num">{fmtEUR(gross)}</b></div>
      <div class="s1"><span class="muted small">Abgaben</span><b class="num tx">{fmtEUR(deductions)} <span class="small faint">{fmtPct(pct(deductions))}</span></b></div>
      <div class="s1"><span class="muted small">Netto</span><b class="num pos">{fmtEUR(pay.net ?? gross - deductions)}</b></div>
    </div>
    <div class="bar" role="img" aria-label="Aufteilung von Brutto in Abgaben und Netto">
      {#each parts as s (s.k)}
        <span class="seg" class:dim={hover && hover !== s.k} style="flex:{s.value};background:{s.color}" title="{s.label}: {fmtEUR(s.value)} ({fmtPct(pct(s.value))})"
          onpointerenter={() => (hover = s.k)} onpointerleave={() => (hover = null)} role="presentation"></span>
      {/each}
    </div>
    <ul class="leg">
      {#each parts as s (s.k)}
        <li class:dim={hover && hover !== s.k} onpointerenter={() => (hover = s.k)} onpointerleave={() => (hover = null)}>
          <i class="dot" style="background:{s.color}"></i>
          <span class="ellipsis">{s.label}</span>
          <span class="faint small num">{fmtPct(pct(s.value))}</span>
          <span class="num v">{fmtEUR(s.value)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if vat > 0 || cg > 0 || !pay}
    <ul class="est" class:top={!!pay}>
      <li>
        <span class="ellipsis">Umsatzsteuer <span class="badge tax">geschätzt</span><Tip text="Aus Belegen mit ausgewiesener USt; fehlende Belege werden anhand der Kategorien geschätzt. Keine Steuerberechnung." /></span>
        <span class="num v">{vat > 0 ? fmtEUR(vat) : '–'}</span>
      </li>
      <li>
        <span class="ellipsis">Kapitalertragsteuer<Tip text="Laut Steuerbescheinigungen der Depotbanken, sonst geschätzt." /></span>
        <span class="num v">{cg > 0 ? fmtEUR(cg) : '–'}</span>
      </li>
    </ul>
  {/if}
  {#if taxes && taxes.total > 0 && !compact}
    <div class="total small muted">Abgabenquote <b class="num">{taxes.quote != null ? fmtPct(taxes.quote * 100) : '–'}</b></div>
  {/if}
</div>

<style>
  .tb { display: flex; flex-direction: column; gap: 12px; }
  .sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .s1 { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .s1 b { font-size: 15px; letter-spacing: -.01em; }
  .s1 b .small { display: block; font-weight: 500; }
  .tx { color: var(--tax); }
  .bar { display: flex; height: 14px; border-radius: 8px; overflow: hidden; gap: 2px; background: var(--surface-2); }
  .seg { min-width: 2px; transition: opacity .15s, filter .15s; animation: wipe .8s cubic-bezier(.3,.8,.3,1) both; transform-origin: left; }
  .seg:first-child { border-radius: 8px 3px 3px 8px; } .seg:last-child { border-radius: 3px 8px 8px 3px; }
  .seg.dim { opacity: .35; }
  @keyframes wipe { from { transform: scaleX(0); opacity: 0; } to { transform: none; opacity: 1; } }
  .leg, .est { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .leg li { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 6px; transition: opacity .15s, background .15s; }
  .leg li:hover { background: var(--surface-2); }
  .leg li.dim { opacity: .45; }
  .leg .ellipsis { flex: 1; min-width: 0; }
  .v { font-weight: 600; min-width: 62px; text-align: right; }
  .est { gap: 4px; }
  .est.top { border-top: 1px solid var(--border); padding-top: 10px; }
  .est li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 4px; }
  .est .ellipsis { display: inline-flex; align-items: center; gap: 6px; }
  .total { text-align: right; }
  .compact .leg li { padding: 2px 4px; font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { .seg { animation: none; } }
</style>
