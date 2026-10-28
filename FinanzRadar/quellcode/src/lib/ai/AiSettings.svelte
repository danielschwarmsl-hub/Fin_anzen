<script>
  import { onMount } from 'svelte';
  import { app, saveSettings, toast } from '../store/state.svelte.js';
  import { ai, connect, benchmark, runOpenCases, cancelAi, installHooks } from './engine.svelte.js';
  import { ACCEL_LABEL } from './hardware.js';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Collapsible from '../ui/Collapsible.svelte';

  const s = app.settings.ai;
  let benching = $state(false);
  const textModels = $derived(ai.models.filter(m => !/embed/i.test(m.name)));
  const visionModels = $derived(ai.models.filter(m => ai.caps[m.name]?.vision));
  const canThink = $derived(!!ai.caps[s.model]?.thinking);
  const rec = $derived(ai.recommendation);
  const missingRec = $derived(rec && !ai.models.some(m => m.name === rec.text));
  const platformLabel = $derived(ai.platform ? (ai.platform.os === 'mac' ? (ai.platform.appleSilicon ? 'Mac mit Apple Silicon' : 'Mac') : ai.platform.os === 'windows' ? 'Windows-PC' : ai.platform.os === 'linux' ? 'Linux' : 'Unbekannt') : '…');
  const gb = (b) => b ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : '';

  onMount(() => { if (s.enabled || ai.status === 'unknown') connect(); });

  async function save() { await saveSettings(); installHooks(); }
  async function toggleEnabled(v) { s.enabled = v; await save(); if (v && ai.status !== 'ready') connect(); }
  async function doBench() {
    benching = true;
    try { const r = await benchmark(); toast(`${r.tps ?? '?'} Token/s · ${ACCEL_LABEL[r.accel?.mode] || ''}`, { tone: 'good' }); }
    catch (e) { toast(e.message, { tone: 'bad' }); }
    benching = false;
  }
  function copy(t) { navigator.clipboard?.writeText(t); toast('Kopiert'); }
  const originCmd = $derived(ai.platform?.os === 'windows' ? 'setx OLLAMA_ORIGINS "' + location.origin + '"' : 'launchctl setenv OLLAMA_ORIGINS "' + location.origin + '"');
</script>

<div class="stack tight">
  <div class="row wrap">
    <span class="st {ai.status}"></span>
    <strong>{ai.status === 'ready' ? 'Ollama verbunden' : ai.status === 'offline' ? 'Ollama nicht erreichbar' : ai.status === 'nomodel' ? 'Kein Modell installiert' : ai.status === 'checking' ? 'Prüfe …' : 'Nicht geprüft'}</strong>
    {#if ai.version}<span class="badge">v{ai.version}</span>{/if}
    <span class="badge"><Icon name="cpu" size={12} />{platformLabel}</span>
    {#if ai.accel}<span class="badge accent">{ACCEL_LABEL[ai.accel.mode]}</span>{/if}
    {#if ai.tps}<span class="badge">{String(ai.tps).replace('.', ',')} Token/s</span>{/if}
    <div class="grow"></div>
    <button class="btn btn-sm" onclick={connect}><Icon name="refresh" size={14} />Prüfen</button>
    <Toggle checked={s.enabled} label="KI nutzen" onchange={toggleEnabled} disabled={ai.status !== 'ready'} />
  </div>

  {#if ai.status === 'offline'}
    <div class="note">
      {#if ai.error}<div class="small negc">{ai.error}</div>{/if}
      <div class="row"><Icon name="alert" size={16} /><span>Ollama starten und „Prüfen“ klicken.</span><a class="btn btn-sm btn-ghost" href="https://ollama.com/download" target="_blank" rel="noreferrer"><Icon name="external" size={14} />Download</a></div>
      <Collapsible title="Verbindung klappt nicht?">
        <label class="field urlf"><span>Ollama-Adresse</span>
          <div class="row"><input class="input grow" bind:value={s.url} placeholder="http://localhost:11434" /><button class="btn btn-sm" onclick={async () => { await save(); connect(); }}>Übernehmen</button></div>
        </label>
        <ol class="small">
          <li>Ollama-App läuft (Menüleiste bzw. Taskleiste).</li>
          <li>FinanzRadar über den Start-Skript-Link öffnen (<span class="mono">http://localhost:8765</span>) – dieser Ursprung ist bei Ollama standardmäßig erlaubt.</li>
          <li>Anderer Ursprung? Freigeben: <span class="mono">{originCmd}</span> <button class="btn btn-sm btn-ghost btn-icon" onclick={() => copy(originCmd)}><Icon name="copy" size={13} /></button>, dann Ollama neu starten.</li>
        </ol>
      </Collapsible>
    </div>
  {/if}

  {#if ai.status === 'ready' || ai.status === 'nomodel'}
    <div class="grid g2">
      <label class="field"><span>Text-Modell <Tip text="Für Dokumenttyp, Felder, Kategorien und Steuer-Hinweis. Kleinere Modelle sind schneller." /></span>
        <select class="input" bind:value={s.model} onchange={save}>
          {#each textModels as m}<option value={m.name}>{m.name} · {m.details?.parameter_size || gb(m.size)}</option>{/each}
        </select>
      </label>
      <label class="field"><span>Bild-Modell <Tip text="Optional: liest Kassenbon-Fotos direkt. Ohne Bild-Modell übernimmt die eingebaute Texterkennung." /></span>
        <select class="input" bind:value={s.visionModel} onchange={save}>
          <option value="">– keins (Texterkennung) –</option>
          {#each visionModels as m}<option value={m.name}>{m.name} · {m.details?.parameter_size || gb(m.size)}</option>{/each}
        </select>
      </label>
    </div>
    <div class="row wrap">
      <Toggle bind:checked={s.think} label={s.think ? 'Thinking an' : 'No Thinking'} disabled={!canThink} onchange={save} />
      <Tip text={canThink ? 'Aus = schneller, direkte Antworten (empfohlen). An = Modell denkt vorher nach, genauer aber deutlich langsamer.' : 'Dieses Modell unterstützt kein Thinking.'} />
      <Toggle checked={s.autoRun !== false} label="Nach Import automatisch" onchange={(v) => { s.autoRun = v; save(); }} />
      <div class="grow"></div>
      <button class="btn btn-sm" onclick={doBench} disabled={benching || !s.model}><Icon name="zap" size={14} />{benching ? 'Messe …' : 'Testlauf'}</button>
    </div>
    {#if rec}
      <div class="rec small">
        <Icon name="sparkles" size={14} />
        <span>Empfohlen: <strong>{rec.text}</strong>{#if rec.vision} · Bild: <strong>{rec.vision}</strong>{/if} <span class="faint">({rec.reason})</span></span>
        {#if missingRec}<button class="btn btn-sm btn-ghost" onclick={() => copy('ollama pull ' + rec.text)}><Icon name="copy" size={13} />ollama pull {rec.text}</button>{/if}
      </div>
    {/if}
    <div class="row wrap">
      {#if ai.running}
        <span class="spin"></span><span class="small grow ellipsis">{ai.label} · {ai.done}/{ai.total}</span>
        <button class="btn btn-sm btn-ghost btn-danger" onclick={cancelAi}><Icon name="stop" size={14} />Stopp</button>
      {:else}
        <button class="btn btn-primary btn-sm" onclick={() => runOpenCases()} disabled={!s.model}><Icon name="sparkles" size={14} />Offene Fälle mit KI klären</button>
        {#if ai.lastRun}<span class="small faint">Zuletzt: {ai.lastRun.done}/{ai.lastRun.total} in {Math.round(ai.lastRun.ms / 1000)} s</span>{/if}
      {/if}
    </div>
    {#if ai.error}<div class="small negc">{ai.error}</div>{/if}
  {/if}
</div>

<style>
  .st { width: 10px; height: 10px; border-radius: 50%; background: var(--text-3); }
  .st.ready { background: var(--good); box-shadow: 0 0 0 4px var(--good-soft); }
  .st.offline { background: var(--bad); } .st.nomodel, .st.checking { background: var(--warn); }
  .urlf { margin-bottom: 10px; }
  .note { padding: 10px 12px; border-radius: 10px; background: var(--warn-soft); display: flex; flex-direction: column; gap: 8px; }
  .rec { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 10px; background: var(--accent-soft); }
  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent); animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
</style>
