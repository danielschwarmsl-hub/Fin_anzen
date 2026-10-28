<script>
  // Prüfliste: eine Karte je unsicherem Eintrag (Buchung oder Dokument), sortiert nach Geldwirkung.
  // Logik (Kriterium, Sortierung, Patches) liegt DOM-frei in reviewModel.js.
  import { untrack } from 'svelte';
  import { app, setView, updateDocument, applyTxPatches, applyRule, removeRule, autoLearn, toast, reload, getThumb, getBlob, sourceOf, accountName } from '../store/state.svelte.js';
  import { postProcess } from '../store/postprocess.js';
  import { CATEGORIES, categoryLabel } from '../classify/categories.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import { suggestRuleFromCorrection, ruleHits } from '../classify/rules.js';
  import {
    buildQueue, isReceiptSuggestion, isPendingTx, isPendingDoc, isUnreadable, txAspects, docReason, confirmPatches, rejectPatches, confirmAllPatches,
    mergePatches, prevFor, similarOpen, pairOf, splitsFromSuggestion, KIND_LABEL, CONFIDENCE_TEXT,
  } from './reviewModel.js';
  import Icon from '../ui/Icon.svelte';
  import Seg from '../ui/Seg.svelte';
  import Empty from '../ui/Empty.svelte';
  import Money from '../ui/Money.svelte';
  import Tip from '../ui/Tip.svelte';
  import Modal from '../ui/Modal.svelte';
  import CategoryPicker from '../ui/CategoryPicker.svelte';
  import DocFix from '../ui/DocFix.svelte';
  import { fmtDate, parseGermanAmount } from '../util/format.js';

  const CAT = new Map(CATEGORIES.map(c => [c.id, c]));
  const SRC = { rule: 'Regel', merchant: 'Händler', keyword: 'Stichwort', user: 'Manuell', ai: 'KI', transfer: 'Umbuchung' };
  const TYPES = Object.entries(TYPE_LABELS || {}).filter(([value]) => value !== 'irrelevant').map(([value, v]) => ({ value, label: v.name || v.label || value }));
  TYPES.push({ value: 'irrelevant', label: 'Kein Finanzdokument' });
  const REJECT = { receipt: 'Lösen', transfer: 'Keine Umbuchung', paypal: 'Nicht dieselbe Zahlung', depot: 'Nicht doppelt', storno: 'Kein Storno', split: 'Nicht aufteilen' };
  const CONFIRM = { split: 'Übernehmen' };

  const build = (f) => buildQueue({ transactions: app.data.transactions, documents: app.data.documents }, f);
  const initialTab = app.params?.tab === 'tx' || app.params?.tab === 'docs' ? app.params.tab : 'all';

  let filter = $state(initialTab);
  let queue = $state(build(initialTab));
  let pos = $state(0);
  let busy = $state(false);
  let makeRule = $state(false);
  let choice = $state(null);
  let form = $state({ type: '', issuer: '', date: '', amount: '', title: '' });
  let preview = $state({ url: null, full: false });
  let lastUndo = $state(null);
  let pickerEl = $state(null);
  let typeEl = $state(null);

  // Filterwechsel: Liste neu aufbauen
  let builtFor = initialTab;
  $effect(() => {
    const f = filter;
    if (f === builtFor) return;
    builtFor = f;
    untrack(() => { queue = build(f); pos = 0; });
  });

  const counts = $derived.by(() => {
    void app.dataVersion;
    return untrack(() => ({ tx: app.data.transactions.filter(isPendingTx).length, docs: app.data.documents.filter(isPendingDoc).length }));
  });
  const tabs = $derived([
    { value: 'all', label: `Alle · ${counts.tx + counts.docs}` },
    { value: 'tx', label: `Buchungen · ${counts.tx}` },
    { value: 'docs', label: `Dokumente · ${counts.docs}` },
  ]);
  const txById = $derived.by(() => { void app.dataVersion; return untrack(() => new Map(app.data.transactions.map(t => [t.id, t]))); });
  const docById = $derived.by(() => { void app.dataVersion; return untrack(() => new Map(app.data.documents.map(d => [d.id, d]))); });

  const total = $derived(queue.length);
  const curKey = $derived(queue[pos]);
  const isDoc = $derived(!!curKey && curKey.startsWith('d:'));
  const cur = $derived.by(() => {
    void app.dataVersion;
    if (!curKey) return null;
    const id = curKey.slice(2);
    return (isDoc ? app.data.documents : app.data.transactions).find(x => x.id === id) || null;
  });
  const done = $derived(pos >= total);
  const leftover = $derived(filter === 'docs' ? counts.docs : filter === 'tx' ? counts.tx : counts.tx + counts.docs);
  const pendingNow = (o) => (isDoc ? isPendingDoc(o) : isPendingTx(o));

  // Fehlende und inzwischen erledigte Einträge überspringen (z. B. durch eine neue Regel mitgeklärt)
  $effect(() => {
    if (pos >= total) return;
    const stale = !cur || (!busy && !pendingNow(cur));
    if (stale) untrack(() => { pos = pos + 1; });
  });

  function advance() { pos = pos + 1; }
  function restart() { queue = build(filter); pos = 0; }
  function skip() { if (cur && !busy) advance(); }

  // ---- Buchungen ----
  const aspects = $derived(cur && !isDoc ? txAspects(cur) : []);
  const hasCat = $derived(aspects.some(a => a.kind === 'category'));
  const primary = $derived(aspects[0] || null);

  const topCats = $derived.by(() => {
    const t = !isDoc && hasCat ? cur : null;
    if (!t) return [];
    void app.dataVersion;
    return untrack(() => {
      const overall = new Map(), same = new Map();
      for (const x of app.data.transactions) {
        if (!x.category || (x.needsReview && !x.reviewed)) continue;
        overall.set(x.category, (overall.get(x.category) || 0) + 1);
        if (t.counterparty && x.counterparty === t.counterparty) same.set(x.category, (same.get(x.category) || 0) + 1);
      }
      const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
      const out = [];
      for (const c of [t.category, ...rank(same), ...rank(overall)]) if (c && CAT.has(c) && !out.includes(c) && c !== 'umbuchung') out.push(c);
      return out.slice(0, 9);
    });
  });

  // Ähnliche offene Fälle (gleiche Gegenpartei + gleiche Art) für Sammelaktion und Regel-Vorgabe
  const similar = $derived.by(() => {
    const t = !isDoc ? cur : null;
    if (!t || !primary) return [];
    void app.dataVersion;
    return untrack(() => similarOpen($state.snapshot(t), primary.kind, app.data.transactions));
  });
  const similarCat = $derived.by(() => {
    const t = !isDoc && hasCat ? cur : null;
    if (!t) return 0;
    void app.dataVersion;
    return untrack(() => similarOpen($state.snapshot(t), 'category', app.data.transactions).length);
  });
  const catStr = (c) => (c?.subcategory ? `${c.category}.${c.subcategory}` : c?.category);
  // Regel, die aus der aktuellen Wahl entstünde: Muster, Treffer (alle Buchungen, nicht nur offene) und davon offene
  const rulePreview = $derived.by(() => {
    const t = !isDoc && hasCat ? cur : null;
    if (!t || !choice?.category) return null;
    void app.dataVersion;
    return untrack(() => {
      const r = suggestRuleFromCorrection({ ...$state.snapshot(t), ...choice }, catStr(choice));
      if (!r) return { rule: null, hits: [], open: 0 };
      const hits = ruleHits(r, app.data.transactions).filter(x => x.id !== t.id);
      return { rule: r, hits, open: hits.filter(isPendingTx).length };
    });
  });
  const ruleCount = $derived(rulePreview?.hits.length || 0);
  let ruleOpen = $state(false);

  $effect(() => {
    const t = !isDoc ? cur : null;
    void curKey;
    if (!t) return;
    untrack(() => {
      choice = { category: t.category || null, subcategory: t.subcategory || null };
      makeRule = similarCat >= 2;
    });
  });

  /** Patches speichern, Rückgängig vormerken; bei gelösten Paaren neu auswerten (Kategorie der Seiten neu bestimmen) */
  async function commit(list, { rePost = false } = {}) {
    if (!list.length) return;
    const items = list.map(({ id, patch }) => ({ id, prev: prevFor($state.snapshot(txById.get(id)), patch) }));
    await applyTxPatches(list);
    lastUndo = { kind: 'tx', items, at: pos };
    if (rePost) { await postProcess(); await reload(); }
  }
  const ctx = () => ({ txById, choice: $state.snapshot(choice) });
  const changedFrom = (t) => !!choice?.category && (choice.category !== t.category || (choice.subcategory || null) !== (t.subcategory || null));

  /** Nach einer Kategorie-Entscheidung: Regel anlegen (Checkbox) oder automatisch lernen */
  async function learn(snap, changed) {
    if (makeRule && choice?.category) {
      const rule = suggestRuleFromCorrection({ ...snap, ...choice }, catStr(choice));
      if (!rule) { toast('Keine Regel ableitbar'); return; }
      const n = await applyRule(rule);
      lastUndo = null;
      toast(`Regel angewendet auf ${n + 1} Buchungen`, { tone: 'good', ms: 9000, action: { label: 'Rückgängig', fn: () => removeRule(rule.id) } });
    } else if (changed) await autoLearn(snap, choice.category, choice.subcategory);
  }

  /** „Übernehmen“: alle offenen Prüfungen der Buchung bestätigen */
  async function acceptTx(category, subcategory) {
    const t = cur;
    if (busy || !t || isDoc) return;
    if (category) choice = { category, subcategory: subcategory ?? null };
    if (hasCat && !choice?.category) { toast('Bitte zuerst eine Kategorie wählen'); return; }
    const snap = $state.snapshot(t);
    const changed = hasCat && changedFrom(t);
    busy = true;
    try {
      await commit(confirmAllPatches(snap, ctx()));
      if (hasCat) await learn(snap, changed);
      advance();
    } catch (e) {
      console.error(e);
      toast('Speichern fehlgeschlagen', { tone: 'bad' });
    } finally { busy = false; }
  }

  /** Einzelne Prüfung bestätigen oder ablehnen (Karte bleibt, solange noch etwas offen ist) */
  async function actAspect(a, ok) {
    const t = cur;
    if (busy || !t) return;
    busy = true;
    try {
      const snap = $state.snapshot(t);
      const sugg = a.kind === 'receipt' && isReceiptSuggestion(snap, a);
      const list = ok ? confirmPatches(snap, a, ctx()) : rejectPatches(snap, a, ctx());
      await commit(list, { rePost: !ok && a.kind !== 'split' && a.kind !== 'receipt' });
      const msg = sugg ? (ok ? 'Beleg verknüpft' : 'Beleg-Vorschlag abgelehnt') : ok ? `${KIND_LABEL[a.kind]} bestätigt` : `${KIND_LABEL[a.kind]}: ${REJECT[a.kind] || 'abgelehnt'}`;
      toast(msg, { tone: 'good' });
    } catch (e) {
      console.error(e);
      toast('Speichern fehlgeschlagen', { tone: 'bad' });
    } finally { busy = false; }
  }

  // „Alle ähnlichen bestätigen“: erst ansehen und auswählen, dann bestätigen
  let simOpen = $state(false);
  let simSel = $state({});
  const simCount = $derived(1 + similar.filter(s => simSel[s.tx.id]).length);
  function openSimilar() {
    if (busy || !cur || !primary || !similar.length) return;
    if (primary.kind === 'category' && !choice?.category) { toast('Bitte zuerst eine Kategorie wählen'); return; }
    simSel = Object.fromEntries(similar.map(s => [s.tx.id, true]));
    simOpen = true;
  }
  const simAll = (on) => { simSel = Object.fromEntries(similar.map(s => [s.tx.id, on])); };
  const catText = (category, sub) => (category ? categoryLabel(category, sub) || category : 'ohne Kategorie');

  /** Sammelaktion: dieselbe Art bei den ausgewählten offenen Buchungen derselben Gegenpartei bestätigen */
  async function acceptSimilar() {
    const t = cur;
    if (busy || !t || !primary || !similar.length) return;
    if (primary.kind === 'category' && !choice?.category) { toast('Bitte zuerst eine Kategorie wählen'); return; }
    simOpen = false;
    const snap = $state.snapshot(t);
    const c = ctx();
    const picked = similar.filter(s => simSel[s.tx.id]);
    const all = [{ tx: snap, aspect: primary }, ...picked.map(s => ({ tx: $state.snapshot(s.tx), aspect: s.aspect }))];
    const changed = primary.kind === 'category' && changedFrom(t);
    busy = true;
    try {
      await commit(mergePatches(all.flatMap(({ tx, aspect }) => confirmPatches(tx, aspect, c))));
      toast(`${all.length} × ${KIND_LABEL[primary.kind]} bestätigt`, { tone: 'good' });
      if (changed) await autoLearn(snap, choice.category, choice.subcategory);
      if (!isPendingTx(t)) advance();
    } catch (e) {
      console.error(e);
      toast('Speichern fehlgeschlagen', { tone: 'bad' });
    } finally { busy = false; }
  }

  // ---- Dokumente ----
  const centsStr = (c) => (c / 100).toFixed(2).replace('.', ',');
  $effect(() => {
    const d = isDoc ? cur : null;
    void curKey;
    if (!d) return;
    untrack(() => { form = { type: d.type || '', issuer: d.issuer || '', date: d.date || '', amount: d.amount == null ? '' : centsStr(d.amount), title: d.title || '' }; });
  });
  $effect(() => {
    const fid = isDoc ? cur?.fileId : null;
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
    if (busy || !d || !isDoc) return;
    const amount = form.amount.trim() ? parseGermanAmount(form.amount) : null;
    const next = { type: form.type || d.type, issuer: form.issuer.trim() || null, date: form.date || null, amount, title: form.title.trim() || d.title || null };
    const prev = { type: d.type ?? null, issuer: d.issuer ?? null, date: d.date ?? null, amount: d.amount ?? null, title: d.title ?? null, needsReview: !!d.needsReview, reviewed: !!d.reviewed, userEdited: d.userEdited ?? null };
    const edited = Object.keys(next).some(k => (next[k] ?? null) !== (prev[k] ?? null));
    busy = true;
    try {
      await updateDocument(d.id, { ...next, needsReview: false, reviewed: true, ...(edited ? { userEdited: true } : {}) });
      lastUndo = { kind: 'doc', id: d.id, prev, at: pos };
      advance();
    } catch (e) { console.error(e); toast('Speichern fehlgeschlagen', { tone: 'bad' }); }
    finally { busy = false; }
  }
  async function markIrrelevant() {
    const d = cur;
    if (busy || !d || !isDoc) return;
    const prev = { type: d.type ?? null, needsReview: !!d.needsReview, reviewed: !!d.reviewed };
    busy = true;
    try {
      await updateDocument(d.id, { type: 'irrelevant', needsReview: false, reviewed: true });
      lastUndo = { kind: 'doc', id: d.id, prev, at: pos };
      advance();
    } finally { busy = false; }
  }

  async function undo() {
    const u = lastUndo;
    if (!u || busy) return;
    busy = true;
    try {
      if (u.kind === 'tx') await applyTxPatches(u.items.map(i => ({ id: i.id, patch: i.prev })));
      else await updateDocument(u.id, u.prev);
      pos = u.at;
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
    if (simOpen || ruleOpen) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg?.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'u' && lastUndo) { e.preventDefault(); undo(); return; }
    if (!cur) return;
    if (k === 'enter' && /^(BUTTON|A)$/.test(tg?.tagName || '')) return;
    if (k === 'j' || k === 'enter') { e.preventDefault(); isDoc ? acceptDoc() : acceptTx(); }
    else if (k === 'k') { e.preventDefault(); skip(); }
    else if (k === 'e') { e.preventDefault(); isDoc ? typeEl?.focus() : openPicker(); }
    else if (!isDoc && hasCat && /^[1-9]$/.test(k) && topCats[Number(k) - 1]) { e.preventDefault(); acceptTx(topCats[Number(k) - 1], null); }
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
  const pct = (s) => (s == null ? null : Math.round(s <= 1 ? s * 100 : s));
  const origin = $derived(isDoc && cur ? sourceOf(cur.fileId) : null);
  const receiptOf = (a) => docById.get(a.refId || cur?.receiptDocId || (cur?.receiptDocIds || [])[0]) || null;
</script>

<svelte:window onkeydown={onKey} />

{#snippet why(text)}
  <div class="why small"><Icon name="info" size={13} /><span>{text}</span></div>
{/snippet}

{#snippet pairRow(p)}
  {#if p}
    <button class="lrow" onclick={() => setView('transactions', { focus: p.id })} title="Gegenbuchung öffnen">
      <Icon name="split" size={14} />
      <span class="ellipsis grow">{accountName(p.accountId)} · {p.counterparty || p.counterpartyRaw || '–'}</span>
      <span class="small muted num">{fmtDate(p.bookingDate)}</span>
      <Money value={p.amount} sign color />
    </button>
  {/if}
{/snippet}

<div class="wrap stack">
  <div class="head row wrap">
    <Seg bind:value={filter} options={tabs} />
    <span class="grow"></span>
    {#if lastUndo}<button class="btn btn-ghost btn-sm" onclick={undo} disabled={busy}><Icon name="refresh" size={14} />Rückgängig <kbd>U</kbd></button>{/if}
    {#if total > 0 && !done}<span class="num muted prog" aria-live="polite">{pos + 1} / {total}</span>{/if}
    <Tip text="Sortiert nach Betrag: was am meisten Geld bewegt, kommt zuerst. J übernimmt alles auf der Karte, K überspringt, 1–9 wählt eine Kategorie." side="bottom" />
  </div>
  {#if total > 0}<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax={total} aria-valuenow={Math.min(pos, total)}><i style="width:{Math.min(100, (pos / total) * 100)}%"></i></div>{/if}

  {#if done || !cur}
    <div class="card fade-up">
      {#if leftover > 0}
        <Empty icon="inbox" title={`${leftover} offen`}>
          {#snippet action()}<button class="btn btn-primary" onclick={restart}>Nochmal ansehen</button>{/snippet}
        </Empty>
      {:else if counts.tx + counts.docs > 0}
        <Empty icon="check" title={filter === 'docs' ? 'Alle Dokumente geprüft' : 'Alle Buchungen geprüft'}>
          {#snippet action()}<button class="btn btn-primary" onclick={() => (filter = 'all')}>Alle anzeigen</button>{/snippet}
        </Empty>
      {:else}
        <Empty icon="check" title="Alles geprüft">
          {#snippet action()}<button class="btn btn-primary" onclick={() => setView('overview')}>Zum Überblick</button>{/snippet}
        </Empty>
      {/if}
    </div>
  {:else if !isDoc}
    {#key cur.id}
      <div class="card fade-up tx" class:busy>
        <div class="row wrap meta">
          {#each aspects as a (a.kind + (a.refId || ''))}<span class="badge warn"><Icon name="alert" size={12} />{KIND_LABEL[a.kind] || a.kind}</span>{/each}
          <span class="small muted num">{fmtDate(cur.bookingDate)}</span>
          <span class="badge ellipsis" style="max-width:180px">{accountName(cur.accountId)}</span>
        </div>
        <div class="who">
          <div class="cpn">{cur.counterparty || cur.counterpartyRaw || '–'}</div>
          {#if cur.purpose}<div class="purpose muted">{cur.purpose}</div>{/if}
        </div>
        <div class="amount num" class:in={cur.amount > 0}><Money value={cur.amount} sign /></div>

        {#each aspects as a (a.kind + (a.refId || ''))}
          {#if a.kind === 'category'}
            <div class="sugg">
              <div class="row" style="gap:8px">
                <span class="lbl">Kategorie</span>
                <span class="grow"></span>
                {#if cur.categorySource}<span class="badge">{SRC[cur.categorySource] || cur.categorySource}</span>{/if}
              </div>
              <div class="row" style="gap:10px">
                <span class="dot big" style="background:{CAT.get(choice?.category)?.color || 'var(--text-3)'}"></span>
                <strong class="grow ellipsis">{catLabel(choice?.category, choice?.subcategory)}</strong>
                <span class="num small muted">{Math.round((cur.confidence ?? 0) * 100)} %</span>
              </div>
              <div class="conf"><i style="width:{Math.round((cur.confidence ?? 0) * 100)}%; background:{confColor(cur.confidence ?? 0)}"></i></div>
              {@render why(a.reason)}
              {#if cur.aiSuggestion?.category && CAT.has(cur.aiSuggestion.category) && cur.aiSuggestion.category !== cur.category}
                <div class="row wrap small" style="gap:8px">
                  <Icon name="sparkles" size={13} />
                  <span class="grow">KI: <b>{catLabel(cur.aiSuggestion.category, cur.aiSuggestion.subcategory)}</b>{#if cur.aiSuggestion.confidence != null} · {Math.round(cur.aiSuggestion.confidence * 100)} %{/if}{#if cur.aiSuggestion.reason} – {cur.aiSuggestion.reason}{/if}</span>
                  <button class="btn btn-sm" onclick={() => acceptTx(cur.aiSuggestion.category, cur.aiSuggestion.subcategory || null)} disabled={busy}>Übernehmen</button>
                </div>
              {/if}
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
              {#if rulePreview?.rule}
                <label class="chk small">
                  <input type="checkbox" bind:checked={makeRule} /> Regel: alle mit „{rulePreview.rule.match.value}“ → {catText(choice?.category, choice?.subcategory)}
                  <Tip text="Dauerhaft: gilt für alle vorhandenen Buchungen mit diesem Text (auch bereits zugeordnete, außer von dir festgelegte) und für alle künftigen Importe." />
                </label>
                {#if ruleCount > 0}
                  <button class="btn btn-sm btn-ghost" onclick={() => (ruleOpen = true)} title="Treffer ansehen">trifft {ruleCount} weitere{rulePreview.open ? `, davon ${rulePreview.open} offen` : ''} – ansehen</button>
                {/if}
              {:else if rulePreview}
                <span class="small faint">Keine Regel möglich – nur der Zahlungsdienst ist bekannt, nicht der Händler<Tip text="Bei „PayPal“, „Klarna“ oder „VISA“ ohne erkennbaren Shop würde eine Regel alle Buchungen dieses Zahlungsdienstes treffen." /></span>
              {/if}
            </div>
          {:else if a.kind === 'receipt'}
            {@const d = receiptOf(a)}
            <div class="asp">
              <div class="row" style="gap:8px"><span class="lbl">Beleg</span>{#if pct(cur.receiptScore) != null}<span class="badge">{pct(cur.receiptScore)} % Treffer</span>{/if}</div>
              {#if d}
                <button class="lrow" onclick={() => setView('documents', { open: d.id })} title="Beleg öffnen">
                  <Icon name="receipt" size={14} />
                  <span class="ellipsis grow">{d.title || d.issuer || 'Beleg'}</span>
                  <span class="small muted num">{fmtDate(d.date)}</span>
                  {#if d.amount != null}<Money value={d.amount} />{/if}
                </button>
              {/if}
              {@render why(a.reason)}
              {#if cur.aiHint?.reason}{@render why(`KI-Hinweis: ${cur.aiHint.reason}${cur.aiHint.confidence != null ? ` (${pct(cur.aiHint.confidence)} %)` : ''}`)}{/if}
              <div class="row" style="gap:8px">
                {#if isReceiptSuggestion(cur, a)}
                  <button class="btn btn-sm" onclick={() => actAspect(a, true)} disabled={busy}><Icon name="link" size={14} />Verknüpfen</button>
                  <button class="btn btn-sm btn-ghost" onclick={() => actAspect(a, false)} disabled={busy}><Icon name="x" size={14} />Ablehnen</button>
                {:else}
                  <button class="btn btn-sm" onclick={() => actAspect(a, true)} disabled={busy}><Icon name="check" size={14} />Passt</button>
                  <button class="btn btn-sm btn-ghost" onclick={() => actAspect(a, false)} disabled={busy}><Icon name="x" size={14} />{REJECT.receipt}</button>
                {/if}
              </div>
            </div>
          {:else if a.kind === 'split'}
            {@const parts = splitsFromSuggestion(cur)}
            <div class="asp">
              <span class="lbl">Aufteilung</span>
              {#each parts as s, i (i)}
                <div class="row small" style="gap:8px"><span class="dot" style="background:{CAT.get(s.category)?.color}"></span><span class="grow ellipsis">{catLabel(s.category, s.subcategory)}</span><Money value={s.amount} /></div>
              {/each}
              {@render why(a.reason)}
              <div class="row" style="gap:8px">
                <button class="btn btn-sm" onclick={() => actAspect(a, true)} disabled={busy || parts.length < 2}><Icon name="split" size={14} />{CONFIRM.split}</button>
                <button class="btn btn-sm btn-ghost" onclick={() => actAspect(a, false)} disabled={busy}><Icon name="x" size={14} />{REJECT.split}</button>
              </div>
            </div>
          {:else}
            {@const p = pairOf(cur, a, txById)}
            <div class="asp">
              <div class="row" style="gap:8px">
                <span class="lbl">{KIND_LABEL[a.kind] || a.kind}</span>
                {#if CONFIDENCE_TEXT[cur.transferConfidence] && a.kind !== 'storno'}<span class="badge">Sicherheit {CONFIDENCE_TEXT[cur.transferConfidence]}</span>{/if}
              </div>
              {@render pairRow(p)}
              {@render why(a.reason)}
              <div class="row" style="gap:8px">
                <button class="btn btn-sm" onclick={() => actAspect(a, true)} disabled={busy}><Icon name="check" size={14} />Passt</button>
                <button class="btn btn-sm btn-ghost" onclick={() => actAspect(a, false)} disabled={busy}><Icon name="x" size={14} />{REJECT[a.kind] || 'Stimmt nicht'}</button>
              </div>
            </div>
          {/if}
        {/each}

        <div class="actions">
          <button class="btn" onclick={skip} disabled={busy}>Überspringen <kbd>K</kbd></button>
          {#if hasCat}<button class="btn" onclick={openPicker} disabled={busy}><Icon name="edit" size={15} />Ändern <kbd>E</kbd></button>{/if}
          {#if similar.length}
            <button class="btn btn-ghost" onclick={openSimilar} disabled={busy} title="Einmalig: nur offene Prüffälle derselben Gegenpartei – vorher ansehen und auswählen">
              <Icon name="check" size={15} />{similar.length + 1} offene von „{cur.counterparty || cur.counterpartyRaw}“ ansehen &amp; bestätigen
            </button>
          {/if}
          <span class="grow"></span>
          <button class="btn btn-primary btn-lg" onclick={() => acceptTx()} disabled={busy || (hasCat && !choice?.category)}><Icon name="check" size={17} />{aspects.length > 1 ? 'Alles passt' : 'Übernehmen'} <kbd class="k">J</kbd></button>
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
            <span class="badge warn"><Icon name="alert" size={12} />{isUnreadable(cur) ? KIND_LABEL.unreadable : KIND_LABEL.doc}</span>
            {#if cur.confidence != null}<span class="small muted num">{Math.round(cur.confidence * 100)} % sicher</span>{/if}
            {#if cur.amount != null}<span class="grow"></span><Money value={cur.amount} />{/if}
          </div>
          {@render why(docReason(cur))}
          {#if cur.typeSource === 'ai' && cur.aiReason}{@render why(`KI: ${cur.aiReason}`)}{/if}
          {#if isUnreadable(cur) || cur.alternatives?.length}<DocFix doc={cur} />{/if}
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

<Modal bind:open={ruleOpen} title="Treffer der Regel" width={760}>
  {#if rulePreview?.rule}
    <div class="stack tight">
      <p class="small muted">Alle Buchungen, deren Text „<b>{rulePreview.rule.match.value}</b>“ enthält, würden <b>{catText(choice?.category, choice?.subcategory)}</b> – jetzt und bei künftigen Importen. Von dir festgelegte Kategorien bleiben.</p>
      <ul class="plain simlist">
        {#each rulePreview.hits.slice(0, 300) as h (h.id)}
          <li class="simrow norule">
            <span class="num muted">{fmtDate(h.bookingDate)}</span>
            <span class="simtxt">
              <span class="ellipsis">{h.counterparty || h.counterpartyRaw || '–'} · {h.purpose || h.bookingText || ''}</span>
              <span class="faint small">bisher {catText(h.category, h.subcategory)}{isPendingTx(h) ? ' · offen' : ''}</span>
            </span>
            <Money value={h.amount} class="small" />
          </li>
        {/each}
      </ul>
      {#if rulePreview.hits.length > 300}<div class="small faint">+{rulePreview.hits.length - 300} weitere</div>{/if}
    </div>
  {/if}
  {#snippet footer()}<button class="btn" onclick={() => (ruleOpen = false)}>Schließen</button>{/snippet}
</Modal>

<Modal bind:open={simOpen} title="Offene Buchungen derselben Gegenpartei bestätigen" width={760}>
  {#if cur && primary}
    <div class="stack tight">
      <p class="small muted">
        {KIND_LABEL[primary.kind]} bestätigen für alle offenen Buchungen von <b>{cur.counterparty || cur.counterpartyRaw || '–'}</b>{#if primary.kind === 'category'} → <b>{catText(choice?.category, choice?.subcategory)}</b>{/if}.
        Abwählen, was nicht dazugehört.
      </p>
      <div class="row small"><button class="btn btn-sm btn-ghost" onclick={() => simAll(true)}>Alle</button><button class="btn btn-sm btn-ghost" onclick={() => simAll(false)}>Keine</button></div>
      <ul class="plain simlist">
        <li class="simrow cur">
          <input type="checkbox" checked disabled aria-label="Aktuelle Buchung" />
          <span class="num muted">{fmtDate(cur.bookingDate)}</span>
          <span class="simtxt"><span class="ellipsis">{cur.purpose || cur.bookingText || '–'}</span><span class="faint small">diese Buchung{#if primary.kind === 'category'} · bisher {catText(cur.category, cur.subcategory)}{/if}</span></span>
          <Money value={cur.amount} class="small" />
        </li>
        {#each similar as s (s.tx.id)}
          <li class="simrow">
            <input type="checkbox" bind:checked={simSel[s.tx.id]} aria-label="Auswählen" />
            <span class="num muted">{fmtDate(s.tx.bookingDate)}</span>
            <span class="simtxt">
              <span class="ellipsis">{s.tx.purpose || s.tx.bookingText || '–'}</span>
              <span class="faint small">{#if primary.kind === 'category'}bisher {catText(s.tx.category, s.tx.subcategory)}{:else}{s.aspect.reason || KIND_LABEL[primary.kind]}{/if}{s.tx.accountId ? ' · ' + accountName(s.tx.accountId) : ''}</span>
            </span>
            <Money value={s.tx.amount} class="small" />
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (simOpen = false)}>Abbrechen</button>
    <button class="btn btn-primary" onclick={acceptSimilar} disabled={busy}><Icon name="check" size={15} />{simCount} bestätigen</button>
  {/snippet}
</Modal>

<style>
  .wrap { max-width: 880px; margin: 0 auto; gap: 14px; }
  .head { gap: 10px; }
  .prog { font-weight: 600; }
  .bar { height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 4px; transition: width .35s cubic-bezier(.2, .8, .2, 1); }

  .card { padding: 24px; transition: opacity .15s; }
  .card.busy { opacity: .65; pointer-events: none; }
  .tx { display: flex; flex-direction: column; gap: 18px; max-width: 680px; width: 100%; margin: 0 auto; }
  .meta { gap: 8px; }
  .who { display: flex; flex-direction: column; gap: 6px; }
  .cpn { font-size: 22px; font-weight: 700; letter-spacing: -.015em; overflow-wrap: anywhere; }
  .purpose { font-size: 13px; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .amount { font-size: 30px; font-weight: 750; letter-spacing: -.02em; }
  .amount.in { color: var(--good); }
  .sugg, .asp { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: var(--radius-sm); background: var(--surface-2); }
  .why { display: flex; gap: 6px; align-items: flex-start; color: var(--text-2); }
  .why :global(svg) { flex: none; margin-top: 2px; }
  .lrow { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: inherit; cursor: pointer; text-align: left; min-width: 0; }
  .lrow:hover { border-color: var(--accent); }
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
  .simlist { display: grid; gap: 2px; max-height: 52vh; overflow: auto; }
  .simrow { display: grid; grid-template-columns: auto 86px 1fr auto; gap: 10px; align-items: center; padding: 6px 4px; border-bottom: 1px solid var(--border); }
  .simrow.cur { background: var(--surface-2); border-radius: 8px; }
  .simtxt { display: grid; min-width: 0; }
  .simrow.norule { grid-template-columns: 86px 1fr auto; }
</style>
