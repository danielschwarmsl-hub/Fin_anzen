// Worker-Einstieg für pdf.js: erst Polyfills (der Worker hat einen eigenen Kontext), dann der eigentliche pdf.js-Worker.
// Rückfall im Hauptthread (pdf.js → loadMainThreadWorker): Diese Datei wird dann per import() im Hauptthread geladen.
// Vite entfernt im Worker-Bundle alle Exporte – nutzbar ist dort nur der Seiteneffekt von pdf.worker, der
// globalThis.pdfjsWorker = { WorkerMessageHandler } setzt. Darauf baut der Rückfall, nicht auf einem Export.
import './pdf-polyfills.js';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
