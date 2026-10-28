<script>
  // Donut + Rangliste der Ausgabenkategorien.
  import { pie, arc } from 'd3-shape';
  import { fmtEUR } from '../util/format.js';
  import Icon from '../ui/Icon.svelte';

  // items: insights.byCategory  [{id,label,color,amount,share,subs:[{id,label,amount}]}]
  // prev:  optional byCategory der Vorperiode (für Delta)
  let { items = [], prev = null, total = null, centerLabel = 'Ausgaben', onselect = null, limit = 8, size = 188 } = $props();

  let hover = $state(null);
  let open = $state({});
  let showAll = $state(false);

  const list = $derived((items || []).filter((c) => c && c.amount > 0).sort((a, b) => b.amount - a.amount));
  const sum = $derived(total ?? list.reduce((a, c) => a + c.amount, 0));
  const shown = $derived(showAll ? list : list.slice(0, limit));
  const topAmt = $derived(list[0]?.amount || 1);
  const prevMap = $derived(prev ? new Map(prev.map((c) => [c.id, c.amount])) : null);

  const R = $derived(size / 2);
  const slices = $derived.by(() => {
    const p = pie().value((d) => d.amount).sort(null).padAngle(list.length > 1 ? 0.018 : 0);
    const a = arc().innerRadius(R * 0.66).outerRadius(R - 6).cornerRadius(3);
    const aHover = arc().innerRadius(R * 0.63).outerRadius(R - 1).cornerRadius(3);
    return p(list).map((s) => ({ id: s.data.id, d: a(s), dh: aHover(s), color: s.data.color }));
  });

  const cur = $derived(hover ? list.find((c) => c.id === hover) : null);
  const pct = (v) => (sum ? (v / sum) * 100 : 0);
  const fmtPct = (p) => (p >= 10 ? p.toFixed(0) : p.toFixed(1).replace('.', ',')) + ' %';

  function delta(c) {
    if (!prevMap) return null;
    const p = prevMap.get(c.id);
    if (!p || p <= 0) return null;
    return c.amount / p - 1;
  }
  const toggle = (id) => { open = { ...open, [id]: !open[id] }; };
</script>

{#if list.length}
  <div class="cb">
    <div class="donut" style="width:{size}px;height:{size}px">
      <svg width={size} height={size} viewBox="{-R} {-R} {size} {size}" role="img" aria-label="Verteilung der Ausgaben nach Kategorie">
        {#each slices as s (s.id)}
          <path d={hover === s.id ? s.dh : s.d} fill={s.color} class="sl" class:dim={hover && hover !== s.id}
            onpointerenter={() => (hover = s.id)} onpointerleave={() => (hover = null)} onclick={() => onselect?.(s.id)}
            role="presentation" />
        {/each}
      </svg>
      <div class="center">
        {#if cur}
          <span class="c-l ellipsis">{cur.label}</span>
          <span class="c-v num">{fmtEUR(cur.amount)}</span>
          <span class="c-s small muted num">{fmtPct(pct(cur.amount))}</span>
        {:else}
          <span class="c-l">{centerLabel}</span>
          <span class="c-v num">{fmtEUR(sum)}</span>
          <span class="c-s small muted">{list.length} Kategorien</span>
        {/if}
      </div>
    </div>

    <ul class="rank">
      {#each shown as c, i (c.id)}
        {@const dl = delta(c)}
        <li style="--d:{i * 35}ms" class:dim={hover && hover !== c.id}>
          <div class="line" onpointerenter={() => (hover = c.id)} onpointerleave={() => (hover = null)} role="presentation">
            <button type="button" class="exp" aria-label="Unterkategorien" aria-expanded={!!open[c.id]} disabled={!c.subs?.length} onclick={() => toggle(c.id)}>
              <span class="chev" class:on={open[c.id]}><Icon name="chevron" size={13} /></span>
            </button>
            <button type="button" class="main" onclick={() => onselect?.(c.id)} onfocus={() => (hover = c.id)} onblur={() => (hover = null)}>
              <span class="top">
                <span class="nm ellipsis"><i class="dot" style="background:{c.color}"></i>{c.label}</span>
                {#if dl != null && Math.abs(dl) >= 0.03}
                  <span class="dl small num" class:up={dl > 0} class:down={dl < 0} title="Veränderung zur Vorperiode">{dl > 0 ? '▲' : '▼'} {Math.abs(dl * 100).toFixed(0)} %</span>
                {/if}
                <span class="pc small faint num">{fmtPct(pct(c.amount))}</span>
                <span class="am num">{fmtEUR(c.amount)}</span>
              </span>
              <span class="track"><span class="fill" style="width:{(c.amount / topAmt) * 100}%;background:{c.color}"></span></span>
            </button>
          </div>
          {#if open[c.id] && c.subs?.length}
            <ul class="subs">
              {#each c.subs.filter((s) => s.amount > 0).sort((a, b) => b.amount - a.amount) as s (s.id)}
                <li>
                  <button type="button" class="sub small" onclick={() => onselect?.(c.id, s.id)}>
                    <span class="ellipsis muted">{s.label}</span>
                    <span class="num">{fmtEUR(s.amount)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
      {#if list.length > limit}
        <li><button type="button" class="btn btn-ghost btn-sm more" onclick={() => (showAll = !showAll)}>{showAll ? 'Weniger' : `Alle ${list.length} anzeigen`}</button></li>
      {/if}
    </ul>
  </div>
{:else}
  <div class="faint small none">Keine Ausgaben im Zeitraum</div>
{/if}

<style>
  .cb { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; }
  .donut { position: relative; flex: none; margin: 0 auto; }
  .sl { transition: d .18s ease, opacity .18s; cursor: pointer; animation: pop .6s cubic-bezier(.3,.8,.3,1) both; transform-origin: center; }
  .sl.dim { opacity: .35; }
  @keyframes pop { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 0 34px; pointer-events: none; text-align: center; }
  .c-l { font-size: 11.5px; color: var(--text-2); font-weight: 550; max-width: 100%; }
  .c-v { font-size: 17px; font-weight: 700; letter-spacing: -.02em; }
  .rank { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 1px; }
  .rank > li { animation: fade .4s ease both; animation-delay: var(--d); transition: opacity .15s; }
  .rank > li.dim { opacity: .5; }
  .line { display: flex; align-items: center; gap: 2px; }
  .exp { all: unset; box-sizing: border-box; width: 22px; height: 30px; display: grid; place-items: center; cursor: pointer; color: var(--text-3); border-radius: 6px; flex: none; }
  .exp:disabled { opacity: .25; cursor: default; }
  .exp:not(:disabled):hover { color: var(--text); background: var(--surface-2); }
  .exp:focus-visible { outline: 2px solid var(--accent); }
  .chev { display: inline-flex; transition: transform .15s; } .chev.on { transform: rotate(90deg); }
  .main { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; padding: 6px 8px; border-radius: 9px; cursor: pointer; transition: background .15s; }
  .main:hover { background: var(--surface-2); }
  .main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .nm { flex: 1; min-width: 0; font-weight: 550; display: flex; align-items: center; gap: 8px; }
  .am { font-weight: 600; min-width: 64px; text-align: right; }
  .pc { min-width: 38px; text-align: right; }
  .dl { color: var(--text-3); } .dl.up { color: var(--bad); } .dl.down { color: var(--good); }
  .track { height: 5px; border-radius: 5px; background: var(--surface-2); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 5px; transform-origin: left; animation: grow .7s cubic-bezier(.3,.8,.3,1) both; animation-delay: var(--d); }
  .subs { list-style: none; margin: 2px 0 6px 30px; padding: 0 0 0 10px; border-left: 2px solid var(--border); }
  .sub { all: unset; box-sizing: border-box; width: 100%; display: flex; justify-content: space-between; gap: 10px; padding: 4px 8px; border-radius: 7px; cursor: pointer; }
  .sub:hover { background: var(--surface-2); }
  .sub:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .more { margin: 4px 0 0 24px; }
  .none { padding: 24px 0; text-align: center; }
  @keyframes fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @media (max-width: 520px) { .pc { display: none; } .cb { gap: 12px; } }
  @media (prefers-reduced-motion: reduce) { .sl, .fill, .rank > li { animation: none; } }
</style>
