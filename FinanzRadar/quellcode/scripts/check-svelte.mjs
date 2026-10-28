// Kompiliert alle (oder angegebene) .svelte-Dateien und meldet Fehler/Warnungen
import { compile } from 'svelte/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const files = [];
function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.svelte')) files.push(p); } }
if (args.length) files.push(...args); else walk('src');
let bad = 0;
for (const f of files) {
  try {
    const r = compile(readFileSync(f, 'utf8'), { filename: f, generate: 'client' });
    for (const w of r.warnings) if (!/a11y/.test(w.code)) console.log('WARN', f, w.code, w.message.split('\n')[0]);
  } catch (e) { bad++; console.log('ERROR', f, e.message.split('\n')[0], e.start ? `@${e.start.line}:${e.start.column}` : ''); }
}
console.log(bad ? `${bad} Fehler` : `OK (${files.length} Dateien)`);
process.exit(bad ? 1 : 0);
