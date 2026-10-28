<script>
  import { onMount } from 'svelte';
  import { app, init, setView, saveSettings, effectiveRange, toast } from './lib/store/state.svelte.js';
  import Icon from './lib/ui/Icon.svelte';
  import Seg from './lib/ui/Seg.svelte';
  import SearchPalette from './lib/views/SearchPalette.svelte';
  import Sources from './lib/views/Sources.svelte';
  import Overview from './lib/views/Overview.svelte';
  import Transactions from './lib/views/Transactions.svelte';
  import Documents from './lib/views/Documents.svelte';
  import Contracts from './lib/views/Contracts.svelte';
  import Assets from './lib/views/Assets.svelte';
  import Tax from './lib/views/Tax.svelte';
  import Settings from './lib/views/Settings.svelte';
  import Review from './lib/views/Review.svelte';
  import ProgressBar from './lib/views/ProgressBar.svelte';
  import AiBanner from './lib/ai/AiBanner.svelte';
  import { connect as aiConnect } from './lib/ai/engine.svelte.js';
  import { fmtDate } from './lib/util/format.js';

  const NAV = [
    { id: 'overview', label: 'Überblick', icon: 'overview' },
    { id: 'transactions', label: 'Buchungen', icon: 'list' },
    { id: 'documents', label: 'Dokumente', icon: 'file' },
    { id: 'contracts', label: 'Verträge & Abos', icon: 'repeat' },
    { id: 'assets', label: 'Vermögen', icon: 'wallet' },
    { id: 'tax', label: 'Steuer', icon: 'tax' },
  ];
  const VIEWS = { start: Sources, sources: Sources, overview: Overview, transactions: Transactions, documents: Documents, contracts: Contracts, assets: Assets, tax: Tax, settings: Settings, review: Review };
  const TITLES = { start: 'Willkommen', sources: 'Quellen', overview: 'Überblick', transactions: 'Buchungen', documents: 'Dokumente', contracts: 'Verträge & Abos', assets: 'Vermögen', tax: 'Steuer', settings: 'Einstellungen', review: 'Prüfen' };
  const PRESETS = [{ value: 'month', label: 'Monat' }, { value: '3m', label: '3 M' }, { value: '12m', label: '12 M' }, { value: 'year', label: 'Jahr' }, { value: 'all', label: 'Alles' }];

  let bootError = $state(null);
  let topH = $state(66);
  const View = $derived(VIEWS[app.view] || Overview);
  const reviewCount = $derived(app.data.transactions.filter(t => t.needsReview && !t.reviewed).length + app.data.documents.filter(d => d.needsReview && !d.reviewed && d.type !== 'irrelevant').length);
  const hasData = $derived(app.data.files.length > 0);
  const range = $derived.by(() => { void app.dataVersion; return effectiveRange(); });
  const showFilter = $derived(['overview', 'transactions'].includes(app.view));

  onMount(() => {
    init().then(() => {
      const h = location.hash.slice(1);
      if (h && VIEWS[h] && app.data.files.length) app.view = h;
      if (app.settings.ai.enabled) aiConnect();
    }).catch((e) => { console.error(e); bootError = e?.message || String(e); });
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'k') { e.preventDefault(); app.searchOpen = true; }
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); app.searchOpen = true; }
    };
    window.addEventListener('keydown', onKey);
    // Dateien, die neben der Ablagefläche fallen gelassen werden, würden sonst im Browser geöffnet und die App verlassen
    const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onDragOver = e => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = e => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (app.view !== 'sources' && app.view !== 'start') { setView('sources'); toast('Dateien hier ablegen oder über „Ordner wählen“ hinzufügen'); }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('dragover', onDragOver); window.removeEventListener('drop', onDrop); };
  });

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    app.settings.theme = order[(order.indexOf(app.settings.theme) + 1) % 3];
    saveSettings();
  }
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
</script>

{#if !app.ready}
  <div class="boot">
    {#if bootError}
      <div class="card boot-err stack">
        <h2>Browser-Speicher nicht verfügbar</h2>
        <p class="muted">FinanzRadar speichert alles lokal in IndexedDB. Bitte kein privates Fenster verwenden und Website-Daten für diese Seite zulassen, dann neu laden.</p>
        <code class="small faint">{bootError}</code>
        <button class="btn btn-primary" onclick={() => location.reload()}>Neu laden</button>
      </div>
    {:else}<div class="logo-mark big"></div>{/if}
  </div>
{:else}
  <div class="shell" class:nodata={!hasData}>
    <aside class="side">
      <button class="brand" onclick={() => setView(hasData ? 'overview' : 'start')}>
        <span class="logo-mark"></span><span>FinanzRadar</span>
      </button>
      <nav>
        {#each NAV as n}
          <button class="nav" class:on={app.view === n.id} disabled={!hasData} onclick={() => setView(n.id)}>
            <Icon name={n.icon} /><span>{n.label}</span>
          </button>
        {/each}
        <button class="nav" class:on={app.view === 'review'} disabled={!hasData} onclick={() => setView('review')}>
          <Icon name="inbox" /><span>Prüfen</span>{#if reviewCount}<span class="count">{reviewCount}</span>{/if}
        </button>
      </nav>
      <div class="side-foot">
        <button class="nav" class:on={app.view === 'sources' || app.view === 'start'} onclick={() => setView('sources')}><Icon name="folder" /><span>Quellen</span></button>
        <button class="nav" class:on={app.view === 'settings'} onclick={() => setView('settings')}><Icon name="settings" /><span>Einstellungen</span>{#if app.settings.ai.enabled}<span class="ai-dot" title="Lokale KI aktiv"></span>{/if}</button>
        <button class="nav" onclick={cycleTheme} title="Darstellung"><Icon name={app.settings.theme === 'dark' ? 'moon' : app.settings.theme === 'light' ? 'sun' : 'eye'} /><span>{app.settings.theme === 'auto' ? 'System' : app.settings.theme === 'dark' ? 'Dunkel' : 'Hell'}</span></button>
      </div>
    </aside>

    <main class="main" style="--top-h:{topH}px">
      <header class="top" bind:offsetHeight={topH}>
        <h1>{TITLES[app.view]}</h1>
        {#if showFilter && hasData}
          <Seg bind:value={app.filter.preset} options={PRESETS} size="sm" />
          <span class="range small faint num">{fmtDate(range.from)} – {fmtDate(range.to)}</span>
        {/if}
        <div class="grow"></div>
        {#if hasData}
          <button class="search" onclick={() => (app.searchOpen = true)}>
            <Icon name="search" size={16} /><span>Suchen</span><kbd>{isMac ? '⌘' : 'Strg'} K</kbd>
          </button>
          <button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="plus" size={16} />Dateien</button>
        {/if}
      </header>
      {#if app.progress.running && app.view !== 'sources' && app.view !== 'start'}<ProgressBar compact />{/if}
      <section class="content">
        {#key app.view}<div class="view-in"><View /></div>{/key}
      </section>
    </main>
  </div>
  <SearchPalette />
  <AiBanner />
  <div class="toasts">
    {#each app.toasts as t (t.id)}
      <div class="toast {t.tone} fade-up" role="status">{t.msg}{#if t.action}<button class="btn btn-sm btn-ghost" onclick={() => { app.toasts = app.toasts.filter(x => x.id !== t.id); t.action.fn(); }}>{t.action.label}</button>{/if}</div>
    {/each}
  </div>
{/if}

<style>
  .boot { height: 100vh; display: grid; place-items: center; padding: 16px; }
  .boot-err { max-width: 460px; }
  .boot-err code { overflow-wrap: anywhere; }
  .shell { display: grid; grid-template-columns: var(--sidebar) 1fr; min-height: 100vh; background: linear-gradient(to right, var(--surface) calc(var(--sidebar) - 1px), var(--border) calc(var(--sidebar) - 1px), var(--border) var(--sidebar), var(--bg) var(--sidebar)); }
  .side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 6px; padding: 16px 12px; border-right: 1px solid var(--border); background: var(--surface); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; font-size: 16px; letter-spacing: -.02em; padding: 6px 10px 16px; border: 0; background: none; cursor: pointer; }
  :global(.logo-mark) { width: 28px; height: 28px; border-radius: 9px; background: conic-gradient(from 200deg, var(--accent), #20c997, #ffb020, var(--accent)); position: relative; flex: none; }
  :global(.logo-mark)::after { content: ''; position: absolute; inset: 7px; border-radius: 50%; background: var(--surface); }
  :global(.logo-mark.big) { width: 56px; height: 56px; border-radius: 18px; animation: spin 1.4s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  nav { display: flex; flex-direction: column; gap: 2px; }
  .nav { display: flex; align-items: center; gap: 11px; height: 38px; padding: 0 12px; border-radius: 10px; border: 0; background: none; cursor: pointer; color: var(--text-2); font-weight: 550; text-align: left; width: 100%; }
  .nav span:first-of-type { flex: 1; }
  .nav:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .nav.on { background: var(--accent-soft); color: var(--accent); }
  .nav:disabled { opacity: .4; cursor: default; }
  .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--warn); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; }
  .ai-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px var(--good-soft); }
  .side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 10px; }
  .main { min-width: 0; display: flex; flex-direction: column; }
  .top { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 14px; padding: 14px 28px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px 0 12px; min-width: 230px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text-3); cursor: pointer; }
  .search span { flex: 1; text-align: left; }
  .content { padding: 24px 28px 60px; max-width: 1480px; width: 100%; }
  /* nur Opacity: ein transform würde fixe Panels (Drawer, Viewer) an den Inhaltsbereich binden */
  .view-in { animation: viewIn .28s ease; }
  @keyframes viewIn { from { opacity: 0; } to { opacity: 1; } }
  .toasts { position: fixed; bottom: 20px; left: 0; right: 0; margin-inline: auto; width: max-content; max-width: 92vw; display: flex; flex-direction: column; gap: 8px; z-index: 120; }
  .toast { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 12px; background: var(--text); color: var(--bg); box-shadow: var(--shadow-lg); font-weight: 550; }
  .toast.good { background: var(--good); color: #fff; } .toast.bad { background: var(--bad); color: #fff; }
  @media (max-width: 860px) {
    .shell { grid-template-columns: 1fr; background: var(--bg); }
    .nav { width: auto; padding: 0 10px; } .brand { padding: 4px 6px; } .brand span:last-child { display: none; }
    .side { position: sticky; top: 0; z-index: 30; gap: 2px; padding: 8px; overflow-x: auto; flex-wrap: nowrap; }
    nav { flex-wrap: nowrap; } .top { position: static; }
    .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--border); }
    nav { flex-direction: row; } .nav span:first-of-type { display: none; } .side-foot { flex-direction: row; margin: 0; border: 0; padding: 0; }
    .content, .top { padding-left: 16px; padding-right: 16px; } .search { min-width: 0; }
  }
</style>
