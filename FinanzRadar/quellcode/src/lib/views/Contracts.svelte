<script>
  import { tick, untrack } from 'svelte';
  import { app, setView, putRecord, toast, accountName } from '../store/state.svelte.js';
  import { getCategory } from '../classify/categories.js';
  import { fmtEUR, fmtDate, daysBetween } from '../util/format.js';
  import Stat from '../ui/Stat.svelte';
  import Seg from '../ui/Seg.svelte';
  import Icon from '../ui/Icon.svelte';
  import Empty from '../ui/Empty.svelte';
  import Money from '../ui/Money.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import Tip from '../ui/Tip.svelte';

  // ---- Konstanten ----
  const INTERVALS = {
    weekly: { f: 52 / 12, label: 'wöchentlich' },
    biweekly: { f: 26 / 12, label: '14-täglich' },
    monthly: { f: 1, label: 'monatlich' },
    quarterly: { f: 1 / 3, label: 'vierteljährlich' },
    halfyearly: { f: 1 / 6, label: 'halbjährlich' },
    yearly: { f: 1 / 12, label: 'jährlich' },
  };
  const INTERVAL_ALIAS = {
    weekly: 'weekly', wöchentlich: 'weekly',
    biweekly: 'biweekly', '14-täglich': 'biweekly', zweiwöchentlich: 'biweekly',
    monthly: 'monthly', monatlich: 'monthly',
    quarterly: 'quarterly', vierteljährlich: 'quarterly', quartal: 'quarterly',
    halfyearly: 'halfyearly', semiannual: 'halfyearly', halbjährlich: 'halfyearly',
    yearly: 'yearly', annual: 'yearly', jährlich: 'yearly',
  };
  const KINDS = [
    { value: 'abo', label: 'Abo' },
    { value: 'versicherung', label: 'Versicherung' },
    { value: 'dauerauftrag', label: 'Dauerauftrag' },
    { value: 'miete', label: 'Miete' },
    { value: 'kredit', label: 'Kredit' },
    { value: 'vorsorge', label: 'Vorsorge' },
    { value: 'einkommen', label: 'Einnahme' },
    { value: 'sonstiges', label: 'Sonstiges' },
  ];
  const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
  const TABS = [
    { value: 'alle', label: 'Alle' },
    { value: 'abo', label: 'Abos' },
    { value: 'versicherung', label: 'Versicherungen' },
    { value: 'wohnen', label: 'Wohnen' },
    { value: 'vorsorge', label: 'Vorsorge' },
    { value: 'einnahmen', label: 'Einnahmen' },
    { value: 'ohne', label: 'Ohne Zahlung' },
    { value: 'beendet', label: 'Beendet' },
  ];
  const TAB_KINDS = { abo: ['abo'], versicherung: ['versicherung'], wohnen: ['miete'], vorsorge: ['vorsorge'], einnahmen: ['einkommen'] };

  // ---- Helfer ----
  const today = (() => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  })();
  const intervalKey = (c) => INTERVAL_ALIAS[String(c.interval || 'monthly').toLowerCase()] || 'monthly';
  const monthlyOf = (c) => Math.round(Math.abs(c.amount || 0) * INTERVALS[intervalKey(c)].f);
  const yearlyOf = (c) => Math.round(Math.abs(c.amount || 0) * INTERVALS[intervalKey(c)].f * 12);
  const monthYear = (iso) => (iso ? iso.slice(5, 7) + '.' + iso.slice(0, 4) : '');
  const isoTime = (iso) => Date.parse(iso + 'T12:00:00Z');

  function dueText(days) {
    if (days === 0) return 'heute fällig';
    if (days === 1) return 'morgen';
    if (days > 1) return `in ${days} Tagen`;
    return `vor ${-days} Tagen`;
  }

  /** Preisänderung normalisieren → { delta (Cent, + = teurer), date } | null */
  function priceChangeOf(c) {
    const p = c.priceChange;
    if (p == null || p === false || p === 0) return null;
    if (typeof p === 'number') return { delta: p, date: c.priceChangeDate || null };
    let delta = null;
    if (Number.isFinite(p.delta)) delta = p.delta;
    else if (Number.isFinite(p.to) && Number.isFinite(p.from)) delta = Math.abs(p.to) - Math.abs(p.from);
    if (!delta) return null;
    return { delta, date: p.date || p.since || c.priceChangeDate || null };
  }

  // ---- Daten ----
  let tab = $state('alle');
  let openId = $state(null);
  let kindEdit = $state(null);
  let hiddenOpen = $state(false);

  const all = $derived(app.data.contracts || []);
  const activeAll = $derived(all.filter((c) => c.active !== false && !c.hidden && c.kind !== 'einkommen'));
  // Sparraten (Tagesgeld, Depot, Privatrente) sind keine Kosten – separat ausweisen
  const activeFixed = $derived(activeAll.filter((c) => c.kind !== 'vorsorge'));
  const savingMonthly = $derived(activeAll.filter((c) => c.kind === 'vorsorge').reduce((s, c) => s + monthlyOf(c), 0));
  const fixedMonthly = $derived(activeFixed.reduce((s, c) => s + monthlyOf(c), 0));
  const fixedYearly = $derived(activeFixed.reduce((s, c) => s + yearlyOf(c), 0));

  // Vertrag aus einem Dokument, zu dem (noch) keine Zahlung gefunden wurde – nicht „beendet“
  const noPay = (c) => !!c.noPayments;
  function inTab(c, t) {
    if (t === 'ohne') return noPay(c);
    if (noPay(c)) return t === 'alle';
    if (t === 'beendet') return c.active === false;
    if (c.active === false) return false;
    if (t === 'alle') return true;
    return (TAB_KINDS[t] || []).includes(c.kind);
  }
  const tabs = $derived(all.some(noPay) ? TABS : TABS.filter((x) => x.value !== 'ohne'));
  const noticeOf = (c) => c.cancellationPeriod || c.noticePeriod || c.kuendigungsfrist || null;
  const rows = $derived(all.filter((c) => inTab(c, tab)).sort((a, b) => yearlyOf(b) - yearlyOf(a)));
  const visibleRows = $derived(rows.filter((c) => !c.hidden));
  const hiddenRows = $derived(rows.filter((c) => c.hidden));

  // ---- Aufgeklappter Vertrag: Zahlungsverlauf ----
  const openC = $derived(openId ? all.find((c) => c.id === openId) || null : null);
  const pays = $derived.by(() => {
    if (!openC) return [];
    const txs = app.data.transactions || [];
    const ids = new Set(openC.txIds || []);
    const byId = new Map();
    for (const t of txs) if (ids.has(t.id)) byId.set(t.id, t);
    const list = [];
    for (const t of txs) {
      if (byId.has(t.id) || (t.contractId === openC.id && !ids.has(t.id))) {
        if (t.bookingDate) list.push({ id: t.id, date: t.bookingDate, amount: t.amount });
      }
    }
    return list.sort((a, b) => a.date.localeCompare(b.date));
  });
  const timeline = $derived.by(() => {
    if (!pays.length) return [];
    const t0 = isoTime(pays[0].date), t1 = isoTime(pays[pays.length - 1].date);
    return pays.map((p) => ({ ...p, pos: pays.length < 2 || t1 === t0 ? 50 : ((isoTime(p.date) - t0) / (t1 - t0)) * 100 }));
  });
  const recentPays = $derived(pays.slice(-12).reverse());

  // ---- Aktionen ----
  function toggle(id) {
    openId = openId === id ? null : id;
    kindEdit = null;
  }
  async function saveContract(c, patch) {
    await putRecord('contracts', { ...c, ...patch });
  }
  async function changeKind(c, kind) {
    kindEdit = null;
    if (kind === c.kind) return;
    await saveContract(c, { kind, kindUser: true });
    toast('Art gespeichert');
  }
  async function toggleHidden(c) {
    const hidden = !c.hidden;
    await saveContract(c, { hidden });
    toast(hidden ? 'Ausgeblendet' : 'Wieder eingeblendet');
  }

  // ---- Fokus aus Suche / Verweis ----
  $effect(() => {
    const id = app.params?.focus;
    if (!id) return;
    untrack(() => {
      const c = all.find((x) => x.id === id);
      if (!c) return;
      tab = noPay(c) ? 'ohne' : c.active === false ? 'beendet' : 'alle';
      hiddenOpen = !!c.hidden;
      openId = id;
      tick().then(() => document.getElementById('ct-' + id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    });
  });
</script>

{#snippet row(c)}
  {@const cat = getCategory(c.category)}
  {@const pc = priceChangeOf(c)}
  {@const open = openId === c.id}
  {@const due = c.active === false ? null : c.nextDate || null}
  {@const days = due ? daysBetween(today, due) : null}
  {@const notice = noticeOf(c)}
  <article class="ct" class:open class:off={c.active === false && !noPay(c)} id={'ct-' + c.id}>
    <button class="head" aria-expanded={open} onclick={() => toggle(c.id)}>
      <span class="cdot" style="background:{cat?.color || 'var(--text-3)'}"></span>
      <span class="grow min0">
        <span class="row wrap gap-s">
          <strong class="ellipsis pname">{c.provider || 'Vertrag'}</strong>
          <span class="badge">{INTERVALS[intervalKey(c)].label}</span>
          {#if noPay(c)}<span class="badge warn" title="Vertrag aus Dokument, keine passende Zahlung gefunden">ohne Zahlung</span>{/if}
          {#if pc}
            <span class="badge {pc.delta > 0 ? 'warn' : 'good'}">{pc.delta > 0 ? '+' : '−'}{fmtEUR(Math.abs(pc.delta))}{pc.date ? ' seit ' + monthYear(pc.date) : ''}</span>
          {/if}
        </span>
        <span class="small muted ellipsis block">{noPay(c) ? (c.product || 'Aus Dokument') : `${cat?.label || 'Ohne Kategorie'} · ${accountName(c.accountId)} · ${c.count ?? c.txIds?.length ?? 0}× gebucht`}{#if notice} · Kündigungsfrist {notice}{/if}</span>
        {#if days != null}
          {#if days < -3}<span class="small faint block">Zuletzt erwartet {fmtDate(due)} <Tip text="Noch keine passende Buchung importiert – neuere Kontoauszüge hinzufügen oder Vertrag als beendet markieren." /></span>{:else}<span class="small faint block">Nächste Fälligkeit {fmtDate(due)} · {dueText(days)}</span>{/if}
        {/if}
      </span>
      <span class="amt">
        <Money value={c.amount} color />
        <span class="small faint num">{fmtEUR(monthlyOf(c))} / Monat</span>
      </span>
      <span class="chev"><Icon name="chevronDown" size={16} /></span>
    </button>

    {#if open && openC}
      <div class="detail fade-up">
        {#if timeline.length}
          <div class="tl" role="img" aria-label="Zahlungsverlauf">
            <span class="axis"></span>
            {#each timeline as p (p.id)}
              <span class="pt" style="left:{p.pos}%" title="{fmtDate(p.date)} · {fmtEUR(p.amount)}"></span>
            {/each}
          </div>
          <div class="tl-ends small faint num"><span>{fmtDate(pays[0].date)}</span><span>{fmtDate(pays.at(-1).date)}</span></div>
          <div class="pays">
            {#each recentPays as p (p.id)}
              <span class="pay num">{fmtDate(p.date)}<b>{fmtEUR(p.amount)}</b></span>
            {/each}
          </div>
        {:else}
          <div class="small faint">Keine Zahlungen verknüpft</div>
        {/if}

        {#if c.contractNumber || notice || c.startDate || c.term || c.docId}
          <dl class="kv small">
            {#if c.contractNumber}<dt>Vertragsnummer</dt><dd class="mono">{c.contractNumber}</dd>{/if}
            {#if notice}<dt>Kündigungsfrist</dt><dd>{notice}{#if c.docId} <Tip text="Aus dem Vertragsdokument übernommen" />{/if}</dd>{/if}
            {#if c.startDate}<dt>Beginn</dt><dd>{fmtDate(c.startDate)}</dd>{/if}
            {#if c.term}<dt>Laufzeit</dt><dd>{c.term}</dd>{/if}
            {#if c.docId && c.docMatch}<dt>Zuordnung</dt><dd>{c.docMatch === 'nummer' ? 'über Vertragsnummer' : 'über Anbieter'}</dd>{/if}
          </dl>
        {/if}
        <div class="acts">
          {#if c.docId}<button class="btn btn-sm" onclick={() => setView('documents', { open: c.docId })}><Icon name="file" size={14} />Vertrag öffnen</button>{/if}
          {#if kindEdit === c.id}
            <label class="field kind-field">
              <span>Art</span>
              <select class="input" value={c.kind} onchange={(e) => changeKind(c, e.currentTarget.value)}>
                {#each KINDS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
              </select>
            </label>
          {:else}
            <button class="btn btn-sm" onclick={() => (kindEdit = c.id)}><Icon name="edit" size={14} />Art ändern</button>
          {/if}
          <button class="btn btn-sm" onclick={() => toggleHidden(c)}><Icon name={c.hidden ? 'eye' : 'ban'} size={14} />{c.hidden ? 'Einblenden' : 'Ausblenden'}</button>
          <button class="btn btn-sm" onclick={() => setView('transactions', { search: c.provider })}><Icon name="list" size={14} />Zu Buchungen</button>
        </div>
      </div>
    {/if}
  </article>
{/snippet}

<div class="stack">
  <div class="grid g3">
    <Stat label="Fixkosten pro Monat" value={fixedMonthly} icon="repeat" tone="accent" tip="Aktive Verträge ohne Einnahmen und Sparraten, auf einen Monat umgerechnet" sub={savingMonthly ? `+ ${fmtEUR(savingMonthly)} Sparraten` : null} />
    <Stat label="Fixkosten pro Jahr" value={fixedYearly} icon="calendar" tip="Monatlicher Betrag × 12" />
    <Stat label="Aktive Verträge" value={activeAll.length} format="num" icon="contract" />
  </div>

  {#if !all.length}
    <div class="card">
      <Empty icon="repeat" title="Noch keine Verträge erkannt">
        {#snippet action()}
          <button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="plus" size={16} />Dateien hinzufügen</button>
        {/snippet}
      </Empty>
    </div>
  {:else}
    <div class="tabs">
      <Seg bind:value={tab} options={tabs} size="sm" />
    </div>

    <div class="card list">
      {#each visibleRows as c (c.id)}
        {@render row(c)}
      {:else}
        <div class="none small faint">Keine Einträge in dieser Ansicht</div>
      {/each}
    </div>

    {#if hiddenRows.length}
      <Collapsible title="Ausgeblendet" badge={hiddenRows.length} bind:open={hiddenOpen}>
        <div class="card list flat">
          {#each hiddenRows as c (c.id)}
            {@render row(c)}
          {/each}
        </div>
      </Collapsible>
    {/if}
  {/if}
</div>

<style>
  .tabs { max-width: 100%; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .list { padding: 0; overflow: hidden; }
  .list.flat { box-shadow: none; }
  .none { padding: 22px 16px; text-align: center; }
  .min0 { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .block { display: block; }
  .gap-s { gap: 8px; }
  .ct { border-bottom: 1px solid var(--border); transition: background .15s; }
  .ct:last-child { border-bottom: 0; }
  .ct.off { opacity: .72; }
  .ct.open { background: var(--surface-2); }
  .head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: none; border: 0; cursor: pointer; text-align: left; color: inherit; transition: background .15s; }
  .head:hover { background: var(--surface-2); }
  .cdot { width: 10px; height: 10px; border-radius: 50%; flex: none; align-self: center; }
  .pname { font-size: 14.5px; font-weight: 650; min-width: 0; }
  .amt { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; text-align: right; }
  .chev { color: var(--text-3); display: grid; place-items: center; transition: transform .2s ease; flex: none; }
  .ct.open .chev { transform: rotate(180deg); }
  .detail { padding: 4px 16px 16px 38px; display: flex; flex-direction: column; gap: 12px; }
  .tl { position: relative; height: 22px; margin: 4px 6px 0; }
  .axis { position: absolute; left: 0; right: 0; top: 50%; height: 2px; background: var(--border); border-radius: 2px; transform: translateY(-50%); }
  .pt { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--surface); transition: transform .15s; cursor: default; }
  .pt:hover { transform: scale(1.25); }
  .tl-ends { display: flex; justify-content: space-between; margin: 0 6px; }
  .pays { display: flex; flex-wrap: wrap; gap: 6px; }
  .pay { display: inline-flex; align-items: center; gap: 8px; padding: 3px 8px; border-radius: 7px; background: var(--surface); border: 1px solid var(--border); color: var(--text-2); font-size: 12px; }
  .pay b { color: var(--text); font-weight: 600; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; }
  .kv dt { color: var(--text-3); }
  .kv dd { margin: 0; }
  .acts { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
  .kind-field { min-width: 200px; }
  @media (max-width: 520px) {
    .head { padding: 12px; gap: 10px; }
    .detail { padding: 4px 12px 14px 14px; }
  }
</style>
