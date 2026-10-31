// PDF-Leser: Fehlerklassifikation, Wiederholung, Zeitlimit und gemeinsamer Worker (DOM-frei, extract/pdf-reader.js)
import { describe, it, expect, vi } from 'vitest';
import {
  classifyPdfError, isPdfWorkerFailure, pdfReaderError, withTimeout, withWorkerRetry, createWorkerHolder, raceSlot,
} from '../src/lib/extract/pdf-reader.js';
import { isPdfWorkerFailure as fromIndex } from '../src/lib/extract/index.js';

const named = (name, message = '') => Object.assign(new Error(message), { name });

describe('classifyPdfError', () => {
  it('erkennt Worker-Ausfälle (Firefox-, Chromium- und Safari-Meldungen)', () => {
    for (const m of [
      'Setting up fake worker failed: "can\'t access property "setup", t is undefined".',
      'Setting up fake worker failed: "Cannot read properties of undefined (reading \'setup\')".',
      'Worker was destroyed', 'Worker was terminated.', 'Worker task was terminated', 'Transport destroyed',
      'error loading dynamically imported module: http://127.0.0.1:8765/assets/pdf-worker-abc.js',
      'Failed to fetch dynamically imported module: http://localhost/assets/pdf-worker.js',
      'Importing a module script failed.', 'NetworkError when attempting to fetch resource.',
      'Zeitüberschreitung im PDF-Leser (Öffnen)', 'PDF-Worker wurde beendet (abgestürzt)', 'out of memory',
    ]) expect(classifyPdfError(new Error(m)), m).toBe('worker');
  });
  it('trennt defekte Dateien, Passwort und Abbruch vom Worker-Ausfall', () => {
    expect(classifyPdfError(named('InvalidPDFException', 'Invalid PDF structure.'))).toBe('invalid');
    expect(classifyPdfError(named('PasswordException', 'No password given'))).toBe('password');
    expect(classifyPdfError(new DOMException('Vorgang abgebrochen', 'AbortError'))).toBe('abort');
    expect(classifyPdfError(new Error('Bad FCHECK in flate stream'))).toBe('other');
    expect(classifyPdfError(null)).toBe('other');
  });
  it('erkennt gespeicherte Fehlertexte (db.files.error) – auch den eigenen Klartext', () => {
    expect(isPdfWorkerFailure('Setting up fake worker failed: "t is undefined".')).toBe(true);
    expect(isPdfWorkerFailure(pdfReaderError(new Error('Worker was destroyed')).message)).toBe(true);
    expect(isPdfWorkerFailure('Keine gültige PDF-Datei')).toBe(false);
    expect(fromIndex('Worker was terminated')).toBe(true); // auch über extract/index.js erreichbar (für das Neueinlesen)
  });
});

describe('pdfReaderError', () => {
  it('Klartext zuerst, Originalmeldung nur als Zusatz', () => {
    const orig = new Error('Setting up fake worker failed: "t is undefined".');
    const e = pdfReaderError(orig);
    expect(e.name).toBe('PdfReaderError');
    expect(e.message).toMatch(/^PDF konnte nicht gelesen werden \(PDF-Leser abgestürzt\) – bitte „Neu einlesen“\./);
    expect(e.message).toContain('Technische Meldung: Setting up fake worker failed');
    expect(e.cause).toBe(orig);
    expect(pdfReaderError(e)).toBe(e);
  });
});

describe('withTimeout', () => {
  it('lässt schnelle Promises durch und bricht hängende ab', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, 'x')).resolves.toBe(7);
    const onTimeout = vi.fn();
    const err = await withTimeout(new Promise(() => {}), 10, 'Seite 3', onTimeout).catch(e => e);
    expect(err.message).toBe('Zeitüberschreitung im PDF-Leser (Seite 3)');
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(classifyPdfError(err)).toBe('worker');
  });
});

describe('withWorkerRetry', () => {
  it('startet den Worker nach einem Ausfall neu und versucht die Datei einmal erneut', async () => {
    const restart = vi.fn();
    let calls = 0;
    const res = await withWorkerRetry(async () => { if (calls++ === 0) throw new Error('Worker was terminated'); return 'gelesen'; }, { restart });
    expect(res).toBe('gelesen');
    expect(restart).toHaveBeenCalledOnce();
    expect(calls).toBe(2);
  });
  it('gibt nach dem zweiten Ausfall einen Klartext-Fehler', async () => {
    const restart = vi.fn();
    const err = await withWorkerRetry(async () => { throw new Error('Setting up fake worker failed: "x".'); }, { restart }).catch(e => e);
    expect(err.name).toBe('PdfReaderError');
    expect(restart).toHaveBeenCalledOnce();
  });
  it('wiederholt keine defekten Dateien, Passwörter, Abbrüche oder fertige Klartext-Fehler', async () => {
    for (const e of [named('InvalidPDFException', 'Invalid PDF structure.'), named('PasswordException'), new DOMException('ab', 'AbortError'),
      pdfReaderError(new Error('Worker was destroyed'))]) {
      const restart = vi.fn();
      let calls = 0;
      const got = await withWorkerRetry(async () => { calls++; throw e; }, { restart }).catch(x => x);
      expect(got).toBe(e);
      expect(calls).toBe(1);
      expect(restart).not.toHaveBeenCalled();
    }
  });
  it('scheitert der Neustart selbst, kommt ebenfalls der Klartext-Fehler', async () => {
    const err = await withWorkerRetry(async () => { throw new Error('Worker was destroyed'); }, { restart: async () => { throw new Error('PDF-Worker startet nicht'); } }).catch(e => e);
    expect(err.name).toBe('PdfReaderError');
    expect(err.message).toContain('PDF-Worker startet nicht');
  });
});

/** Worker-Attrappe: zählt Starts/Beenden, merkt sich markDead für simulierte Abstürze */
function fakeFactory({ failFirst = 0 } = {}) {
  const f = { started: 0, destroyed: 0, handles: [], fails: failFirst };
  f.create = vi.fn(async (markDead) => {
    await new Promise(r => setTimeout(r, 5));
    if (f.fails > 0) { f.fails--; throw new Error('PDF-Worker konnte nicht starten'); }
    const h = { id: ++f.started, markDead, alive: true };
    f.handles.push(h);
    return h;
  });
  f.destroy = vi.fn((h) => { h.alive = false; f.destroyed++; });
  return f;
}

describe('createWorkerHolder', () => {
  it('startet bei parallelen Dokumenten nur EINEN Worker und hält ihn über viele Dateien', async () => {
    const f = fakeFactory();
    const holder = createWorkerHolder(f);
    const slots = await Promise.all(Array.from({ length: 8 }, () => holder.acquire()));
    expect(new Set(slots).size).toBe(1);
    expect(f.started).toBe(1);
    expect(holder.stats()).toMatchObject({ alive: true, users: 8 });
    for (const s of slots) holder.release(s);
    for (let i = 0; i < 40; i++) holder.release(await holder.acquire());
    expect(f.started).toBe(1);
    expect(f.destroyed).toBe(0); // Schließen eines Dokuments beendet den gemeinsamen Worker nicht
  });

  it('Neustart nach Absturz: nur der kaputte Worker wird verworfen, der nächste acquire startet neu', async () => {
    const f = fakeFactory();
    const holder = createWorkerHolder(f);
    const a = await holder.acquire();
    const b = await holder.acquire();
    holder.restart(a);
    holder.restart(b); // zweiter paralleler Fehler im selben (schon verworfenen) Worker: kein Doppel-Neustart
    expect(f.destroyed).toBe(1);
    const c = await holder.acquire();
    expect(c).not.toBe(a);
    expect(f.started).toBe(2);
    holder.restart(a); // veralteter Slot: aktueller Worker bleibt
    expect(c.dead).toBe(false);
  });

  it('markDead (error-Event) verwirft den Worker und bricht laufende Anfragen sofort ab', async () => {
    const f = fakeFactory();
    const holder = createWorkerHolder(f);
    const slot = await holder.acquire();
    const pending = raceSlot(slot, new Promise(() => {}));
    f.handles[0].markDead();
    const err = await pending.catch(e => e);
    expect(err.message).toMatch(/PDF-Worker wurde beendet/);
    expect(isPdfWorkerFailure(err)).toBe(true);
    expect(holder.stats().alive).toBe(false);
    await expect(raceSlot(slot, Promise.resolve(1))).rejects.toThrow(/beendet/);
    expect((await holder.acquire()).handle.id).toBe(2);
  });

  it('raceSlot meldet sich nach Erfolg wieder ab (kein Leck bei vielen Seiten)', async () => {
    const holder = createWorkerHolder(fakeFactory());
    const slot = await holder.acquire();
    for (let i = 0; i < 100; i++) await raceSlot(slot, Promise.resolve(i));
    expect(slot.listeners.size).toBe(0);
  });

  it('releaseIdle beendet den Worker erst, wenn kein Dokument mehr offen ist (Vorschau bleibt nutzbar)', async () => {
    const f = fakeFactory();
    const holder = createWorkerHolder(f);
    const viewer = await holder.acquire();
    holder.releaseIdle();
    expect(f.destroyed).toBe(0);
    holder.release(viewer);
    expect(f.destroyed).toBe(1);
    const again = await holder.acquire(); // neuer Import nach dem Freigeben: neuer Worker
    expect(again.handle.id).toBe(2);
    holder.release(again);
    expect(f.destroyed).toBe(1); // ohne releaseIdle bleibt er
    holder.releaseIdle();
    expect(f.destroyed).toBe(2);
  });

  it('ein neues Öffnen nach releaseIdle hebt das spätere Beenden auf (laufender Import)', async () => {
    const f = fakeFactory();
    const holder = createWorkerHolder(f);
    const a = await holder.acquire();
    holder.releaseIdle();
    const b = await holder.acquire();
    holder.release(a);
    holder.release(b);
    expect(f.destroyed).toBe(0);
  });

  it('gescheiterter Start: Fehler an alle Wartenden, der nächste Versuch startet neu', async () => {
    const f = fakeFactory({ failFirst: 1 });
    const holder = createWorkerHolder(f);
    const res = await Promise.allSettled([holder.acquire(), holder.acquire()]);
    expect(res.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect((await holder.acquire()).handle.id).toBe(1);
  });

  it('stirbt der Worker schon während des Starts, wird er verworfen und neu gestartet', async () => {
    const f = fakeFactory();
    const origCreate = f.create;
    let first = true;
    f.create = async (markDead) => { const h = await origCreate(markDead); if (first) { first = false; markDead(); } return h; };
    const holder = createWorkerHolder(f);
    const slot = await holder.acquire();
    expect(slot.handle.id).toBe(2);
    expect(f.destroyed).toBe(1);
  });
});
