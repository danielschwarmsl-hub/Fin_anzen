<script>
  import { app } from '../store/state.svelte.js';
  import { pauseImport, resumeImport, cancelImport } from '../store/importer.js';
  import Icon from '../ui/Icon.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import { TYPE_LABELS } from '../parsers/naming.js';
  let { compact = false } = $props();
  const p = app.progress;
  const pct = $derived(p.total ? Math.round((p.done / p.total) * 100) : 0);
  const label = (t) => (t === 'irrelevant' ? 'Ohne Finanzbezug' : TYPE_LABELS?.[t]?.name || TYPE_LABELS?.[t]?.label || t);
  const icon = (t) => TYPE_LABELS?.[t]?.icon || 'file';
  const PHASES = { collect: 'Sammeln', process: 'Lesen', analyze: 'Analysieren', ai: 'KI', done: 'Fertig' };
</script>

<div class="pb" class:compact>
  <div class="row">
    <span class="spinner" class:paused={p.paused}></span>
    <strong>{PHASES[p.phase] || 'Verarbeiten'}</strong>
    <span class="muted num">{p.done} / {p.total}</span>
    <span class="grow ellipsis faint small">{p.current}</span>
    {#if p.phase === 'process'}
      {#if p.paused}<button class="btn btn-sm" onclick={resumeImport}><Icon name="play" size={14} />Weiter</button>
      {:else}<button class="btn btn-sm" onclick={pauseImport}><Icon name="pause" size={14} />Pause</button>{/if}
      <button class="btn btn-sm btn-ghost btn-danger" onclick={cancelImport}><Icon name="stop" size={14} />Abbrechen</button>
    {/if}
  </div>
  <div class="bar"><div class="fill" style="width:{p.phase === 'analyze' || p.phase === 'ai' ? 100 : pct}%"></div></div>
  {#if !compact}
    <div class="row wrap counts">
      {#each Object.entries(p.counts) as [t, n]}
        <span class="chip"><Icon name={icon(t)} size={14} />{label(t)} <strong class="num">{n}</strong></span>
      {/each}
      {#if p.skipped}<span class="chip faint">Bekannt/doppelt <strong class="num">{p.skipped}</strong></span>{/if}
    </div>
    {#if p.errors.length}
      <Collapsible title="Probleme" badge={p.errors.length}>
        <ul class="errs small">{#each p.errors as e}<li><span class="mono">{e.name}</span> – {e.error}</li>{/each}</ul>
      </Collapsible>
    {/if}
  {/if}
</div>

<style>
  .pb { display: flex; flex-direction: column; gap: 10px; }
  .pb.compact { padding: 10px 28px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .bar { height: 6px; border-radius: 6px; background: var(--surface-2); overflow: hidden; }
  .fill { height: 100%; background: linear-gradient(90deg, var(--accent), #20c997); border-radius: 6px; transition: width .3s; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent); animation: spin .8s linear infinite; }
  .spinner.paused { animation: none; border-color: var(--warn); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .counts { gap: 6px; }
  .errs { margin: 0; padding-left: 16px; max-height: 200px; overflow: auto; }
</style>
