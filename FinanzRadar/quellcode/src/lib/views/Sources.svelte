<script>
  import { app, live, setView, saveSettings, toast, retryState, retryFailedFiles } from '../store/state.svelte.js';
  import { db } from '../store/db.js';
  import { runImport, ensureSource } from '../store/importer.js';
  import * as local from '../sources/local.js';
  import * as dropbox from '../sources/dropbox.js';
  import * as gdrive from '../sources/gdrive.js';
  import * as outlook from '../sources/outlook.js';
  import SourceSetup from '../sources/SourceSetup.svelte';
  import OutlookSetup from '../sources/OutlookSetup.svelte';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Modal from '../ui/Modal.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import { fmtDate, extOf } from '../util/format.js';
  import { friendlyError } from '../util/errors.js';

  let over = $state(false);
  let dragDepth = 0; // dragenter/-leave feuern auch für Kindelemente (Firefox: relatedTarget unzuverlässig)
  let cloudKind = $state(null);
  let cloudOpen = $state(false);
  let dirInput, fileInput;
  let lastRun = $state(null);

  const hasData = $derived(app.data.files.length > 0);
  const step = $derived(app.progress.running ? 2 : lastRun ? 3 : 1);
  const reviewCount = $derived(live.reviewCount);
  // Dateien mit Lesefehler (bleiben gespeichert): Sammelanzeige mit „Erneut versuchen“
  const failedFiles = $derived(app.data.files.filter(f => f.status === 'error'));
  const fileCount = (sid) => app.data.files.filter(f => f.sourceId === sid || (f.origins || []).some(o => o.sourceId === sid)).length;

  async function start(items, src) {
    if (!items || (Array.isArray(items) && !items.length)) { toast('Keine passenden Dateien gefunden'); return; }
    lastRun = null;
    await runImport(items, src);
    lastRun = { docs: app.progress.newDocs, tx: app.progress.newTx, skipped: app.progress.skipped, ignored: app.progress.counts.irrelevant || 0, errors: app.progress.errors.length };
  }

  async function pickFolder() {
    if (local.isDirectoryPickerSupported()) {
      try {
        const { handle, name } = await local.pickDirectory();
        const src = await ensureSource({ kind: 'local', name, root: name });
        await db.sources.update(src.id, { config: { handle } });
        await start(local.enumerateHandle(handle, { basePath: name }), src);
      } catch (e) { if (e.name !== 'AbortError') toast(e.message, { tone: 'bad' }); }
    } else dirInput.click();
  }
  async function onDirInput(e) {
    const items = local.filesFromInput(e.target.files);
    const name = items[0]?.path?.split('/')[0] || 'Ordner';
    const src = await ensureSource({ kind: 'local', name, root: name });
    e.target.value = '';
    await start(items, src);
  }
  async function onFileInput(e) {
    const items = local.filesFromInput(e.target.files);
    const src = await ensureSource({ kind: 'upload', name: 'Einzeldateien', root: '' });
    e.target.value = '';
    await start(items, src);
  }
  async function onDrop(e) {
    e.preventDefault(); over = false; dragDepth = 0;
    if (app.progress.running) return;
    const items = await local.itemsFromDataTransfer(e.dataTransfer);
    const top = items[0]?.path?.includes('/') ? items[0].path.split('/')[0] : 'Abgelegte Dateien';
    const src = await ensureSource({ kind: 'local', name: top, root: top });
    await start(items, src);
  }
  async function rescan(s) {
    try {
      if (s.kind === 'local' && s.config?.handle) {
        const ok = await local.ensurePermission(s.config.handle);
        if (!ok) { toast('Zugriff verweigert'); return; }
        await start(local.enumerateHandle(s.config.handle, { basePath: s.name }), s);
      } else if (s.kind === 'local' || s.kind === 'upload') {
        dirInput.click();
      } else if (s.kind === 'outlook' && s.config?.folders?.length) {
        await start(outlook.enumerate(s.config), s);
      } else { cloudKind = s.kind; cloudOpen = true; }
    } catch (e) { toast(e.message, { tone: 'bad' }); }
  }
  async function removeSource(s) {
    if (!confirm(`Quelle „${s.name}“ entfernen? Bereits ausgelesene Daten bleiben erhalten.`)) return;
    await db.sources.delete(s.id);
    app.data.sources = app.data.sources.filter(x => x.id !== s.id);
  }
  async function onCloud({ kind, name, config, token }) {
    cloudOpen = false;
    if (kind === 'dropbox') app.settings.dropboxAppKey = config.appKey;
    if (kind === 'gdrive') app.settings.gdriveClientId = config.clientId;
    saveSettings();
    const { appKey, clientId, ...rest } = config;
    const src = await ensureSource({ kind, name, root: config.path || config.folderId || '', config: rest });
    const it = kind === 'dropbox' ? dropbox.enumerate({ token: token.accessToken || token, path: config.path || '' }) : gdrive.enumerate({ token: token.accessToken || token, folderId: config.folderId || 'root' });
    await start(it, src);
  }
  async function onOutlook({ kind, name, config }) {
    cloudOpen = false;
    const src = await ensureSource({ kind, name, root: '', config });
    src.config = config; // vorhandene Quelle: neue Ordner-/Zeitraumwahl übernehmen
    await db.sources.update(src.id, { config });
    await start(outlook.enumerate(config), src);
  }
  async function loadSamples() {
    const base = new URL('samples/', document.baseURI).href;
    const manifest = await (await fetch(base + 'manifest.json')).json();
    const items = manifest.map(m => ({
      path: 'Beispieldaten/' + m.path, name: m.path.split('/').pop(), size: m.size, mtime: 0, ext: extOf(m.path),
      getFile: async () => { const r = await fetch(base + m.path.split('/').map(encodeURIComponent).join('/')); const b = await r.blob(); return new File([b], m.path.split('/').pop(), { type: b.type }); },
    }));
    const src = await ensureSource({ kind: 'local', name: 'Beispieldaten', root: 'samples' });
    await start(items, src);
  }
  const KIND = { local: { icon: 'folder', label: 'Ordner' }, upload: { icon: 'upload', label: 'Dateien' }, dropbox: { icon: 'dropbox', label: 'Dropbox' }, gdrive: { icon: 'cloud', label: 'Google Drive' }, outlook: { icon: 'inbox', label: 'Outlook' } };
  const CLOUD_TITLE = { dropbox: 'Dropbox verbinden', gdrive: 'Google Drive verbinden', outlook: 'Outlook verbinden' };
</script>

<input type="file" webkitdirectory multiple class="hidden" bind:this={dirInput} onchange={onDirInput} />
<input type="file" multiple class="hidden" bind:this={fileInput} onchange={onFileInput} accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,.webp,.tif,.tiff,.csv,.tsv,.txt,.xlsx,.xls,.xml,.sta,.mt940" />

<div class="stack">
  <ol class="steps">
    {#each ['Quellen', 'Verarbeiten', 'Prüfen', 'Überblick'] as s, i}
      <li class:done={step > i + 1} class:on={step === i + 1}><span class="n">{step > i + 1 ? '✓' : i + 1}</span>{s}</li>
    {/each}
  </ol>

  {#if app.progress.running}
    <div class="card"><ProgressBar /></div>
  {:else if lastRun}
    <div class="card done fade-up">
      <div class="row wrap">
        <div class="big-ic"><Icon name="check" size={26} /></div>
        <div class="grow">
          <h2>Fertig sortiert</h2>
          <div class="row wrap small muted">
            <span><strong class="num">{lastRun.docs}</strong> Dokumente</span>·<span><strong class="num">{lastRun.tx}</strong> Buchungen</span>
            {#if lastRun.ignored}·<span>{lastRun.ignored} ohne Finanzbezug</span>{/if}
            {#if lastRun.skipped}·<span>{lastRun.skipped} bereits bekannt</span>{/if}
            {#if lastRun.errors}·<span class="negc">{lastRun.errors} Fehler</span>{/if}
          </div>
        </div>
        {#if reviewCount}
          <button class="btn" onclick={() => setView('overview')}>Überblick</button>
          <button class="btn btn-primary btn-lg" onclick={() => setView('review')}><Icon name="inbox" />{reviewCount} prüfen</button>
        {:else}
          <button class="btn btn-primary btn-lg" onclick={() => setView('overview')}>Zum Überblick<Icon name="arrowRight" /></button>
        {/if}
      </div>
      {#if app.progress.errors.length && !failedFiles.length}
        <div class="errs-wrap"><Collapsible title="Nicht gelesene Dateien" badge={app.progress.errors.length}>
          <ul class="errs small">
            {#each app.progress.errors as e}
              {@const fe = friendlyError(e.error)}
              <li><span class="mono">{e.name}</span> – {fe.text}{#if fe.detail}<div class="faint detail">{fe.detail}</div>{/if}</li>
            {/each}
          </ul>
        </Collapsible></div>
      {/if}
    </div>
  {/if}

  {#if failedFiles.length && !app.progress.running}
    <div class="card failed">
      <div class="row wrap">
        <Icon name="alert" size={18} />
        <strong class="grow">{failedFiles.length} {failedFiles.length === 1 ? 'Datei konnte' : 'Dateien konnten'} nicht gelesen werden</strong>
        <Tip text="Häufig ein vorübergehender Fehler des PDF-Lesers. Erneut versuchen liest die gespeicherten Dateien nacheinander noch einmal." />
        <button class="btn btn-sm" onclick={retryFailedFiles} disabled={retryState.running}>
          <Icon name="refresh" size={14} />{retryState.running ? `Wird eingelesen ${retryState.done + 1} / ${retryState.total} …` : 'Erneut versuchen'}
        </button>
      </div>
      <Collapsible title="Welche Dateien?">
        <ul class="errs small">
          {#each failedFiles as f (f.id)}
            {@const fe = friendlyError(f.error)}
            <li><span class="mono">{f.name}</span> – {fe.text}{#if fe.detail}<div class="faint detail">{fe.detail}</div>{/if}</li>
          {/each}
        </ul>
      </Collapsible>
    </div>
  {/if}

  <div class="drop" class:over role="region" aria-label="Dateien ablegen"
       ondragenter={() => { dragDepth++; over = true; }} ondragover={(e) => { e.preventDefault(); over = true; }}
       ondragleave={() => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) over = false; }} ondrop={onDrop}>
    <div class="drop-ic"><Icon name="upload" size={30} /></div>
    <h2>{hasData ? 'Weitere Dateien hinzufügen' : 'Alles reinwerfen. Fertig sortiert.'}</h2>
    <div class="muted">Ordner oder Dateien hierher ziehen</div>
    <div class="row wrap center">
      <button class="btn btn-primary btn-lg" onclick={pickFolder} disabled={app.progress.running}><Icon name="folder" />Ordner wählen</button>
      <button class="btn btn-lg" onclick={() => fileInput.click()} disabled={app.progress.running}><Icon name="file" />Dateien</button>
      <button class="btn btn-lg" onclick={() => { cloudKind = 'dropbox'; cloudOpen = true; }} disabled={app.progress.running}><Icon name="dropbox" />Dropbox</button>
      <button class="btn btn-lg" onclick={() => { cloudKind = 'gdrive'; cloudOpen = true; }} disabled={app.progress.running}><Icon name="cloud" />Google Drive</button>
      <button class="btn btn-lg" onclick={() => { cloudKind = 'outlook'; cloudOpen = true; }} disabled={app.progress.running}><Icon name="inbox" />Outlook</button>
    </div>
    <div class="row center small faint">
      PDF · Scans & Fotos · CSV · Excel · camt/MT940 · E-Rechnung
      <Tip text="Kontoauszüge (ING, comdirect, Renault Bank, PayPal u. v. m.), Kassenbons, Rechnungen, Lohnabrechnungen, Depot-, Versicherungs- und Rentenunterlagen. Alles bleibt auf diesem Gerät." />
    </div>
  </div>

  {#if !hasData && !app.progress.running}
    <button class="sample btn btn-ghost" onclick={loadSamples}><Icon name="sparkles" size={16} />Mit Beispieldaten ausprobieren</button>
  {/if}

  {#if app.data.sources.length}
    <div class="card">
      <div class="card-head"><h3>Verbundene Quellen</h3></div>
      <div class="srcs">
        {#each app.data.sources as s (s.id)}
          <div class="src">
            <span class="sic"><Icon name={KIND[s.kind]?.icon || 'folder'} /></span>
            <div class="grow">
              <div class="ellipsis"><strong>{s.name}</strong></div>
              <div class="small faint">{KIND[s.kind]?.label} · {fileCount(s.id)} Dateien{#if s.lastScan} · {fmtDate(s.lastScan.slice(0, 10))}{/if}</div>
            </div>
            <button class="btn btn-sm" onclick={() => rescan(s)} disabled={app.progress.running} title="Neu scannen"><Icon name="refresh" size={14} />Scannen</button>
            <button class="btn btn-sm btn-ghost btn-icon" onclick={() => removeSource(s)} title="Entfernen"><Icon name="trash" size={14} /></button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <Collapsible title="Datenschutz & Browser">
    <ul class="small muted plain">
      <li>Verarbeitung komplett im Browser; Daten liegen nur in diesem Browserprofil.</li>
      <li>Chrome/Edge: Ordner lassen sich später per „Scannen“ aktualisieren. Firefox: Ordner erneut auswählen oder hineinziehen.</li>
      <li>Doppelte Dateien werden am Inhalt erkannt; alle Fundorte bleiben als Herkunft gespeichert.</li>
    </ul>
  </Collapsible>
</div>

<Modal bind:open={cloudOpen} title={CLOUD_TITLE[cloudKind] || ''} width={620}>
  {#if cloudKind === 'outlook'}<OutlookSetup initial={app.data.sources.find(x => x.kind === 'outlook')?.config} onconnected={onOutlook} />
  {:else if cloudKind}<SourceSetup kind={cloudKind} initialKey={cloudKind === 'dropbox' ? app.settings.dropboxAppKey : app.settings.gdriveClientId} onconnected={onCloud} />{/if}
</Modal>

<style>
  .steps { list-style: none; display: flex; gap: 6px; padding: 0; margin: 0 0 4px; flex-wrap: wrap; }
  .steps li { display: flex; align-items: center; gap: 8px; padding: 6px 14px 6px 6px; border-radius: 999px; color: var(--text-3); font-weight: 600; font-size: 13px; background: var(--surface); border: 1px solid var(--border); }
  .steps .n { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); font-size: 12px; }
  .steps li.on { color: var(--accent); border-color: var(--accent); } .steps li.on .n { background: var(--accent); color: #fff; }
  .steps li.done { color: var(--good); } .steps li.done .n { background: var(--good-soft); }
  .drop { border: 2px dashed var(--border); border-radius: 22px; padding: 46px 20px; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; background: radial-gradient(ellipse at top, var(--accent-soft), transparent 60%), var(--surface); transition: border-color .15s, transform .15s; }
  .drop.over { border-color: var(--accent); transform: scale(1.005); }
  .drop h2 { font-size: 24px; letter-spacing: -.02em; }
  .drop-ic { width: 64px; height: 64px; border-radius: 20px; display: grid; place-items: center; background: var(--accent); color: #fff; box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 40%, transparent); }
  .center { justify-content: center; }
  .sample { align-self: center; color: var(--accent); }
  .errs-wrap { margin-top: 12px; }
  .failed { display: flex; flex-direction: column; gap: 8px; border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
  .failed > .row { gap: 10px; align-items: center; color: var(--text); }
  .failed > .row > :global(svg) { color: var(--warn); }
  .detail { font-size: 11px; overflow-wrap: anywhere; }
  .errs { margin: 0; padding-left: 16px; max-height: 220px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
  .done { border-color: color-mix(in srgb, var(--good) 40%, var(--border)); }
  .big-ic { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: var(--good-soft); color: var(--good); }
  .srcs { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .src { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; }
  .sic { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--surface-2); color: var(--text-2); }
  .plain { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; }
</style>
