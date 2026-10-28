<script>
  import { app, setView, accountName } from '../store/state.svelte.js';
  import { search, snippet } from '../store/search.js';
  import Icon from '../ui/Icon.svelte';
  import Money from '../ui/Money.svelte';
  import { fmtDate } from '../util/format.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import { CATEGORIES } from '../classify/categories.js';

  let q = $state('');
  let sel = $state(0);
  let input = $state();
  const res = $derived.by(() => { void app.dataVersion; return app.searchOpen ? search(q, { limit: 8 }) : null; });
  const flat = $derived(res ? [
    ...res.documents.map(d => ({ kind: 'doc', item: d })),
    ...res.transactions.map(t => ({ kind: 'tx', item: t })),
    ...res.contracts.map(c => ({ kind: 'contract', item: c })),
  ] : []);
  const catColor = (id) => CATEGORIES.find(c => c.id === id)?.color || 'var(--text-3)';
  const HINTS = ['rewe 2026', '>100', 'typ:rechnung', 'konto:ing', 'steuer', 'abo', '03.2026'];

  $effect(() => { if (app.searchOpen) { sel = 0; setTimeout(() => input?.focus(), 10); } });
  $effect(() => { void q; sel = 0; });

  function close() { app.searchOpen = false; }
  function open(r) {
    close();
    if (r.kind === 'doc') setView('documents', { open: r.item.id });
    else if (r.kind === 'tx') setView('transactions', { focus: r.item.id, search: q });
    else setView('contracts', { focus: r.item.id });
  }
  function key(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(flat.length - 1, sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); }
    else if (e.key === 'Enter' && flat[sel]) open(flat[sel]);
  }
  const idx = (kind, i) => kind === 'doc' ? i : kind === 'tx' ? res.documents.length + i : res.documents.length + res.transactions.length + i;
</script>

{#if app.searchOpen}
  <div class="back" role="presentation" onclick={close}></div>
  <div class="pal fade-up" role="dialog" aria-label="Suche">
    <div class="in">
      <Icon name="search" />
      <input bind:this={input} bind:value={q} onkeydown={key} placeholder="Händler, Betrag, Text, Datei …" />
      <kbd>Esc</kbd>
    </div>
    <div class="hints">
      {#each HINTS as h}<button class="chip" onclick={() => { q = q ? q + ' ' + h : h; input.focus(); }}>{h}</button>{/each}
    </div>
    <div class="res scroll">
      {#if res && res.total === 0}
        <div class="none muted">Nichts gefunden</div>
      {/if}
      {#if res?.documents.length}
        <div class="grp">Dokumente</div>
        {#each res.documents as d, i}
          <button class="hit" class:sel={sel === idx('doc', i)} onmouseenter={() => (sel = idx('doc', i))} onclick={() => open({ kind: 'doc', item: d })}>
            <span class="hi"><Icon name={TYPE_LABELS?.[d.type]?.icon || 'file'} size={16} /></span>
            <span class="grow"><span class="t ellipsis">{d.title || d.displayName}</span><span class="s ellipsis">{snippet(d.text, q, 110)}</span></span>
            <span class="r"><Money value={d.amount} /><span class="s">{fmtDate(d.date)}</span></span>
          </button>
        {/each}
      {/if}
      {#if res?.transactions.length}
        <div class="grp">Buchungen</div>
        {#each res.transactions as t, i}
          <button class="hit" class:sel={sel === idx('tx', i)} onmouseenter={() => (sel = idx('tx', i))} onclick={() => open({ kind: 'tx', item: t })}>
            <span class="hi"><span class="dot" style="background:{catColor(t.category)}"></span></span>
            <span class="grow"><span class="t ellipsis">{t.counterparty || t.counterpartyRaw || t.bookingText}</span><span class="s ellipsis">{t.purpose} · {accountName(t.accountId)}</span></span>
            <span class="r"><Money value={t.amount} color /><span class="s">{fmtDate(t.bookingDate)}</span></span>
          </button>
        {/each}
      {/if}
      {#if res?.contracts.length}
        <div class="grp">Verträge & Abos</div>
        {#each res.contracts as c, i}
          <button class="hit" class:sel={sel === idx('contract', i)} onmouseenter={() => (sel = idx('contract', i))} onclick={() => open({ kind: 'contract', item: c })}>
            <span class="hi"><Icon name="repeat" size={16} /></span>
            <span class="grow"><span class="t ellipsis">{c.provider}</span><span class="s">{c.interval}</span></span>
            <span class="r"><Money value={c.amount} /></span>
          </button>
        {/each}
      {/if}
    </div>
    {#if res && res.total > flat.length}<div class="more small faint">{res.total} Treffer – Enter öffnet, in „Buchungen“ alle sehen</div>{/if}
  </div>
{/if}

<style>
  .back { position: fixed; inset: 0; background: rgba(8, 10, 18, .4); backdrop-filter: blur(3px); z-index: 100; }
  .pal { position: fixed; left: 0; right: 0; margin-inline: auto; top: 10vh; width: min(720px, 94vw); max-height: 76vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow-lg); z-index: 101; overflow: hidden; }
  .in { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--text-3); }
  .in input { flex: 1; border: 0; outline: 0; background: none; font-size: 17px; color: var(--text); }
  .hints { display: flex; gap: 6px; padding: 10px 16px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
  .res { padding: 6px; }
  .grp { font-size: 11px; font-weight: 700; color: var(--text-3); text-transform: uppercase; letter-spacing: .05em; padding: 10px 10px 4px; }
  .hit { width: 100%; display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 10px; border: 0; background: none; text-align: left; cursor: pointer; }
  .hit.sel { background: var(--accent-soft); }
  .hi { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--text-2); flex: none; }
  .t { display: block; font-weight: 600; }
  .s { display: block; font-size: 12px; color: var(--text-3); }
  .r { display: flex; flex-direction: column; align-items: flex-end; flex: none; }
  .none { padding: 30px; text-align: center; }
  .more { padding: 8px 16px; border-top: 1px solid var(--border); }
</style>
