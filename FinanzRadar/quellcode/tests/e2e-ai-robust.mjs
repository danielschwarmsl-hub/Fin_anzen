// KI-Robustheit gegen tests/mock-ollama.mjs: Ollama fällt aus, ungültiges JSON, falsche Struktur, HTTP 500, Abbruch,
// KI-Kategorien überleben die Nachverarbeitung. Aufruf: APP=http://localhost:8765/ LC_ALL=C.UTF-8 node tests/e2e-ai-robust.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://localhost:8765/';
const PORT = 11500;
const MOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-ollama.mjs');

// Zweitkonto mit 130 Buchungen unbekannter Händler → viele „offene Fälle“ (7 Batches)
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ai-'));
const CSV_DIR = path.join(DIR, 'Zweitkonto');
fs.mkdirSync(CSV_DIR);
{
  const de = (c) => (c / 100).toFixed(2).replace('.', ',');
  const names = ['Zyx Holding', 'Quorbl AG', 'Fnord Services', 'Blarg & Söhne', 'Wumpus UG', 'Glimmer Labs'];
  const rows = []; let bal = 100000;
  for (let i = 0; i < 130; i++) { const d = new Date(Date.UTC(2025, 0, 3 + i * 2)); const amt = -(500 + ((i * 937) % 8000)); bal += amt; rows.push([d, names[i % names.length] + ' ' + i, `Ref ${1000000 + i * 7} Posten ${i}`, amt, bal]); }
  const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  const L = ['Umsatzanzeige;Datei erstellt am: 30.06.2026 10:15', '', 'IBAN;DE45 1203 0000 1234 5678 90', 'Kontoname;Zweitkonto', 'Bank;ING', 'Kunde;Max Mustermann', 'Zeitraum;01.01.2025 - 30.12.2025', `Saldo;${de(bal)};EUR`, '', 'Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;Betrag;Währung'];
  for (const [d, n, p, a, b] of rows.reverse()) L.push(`${fmt(d)};${fmt(d)};${n};Lastschrift;${p};${de(b)};EUR;${de(a)};EUR`);
  fs.writeFileSync(path.join(CSV_DIR, 'ing_unbekannt.csv'), Buffer.from(L.join('\r\n') + '\r\n', 'latin1'));
  fs.mkdirSync(path.join(DIR, 'Neu')); fs.writeFileSync(path.join(DIR, 'Neu', 'notiz.txt'), 'Notiz zum Nachimport');
}
let mock = null;
const startMock = async (delay = 200, mode = 'ok') => { mock = spawn('node', [MOCK, String(PORT), String(delay), mode], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 600)); };
const stopMock = async () => { mock?.kill('SIGKILL'); mock = null; await new Promise(r => setTimeout(r, 300)); };
const setMode = (m) => fetch(`http://127.0.0.1:${PORT}/__mode/${m}`, { method: 'POST' });
const fails = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };
const neg = () => page.$eval('.negc', e => e.innerText).catch(() => '');
process.on('exit', () => mock?.kill('SIGKILL'));
process.on('uncaughtException', (e) => { console.log('FAIL', e.message.split('\n')[0]); mock?.kill('SIGKILL'); process.exit(1); });
await startMock(200);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => { delete window.showDirectoryPicker; });
await page.goto(APP);
await page.click('text=Mit Beispieldaten ausprobieren');
await page.waitForSelector('.card.done', { timeout: 240000 });
// URL des Mock-Ollama in die Einstellungen schreiben
await page.evaluate((port) => new Promise((res) => { const r = indexedDB.open('finanzradar'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key: 'settings', value: { theme: 'auto', showTaxes: true, onboarded: true, ai: { enabled: false, model: '', visionModel: '', think: false, url: 'http://127.0.0.1:' + port } } }); tx.oncomplete = () => { db.close(); res(); }; }; }), PORT);
await page.reload();
await page.waitForSelector('aside button:has-text("Einstellungen")');
const tab = (l) => page.click(`aside button:has-text("${l}")`);
const tx = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('finanzradar'); r.onsuccess = () => { const db = r.result; db.transaction('transactions').objectStore('transactions').getAll().onsuccess = (e) => { db.close(); const t = e.target.result; res({ n: t.length, ai: t.filter(x => x.categorySource === 'ai').length, review: t.filter(x => x.needsReview && x.categorySource !== 'user').length, bad: t.filter(x => !x.category || x.category === 'null').length }); }; }; }));
await tab('Quellen');
await page.setInputFiles('input[webkitdirectory]', CSV_DIR);
await page.waitForSelector('.card.done', { timeout: 120000 });
await page.waitForTimeout(500);
const t0 = await tx(); check(t0.review > 100, 'Ausgangslage: viele offene Fälle ' + JSON.stringify(t0));
await tab('Einstellungen');
await page.waitForSelector('text=Ollama verbunden', { timeout: 15000 });
// ---- 1. Ollama fällt mitten im Lauf aus ----
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForTimeout(250);
await stopMock();
await page.waitForSelector('.aib', { state: 'detached', timeout: 60000 });
const t1 = await tx();
check(/nicht mehr erreichbar/.test(await neg()) && await page.locator('text=Ollama nicht erreichbar').count() > 0, 'Ollama fällt mitten im Lauf aus → Status offline + Meldung');
check(t1.ai > 0 && t1.ai < t0.review, 'bisherige Ergebnisse bleiben erhalten, Lauf bricht ab ' + JSON.stringify(t1));
// ---- 2. Ollama wieder da, ungültiges JSON ----
await startMock(200, 'invalid');
await page.click('main button.btn-sm:has-text("Prüfen")'); await page.waitForSelector('text=Ollama verbunden');
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForSelector('.aib', { state: 'detached', timeout: 60000 });
check(/keine auswertbaren Antworten/.test(await neg()) && (await tx()).ai === t1.ai, 'ungültiges JSON → Hinweis, nichts verändert');
await setMode('shape');
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForSelector('.aib', { state: 'detached', timeout: 60000 });
check(/keine auswertbaren Antworten/.test(await neg()) && (await tx()).ai === t1.ai, 'falsche JSON-Struktur → Hinweis, kein Absturz');
await setMode('error');
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForSelector('.aib', { state: 'detached', timeout: 60000 });
check(/fehlgeschlagen/.test(await neg()), 'HTTP 500 → Lauf endet nach wenigen Fehlern mit Meldung');
// ---- 3. Abbruch mitten im Lauf ----
await stopMock(); await startMock(1500, 'ok');
await page.click('main button.btn-sm:has-text("Prüfen")'); await page.waitForSelector('text=Ollama verbunden');
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForTimeout(2200);
await page.click('.aib button[title="Stoppen"]');
await page.waitForSelector('.aib', { state: 'detached', timeout: 10000 });
const t2 = await tx();
check(!(await neg()) && t2.ai > t1.ai, 'Abbrechen mitten im Lauf: keine Fehlermeldung, Teilergebnis bleibt ' + JSON.stringify(t2));
// ---- 4. vollständiger Lauf, dann Neuimport -> KI-Kategorien bleiben ----
await stopMock(); await startMock(30, 'ok');
await page.click('main button.btn-sm:has-text("Prüfen")'); await page.waitForSelector('text=Ollama verbunden');
await page.click('text=Offene Fälle mit KI klären');
await page.waitForSelector('.aib');
await page.waitForSelector('.aib', { state: 'detached', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(800);
const before = await tx();
check(before.review === 0 && before.ai >= 122, 'vollständiger Lauf klärt alle offenen Fälle ' + JSON.stringify(before));
await tab('Quellen');
await page.setInputFiles('input[webkitdirectory]', path.join(DIR, 'Neu'));
await page.waitForSelector('.card.done', { timeout: 120000 });
await page.waitForTimeout(500);
const after = await tx(); check(after.ai >= before.ai && after.bad === 0, 'KI-Kategorien überleben Import + Nachverarbeitung ' + JSON.stringify(after));
check(!errors.length, 'keine Seitenfehler ' + errors.join('|'));
fs.rmSync(DIR, { recursive: true, force: true });
await stopMock(); await browser.close();
console.log(fails.length ? '\nFEHLER' : '\nALLES OK');
process.exit(fails.length ? 1 : 0);
