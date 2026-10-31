// Robustheit des PDF-Lesers (pdf.js-Worker): Fehlerklassifikation, Wiederholung, Zeitlimits und ein gemeinsamer
// Worker für alle Dokumente. DOM-frei – wird in pdf.js mit echtem Web-Worker verdrahtet und in Node getestet.

/** Meldungen, die auf einen abgestürzten/unbrauchbaren PDF-Leser hindeuten (nicht auf eine defekte Datei). */
const WORKER_FAILURE_RE = new RegExp([
  'fake worker', // „Setting up fake worker failed: …“ (Rückfall ohne WorkerMessageHandler)
  'worker was (?:destroyed|terminated)', 'worker task was terminated', 'transport destroyed',
  'pdf-leser', 'pdf-worker',
  'failed to fetch dynamically imported module', 'error loading dynamically imported module',
  'importing a module script failed', 'networkerror', 'network error', 'failed to fetch',
  'out of memory', 'cannot use more than one pdfworker',
].join('|'), 'i');

/**
 * Art eines Fehlers beim PDF-Lesen:
 * 'abort' (vom Nutzer abgebrochen) | 'password' | 'invalid' (defekte Datei) | 'worker' (PDF-Leser ausgefallen) | 'other'
 */
export function classifyPdfError(e) {
  const name = e?.name || '';
  const msg = typeof e === 'string' ? e : e?.message || '';
  if (name === 'AbortError') return 'abort';
  if (name === 'PasswordException') return 'password';
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') return 'invalid';
  if (name === 'PdfReaderError' || WORKER_FAILURE_RE.test(msg)) return 'worker';
  return 'other';
}

/** Gespeicherte Fehlermeldung (db.files.error) oder Fehlerobjekt: ist der PDF-Leser ausgefallen (→ später erneut lesen)? */
export function isPdfWorkerFailure(e) {
  return classifyPdfError(e) === 'worker';
}

/** Klartext-Fehler für den Nutzer; die Originalmeldung bleibt als Zusatz erhalten (und in `cause`). */
export function pdfReaderError(e) {
  if (e?.name === 'PdfReaderError') return e;
  const orig = (typeof e === 'string' ? e : e?.message || String(e || '')).trim();
  const err = new Error('PDF konnte nicht gelesen werden (PDF-Leser abgestürzt) – bitte „Neu einlesen“.'
    + (orig ? ` Technische Meldung: ${orig}` : ''), { cause: e });
  err.name = 'PdfReaderError';
  return err;
}

/** Promise mit Zeitlimit; danach Fehler „Zeitüberschreitung im PDF-Leser (label)“ (gilt als Worker-Ausfall). */
export function withTimeout(promise, ms, label, onTimeout) {
  if (!(ms > 0)) return promise;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* egal */ }
      reject(new Error(`Zeitüberschreitung im PDF-Leser (${label})`));
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Führt run(attempt) aus; scheitert es mit einem Worker-Fehler, wird restart(e) abgewartet und erneut versucht
 * (höchstens `retries`-mal). Bleibt es beim Worker-Fehler, kommt ein Klartext-Fehler (PdfReaderError).
 * Andere Fehler (defekte Datei, Passwort, Abbruch) werden unverändert weitergereicht. Ein bereits fertiger
 * PdfReaderError (innere Wiederholung schon erschöpft) wird nicht noch einmal wiederholt.
 */
export async function withWorkerRetry(run, { restart, retries = 1, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(attempt);
    } catch (e) {
      if (e?.name === 'PdfReaderError') throw e;
      if (classifyPdfError(e) !== 'worker') throw e;
      if (attempt >= retries) throw pdfReaderError(e);
      onRetry?.(e, attempt);
      try { await restart?.(e); } catch (re) { throw pdfReaderError(re); }
    }
  }
}

/**
 * promise, aber abgelehnt, sobald der Worker-Slot stirbt (Absturz/Neustart): Anfragen an einen toten Worker
 * würden sonst nie beantwortet. Die Meldung gilt als Worker-Fehler (→ Neustart und neuer Versuch).
 */
export function raceSlot(slot, promise) {
  if (!slot?.onDeath) return promise;
  if (slot.dead) return Promise.reject(new Error('PDF-Worker wurde beendet (abgestürzt)'));
  let off = () => {};
  const died = new Promise((_, reject) => { off = slot.onDeath(() => reject(new Error('PDF-Worker wurde beendet (abgestürzt)'))); });
  return Promise.race([promise, died]).finally(off);
}

/**
 * Hält EINEN gemeinsamen Worker für alle offenen Dokumente (Import, Vorschau, OCR).
 * create(markDead) → Promise<handle>; destroy(handle) beendet ihn. markDead() meldet einen Absturz von außen.
 * - acquire() → slot (Worker wird bei Bedarf einmal erzeugt, auch bei parallelen Aufrufen nur einmal)
 * - release(slot) nach dem Schließen eines Dokuments
 * - slot.onDeath(fn) meldet den Tod des Slots (für raceSlot)
 * - restart(slot) verwirft einen kaputten Worker (nur, wenn es noch der aktuelle ist); der nächste acquire() erzeugt neu
 * - releaseIdle() beendet den Worker, sobald kein Dokument mehr offen ist (z. B. am Ende des Imports)
 */
export function createWorkerHolder({ create, destroy }) {
  let cur = null;
  let starting = null;
  let gen = 0;
  let releaseWanted = false;
  let created = 0;

  function kill(slot) {
    if (!slot || slot.dead) return;
    slot.dead = true;
    if (cur === slot) cur = null;
    if (slot.handle) { try { destroy(slot.handle); } catch { /* bereits beendet */ } }
    for (const fn of [...slot.listeners]) { try { fn(); } catch { /* egal */ } }
    slot.listeners.clear();
  }

  function start() {
    const listeners = new Set();
    const slot = {
      gen: ++gen, users: 0, dead: false, handle: null, listeners,
      /** fn bei Tod des Slots aufrufen; liefert die Abmeldung */
      onDeath(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    return (async () => {
      try {
        const handle = await create(() => kill(slot));
        created++;
        slot.handle = handle;
        if (slot.dead) { try { destroy(handle); } catch { /* egal */ } return; } // schon beim Start gestorben → nächster Versuch
        cur = slot;
      } finally {
        starting = null;
      }
    })();
  }

  return {
    async acquire() {
      releaseWanted = false;
      for (let i = 0; i < 5; i++) {
        if (cur && !cur.dead) { cur.users++; return cur; }
        if (!starting) starting = start();
        await starting;
      }
      throw new Error('PDF-Leser startet nicht');
    },
    release(slot) {
      if (!slot) return;
      slot.users = Math.max(0, slot.users - 1);
      if (releaseWanted && slot === cur && slot.users === 0) { releaseWanted = false; kill(slot); }
    },
    restart(slot = cur) { kill(slot); },
    releaseIdle() {
      if (cur && cur.users === 0) kill(cur);
      else if (cur) releaseWanted = true;
    },
    /** Zustand für Tests/Diagnose: { alive, users, generation, created } */
    stats() { return { alive: !!(cur && !cur.dead), users: cur?.users ?? 0, generation: gen, created }; },
  };
}
