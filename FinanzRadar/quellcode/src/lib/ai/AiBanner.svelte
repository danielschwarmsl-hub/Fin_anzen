<script>
  // Schwebender KI-Status: Fortschritt, Hochrechnung und 6-Minuten-Empfehlung
  import { ai, cancelAi, switchToSmaller, SLOW_MS } from './engine.svelte.js';
  import { app, setView, toast } from '../store/state.svelte.js';
  import Icon from '../ui/Icon.svelte';
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const pct = $derived(ai.total ? Math.round((ai.done / ai.total) * 100) : 0);
  async function smaller() {
    if (await switchToSmaller()) toast('Kleineres Modell aktiv: ' + app.settings.ai.model, { tone: 'good' });
  }
  function copy(t) { navigator.clipboard?.writeText(t); toast('Befehl kopiert'); }
</script>

{#if ai.running}
  <div class="aib fade-up" class:slow={ai.slow}>
    <div class="row">
      <span class="ic"><Icon name="sparkles" size={15} /></span>
      <div class="grow">
        <div class="row small"><strong>KI arbeitet</strong><span class="faint num">{ai.done}/{ai.total} · {mmss(ai.elapsedMs)}{#if ai.projectedMs} / ~{mmss(ai.projectedMs)}{/if}</span></div>
        <div class="small faint ellipsis">{ai.label}</div>
      </div>
      <button class="btn btn-sm btn-ghost btn-icon" title="Stoppen" onclick={cancelAi}><Icon name="stop" size={14} /></button>
    </div>
    <div class="bar"><div class="fill" style="width:{pct}%"></div></div>
    {#if ai.slow}
      <div class="warn small">
        <Icon name="clock" size={14} />
        <span class="grow">{ai.elapsedMs > SLOW_MS ? 'Läuft länger als 6 Minuten.' : 'Dauert voraussichtlich über 6 Minuten.'}{#if ai.slow.suggestion}{' '}Kleineres Modell empfohlen: <strong>{ai.slow.suggestion.name}</strong>{/if}</span>
      </div>
      <div class="row wrap">
        {#if ai.slow.suggestion?.installed}
          <button class="btn btn-sm btn-primary" onclick={smaller}>Wechseln</button>
        {:else if ai.slow.suggestion}
          <button class="btn btn-sm" onclick={() => copy('ollama pull ' + ai.slow.suggestion.name)}><Icon name="copy" size={13} />ollama pull {ai.slow.suggestion.name}</button>
        {/if}
        <button class="btn btn-sm btn-ghost" onclick={() => { ai.slow = null; ai.dismissedSlow = true; }}>Weiterlaufen lassen</button>
        <button class="btn btn-sm btn-ghost" onclick={() => setView('settings')}>Einstellungen</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .aib { position: fixed; right: 20px; bottom: 20px; width: min(380px, calc(100vw - 40px)); padding: 12px 14px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-lg); z-index: 110; display: flex; flex-direction: column; gap: 8px; }
  .aib.slow { border-color: var(--warn); }
  .ic { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .bar { height: 4px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width .3s; }
  .warn { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 9px; background: var(--warn-soft); color: var(--text); }
</style>
