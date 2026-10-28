<script>
  // Seitenpanel mit allen Details einer Buchung
  import { untrack } from 'svelte';
  import { app, updateTransaction, setView, getThumb, sourceOf, accountName, toast } from '../store/state.svelte.js';
  import { CATEGORIES } from '../classify/categories.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import CategoryPicker from '../ui/CategoryPicker.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Money from '../ui/Money.svelte';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import { fmtDate, fmtEUR, parseGermanAmount } from '../util/format.js';

  let { txId, onclose, onprev = null, onnext = null, oncategory = null } = $props();

  const REASONS = {
    lohn: 'Lohn & Gehalt',
    beruf: 'Beruf & Werbungskosten',
    versicherung_vorsorge: 'Versicherung & Vorsorge',
    kapitalertraege: 'Kapitalerträge',
    haushalt_handwerker: 'Haushalt & Handwerker',
    spenden: 'Spenden',
    gesundheit: 'Gesundheit',
    kinder_bildung: 'Kinder & Bildung',
    sonstiges: 'Sonstiges',
  };
  const SRC = { rule: 'Regel', merchant: 'Händler', keyword: 'Stichwort', user: 'Manuell', ai: 'KI', transfer: 'Umbuchung' };

  const tx = $derived(app.data.transactions.find(t => t.id === txId));
  const doc = $derived(tx?.receiptDocId ? app.data.documents.find(d => d.id === tx.receiptDocId) : null);
  const srcDoc = $derived(tx?.documentId ? app.data.documents.find(d => d.id === tx.documentId) : null);
  const origin = $derived(tx ? sourceOf(tx.fileId || srcDoc?.fileId) : null);
  const contract = $derived(tx?.contractId ? app.data.contracts.find(c => c.id === tx.contractId) : null);
  const typeLabel = (t) => TYPE_LABELS?.[t]?.name || t || 'Dokument';
  const catOf = (id) => CATEGORIES.find(c => c.id === id);

  let panel = $state(null);
  $effect(() => { panel?.focus({ preventScroll: true }); });
  $effect(() => { if (!tx) onclose?.(); });

  // Vorschaubild des Belegs
  let thumbUrl = $state(null);
  $effect(() => {
    const fid = doc?.fileId;
    let url = null, dead = false;
    thumbUrl = null;
    if (!fid) return;
    getThumb(fid).then(b => { if (b && !dead) { url = URL.createObjectURL(b); thumbUrl = url; } }).catch(() => {});
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  });

  function onKey(e) {
    if (e.key === 'Escape' && e.target?.tagName !== 'SELECT') { e.preventDefault(); onclose?.(); }
  }

  const patch = (p) => updateTransaction(txId, p);

  function rename(e) {
    const v = e.target.value.trim();
    if (!v || v === tx.counterparty) { e.target.value = tx.counterparty || ''; return; }
    patch({ counterparty: v, counterpartyUser: true });
  }
  function setCat(p) {
    if (!p?.category) return;
    if (oncategory) oncategory(tx, p);
    else patch({ category: p.category, subcategory: p.subcategory || null, categorySource: 'user', confidence: 1, needsReview: false });
  }
  function setTax(v) {
    patch({ taxRelevant: !!v, taxReason: v ? (tx.taxReason || 'sonstiges') : tx.taxReason, taxSource: 'user' });
  }
  function setReason(e) { patch({ taxReason: e.target.value, taxRelevant: true, taxSource: 'user' }); }
  function setTransfer(v) {
    if (v) patch({ isTransfer: true, category: 'umbuchung', subcategory: null, categorySource: 'user', confidence: 1, needsReview: false });
    else patch({ isTransfer: false, transferPairId: null, category: tx.category === 'umbuchung' ? 'sonstiges' : tx.category, categorySource: 'user' });
  }
  function setNote(e) { patch({ note: e.target.value.trim() || null }); }
  function unlinkReceipt() { patch({ receiptDocId: null }); }
  function reviewed() { patch({ needsReview: false, reviewed: true }); }

  // Aufteilen
  let parts = $state(null);
  const cents2str = (c) => (c / 100).toFixed(2).replace('.', ',');
  $effect(() => {
    const id = txId;
    untrack(() => {
      const t = app.data.transactions.find(x => x.id === id);
      parts = t?.splits?.length ? t.splits.map(s => ({ amt: cents2str(Math.abs(s.amount)), category: s.category, subcategory: s.subcategory || null })) : null;
    });
  });
  const total = $derived(Math.abs(tx?.amount || 0));
  const partsSum = $derived(parts ? parts.reduce((s, p) => s + Math.abs(parseGermanAmount(p.amt) || 0), 0) : 0);
  const rest = $derived(total - partsSum);
  const splitOk = $derived(!!parts && parts.length >= 2 && rest === 0 && parts.every(p => (parseGermanAmount(p.amt) || 0) !== 0 && p.category));
  function startSplit() {
    const a = Math.round(total / 2);
    parts = [
      { amt: cents2str(a), category: tx.category, subcategory: tx.subcategory || null },
      { amt: cents2str(total - a), category: tx.category, subcategory: tx.subcategory || null },
    ];
  }
  function addPart() { parts.push({ amt: cents2str(Math.max(rest, 0)), category: tx.category, subcategory: tx.subcategory || null }); }
  function dropPart(i) { parts.splice(i, 1); if (parts.length < 2) parts = null; }
  function fillRest() { if (!parts?.length) return; const l = parts[parts.length - 1]; l.amt = cents2str(Math.max(0, (Math.abs(parseGermanAmount(l.amt) || 0)) + rest)); }
  async function saveSplit() {
    if (!splitOk) return;
    const sign = tx.amount < 0 ? -1 : 1;
    const splits = parts.map(p => ({ amount: sign * Math.abs(parseGermanAmount(p.amt)), category: p.category, subcategory: p.subcategory || null }));
    await patch({ splits, categorySource: 'user', confidence: 1, needsReview: false });
    toast('Aufteilung gespeichert', { tone: 'good' });
  }
  async function clearSplit() { parts = null; await patch({ splits: null }); }

  const fmtIban = (s) => (s ? String(s).replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim() : '');
  const details = $derived(tx ? [
    ['Buchungsdatum', tx.bookingDate ? fmtDate(tx.bookingDate) : null],
    ['Wertstellung', tx.valueDate ? fmtDate(tx.valueDate) : null],
    ['Buchungstext', tx.bookingText],
    ['IBAN', fmtIban(tx.counterpartyIban)],
    ['Mandatsreferenz', tx.mandateId],
    ['Gläubiger-ID', tx.creditorId],
    ['End-to-End-ID', tx.endToEndId],
    ['GVC', tx.gvc],
    ['Gebühr', tx.fee ? fmtEUR(tx.fee) : null],
    ['Originalname', tx.counterpartyRaw && tx.counterpartyRaw !== tx.counterparty ? tx.counterpartyRaw : null],
  ].filter(([, v]) => v) : []);
  const confColor = (c) => (c >= 0.75 ? 'var(--good)' : c >= 0.45 ? 'var(--warn)' : 'var(--bad)');
</script>

<svelte:window onkeydown={onKey} />
<div class="back" role="presentation" onclick={() => onclose?.()}></div>
{#if tx}
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Buchungsdetails" tabindex="-1" bind:this={panel}>
    <header class="dh">
      <div class="grow row wrap" style="gap:8px">
        <span class="small muted num">{fmtDate(tx.bookingDate)}</span>
        <span class="badge ellipsis" style="max-width:160px">{accountName(tx.accountId)}</span>
        {#if tx.needsReview && !tx.reviewed}<span class="badge warn">Prüfen</span>{/if}
      </div>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={onprev} disabled={!onprev} aria-label="Vorherige Buchung"><Icon name="arrowUp" size={16} /></button>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={onnext} disabled={!onnext} aria-label="Nächste Buchung"><Icon name="arrowDown" size={16} /></button>
      <button class="btn btn-ghost btn-icon btn-sm" onclick={() => onclose?.()} aria-label="Schließen"><Icon name="x" size={16} /></button>
    </header>

    <div class="db scroll">
      <section class="hero">
        <input class="name" value={tx.counterparty || ''} onchange={rename} placeholder="Gegenpartei" aria-label="Gegenpartei" />
        <div class="amt num" class:in={tx.amount > 0}><Money value={tx.amount} sign /></div>
        {#if tx.purpose}<p class="purpose">{tx.purpose}</p>{/if}
      </section>

      <section class="sec">
        <div class="lbl">Kategorie
          {#if tx.categorySource}<span class="badge">{SRC[tx.categorySource] || tx.categorySource}</span>{/if}
          <Tip text="Änderungen werden als manuelle Entscheidung gespeichert und bei Neuberechnung nicht überschrieben." />
        </div>
        <div class="row" style="gap:10px">
          <CategoryPicker category={tx.category} subcategory={tx.subcategory} onpick={setCat} />
          {#if tx.needsReview && !tx.reviewed}<button class="btn btn-sm" onclick={reviewed}><Icon name="check" size={14} />Passt</button>{/if}
        </div>
        {#if tx.confidence != null && tx.confidence < 1 && tx.categorySource !== 'user'}
          <div class="conf" title="Sicherheit der Zuordnung"><i style="width:{Math.round(tx.confidence * 100)}%; background:{confColor(tx.confidence)}"></i></div>
        {/if}
      </section>

      <section class="sec flags">
        <div class="frow">
          <Toggle checked={!!tx.taxRelevant} label="Steuerrelevant" onchange={setTax} />
          {#if tx.taxRelevant}
            <select class="input sm" value={tx.taxReason || 'sonstiges'} onchange={setReason} aria-label="Steuergrund">
              {#each Object.entries(REASONS) as [k, v]}<option value={k}>{v}</option>{/each}
            </select>
          {/if}
        </div>
        <div class="frow"><Toggle checked={!!tx.isTransfer} label="Umbuchung" onchange={setTransfer} /><Tip text="Umbuchungen zwischen eigenen Konten zählen nicht als Einnahme oder Ausgabe." /></div>
      </section>

      <section class="sec">
        <div class="lbl">Beleg</div>
        {#if doc}
          <div class="linkrow">
            <div class="thumb">{#if thumbUrl}<img src={thumbUrl} alt="" />{:else}<Icon name="receipt" size={20} />{/if}</div>
            <div class="grow">
              <div class="b ellipsis">{doc.title || doc.issuer || 'Beleg'}</div>
              <div class="small muted ellipsis">{typeLabel(doc.type)} · {fmtDate(doc.date)}{doc.amount != null ? ' · ' + fmtEUR(doc.amount) : ''}</div>
            </div>
            <button class="btn btn-sm" onclick={() => setView('documents', { open: doc.id })}>Öffnen</button>
            <button class="btn btn-ghost btn-icon btn-sm" onclick={unlinkReceipt} aria-label="Verknüpfung lösen" title="Verknüpfung lösen"><Icon name="x" size={14} /></button>
          </div>
        {:else}<span class="faint">–</span>{/if}
      </section>

      {#if contract}
        <section class="sec">
          <div class="lbl">Vertrag / Abo</div>
          <div class="linkrow">
            <div class="thumb"><Icon name="repeat" size={18} /></div>
            <div class="grow"><div class="b ellipsis">{contract.provider || 'Vertrag'}</div>{#if contract.interval}<div class="small muted">{({ weekly: 'wöchentlich', biweekly: '14-täglich', monthly: 'monatlich', quarterly: 'vierteljährlich', halfyearly: 'halbjährlich', yearly: 'jährlich' })[contract.interval] || contract.interval}</div>{/if}</div>
            <button class="btn btn-sm" onclick={() => setView('contracts', { open: contract.id })}>Öffnen</button>
          </div>
        </section>
      {/if}

      {#if srcDoc || origin}
        <section class="sec">
          <div class="lbl">Herkunft</div>
          <div class="linkrow">
            <div class="thumb"><Icon name="file" size={18} /></div>
            <div class="grow">
              <div class="b ellipsis">{srcDoc?.title || origin?.file?.name || 'Quelldatei'}</div>
              {#if origin}<div class="small muted ellipsis" title={(origin.source?.name || '') + ' / ' + (origin.file.path || origin.file.name || '')}>{origin.source?.name || 'Quelle'} / {origin.file.path || origin.file.name}</div>{/if}
            </div>
            {#if srcDoc}<button class="btn btn-sm" onclick={() => setView('documents', { open: srcDoc.id })}>Öffnen</button>{/if}
          </div>
        </section>
      {/if}

      {#if details.length}
        <Collapsible title="Details" badge={details.length}>
          <dl class="kv">
            {#each details as [k, v]}<dt>{k}</dt><dd class:mono={k === 'IBAN' || k.endsWith('ID') || k === 'Mandatsreferenz'}>{v}</dd>{/each}
          </dl>
        </Collapsible>
      {/if}

      <Collapsible title="Aufteilen" open={!!tx.splits?.length} badge={tx.splits?.length || null}>
        {#if !parts}
          <button class="btn btn-sm" onclick={startSplit}><Icon name="split" size={14} />In Teile aufteilen</button>
        {:else}
          <div class="stack tight">
            {#each parts as p, i}
              <div class="part">
                <input class="input sm num" bind:value={p.amt} inputmode="decimal" aria-label="Betrag Teil {i + 1}" />
                <CategoryPicker category={p.category} subcategory={p.subcategory} compact onpick={(c) => { p.category = c.category; p.subcategory = c.subcategory; }} />
                <button class="btn btn-ghost btn-icon btn-sm" onclick={() => dropPart(i)} aria-label="Teil entfernen"><Icon name="x" size={14} /></button>
              </div>
            {/each}
            <div class="row between">
              <button class="btn btn-ghost btn-sm" onclick={addPart}><Icon name="plus" size={14} />Teil</button>
              <button class="restbtn small num" class:ok={rest === 0} onclick={fillRest} disabled={rest === 0} title="Rest dem letzten Teil zuweisen">
                {rest === 0 ? 'Passt' : (rest > 0 ? 'Offen ' : 'Zu viel ') + fmtEUR(Math.abs(rest))}
              </button>
            </div>
            <div class="row" style="gap:8px">
              <button class="btn btn-primary btn-sm" onclick={saveSplit} disabled={!splitOk}>Speichern</button>
              {#if tx.splits?.length}<button class="btn btn-ghost btn-sm btn-danger" onclick={clearSplit}>Aufteilung aufheben</button>
              {:else}<button class="btn btn-ghost btn-sm" onclick={() => (parts = null)}>Abbrechen</button>{/if}
            </div>
          </div>
        {/if}
      </Collapsible>

      <section class="sec">
        <label class="field"><span>Notiz</span>
          <textarea class="input" rows="2" value={tx.note || ''} onchange={setNote} placeholder="Optional"></textarea>
        </label>
      </section>
    </div>
  </aside>
{/if}

<style>
  .back { position: fixed; inset: 0; background: rgba(8, 10, 18, .28); z-index: 80; animation: fade .2s ease both; }
  .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 100vw); z-index: 85; display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); animation: slide .25s cubic-bezier(.2, .8, .2, 1) both; outline: none; }
  @keyframes slide { from { transform: translateX(32px); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .dh { display: flex; align-items: center; gap: 4px; padding: 12px 14px 12px 20px; border-bottom: 1px solid var(--border); }
  .db { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 18px; }
  .hero { display: flex; flex-direction: column; gap: 4px; }
  .name { border: 1px solid transparent; background: transparent; font-size: 20px; font-weight: 700; letter-spacing: -.01em; padding: 4px 8px; margin: 0 -8px; border-radius: 9px; width: calc(100% + 16px); outline: none; transition: border-color .15s, background .15s; }
  .name:hover { background: var(--surface-2); }
  .name:focus { border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px var(--accent-soft); }
  .amt { font-size: 28px; font-weight: 700; letter-spacing: -.02em; }
  .amt.in { color: var(--good); }
  .purpose { margin: 6px 0 0; padding: 10px 12px; background: var(--surface-2); border-radius: var(--radius-sm); color: var(--text-2); font-size: 13px; overflow-wrap: anywhere; user-select: text; max-height: 140px; overflow: auto; }
  .sec { display: flex; flex-direction: column; gap: 8px; }
  .lbl { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--text-2); }
  .conf { height: 4px; border-radius: 4px; background: var(--surface-3); overflow: hidden; max-width: 220px; }
  .conf i { display: block; height: 100%; border-radius: 4px; transition: width .3s; }
  .flags { gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .frow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .input.sm { height: 30px; font-size: 13px; padding: 0 8px; }
  .linkrow { display: flex; align-items: center; gap: 10px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .thumb { width: 40px; height: 40px; border-radius: 8px; background: var(--surface-2); display: grid; place-items: center; color: var(--text-3); overflow: hidden; flex: none; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .b { font-weight: 600; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
  .kv dt { color: var(--text-3); }
  .kv dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
  .part { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 8px; }
  .restbtn { border: 0; background: var(--warn-soft); color: var(--warn); padding: 3px 10px; border-radius: 999px; cursor: pointer; font-weight: 600; }
  .restbtn.ok { background: var(--good-soft); color: var(--good); cursor: default; }
  textarea.input { resize: vertical; width: 100%; }
  @media (prefers-reduced-motion: reduce) { .drawer, .back { animation: none; } }
</style>
