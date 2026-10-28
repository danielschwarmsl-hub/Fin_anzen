// E2E-Rundgang: Beispieldaten laden, alle Ansichten öffnen, Screenshots + Konsolenfehler
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const OUT = process.env.SHOTS || './shots';
const URL = process.env.APP || 'http://localhost:8765/';
const theme = process.env.THEME || 'light';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto(URL);
await page.waitForSelector('text=Alles reinwerfen', { timeout: 20000 });
await page.screenshot({ path: `${OUT}/01-start-${theme}.png` });
await page.click('text=Mit Beispieldaten ausprobieren');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/02-progress-${theme}.png` });
await page.waitForSelector('.card.done', { timeout: 240000 });
await page.screenshot({ path: `${OUT}/03-done-${theme}.png` });
const views = ['overview', 'transactions', 'documents', 'contracts', 'assets', 'tax', 'review', 'settings', 'sources'];
for (const v of views) {
  await page.evaluate(v => { location.hash = v; }, v);
  await page.click(`nav button:has-text("${{ overview: 'Überblick', transactions: 'Buchungen', documents: 'Dokumente', contracts: 'Verträge', assets: 'Vermögen', tax: 'Steuer', review: 'Prüfen', settings: 'Einstellungen', sources: 'Quellen' }[v]}")`).catch(() => {});
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/v-${v}-${theme}.png`, fullPage: true });
}
// Suche
await page.keyboard.press('Control+k');
await page.keyboard.type('rewe');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/search-${theme}.png` });
await page.keyboard.press('Escape');
const stats = await page.evaluate(async () => {
  const req = indexedDB.open('finanzradar');
  const db = await new Promise(r => (req.onsuccess = () => r(req.result)));
  const count = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
  return { files: await count('files'), documents: await count('documents'), transactions: await count('transactions'), accounts: await count('accounts'), contracts: await count('contracts') };
});
console.log(JSON.stringify(stats));
console.log(errors.length ? errors.join('\n') : 'NO ERRORS');
await browser.close();
