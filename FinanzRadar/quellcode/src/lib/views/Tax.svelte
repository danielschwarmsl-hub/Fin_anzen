<script>
  import { app, live, setView, updateDocument, updateTransaction, getBlob, toast } from '../store/state.svelte.js';
  import { buildTaxZip } from '../export/zip.js';
  import { typeLabel, TYPE_LABELS } from '../parsers/naming.js';
  import { fmtDate } from '../util/format.js';
  import Stat from '../ui/Stat.svelte';
  import Seg from '../ui/Seg.svelte';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Money from '../ui/Money.svelte';
  import Empty from '../ui/Empty.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import TaxBreakdown from '../charts/TaxBreakdown.svelte';

  const REASONS = [
    ['lohn', 'Lohn'],
    ['beruf', 'Beruf'],
    ['versicherung_vorsorge', 'Versicherung & Vorsorge'],
    ['kapitalertraege', 'Kapitalerträge'],
    ['haushalt_handwerker', 'Haushalt & Handwerker'],
    ['spenden', 'Spenden'],
    ['gesundheit', 'Gesundheit'],
    ['kinder_bildung', 'Kinder & Bildung'],
    ['sonstiges', 'Sonstiges'],
  ];
  const REASON_LABEL = Object.fromEntries(REASONS);
  const reasonOf = (d) => (REASON_LABEL[d.taxReason] ? d.taxReason : 'sonstiges');

  // ---- Helfer ----
  const docDate = (d) => d.date || d.periodTo || d.periodFrom || '';
  const yearOf = (iso) => (iso || '').slice(0, 4);
  const docTitle = (d) => d.title || typeLabel(d);
  const byDocDateDesc = (a, b) => docDate(b).localeCompare(docDate(a));

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- UI-State ----
  let year = $state('all');
  let includeSuggested = $state(true);
  let zipping = $state(false);
  let addOpen = $state(false);
  let addQ = $state('');
  let addReason = $state('sonstiges');
  let txLimit = $state(200);

  // ---- Abgeleitete Daten ----
  const flaggedDocs = $derived(app.data.documents.filter((d) => d.taxRelevant && d.type !== 'irrelevant'));
  const flaggedTxs = $derived(app.data.transactions.filter((t) => t.taxRelevant));

  const years = $derived(
    [...new Set([...flaggedDocs.map((d) => yearOf(docDate(d))), ...flaggedTxs.map((t) => yearOf(t.bookingDate))])]
      .filter((y) => /^\d{4}$/.test(y))
      .sort()
      .reverse()
  );
  const yearOptions = $derived([{ value: 'all', label: 'Alle' }, ...years.map((y) => ({ value: y, label: y }))]);
  const inYear = (iso) => year === 'all' || yearOf(iso) === year;

  const markedDocs = $derived(flaggedDocs.filter((d) => inYear(docDate(d))).sort(byDocDateDesc));
  const exportDocs = $derived(markedDocs.filter((d) => includeSuggested || d.taxSource === 'user'));
  const markedTxs = $derived(
    flaggedTxs.filter((t) => inYear(t.bookingDate)).sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''))
  );
  const txWithoutReceipt = $derived(markedTxs.filter((t) => !t.receiptDocId && !t.receiptDocIds?.length).length);
  const groups = $derived(
    REASONS.map(([id, label]) => ({ id, label, docs: markedDocs.filter((d) => reasonOf(d) === id) })).filter((g) => g.docs.length)
  );
  const taxes = $derived(live.insights?.taxes || null);

  // Kandidaten für "Dokument hinzufügen": alle nicht markierten Dokumente
  const addCandidates = $derived.by(() => {
    const q = addQ.trim().toLowerCase();
    return app.data.documents
      .filter((d) => !d.taxRelevant && d.type !== 'irrelevant')
      .filter((d) => !q || [d.title, d.institution, d.issuer, typeLabel(d), docDate(d)].join(' ').toLowerCase().includes(q))
      .sort(byDocDateDesc)
      .slice(0, 40);
  });

  // ---- Aktionen ----
  async function confirmDoc(d) {
    await updateDocument(d.id, { taxSource: 'user' });
  }

  async function removeDoc(d) {
    const prev = { taxRelevant: d.taxRelevant, taxSource: d.taxSource ?? null };
    await updateDocument(d.id, { taxRelevant: false, taxSource: 'user' });
    toast('Aus Steuer-Ablage entfernt', { action: { label: 'Rückgängig', fn: () => updateDocument(d.id, prev) } });
  }

  async function setReason(d, e) {
    await updateDocument(d.id, { taxReason: e.currentTarget.value, taxSource: 'user' });
  }

  async function removeTx(t) {
    const prev = { taxRelevant: t.taxRelevant, taxSource: t.taxSource ?? null };
    await updateTransaction(t.id, { taxRelevant: false, taxSource: 'user' });
    toast('Aus Steuer-Ablage entfernt', { action: { label: 'Rückgängig', fn: () => updateTransaction(t.id, prev) } });
  }

  async function flagDoc(d) {
    await updateDocument(d.id, { taxRelevant: true, taxReason: addReason, taxSource: 'user' });
    toast('Markiert', { tone: 'good' });
  }

  async function downloadZip() {
    if (zipping || !exportDocs.length) return;
    zipping = true;
    try {
      const documents = $state.snapshot(exportDocs);
      const blob = await buildTaxZip({
        documents,
        files: $state.snapshot(app.data.files),
        getBlob,
        includeSuggested,
      });
      save(blob, `FinanzRadar_Steuer_${new Date().toISOString().slice(0, 10)}.zip`);
      toast(`${documents.length} Dokumente gepackt`, { tone: 'good' });
    } catch (e) {
      toast(e?.message || 'ZIP konnte nicht erstellt werden', { tone: 'bad' });
    } finally {
      zipping = false;
    }
  }
</script>

<div class="stack">
  <div class="row wrap head">
    {#if years.length}<Seg bind:value={year} options={yearOptions} size="sm" />{/if}
    <div class="grow"></div>
    <div class="row">
      <Toggle bind:checked={includeSuggested} label="Auch Vorschläge" />
      <Tip text="Automatisch erkannte Dokumente ebenfalls ins ZIP aufnehmen. Bestätigte sind immer dabei." />
    </div>
    <button class="btn btn-primary btn-lg" onclick={downloadZip} disabled={zipping || !exportDocs.length} aria-busy={zipping}>
      <Icon name={zipping ? 'refresh' : 'download'} />{zipping ? 'Wird gepackt …' : 'ZIP herunterladen'}
    </button>
  </div>
  {#if zipping}<div class="skeleton bar" aria-hidden="true"></div>{/if}

  <div class="grid g2">
    <Stat label="Markierte Dokumente" value={markedDocs.length} format="num" icon="file" tone="tax" sub={`${exportDocs.length} im ZIP`} />
    <Stat label="Buchungen ohne Beleg" value={txWithoutReceipt} format="num" icon="receipt" tip="Der Kontoauszug dient als Nachweis." />
  </div>

  {#if !flaggedDocs.length && !flaggedTxs.length}
    <div class="card">
      <Empty icon="tax" title="Noch nichts markiert">
        {#snippet action()}
          <button class="btn btn-primary" onclick={() => (addOpen = true)}><Icon name="plus" />Dokument hinzufügen</button>
        {/snippet}
      </Empty>
    </div>
  {:else if !markedDocs.length && !markedTxs.length}
    <div class="card">
      <Empty icon="calendar" title="Keine Markierungen in {year}">
        {#snippet action()}
          <button class="btn btn-primary" onclick={() => (year = 'all')}>Alle Jahre zeigen</button>
        {/snippet}
      </Empty>
    </div>
  {:else}
    {#if groups.length}
      <div class="grid g2">
        {#each groups as g (g.id)}
          <section class="card fade-up">
            <div class="card-head">
              <h3>{g.label}</h3>
              <span class="badge">{g.docs.length}</span>
            </div>
            <ul class="plain">
              {#each g.docs as d (d.id)}
                <li class="drow">
                  <div class="dmain">
                    <button class="link ellipsis" onclick={() => setView('documents', { open: d.id })}>{docTitle(d)}</button>
                    <div class="meta small faint row">
                      <span class="num">{fmtDate(docDate(d))}</span>
                      {#if d.institution}<span class="ellipsis">{d.institution}</span>{/if}
                    </div>
                  </div>
                  <Money value={d.amount} class="small" />
                  <span class="badge {d.taxSource === 'user' ? 'good' : 'warn'}">{d.taxSource === 'user' ? 'bestätigt' : 'Vorschlag'}</span>
                  <div class="acts">
                    {#if d.taxSource !== 'user'}
                      <button class="btn btn-sm btn-icon" title="Bestätigen" aria-label="Bestätigen" onclick={() => confirmDoc(d)}><Icon name="check" size={14} /></button>
                    {/if}
                    <button class="btn btn-sm btn-icon btn-ghost" title="Entfernen" aria-label="Entfernen" onclick={() => removeDoc(d)}><Icon name="x" size={14} /></button>
                    <select class="input sel" value={d.type} onchange={(e) => updateDocument(d.id, { type: e.currentTarget.value })} aria-label="Dokumenttyp ändern" title="Dokumenttyp – Änderung liest die Datei neu ein">
                      {#each Object.entries(TYPE_LABELS) as [v, t] (v)}<option value={v}>{t.name}</option>{/each}
                    </select>
                    <select class="input sel" value={reasonOf(d)} onchange={(e) => setReason(d, e)} aria-label="Steuergrund ändern" title="Steuergrund">
                      {#each REASONS as [v, l] (v)}<option value={v}>{l}</option>{/each}
                    </select>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}

    {#if markedTxs.length}
      <section class="card fade-up">
        <div class="card-head">
          <h3>Markierte Buchungen</h3>
          <span class="badge">{markedTxs.length}</span>
        </div>
        <div class="scroll">
          <table class="tbl">
            <thead>
              <tr><th>Datum</th><th>Gegenpartei</th><th class="r">Betrag</th><th>Beleg</th><th><span class="sr">Aktion</span></th></tr>
            </thead>
            <tbody>
              {#each markedTxs.slice(0, txLimit) as t (t.id)}
                <tr>
                  <td class="num small">{fmtDate(t.bookingDate)}</td>
                  <td><span class="ellipsis tx-name">{t.counterparty || t.counterpartyRaw || t.purpose || '–'}</span></td>
                  <td class="r"><Money value={t.amount} /></td>
                  <td>
                    {#if t.receiptDocId || t.receiptDocIds?.length}
                      <span class="badge good">{(t.receiptDocIds?.length || 1) > 1 ? `${t.receiptDocIds.length} Belege` : 'Beleg'}</span>
                    {:else}
                      <Tip text="Kein Beleg verknüpft. Der Kontoauszug dient als Nachweis.">
                        <span class="hint"><Icon name="alert" size={15} /></span>
                      </Tip>
                    {/if}
                  </td>
                  <td class="r">
                    <button class="btn btn-sm btn-icon btn-ghost" title="Entfernen" aria-label="Entfernen" onclick={() => removeTx(t)}><Icon name="x" size={14} /></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if markedTxs.length > txLimit}
          <div class="more">
            <button class="btn btn-sm" onclick={() => (txLimit += 200)}>Mehr laden ({markedTxs.length - txLimit})</button>
          </div>
        {/if}
      </section>
    {/if}
  {/if}

  <Collapsible title="Transparenz: Steuern & Abgaben">
    {#if taxes}
      <TaxBreakdown {taxes} />
    {:else}
      <p class="muted small">Noch keine Daten</p>
    {/if}
  </Collapsible>

  <Collapsible title="Dokument hinzufügen" bind:open={addOpen}>
    <div class="row wrap addrow">
      <input class="input grow" type="search" placeholder="Suchen" bind:value={addQ} aria-label="Dokument suchen" />
      <select class="input" bind:value={addReason} aria-label="Steuergrund">
        {#each REASONS as [v, l] (v)}<option value={v}>{l}</option>{/each}
      </select>
    </div>
    <ul class="plain">
      {#each addCandidates as d (d.id)}
        <li class="drow">
          <span class="ellipsis grow">{docTitle(d)}</span>
          <span class="small faint num">{fmtDate(docDate(d))}</span>
          <button class="btn btn-sm" onclick={() => flagDoc(d)}><Icon name="plus" size={14} />Markieren</button>
        </li>
      {:else}
        <li class="muted small">Keine Treffer</li>
      {/each}
    </ul>
  </Collapsible>
</div>

<style>
  .head { row-gap: 10px; }
  .bar { height: 4px; border-radius: 4px; }
  .plain { list-style: none; margin: 0; padding: 0; }
  .drow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--border); transition: background .15s; }
  .drow:last-child { border-bottom: 0; padding-bottom: 0; }
  .dmain { flex: 1 1 180px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .meta { gap: 6px; min-width: 0; }
  .link { display: block; max-width: 100%; border: 0; padding: 0; background: none; cursor: pointer; text-align: left; font-weight: 600; color: var(--text); }
  .link:hover { color: var(--accent); }
  .acts { display: flex; align-items: center; gap: 4px; }
  .sel { height: 28px; max-width: 160px; font-size: 12.5px; padding: 0 8px; border-radius: 8px; }
  .hint { color: var(--warn); display: inline-flex; }
  .tx-name { display: block; max-width: 280px; }
  .addrow { margin-bottom: 10px; }
  .more { display: flex; justify-content: center; padding-top: 12px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .scroll { max-height: 520px; }
  @media (max-width: 520px) {
    .sel { max-width: 130px; }
    .tx-name { max-width: 150px; }
  }
</style>
