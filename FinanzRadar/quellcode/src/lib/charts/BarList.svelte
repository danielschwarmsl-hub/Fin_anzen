<script>
  // Horizontale Rangliste. items: [{ label, value, color, sub, id }]
  import { fmtEUR } from '../util/format.js';
  let { items = [], max = 8, onselect = null, format = (v) => fmtEUR(v), color = 'var(--accent)' } = $props();

  const shown = $derived((items || []).filter((i) => i && i.value > 0).slice(0, max));
  const top = $derived(Math.max(1, ...shown.map((i) => i.value)));
</script>
{#if shown.length}
  <ul class="bl">
    {#each shown as it, i (it.id ?? it.label)}
      <li style="--d:{i * 40}ms">
        <button type="button" class="row-btn" disabled={!onselect} onclick={() => onselect?.(it)} title={it.label}>
          <span class="top">
            <span class="lbl ellipsis">{it.label}</span>
            <span class="val num">{format(it.value)}</span>
          </span>
          <span class="track"><span class="fill" style="width:{(it.value / top) * 100}%; background:{it.color || color}"></span></span>
          {#if it.sub}<span class="sub small faint ellipsis">{it.sub}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
{:else}
  <div class="faint small none">Keine Daten</div>
{/if}
<style>
  .bl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .row-btn { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 7px 8px; border-radius: 9px; cursor: pointer; transition: background .15s; }
  .row-btn:disabled { cursor: default; }
  .row-btn:not(:disabled):hover { background: var(--surface-2); }
  .row-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
  .lbl { font-weight: 550; min-width: 0; }
  .val { font-weight: 600; color: var(--text); }
  .track { height: 6px; border-radius: 6px; background: var(--surface-2); overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 6px; transform-origin: left; animation: grow .7s cubic-bezier(.3,.8,.3,1) both; animation-delay: var(--d); transition: width .4s ease; }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .none { padding: 18px 0; text-align: center; }
  @media (prefers-reduced-motion: reduce) { .fill { animation: none; } }
</style>
