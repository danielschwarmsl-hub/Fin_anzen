<script>
  // Fortschritt während des Imports; mit `report` der kompakte Importbericht danach
  import { app, live, setView } from '../store/state.svelte.js';
  import { pauseImport, resumeImport, cancelImport } from '../store/importer.js';
  import Icon from '../ui/Icon.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import Tip from '../ui/Tip.svelte';
  let { compact = false, report = false, ondismiss = null } = $props();
  const p = app.progress;
  const pct = $derived(p.total ? Math.round((p.done / p.total) * 100) : 0);
  const label = (t) => (t === 'irrelevant' ? 'Ohne Finanzbezug' : TYPE_LABELS?.[t]?.name || TYPE_LABELS?.[t]?.label || t);
  const icon = (t) => TYPE_LABELS?.[t]?.icon || 'file';
  const PHASES = { collect: 'Sammeln', process: 'Lesen', analyze: 'Analysieren', ai: 'KI', done: 'Fertig' };

  // Importbericht: nichts verschwindet still
  const rep = $derived({
    neu: p.newTx || 0,
    docs: p.newDocs || 0,
    dupTx: p.dupTx || 0,
    dupFiles: p.skipped || 0,
    enriched: p.enrichedTx || 0,
    ignored: p.counts?.irrelevant || 0,
    errors: p.errors?.length || 0,
    review: live.reviewCount || 0,
  });
</script>

{#if report}
<div class="rep row wrap" role="status">
  <Icon name="check" size={15} />
  <span><b class="num">{rep.neu}</b> neu<Tip text={`${rep.neu} Buchungen aus ${rep.docs} Dokumenten`} /></span>
  <span class="sep">·</span>
  <span><b class="num">{rep.dupTx + rep.dupFiles}</b> Dubletten übersprungen<Tip text={`${rep.dupTx} Buchungen, ${rep.dupFiles} bereits bekannte Dateien`} /></span>
  <span class="sep">·</span>
  <span><b class="num">{rep.enriched}</b> ergänzt</span>
  <span class="sep">·</span>
  <span><b class="num">{rep.ignored}</b> ignoriert</span>
  {#if rep.errors}<span class="sep">·</span><span class="negc"><b class="num">{rep.errors}</b> Fehler</span>{/if}
  <span class="sep">·</span>
  {#if rep.review}
    <button class="btn btn-sm btn-primary" onclick={() => setView('review')}><b class="num">{rep.review}</b>&nbsp;brauchen dich<Icon name="arrowRight" size={14} /></button>
  {:else}<span class="good"><b class="num">0</b> brauchen dich</span>{/if}
  {#if ondismiss}<span class="grow"></span><button class="btn btn-ghost btn-icon btn-sm" onclick={ondismiss} aria-label="Bericht schließen"><Icon name="x" size={14} /></button>{/if}
</div>
{:else}

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
{/if}

<style>
  .rep { gap: 6px; align-items: center; font-size: 13px; }
  .rep .sep { color: var(--text-3); }
  .rep .good { color: var(--good); }
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
