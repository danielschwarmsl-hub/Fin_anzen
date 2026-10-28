// Kleine Skalen-Helfer (DOM-frei)
export function niceStep(range, ticks = 4) {
  const raw = range / Math.max(1, ticks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * pow;
}
/** Schöne Ticks im Bereich [lo, hi] (inklusive 0 falls enthalten). */
export function niceTicks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo];
  const step = niceStep(hi - lo, count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
export const fmtAxis = (cents) => {
  const v = cents / 100, a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' Mio';
  if (a >= 1000) return (v / 1000).toFixed(a >= 1e4 || Number.isInteger(v / 1000) ? 0 : 1).replace('.', ',') + ' T';
  return Math.round(v).toString();
};
