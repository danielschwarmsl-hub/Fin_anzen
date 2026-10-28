// UI-Regressionen (Playwright): kein horizontales Scrollen auf 390 px, Achsenbeschriftung, Typ-Labels, Zahlenformat.
// Start: APP=http://127.0.0.1:8791/ node tests/e2e-ui.mjs   (gebaute App wird per HTTP ausgeliefert)
import { createRequire } from 'node:module';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const URL = process.env.APP || 'http://localhost:8765/';
const NAV = { overview: 'Überblick', transactions: 'Buchungen', documents: 'Dokumente', contracts: 'Verträge', assets: 'Vermögen', tax: 'Steuer', review: 'Prüfen', settings: 'Einstellungen', sources: 'Quellen' };
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(ok ? 'ok  ' : 'FAIL', msg); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'de-DE' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL);
await page.click('text=Mit Beispieldaten ausprobieren');
await page.waitForSelector('.card.done', { timeout: 240000 });
const go = async (v) => { await page.click(`aside button:has-text("${NAV[v]}"), nav button:has-text("${NAV[v]}")`); await page.waitForTimeout(900); };

for (const v of Object.keys(NAV)) {
  await go(v);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check(sw[0] <= sw[1], `390px: ${v} ohne horizontales Scrollen (${sw[0]} <= ${sw[1]})`);
}

await page.setViewportSize({ width: 1440, height: 900 });
await go('assets');
await page.waitForSelector('.nw svg text.ax', { timeout: 8000 }).catch(() => {});
const xl = await page.$$eval('.nw svg text.ax', (els) => els.map((e) => e.textContent));
const xt = xl.filter((t) => /^\d\d[./]/.test(t));
check(xt.length > 1 && new Set(xt).size === xt.length, `Vermögensverlauf: x-Beschriftungen eindeutig (${xt.join(' ')})`);

await go('review');
const opts = await page.locator('select option').allInnerTexts();
check(!opts.some((o) => /Umsaetze/.test(o)), 'Prüfen: Typ-Liste ohne ASCII-Label "Umsaetze"');
check(opts.length > 5, 'Prüfen: Typ-Liste vorhanden');

await go('contracts');
const ct = await page.locator('main').innerText();
check(!/monthly|biweekly|quarterly|halfyearly|yearly|weekly/.test(ct), 'Verträge: Intervalle auf Deutsch');

await go('overview');
const kpis = await page.locator('.kpi .val').allInnerTexts();
check(kpis.every((k) => /,\d\d\s€$|%$/.test(k.trim())), `Überblick: Kennzahlen immer mit Cent (${kpis.join(' | ')})`);

check(errors.length === 0, 'keine Seitenfehler ' + errors.join(';'));
await browser.close();
if (fails.length) { console.log(`\n${fails.length} Fehler`); process.exit(1); }
console.log('\nALLE OK');
