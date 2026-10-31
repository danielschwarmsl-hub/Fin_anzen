<script>
  // Dokument-Detail: Vorschau links, Felder & Aktionen rechts. Öffnet als Seitenpanel.
  import { untrack } from 'svelte';
  import { app, setView, getBlob, getThumb, updateDocument, toast } from '../store/state.svelte.js';
  import { openPdf, closePdf } from '../extract/pdf.js';
  import { TYPE_LABELS } from '../parsers/naming.js';
  import { parseGermanAmount, fmtDate } from '../util/format.js';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Toggle from '../ui/Toggle.svelte';
  import Money from '../ui/Money.svelte';
  import Collapsible from '../ui/Collapsible.svelte';
  import DocFix from '../ui/DocFix.svelte';
  import { isUnreadable, docReason } from './reviewModel.js';

  let { id, onclose = null } = $props();

  const TAX_REASONS = [
    ['lohn', 'Lohn & Gehalt'],
    ['beruf', 'Beruf & Werbungskosten'],
    ['versicherung_vorsorge', 'Versicherung & Vorsorge'],
    ['kapitalertraege', 'Kapitalerträge'],
    ['haushalt_handwerker', 'Haushalt & Handwerker'],
    ['spenden', 'Spenden'],
    ['gesundheit', 'Gesundheit'],
    ['kinder_bildung', 'Kinder & Bildung'],
    ['sonstiges', 'Sonstiges'],
  ];
  const PAYROLL_LABELS = { gross: 'Brutto', net: 'Netto', payout: 'Auszahlung', lohnsteuer: 'Lohnsteuer', soli: 'Soli', kirchensteuer: 'Kirchensteuer', kv: 'Krankenversicherung', pv: 'Pflegeversicherung', rv: 'Rentenversicherung', av: 'Arbeitslosenversicherung' };
  const TYPE_OPTIONS = Object.entries(TYPE_LABELS).filter(([k]) => k !== 'irrelevant');
  const IMG_EXT = /^(png|jpe?g|webp|gif|bmp|heic|heif|tiffe?|tif)$/;

  const centsText = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
  const labelize = (k) => { const s = String(k).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
  const fmtVal = (v) => (typeof v === 'boolean' ? (v ? 'Ja' : 'Nein') : typeof v === 'object' ? JSON.stringify(v) : String(v));
  // Wertpapier-Felder: deutsche Beschriftung; 'cent' = Betrag in Cent, 'fx' = Cent in der Fremdwährung des Dokuments
  const SECURITY_FIELDS = {
    security: ['Wertpapier'], wkn: ['WKN'], isin: ['ISIN'], quantity: ['Stück'], price: ['Kurs', 'cent'], venue: ['Ausführungsplatz'],
    orderNo: ['Ordernummer'], valuta: ['Valuta', 'date'], marketValue: ['Kurswert', 'cent'], fees: ['Entgelte', 'cent'],
    taxPaid: ['Abgeführte Steuern', 'cent'], currency: ['Währung'], gross: ['Brutto', 'cent'], grossForeign: ['Brutto', 'fx'],
    withholdingTax: ['Quellensteuer', 'fx'], fxRate: ['Devisenkurs'], perShare: ['Ertrag je Stück'], capitalIncome: ['Kapitalertrag'],
    infoOnly: ['Nur Information'], side: ['Art'], period: ['Zeitraum'], depot: ['Depot'],
  };
  function fieldRow(d, k, v) {
    const f = d.type === 'wertpapier' ? SECURITY_FIELDS[k] : null;
    if (!f) return [labelize(k), fmtVal(v)];
    const cur = d.fields?.currency && d.fields.currency !== 'EUR' ? d.fields.currency : 'EUR';
    const val = f[1] === 'cent' ? `${centsText(v)} €` : f[1] === 'fx' ? `${centsText(v)} ${cur}` : f[1] === 'date' ? fmtDate(v) : fmtVal(v);
    return [f[0], val];
  }

  // ---- Daten ----
  const doc = $derived(app.data.documents.find((d) => d.id === id) || null);
  const file = $derived(doc ? app.data.files.find((f) => f.id === doc.fileId) || null : null);
  const ext = $derived(String(file?.ext || '').toLowerCase());
  const kind = $derived.by(() => {
    if (!doc) return 'none';
    if (ext === 'pdf' || file?.mime === 'application/pdf') return 'pdf';
    if (IMG_EXT.test(ext)) return 'image';
    if (doc.text) return 'text';
    return 'none';
  });
  const typeIcon = $derived(TYPE_LABELS[doc?.type]?.icon || 'file');

  // Bemerkung: Abbruch, falls das Dokument verschwindet
  $effect(() => { if (!doc) onclose?.(); });

  // ---- Formular (Entwurf) ----
  const toForm = (d) => ({
    title: d.title ?? '',
    type: d.type ?? 'finanz_sonstiges',
    issuer: d.issuer ?? '',
    date: d.date ?? '',
    amount: centsText(d.amount),
    tags: (d.tags ?? []).join(', '),
  });
  let form = $state({ title: '', type: 'finanz_sonstiges', issuer: '', date: '', amount: '', tags: '' });
  $effect(() => {
    void id;
    const d = untrack(() => doc);
    if (d) form = toForm(d);
  });

  const amountInvalid = $derived(form.amount.trim() !== '' && parseGermanAmount(form.amount) == null);

  const changes = $derived.by(() => {
    const out = {};
    if (!doc) return out;
    const title = form.title.trim() || null;
    if (title !== (doc.title ?? null)) out.title = title;
    if (form.type !== doc.type) out.type = form.type;
    const issuer = form.issuer.trim() || null;
    if (issuer !== (doc.issuer ?? null)) out.issuer = issuer;
    const date = form.date || null;
    if (date !== (doc.date ?? null)) out.date = date;
    if (!amountInvalid) {
      const amt = form.amount.trim() === '' ? null : parseGermanAmount(form.amount);
      if (amt !== (doc.amount ?? null)) out.amount = amt;
    }
    const tags = form.tags.split(',').map((s) => s.trim()).filter(Boolean);
    if (tags.join('|') !== (doc.tags ?? []).join('|')) out.tags = tags;
    return out;
  });
  const dirty = $derived(Object.keys(changes).length > 0);

  async function commit(extra, msg = 'Gespeichert') {
    if (!doc || amountInvalid) return;
    const edited = Object.keys(changes).length > 0;
    const patch = { ...changes, ...extra };
    if (!Object.keys(patch).length) return;
    if (edited) patch.userEdited = true;
    await updateDocument(id, patch);
    toast(msg);
  }
  const save = () => commit({});
  const markReviewed = () => commit({ needsReview: false, reviewed: true }, 'Als geprüft markiert');

  async function setTax(on) {
    await updateDocument(id, { taxRelevant: on, taxReason: on ? doc.taxReason || 'sonstiges' : null, taxSource: 'user' });
  }
  async function setTaxReason(r) {
    await updateDocument(id, { taxReason: r, taxSource: 'user' });
  }

  // ---- Verknüpfte Buchungen ----
  const linked = $derived.by(() => {
    if (!doc) return [];
    return app.data.transactions
      .filter((t) => t.receiptDocId === doc.id || t.documentId === doc.id || (Array.isArray(t.receiptDocIds) && t.receiptDocIds.includes(doc.id)))
      .sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''));
  });
  const payrollRows = $derived(
    doc?.payroll ? Object.entries(PAYROLL_LABELS).filter(([k]) => doc.payroll[k] != null).map(([k, label]) => ({ label, value: doc.payroll[k] })) : []
  );
  const fieldRows = $derived(
    doc?.fields ? Object.entries(doc.fields).filter(([k, v]) => v != null && v !== '' && !HIDDEN_FIELDS.has(k)).map(([k, v]) => fieldRow(doc, k, v)) : []
  );

  // Kontrollsummen und Info-Abschnitte (Kontoauszug/Finanzreport) eigens darstellen, nicht als Rohfelder
  const HIDDEN_FIELDS = new Set(['diagnostics', 'controlTotals', 'infoSections', 'variant', 'section']);
  const totals = $derived(doc?.fields?.controlTotals || null);
  const infoSections = $derived(Array.isArray(doc?.fields?.infoSections) && doc.fields.infoSections.length ? doc.fields.infoSections : null);

  // Diagnose beim Einlesen von Kontoumsätzen: nur zeigen, wenn etwas hakt
  const diag = $derived(doc?.fields?.diagnostics?.problems?.length ? doc.fields.diagnostics : null);

  // ---- Vorschau ----
  let pdf = $state(null);
  let pdfErr = $state(null);
  let loading = $state(false);
  let pageNo = $state(1);
  let wrapW = $state(0);
  let canvas = $state(null);
  const pageCount = $derived(pdf?.numPages ?? 0);

  let imgUrl = $state(null);
  let imgFailed = $state(false);
  let thumbUrl = $state(null);

  function goPage(n) {
    if (pdf && n >= 1 && n <= pdf.numPages) pageNo = n;
  }

  // PDF laden
  $effect(() => {
    const fid = doc?.fileId;
    if (kind !== 'pdf' || !fid) return;
    let cancelled = false;
    let loaded = null;
    pdfErr = null;
    loading = true;
    (async () => {
      try {
        const blob = await getBlob(fid);
        if (!blob) throw new Error('Original fehlt');
        const d = await openPdf(await blob.arrayBuffer());
        if (cancelled) { closePdf(d); return; }
        loaded = d;
        pdf = d;
        pageNo = 1;
      } catch (e) {
        if (!cancelled) pdfErr = e.message || 'Vorschau nicht möglich';
      } finally {
        if (!cancelled) loading = false;
      }
    })();
    return () => { cancelled = true; pdf = null; if (loaded) closePdf(loaded); };
  });

  // Seite rendern, Breite einpassen
  $effect(() => {
    const p = pdf, n = pageNo, w = wrapW, c = canvas;
    if (!p || !c || !w) return;
    let cancelled = false;
    let task = null;
    p.getPage(n)
      .then(async (page) => {
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const avail = Math.max(120, w - 24);
        const vp = page.getViewport({ scale: (avail / base.width) * dpr });
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
        await task.promise;
      })
      .catch((e) => { if (!cancelled && e?.name !== 'RenderingCancelledException') pdfErr = e.message || 'Vorschau nicht möglich'; });
    return () => { cancelled = true; task?.cancel(); };
  });

  // Bilddatei als Object-URL
  $effect(() => {
    const fid = doc?.fileId;
    if (kind !== 'image' || !fid) return;
    imgFailed = false;
    let url = null;
    let off = false;
    getBlob(fid).then((b) => { if (off || !b) return; url = URL.createObjectURL(b); imgUrl = url; }).catch(() => {});
    return () => { off = true; if (url) URL.revokeObjectURL(url); imgUrl = null; };
  });

  // Vorschaubild, wenn keine echte Vorschau möglich ist
  $effect(() => {
    const fid = doc?.fileId;
    const need = fid && (kind === 'none' || (kind === 'image' && imgFailed) || (kind === 'pdf' && pdfErr));
    if (!need) return;
    let url = null;
    let off = false;
    getThumb(fid).then((b) => { if (off || !b) return; url = URL.createObjectURL(b); thumbUrl = url; }).catch(() => {});
    return () => { off = true; if (url) URL.revokeObjectURL(url); thumbUrl = null; };
  });

  // ---- Herkunft & Aktionen ----
  const originsList = $derived(file?.origins ?? []);

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
  function outName() {
    let n = doc.displayName || file?.name || 'dokument';
    if (ext && !n.toLowerCase().endsWith('.' + ext)) n += '.' + ext;
    return n;
  }
  async function download() {
    try {
      const blob = await getBlob(doc.fileId);
      if (!blob) throw new Error('Original nicht gefunden');
      saveBlob(blob, outName());
    } catch (e) {
      toast(e.message, { tone: 'bad' });
    }
  }
  async function copyName() {
    try {
      await navigator.clipboard.writeText(doc.displayName || '');
      toast('Dateiname kopiert');
    } catch {
      toast('Kopieren nicht möglich', { tone: 'bad' });
    }
  }
  function openTx(t) {
    setView('transactions', { focus: t.id });
    onclose?.();
  }

  // ---- Fenster ----
  function close() { onclose?.(); }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (kind === 'pdf' && !/INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || '')) {
      if (e.key === 'ArrowRight') goPage(pageNo + 1);
      if (e.key === 'ArrowLeft') goPage(pageNo - 1);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if doc}
  <div class="back" role="presentation" onclick={close}></div>
  <div class="panel" role="dialog" aria-modal="true" aria-label={doc.title || doc.displayName}>
    <header class="phead">
      <div class="grow htext">
        <h2 class="ellipsis">{doc.title || doc.displayName || 'Dokument'}</h2>
        <div class="small muted ellipsis">{TYPE_LABELS[doc.type]?.name ?? 'Dokument'}{doc.issuer ? ' · ' + doc.issuer : ''}</div>
      </div>
      <button class="btn btn-ghost btn-icon" onclick={close} aria-label="Schließen"><Icon name="x" /></button>
    </header>

    <div class="pbody">
      <section class="preview" aria-label="Vorschau">
        {#if kind === 'pdf' && !pdfErr}
          <div class="pdfbar">
            <button class="btn btn-sm btn-ghost btn-icon" onclick={() => goPage(pageNo - 1)} disabled={pageNo <= 1} aria-label="Vorherige Seite">
              <span class="flip"><Icon name="chevron" size={16} /></span>
            </button>
            <span class="small num">{pageNo} / {pageCount || '–'}</span>
            <button class="btn btn-sm btn-ghost btn-icon" onclick={() => goPage(pageNo + 1)} disabled={pageNo >= pageCount} aria-label="Nächste Seite">
              <Icon name="chevron" size={16} />
            </button>
          </div>
          <div class="pdfwrap" bind:clientWidth={wrapW}>
            {#if loading && !pdf}<div class="skeleton ph"></div>{/if}
            <canvas bind:this={canvas} class:hidden={!pdf}></canvas>
          </div>
        {:else if kind === 'image' && !imgFailed}
          <div class="center-box">
            {#if imgUrl}<img class="fit" src={imgUrl} alt={doc.displayName || ''} onerror={() => (imgFailed = true)} />{:else}<div class="skeleton ph"></div>{/if}
          </div>
        {:else if kind === 'text'}
          <pre class="raw mono">{doc.text}</pre>
        {:else}
          <div class="center-box">
            {#if thumbUrl}<img class="fit" src={thumbUrl} alt="" />{:else}<div class="big-ic"><Icon name={typeIcon} size={56} /></div>{/if}
          </div>
        {/if}
        {#if pdfErr}<div class="small negc pverr">{pdfErr}</div>{/if}
      </section>

      <section class="meta">
        <div class="mbody">
          {#if (doc.needsReview && !doc.reviewed) || doc.typeSource === 'ai'}
            <div class="notice">
              {#if doc.needsReview && !doc.reviewed}<div class="small"><Icon name="alert" size={13} /> {docReason(doc)}</div>{/if}
              {#if doc.typeSource === 'ai'}<div class="small muted"><Icon name="sparkles" size={13} /> Typ von der KI{doc.aiReason ? ': ' + doc.aiReason : ''}</div>{/if}
              {#if isUnreadable(doc) || doc.alternatives?.length}<DocFix doc={doc} />{/if}
            </div>
          {/if}
          {#if totals || infoSections}
            <div class="small faint">
              {#if totals}Laut Auszug: {totals.sollCount ?? '?'} Soll-Buchungen{totals.sollSum != null ? ` (${centsText(totals.sollSum)} €)` : ''} · {totals.habenCount ?? '?'} Haben-Buchungen{totals.habenSum != null ? ` (${centsText(totals.habenSum)} €)` : ''}{/if}
              {#if totals && infoSections}<br />{/if}
              {#if infoSections}Nur zur Info, nicht als Buchungen gelesen: {infoSections.join(', ')}{/if}
            </div>
          {/if}
          {#if diag}
            <div class="diag">
              <div class="small diag-h"><Icon name="alert" size={13} /> Beim Einlesen hakt es</div>
              <ul class="small">
                {#each diag.problems as p (p)}<li>{p}</li>{/each}
              </ul>
              {#if diag.unparsed?.length}
                <div class="small muted">Nicht gelesene Zeilen:</div>
                <ul class="small mono">
                  {#each diag.unparsed as u, i (i)}<li>{u.page ? `S. ${u.page}: ` : ''}{u.text}</li>{/each}
                </ul>
              {/if}
              {#if !diag.bookings && diag.strayAmounts?.length}
                <div class="small muted">Beträge ohne Datum in derselben Zeile:</div>
                <ul class="small mono">
                  {#each diag.strayAmounts as u, i (i)}<li>{u.page ? `S. ${u.page}: ` : ''}{u.text}</li>{/each}
                </ul>
              {/if}
              {#if diag.sollHaben?.signFromKind}<div class="small faint">Vorzeichen bei {diag.sollHaben.signFromKind} Buchung{diag.sollHaben.signFromKind === 1 ? '' : 'en'} aus der Buchungsart abgeleitet (Spalte Soll/Haben im Scan nicht erkennbar)</div>{/if}
              <div class="small faint">{diag.pages} Seiten · {diag.dateLines} Zeilen mit Datum · {diag.bookings} Buchungen gelesen{diag.expectedCount != null ? ` von ${diag.expectedCount}` : ''} · Zahlenformat {diag.numberFormat === 'dot' ? '-75.00' : '-75,00'}</div>
            </div>
          {/if}
          <div class="fields">
            <label class="field wide"><span>Titel</span><input class="input" bind:value={form.title} /></label>
            <label class="field"><span>Typ</span>
              <select class="input" bind:value={form.type}>
                {#each TYPE_OPTIONS as [k, t] (k)}<option value={k}>{t.name}</option>{/each}
              </select>
            </label>
            <label class="field"><span>Datum</span><input class="input" type="date" bind:value={form.date} /></label>
            <label class="field"><span>Aussteller</span><input class="input" bind:value={form.issuer} /></label>
            <label class="field"><span>Betrag in €</span><input class="input num" inputmode="decimal" placeholder="0,00" bind:value={form.amount} aria-invalid={amountInvalid} /></label>
            <label class="field wide"><span>Schlagworte <Tip text="Mit Komma trennen" /></span><input class="input" bind:value={form.tags} placeholder="z. B. Büro, Reise" /></label>
          </div>

          <div class="taxrow">
            <Toggle checked={!!doc.taxRelevant} label="Steuerrelevant" onchange={setTax} />
            <Tip text={doc.aiTaxReason ? `KI: ${doc.aiTaxReason}` : 'Landet im Steuer-Export, geordnet nach Grund.'} />
            {#if doc.taxRelevant}
              <select class="input taxsel" value={doc.taxReason || 'sonstiges'} onchange={(e) => setTaxReason(e.currentTarget.value)} aria-label="Steuergrund">
                {#each TAX_REASONS as [v, l] (v)}<option value={v}>{l}</option>{/each}
              </select>
            {/if}
          </div>

          {#if payrollRows.length}
            <div class="block">
              <h4>Lohn <Tip text="Aus der Abrechnung erkannt" /></h4>
              <dl class="kv">
                {#each payrollRows as r (r.label)}
                  <dt>{r.label}</dt><dd><Money value={r.value} /></dd>
                {/each}
                {#if doc.payroll.period}<dt>Zeitraum</dt><dd>{doc.payroll.period}</dd>{/if}
              </dl>
            </div>
          {/if}

          {#if doc.vat?.length}
            <div class="block">
              <h4>Umsatzsteuer</h4>
              <table class="tbl small">
                <thead><tr><th>Satz</th><th class="r">Netto</th><th class="r">MwSt</th><th class="r">Brutto</th></tr></thead>
                <tbody>
                  {#each doc.vat as v (v.rate)}
                    <tr><td>{v.rate} %</td><td class="r"><Money value={v.net} /></td><td class="r"><Money value={v.tax} /></td><td class="r"><Money value={v.gross} /></td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          <div class="block">
            <h4 class="row">Verknüpfte Buchungen <span class="badge">{linked.length}</span></h4>
            {#if linked.length}
              <div class="links">
                {#each linked.slice(0, 20) as t (t.id)}
                  <button class="lrow" onclick={() => openTx(t)}>
                    <span class="num faint small">{fmtDate(t.bookingDate)}</span>
                    <span class="grow ellipsis">{t.counterparty || t.counterpartyRaw || '–'}</span>
                    <Money value={t.amount} sign color />
                  </button>
                {/each}
              </div>
              {#if linked.length > 20}<div class="small faint">+{linked.length - 20} weitere</div>{/if}
            {:else}
              <div class="small faint">Keine verknüpften Buchungen</div>
            {/if}
          </div>

          <Collapsible title="Erkannte Felder" badge={fieldRows.length || null}>
            {#if fieldRows.length}
              <dl class="kv">
                {#each fieldRows as [k, v] (k)}<dt>{k}</dt><dd class="wrapval">{v}</dd>{/each}
              </dl>
            {:else}
              <div class="small faint">Keine Felder erkannt</div>
            {/if}
          </Collapsible>

          <Collapsible title="Herkunft & Technik">
            <div class="prov">
              <div class="row between">
                <span class="mono ellipsis fname" title={doc.displayName}>{doc.displayName || '–'}</span>
                <button class="btn btn-sm btn-ghost btn-icon" onclick={copyName} aria-label="Dateinamen kopieren" title="Kopieren"><Icon name="copy" size={14} /></button>
              </div>
              <dl class="kv">
                <dt>Fundorte</dt>
                <dd>
                  {#each originsList as o (o.sourceId + o.path)}
                    <div class="origin"><strong>{o.sourceName}</strong><span class="faint mono">{o.path}</span></div>
                  {:else}
                    <span class="faint">–</span>
                  {/each}
                </dd>
                <dt>Importiert</dt><dd>{fmtDate(file?.importedAt?.slice(0, 10))}</dd>
                <dt>SHA-256 <Tip text="Inhalts-Fingerabdruck; gleiche Datei = gleicher Wert" /></dt>
                <dd class="mono" title={doc.fileId}>{doc.fileId ? doc.fileId.slice(0, 16) + '…' : '–'}</dd>
              </dl>
            </div>
          </Collapsible>
        </div>

        <footer class="actions">
          <button class="btn btn-primary" onclick={save} disabled={!dirty || amountInvalid}>Speichern</button>
          {#if !doc.reviewed || doc.needsReview}
            <button class="btn" onclick={markReviewed} disabled={amountInvalid}><Icon name="check" size={16} />Als geprüft markieren</button>
          {:else}
            <span class="badge good"><Icon name="check" size={12} />Geprüft</span>
          {/if}
          <span class="grow"></span>
          <button class="btn btn-ghost" onclick={download}><Icon name="download" size={16} />Original</button>
        </footer>
      </section>
    </div>
  </div>
{/if}

<style>
  .notice { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--warn-soft); }
  .notice :global(svg) { vertical-align: -2px; }
  .back { position: fixed; inset: 0; background: rgba(8, 10, 18, .42); backdrop-filter: blur(2px); z-index: 90; animation: fade .2s ease both; }
  .panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(1080px, 100vw); display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); z-index: 91; animation: slide .26s cubic-bezier(.2, .7, .2, 1) both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slide { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }

  .phead { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px 18px; border-bottom: 1px solid var(--border); min-width: 0; }
  .htext { min-width: 0; }
  .htext h2 { font-size: 16px; }

  .pbody { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); }
  .preview { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface-2); border-right: 1px solid var(--border); }
  .pdfbar { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .flip { display: inline-flex; transform: rotate(180deg); }
  .pdfwrap { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  .pdfwrap canvas { display: block; width: 100%; height: auto; background: #fff; border-radius: 6px; box-shadow: var(--shadow); }
  .ph { width: 70%; aspect-ratio: 1 / 1.4; margin: 24px auto; }
  .center-box { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 16px; }
  .fit { max-width: 100%; max-height: 100%; height: auto; border-radius: 8px; box-shadow: var(--shadow); background: var(--surface); }
  .big-ic { width: 110px; height: 110px; border-radius: 28px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .raw { flex: 1; min-height: 0; margin: 0; padding: 14px 16px; overflow: auto; white-space: pre; font-size: 12px; line-height: 1.5; background: var(--surface); color: var(--text-2); tab-size: 2; }
  .pverr { padding: 8px 12px; }

  .meta { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .mbody { flex: 1; min-height: 0; overflow: auto; padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 16px; }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface); }

  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .fields .wide { grid-column: 1 / -1; }
  .fields .field > span { display: inline-flex; align-items: center; gap: 4px; }
  .fields input[aria-invalid="true"] { border-color: var(--bad); }

  .taxrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .taxsel { height: 30px; font-size: 13px; margin-left: auto; max-width: 100%; }

  .block h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 13px; align-items: baseline; }
  .kv dt { color: var(--text-2); display: flex; align-items: center; gap: 4px; }
  .kv dd { margin: 0; min-width: 0; }
  .wrapval { overflow-wrap: anywhere; }
  .tbl td, .tbl th { padding: 6px 8px; }

  .links { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .lrow { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface); cursor: pointer; text-align: left; color: var(--text); transition: background .12s; }
  .lrow:last-child { border-bottom: 0; }
  .lrow:hover { background: var(--surface-2); }

  .prov { display: flex; flex-direction: column; gap: 10px; }
  .fname { font-size: 12px; min-width: 0; flex: 1; }
  .origin { display: flex; flex-direction: column; gap: 1px; margin-bottom: 6px; min-width: 0; overflow-wrap: anywhere; }
  .origin .mono { font-size: 11px; }

  .actions .grow { flex: 1; }
  .badge.good { background: var(--good-soft); color: var(--good); }
  .badge.good :global(svg) { margin-right: 2px; }

  @media (max-width: 860px) {
    .pbody { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
    .preview { border-right: 0; border-bottom: 1px solid var(--border); max-height: 48vh; min-height: 220px; }
    .meta { min-height: auto; }
    .mbody { overflow: visible; }
    .actions { position: sticky; bottom: 0; }
  }
  @media (max-width: 520px) {
    .fields { grid-template-columns: minmax(0, 1fr); }
    .kv { grid-template-columns: minmax(0, 1fr); }
    .kv dt { margin-top: 4px; }
    .taxsel { margin-left: 0; }
  }
  .diag { border: 1px solid var(--warn); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 12px; display: grid; gap: 6px; }
  .diag-h { color: var(--warn); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .diag ul { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
  .diag .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
</style>
