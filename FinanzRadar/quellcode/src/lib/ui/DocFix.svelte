<script>
  // Schnellaktionen für unlesbare/unsichere Belege: „Neu prüfen“ (zweiter OCR-Lauf) und „Ist eher: X“ (Typ erzwingen)
  import { reprocessDoc } from '../store/state.svelte.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import Icon from './Icon.svelte';

  let { doc, size = 'sm', ondone = null } = $props();
  let busy = $state(false);

  const alts = $derived((Array.isArray(doc?.alternatives) ? doc.alternatives : [])
    .filter(a => a?.type && a.type !== doc.type && TYPE_LABELS[a.type])
    .slice(0, 3));
  const typeName = (t) => (t === 'irrelevant' ? 'Kein Finanzdokument' : TYPE_LABELS[t]?.name || t);

  async function run(opts) {
    if (busy) return;
    busy = true;
    try { if (await reprocessDoc(doc, opts)) ondone?.(); } finally { busy = false; }
  }
</script>

<span class="fix" class:busy>
  <button class="btn" class:btn-sm={size === 'sm'} onclick={() => run({ ocrBoost: true })} disabled={busy} title="Datei mit höherer Auflösung erneut lesen">
    <Icon name="refresh" size={14} />{busy ? 'Prüfe …' : 'Neu prüfen'}
  </button>
  {#each alts as a (a.type)}
    <button class="btn btn-ghost" class:btn-sm={size === 'sm'} onclick={() => run({ forceType: a.type })} disabled={busy}>
      Ist eher: {typeName(a.type)}{#if a.confidence != null}<span class="faint num">&nbsp;{Math.round(a.confidence * 100)} %</span>{/if}
    </button>
  {/each}
</span>

<style>
  .fix { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .fix.busy { opacity: .7; }
</style>
