// Kopiert die fiktiven Beispieldateien nach public/samples und schreibt ein Manifest
import { cpSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const src = new URL('../samples/out/', import.meta.url).pathname;
const out = new URL('../public/samples/', import.meta.url).pathname;
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f !== 'EXPECTED.json') files.push(relative(src, p)); } })(src);
cpSync(src, out, { recursive: true });
rmSync(join(out, 'EXPECTED.json'), { force: true });
writeFileSync(join(out, 'manifest.json'), JSON.stringify(files.map(f => ({ path: f, size: statSync(join(src, f)).size })), null, 1));
console.log('samples', files.length);
