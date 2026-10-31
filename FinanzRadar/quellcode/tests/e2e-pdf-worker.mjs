// PDF-Leser (pdf.js-Worker) im Browser: viele PDFs am Stück, gemeinsamer Worker, Absturz/Startfehler wie in Firefox,
// erzwungener Rückfall im Hauptthread, nicht ladbarer Leser (Klartext-Fehler) und „Neu einlesen“ danach.
// Aufruf: APP=http://localhost:8765/ DATA=<Ordner mit ≥30 Text-PDFs> [SCANS=<Ordner mit Scan-PDFs>] [SILENT=1] [ONLY=2,6] [VERBOSE=1] \
//         LC_ALL=C.UTF-8 node tests/e2e-pdf-worker.mjs
// App bauen: npx vite build --outDir /tmp/fr-app && FINANZRADAR_APP_DIR=/tmp/fr-app python3 ../server.py 8765
// Firefox ist hier nicht installiert – sein Fehlerbild wird in Chromium nachgestellt: Web-Worker, die beim Start ein
// error-Event liefern, deren Konstruktor wirft oder die mitten im Lesen abstürzen.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:8765/';
const DATA = process.env.DATA || '/tmp/fr-pdf';
const SCANS = process.env.SCANS || '';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean).map(Number); // z. B. ONLY=2,6
const want = (n) => !ONLY.length || ONLY.includes(n);
const fail = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail.push(msg); };
const countPdfs = (dir) => fs.readdirSync(dir, { recursive: true }).filter(f => /\.pdf$/i.test(String(f))).length;
const browser = await chromium.launch();

/**
 * Worker-Simulation (läuft vor dem App-Code). Nur pdf.js-Worker (URL enthält „pdf-worker“) sind betroffen.
 * failCreate: Nummern der Worker-Starts, die mit error-Event scheitern (Skript wirft beim Laden – wie Firefox)
 * throwCreate: Nummern der Starts, bei denen schon der Konstruktor wirft; throwAll: jeder Start wirft
 * crashAtDoc: nach der n-ten geöffneten PDF stürzt der laufende Worker ab (terminate + error-Event)
 * silentAtDoc: wie crashAtDoc, aber ohne error-Event (nur Zeitlimit hilft)
 */
function simulate(cfg) {
  const Real = window.Worker;
  const st = window.__pdfSim = { created: 0, startFailed: 0, thrown: 0, crashed: 0, docs: 0, live: new Set() };
  const has = (list, n) => (list || []).includes(n);
  window.Worker = class extends Real {
    constructor(url, opts) {
      const isPdf = /pdf-worker/.test(String(url));
      let n = 0;
      if (isPdf) {
        n = ++st.created;
        if (cfg.throwAll || has(cfg.throwCreate, n)) { st.thrown++; throw new DOMException('simulierter Worker-Fehler', 'SecurityError'); }
        if (has(cfg.failCreate, n)) {
          st.startFailed++;
          url = URL.createObjectURL(new Blob(['throw new Error("simulierter Startfehler")'], { type: 'text/javascript' }));
        }
      }
      super(url, opts);
      if (!isPdf) return;
      st.live.add(this);
      const realPost = this.postMessage.bind(this);
      this.postMessage = (msg, transfer) => {
        if (msg?.action === 'GetDocRequest') {
          const k = ++st.docs;
          if (cfg.verbose) console.log('PDF-SIM GetDoc', k, Math.round(performance.now()));
          const loud = has(cfg.crashAtDoc, k), silent = has(cfg.silentAtDoc, k);
          if (loud || silent) {
            setTimeout(() => {
              st.crashed++;
              this.terminate();
              if (loud) this.dispatchEvent(new ErrorEvent('error', { message: 'simulierter Absturz (out of memory)' }));
            }, 15);
          }
        }
        return realPost(msg, transfer);
      };
      const realTerm = this.terminate.bind(this);
      this.terminate = () => { st.live.delete(this); return realTerm(); };
    }
  };
}

const open = async (cfg = null) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
  const page = await ctx.newPage();
  const logs = [];
  page.on('pageerror', e => fail.push('pageerror: ' + e.message));
  const t0 = Date.now();
  page.on('console', m => { if (/PDF-|fake worker/i.test(m.text())) logs.push(m.text()); if (process.env.VERBOSE) console.log('     [page]', ((Date.now() - t0) / 1000).toFixed(1), m.text().slice(0, 160)); });
  await page.addInitScript(() => { delete window.showDirectoryPicker; }); // erzwingt den <input webkitdirectory>-Pfad
  if (cfg) await page.addInitScript(simulate, { ...cfg, verbose: !!process.env.VERBOSE });
  await page.goto(APP);
  await page.waitForSelector('text=Mit Beispieldaten ausprobieren');
  await page.click('aside button:has-text("Quellen")');
  page.__logs = logs;
  return page;
};
const dbFiles = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('finanzradar');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction(['files'], 'readonly');
    tx.objectStore('files').getAll().onsuccess = (e) => { res(e.target.result.map(f => ({ name: f.name, status: f.status, error: f.error || null }))); };
    tx.oncomplete = () => db.close();
  };
}));
const summary = (files) => files.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m; }, {});
const sim = (page) => page.evaluate(() => { const s = window.__pdfSim; return s ? { ...s, live: s.live.size } : null; });
const importDir = async (page, dir) => {
  const t = Date.now();
  await page.setInputFiles('input[webkitdirectory]', dir);
  await page.waitForSelector('.pb', { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('.card.done', { timeout: 1_200_000 });
  return (Date.now() - t) / 1000;
};
const pdfOk = (files, n, label) => {
  const s = summary(files);
  const read = (s.done || 0) + (s.ignored || 0);
  check(read === n && !s.error && !s.processing, `${label}: alle ${n} PDFs gelesen (${JSON.stringify(s)})`);
  for (const f of files.filter(x => x.status === 'error').slice(0, 5)) console.log('     ', f.name, '→', f.error);
  return s;
};

const nData = countPdfs(DATA);
check(nData >= 30, `Testdaten: ${nData} PDFs in ${DATA}`);

// 1. Normalbetrieb: ein gemeinsamer Worker für alle PDFs, nach dem Import wieder freigegeben; Vorschau nutzt ihn ebenfalls
if (want(1)) {
  const page = await open({});
  const secs = await importDir(page, DATA);
  pdfOk(await dbFiles(page), nData, `Normal (${secs} s)`);
  const s = await sim(page);
  check(s.created === 1, `ein gemeinsamer pdf.js-Worker für ${nData} PDFs (gestartet: ${s.created}, geöffnet: ${s.docs})`);
  check(page.workers().length === 0 && s.live === 0, `nach dem Import kein Worker mehr aktiv (${page.workers().length})`);
  // Vorschau (DocViewer) öffnet über denselben Weg; Schließen gibt das Dokument frei
  await page.click('aside button:has-text("Dokumente")');
  await page.locator('.dcard, tr.clickable').first().click();
  await page.waitForFunction(() => { const c = document.querySelector('.pdfwrap canvas'); return c && !c.classList.contains('hidden') && c.width > 0; }, null, { timeout: 30000 })
    .then(() => check(true, 'Vorschau rendert die PDF'), () => check(false, 'Vorschau rendert die PDF'));
  check(!(await page.$('.pverr')), 'Vorschau ohne Fehler');
  await page.context().close();
}

// 2. Firefox-Fehlerbild: Abstürze mitten im Lesen + gescheiterte Neustarts → neuer Worker bzw. Rückfall im Hauptthread
if (want(2)) {
  const page = await open({ crashAtDoc: [5, 14, 23], failCreate: [3], throwCreate: [4, 5] });
  const secs = await importDir(page, DATA);
  pdfOk(await dbFiles(page), nData, `Abstürze + Startfehler (${secs} s)`);
  const s = await sim(page);
  check(s.crashed >= 2 && s.startFailed >= 1, `Ausfälle wirklich ausgelöst (Abstürze ${s.crashed}, Startfehler ${s.startFailed}, Konstruktor-Fehler ${s.thrown}, Starts ${s.created})`);
  check(!page.__logs.some(l => /fake worker failed/i.test(l)), 'kein „Setting up fake worker failed“');
  await page.context().close();
}

// 3. Erzwungener Rückfall: kein pdf.js-Web-Worker startbar → alles im Hauptthread lesen
if (want(3)) {
  const page = await open({ throwAll: true });
  const secs = await importDir(page, DATA);
  pdfOk(await dbFiles(page), nData, `nur Hauptthread (${secs} s)`);
  const s = await sim(page);
  check(s.thrown >= 2 && s.live === 0, `Web-Worker nie gestartet (Versuche ${s.thrown})`);
  await page.context().close();
}

// 4. Leser gar nicht ladbar (Netzwerk) → Klartext-Fehler; danach „Alle Dateien neu einlesen“ holt alles nach
if (want(4)) {
  const page = await open({});
  const subset = fs.mkdtempSync(path.join(path.dirname(DATA), 'pdf-subset-'));
  for (const f of fs.readdirSync(DATA, { recursive: true }).filter(x => /\.pdf$/i.test(String(x))).slice(0, 6)) fs.copyFileSync(path.join(DATA, f), path.join(subset, path.basename(f)));
  await page.route(/pdf-worker-[^/]*\.js/, async (route) => {
    const res = await route.fetch();
    if ((await res.body()).length > 100_000) await route.abort('failed'); else await route.fulfill({ response: res });
  });
  await importDir(page, subset);
  const files = await dbFiles(page);
  const errs = files.filter(f => f.status === 'error');
  check(errs.length === files.length && errs.every(f => /^PDF konnte nicht gelesen werden \(PDF-Leser abgestürzt\)/.test(f.error)),
    `Klartext-Fehler bei nicht ladbarem Leser (${errs.length}/${files.length}): ${errs[0]?.error}`);
  await page.unroute(/pdf-worker-[^/]*\.js/);
  await page.click('aside button:has-text("Einstellungen")');
  await page.click('summary:has-text("Wartung")');
  await page.click('button:has-text("Alle Dateien neu einlesen")');
  await page.click('.modal button:has-text("Neu einlesen"), [role=dialog] button:has-text("Neu einlesen")');
  for (let t = Date.now(); Date.now() - t < 300000;) { // warten, bis alle Dateien neu gelesen sind
    await page.waitForTimeout(1000);
    const st = summary(await dbFiles(page));
    if (!st.error && !st.processing) break;
  }
  pdfOk(await dbFiles(page), files.length, 'Neu einlesen nach Leser-Ausfall');
  fs.rmSync(subset, { recursive: true, force: true });
  await page.context().close();
}

// 5. Stiller Absturz (kein error-Event): nur Zeitlimits retten den Import – dauert ~1–2 min, daher optional
if (process.env.SILENT && want(5)) {
  const page = await open({ silentAtDoc: [4] });
  const secs = await importDir(page, DATA);
  pdfOk(await dbFiles(page), nData, `stiller Absturz (${secs} s)`);
  await page.context().close();
}

// 6. Scans mit OCR (langsam) + ein Absturz mitten im Rendern
if (SCANS && want(6)) {
  const n = countPdfs(SCANS);
  const page = await open({ crashAtDoc: [3] });
  const secs = await importDir(page, SCANS);
  pdfOk(await dbFiles(page), n, `Scans mit OCR + Absturz (${secs} s)`);
  const s = await sim(page);
  check(s.crashed === 1, `Absturz beim Scan ausgelöst (${s.crashed}, Starts ${s.created})`);
  await page.context().close();
}

await browser.close();
console.log(fail.length ? '\nFEHLER:\n' + fail.join('\n') : '\nALLES OK');
process.exit(fail.length ? 1 : 0);
