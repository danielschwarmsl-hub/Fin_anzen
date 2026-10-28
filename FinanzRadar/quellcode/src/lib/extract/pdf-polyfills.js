// Polyfills für pdf.js 6 – laufen im Hauptthread UND im pdf.js-Worker (eigener JS-Kontext, erbt nichts von main.js).
// Ohne sie scheitern verschlüsselte PDFs (auch solche nur mit Besitzer-Passwort, wie viele Bankauszüge) in älteren Browsern
// mit „getOrInsertComputed is not a function“ bzw. „Math.sumPrecise is not a function“.
import '../../polyfills.js';

/** Exakte Summe (Shewchuk, wie Python math.fsum) – Ersatz für Math.sumPrecise */
export function sumPrecise(iterable) {
  const partials = [];
  let special = 0; // ±Infinity / NaN
  let any = false;
  for (const x of iterable) {
    if (typeof x !== 'number') throw new TypeError('Math.sumPrecise: Zahlen erwartet');
    any = true;
    if (!Number.isFinite(x)) { special += x; continue; }
    let v = x;
    let i = 0;
    for (let y of partials) {
      if (Math.abs(v) < Math.abs(y)) { const t = v; v = y; y = t; }
      const hi = v + y;
      const lo = y - (hi - v);
      if (lo) partials[i++] = lo;
      v = hi;
    }
    partials.length = i;
    partials.push(v);
  }
  if (!any) return -0;
  if (special !== 0 || Number.isNaN(special)) return special;
  let n = partials.length;
  let hi = partials[--n];
  let lo = 0;
  while (n > 0) {
    const x = hi;
    const y = partials[--n];
    hi = x + y;
    lo = y - (hi - x);
    if (lo) break;
  }
  if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi;
}

if (typeof Math.sumPrecise !== 'function') {
  Object.defineProperty(Math, 'sumPrecise', { configurable: true, writable: true, value: sumPrecise });
}
