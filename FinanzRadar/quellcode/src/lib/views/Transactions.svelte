<script>
  // Buchungen: vollständiges Journal mit Filtern, Gruppierung nach Monat, Mehrfachauswahl und Detail-Panel
  import { untrack, tick } from 'svelte';
  import { app, setView, effectiveRange, updateTransaction, updateTransactions, putRecord, toast, reload, autoLearn } from '../store/state.svelte.js';
  import { isPendingTx } from './reviewModel.js';
  import { search } from '../store/search.js';
  import { postProcess } from '../store/postprocess.js';
  import { CATEGORIES } from '../classify/categories.js';
  import { suggestRuleFromCorrection } from '../classify/rules.js';
  import { buildCsvExport } from '../export/zip.js';
  import { fmtDate, fmtMonth, uid } from '../util/format.js';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Seg from '../ui/Seg.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Money from '../ui/Money.svelte';
  import Empty from '../ui/Empty.svelte';
  import CategoryPicker from '../ui/CategoryPicker.svelte';
  import TxDrawer from './TxDrawer.svelte';

  const PAGE = 150;
  const CAT = new Map(CATEGORIES.map(c => [c.id, c]));
  const MF = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthLabel = (ym) => MF.format(new Date(ym + '-01T12:00:00Z'));

  // ---- Filter-Zustand ----
  let qInput = $state('');
  let q = $state('');
  let accountIds = $state([]);
  let categoryIds = $state([]);
  let dir = $state('all');
  let showTransfers = $state(false);
  let onlyTax = $state(false);
  let onlyAbo = $state(false);
  let onlyReview = $state(false);
  let allTime = $state(false);
  let monthFilter = $state(null);

  let limit = $state(PAGE);
  let sel = $state(new Set());
  let lastIdx = -1;
  let drawerId = $state(null);
  let editCatId = $state(null);
  let pop = $state(null);
  let vw = $state(1200); // Fensterbreite (Sticky-Header)
  let cw = $state(1200); // Breite der Tabelle: Spalten richten sich danach, nicht nach dem Fenster (Seitenleiste!)
  let sentinel = $state(null);
  let pendingScroll = $state(null);
  let ruleBusy = false;
  let qTimer;

  function resetFilters() {
    qInput = ''; q = ''; accountIds = []; categoryIds = []; dir = 'all'; showTransfers = false;
    onlyTax = false; onlyAbo = false; onlyReview = false; allTime = false; monthFilter = null;
  }
  function applyParams(p) {
    if (!p || !Object.keys(p).length) return;
    resetFilters();
    if (p.category) categoryIds = [p.category];
    if (p.search) { qInput = q = String(p.search); }
    if (p.accountId) accountIds = [p.accountId];
    if (p.month) monthFilter = p.month;
    if (p.direction === 'in' || p.direction === 'out') dir = p.direction;
    if (p.tax) onlyTax = true;
    if (p.abo) onlyAbo = true;
    if (p.review) onlyReview = true;
    if (p.transfers) showTransfers = true;
    if (p.focus) {
      allTime = true;
      const t = app.data.transactions.find(x => x.id === p.focus);
      if (t?.isTransfer || t?.category === 'umbuchung') showTransfers = true;
      drawerId = p.focus;
      pendingScroll = p.focus;
    }
  }
  let appliedParams = app.params;
  applyParams(app.params);
  $effect(() => {
    const p = app.params;
    if (p === appliedParams) return;
    appliedParams = p;
    untrack(() => applyParams(p));
  });

  function onSearchInput(e) {
    qInput = e.target.value;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => (q = qInput), 180);
  }

  // ---- Daten ----
  const range = $derived.by(() => {
    const f = app.filter; void f.preset; void f.from; void f.to; void app.dataVersion;
    return untrack(() => effectiveRange());
  });
  const searchSet = $derived.by(() => {
    const term = q.trim();
    if (!term) return null;
    void app.data.transactions;
    return untrack(() => new Set(search(term, { limit: 200000 }).transactions.map(t => t.id)));
  });
  const sortedAll = $derived.by(() => {
    void app.data.transactions; void app.data.transactions.length;
    return untrack(() => app.data.transactions.slice().sort((a, b) => {
      const x = a.bookingDate || '', y = b.bookingDate || '';
      return x < y ? 1 : x > y ? -1 : 0;
    }));
  });
  const filtered = $derived.by(() => {
    void app.dataVersion;
    const all = sortedAll, ss = searchSet, r = range;
    const gset = app.filter.accountIds?.length ? new Set(app.filter.accountIds) : null;
    const aset = accountIds.length ? new Set(accountIds) : null;
    const cset = categoryIds.length ? new Set(categoryIds) : null;
    const mf = monthFilter, at = allTime, d = dir, st = showTransfers, ot = onlyTax, oa = onlyAbo, or = onlyReview;
    return untrack(() => all.filter(t => {
      const date = t.bookingDate || '';
      if (mf) { if (!date.startsWith(mf)) return false; }
      else if (!at && r) { if (r.from && date < r.from) return false; if (r.to && date > r.to) return false; }
      if (gset && !gset.has(t.accountId)) return false;
      if (aset && !aset.has(t.accountId)) return false;
      if (cset && !cset.has(t.category || 'none')) return false;
      if (d === 'in' && !(t.amount > 0)) return false;
      if (d === 'out' && !(t.amount < 0)) return false;
      if (!st && (t.isTransfer || t.category === 'umbuchung')) return false;
      if (ot && !t.taxRelevant) return false;
      if (oa && !t.contractId) return false;
      if (or && !isPendingTx(t)) return false;
      if (ss && !ss.has(t.id)) return false;
      return true;
    }));
  });
  const summary = $derived.by(() => {
    const list = filtered; void app.dataVersion;
    return untrack(() => {
      let income = 0, expense = 0;
      for (const t of list) { if (t.amount > 0) income += t.amount; else expense += t.amount; }
      return { count: list.length, income, expense, net: income + expense };
    });
  });
  const monthSums = $derived.by(() => {
    const list = filtered; void app.dataVersion;
    return untrack(() => {
      const m = new Map();
      for (const t of list) {
        const k = (t.bookingDate || '').slice(0, 7);
        const e = m.get(k) || { sum: 0, count: 0 };
        e.sum += t.amount; e.count++;
        m.set(k, e);
      }
      return m;
    });
  });
  const rows = $derived.by(() => {
    const list = filtered, ms = monthSums, n = Math.min(limit, list.length);
    return untrack(() => {
      const out = [];
      let cur = null;
      for (let i = 0; i < n; i++) {
        const t = list[i];
        const k = (t.bookingDate || '').slice(0, 7);
        if (k !== cur) { cur = k; const e = ms.get(k); out.push({ key: 'm' + k, type: 'm', month: k, label: k ? monthLabel(k) : 'Ohne Datum', sum: e?.sum || 0, count: e?.count || 0 }); }
        out.push({ key: t.id, type: 't', tx: t, idx: i });
      }
      return out;
    });
  });
  // Gleiches Kriterium wie die Prüfliste (Kategorie unsicher oder offene Prüfungen)
  const reviewCount = $derived.by(() => { void app.dataVersion; return untrack(() => app.data.transactions.reduce((n, t) => n + (isPendingTx(t) ? 1 : 0), 0)); });
  const accLabels = $derived(new Map(app.data.accounts.map(a => [a.id, accLabel(a)])));
  function accLabel(a) {
    const inst = a.institution, nm = a.name;
    return inst && nm && nm !== inst ? `${inst} · ${nm}` : (nm || inst || 'Konto');
  }
  const accShort = (id) => { const a = app.data.accounts.find(x => x.id === id); return a ? (a.name || a.institution || 'Konto') : '–'; };

  const filterKey = $derived(JSON.stringify([q, accountIds, categoryIds, dir, showTransfers, onlyTax, onlyAbo, onlyReview, allTime, monthFilter, range?.from, range?.to, app.filter.accountIds]));
  const anyFilter = $derived(!!(q || accountIds.length || categoryIds.length || dir !== 'all' || showTransfers || onlyTax || onlyAbo || onlyReview || allTime || monthFilter));

  $effect(() => { void filterKey; untrack(() => { limit = PAGE; sel = new Set(); lastIdx = -1; }); });

  // Zur fokussierten Buchung scrollen
  $effect(() => {
    const id = pendingScroll;
    if (!id) return;
    const idx = filtered.findIndex(t => t.id === id);
    if (idx < 0) return;
    untrack(() => { if (limit < idx + 1) limit = idx + PAGE; });
    tick().then(() => {
      document.querySelector(`[data-tx="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      pendingScroll = null;
    });
  });

  // Nachladen beim Scrollen
  $effect(() => {
    void limit;
    const el = sentinel;
    if (!el) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { rootMargin: '900px' });
    io.observe(el);
    return () => io.disconnect();
  });
  function more() { limit = Math.min(limit + PAGE, filtered.length); }

  // ---- Darstellung ----
  const showAcct = $derived(cw >= 960);
  const showFlags = $derived(cw >= 810);
  const showCat = $derived(cw >= 690);
  const narrow = $derived(cw < 560);
  const cols = $derived(4 + (showAcct ? 1 : 0) + (showFlags ? 1 : 0) + (showCat ? 1 : 0));
  const sticky = $derived(vw > 860);

  function catLabel(category, sub) {
    if (!category) return 'Ohne Kategorie';
    const c = CAT.get(category);
    if (!c) return category;
    const s = sub && c.subs?.find(x => x.id === sub);
    return s ? `${c.label} › ${s.label}` : c.label;
  }
  const catColor = (id) => CAT.get(id)?.color || 'var(--text-3)';

  // ---- Popover ----
  function onWinClick(e) {
    if (pop && !e.target.closest?.(`[data-pop="${pop}"]`)) pop = null;
  }
  function onWinKey(e) { if (e.key === 'Escape' && pop) { pop = null; } }
  const togglePop = (n) => (pop = pop === n ? null : n);
  function toggleIn(arr, v) { return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]; }

  // ---- Kategorie ändern ----
  async function setCategory(tx, { category, subcategory }) {
    if (!category) return;
    if (ruleBusy) { toast('Bitte kurz warten …'); return; }
    if (tx.category === category && (tx.subcategory || null) === (subcategory || null)) return;
    const snap = $state.snapshot(tx);
    await updateTransaction(tx.id, { category, subcategory: subcategory || null, categorySource: 'user', confidence: 1, needsReview: false, reviewed: true });
    // Zweite gleiche Korrektur derselben Gegenpartei → Regel entsteht automatisch (eigener Toast mit Rückgängig)
    ruleBusy = true;
    let learned = false;
    try { learned = await autoLearn(snap, category, subcategory || null); } finally { ruleBusy = false; }
    if (learned) return;
    toast(`Kategorie: ${catLabel(category, subcategory)}`, { ms: 9000, action: { label: 'Immer so', fn: () => alwaysSo(snap, subcategory ? `${category}.${subcategory}` : category) } });
  }
  async function alwaysSo(snap, category) {
    if (ruleBusy) return;
    ruleBusy = true;
    try {
      const rule = suggestRuleFromCorrection(snap, category);
      if (!rule) { toast('Keine Regel ableitbar'); return; }
      if (!rule.id) rule.id = uid('rule_');
      const before = new Map(app.data.transactions.map(t => [t.id, t.category]));
      toast('Regel wird angewendet …', { ms: 2500 });
      await putRecord('rules', rule);
      await postProcess();
      await reload();
      let n = 0;
      const cat = String(category).split('.')[0];
      for (const t of app.data.transactions) if (t.category === cat && before.get(t.id) !== cat) n++;
      n = Math.max(n, 1);
      toast(`Regel angewendet auf ${n} ${n === 1 ? 'Buchung' : 'Buchungen'}`, { tone: 'good' });
    } catch (e) {
      console.error(e);
      toast('Regel konnte nicht angewendet werden', { tone: 'bad' });
    } finally { ruleBusy = false; }
  }
  function focusSelect(node) {
    const s = node.querySelector('select');
    s?.focus();
    try { s?.showPicker?.(); } catch { /* ohne Nutzeraktion nicht erlaubt */ }
  }

  // ---- Auswahl ----
  const allSel = $derived(sel.size > 0 && sel.size >= filtered.length);
  function toggle(e, r) {
    const next = new Set(sel);
    const id = r.tx.id;
    if (e.shiftKey && lastIdx >= 0) {
      const a = Math.min(lastIdx, r.idx), b = Math.max(lastIdx, r.idx);
      const add = !sel.has(id);
      for (let i = a; i <= b; i++) { const x = filtered[i]?.id; if (x) add ? next.add(x) : next.delete(x); }
    } else if (next.has(id)) next.delete(id); else next.add(id);
    lastIdx = r.idx;
    sel = next;
  }
  function toggleAll() { sel = allSel ? new Set() : new Set(filtered.map(t => t.id)); }
  const selTx = $derived.by(() => { void app.dataVersion; const s = sel; return untrack(() => (s.size ? filtered.filter(t => s.has(t.id)) : [])); });
  const allSelTax = $derived(selTx.length > 0 && selTx.every(t => t.taxRelevant));

  async function bulkCategory(category) {
    const ids = [...sel];
    pop = null;
    await updateTransactions(ids, { category, subcategory: null, categorySource: 'user', confidence: 1, needsReview: false });
    toast(`${ids.length} Buchungen: ${catLabel(category)}`, { tone: 'good' });
    sel = new Set();
  }
  async function bulkTax() {
    const on = !allSelTax;
    const list = selTx;
    if (on) {
      const noReason = list.filter(t => !t.taxReason).map(t => t.id);
      const withReason = list.filter(t => t.taxReason).map(t => t.id);
      if (noReason.length) await updateTransactions(noReason, { taxRelevant: true, taxReason: 'sonstiges', taxSource: 'user' });
      if (withReason.length) await updateTransactions(withReason, { taxRelevant: true, taxSource: 'user' });
    } else {
      await updateTransactions(list.map(t => t.id), { taxRelevant: false, taxSource: 'user' });
    }
    toast(on ? `${list.length} als steuerrelevant markiert` : 'Steuer-Markierung entfernt', { tone: 'good' });
    sel = new Set();
  }
  async function bulkTransfer() {
    const ids = [...sel];
    await updateTransactions(ids, { isTransfer: true, category: 'umbuchung', subcategory: null, categorySource: 'user', confidence: 1, needsReview: false });
    toast(`${ids.length} als Umbuchung markiert`, { tone: 'good' });
    sel = new Set();
  }

  // ---- Export ----
  function exportCsv() {
    let csv = buildCsvExport($state.snapshot(filtered), $state.snapshot(app.data.accounts));
    if (!csv.startsWith('﻿')) csv = '﻿' + csv;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `buchungen_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`${filtered.length} Buchungen exportiert`, { tone: 'good' });
  }

  // ---- Drawer ----
  const drawerIdx = $derived(drawerId ? filtered.findIndex(t => t.id === drawerId) : -1);
  function openDrawer(tx) { drawerId = tx.id; }
  function step(delta) {
    const t = filtered[drawerIdx + delta];
    if (!t) return;
    drawerId = t.id;
    if (drawerIdx + delta + 20 > limit) more();
  }
  function rowKey(e, tx) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(tx); }
  }
  const stop = (e) => e.stopPropagation();
</script>

<svelte:window bind:innerWidth={vw} onclick={onWinClick} onkeydown={onWinKey} />

{#snippet flagIcons(tx)}
  <span class="flags">
    {#if tx.receiptDocId}<span class="fl good" title="Beleg verknüpft"><Icon name="receipt" size={15} /></span>{/if}
    {#if tx.contractId}<span class="fl" title="Abo / Vertrag"><Icon name="repeat" size={15} /></span>{/if}
    {#if tx.isTransfer}<span class="fl" title="Umbuchung"><Icon name="refresh" size={15} /></span>{/if}
    {#if tx.splits?.length}<span class="fl" title="Aufgeteilt"><Icon name="split" size={15} /></span>{/if}
    {#if tx.taxRelevant}<span class="badge tax" title="Steuerrelevant">Steuer</span>{/if}
    {#if isPendingTx(tx)}<span class="rdot" title="Bitte prüfen"></span>{/if}
  </span>
{/snippet}

{#snippet catList(selected, onpick, multi)}
  <div class="pop-list scroll">
    {#each CATEGORIES as c}
      <button class="opt" role="menuitem" onclick={() => onpick(c.id)}>
        {#if multi}<span class="ck" class:on={selected.includes(c.id)}><Icon name="check" size={11} stroke={3} /></span>{/if}
        <span class="dot" style="background:{c.color}"></span><span class="ellipsis">{c.label}</span>
      </button>
    {/each}
    {#if multi}
      <button class="opt" role="menuitem" onclick={() => onpick('none')}>
        <span class="ck" class:on={selected.includes('none')}><Icon name="check" size={11} stroke={3} /></span>
        <span class="dot" style="background:var(--text-3)"></span><span class="ellipsis">Ohne Kategorie</span>
      </button>
    {/if}
  </div>
{/snippet}

<div class="stack">
  {#if !app.data.transactions.length}
    <div class="card">
      <Empty icon="list" title="Noch keine Buchungen">
        {#snippet action()}<button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="plus" size={16} />Dateien hinzufügen</button>{/snippet}
      </Empty>
    </div>
  {:else}
    <div class="toolbar">
      <div class="row wrap" style="gap:8px">
        <label class="searchbox">
          <Icon name="search" size={16} />
          <input class="sin" type="search" placeholder="Buchungen durchsuchen …" value={qInput} oninput={onSearchInput} aria-label="Buchungen durchsuchen" />
          <Tip text="Filter: konto:ing  kat:wohnen  steuer  abo  >100  <50  2026  03.2026  „exakter text“" side="bottom" />
        </label>
        <button class="btn btn-ghost btn-sm" onclick={exportCsv} disabled={!filtered.length} title="Gefilterte Buchungen als CSV exportieren"><Icon name="download" size={15} />CSV</button>
      </div>

      <div class="row wrap chips">
        <div class="pw" data-pop="acc">
          <button class="chip" class:on={accountIds.length > 0} onclick={() => togglePop('acc')} aria-haspopup="menu" aria-expanded={pop === 'acc'}>
            <Icon name="bank" size={14} />Konto{#if accountIds.length}<span>· {accountIds.length}</span>{/if}<Icon name="chevronDown" size={13} />
          </button>
          {#if pop === 'acc'}
            <div class="pop fade-up" role="menu">
              <div class="pop-list scroll">
                {#each app.data.accounts as a (a.id)}
                  <button class="opt" role="menuitemcheckbox" aria-checked={accountIds.includes(a.id)} onclick={() => (accountIds = toggleIn(accountIds, a.id))}>
                    <span class="ck" class:on={accountIds.includes(a.id)}><Icon name="check" size={11} stroke={3} /></span>
                    <span class="ellipsis">{accLabels.get(a.id)}</span>
                  </button>
                {:else}<div class="opt faint">Keine Konten</div>{/each}
              </div>
            </div>
          {/if}
        </div>

        <div class="pw" data-pop="cat">
          <button class="chip" class:on={categoryIds.length > 0} onclick={() => togglePop('cat')} aria-haspopup="menu" aria-expanded={pop === 'cat'}>
            <Icon name="tag" size={14} />Kategorie{#if categoryIds.length}<span>· {categoryIds.length}</span>{/if}<Icon name="chevronDown" size={13} />
          </button>
          {#if pop === 'cat'}
            <div class="pop fade-up" role="menu">{@render catList(categoryIds, (id) => (categoryIds = toggleIn(categoryIds, id)), true)}</div>
          {/if}
        </div>

        <Seg bind:value={dir} size="sm" options={[{ value: 'all', label: 'Alle' }, { value: 'in', label: 'Einnahmen' }, { value: 'out', label: 'Ausgaben' }]} />

        <button class="chip" class:on={onlyTax} onclick={() => (onlyTax = !onlyTax)} aria-pressed={onlyTax}>Nur Steuer</button>
        <button class="chip" class:on={onlyAbo} onclick={() => (onlyAbo = !onlyAbo)} aria-pressed={onlyAbo}>Nur Abos</button>
        <button class="chip" class:on={onlyReview} onclick={() => (onlyReview = !onlyReview)} aria-pressed={onlyReview}>
          Zu prüfen{#if reviewCount}<span class="badge warn">{reviewCount}</span>{/if}
        </button>
        <button class="chip" class:on={allTime} onclick={() => (allTime = !allTime)} aria-pressed={allTime} title="Gewählten Zeitraum ignorieren"><Icon name="calendar" size={14} />Ganzer Zeitraum</button>
        {#if monthFilter}<button class="chip on" onclick={() => (monthFilter = null)} title="Monatsfilter entfernen">{fmtMonth(monthFilter)}<Icon name="x" size={12} /></button>{/if}
        <Toggle bind:checked={showTransfers} label="Umbuchungen anzeigen" />
        {#if anyFilter}<button class="btn btn-ghost btn-sm" onclick={resetFilters}><Icon name="x" size={14} />Zurücksetzen</button>{/if}
      </div>
    </div>

    <div class="summary row wrap">
      <span><b class="num">{summary.count.toLocaleString('de-DE')}</b> <span class="muted">Buchungen</span>{#if !showTransfers}<span class="tipwrap"><Tip text="Umbuchungen zwischen eigenen Konten sind ausgeblendet und zählen nicht in die Summen." /></span>{/if}</span>
      <span class="sdiv"></span>
      <span><span class="muted">Einnahmen</span> <Money value={summary.income} class="pos" /></span>
      <span><span class="muted">Ausgaben</span> <Money value={summary.expense} /></span>
      <span><span class="muted">Saldo</span> <b><Money value={summary.net} color /></b></span>
    </div>

    {#if !filtered.length}
      <div class="card">
        <Empty icon="search" title="Keine Buchungen gefunden">
          {#snippet action()}<button class="btn" onclick={resetFilters}>Filter zurücksetzen</button>{/snippet}
        </Empty>
      </div>
    {:else}
      <div class="card flat tw" bind:clientWidth={cw}>
        <table class="tbl" class:sticky class:narrow>
          <thead>
            <tr>
              <th class="c"><input type="checkbox" checked={allSel} indeterminate={sel.size > 0 && !allSel} onclick={toggleAll} aria-label="Alle auswählen" /></th>
              <th class="d">Datum</th>
              <th>Gegenpartei</th>
              {#if showAcct}<th class="a">Konto</th>{/if}
              {#if showCat}<th class="k">Kategorie</th>{/if}
              {#if showFlags}<th class="f"></th>{/if}
              <th class="r m">Betrag</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.key)}
              {#if r.type === 'm'}
                <tr class="mh"><td colspan={cols}>
                  <div class="mhc"><strong>{r.label}</strong><span class="faint small">{r.count} {r.count === 1 ? 'Buchung' : 'Buchungen'}</span><span class="grow"></span><Money value={r.sum} color /></div>
                </td></tr>
              {:else}
                {@const tx = r.tx}
                <tr class="tr" class:sel={sel.has(tx.id)} class:foc={drawerId === tx.id} data-tx={tx.id} tabindex="0" onclick={() => openDrawer(tx)} onkeydown={(e) => rowKey(e, tx)}>
                  <td class="c" onclick={stop}><input type="checkbox" checked={sel.has(tx.id)} onclick={(e) => toggle(e, r)} aria-label="Buchung auswählen" /></td>
                  <td class="d num muted">{narrow ? fmtDate(tx.bookingDate, { short: true }) : fmtDate(tx.bookingDate)}</td>
                  <td class="main">
                    <div class="cp ellipsis">{tx.counterparty || tx.counterpartyRaw || '–'}{#if !showFlags}{@render flagIcons(tx)}{/if}</div>
                    <div class="pu muted small ellipsis">{tx.purpose || ''}</div>
                    {#if !showCat}<div class="small faint ellipsis"><span class="dot" style="background:{catColor(tx.category)}"></span> {catLabel(tx.category, tx.subcategory)}</div>{/if}
                  </td>
                  {#if showAcct}<td class="a"><span class="badge ellipsis acct">{accShort(tx.accountId)}</span></td>{/if}
                  {#if showCat}
                    <td class="k" onclick={stop}>
                      {#if editCatId === tx.id}
                        <span class="edit" use:focusSelect onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) editCatId = null; }}>
                          <CategoryPicker category={tx.category} subcategory={tx.subcategory} compact onpick={(p) => { editCatId = null; setCategory(tx, p); }} />
                        </span>
                      {:else}
                        <button class="catbtn" onclick={() => (editCatId = tx.id)} title="Kategorie ändern">
                          <span class="dot" style="background:{catColor(tx.category)}"></span><span class="ellipsis">{catLabel(tx.category, tx.subcategory)}</span>
                        </button>
                      {/if}
                    </td>
                  {/if}
                  {#if showFlags}<td class="f">{@render flagIcons(tx)}</td>{/if}
                  <td class="r m"><Money value={tx.amount} class={tx.amount > 0 ? 'pos' : ''} /></td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>

      {#if filtered.length > limit}
        <div class="more" bind:this={sentinel}>
          <button class="btn btn-ghost btn-sm" onclick={more}>{(filtered.length - limit).toLocaleString('de-DE')} weitere laden</button>
        </div>
      {/if}
    {/if}

    {#if sel.size}
      <div class="bulk card fade-up" role="toolbar" aria-label="Auswahl bearbeiten">
        <b class="num">{sel.size}</b><span class="muted">ausgewählt</span>
        {#if !allSel}<button class="btn btn-ghost btn-sm" onclick={toggleAll}>Alle {filtered.length.toLocaleString('de-DE')}</button>{/if}
        <span class="grow"></span>
        <div class="pw" data-pop="bulk">
          <button class="btn btn-sm" onclick={() => togglePop('bulk')} aria-haspopup="menu" aria-expanded={pop === 'bulk'}><Icon name="tag" size={14} />Kategorie setzen</button>
          {#if pop === 'bulk'}<div class="pop up fade-up" role="menu">{@render catList([], bulkCategory, false)}</div>{/if}
        </div>
        <button class="btn btn-sm" onclick={bulkTax}><Icon name="tax" size={14} />{allSelTax ? 'Steuer entfernen' : 'Steuerrelevant'}</button>
        <button class="btn btn-sm" onclick={bulkTransfer}><Icon name="refresh" size={14} />Umbuchung</button>
        <button class="btn btn-ghost btn-icon btn-sm" onclick={() => (sel = new Set())} aria-label="Auswahl aufheben"><Icon name="x" size={15} /></button>
      </div>
    {/if}
  {/if}
</div>

{#if drawerId}
  <TxDrawer
    txId={drawerId}
    onclose={() => (drawerId = null)}
    onprev={drawerIdx > 0 ? () => step(-1) : null}
    onnext={drawerIdx >= 0 && drawerIdx < filtered.length - 1 ? () => step(1) : null}
    oncategory={setCategory}
  />
{/if}

<style>
  .toolbar { display: flex; flex-direction: column; gap: 10px; }
  .chips { gap: 8px; }
  .searchbox { flex: 1; min-width: 220px; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text-3); transition: border-color .15s, box-shadow .15s; }
  .searchbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); color: var(--accent); }
  .sin { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: var(--text); height: 100%; }
  .sin::-webkit-search-cancel-button { cursor: pointer; }
  .chip { transition: background .15s, color .15s; }
  .chip:hover:not(.on) { background: var(--surface-2); }
  .chip :global(.badge) { height: 16px; padding: 0 5px; font-size: 10.5px; }

  .pw { position: relative; }
  .pop { position: absolute; top: calc(100% + 6px); left: 0; min-width: 220px; max-width: 320px; z-index: 40; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 6px; }
  .pop.up { top: auto; bottom: calc(100% + 8px); left: auto; right: 0; }
  .pop-list { max-height: 320px; display: flex; flex-direction: column; }
  .opt { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 10px; border: 0; background: none; border-radius: 8px; cursor: pointer; text-align: left; color: var(--text); font-size: 13px; }
  .opt:hover, .opt:focus-visible { background: var(--surface-2); }
  .ck { width: 16px; height: 16px; border-radius: 5px; border: 1.5px solid var(--border); display: grid; place-items: center; color: transparent; flex: none; transition: background .12s, border-color .12s; }
  .ck.on { background: var(--accent); border-color: var(--accent); color: #fff; }

  .summary { gap: 18px; padding: 2px 4px; font-size: 13px; }
  .summary > span { display: inline-flex; align-items: center; gap: 6px; }
  .sdiv { width: 1px; height: 14px; background: var(--border); }
  .tipwrap { margin-left: 4px; display: inline-flex; }

  .tw { padding: 0; }
  .tbl { table-layout: fixed; }
  .tbl:not(.sticky) th { position: static; }
  .tbl.sticky th { top: var(--top-h, 66px); }
  .tbl th.c, .tbl td.c { width: 40px; padding-right: 0; }
  .tbl th.d, .tbl td.d { width: 100px; }
  .tbl th.a, .tbl td.a { width: 140px; }
  .tbl th.k, .tbl td.k { width: 210px; }
  .tbl th.f, .tbl td.f { width: 120px; }
  .tbl th.m, .tbl td.m { width: 120px; }
  .tbl td.main { overflow: hidden; }
  .tbl td.k { overflow: hidden; }
  .tbl td.c input, .tbl th.c input { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
  .tr { cursor: pointer; outline-offset: -2px; }
  .tr td { transition: background .12s; }
  .tr.sel td { background: var(--accent-soft); }
  .tr.foc td { background: var(--surface-2); }
  .tr:focus-visible { outline: 2px solid var(--accent); }
  .cp { font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .pu { line-height: 1.3; }
  .acct { max-width: 124px; display: inline-block; line-height: 20px; }
  .catbtn { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 3px 8px; margin: 0 -4px; border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer; font-size: 12.5px; color: var(--text); transition: background .12s, border-color .12s; }
  .catbtn:hover { border-color: var(--border); background: var(--surface); }
  .edit { display: block; }
  .flags { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; color: var(--text-3); }
  .f .flags { margin-left: 0; }
  .fl { display: inline-flex; }
  .fl.good { color: var(--good); }
  .rdot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
  .tw :global(.badge.tax) { height: 18px; font-size: 10.5px; padding: 0 5px; }

  .mh td { background: var(--surface-2); padding: 7px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  .mh:hover td { background: var(--surface-2); }
  .sticky .mh td { position: sticky; top: calc(var(--top-h, 66px) + 34px); z-index: 1; }
  .mhc { display: flex; align-items: center; gap: 10px; }
  .more { display: flex; justify-content: center; padding: 8px; }

  .bulk { position: sticky; bottom: 16px; z-index: 30; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; box-shadow: var(--shadow-lg); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }

  .tbl.narrow th.d, .tbl.narrow td.d { width: 62px; }
  .tbl.narrow th.m, .tbl.narrow td.m { width: 96px; }
  @media (max-width: 720px) {
    .summary { gap: 10px 14px; }
    .sdiv { display: none; }
  }
</style>
