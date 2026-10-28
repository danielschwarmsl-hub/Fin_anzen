// Worker-Einstieg für pdf.js: erst Polyfills (der Worker hat einen eigenen Kontext), dann der eigentliche pdf.js-Worker.
import './pdf-polyfills.js';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
