<script>
  import { onMount } from 'svelte';
  import { app, saveSettings, reload, resetAll, deleteRecord, getBlob, toast, applyRule } from '../store/state.svelte.js';
  import { postProcess } from '../store/postprocess.js';
  import { db, loadAll, TABLES } from '../store/db.js';
  import { CATEGORIES, categoryLabel } from '../classify/categories.js';
  import { ruleHits } from '../classify/rules.js';
  import { uid } from '../util/format.js';
  import * as zip from '../export/zip.js';
  import AiSettings from '../ai/AiSettings.svelte';
  import Seg from '../ui/Seg.svelte';
  import Icon from '../ui/Icon.svelte';
  import Tip from '../ui/Tip.svelte';
  import Modal from '../ui/Modal.svelte';
  import Collapsible from '../ui/Collapsible.svelte';

  const THEMES = [
    { value: 'auto', label: 'System' },
    { value: 'light', label: 'Hell' },
    { value: 'dark', label: 'Dunkel' },
  ];
  const WIPE_WORD = 'LÖSCHEN';
  const hasArchive = typeof zip.buildArchiveZip === 'function';
  const redirectUri = typeof location !== 'undefined' ? location.origin + location.pathname.replace(/index\.html$/, '') + 'oauth.html' : '';

  // ---- Helfer ----
  const today = () => new Date().toISOString().slice(0, 10);
  const snap = (x) => $state.snapshot(x);
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
  function fmtBytes(n) {
    if (!n) return '0 MB';
    return n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.round(n / 1e6) + ' MB';
  }

  let busy = $state(false);
  async function run(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      toast(e?.message || 'Vorgang fehlgeschlagen', { tone: 'bad' });
    } finally {
      busy = false;
    }
  }

  // ---- Darstellung ----
  // Seg schreibt direkt in app.settings.theme; gespeichert wird nur bei tatsächlicher Änderung.
  let lastTheme = app.settings.theme;
  $effect(() => {
    const t = app.settings.theme;
    if (t !== lastTheme) {
      lastTheme = t;
      saveSettings();
    }
  });

  // ---- Kategorien & Regeln ----
  const rules = $derived(app.data.rules || []);

  const FIELD_LABEL = { text: 'Text', counterparty: 'Gegenpartei', purpose: 'Zweck', iban: 'IBAN', creditorId: 'Gläubiger-ID' };
  function ruleMatch(r) {
    const m = r.match;
    if (typeof m === 'string' && m) return m;
    if (m?.value && (m.op || 'contains') !== 'regex') return `${FIELD_LABEL[m.field] || 'Text'} ${m.op === 'equals' ? 'ist' : 'enthält'} „${m.value}“`;
    if (m && typeof m === 'object') {
      const s = Object.entries(m)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' | ') : v}`)
        .join(' · ');
      if (s) return s;
    }
    return r.label || r.id || '–';
  }
  function ruleTarget(r) {
    const s = r.set || {};
    return categoryLabel(s.category ?? r.category, s.subcategory ?? r.subcategory ?? null);
  }
  async function removeRule(r) {
    if (!confirm(`Regel „${ruleMatch(r)}“ löschen?`)) return;
    try {
      await deleteRecord('rules', r.id);
      toast('Regel gelöscht');
    } catch (e) {
      toast(e?.message || 'Löschen fehlgeschlagen', { tone: 'bad' });
    }
  }
  const rebuild = () =>
    run(async () => {
      await postProcess();
      await reload();
      toast('Regeln neu angewendet', { tone: 'good' });
    });

  // Neue Regel „Text enthält … → Kategorie“ (Gegenpartei, Zweck und Buchungstext zugleich); greift vor allen eingebauten Regeln
  let newText = $state('');
  let newTarget = $state('');
  const draftRule = $derived(newText.trim() ? { match: { field: 'text', op: 'contains', value: newText.trim() } } : null);
  const draftHits = $derived(draftRule ? ruleHits(draftRule, app.data.transactions).length : 0);
  const draftReady = $derived(!!draftRule && !!newTarget && !busy);
  const addRule = () =>
    run(async () => {
      if (!draftRule || !newTarget) return;
      const [category, subcategory] = newTarget.split('.');
      const rule = { id: uid('rule_'), match: { ...draftRule.match }, set: { category, subcategory: subcategory || null }, createdAt: new Date().toISOString() };
      const n = await applyRule(rule);
      newText = '';
      newTarget = '';
      toast(`Regel angelegt · ${n} ${n === 1 ? 'Buchung' : 'Buchungen'}`, { tone: 'good' });
    });

  // ---- Alle Dateien neu einlesen ----
  let reprocessOpen = $state(false);
  async function reprocessAll() {
    reprocessOpen = false;
    await run(async () => {
      let fn = null;
      try {
        fn = (await import('../store/importer.js'))?.reprocessAll;
      } catch (e) {
        console.warn(e);
      }
      if (typeof fn !== 'function') {
        toast('Neu einlesen ist noch nicht verfügbar');
        return;
      }
      const res = (await fn()) || {};
      await reload();
      const done = res.done ?? 0;
      const failed = res.failed ?? 0;
      toast(`${done} ${done === 1 ? 'Datei' : 'Dateien'} neu eingelesen${failed ? ` · ${failed} fehlgeschlagen` : ''}`, { tone: failed ? 'bad' : 'good', ms: 6000 });
    });
  }

  // ---- Cloud-Zugänge ----
  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(redirectUri);
      toast('Kopiert', { tone: 'good' });
    } catch {
      toast('Kopieren nicht möglich', { tone: 'bad' });
    }
  }

  // ---- Speicherplatz ----
  let storage = $state(null);
  let persisted = $state(null);
  const storageText = $derived(storage ? `${fmtBytes(storage.usage)} von ${fmtBytes(storage.quota)}` : '–');
  const storagePct = $derived(storage?.quota ? Math.min(100, (storage.usage / storage.quota) * 100) : 0);

  async function refreshStorage() {
    try {
      if (navigator.storage?.estimate) {
        const e = await navigator.storage.estimate();
        storage = { usage: e.usage || 0, quota: e.quota || 0 };
      }
      if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    } catch {
      /* Speicherschätzung im Browser nicht verfügbar */
    }
  }
  async function persist() {
    try {
      const ok = await navigator.storage.persist();
      persisted = ok;
      toast(ok ? 'Speicher ist dauerhaft' : 'Browser hat die Anfrage abgelehnt', { tone: ok ? 'good' : 'info' });
    } catch {
      toast('Nicht unterstützt', { tone: 'bad' });
    }
  }

  // ---- Export & Backup ----
  function exportCsv() {
    let csv = zip.buildCsvExport(snap(app.data.transactions), snap(app.data.accounts));
    if (!csv.startsWith('﻿')) csv = '﻿' + csv;
    save(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `buchungen_${today()}.csv`);
    toast(`${app.data.transactions.length} Buchungen exportiert`, { tone: 'good' });
  }

  const exportArchive = () =>
    run(async () => {
      const blob = await zip.buildArchiveZip({
        documents: snap(app.data.documents),
        files: snap(app.data.files),
        transactions: snap(app.data.transactions),
        accounts: snap(app.data.accounts),
        getBlob,
      });
      save(blob, `FinanzRadar_Archiv_${today()}.zip`);
    });

  const exportBackup = () =>
    run(async () => {
      const tables = await loadAll();
      // Dateihandles lassen sich nicht serialisieren; Quellen bleiben ohne Handle erhalten.
      if (tables.sources) tables.sources = tables.sources.map((s) => (s.config?.handle ? { ...s, config: { ...s.config, handle: undefined } } : s));
      const payload = { app: 'FinanzRadar', version: 1, exportedAt: new Date().toISOString(), settings: snap(app.settings), tables };
      save(new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'finanzradar-backup.json');
    });

  let importInput = $state(null);
  async function onImport(e) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!confirm(`Backup „${file.name}“ einspielen? Gleiche Einträge werden überschrieben.`)) return;
    await run(async () => {
      const data = JSON.parse(await file.text());
      if (!data?.tables || typeof data.tables !== 'object') throw new Error('Kein FinanzRadar-Backup');
      const tables = TABLES.filter((t) => Array.isArray(data.tables[t]));
      if (!tables.length) throw new Error('Backup enthält keine Daten');
      let n = 0;
      await db.transaction('rw', tables.map((t) => db[t]), async () => {
        for (const t of tables) {
          await db[t].bulkPut(data.tables[t]);
          n += data.tables[t].length;
        }
      });
      if (data.settings && typeof data.settings === 'object') {
        Object.assign(app.settings, data.settings, { ai: { ...app.settings.ai, ...(data.settings.ai || {}) } });
        await saveSettings();
      }
      await reload();
      await refreshStorage();
      toast(`Backup eingespielt (${n} Einträge)`, { tone: 'good' });
    });
  }

  // ---- Alle Daten löschen ----
  let wipeOpen = $state(false);
  let wipeText = $state('');
  const wipeReady = $derived(wipeText.trim() === WIPE_WORD);
  async function wipe() {
    if (!wipeReady) return;
    wipeOpen = false;
    wipeText = '';
    await run(async () => {
      await resetAll();
      await refreshStorage();
      toast('Alle Daten gelöscht');
    });
  }

  onMount(refreshStorage);
</script>

<div class="stack page">
  <section class="card">
    <div class="card-head"><h3>Darstellung</h3></div>
    <Seg bind:value={app.settings.theme} options={THEMES} />
  </section>

  <section class="card">
    <div class="card-head"><h3>Lokale KI</h3></div>
    <AiSettings />
  </section>

  <section class="card">
    <div class="card-head">
      <h3>Kategorien & Regeln</h3>
      <button class="btn btn-sm" onclick={rebuild} disabled={busy}><Icon name="refresh" size={14} />Neu anwenden</button>
    </div>
    <div class="stack tight">
      <div class="newrule">
        <span class="small muted row">Wenn Text enthält<Tip text="Durchsucht Gegenpartei, Verwendungszweck und Buchungstext (ab Wortanfang). Eigene Regeln gehen allen eingebauten Regeln und Händlern vor; manuell gesetzte Kategorien bleiben." /></span>
        <input class="input" bind:value={newText} placeholder="z. B. Hansa Wohnbau" aria-label="Suchtext der Regel" autocomplete="off" spellcheck="false" />
        <span class="small muted">→</span>
        <select class="input" bind:value={newTarget} aria-label="Zielkategorie">
          <option value="" disabled>Kategorie …</option>
          {#each CATEGORIES as c (c.id)}
            <optgroup label={c.label}>
              <option value={c.id}>{c.label}</option>
              {#each c.subs || [] as s (s.id)}
                <option value={`${c.id}.${s.id}`}>{c.label} › {s.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <span class="small faint num" title="Buchungen, die die Regel heute trifft">{draftRule ? `${draftHits} Treffer` : ''}</span>
        <button class="btn btn-sm" onclick={addRule} disabled={!draftReady}><Icon name="check" size={14} />Anlegen</button>
      </div>
      <Collapsible title="Regeln" badge={rules.length}>
        {#if rules.length}
          <ul class="plain">
            {#each rules as r (r.id)}
              <li class="rrow">
                <span class="ellipsis grow"><strong>{ruleMatch(r)}</strong> <span class="faint">→</span> {ruleTarget(r)}</span>
                <button class="btn btn-sm btn-icon btn-ghost" title="Löschen" aria-label="Regel löschen" onclick={() => removeRule(r)}><Icon name="trash" size={14} /></button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted small">Keine Regeln</p>
        {/if}
      </Collapsible>

      <Collapsible title="Kategorien" badge={CATEGORIES.length}>
        <div class="chips">
          {#each CATEGORIES as c (c.id)}
            <span class="chip" title={(c.subs || []).map((s) => s.label).join(', ')}>
              <span class="dot" style="background:{c.color}"></span>{c.label}
            </span>
          {/each}
        </div>
      </Collapsible>
    </div>
  </section>

  <section class="card">
    <div class="card-head">
      <h3>Cloud-Zugänge</h3>
      <Tip text="Eigene App-Keys aus Dropbox bzw. Google Cloud. Die Weiterleitungs-URI dort eintragen." />
    </div>
    <div class="grid g2">
      <label class="field">
        <span>Dropbox App-Key</span>
        <input class="input" bind:value={app.settings.dropboxAppKey} onchange={() => saveSettings()} autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>Google Client-ID</span>
        <input class="input" bind:value={app.settings.gdriveClientId} onchange={() => saveSettings()} autocomplete="off" spellcheck="false" />
      </label>
    </div>
    <label class="field redirect">
      <span>Weiterleitungs-URI</span>
      <div class="row">
        <input class="input mono grow" readonly value={redirectUri} aria-label="Weiterleitungs-URI" />
        <button class="btn btn-icon" onclick={copyRedirect} title="Kopieren" aria-label="URI kopieren"><Icon name="copy" size={16} /></button>
      </div>
    </label>
  </section>

  <section class="card">
    <div class="card-head"><h3>Daten</h3></div>
    <div class="row between wrap storage">
      <div class="stor">
        <div class="row small muted">Speicherplatz<Tip text="Im Browser belegter Speicher für Buchungen und Dokumente." /></div>
        <div class="num">{storageText}</div>
        <div class="meter" role="meter" aria-label="Speicherplatz" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(storagePct)}>
          <span style="width:{storagePct}%"></span>
        </div>
      </div>
      <div class="row wrap">
        {#if persisted === true}
          <span class="badge good">dauerhaft</span>
        {:else if persisted === false}
          <button class="btn btn-sm" onclick={persist}><Icon name="check" size={14} />Dauerhaft speichern</button>
        {/if}
      </div>
    </div>

    <div class="sep"></div>

    <Collapsible title="Export & Backup">
      <ul class="plain">
        <li class="arow">
          <div class="grow"><strong>Buchungen</strong><div class="small faint">CSV</div></div>
          <button class="btn btn-sm" onclick={exportCsv} disabled={!app.data.transactions.length}><Icon name="download" size={14} />CSV</button>
        </li>
        {#if hasArchive}
          <li class="arow">
            <div class="grow"><strong>Dokumentarchiv</strong><div class="small faint">ZIP</div></div>
            <button class="btn btn-sm" onclick={exportArchive} disabled={busy || !app.data.documents.length}><Icon name="download" size={14} />ZIP</button>
          </li>
        {/if}
        <li class="arow">
          <div class="grow">
            <strong class="row">Backup<Tip text="Enthält Tabellen und Einstellungen, aber keine Originaldateien." /></strong>
            <div class="small faint">JSON</div>
          </div>
          <button class="btn btn-sm" onclick={exportBackup} disabled={busy}><Icon name="download" size={14} />JSON</button>
          <button class="btn btn-sm" onclick={() => importInput?.click()} disabled={busy}><Icon name="upload" size={14} />Einspielen</button>
          <input type="file" accept=".json,application/json" class="hidden" bind:this={importInput} onchange={onImport} aria-label="Backup-Datei wählen" />
        </li>
      </ul>
    </Collapsible>

    <div class="sep"></div>

    <Collapsible title="Wartung">
      <div class="row between wrap">
        <span class="small muted row">Alle Dateien neu einlesen<Tip text="Liest alle gespeicherten Dateien mit der aktuellen Erkennung neu ein. Manuelle Korrekturen bleiben erhalten." /></span>
        <button class="btn btn-sm" onclick={() => (reprocessOpen = true)} disabled={busy || app.progress.running}><Icon name="refresh" size={14} />Alle Dateien neu einlesen</button>
      </div>
    </Collapsible>

    <div class="sep"></div>

    <Collapsible title="Gefahrenbereich">
      <div class="row between wrap">
        <span class="small muted">Alle Daten in diesem Browser entfernen</span>
        <button class="btn btn-danger" onclick={() => (wipeOpen = true)}><Icon name="trash" size={14} />Alle Daten löschen</button>
      </div>
    </Collapsible>
  </section>

  <section class="card">
    <div class="card-head"><h3>Über</h3></div>
    <div class="row between wrap">
      <span><strong>FinanzRadar</strong> <span class="muted small">Version 1.0</span></span>
      <span class="row small muted">Alles läuft lokal<Tip text="Keine Server, kein Upload. Daten bleiben in diesem Browserprofil." /></span>
    </div>
  </section>
</div>

<Modal bind:open={reprocessOpen} title="Alle Dateien neu einlesen" width={460}>
  <p class="small muted">Alle {app.data.files?.length || 0} gespeicherten Dateien werden erneut verarbeitet. Das kann einige Minuten dauern.</p>
  {#snippet footer()}
    <button class="btn" onclick={() => (reprocessOpen = false)}>Abbrechen</button>
    <button class="btn btn-primary" onclick={reprocessAll} disabled={busy}><Icon name="refresh" size={14} />Neu einlesen</button>
  {/snippet}
</Modal>

<Modal bind:open={wipeOpen} title="Alle Daten löschen" width={460}>
  <div class="stack tight">
    <p class="small muted">Buchungen, Dokumente und Einstellungen in diesem Browser werden entfernt.</p>
    <label class="field">
      <span>Zur Bestätigung „{WIPE_WORD}“ eingeben</span>
      <input class="input" bind:value={wipeText} autocomplete="off" aria-label="Bestätigungswort" />
    </label>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => { wipeOpen = false; wipeText = ''; }}>Abbrechen</button>
    <button class="btn solid-danger" onclick={wipe} disabled={!wipeReady || busy}><Icon name="trash" size={14} />Endgültig löschen</button>
  {/snippet}
</Modal>

<style>
  .page { max-width: 880px; }
  .plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .rrow, .arow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); }
  .rrow:last-child, .arow:last-child { border-bottom: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chips .chip { cursor: default; }
  .redirect { margin-top: 14px; }
  .stor { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .meter { height: 6px; width: min(280px, 100%); border-radius: 6px; background: var(--surface-3); overflow: hidden; margin-top: 4px; }
  .meter span { display: block; height: 100%; background: var(--accent); border-radius: 6px; transition: width .3s ease; }
  .solid-danger { background: var(--bad); border-color: var(--bad); color: #fff; }
  .solid-danger:hover { filter: brightness(1.08); background: var(--bad); }
  .storage { row-gap: 10px; }
  .newrule { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-bottom: 6px; }
  .newrule .input { flex: 1 1 180px; min-width: 0; }
</style>
