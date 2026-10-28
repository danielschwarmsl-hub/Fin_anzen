<script>
  import Tip from './Tip.svelte';
  import Icon from './Icon.svelte';
  import { fmtEUR } from '../util/format.js';
  let { label, value, format = 'eur', tip = null, delta = null, icon = null, tone = null, sub = null } = $props();
  const shown = $derived(format === 'eur' ? fmtEUR(value, { compact: Math.abs(value) >= 100000000 }) : format === 'pct' ? (value == null ? '–' : (value * 100).toFixed(1).replace('.', ',') + ' %') : String(value ?? '–'));
</script>
<div class="stat card">
  <div class="lbl">{#if icon}<span class="ic {tone || ''}"><Icon name={icon} size={15} /></span>{/if}<span>{label}</span>{#if tip}<Tip text={tip} />{/if}</div>
  <div class="val num {tone || ''}">{shown}</div>
  {#if sub || delta != null}<div class="sub small muted">{#if delta != null}<span class:pos={delta >= 0} class:negc={delta < 0}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)} %</span>{/if} {sub || ''}</div>{/if}
</div>
<style>
  .stat { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
  .lbl { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 12.5px; font-weight: 550; }
  .ic { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; background: var(--surface-2); color: var(--text-2); }
  .ic.good { background: var(--good-soft); color: var(--good); } .ic.bad { background: var(--bad-soft); color: var(--bad); }
  .ic.accent { background: var(--accent-soft); color: var(--accent); } .ic.tax { color: var(--tax); background: color-mix(in srgb, var(--tax) 14%, transparent); }
  .val { font-size: 25px; font-weight: 700; letter-spacing: -.02em; }
  .val.good { color: var(--good); } .val.bad { color: var(--bad); }
</style>
