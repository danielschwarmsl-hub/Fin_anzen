<script>
  import * as dropbox from './dropbox.js';
  import * as gdrive from './gdrive.js';

  // kind: 'dropbox' | 'gdrive'; onconnected({kind, name, config, token}) bei Ordnerauswahl
  let { kind, onconnected, initialKey = '' } = $props();

  const isDropbox = $derived(kind === 'dropbox');
  const label = $derived(isDropbox ? 'Dropbox' : 'Google Drive');
  const redirectUri = globalThis.location ? dropbox.oauthRedirectUri() : '';
  const origin = globalThis.location ? globalThis.location.origin : '';

  // svelte-ignore state_referenced_locally
  let key = $state(initialKey || '');
  let token = $state(null);
  let busy = $state(false);
  let error = $state('');
  let crumbs = $state([]); // [{ id, name }]; Dropbox: id = Pfad, Drive: id = Ordner-ID
  let folders = $state([]);

  const current = $derived(crumbs.at(-1));

  async function run(task) {
    error = '';
    busy = true;
    try {
      await task();
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  async function loadFolders() {
    const { accessToken } = token;
    folders = isDropbox
      ? await dropbox.listFolders(accessToken, current.id)
      : await gdrive.listFolders(accessToken, current.id);
  }

  function connect() {
    return run(async () => {
      const k = key.trim();
      token = isDropbox ? await dropbox.connect({ appKey: k }) : await gdrive.connect({ clientId: k });
      crumbs = [isDropbox ? { id: '', name: 'Dropbox' } : { id: 'root', name: 'Mein Drive' }];
      await loadFolders();
    });
  }

  function descend(folder) {
    crumbs = [...crumbs, { id: isDropbox ? folder.path : folder.id, name: folder.name }];
    return run(loadFolders);
  }

  function jumpTo(index) {
    crumbs = crumbs.slice(0, index + 1);
    return run(loadFolders);
  }

  function useFolder() {
    const sub = crumbs.slice(1).map((c) => c.name).join(' / ');
    const name = sub ? `${label}: ${sub}` : label;
    const config = isDropbox
      ? { appKey: key.trim(), path: current.id }
      : { clientId: key.trim(), folderId: current.id };
    onconnected?.({ kind, name, config, token });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      error = 'Kopieren nicht möglich – bitte manuell markieren.';
    }
  }
</script>

<div class="card stack">
  <details class="collapsible">
    <summary>Einrichtung ({label})</summary>
    <div class="body">
    {#if isDropbox}
      <ol class="stack muted">
        <li>Auf dropbox.com/developers/apps öffnen und <strong>Create app</strong> wählen.</li>
        <li>Scoped access wählen, Zugriff <strong>Full Dropbox</strong> oder <strong>App folder</strong>.</li>
        <li>Unter Permissions <code>files.metadata.read</code> und <code>files.content.read</code> aktivieren und speichern.</li>
        <li>
          Redirect URI eintragen:
          <span class="row">
            <code>{redirectUri}</code>
            <button class="btn" type="button" onclick={() => copy(redirectUri)}>Kopieren</button>
          </span>
        </li>
        <li><strong>App key</strong> kopieren und unten einfügen.</li>
      </ol>
    {:else}
      <ol class="stack muted">
        <li>Auf console.cloud.google.com ein Projekt wählen oder anlegen.</li>
        <li>Die <strong>Google Drive API</strong> aktivieren.</li>
        <li>OAuth-Zustimmungsbildschirm: Nutzertyp <strong>Extern</strong>, eigene Mail-Adresse als Testnutzer eintragen.</li>
        <li>Anmeldedaten → <strong>OAuth-Client-ID</strong> erstellen, Anwendungstyp <strong>Webanwendung</strong>.</li>
        <li>
          Autorisierte JavaScript-Quellen:
          <span class="row">
            <code>{origin}</code>
            <button class="btn" type="button" onclick={() => copy(origin)}>Kopieren</button>
          </span>
        </li>
        <li><strong>Client-ID</strong> kopieren und unten einfügen.</li>
      </ol>
    {/if}
    </div>
  </details>

  <div class="row">
    <input
      class="input"
      bind:value={key}
      placeholder={isDropbox ? 'App-Key' : 'Client-ID'}
      autocomplete="off"
      disabled={busy}
    />
    <button class="btn btn-primary" type="button" onclick={connect} disabled={busy || !key.trim()}>
      {token ? 'Neu verbinden' : 'Verbinden'}
    </button>
  </div>

  {#if error}
    <p class="muted" style="color: var(--bad)">{error}</p>
  {/if}

  {#if token}
    <nav class="row" aria-label="Ordnerpfad">
      {#each crumbs as crumb, i (i)}
        <button class="btn" type="button" onclick={() => jumpTo(i)} disabled={busy || i === crumbs.length - 1}>
          {crumb.name}
        </button>
        {#if i < crumbs.length - 1}<span class="muted">/</span>{/if}
      {/each}
    </nav>

    <ul class="stack" style="list-style: none; padding: 0; margin: 0">
      {#each folders as folder (folder.id)}
        <li>
          <button class="btn" type="button" onclick={() => descend(folder)} disabled={busy}>
            {folder.name}
          </button>
        </li>
      {:else}
        <li class="muted">Keine Unterordner.</li>
      {/each}
    </ul>

    <button class="btn btn-primary" type="button" onclick={useFolder} disabled={busy}>
      Diesen Ordner verwenden
    </button>
  {/if}
</div>

<style>
  code { overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }
  nav.row { flex-wrap: wrap; }
</style>
