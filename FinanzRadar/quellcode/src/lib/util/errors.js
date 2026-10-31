// Importfehler in Klartext – DOM-frei. Technische Meldungen (pdf.js, Tesseract, IndexedDB …) werden zu einem Satz mit
// nächstem Schritt; der Originaltext bleibt als `detail` für die kleine Zeile darunter bzw. den Erkennungsbericht.

// [Muster, Klartext]; erstes Muster gewinnt
const RULES = [
  [/passw(?:or)?[dt]|PasswordException/i, 'PDF ist passwortgeschützt'],
  [/fake worker|worker was (?:destroyed|terminated)|worker.*(?:failed|crash|abgestürzt|terminated)|WorkerMessageHandler|pdf\.worker|PDF-Leser/i, 'PDF-Leser ist abgestürzt – Datei bitte erneut einlesen'],
  [/invalid pdf|InvalidPDFException|keine gültige pdf|missing pdf header|unexpected end of (?:pdf|file)|bad xref|xref/i, 'Datei ist keine gültige PDF'],
  [/^abgebrochen$|AbortError|aborted/i, 'Einlesen abgebrochen – Datei bitte erneut einlesen'],
  [/quota|speicher des browsers voll/i, 'Speicher des Browsers ist voll'],
  [/out of memory|allocation failed|array buffer allocation|zu wenig (?:arbeits)?speicher/i, 'Zu wenig Arbeitsspeicher – Datei bitte einzeln erneut einlesen'],
  [/libheif|heic/i, 'HEIC-Bild nicht lesbar (Format wird nicht unterstützt)'],
  [/NotReadableError|NotFoundError|nicht lesbar \(berechtigung/i, 'Datei nicht lesbar – kein Zugriff oder Datei wurde inzwischen geändert'],
  [/dateiinhalt nicht gespeichert/i, 'Original nicht gespeichert – Datei bitte neu importieren'],
  [/tesseract|traineddata|\bocr\b|texterkennung/i, 'Texterkennung (OCR) fehlgeschlagen – Datei bitte erneut einlesen'],
  [/failed to fetch|networkerror|load failed/i, 'Datei konnte nicht geladen werden – Verbindung zur Quelle prüfen'],
];
const FALLBACK = 'Datei konnte nicht gelesen werden';

/**
 * friendlyError(msg) → { text, detail, retry }
 * text: Klartext für die Anzeige; detail: Originalmeldung (null, wenn identisch oder leer);
 * retry: true, wenn erneutes Einlesen sinnvoll ist (nicht bei Passwort/keiner PDF).
 */
export function friendlyError(msg) {
  const raw = typeof msg === 'string' ? msg : msg?.message || (msg == null ? '' : String(msg));
  const orig = raw.replace(/\s+/g, ' ').trim();
  const hit = RULES.find(([re]) => re.test(orig));
  const text = hit ? hit[1] : FALLBACK;
  const retry = !hit || !/passwort|keine gültige PDF|HEIC/.test(text);
  return { text, detail: orig && orig !== text ? orig : null, retry };
}
