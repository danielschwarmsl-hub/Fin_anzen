<script module>
  // Vorschau-Cache (Object-URLs je fileId, '' = keine Vorschau). Begrenzt, damit der Speicher nicht unbegrenzt wächst.
  import { getThumb } from '../store/state.svelte.js';
  const thumbs = new Map();
  const thumbsLoading = new Set();
  const MAX_THUMBS = 1500;
  function loadThumb(fileId, done) {
    if (!fileId || thumbs.has(fileId) || thumbsLoading.has(fileId)) return;
    thumbsLoading.add(fileId);
    getThumb(fileId)
      .then((blob) => {
        if (thumbs.size >= MAX_THUMBS) {
          const [k, v] = thumbs.entries().next().value;
          if (v) URL.revokeObjectURL(v);
          thumbs.delete(k);
        }
        thumbs.set(fileId, blob ? URL.createObjectURL(blob) : '');
      })
      .catch(() => thumbs.set(fileId, ''))
      .finally(() => { thumbsLoading.delete(fileId); done(); });
  }
</script>

<script>
  import { untrack } from 'svelte';
  import { app, setView, getBlob, toast, retryState, retryFailedFiles } from '../store/state.svelte.js';
  import { search } from '../store/search.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import { fmtDate } from '../util/format.js';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Seg from '../ui/Seg.svelte';
  import Money from '../ui/Money.svelte';
  import Empty from '../ui/Empty.svelte';
  import DocViewer from './DocViewer.svelte';
  import DocFix from '../ui/DocFix.svelte';
  import { isPendingDoc, isUnreadable, docReason } from './reviewModel.js';

  const PAGE_GRID = 120;
  const PAGE_LIST = 200;
  const VIEW_OPTIONS = [{ value: 'grid', label: 'Raster' }, { value: 'list', label: 'Liste' }];

  // ---- Zustand ----
  let qInput = $state('');
  let q = $state('');
  let qTimer;
  let typeF = $state(null);
  let year = $state('all');
  let taxOnly = $state(false);
  let reviewOnly = $state(false);
  let showIgnored = $state(false);
  let view = $state('grid');
  let more = $state(1);
  let openId = $state(app.params?.open ?? null);
  let thumbTick = $state(0);

  $effect(() => {
    const o = app.params?.open;
    if (o) openId = o;
  });
  $effect(() => () => clearTimeout(qTimer));
  // Bei Filterwechsel wieder auf die erste Seite
  $effect(() => {
    void q; void typeF; void year; void taxOnly; void reviewOnly; void showIgnored;
    untrack(() => (more = 1));
  });

  function onQ(e) {
    qInput = e.currentTarget.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => (q = qInput.trim()), 160);
  }
  function resetFilters() {
    qInput = ''; q = ''; typeF = null; year = 'all'; taxOnly = false; reviewOnly = false; showIgnored = false;
  }

  // ---- Lookups ----
  const dateOf = (d) => d.date || d.periodFrom || '';
  const typeIcon = (t) => TYPE_LABELS[t]?.icon || 'file';
  const typeName = (t) => TYPE_LABELS[t]?.name || 'Dokument';
  const docs = $derived(app.data.documents.filter((d) => d.type !== 'irrelevant'));
  const docById = $derived(new Map(docs.map((d) => [d.id, d])));
  const filesById = $derived(new Map(app.data.files.map((f) => [f.id, f])));
  const sourcesById = $derived(new Map(app.data.sources.map((s) => [s.id, s])));
  function srcName(d) {
    const f = filesById.get(d.fileId);
    return sourcesById.get(f?.sourceId)?.name || f?.origins?.[0]?.sourceName || '';
  }

  // ---- Filter ----
  // Suche über Orama (Dokumente), Filter-Syntax wie "typ:rechnung", "2026" bleibt erhalten
  const searchIds = $derived.by(() => {
    if (!q) return null;
    return search(q, { limit: 1000000 }).documents.map((d) => d.id);
  });
  const years = $derived([...new Set(docs.map((d) => dateOf(d).slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a)));
  const yearOptions = $derived([{ value: 'all', label: 'Alle' }, ...years.map((y) => ({ value: y, label: y }))]);

  const base = $derived.by(() => {
    const list = searchIds
      ? searchIds.map((id) => docById.get(id)).filter(Boolean)
      : docs.slice().sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    return list.filter((d) =>
      (year === 'all' || dateOf(d).startsWith(year)) &&
      (!taxOnly || d.taxRelevant) &&
      (!reviewOnly || isPendingDoc(d)));
  });
  const typeCounts = $derived.by(() => {
    const m = new Map();
    for (const d of base) m.set(d.type, (m.get(d.type) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  });
  const shown = $derived(typeF ? base.filter((d) => d.type === typeF) : base);
  // Unlesbare/unsichere Belege: oben mit Schnellaktionen („Neu prüfen“, „Ist eher: X“)
  const fixable = $derived(docs.filter((d) => isPendingDoc(d) && (isUnreadable(d) || d.alternatives?.length)));
  const pageSize = $derived(view === 'list' ? PAGE_LIST : PAGE_GRID);
  const visible = $derived(shown.slice(0, more * pageSize));

  // Ignorierte Dateien (ohne Finanzbezug)
  const ignoredAll = $derived(app.data.files.filter((f) => f.status === 'ignored'));
  const ignoredShown = $derived.by(() => {
    if (!q) return ignoredAll;
    const t = q.toLowerCase();
    return ignoredAll.filter((f) => `${f.name} ${f.path}`.toLowerCase().includes(t));
  });

  // ---- Vorschaubilder nachladen (nur sichtbare) ----
  function bumpThumbs() { thumbTick++; }
  const thumbOf = (fileId) => { void thumbTick; return thumbs.get(fileId) || ''; };
  $effect(() => {
    if (showIgnored) {
      for (const f of ignoredShown) loadThumb(f.id, bumpThumbs);
    } else if (view === 'grid') {
      for (const d of visible) loadThumb(d.fileId, bumpThumbs);
    }
  });

  // ---- Aktionen ----
  function open(id) { openId = id; }
  function onRowKey(e, id) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(id); }
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function downloadFile(f) {
    try {
      const blob = await getBlob(f.id);
      if (!blob) throw new Error('Original nicht gefunden');
      saveBlob(blob, f.name);
    } catch (e) {
      toast(e.message, { tone: 'bad' });
    }
  }
  // Dateien mit Lesefehler: ruhiger Hinweis mit „Erneut versuchen“ (Details unter Quellen)
  const failedCount = $derived(app.data.files.filter((f) => f.status === 'error').length);
  const hasFilters = $derived(!!q || typeF || year !== 'all' || taxOnly || reviewOnly);
</script>

<div class="docs stack">
  <div class="toolbar">
    <div class="search">
      <span class="sicon"><Icon name="search" size={16} /></span>
      <input class="input" type="search" placeholder="Suchen" value={qInput} oninput={onQ} aria-label="Dokumente suchen" />
      <Tip text="Filter: typ:rechnung · konto:ing · steuer · 2026 · 03.2026 · >100" />
    </div>
    {#if !showIgnored}<Seg bind:value={view} options={VIEW_OPTIONS} />{/if}
  </div>

  {#if !showIgnored}
    <div class="filters">
      <div class="chips" role="group" aria-label="Dokumenttyp">
        <button class="chip" class:on={typeF === null} onclick={() => (typeF = null)} aria-pressed={typeF === null}>
          Alle <span class="cnt">{base.length}</span>
        </button>
        {#each typeCounts as [t, n] (t)}
          <button class="chip" class:on={typeF === t} onclick={() => (typeF = typeF === t ? null : t)} aria-pressed={typeF === t}>
            <Icon name={typeIcon(t)} size={14} />{typeName(t)} <span class="cnt">{n}</span>
          </button>
        {/each}
      </div>
      <div class="row wrap between">
        <div class="scrollx">
          {#if years.length}<Seg bind:value={year} options={yearOptions} size="sm" />{/if}
        </div>
        <div class="chips">
          <button class="chip" class:on={taxOnly} onclick={() => (taxOnly = !taxOnly)} aria-pressed={taxOnly}>Steuerrelevant</button>
          <button class="chip" class:on={reviewOnly} onclick={() => (reviewOnly = !reviewOnly)} aria-pressed={reviewOnly}>Zu prüfen</button>
          <button class="chip" class:on={showIgnored} onclick={() => (showIgnored = true)} aria-pressed={showIgnored}>
            Ignorierte <span class="cnt">{ignoredAll.length}</span>
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div class="row between wrap">
      <div class="chips">
        <button class="chip on" onclick={() => (showIgnored = false)} aria-pressed="true">
          <span class="flip"><Icon name="arrowRight" size={14} /></span>Zurück zu Dokumenten
        </button>
      </div>
      <span class="small muted num">{ignoredShown.length} Dateien <Tip text="Ohne Finanzbezug erkannt; nicht im Archiv." /></span>
    </div>
  {/if}

  {#if failedCount && !showIgnored && !app.progress.running}
    <div class="failbar small" role="status">
      <Icon name="alert" size={15} />
      <span class="grow">{failedCount} {failedCount === 1 ? 'Datei konnte' : 'Dateien konnten'} nicht gelesen werden</span>
      <button class="btn btn-sm btn-ghost" onclick={() => setView('sources')}>Details</button>
      <button class="btn btn-sm" onclick={retryFailedFiles} disabled={retryState.running}>
        <Icon name="refresh" size={14} />{retryState.running ? `Wird eingelesen ${retryState.done + 1} / ${retryState.total} …` : 'Erneut versuchen'}
      </button>
    </div>
  {/if}

  {#if showIgnored}
    {#if ignoredShown.length}
      <div class="card flat tblwrap scroll">
        <table class="tbl">
          <thead><tr><th>Datei</th><th class="hide-s">Pfad</th><th class="hide-s">Herkunft</th><th class="r"></th></tr></thead>
          <tbody>
            {#each ignoredShown as f (f.id)}
              <tr>
                <td>
                  <div class="row fcell">
                    <span class="ic"><Icon name="ban" size={16} /></span>
                    <span class="mono ellipsis fname" title={f.name}>{f.name}</span>
                  </div>
                </td>
                <td class="hide-s small faint"><span class="ellipsis pathc" title={f.path}>{f.path}</span></td>
                <td class="hide-s small muted ellipsis">{f.origins?.[0]?.sourceName || ''}</td>
                <td class="r"><button class="btn btn-sm btn-ghost btn-icon" onclick={() => downloadFile(f)} aria-label="Herunterladen" title="Herunterladen"><Icon name="download" size={14} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="card">
        <Empty icon="check" title={q ? 'Keine Treffer' : 'Nichts ignoriert'}>
          {#snippet action()}
            <button class="btn" onclick={() => (showIgnored = false)}>Zu Dokumenten</button>
          {/snippet}
        </Empty>
      </div>
    {/if}
  {:else if !docs.length}
    <div class="card">
      <Empty icon="file" title="Noch keine Dokumente">
        {#snippet action()}
          <button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="upload" size={16} />Dateien importieren</button>
        {/snippet}
      </Empty>
    </div>
  {:else if !shown.length}
    <div class="card">
      <Empty icon="search" title="Keine Treffer">
        {#snippet action()}
          <button class="btn" onclick={resetFilters} disabled={!hasFilters}>Filter zurücksetzen</button>
        {/snippet}
      </Empty>
    </div>
  {:else}
    {#if fixable.length && !q}
      <div class="card fixes">
        <div class="row between"><strong class="small">Unlesbar oder unsicher <span class="badge warn">{fixable.length}</span></strong><Tip text="Neu prüfen liest die Datei mit höherer Auflösung. „Ist eher“ übernimmt einen anderen erkannten Typ." /></div>
        {#each fixable.slice(0, 6) as d (d.id)}
          <div class="fixrow">
            <button class="fixname" onclick={() => open(d.id)}>
              <Icon name={isUnreadable(d) ? 'alert' : typeIcon(d.type)} size={15} />
              <span class="ellipsis">{d.title || d.displayName || 'Ohne Titel'}</span>
              <span class="small faint ellipsis">{docReason(d)}</span>
            </button>
            <DocFix doc={d} />
          </div>
        {/each}
        {#if fixable.length > 6}<button class="btn btn-sm btn-ghost" onclick={() => setView('review', { tab: 'docs' })}>Alle {fixable.length} in der Prüfliste</button>{/if}
      </div>
    {/if}
    <div class="count small muted num">{shown.length} {shown.length === 1 ? 'Dokument' : 'Dokumente'}</div>

    {#if view === 'grid'}
      <div class="grid-docs">
        {#each visible as d (d.id)}
          <div class="dcard" role="button" tabindex="0" onclick={() => open(d.id)} onkeydown={(e) => onRowKey(e, d.id)} aria-label={d.title || d.displayName}>
            <div class="thumb">
              {#if thumbOf(d.fileId)}
                <img src={thumbOf(d.fileId)} alt="" loading="lazy" decoding="async" />
              {:else}
                <div class="tic"><Icon name={typeIcon(d.type)} size={36} /></div>
              {/if}
            </div>
            <div class="dbody">
              <div class="dtitle ellipsis" title={d.title}>{d.title || d.displayName || 'Ohne Titel'}</div>
              <div class="small muted ellipsis">{d.issuer || d.institution || '–'} · <span class="num">{fmtDate(dateOf(d))}</span></div>
              <div class="row between amt"><Money value={d.amount} /></div>
              <div class="badges">
                <span class="badge">{typeName(d.type)}</span>
                {#if d.taxRelevant}<span class="badge tax">Steuer</span>{/if}
                {#if d.ocr}<span class="badge">OCR</span>{/if}
                {#if d.needsReview && !d.reviewed}<span class="badge warn">Zu prüfen</span>{/if}
              </div>
              {#if srcName(d)}<div class="src"><span class="chip small-chip">{srcName(d)}</span></div>{/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="card flat tblwrap scroll">
        <table class="tbl">
          <thead>
            <tr><th>Datei</th><th>Typ</th><th class="hide-s">Aussteller</th><th>Datum</th><th class="r">Betrag</th><th class="hide-s">Herkunft</th></tr>
          </thead>
          <tbody>
            {#each visible as d (d.id)}
              <tr class="clickable" tabindex="0" onclick={() => open(d.id)} onkeydown={(e) => onRowKey(e, d.id)}>
                <td><div class="mono ellipsis fname" title={d.displayName}>{d.displayName || d.title || '–'}</div></td>
                <td><span class="row small nowrap"><Icon name={typeIcon(d.type)} size={14} />{typeName(d.type)}</span></td>
                <td class="hide-s ellipsis">{d.issuer || d.institution || '–'}</td>
                <td class="num">{fmtDate(dateOf(d))}</td>
                <td class="r"><Money value={d.amount} /></td>
                <td class="hide-s small muted ellipsis">{srcName(d)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if shown.length > visible.length}
      <div class="more">
        <button class="btn" onclick={() => more++}>Mehr laden <span class="num faint">({shown.length - visible.length})</span></button>
      </div>
    {/if}
  {/if}
</div>

{#if openId && !showIgnored}
  <DocViewer id={openId} onclose={() => (openId = null)} />
{/if}

<style>
  .docs { gap: 14px; }
  .failbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border)); border-radius: var(--radius-sm); background: var(--surface); }
  .failbar > :global(svg) { color: var(--warn); }
  .failbar .grow { flex: 1 1 200px; }
  .fixes { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; }
  .fixrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: space-between; }
  .fixname { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 240px; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; padding: 4px 0; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .search { position: relative; flex: 1 1 260px; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .search .input { width: 100%; padding-left: 34px; padding-right: 36px; }
  .search :global(.tip) { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); }
  .sicon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-3); display: inline-flex; pointer-events: none; }
  .filters { display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-width: 0; }
  .chip { transition: background .15s, color .15s, border-color .15s; }
  .chip .cnt { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .chip.on .cnt { color: var(--accent); opacity: .8; }
  .scrollx { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .scrollx::-webkit-scrollbar { display: none; }
  .count { margin-top: -4px; }
  .flip { display: inline-flex; transform: rotate(180deg); }

  .grid-docs { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .dcard { display: flex; flex-direction: column; min-width: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); cursor: pointer; transition: transform .14s ease, border-color .14s ease, box-shadow .14s ease; animation: fadeUp .3s ease both; }
  .dcard:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .dcard:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .thumb { aspect-ratio: 4 / 3; background: var(--surface-2); display: grid; place-items: center; overflow: hidden; border-bottom: 1px solid var(--border); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
  .tic { width: 60px; height: 60px; border-radius: 18px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .dbody { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px 12px; min-width: 0; }
  .dtitle { font-weight: 600; font-size: 13.5px; }
  .amt { margin-top: 2px; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .badges .badge { height: 18px; font-size: 10.5px; padding: 0 6px; }
  .src { margin-top: 4px; min-width: 0; }
  .small-chip { height: 22px; font-size: 11.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

  .tblwrap { max-height: 70vh; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
  .tblwrap .tbl tr.clickable { cursor: pointer; }
  .tblwrap .tbl tr:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .fname { font-size: 12px; max-width: 360px; min-width: 0; }
  .pathc { display: inline-block; max-width: 280px; font-size: 12px; }
  .nowrap { white-space: nowrap; }
  .fcell { gap: 8px; min-width: 0; }
  .ic { color: var(--text-3); display: inline-flex; flex: none; }
  .r :global(.num) { font-weight: 550; }

  .more { display: flex; justify-content: center; padding: 6px 0 10px; }

  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  @media (max-width: 720px) {
    .hide-s { display: none; }
    .fname { max-width: 60vw; }
    .grid-docs { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  }
</style>
