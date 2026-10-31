<script>
  import { app, live, setView, putRecord, deleteRecord, toast, accountName } from '../store/state.svelte.js';
  import { fmtEUR, fmtDate, maskIban, uid, daysBetween, parseGermanAmount } from '../util/format.js';
  import NetWorthLine from '../charts/NetWorthLine.svelte';
  import Sparkline from '../charts/Sparkline.svelte';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Empty from '../ui/Empty.svelte';
  import Money from '../ui/Money.svelte';
  import Modal from '../ui/Modal.svelte';
  import Toggle from '../ui/Toggle.svelte';

  // ---- Konstanten ----
  const ACCOUNT_KINDS = [
    { value: 'giro', label: 'Girokonto' },
    { value: 'tagesgeld', label: 'Tagesgeld' },
    { value: 'depot', label: 'Depot' },
    { value: 'paypal', label: 'PayPal' },
    { value: 'kreditkarte', label: 'Kreditkarte' },
    { value: 'rente', label: 'Altersvorsorge' },
    { value: 'bu', label: 'Versicherung (BU)' },
    { value: 'sonstiges', label: 'Sonstiges' },
  ];
  const GROUPS = [
    { key: 'giro', label: 'Girokonten', kinds: ['giro'] },
    { key: 'tagesgeld', label: 'Tagesgeld', kinds: ['tagesgeld'] },
    { key: 'depot', label: 'Depots', kinds: ['depot'] },
    { key: 'paypal', label: 'PayPal', kinds: ['paypal'] },
    { key: 'kreditkarte', label: 'Kreditkarten', kinds: ['kreditkarte'] },
    { key: 'rente', label: 'Altersvorsorge', kinds: ['rente'] },
    { key: 'bu', label: 'Versicherungen', kinds: ['bu', 'versicherung'] },
    { key: 'sonstiges', label: 'Sonstiges', kinds: [] },
  ];
  const ASSET_CATS = [
    { id: 'elektronik', label: 'Elektronik', icon: 'cpu' },
    { id: 'schmuck', label: 'Schmuck', icon: 'gem' },
    { id: 'uhren', label: 'Uhren', icon: 'clock' },
    { id: 'kunst', label: 'Kunst', icon: 'sparkles' },
    { id: 'fahrzeug', label: 'Fahrzeug', icon: 'tag' },
    { id: 'moebel', label: 'Möbel', icon: 'tag' },
    { id: 'instrumente', label: 'Instrumente', icon: 'zap' },
    { id: 'sonstiges', label: 'Sonstiges', icon: 'tag' },
  ];

  // ---- Helfer ----
  const today = (() => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  })();
  const groupOf = (kind) => GROUPS.find((g) => g.kinds.includes(kind))?.key || 'sonstiges';
  const kindKey = (kind) => (ACCOUNT_KINDS.some((k) => k.value === kind) ? kind : 'sonstiges');
  const catLabel = (id) => ASSET_CATS.find((c) => c.id === id)?.label || 'Sonstiges';
  const catIcon = (id) => ASSET_CATS.find((c) => c.id === id)?.icon || 'tag';
  const assetValue = (a) => a.currentValue ?? a.purchasePrice ?? 0;
  const centsStr = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const pct = (x) => (x * 100).toFixed(1).replace('.', ',') + ' %';
  const fmtQty = (q) => (q == null ? '–' : Number(q).toLocaleString('de-DE', { maximumFractionDigits: 4 }));

  function warranty(a) {
    if (!a.warrantyUntil) return null;
    const d = daysBetween(today, a.warrantyUntil);
    if (d < 0) return { cls: '', text: 'abgelaufen' };
    if (d === 0) return { cls: 'warn', text: 'läuft heute ab' };
    return { cls: d <= 90 ? 'warn' : 'good', text: `läuft ab in ${d} Tagen` };
  }

  function focusOnMount(node) {
    node.focus();
    node.select();
  }

  // ---- Hero / Nettovermögen ----
  const ins = $derived(live.insights);
  const nwSeries = $derived(ins?.netWorth?.series || []);
  const nwSorted = $derived([...nwSeries].sort((a, b) => a.date.localeCompare(b.date)));
  const nwChange = $derived(nwSorted.length > 1 ? nwSorted.at(-1).value - nwSorted[0].value : null);

  // ---- Konten ----
  const valsByAcc = $derived.by(() => {
    const m = new Map();
    for (const v of app.data.valuations || []) {
      if (!v.accountId) continue;
      if (!m.has(v.accountId)) m.set(v.accountId, []);
      m.get(v.accountId).push(v);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return m;
  });
  const nwByAcc = $derived(new Map((ins?.netWorth?.byAccount || []).map((x) => [x.accountId, x])));
  // Konten ohne eigene Bewertung, deren Stand in einem Depotwert steckt (MLP-Liquiditätskonto): Saldo nur anzeigen, nicht summieren
  const includedBal = $derived.by(() => {
    const m = new Map();
    for (const d of app.data.documents || []) {
      if (!d.accountId || !d.fields?.includedInDepotValue || d.balance?.closing == null) continue;
      const cur = m.get(d.accountId);
      if (!cur || (d.date || '') >= (cur.date || '')) m.set(d.accountId, { value: d.balance.closing, date: d.balance.closingDate || d.date });
    }
    return m;
  });
  const accRows = $derived(
    (app.data.accounts || []).map((a) => {
      const vs = valsByAcc.get(a.id) || [];
      const last = vs.at(-1);
      const bya = nwByAcc.get(a.id);
      const inc = !bya && !last ? includedBal.get(a.id) : null;
      return {
        a,
        value: bya ? bya.value : last ? last.value : inc ? inc.value : null,
        date: bya ? bya.date : last ? last.date : inc ? inc.date : null,
        included: !!inc,
        spark: vs.map((v) => v.value),
      };
    })
  );
  const counted = (r) => (r.included ? 0 : r.value ?? 0);
  const accGroups = $derived(
    GROUPS.map((g) => {
      const rows = accRows.filter((r) => groupOf(r.a.kind) === g.key);
      return { ...g, rows, sum: rows.reduce((s, r) => s + counted(r), 0) };
    }).filter((g) => g.rows.length)
  );
  const netTotal = $derived(ins?.netWorth?.total ?? accRows.reduce((s, r) => s + counted(r), 0));

  let editingId = $state(null);
  let draft = $state('');
  function startRename(a) {
    editingId = a.id;
    draft = a.name || a.institution || '';
  }
  async function commitRename(a) {
    const n = draft.trim();
    editingId = null;
    if (n && n !== a.name) await saveAccount(a, { name: n });
  }
  async function saveAccount(a, patch) {
    await putRecord('accounts', { ...a, ...patch });
  }

  // ---- Depot ----
  // Pro Depot nur der jüngste Bestand (Stichtag, bei gleichem Tag das zuletzt importierte Dokument) – wie in networth.js
  const holdings = $derived.by(() => {
    const latest = new Map();
    const docOrder = new Map((app.data.documents || []).map((d, i) => [d.id, d.createdAt || String(i).padStart(8, '0')]));
    for (const h of app.data.holdings || []) {
      const key = (h.date || '') + '|' + (docOrder.get(h.documentId) || '');
      const cur = latest.get(h.accountId || '');
      if (!cur || key > cur.key) latest.set(h.accountId || '', { key, documentId: h.documentId, date: h.date });
    }
    return (app.data.holdings || [])
      .filter((h) => { const l = latest.get(h.accountId || ''); return l && h.documentId === l.documentId && h.date === l.date; })
      .sort((a, b) => (b.value || 0) - (a.value || 0));
  });
  // Je Depot: Stand, Gesamtwert (Bewertung des Dokuments, sonst Summe), Positionen, Kennzahlen und Entwicklung
  const depots = $derived.by(() => {
    const byAcc = new Map();
    for (const h of holdings) {
      const k = h.accountId || '';
      if (!byAcc.has(k)) byAcc.set(k, []);
      byAcc.get(k).push(h);
    }
    const docs = new Map((app.data.documents || []).map((d) => [d.id, d]));
    return [...byAcc.entries()].map(([accountId, hs]) => {
      const doc = docs.get(hs[0].documentId) || null;
      const date = hs[0].date || doc?.date || null;
      const sum = hs.reduce((s, h) => s + (h.value || 0), 0);
      const vs = valsByAcc.get(accountId) || [];
      const own = vs.find((v) => v.documentId === hs[0].documentId && v.date === date);
      const total = own ? own.value : sum;
      const acc = (app.data.accounts || []).find((a) => a.id === accountId);
      const txs = doc ? (app.data.transactions || []).filter((t) => t.accountId === accountId && t.documentId === doc.id) : [];
      return {
        accountId, acc, doc, date, sum, total, cash: total - sum, hs,
        fields: doc?.fields || {}, spark: vs.map((v) => v.value),
        trades: { n: txs.length, sum: txs.reduce((s, t) => s - t.amount, 0) },
      };
    }).sort((a, b) => b.total - a.total);
  });
  const holdingsTotal = $derived(depots.reduce((s, d) => s + d.total, 0));
  const fmtPct = (x, sign = true) => (x == null ? '–' : (sign && x > 0 ? '+' : '') + x.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %');
  const fmtPrice = (h) => (h.priceExact ?? (h.price != null ? h.price / 100 : null)) == null ? '–'
    : (h.priceExact ?? h.price / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + ' ' + (h.currency === 'EUR' || !h.currency ? '€' : h.currency);
  /** Kennzahlen eines Depot-Dokuments: [Bezeichnung, Wert, Art ('eur'|'pct'|'text'), Tooltip] */
  function depotFigures(dp) {
    const f = dp.fields;
    const perf = f.performance;
    const since = f.resultPeriod?.from ? ' seit ' + fmtDate(f.resultPeriod.from) : '';
    const out = [
      ['Einzahlungen', f.deposits, 'eur', 'Summe aller Einzahlungen ins Depot'],
      ['Sparrate / Monat', f.savingsRate, 'eur', 'Aktuelle monatliche Sparrate'],
      ['Gesamtergebnis', f.result, 'eur', 'Wertzuwachs abzüglich Einzahlungen' + since + ', laut Depotbank'],
      ['Rendite seit Beginn', perf?.mwr?.[2], 'pct', 'Geldgewichtet (berücksichtigt Zeitpunkt und Höhe der Einzahlungen); zeitgewichtet ' + fmtPct(perf?.twr?.[2])],
      ['Rendite lfd. Jahr', perf?.mwr?.[0], 'pct', 'Geldgewichtet; zeitgewichtet ' + fmtPct(perf?.twr?.[0])],
      ['Ausschüttungen', f.distributions, 'eur', 'Ausschüttungen, Zinsen und Dividenden im Zeitraum'],
      ['Depotentgelt', f.depotFee, 'eur', 'Gebucht im Liquiditätskonto'],
      ['Wert ' + (f.valuePrevDate ? fmtDate(f.valuePrevDate) : 'Vorjahr'), f.valuePrevYearEnd, 'eur', 'Gesamtwert zum Jahresende davor'],
      ['Kaufwert', f.cost, 'eur', 'Summe der Kaufwerte laut Depotbank (vereinfachte Rechnung)'],
      ['Gewinn / Verlust', f.gain, 'eur', 'Kurswert minus Kaufwert, ohne steuerliche Gesichtspunkte'],
      ['Verlusttopf Aktien', f.lossPotStocks, 'eur', 'Verlustverrechnungstopf Aktien (Steuerübersicht)'],
      ['Verlusttopf Sonstige', f.lossPotOther, 'eur', 'Verlustverrechnungstopf Sonstige (Steuerübersicht)'],
      ['Freibetrag übrig', f.allowanceRemaining ?? f.exemption?.remaining, 'eur', 'Verbleibender Sparer-Pauschbetrag laut Bank'],
      ['Abgeführte Steuern', f.taxPaid, 'eur', 'Kapitalertragsteuer, Solidaritätszuschlag und Kirchensteuer laut Steuerübersicht'],
    ];
    return out.filter(([, v]) => Number.isFinite(v) && v !== 0);
  }

  // ---- Altersvorsorge & BU ----
  const docValMap = $derived.by(() => {
    const m = new Map();
    for (const v of app.data.valuations || []) {
      if (!v.documentId) continue;
      if (!m.has(v.documentId)) m.set(v.documentId, []);
      m.get(v.documentId).push(v);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return m;
  });
  const vorsorge = $derived(
    (app.data.documents || [])
      .filter((d) => (d.type === 'rente' || d.type === 'versicherung') && d.type !== 'irrelevant')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  );
  function valsOf(d) {
    return docValMap.get(d.id) || (d.accountId ? valsByAcc.get(d.accountId) : null) || [];
  }
  function vorsorgeFields(d) {
    const f = d.fields || {};
    return [
      ['Fondsguthaben', f.fondsguthaben, ''],
      ['Rückkaufswert', f.rueckkaufswert, ''],
      ['Garantierte Rente', f.garantierteRente, ' / Monat'],
      ['BU-Rente', f.buRente, ' / Monat'],
      ['Beitrag / Monat', f.premiumMonthly, ''],
      ['Beitrag / Jahr', f.premiumYearly, ''],
      ['Beiträge gesamt', f.beitraegeGezahlt, ''],
    ].filter(([, v]) => Number.isFinite(v) && v !== 0);
  }

  // ---- Wertgegenstände ----
  const assets = $derived([...(app.data.assets || [])].sort((a, b) => assetValue(b) - assetValue(a)));
  const assetsTotal = $derived(assets.reduce((s, a) => s + assetValue(a), 0));
  const receiptDocs = $derived(
    (app.data.documents || [])
      .filter((d) => d.type === 'rechnung' || d.type === 'kassenbon')
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  );
  const docTitle = (id) => {
    if (!id) return '';
    const d = (app.data.documents || []).find((x) => x.id === id);
    return d ? d.title || d.institution || 'Beleg' : '';
  };

  let formOpen = $state(false);
  let formId = $state(null);
  let form = $state(blankForm());
  function blankForm() {
    return { name: '', category: 'elektronik', purchaseDate: '', purchase: '', current: '', warranty: '', documentId: '', note: '' };
  }
  function openNew() {
    formId = null;
    form = blankForm();
    formOpen = true;
  }
  function openEdit(a) {
    formId = a.id;
    form = {
      name: a.name || '',
      category: a.category || 'sonstiges',
      purchaseDate: a.purchaseDate || '',
      purchase: centsStr(a.purchasePrice),
      current: centsStr(a.currentValue),
      warranty: a.warrantyUntil || '',
      documentId: a.documentId || '',
      note: a.note || '',
    };
    formOpen = true;
  }
  function parseAmt(s) {
    const t = (s || '').trim();
    if (!t) return { v: null, ok: true };
    const v = parseGermanAmount(t);
    return { v, ok: v != null };
  }
  async function saveAsset() {
    const name = form.name.trim();
    if (!name) return;
    const p = parseAmt(form.purchase);
    const c = parseAmt(form.current);
    if (!p.ok || !c.ok) {
      toast('Betrag bitte prüfen', { tone: 'bad' });
      return;
    }
    const rec = {
      id: formId || uid('as_'),
      name,
      category: form.category,
      purchaseDate: form.purchaseDate || null,
      purchasePrice: p.v,
      currentValue: c.v,
      warrantyUntil: form.warranty || null,
      documentId: form.documentId || null,
      note: form.note.trim() || null,
      currency: 'EUR',
    };
    await putRecord('assets', rec);
    formOpen = false;
    toast('Gespeichert');
  }
  async function removeAsset() {
    if (!formId || !confirm(`„${form.name || 'Wertgegenstand'}“ löschen?`)) return;
    await deleteRecord('assets', formId);
    formOpen = false;
    toast('Gelöscht');
  }
</script>

<div class="stack">
  <!-- Hero -->
  {#if accRows.length || nwSeries.length}
    <section class="card hero">
      <div class="hero-top">
        <div class="stack tight">
          <div class="row small muted lbl">
            <span>Nettovermögen</span>
            <Tip text="Summe aller Konten und Depots zum jeweils letzten bekannten Stand" />
          </div>
          <div class="big num">{fmtEUR(netTotal)}</div>
        </div>
        {#if nwChange != null}
          <div class="small num change" class:pos={nwChange >= 0} class:negc={nwChange < 0}>
            {nwChange >= 0 ? '▲' : '▼'} {fmtEUR(Math.abs(nwChange))} seit {fmtDate(nwSorted[0].date)}
          </div>
        {/if}
      </div>
      <NetWorthLine series={nwSeries} height={200} />
    </section>
  {:else}
    <div class="card">
      <Empty icon="wallet" title="Noch kein Vermögen erfasst">
        {#snippet action()}
          <button class="btn btn-primary" onclick={() => setView('sources')}><Icon name="plus" size={16} />Dateien hinzufügen</button>
        {/snippet}
      </Empty>
    </div>
  {/if}

  <!-- Konten -->
  {#each accGroups as g (g.key)}
    <section class="card">
      <div class="card-head">
        <h2>{g.label}<span class="badge">{g.rows.length}</span></h2>
        <Money value={g.sum} class="small strong" />
      </div>
      <div class="acc-grid">
        {#each g.rows as r (r.a.id)}
          <article class="acc">
            <div class="row between top">
              <div class="grow min0">
                <div class="small muted ellipsis">{r.a.institution || '–'}</div>
                {#if editingId === r.a.id}
                  <input
                    class="input name-in"
                    aria-label="Kontoname"
                    bind:value={draft}
                    use:focusOnMount
                    onblur={() => commitRename(r.a)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        draft = r.a.name || '';
                        e.currentTarget.blur();
                      }
                    }}
                  />
                {:else}
                  <button class="rename" onclick={() => startRename(r.a)} title="Umbenennen">
                    <span class="ellipsis">{r.a.name || r.a.institution || 'Konto'}</span>
                    <Icon name="edit" size={13} />
                  </button>
                {/if}
              </div>
              <div class="val num">{r.value != null ? fmtEUR(r.value) : '–'}</div>
            </div>
            {#if r.spark.length > 1}
              <Sparkline values={r.spark} height={34} />
            {/if}
            <div class="row between small faint">
              <span class="mono ellipsis">{maskIban(r.a.iban) || r.a.number || ''}</span>
              <span class="num">{r.included ? 'im Depotwert enthalten · ' : ''}{r.date ? fmtDate(r.date) : ''}</span>
            </div>
            <div class="row between wrap foot">
              <select class="input sel" aria-label="Kontoart" value={kindKey(r.a.kind)} onchange={(e) => saveAccount(r.a, { kind: e.currentTarget.value })}>
                {#each ACCOUNT_KINDS as k (k.value)}<option value={k.value}>{k.label}</option>{/each}
              </select>
              <span class="row small">
                <Toggle checked={r.a.own !== false} label="Eigenes Konto" onchange={(v) => saveAccount(r.a, { own: v })} />
                <Tip text="Markiert Konten, die dir gehören. Fremde Konten bleiben sichtbar." />
              </span>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/each}

  <!-- Depot -->
  {#if depots.length}
    <section class="stack tight">
      <div class="row between">
        <h2 class="sec">Depotbestände<Tip text="Je Depot der neueste Bestand (Stichtag) mit Positionen und Kennzahlen aus dem Depot-Dokument" /></h2>
        {#if depots.length > 1}<Money value={holdingsTotal} class="small strong" />{/if}
      </div>
      {#each depots as dp (dp.accountId)}
        {@const figs = depotFigures(dp)}
        <article class="card depot">
          <div class="row between top wrap dhead">
            <div class="min0">
              <div class="small muted ellipsis">{dp.acc?.institution || dp.doc?.institution || '–'}{dp.acc?.number ? ' · Depot ' + dp.acc.number : ''}</div>
              <div class="strong ellipsis dname">{dp.acc?.name || accountName(dp.accountId)}</div>
              <div class="small faint">
                Stand {dp.date ? fmtDate(dp.date) : '–'} · {dp.hs.length} Positionen{dp.doc ? ' · ' + (dp.doc.title || '') : ''}
              </div>
            </div>
            <div class="amt">
              <span class="val num">{fmtEUR(dp.total)}</span>
              {#if Number.isFinite(dp.fields.result) && dp.fields.result !== 0}
                <span class="small num" class:pos={dp.fields.result > 0} class:negc={dp.fields.result < 0}>{fmtEUR(dp.fields.result, { sign: true })} Ergebnis</span>
              {:else if Number.isFinite(dp.fields.gain) && dp.fields.gain !== 0}
                <span class="small num" class:pos={dp.fields.gain > 0} class:negc={dp.fields.gain < 0}>{fmtEUR(dp.fields.gain, { sign: true })} G/V</span>
              {/if}
            </div>
          </div>
          {#if dp.spark.length > 1}
            <Sparkline values={dp.spark} height={36} />
          {/if}
          {#if figs.length}
            <dl class="figs">
              {#each figs as [label, val, kind, tip] (label)}
                <div class="fig">
                  <dt><span>{label}</span><Tip text={tip} /></dt>
                  <dd class="num" class:pos={kind === 'pct' && val > 0} class:negc={kind === 'pct' && val < 0}>{kind === 'pct' ? fmtPct(val) : fmtEUR(val)}</dd>
                </div>
              {/each}
            </dl>
          {/if}
          <div class="scroll hold">
            <table class="tbl hold-tbl">
              <thead>
                <tr>
                  <th>Wertpapier</th>
                  <th class="r">Stück</th>
                  <th class="r">Kurs</th>
                  <th class="r">Wert</th>
                  <th class="r">Anteil</th>
                  <th class="r">Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {#each dp.hs as h (h.id)}
                  {@const res = h.result ?? (h.cost ? h.gain : null)}
                  <tr>
                    <td class="name-cell">
                      <div class="ellipsis strong-ish" title={h.name || ''}>{h.name || '–'}</div>
                      <div class="small faint ellipsis">{[h.wkn || h.isin, h.focus, h.savingsRate ? 'Sparrate ' + fmtEUR(h.savingsRate) : null].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td class="r num">{fmtQty(h.qty)}</td>
                    <td class="r num" title={h.priceDate ? 'Kurs vom ' + fmtDate(h.priceDate) + (h.fxRate ? ' · Devisenkurs ' + h.fxRate.toLocaleString('de-DE') : '') : ''}>{fmtPrice(h)}</td>
                    <td class="r"><Money value={h.value} /></td>
                    <td class="r num muted">{h.share != null ? fmtPct(h.share, false) : dp.total ? pct((h.value || 0) / dp.total) : '–'}</td>
                    <td class="r num" class:pos={res > 0} class:negc={res < 0}>
                      {res != null ? fmtEUR(res, { sign: true }) : '–'}
                      {#if h.performancePct != null}<div class="small">{fmtPct(h.performancePct)}</div>{/if}
                    </td>
                  </tr>
                {/each}
                {#if dp.cash > 0}
                  <tr class="cash">
                    <td class="name-cell"><div class="strong-ish">Liquiditätskonto</div><div class="small faint">im Depotwert enthalten</div></td>
                    <td></td><td></td>
                    <td class="r"><Money value={dp.cash} /></td>
                    <td class="r num muted">{dp.total ? pct(dp.cash / dp.total) : '–'}</td>
                    <td></td>
                  </tr>
                {/if}
              </tbody>
            </table>
          </div>
          {#if dp.trades.n}
            <div class="small muted">
              {dp.trades.n} Wertpapiergeschäfte im Zeitraum · {fmtEUR(dp.trades.sum)} investiert
              <Tip text="Käufe im Depot zählen nicht als Ausgabe – das Geld bleibt Vermögen" />
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}

  <!-- Altersvorsorge & BU -->
  {#if vorsorge.length}
    <section class="stack tight">
      <h2 class="sec">Altersvorsorge &amp; BU</h2>
      <div class="vgrid">
        {#each vorsorge as d (d.id)}
          {@const vals = valsOf(d)}
          <article class="card vcard">
            <div class="row between top">
              <div class="grow min0">
                <div class="row wrap gap-s">
                  <span class="badge accent">{d.fields?.productKindLabel || d.subtype || 'Vertrag'}</span>
                  {#if d.needsReview && !d.reviewed}<span class="badge warn">Prüfen</span>{/if}
                </div>
                <div class="strong ellipsis vtitle">{d.title || d.institution || 'Vertrag'}</div>
                <div class="small faint ellipsis">{d.institution || d.issuer || ''}{d.date ? ' · ' + fmtDate(d.date) : ''}</div>
              </div>
            </div>
            {#if vals.length > 1}
              <Sparkline values={vals.map((v) => v.value)} height={40} />
            {/if}
            <dl class="kv">
              {#each vorsorgeFields(d) as [label, val, suffix] (label)}
                <dt>{label}</dt>
                <dd><span class="num">{fmtEUR(val)}{suffix}</span></dd>
              {/each}
              {#if !vorsorgeFields(d).length}
                <dt class="faint">Keine Werte erkannt</dt>
                <dd></dd>
              {/if}
            </dl>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Wertgegenstände -->
  <section class="card">
    <div class="card-head">
      <h2>Wertgegenstände<Tip text="Eigene Gegenstände mit Wert und Garantie. Belege lassen sich verknüpfen." /></h2>
      {#if assets.length}
        <Money value={assetsTotal} class="small strong" />
        <button class="btn btn-primary btn-sm" onclick={openNew}><Icon name="plus" size={15} />Hinzufügen</button>
      {/if}
    </div>
    {#if !assets.length}
      <Empty icon="tag" title="Noch keine Wertgegenstände">
        {#snippet action()}
          <button class="btn btn-primary" onclick={openNew}><Icon name="plus" size={16} />Wertgegenstand hinzufügen</button>
        {/snippet}
      </Empty>
    {:else}
      <ul class="alist">
        {#each assets as a (a.id)}
          {@const w = warranty(a)}
          <li>
            <button class="arow" onclick={() => openEdit(a)}>
              <span class="aic"><Icon name={catIcon(a.category)} size={16} /></span>
              <span class="min0">
                <span class="row wrap gap-s">
                  <strong class="ellipsis">{a.name}</strong>
                  {#if w}<span class="badge {w.cls}">{w.text}</span>{/if}
                </span>
                <span class="small muted ellipsis">
                  {catLabel(a.category)}{a.purchaseDate ? ' · gekauft ' + fmtDate(a.purchaseDate) : ''}{docTitle(a.documentId) ? ' · ' + docTitle(a.documentId) : ''}
                </span>
              </span>
              <span class="amt">
                <span class="num strong">{fmtEUR(assetValue(a))}</span>
                {#if a.purchasePrice != null && a.currentValue != null && a.currentValue !== a.purchasePrice}
                  <span class="small faint num">Kauf {fmtEUR(a.purchasePrice)}</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<Modal bind:open={formOpen} title={formId ? 'Wertgegenstand bearbeiten' : 'Wertgegenstand hinzufügen'} width={540}>
  <form class="form" onsubmit={(e) => { e.preventDefault(); saveAsset(); }}>
    <div class="grid g2">
      <label class="field full">
        <span>Name</span>
        <input class="input" bind:value={form.name} placeholder="z. B. MacBook Pro 14" required />
      </label>
      <label class="field">
        <span>Kategorie</span>
        <select class="input" bind:value={form.category}>
          {#each ASSET_CATS as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
        </select>
      </label>
      <label class="field">
        <span>Kaufdatum</span>
        <input class="input" type="date" bind:value={form.purchaseDate} />
      </label>
      <label class="field">
        <span>Kaufpreis (€)</span>
        <input class="input num" inputmode="decimal" placeholder="0,00" bind:value={form.purchase} />
      </label>
      <label class="field">
        <span>Aktueller Wert (€)</span>
        <input class="input num" inputmode="decimal" placeholder="0,00" bind:value={form.current} />
      </label>
      <label class="field">
        <span>Garantie bis</span>
        <input class="input" type="date" bind:value={form.warranty} />
      </label>
      <label class="field">
        <span>Beleg verknüpfen</span>
        <select class="input" bind:value={form.documentId}>
          <option value="">Kein Beleg</option>
          {#each receiptDocs as d (d.id)}
            <option value={d.id}>{(d.title || d.institution || 'Beleg') + ' · ' + fmtDate(d.date)}</option>
          {/each}
        </select>
      </label>
      <label class="field full">
        <span>Notiz</span>
        <textarea class="input" rows="2" bind:value={form.note}></textarea>
      </label>
    </div>
  </form>

  {#snippet footer()}
    {#if formId}
      <button class="btn btn-ghost btn-danger" type="button" onclick={removeAsset}><Icon name="trash" size={15} />Löschen</button>
    {/if}
    {#if form.documentId}
      <button class="btn btn-ghost" type="button" onclick={() => { const id = form.documentId; formOpen = false; setView('documents', { open: id }); }}><Icon name="external" size={15} />Beleg öffnen</button>
    {/if}
    <span class="grow"></span>
    <button class="btn" type="button" onclick={() => (formOpen = false)}>Abbrechen</button>
    <button class="btn btn-primary" type="button" disabled={!form.name.trim()} onclick={saveAsset}>Speichern</button>
  {/snippet}
</Modal>

<style>
  .lbl { font-weight: 550; }
  .big { font-size: 32px; font-weight: 750; letter-spacing: -.025em; line-height: 1.1; }
  .hero-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .change { font-weight: 600; }
  .min0 { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .gap-s { gap: 8px; }
  .strong { font-weight: 650; }
  .top { align-items: flex-start; }
  .sec { font-size: 15px; }
  .chips { margin-bottom: 12px; }

  /* Konten */
  .acc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  .acc { border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--surface); min-width: 0; transition: border-color .15s, box-shadow .15s; }
  .acc:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); box-shadow: var(--shadow); }
  .rename { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 0; background: none; border: 0; cursor: pointer; color: var(--text); font-weight: 650; font-size: 14.5px; text-align: left; min-width: 0; }
  .rename :global(.ico) { opacity: 0; transition: opacity .15s; color: var(--text-3); flex: none; }
  .rename:hover :global(.ico), .rename:focus-visible :global(.ico) { opacity: 1; }
  .name-in { height: 30px; font-weight: 600; width: 100%; }
  .val { font-size: 16px; font-weight: 700; white-space: nowrap; }
  .foot { gap: 8px; }
  .sel { height: 30px; font-size: 12.5px; padding: 0 8px; max-width: 100%; }

  /* Depot */
  .depot { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .dname { font-size: 15px; }
  .dhead { gap: 12px; }
  .figs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 0; }
  .fig { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; min-width: 0; }
  .fig dt { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); }
  .fig dt span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fig dd { margin: 2px 0 0; font-weight: 650; font-size: 14px; }
  .hold { max-width: 100%; }
  .hold-tbl { min-width: 620px; }
  .name-cell { max-width: 300px; }
  .strong-ish { font-weight: 550; }
  .cash td { border-top: 1px dashed var(--border); }

  /* Vorsorge */
  .vgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: var(--gap); }
  .vcard { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .vtitle { font-size: 14.5px; }
  .kv { display: grid; grid-template-columns: 1fr auto; gap: 7px 12px; margin: 0; font-size: 13px; }
  .kv dt { color: var(--text-2); }
  .kv dd { margin: 0; text-align: right; font-weight: 600; }

  /* Wertgegenstände */
  .alist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .alist li + li { border-top: 1px solid var(--border); }
  .arow { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 6px; background: none; border: 0; cursor: pointer; text-align: left; color: inherit; border-radius: 10px; transition: background .15s; }
  .arow:hover { background: var(--surface-2); }
  .aic { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--surface-2); color: var(--text-2); flex: none; }
  .amt { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: none; text-align: right; }

  /* Formular */
  .form { display: flex; flex-direction: column; gap: 12px; }
  .full { grid-column: 1 / -1; }
  textarea.input { resize: vertical; min-height: 56px; }

  @media (max-width: 520px) {
    .big { font-size: 27px; }
    .arow { gap: 10px; padding: 10px 4px; }
    .amt { font-size: 13px; }
  }
</style>
