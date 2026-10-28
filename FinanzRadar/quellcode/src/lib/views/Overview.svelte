<script>
  import { app, live, setView, saveSettings, effectiveRange } from '../store/state.svelte.js';
  import ProgressBar from './ProgressBar.svelte';
  import { computeInsights } from '../analyze/insights.js';
  import { CATEGORIES, getCategory } from '../classify/categories.js';
  import { fmtEUR } from '../util/format.js';
  import Stat from '../ui/Stat.svelte';
  import Tip from '../ui/Tip.svelte';
  import Icon from '../ui/Icon.svelte';
  import Empty from '../ui/Empty.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import MoneyFlow from '../charts/MoneyFlow.svelte';
  import MirrorBars from '../charts/MirrorBars.svelte';
  import CategoryBreakdown from '../charts/CategoryBreakdown.svelte';
  import BarList from '../charts/BarList.svelte';
  import TaxBreakdown from '../charts/TaxBreakdown.svelte';
  import Sparkline from '../charts/Sparkline.svelte';

  const ins = $derived(live.insights);
  const hasData = $derived(!!ins && app.data.transactions.length > 0);

  // ---- Vorperiode gleicher Länge ----
  const DAY = 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const prev = $derived.by(() => {
    if (!hasData || app.filter.preset === 'all') return null;
    void app.dataVersion;
    try {
      const { from, to } = effectiveRange();
      if (!from || !to) return null;
      const t0 = Date.parse(from + 'T12:00:00Z'), t1 = Date.parse(to + 'T12:00:00Z');
      const days = Math.round((t1 - t0) / DAY) + 1;
      const pTo = t0 - DAY, pFrom = pTo - (days - 1) * DAY;
      const r = computeInsights($state.snapshot(app.data), { from: iso(pFrom), to: iso(pTo), accountIds: app.filter.accountIds, showTaxes: false });
      const t = r?.totals;
      return t && (t.income || t.expense) ? r : null;
    } catch (e) {
      return null;
    }
  });

  const ratio = (cur, old) => (old && old > 0 ? cur / old - 1 : null);
  const T = $derived(ins?.totals || { income: 0, expense: 0, savingsRate: 0 });
  const expense = $derived(Math.abs(T.expense || 0));
  const incomeDelta = $derived(prev ? ratio(T.income || 0, prev.totals.income) : null);
  const expenseDelta = $derived(prev ? ratio(expense, Math.abs(prev.totals.expense || 0)) : null);
  const rateDelta = $derived(prev && prev.totals.savingsRate != null && T.savingsRate != null ? T.savingsRate - prev.totals.savingsRate : null);

  const months = $derived(ins?.byMonth || []);
  const sparkIncome = $derived(months.map((m) => m.income || 0));
  const sparkExpense = $derived(months.map((m) => Math.abs(m.expense || 0)));
  const sparkRate = $derived(months.map((m) => (m.income > 0 ? (m.income - Math.abs(m.expense || 0)) / m.income : 0)));
  const nwSeries = $derived(ins?.netWorth?.series || []);
  const nwChange = $derived(nwSeries.length > 1 ? nwSeries[nwSeries.length - 1].value - nwSeries[0].value : null);

  const fmtDeltaTxt = (d) => (d == null ? '' : `${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)} % ggü. Vorperiode`);
  const rateTxt = (d) => (d == null ? '' : `${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(1).replace('.', ',')} Pp. ggü. Vorperiode`);

  // ---- Prüfen-Hinweis ----
  // gleiches Kriterium wie die Prüfliste (Kategorie unsicher oder offene Prüfungen, Dokumente)
  const needsReview = $derived(live.reviewCount || 0);
  // Importbericht nach dem letzten Lauf, bis er weggeklickt wird
  const showReport = $derived(!app.progress.running && app.progress.phase === 'done' && !!app.progress.startedAt && app.progress.reportSeenAt !== app.progress.startedAt);
  const hideReport = () => { app.progress.reportSeenAt = app.progress.startedAt; };

  // ---- Steuern-Toggle persistieren ----
  let firstRun = true;
  $effect(() => {
    void app.settings.showTaxes;
    if (firstRun) { firstRun = false; return; }
    saveSettings();
  });

  // ---- Navigation ----
  const catIds = new Set(CATEGORIES.map((c) => c.id));
  const stripPrefix = (id) => String(id).replace(/^(cat|category|acc|account|src|source|tax|saving)[:/_-]/, '');
  function onNode(n) {
    const raw = String(n.id);
    const bare = stripPrefix(raw);
    if (n.kind === 'category' || n.kind === 'saving') {
      const id = catIds.has(raw) ? raw : catIds.has(bare) ? bare : null;
      if (id) return setView('transactions', { category: id });
      return setView('transactions', { search: n.label });
    }
    if (n.kind === 'account') return setView('transactions', { accountId: app.data.accounts.some((a) => a.id === raw) ? raw : bare });
    if (n.kind === 'tax') return setView('transactions', { category: 'steuern_abgaben' });
    if (n.kind === 'source') return setView('transactions', { category: 'einkommen' });
  }
  function onMonth(m) {
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    setView('transactions', { month: m, from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` });
  }
  const onCategory = (category, subcategory) => setView('transactions', subcategory ? { category, subcategory } : { category });

  // ---- Größte Empfänger ----
  const merchants = $derived((ins?.topMerchants || []).map((m) => {
    const cat = m.category ? getCategory(m.category) : null;
    return { id: m.name, label: m.name, value: Math.abs(m.amount), color: cat?.color, sub: [m.count ? `${m.count}×` : null, cat?.label].filter(Boolean).join(' · ') };
  }));

  // ---- Abos & Fixkosten ----
  const FACTOR = { weekly: 52 / 12, wöchentlich: 52 / 12, biweekly: 26 / 12, monthly: 1, monatlich: 1, quarterly: 1 / 3, vierteljährlich: 1 / 3, quartal: 1 / 3, halfyearly: 1 / 6, semiannual: 1 / 6, halbjährlich: 1 / 6, yearly: 1 / 12, annual: 1 / 12, jährlich: 1 / 12 };
  const INTERVAL_LABEL = { weekly: 'wöchentlich', biweekly: '14-täglich', monthly: 'monatlich', quarterly: 'quartalsweise', halfyearly: 'halbjährlich', semiannual: 'halbjährlich', yearly: 'jährlich', annual: 'jährlich' };
  function monthlyOf(c) {
    if (c.monthly != null) return Math.abs(c.monthly);
    if (c.monthlyAmount != null) return Math.abs(c.monthlyAmount);
    const f = FACTOR[String(c.interval || 'monthly').toLowerCase()] ?? 1;
    return Math.abs(c.amount || 0) * f;
  }
  const contracts = $derived(
    (app.data.contracts || [])
      .filter((c) => c && c.active !== false && !c.hidden && c.kind !== 'einkommen' && c.kind !== 'vorsorge' && (c.amount || 0) < 0 && !['cancelled', 'gekündigt', 'ended', 'inactive'].includes(String(c.status || '').toLowerCase()) && !(c.endDate && c.endDate < iso(Date.now())) && (c.amount || c.monthly || c.monthlyAmount))
      .map((c) => ({ id: c.id, name: c.name || c.provider || c.counterparty || 'Vertrag', monthly: monthlyOf(c), interval: String(c.interval || 'monthly').toLowerCase() }))
      .sort((a, b) => b.monthly - a.monthly)
  );
  const topContracts = $derived(contracts.slice(0, 5));
  const rec = $derived(ins?.recurring || { monthlyTotal: 0, yearlyTotal: 0, count: 0 });
</script>

{#if !hasData}
  <div class="card fade-up">
    <Empty icon="overview" title="Noch keine Daten">
      {#snippet action()}
        <button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="upload" size={16} />Quellen hinzufügen</button>
      {/snippet}
    </Empty>
  </div>
{:else}
  <div class="stack ov">
    {#if showReport}
      <div class="card report fade-up"><ProgressBar report ondismiss={hideReport} /></div>
    {:else if needsReview > 0}
      <div class="attn fade-up" role="status">
        <span class="ai"><Icon name="alert" size={16} /></span>
        <span class="grow"><b class="num">{needsReview}</b> {needsReview === 1 ? 'Eintrag' : 'Einträge'} prüfen</span>
        <button class="btn btn-sm btn-primary" onclick={() => setView('review')}>Prüfen<Icon name="arrowRight" size={14} /></button>
      </div>
    {/if}

    <div class="grid g4 kpis fade-up">
      <div class="kpi">
        <Stat label="Einnahmen" value={T.income || 0} icon="arrowDown" tone="good" delta={incomeDelta} sub={incomeDelta == null ? '' : 'ggü. Vorperiode'} tip="Summe aller Zuflüsse im Zeitraum, ohne Umbuchungen zwischen eigenen Konten." />
        <div class="spark"><Sparkline values={sparkIncome} color="var(--good)" height={30} /></div>
      </div>
      <div class="kpi">
        <Stat label="Ausgaben" value={expense} icon="arrowUp" tone="accent" sub={fmtDeltaTxt(expenseDelta)} tip="Summe aller Abflüsse im Zeitraum, ohne Umbuchungen und ohne Sparen." />
        <div class="spark"><Sparkline values={sparkExpense} color="var(--bad)" height={30} /></div>
      </div>
      <div class="kpi">
        <Stat label="Sparquote" value={T.savingsRate} format="pct" icon="piggy" tone="accent" sub={rateTxt(rateDelta)} tip="Anteil der Einnahmen, der nicht ausgegeben wurde." />
        <div class="spark"><Sparkline values={sparkRate} color="var(--accent)" height={30} /></div>
      </div>
      <div class="kpi">
        <Stat label="Nettovermögen" value={ins.netWorth?.total || 0} icon="wallet" tone="accent" sub={nwChange == null ? '' : `${fmtEUR(nwChange, { sign: true })} im Zeitraum`} tip="Kontostände, Depots und Vermögenswerte abzüglich Verbindlichkeiten." />
        <div class="spark"><Sparkline values={nwSeries} color="var(--accent)" height={30} /></div>
      </div>
    </div>

    <section class="card fade-up" style="animation-delay:.05s">
      <div class="card-head">
        <h2>Geldfluss<Tip text="Von Einnahmen über Konten zu Kategorien. Auf einen Knoten klicken, um die Buchungen zu sehen." /></h2>
        <Toggle bind:checked={app.settings.showTaxes} label="Steuern zeigen" />
      </div>
      <MoneyFlow data={ins.sankey} height={460} onselect={onNode} />
    </section>

    <div class="grid g2">
      <section class="card fade-up" style="animation-delay:.1s">
        <div class="card-head"><h2>Einnahmen vs. Ausgaben<Tip text="Je Monat: Einnahmen nach oben, Ausgaben nach unten, Linie = Netto. Klick öffnet den Monat." /></h2></div>
        <MirrorBars data={months} onselect={onMonth} />
      </section>
      <section class="card fade-up" style="animation-delay:.15s">
        <div class="card-head"><h2>Kostenverteilung<Tip text="Ausgaben nach Kategorie. Pfeile zeigen die Veränderung zur Vorperiode." /></h2></div>
        <CategoryBreakdown items={ins.byCategory} prev={prev?.byCategory} total={expense} onselect={onCategory} />
      </section>
    </div>

    <div class="grid g3">
      <section class="card fade-up" style="animation-delay:.2s">
        <div class="card-head"><h3>Größte Empfänger<Tip text="Händler und Empfänger mit den höchsten Ausgaben im Zeitraum." /></h3></div>
        <BarList items={merchants} max={7} onselect={(it) => setView('transactions', { search: it.label })} />
      </section>

      <section class="card fade-up rec" style="animation-delay:.25s">
        <div class="card-head">
          <h3>Abos &amp; Fixkosten<Tip text="Regelmäßige Zahlungen, automatisch erkannt. Betrag je Monat umgerechnet." /></h3>
          <button class="btn btn-ghost btn-sm" onclick={() => setView('contracts')}>Alle<Icon name="arrowRight" size={14} /></button>
        </div>
        {#if rec.count > 0 || topContracts.length}
          <div class="rec-top">
            <div><span class="big num">{fmtEUR(Math.abs(rec.monthlyTotal || 0))}</span><span class="muted small"> / Monat</span></div>
            <div class="muted small num">{fmtEUR(Math.abs(rec.yearlyTotal || (rec.monthlyTotal || 0) * 12))} / Jahr · {rec.count || contracts.length} Verträge</div>
          </div>
          <ul class="clist">
            {#each topContracts as c (c.id ?? c.name)}
              <li>
                <button type="button" class="crow" onclick={() => setView('contracts')}>
                  <span class="ellipsis nm">{c.name}</span>
                  {#if c.interval !== 'monthly' && INTERVAL_LABEL[c.interval]}<span class="badge">{INTERVAL_LABEL[c.interval]}</span>{/if}
                  <span class="num v">{fmtEUR(c.monthly)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="faint small none">Keine Verträge erkannt</div>
        {/if}
      </section>

      <section class="card fade-up" style="animation-delay:.3s">
        <div class="card-head">
          <h3>Steuern &amp; Abgaben<Tip text="Aus Lohnabrechnungen und Bescheinigungen; Umsatzsteuer und Kapitalertragsteuer sind geschätzt." /></h3>
          <button class="btn btn-ghost btn-sm" onclick={() => setView('tax')}>Steuer<Icon name="arrowRight" size={14} /></button>
        </div>
        <TaxBreakdown taxes={ins.taxes} compact />
      </section>
    </div>
  </div>
{/if}

<style>
  .report { padding: 12px 16px; }
  .ov { padding-bottom: 24px; }
  .attn { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: var(--radius-sm); background: var(--warn-soft); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
  .attn .ai { color: var(--warn); display: inline-flex; }
  .kpi { position: relative; }
  .kpi :global(.stat) { height: 100%; }
  .spark { position: absolute; right: 16px; top: 16px; width: 74px; opacity: .95; pointer-events: none; }
  .big { font-size: 24px; font-weight: 700; letter-spacing: -.02em; }
  .rec-top { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
  .clist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .crow { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 9px; cursor: pointer; transition: background .15s; }
  .crow:hover { background: var(--surface-2); }
  .crow:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .crow .nm { flex: 1; min-width: 0; font-weight: 550; }
  .crow .v { font-weight: 600; }
  .none { padding: 24px 0; text-align: center; }
  @media (max-width: 720px) { .spark { width: 60px; } }
</style>
