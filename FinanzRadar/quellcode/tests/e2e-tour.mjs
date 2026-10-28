// Tour: Beispieldaten → jede Ansicht als Viewport-Screenshot (hell/dunkel/mobil) + Detailpanels
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const OUT = process.env.SHOTS, URL = process.env.APP || 'http://localhost:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'de-DE' });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto(URL);
await page.click('text=Mit Beispieldaten ausprobieren');
await page.waitForSelector('.card.done', { timeout: 240000 });
const NAV = { overview: 'Überblick', transactions: 'Buchungen', documents: 'Dokumente', contracts: 'Verträge', assets: 'Vermögen', tax: 'Steuer', review: 'Prüfen', settings: 'Einstellungen', sources: 'Quellen' };
async function go(v) { await page.click(`aside button:has-text("${NAV[v]}")`); await page.waitForTimeout(1800); }
for (const theme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: theme });
  for (const v of Object.keys(NAV)) { await go(v); await page.screenshot({ path: `${OUT}/t-${v}-${theme}.png` }); }
}
await page.emulateMedia({ colorScheme: 'light' });
await go('transactions');
await page.click('table tbody tr >> nth=3').catch(e => errors.push('row click ' + e.message));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/d-txdrawer.png` });
await page.keyboard.press('Escape');
await go('documents');
await page.click('text=Rechnung Elektro').catch(e => errors.push('doc click ' + e.message));
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/d-docviewer.png` });
await page.keyboard.press('Escape');
await go('overview');
await page.mouse.move(700, 520); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/d-sankey-hover.png`, clip: { x: 240, y: 280, width: 1200, height: 560 } });
await go('tax');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('button:has-text("ZIP herunterladen")')]);
await dl.saveAs(`${OUT}/steuer.zip`);
console.log('ZIP:', dl.suggestedFilename());
await page.setViewportSize({ width: 390, height: 844 });
for (const v of ['overview', 'transactions', 'documents']) { await go(v); await page.screenshot({ path: `${OUT}/m-${v}.png` }); }
console.log(errors.length ? [...new Set(errors)].join('\n') : 'NO ERRORS');
await browser.close();
