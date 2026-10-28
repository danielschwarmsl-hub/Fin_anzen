// Copies offline assets (tesseract worker/core/lang data) into public/vendor
import { cpSync, mkdirSync } from 'node:fs';
const nm = new URL('../node_modules/', import.meta.url).pathname;
const out = new URL('../public/vendor/', import.meta.url).pathname;
mkdirSync(out + 'tesseract/core', { recursive: true });
mkdirSync(out + 'tesseract/lang', { recursive: true });
cpSync(nm + 'tesseract.js/dist/worker.min.js', out + 'tesseract/worker.min.js');
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm', 'tesseract-core-lstm.wasm', 'tesseract-core-relaxedsimd-lstm.wasm', 'tesseract-core-simd-lstm.js', 'tesseract-core-lstm.js', 'tesseract-core-relaxedsimd-lstm.js'])
  cpSync(nm + 'tesseract.js-core/' + f, out + 'tesseract/core/' + f);
cpSync(nm + '@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz', out + 'tesseract/lang/deu.traineddata.gz');
// pdf.js Standardschriften (Rendern im Browser)
mkdirSync(out + 'pdfjs', { recursive: true });
cpSync(nm + 'pdfjs-dist/standard_fonts', out + 'pdfjs/standard_fonts', { recursive: true });
console.log('vendor ok');
