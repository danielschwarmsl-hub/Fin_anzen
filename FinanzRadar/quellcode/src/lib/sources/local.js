// Lokaler Ordner: File System Access API (Chrome/Edge), <input webkitdirectory> (Firefox), Drag & Drop.
// Pfade sind immer relativ zum gewählten Ordner, inklusive dessen Namens (z. B. "Banken/ING/x.csv").
import { allowedFile, isSkippedName, makeItem, isoFromMillis } from './index.js';

export function isDirectoryPickerSupported() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** Öffnet den nativen Ordnerdialog (nur Chrome/Edge). */
export async function pickDirectory() {
  const handle = await globalThis.showDirectoryPicker({ mode: 'read' });
  return { handle, name: handle.name };
}

/** Lesezugriff auf einen gespeicherten Handle prüfen bzw. anfordern (Nutzergeste nötig). */
export async function ensurePermission(handle, mode = 'read') {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** Rekursiv alle erlaubten Dateien eines FileSystemDirectoryHandle durchlaufen. */
export async function* enumerateHandle(dirHandle, { signal, basePath } = {}) {
  const prefix = basePath ?? `${dirHandle.name}/`;
  yield* walkHandle(dirHandle, prefix, signal);
}

async function* walkHandle(dir, prefix, signal) {
  for await (const [name, handle] of dir.entries()) {
    signal?.throwIfAborted();
    if (isSkippedName(name)) continue;
    if (handle.kind === 'directory') {
      yield* walkHandle(handle, `${prefix}${name}/`, signal);
      continue;
    }
    if (!allowedFile(name)) continue;
    const file = await handle.getFile();
    if (!allowedFile(name, file.size)) continue;
    yield makeItem({
      path: prefix + name,
      name,
      size: file.size,
      mtime: isoFromMillis(file.lastModified),
      getFile: () => handle.getFile(),
    });
  }
}

/** Items aus <input type="file" webkitdirectory multiple> (webkitRelativePath enthält den Ordnernamen). */
export function filesFromInput(fileList) {
  const out = [];
  for (const file of Array.from(fileList ?? [])) {
    const rel = file.webkitRelativePath || file.name;
    if (rel.split('/').some(isSkippedName)) continue;
    if (!allowedFile(file.name, file.size)) continue;
    out.push(fileItem(file, rel));
  }
  return out;
}

function fileItem(file, path) {
  return makeItem({
    path,
    name: file.name,
    size: file.size,
    mtime: isoFromMillis(file.lastModified),
    getFile: async () => file,
  });
}

/**
 * Drop-Daten (Ordner und Dateien) auslesen. Chrome: getAsFileSystemHandle, sonst webkitGetAsEntry
 * (Firefox). Die Items werden synchron im drop-Event gesichert, bevor async gewartet wird.
 */
export async function itemsFromDataTransfer(dataTransfer) {
  const pending = [];
  for (const item of Array.from(dataTransfer?.items ?? [])) {
    if (item.kind && item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    const handle = typeof item.getAsFileSystemHandle === 'function'
      ? item.getAsFileSystemHandle().catch(() => null)
      : null;
    if (entry || handle) {
      pending.push({ entry, handle });
    } else {
      const file = item.getAsFile?.();
      if (file) pending.push({ file });
    }
  }

  // Fallback ohne Items-API: nur flache Dateiliste
  if (!pending.length) return filesFromInput(dataTransfer?.files);

  const out = [];
  for (const p of pending) {
    const handle = p.handle ? await p.handle : null;
    if (handle) {
      if (handle.kind === 'directory') {
        for await (const item of enumerateHandle(handle, { basePath: `${handle.name}/` })) out.push(item);
      } else if (allowedFile(handle.name) && !isSkippedName(handle.name)) {
        const file = await handle.getFile();
        if (allowedFile(handle.name, file.size)) out.push(fileItem(file, handle.name));
      }
    } else if (p.entry) {
      await walkEntry(p.entry, p.entry.name, out);
    } else if (p.file && allowedFile(p.file.name, p.file.size)) {
      out.push(fileItem(p.file, p.file.name));
    }
  }
  return out;
}

async function walkEntry(entry, path, out) {
  if (isSkippedName(entry.name)) return;
  if (entry.isDirectory) {
    for (const child of await readDirectory(entry)) {
      await walkEntry(child, `${path}/${child.name}`, out);
    }
    return;
  }
  if (!entry.isFile || !allowedFile(entry.name)) return;
  const file = await entryFile(entry);
  if (!allowedFile(entry.name, file.size)) return;
  out.push(makeItem({
    path,
    name: entry.name,
    size: file.size,
    mtime: isoFromMillis(file.lastModified),
    getFile: () => entryFile(entry),
  }));
}

/** readEntries liefert nur Batches (max. 100) – bis zum leeren Batch lesen. */
function readDirectory(dirEntry) {
  const reader = dirEntry.createReader();
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
