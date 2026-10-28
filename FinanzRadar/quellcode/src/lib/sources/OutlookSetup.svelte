<script>
  import * as outlook from './outlook.js';
  import Tip from '../ui/Tip.svelte';

  // initial: gespeicherte Konfiguration { folders: [{ id, path }], months }; onconnected({ kind, name, config })
  let { initial = null, onconnected } = $props();

  const RANGES = [3, 6, 12, 24, 36];
  let st = $state(null); // { available, platform, reason? }
  let busy = $state(false);
  let error = $state('');
  let folders = $state([]);
  let selected = $state(new Set());
  // svelte-ignore state_referenced_locally
  let months = $state(initial?.months || outlook.DEFAULT_MONTHS);
  let query = $state('');

  const shown = $derived(query.trim() ? folders.filter((f) => f.path.toLowerCase().includes(query.trim().toLowerCase())) : folders);
  const platformLabel = $derived(st?.platform === 'mac' ? 'Mac' : st?.platform === 'windows' ? 'Windows' : '');

  async function check() {
    error = '';
    busy = true;
    try {
      st = await outlook.status();
      if (!st.available) return;
      folders = await outlook.listFolders();
      const saved = new Set((initial?.folders || []).map((f) => f.id));
      const keep = folders.filter((f) => saved.has(f.id));
      selected = new Set((keep.length ? keep : outlook.defaultFolders(folders)).map((f) => f.id));
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }

  function connect() {
    const chosen = folders.filter((f) => selected.has(f.id)).map((f) => ({ id: f.id, path: f.path }));
    onconnected?.({ kind: 'outlook', name: 'Outlook', config: { folders: chosen, months } });
  }

  check();
</script>

<div class="card stack">
  <div class="row">
    <span class="dot" class:ok={st?.available} class:off={st && !st.available}></span>
    <strong class="grow">
      {#if !st}Outlook wird gesucht …{:else if st.available}Outlook bereit{platformLabel ? ` (${platformLabel})` : ''}{:else}Outlook nicht verfügbar{/if}
    </strong>
    <Tip text="Nur klassisches Outlook (Mac: Legacy-Outlook, Windows: Outlook-Desktop). Mails werden über den lokalen Start-Server gelesen – die Daten bleiben auf diesem Gerät. Übernommen werden Anhänge und Mailtexte mit Finanzbezug (z. B. Bestellbestätigungen)." />
    <button class="btn btn-sm" type="button" onclick={check} disabled={busy}>Erneut prüfen</button>
  </div>

  {#if st && !st.available}
    <p class="muted small">{st.reason}</p>
  {/if}
  {#if error}
    <p class="small" style="color: var(--bad)">{error}</p>
  {/if}

  {#if st?.available && folders.length}
    <div class="row">
      <input class="input grow" bind:value={query} placeholder="Ordner suchen" autocomplete="off" />
      <label class="row small">
        Zeitraum
        <select class="input" bind:value={months}>
          {#each RANGES as m (m)}<option value={m}>{m} Monate</option>{/each}
        </select>
      </label>
    </div>
    <ul class="folders scroll">
      {#each shown as f (f.id)}
        <li>
          <label class="row small">
            <input type="checkbox" checked={selected.has(f.id)} onchange={() => toggle(f.id)} />
            <span class="grow ellipsis" title={f.path}>{f.path}</span>
            <span class="faint num">{f.count}</span>
          </label>
        </li>
      {:else}
        <li class="muted small">Keine Ordner gefunden.</li>
      {/each}
    </ul>
    <div class="row">
      <span class="grow small faint">{selected.size} Ordner gewählt</span>
      <button class="btn btn-primary" type="button" onclick={connect} disabled={busy || !selected.size}>Verbinden</button>
    </div>
  {/if}
</div>

<style>
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); flex: none; }
  .dot.ok { background: var(--good); }
  .dot.off { background: var(--bad); }
  .folders { list-style: none; padding: 0; margin: 0; max-height: 300px; display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; }
  .folders label { cursor: pointer; gap: 8px; }
  select.input { width: auto; }
</style>
