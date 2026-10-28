<script>
  // Prüfen: fokussierter Karten-Ablauf für unsichere Dokumente und Buchungen
  import { untrack } from 'svelte';
  import { app, setView, updateTransaction, updateDocument, putRecord, toast, reload, getThumb, getBlob, sourceOf, accountName } from '../store/state.svelte.js';
  import { postProcess } from '../store/postprocess.js';
  import { CATEGORIES } from '../classify/categories.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import { suggestRuleFromCorrection } from '../classify/rules.js';
  import Icon from '../ui/Icon.svelte';
  import Seg from '../ui/Seg.svelte';
  import Empty from '../ui/Empty.svelte';
  import Money from '../ui/Money.svelte';
  import Tip from '../ui/Tip.svelte';
  import CategoryPicker from '../ui/CategoryPicker.svelte';
  import { fmtDate, parseGermanAmount, uid } from '../util/format.js';

  const CAT = new Map(CATEGORIES.map(c => [c.id, c]));
  const SRC = { rule: 'Regel', merchant: 'Händler', keyword: 'Stichwort', user: 'Manuell', ai: 'KI', transfer: 'Umbuchung' };
  const TYPES = Object.entries(TYPE_LABELS || {}).filter(([value]) => value !== 'irrelevant').map(([value, v]) => ({ value, label: v.name || v.label || value }));
  TYPES.push({ value: 'irrelevant', label: 'Kein Finanzdokument' });

  const pendingDoc = (d) => d.needsReview && !d.reviewed && d.type !== 'irrelevant';
  const pendingTx = (t) => t.needsReview && !t.reviewed;

  function buildQueue(kind) {
    if (kind === 'docs') {
      return app.data.documents.filter(pendingDoc).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(d => d.id);
    }
    return app.data.transactions.filter(pendingTx)
      .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0) || Math.abs(b.amount) - Math.abs(a.amount)).map(t => t.id);
  }

  let queues = $state({ docs: buildQueue('docs'), tx: buildQueue('tx') });
  let pos = $state({ docs: 0, tx: 0 });
  let tab = $state(app.params?.tab === 'tx' || app.params?.tab === 'docs' ? app.params.tab : (queues.docs.length ? 'docs' : 'tx'));
  let busy = $state(false);
  let makeRule = $state(false);
  let choice = $state(null);
  let form = $state({ type: '', issuer: '', date: '', amount: '', title: '' });
  let preview = $state({ url: null, full: false });
  let lastUndo = $state(null);
  let pickerEl = $state(null);
  let typeEl = $state(null);

  const pendingDocs = $derived.by(() => { void app.dataVersion; return untrack(() => app.data.documents.filter(pendingDoc).length); });
  const pendingTxs = $derived.by(() => { void app.dataVersion; return untrack(() => app.data.transactions.filter(pendingTx).length); });
  const tabs = $derived([{ value: 'docs', label: `Dokumente · ${pendingDocs}` }, { value: 'tx', label: `Buchungen · ${pendingTxs}` }]);

  const ids = $derived(queues[tab]);
  const p = $derived(pos[tab]);
  const total = $derived(ids.length);
  const curId = $derived(ids[p]);
  const cur = $derived(curId ? (tab === 'docs' ? app.data.documents.find(d => d.id === curId) : app.data.transactions.find(t => t.id === curId)) : null);
  const done = $derived(p >= total);
  const leftover = $derived(tab === 'docs' ? pendingDocs : pendingTxs);
  const otherPending = $derived(tab === 'docs' ? pendingTxs : pendingDocs);

  // Fehlende und inzwischen erledigte Einträge überspringen (z. B. durch eine neue Regel mitgeklärt)
  $effect(() => {
    if (p >= total) return;
    const stale = !cur || (!busy && !(tab === 'docs' ? pendingDoc(cur) : pendingTx(cur)));
    if (stale) untrack(() => { pos[tab] = p + 1; });
  });

  function advance() { pos[tab] = pos[tab] + 1; makeRule = false; }
  function restart(kind) { queues[kind] = buildQueue(kind); pos[kind] = 0; }
  function skip() { if (cur && !busy) advance(); }

  // ---- Buchungen ----
  const topCats = $derived.by(() => {
    const t = tab === 'tx' ? cur : null;
    if (!t) return [];
    void app.dataVersion;
    return untrack(() => {
      const overall = new Map(), same = new Map();
      for (const x of app.data.transactions) {
        if (!x.category || pendingTx(x)) continue;
        overall.set(x.category, (overall.get(x.category) || 0) + 1);
        if (t.counterparty && x.counterparty === t.counterparty) same.set(x.category, (same.get(x.category) || 0) + 1);
      }
      const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      const out = [];
      for (const c of [t.category, ...rank(same), ...rank(overall)]) if (c && CAT.has(c) && !out.includes(c)) out.push(c);
      return out.slice(0, 9);
    });
  });
  const similar = $derived.by(() => {
    const t = tab === 'tx' ? cur : null;
    if (!t?.counterparty) return 0;
    void app.dataVersion;
    return untrack(() => app.data.transactions.reduce((n, x) => n + (x.id !== t.id && x.counterparty === t.counterparty ? 1 : 0), 0));
  });

  $effect(() => {
    const t = tab === 'tx' ? cur : null;
    if (!t) return;
    untrack(() => { choice = { category: t.category || null, subcategory: t.subcategory || null }; });
  });

  async function acceptTx(category, subcategory) {
    const t = cur;
    if (busy || !t || tab !== 'tx') return;
    category = category ?? choice?.category;
    subcategory = category === choice?.category && subcategory === undefined ? choice?.subcategory : subcategory;
    if (!category) { toast('Bitte zuerst eine Kategorie wählen'); return; }
    const changed = category !== t.category || (subcategory || null) !== (t.subcategory || null);
    const prev = { category: t.category ?? null, subcategory: t.subcategory ?? null, categorySource: t.categorySource ?? null, confidence: t.confidence ?? null, needsReview: !!t.needsReview, reviewed: !!t.reviewed };
    const snap = $state.snapshot(t);
    busy = true;
    try {
      await updateTransaction(t.id, { needsReview: false, reviewed: true, ...(changed ? { category, subcategory: subcategory || null, categorySource: 'user', confidence: 1 } : {}) });
      lastUndo = { kind: 'tx', id: t.id, prev, at: p };
      if (makeRule) {
        const rule = suggestRuleFromCorrection({ ...snap, category }, category);
        if (rule) {
          if (!rule.id) rule.id = uid('rule_');
          const before = new Map(app.data.transactions.map(x => [x.id, x.category]));
          await putRecord('rules', rule);
          await postProcess();
          await reload();
          let n = 0;
          for (const x of app.data.transactions) if (x.category === category && before.get(x.id) !== category) n++;
          lastUndo = null;
          toast(`Regel angewendet auf ${n + 1} Buchungen`, { tone: 'good' });
        } else toast('Keine Regel ableitbar');
      }
      advance();
    } catch (e) {
      console.error(e);
      toast('Speichern fehlgeschlagen', { tone: 'bad' });
    } finally { busy = false; }
  }

  // ---- Dokumente ----
  const centsStr = (c) => (c / 100).toFixed(2).replace('.', ',');
  $effect(() => {
    const d = tab === 'docs' ? cur : null;
    if (!d) return;
    untrack(() => { form = { type: d.type || '', issuer: d.issuer || '', date: d.date || '', amount: d.amount == null ? '' : centsStr(d.amount), title: d.title || '' }; });
  });
  $effect(() => {
    const fid = tab === 'docs' ? cur?.fileId : null;
    const urls = [];
    let dead = false;
    preview = { url: null, full: false };
    if (!fid) return;
    (async () => {
      const th = await getThumb(fid);
      if (dead) return;
      if (th) { const u = URL.createObjectURL(th); urls.push(u); preview = { url: u, full: false }; }
      const blob = await getBlob(fid);
      if (dead || !blob) return;
      if (/^image\/(jpeg|png|webp|gif)/.test(blob.type) && blob.size < 12e6) {
        const u = URL.createObjectURL(blob); urls.push(u); preview = { url: u, full: true };
      }
    })().catch(() => {});
    return () => { dead = true; urls.forEach(u => URL.revokeObjectURL(u)); };
  });
  async function openOriginal() {
    const fid = cur?.fileId;
    const blob = fid && await getBlob(fid);
    if (!blob) { toast('Originaldatei nicht verfügbar'); return; }
    const u = URL.createObjectURL(blob);
    window.open(u, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(u), 120000);
  }
  async function acceptDoc() {
    const d = cur;
    if (busy || !d || tab !== 'docs') return;
    const amount = form.amount.trim() ? parseGermanAmount(form.amount) : null;
    const next = { type: form.type || d.type, issuer: form.issuer.trim() || null, date: form.date || null, amount, title: form.title.trim() || d.title || null };
    const prev = { type: d.type ?? null, issuer: d.issuer ?? null, date: d.date ?? null, amount: d.amount ?? null, title: d.title ?? null, needsReview: !!d.needsReview, reviewed: !!d.reviewed, userEdited: d.userEdited ?? null };
    const edited = Object.keys(next).some(k => (next[k] ?? null) !== (prev[k] ?? null));
    busy = true;
    try {
      await updateDocument(d.id, { ...next, needsReview: false, reviewed: true, ...(edited ? { userEdited: true } : {}) });
      lastUndo = { kind: 'docs', id: d.id, prev, at: p };
      advance();
    } catch (e) { console.error(e); toast('Speichern fehlgeschlagen', { tone: 'bad' }); }
    finally { busy = false; }
  }
  async function markIrrelevant() {
    const d = cur;
    if (busy || !d) return;
    const prev = { type: d.type ?? null, needsReview: !!d.needsReview, reviewed: !!d.reviewed };
    busy = true;
    try {
      await updateDocument(d.id, { type: 'irrelevant', needsReview: false, reviewed: true });
      lastUndo = { kind: 'docs', id: d.id, prev, at: p };
      advance();
    } finally { busy = false; }
  }

  async function undo() {
    const u = lastUndo;
    if (!u || busy) return;
    busy = true;
    try {
      if (u.kind === 'tx') await updateTransaction(u.id, u.prev); else await updateDocument(u.id, u.prev);
      tab = u.kind;
      pos[u.kind] = u.at;
      lastUndo = null;
    } finally { busy = false; }
  }

  // ---- Tastatur ----
  function openPicker() {
    const s = pickerEl?.querySelector('select');
    if (!s) return;
    s.focus();
    try { s.showPicker?.(); } catch { /* ignore */ }
  }
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg?.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'u' && lastUndo) { e.preventDefault(); undo(); return; }
    if (!cur) return;
    if (k === 'enter' && /^(BUTTON|A)$/.test(tg?.tagName || '')) return;
    if (k === 'j' || k === 'enter') { e.preventDefault(); tab === 'docs' ? acceptDoc() : acceptTx(); }
    else if (k === 'k') { e.preventDefault(); skip(); }
    else if (k === 'e') { e.preventDefault(); tab === 'docs' ? typeEl?.focus() : openPicker(); }
    else if (tab === 'tx' && /^[1-9]$/.test(k) && topCats[Number(k) - 1]) { e.preventDefault(); acceptTx(topCats[Number(k) - 1], null); }
  }
  function onPick(pk) {
    if (!pk?.category) return;
    choice = { category: pk.category, subcategory: pk.subcategory || null };
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  const confColor = (c) => (c >= 0.75 ? 'var(--good)' : c >= 0.45 ? 'var(--warn)' : 'var(--bad)');
  const catLabel = (id, sub) => {
    const c = CAT.get(id);
    if (!c) return 'Ohne Kategorie';
    const s = sub && c.subs?.find(x => x.id === sub);
    return s ? `${c.label} › ${s.label}` : c.label;
  };
  const origin = $derived(tab === 'docs' && cur ? sourceOf(cur.fileId) : null);
</script>

<svelte:window onkeydown={onKey} />

<div class="wrap stack">
  <div class="head row wrap">
    <Seg bind:value={tab} options={tabs} />
    <span class="grow"></span>
    {#if lastUndo}<button class="btn btn-ghost btn-sm" onclick={undo} disabled={busy}><Icon name="refresh" size={14} />Rückgängig <kbd>U</kbd></button>{/if}
    {#if total > 0 && !done}<span class="num muted prog" aria-live="polite">{p + 1} / {total}</span>{/if}
  </div>
  {#if total > 0}<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax={total} aria-valuenow={Math.min(p, total)}><i style="width:{Math.min(100, (p / total) * 100)}%"></i></div>{/if}

  {#if done || !cur}
    <div class="card fade-up">
      {#if leftover > 0}
        <Empty icon="inbox" title={`${leftover} ${tab === 'docs' ? 'Dokumente' : 'Buchungen'} übersprungen`}>
          {#snippet action()}<button class="btn btn-primary" onclick={() => restart(tab)}>Nochmal ansehen</button>{/snippet}
        </Empty>
      {:else if otherPending > 0}
        <Empty icon="check" title={tab === 'docs' ? 'Alle Dokumente geprüft' : 'Alle Buchungen geprüft'}>
          {#snippet action()}<button class="btn btn-primary" onclick={() => { const o = tab === 'docs' ? 'tx' : 'docs'; restart(o); tab = o; }}>{tab === 'docs' ? 'Zu den Buchungen' : 'Zu den Dokumenten'}</button>{/snippet}
        </Empty>
      {:else}
        <Empty icon="check" title="Alles geprüft">
          {#snippet action()}<button class="btn btn-primary" onclick={() => setView('overview')}>Zum Überblick</button>{/snippet}
        </Empty>
      {/if}
    </div>
  {:else if tab === 'tx'}
    {#key cur.id}
      <div class="card fade-up tx" class:busy>
        <div class="row wrap meta">
          <span class="badge warn"><Icon name="alert" size={12} />Prüfen</span>
          <span class="small muted num">{fmtDate(cur.bookingDate)}</span>
          <span class="badge ellipsis" style="max-width:180px">{accountName(cur.accountId)}</span>
        </div>
        <div class="who">
          <div class="cpn">{cur.counterparty || cur.counterpartyRaw || '–'}</div>
          {#if cur.purpose}<div class="purpose muted">{cur.purpose}</div>{/if}
        </div>
        <div class="amount num" class:in={cur.amount > 0}><Money value={cur.amount} sign /></div>

        <div class="sugg">
          <div class="row" style="gap:8px">
            <span class="lbl">Vorschlag</span>
            <Tip text="So sicher ist die automatische Zuordnung. Mit Übernehmen wird sie bestätigt, mit Ändern korrigierst du sie." />
            <span class="grow"></span>
            {#if cur.categorySource}<span class="badge">{SRC[cur.categorySource] || cur.categorySource}</span>{/if}
          </div>
          <div class="row" style="gap:10px">
            <span class="dot big" style="background:{CAT.get(choice?.category)?.color || 'var(--text-3)'}"></span>
            <strong class="grow ellipsis">{catLabel(choice?.category, choice?.subcategory)}</strong>
            <span class="num small muted">{Math.round((cur.confidence ?? 0) * 100)} %</span>
          </div>
          <div class="conf"><i style="width:{Math.round((cur.confidence ?? 0) * 100)}%; background:{confColor(cur.confidence ?? 0)}"></i></div>
        </div>

        <div class="quick" role="group" aria-label="Kategorie wählen">
          {#each topCats as id, i (id)}
            <button class="chip" class:on={choice?.category === id && !choice?.subcategory} onclick={() => acceptTx(id, null)} disabled={busy}>
              <kbd>{i + 1}</kbd><span class="dot" style="background:{CAT.get(id)?.color}"></span>{CAT.get(id)?.label}
            </button>
          {/each}
        </div>

        <div class="row wrap" style="gap:12px">
          <span class="lbl">Ändern</span>
          <span bind:this={pickerEl}><CategoryPicker category={choice?.category} subcategory={choice?.subcategory} onpick={onPick} /></span>
          <span class="grow"></span>
          <label class="chk small">
            <input type="checkbox" bind:checked={makeRule} /> Regel daraus machen
            {#if similar > 0}<span class="badge accent">+{similar} ähnliche</span>{/if}
          </label>
        </div>

        <div class="actions">
          <button class="btn" onclick={skip} disabled={busy}>Überspringen <kbd>K</kbd></button>
          <button class="btn" onclick={openPicker} disabled={busy}><Icon name="edit" size={15} />Ändern <kbd>E</kbd></button>
          <span class="grow"></span>
          <button class="btn btn-primary btn-lg" onclick={() => acceptTx()} disabled={busy || !choice?.category}><Icon name="check" size={17} />Übernehmen <kbd class="k">J</kbd></button>
        </div>
      </div>
    {/key}
  {:else}
    {#key cur.id}
      <div class="card fade-up docs" class:busy>
        <div class="pv">
          {#if preview.url}
            <button class="pvbtn" onclick={openOriginal} title="Original öffnen" aria-label="Original öffnen"><img src={preview.url} alt="Vorschau" class:full={preview.full} /></button>
          {:else}
            <div class="pvph"><Icon name="file" size={32} /></div>
          {/if}
          <button class="btn btn-sm btn-ghost" onclick={openOriginal}><Icon name="external" size={14} />Original öffnen</button>
        </div>
        <div class="fm stack">
          <div class="row wrap" style="gap:8px">
            <span class="badge warn"><Icon name="alert" size={12} />{cur.reviewReason || 'Prüfen'}</span>
            {#if cur.confidence != null}<span class="small muted num">{Math.round(cur.confidence * 100)} % sicher</span>{/if}
          </div>
          <div class="grid g2" style="gap:12px">
            <label class="field"><span>Typ</span>
              <select class="input" bind:value={form.type} bind:this={typeEl}>
                {#if form.type && !TYPES.some(t => t.value === form.type)}<option value={form.type}>{form.type}</option>{/if}
                {#each TYPES as t}<option value={t.value}>{t.label}</option>{/each}
              </select>
            </label>
            <label class="field"><span>Datum</span><input class="input" type="date" bind:value={form.date} /></label>
            <label class="field"><span>Aussteller</span><input class="input" bind:value={form.issuer} /></label>
            <label class="field"><span>Betrag (€)</span><input class="input num" inputmode="decimal" bind:value={form.amount} placeholder="0,00" /></label>
          </div>
          <label class="field"><span>Titel</span><input class="input" bind:value={form.title} /></label>
          {#if origin}<div class="small faint ellipsis" title={origin.file.path || origin.file.name}>{origin.source?.name || 'Quelle'} / {origin.file.path || origin.file.name}</div>{/if}
          <div class="actions">
            <button class="btn btn-ghost btn-danger" onclick={markIrrelevant} disabled={busy} title="Aus allen Auswertungen ausblenden"><Icon name="ban" size={15} />Kein Finanzdokument</button>
            <span class="grow"></span>
            <button class="btn" onclick={skip} disabled={busy}>Überspringen <kbd>K</kbd></button>
            <button class="btn btn-primary btn-lg" onclick={acceptDoc} disabled={busy}><Icon name="check" size={17} />Übernehmen <kbd class="k">J</kbd></button>
          </div>
        </div>
      </div>
    {/key}
  {/if}
</div>

<style>
  .wrap { max-width: 880px; margin: 0 auto; gap: 14px; }
  .head { gap: 10px; }
  .prog { font-weight: 600; }
  .bar { height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 4px; transition: width .35s cubic-bezier(.2, .8, .2, 1); }

  .card { padding: 24px; transition: opacity .15s; }
  .card.busy { opacity: .65; pointer-events: none; }
  .tx { display: flex; flex-direction: column; gap: 18px; max-width: 680px; width: 100%; margin: 0 auto; }
  .who { display: flex; flex-direction: column; gap: 6px; }
  .cpn { font-size: 22px; font-weight: 700; letter-spacing: -.015em; overflow-wrap: anywhere; }
  .purpose { font-size: 13px; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .amount { font-size: 30px; font-weight: 750; letter-spacing: -.02em; }
  .amount.in { color: var(--good); }
  .sugg { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: var(--radius-sm); background: var(--surface-2); }
  .lbl { font-size: 12px; font-weight: 600; color: var(--text-2); }
  .dot.big { width: 12px; height: 12px; }
  .conf { height: 5px; border-radius: 5px; background: var(--surface-3); overflow: hidden; }
  .conf i { display: block; height: 100%; border-radius: 5px; transition: width .4s; }
  .quick { display: flex; flex-wrap: wrap; gap: 8px; }
  .quick .chip { height: 30px; transition: background .12s, transform .05s; }
  .quick .chip:hover:not(:disabled) { background: var(--surface-2); }
  .quick .chip:active { transform: translateY(1px); }
  .quick kbd { padding: 0 4px; }
  .chk { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .chk input { accent-color: var(--accent); width: 15px; height: 15px; }
  .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 4px; }
  .btn kbd { background: transparent; opacity: .7; }
  .btn-primary kbd.k { border-color: rgba(255, 255, 255, .45); color: #fff; opacity: .9; }

  .docs { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 24px; align-items: start; }
  .pv { display: flex; flex-direction: column; gap: 10px; align-items: stretch; position: sticky; top: 90px; }
  .pvbtn { border: 1px solid var(--border); background: var(--surface-2); border-radius: var(--radius-sm); padding: 0; cursor: zoom-in; overflow: hidden; max-height: 420px; display: block; }
  .pvbtn img { width: 100%; display: block; object-fit: contain; max-height: 420px; }
  .pvph { height: 240px; border-radius: var(--radius-sm); background: var(--surface-2); display: grid; place-items: center; color: var(--text-3); }
  .fm { gap: 14px; }
  @media (max-width: 720px) {
    .docs { grid-template-columns: minmax(0, 1fr); }
    .pv { position: static; }
    .card { padding: 18px; }
    .cpn { font-size: 19px; }
    .actions .btn-lg { flex: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .bar i, .conf i { transition: none; } }
</style>
