// Import-Robustheit im Browser: Pause/Weiter/Abbrechen, Dubletten, defekte Dateien, schneller Neuimport, Worker-Leck
// Aufruf: APP=http://localhost:8765/ DATA=/tmp/fr-big LC_ALL=C.UTF-8 node tests/e2e-import.mjs
// Datensatz erzeugen: python3 scripts/gen-big-dataset.py /tmp/fr-big
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:8765/';
const DATA = process.env.DATA || '/tmp/fr-big';
const fail = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fail.push(msg); };
const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' })).newPage();
  page.on('pageerror', e => fail.push('pageerror: ' + e.message));
  await page.addInitScript(() => { delete window.showDirectoryPicker; }); // erzwingt den <input webkitdirectory>-Pfad
  await page.goto(APP);
  await page.waitForSelector('text=Mit Beispieldaten ausprobieren');
  await page.click('aside button:has-text("Quellen")');
  return page;
};
const dbState = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('finanzradar');
  r.onsuccess = () => {
    const db = r.result, out = { status: {}, docs: 0, origins: {}, workers: 0 };
    const tx = db.transaction(['files', 'documents'], 'readonly');
    tx.objectStore('files').getAll().onsuccess = (e) => { for (const f of e.target.result) { out.status[f.status] = (out.status[f.status] || 0) + 1; out.origins[f.name] = (f.origins || []).length; } };
    tx.objectStore('documents').count().onsuccess = (e) => { out.docs = e.target.result; };
    tx.oncomplete = () => { db.close(); res(out); };
  };
}));
const done = (page) => page.waitForSelector('.card.done', { timeout: 600000 });
const pick = async (page, dir) => { await page.setInputFiles('input[webkitdirectory]', dir); await page.waitForSelector('.pb', { timeout: 30000 }).catch(() => {}); };
const prog = (page) => page.$eval('.pb .num', e => e.innerText).catch(() => null);

// 1. Pause / Weiter / Abbrechen / erneut
{
  const page = await open();
  await pick(page, `${DATA}/Belege`);
  await page.waitForFunction(() => /^\s*([5-9]|\d\d+) \//.test(document.querySelector('.pb .num')?.innerText || ''), null, { timeout: 60000 });
  await page.click('.pb button:has-text("Pause")');
  await page.waitForTimeout(1500);
  const a = await prog(page); await page.waitForTimeout(2000); const b = await prog(page);
  check(a === b, `Pause hält an (${a} → ${b})`);
  await page.click('.pb button:has-text("Weiter")');
  await page.waitForTimeout(3000);
  check((await prog(page)) !== b, 'Weiter läuft wieder');
  await page.click('.pb button:has-text("Pause")');
  await page.waitForTimeout(800);
  await page.click('.pb button:has-text("Abbrechen")'); // Abbrechen im Pause-Zustand darf nicht hängen
  await done(page);
  const s1 = await dbState(page);
  check(!s1.status.processing, `nach Abbruch keine Dateien im Status „processing“ (${JSON.stringify(s1.status)})`);
  await page.click('aside button:has-text("Quellen")');
  const t0 = Date.now(); await pick(page, `${DATA}/Belege`); await done(page);
  const s2 = await dbState(page);
  check(s2.status.done > s1.status.done && !s2.status.error, `Neuimport holt den Rest nach (${JSON.stringify(s2.status)}, ${(Date.now() - t0) / 1000}s)`);
  await page.click('aside button:has-text("Quellen")');
  const t1 = Date.now(); await pick(page, `${DATA}/Belege`); await done(page);
  check(Date.now() - t1 < 8000, `zweiter Neuimport übersprungen und schnell (${Date.now() - t1} ms)`);
  const workers = page.workers().length;
  check(workers === 0, `keine verwaisten Web-Worker nach dem Import (${workers})`);
  await page.context().close();
}

// 2. Defekte Dateien, Dubletten, Quelle mit Umlauten/Tiefe/langen Namen
{
  const page = await open();
  const lt = []; await page.exposeFunction('__lt', (d) => lt.push(d));
  await page.evaluate(() => new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }));
  const t = Date.now();
  for (const sub of ['Kaputt', 'Lang', 'Tief', 'Dubletten', 'Archiv 2025']) fs.existsSync(`${DATA}/${sub}`) || fail.push('Datensatz unvollständig: ' + sub);
  await pick(page, DATA);
  await done(page);
  const txt = await page.$eval('.card.done', e => e.innerText.replace(/\s+/g, ' '));
  const s = await dbState(page);
  check(!s.status.processing, 'kein Rest im Status „processing“');
  check(/Fehler/.test(txt), 'defekte Dateien werden als Fehler gezählt, der Lauf endet trotzdem: ' + txt);
  check(Math.max(...Object.values(s.origins)) >= 4, `Dubletten: ein Datensatz, mehrere Herkunftspfade (max ${Math.max(...Object.values(s.origins))})`);
  check(Math.max(0, ...lt) < 2000, `UI-Freeze < 2 s (längster Long Task ${Math.max(0, ...lt)} ms), Gesamtdauer ${(Date.now() - t) / 1000} s`);
  await page.context().close();
}
await browser.close();
console.log(fail.length ? '\nFEHLER:\n' + fail.join('\n') : '\nALLES OK');
process.exit(fail.length ? 1 : 0);
