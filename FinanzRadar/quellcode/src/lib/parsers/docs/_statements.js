// Brücke zum Kontoauszug-Modul (src/lib/parsers/statements/index.js).
// import.meta.glob (eager) bleibt synchron und läuft auch, solange die Datei noch fehlt (leeres Objekt).
const mods = import.meta.glob('../statements/index.js', { eager: true });
const mod = Object.values(mods)[0] || null;

export const hasStatements = !!mod;

/** Detection oder null (kein Kontoauszug/keine Umsatzdatei). */
export function detectStatementFormat(extracted, fileMeta) {
  if (!mod?.detectStatementFormat) return null;
  try { return mod.detectStatementFormat(extracted, fileMeta) || null; } catch { return null; }
}

export function parseStatement(detection, extracted, fileMeta) {
  if (!mod?.parseStatement) throw new Error('Kontoauszug-Parser nicht verfügbar');
  return mod.parseStatement(detection, extracted, fileMeta);
}
