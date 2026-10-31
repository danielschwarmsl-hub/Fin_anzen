# Implementierungsplan: Bank- und Depotdokumente zuverlässig verarbeiten

Stand: 31.10.2026 · Grundlage: 9 Nutzerdokumente (comdirect Finanzreport, Wertpapierkauf, Dividende, 2× Kosteninformation, MLP Reporting, DKB Kontoauszug Soll/Haben) und die Fehlerbilder aus dem echten Einsatz.

## 1. Warum es beim Nutzer scheitert (Ursachenanalyse)

| # | Befund | Ursache | Folge |
|---|---|---|---|
| U1 | „Setting up fake worker failed: can't access property "setup", t is undefined“ ab ca. 10 Dokumenten, danach bei fast allen | pdf.js startet je PDF einen neuen Web-Worker. Scheitert **ein** Start (z. B. Firefox unter Last), schaltet pdf.js **dauerhaft** auf einen „Fake-Worker“ im Hauptthread um. Dieser lädt unseren Worker-Einstieg (`extract/pdf-worker.js`), der `WorkerMessageHandler` nicht exportiert → jeder weitere PDF-Import schlägt fehl. Fehlermeldung im Firefox-Format; getestet wurde bisher nur in Chromium. | Ab dem Fehler wird kein PDF mehr gelesen. Auch das automatische „Nach Update neu einlesen“ scheitert, deshalb bleiben alte Fehlerkennungen (Wertpapierkauf = „Steuerbescheinigung“) stehen. |
| U2 | Erkennung im Test gut, beim Nutzer schlecht | Getestet wurde mit OCR-Text der **geschwärzten Scans**. Die Originale haben eine **Textebene**: pdf.js liefert andere Zeilen (Spaltenabstände, Zeilen zusammengeführt/getrennt, Courier-Layout der comdirect-Abrechnungen, Fußzeilen, Soll/Haben-Spalten mit x-Position). Diese Form haben wir nie geprüft. | Regeln und Parser greifen beim Original nicht oder anders. |
| U3 | MLP-Reporting und Finanzreport-Depot nur „Info“ | Bestände, Depotwert, Einzahlungen und Transaktionen werden nicht übernommen. | Die zentrale Übersicht fehlt (Vermögen, Depotentwicklung, Sparrate). |
| U4 | Fehler sind für den Nutzer unverständlich | Technische Meldung statt Klartext, kein „warum dieser Typ?“ | Nutzer kann nicht sehen oder melden, was hakt. |

## 2. Ziel und Abnahmekriterien

Abnahme mit **originalnahen PDFs mit Textebene** (aus den Vorlagen nachgebaut, gleiche Struktur, fiktive Werte), im **echten Browser-Import** (pdf.js), in Chromium **und** mit simuliertem Worker-Ausfall:

| Dokument | Erwartet |
|---|---|
| comdirect Geschäftsabrechnung Wertpapierkauf | Typ Wertpapier › Kauf; Betrag −1.077,30 €; Geschäftstag, Valuta, WKN/ISIN, Stück, Kurs, Entgelte, Handelsplatz; Titel „Wertpapierkauf ‹Wertpapier› 1.077,30 €“; Beleg an der Girobuchung |
| comdirect Dividendengutschrift | Wertpapier › Dividende; +3,32 €; Brutto/Quellensteuer/Devisenkurs; steuerrelevant (Kapitalerträge); Beleg an der Gutschrift |
| comdirect Kosteninformation (beide) | Wertpapier › Kosteninformation; erwartete Orderkosten und laufende Kosten als Info; nie Beleg |
| MLP Reporting Konten & Depots | Wertpapier › Depot-Reporting **mit Inhalt**: Depot-Konto „MLP Vermögensdepot“, Positionen (Bezeichnung, WKN, Anteile, Kurs, Wert, Anteil %), Depotwert zum Stichtag, Liquiditätskonto, Summe Einzahlungen/Sparrate, Transaktionen des Quartals (Käufe je Fonds), Wertentwicklung → sichtbar unter Vermögen |
| comdirect Finanzreport | Kontoauszug mit Girokonto, Tagesgeld, Visa (alle Buchungen mit Vorzeichen, Salden gehen auf) **plus** Depotbestand als Bestände/Bewertung und Kontoübersicht-Salden; Konten werden mit vorhandenen comdirect-Konten (CSV) zusammengeführt |
| DKB Kontoauszug Soll/Haben | alle Buchungen, Vorzeichen aus Spalte, 51 Soll + 3 Haben = 54 = gelesen, Summen und Saldo gehen auf |
| 30+ PDFs am Stück | kein einziger Worker-Fehler; fällt ein Worker aus, läuft der Import weiter |

Zusätzlich: bestehende Tests grün, Messbasis (`npm run score`) nicht schlechter, Lint 0 Errors, Check OK.

## 3. Arbeitspakete und Team-Zuordnung

Reihenfolge: **A und B zuerst parallel** (Fundament), danach **C, D, E, F parallel**, zum Schluss **G**.

### A – PDF-Fundament / Worker (Teammitglied „Fundament“)
Dateien: `src/lib/extract/pdf.js`, `pdf-worker.js`, `extract/index.js`, `store/importer.js` (nur Fehlerbehandlung), Tests.
1. **Ein gemeinsamer pdf.js-Worker** (`new pdfjs.PDFWorker()`, als `worker` an `getDocument`) statt eines neuen Workers je Datei; bei Absturz neu erzeugen.
2. **Fake-Worker-Rückfall funktionsfähig**: Worker-Einstieg exportiert `WorkerMessageHandler` (bzw. `globalThis.pdfjsWorker` setzen), damit der Rückfall im Hauptthread wirklich liest statt abzubrechen.
3. **Wiederholung**: Scheitert das Öffnen mit Worker-Fehler → Worker neu starten, Datei einmal neu versuchen; erst dann Fehler.
4. Fehlertext in Klartext („PDF-Leser neu gestartet …“ bzw. „PDF konnte nicht gelesen werden: …“).
5. Browser-Test: 30+ PDFs am Stück; zusätzlich Worker-Ausfall simulieren (z. B. `Worker`-Konstruktor wirft ab Datei 5) → Import muss vollständig durchlaufen. „Nach Update neu einlesen“ läuft danach erneut für zuvor gescheiterte Dateien.

### B – Originalnahe Testdokumente (Teammitglied „Vorlagen“)
Dateien: `scripts/make-real-like-pdfs.py` (reportlab, nur Entwicklung), `tests/fixtures/real-like/*.pdf`, Extrakt-Snapshots `tests/fixtures/real-like/*.json`.
1. Die 7 Dokumentarten **mit Textebene** nachbauen – gleiche Seitenaufteilung, Spalten, Schriftarten (comdirect-Abrechnung in Courier/Monospace, Finanzreport und Kosteninformation proportional, MLP mit Tabellen, DKB mit Spalten Soll/Haben und 6 Seiten), fiktive Namen/Nummern, plausible Beträge (Salden gehen auf, 51/3 Buchungen).
2. Diese PDFs mit **dem echten pdf.js-Pfad der App** (`extractPdfText` im Node-Legacy-Build) in Seiten/Zeilen/Items umwandeln und als JSON-Snapshots speichern – das ist die Form, die beim Nutzer tatsächlich ankommt.
3. Öffentliche Referenztexte zu comdirect- und DKB-Abrechnungen (Portfolio Performance, Testdateien) nur **lokal** zum Abgleich von Formulierungsvarianten nutzen (Lizenz: nicht ins Repo kopieren), Varianten in die eigenen Vorlagen übernehmen (z. B. „ABRECHNUNG VOM“, „Börsenplatz“ statt „Ausführungsplatz“, „Zu Ihren Lasten“ ohne „vor Steuern“, Teilausführungen).

### C – Wertpapier-Abrechnungen auf Textebene (Teammitglied „Wertpapier“)
Dateien: `detect/index.js`, `parsers/docs/securities.js`, `parsers/docs/known.js`, Tests.
1. Erkennung und Parser gegen die B-Snapshots (Textebene) **und** die OCR-Vorlagen; alle Formulierungsvarianten aus B.3.
2. Abgrenzung Steuerbescheinigung robust: Abrechnung mit Steuerseite („Steuerliche Behandlung“, Kapitalertragsteuer 0,00, Verrechnungssalden) bleibt Wertpapier; Verneinung auch gesperrt/gespreizt geschrieben („K E I N E  S T E U E R …“).
3. Kosteninformation: Kosten je Position, Summe, Renditeminderung %, Haltedauer – als Info-Felder.
4. Saubere Titel (kein OCR-Rauschen wie „al a“, „1 3,32“): Wertpapiername nur, wenn er plausibel ist.

### D – Depot-Reporting und Bestände (Teammitglied „Depot“)
Dateien: neuer Parser `parsers/statements/pdf-depotreport.js` (MLP, comdirect-Finanzreport-Depotteil), Anbindung in `parsers/statements/index.js`, ggf. `views/Assets.svelte`, Tests.
1. MLP Reporting: Depotkonto + Liquiditätskonto anlegen, Positionen als `holdings` (Bezeichnung, WKN/ISIN, Anteile, Kurs, Kursdatum, Wert, Anteil %), Bewertung (`valuations`) zum Stichtag, Kennzahlen (Einzahlungen, Sparrate, Ausschüttungen, Depotentgelt, Gesamtergebnis) als Felder, Transaktionsübersicht als Depot-Buchungen (Kauf je Fonds, Betrag, Anteile, Preis).
2. comdirect Finanzreport: Depotbestand → `holdings` + Bewertung; Kontoübersicht → Salden je Konto; Steuerübersicht → Felder (Verlustverrechnungstöpfe, Freibetrag).
3. Abstimmung mit E: der Finanzreport liefert Konten **und** Bestände aus einem Dokument (mehrere Ergebnisse).
4. Vermögen-Ansicht zeigt Depot mit Positionen, Stand und Entwicklung; Doppelzählung vermeiden (Sparplan-Abbuchung vom Giro = Umbuchung ins Depot).

### E – Kontoauszüge auf Textebene (Teammitglied „Kontoauszug“)
Dateien: `parsers/statements/pdf-statement.js`, `pdf-finanzreport.js`, `common.js`, Konto-Zusammenführung in `store/importer.js` (nur Konto-Abgleich), Tests.
1. DKB Soll/Haben mit echten x-Positionen aus B (mehrzeilige Erläuterungen, Betrag in der ersten oder letzten Zeile, Seitenumbrüche, „Kontostand am“, „Gesamtumsatzsummen“).
2. comdirect Finanzreport auf Textebene: Spalten Buchungstag/Valuta, Vorgang, Buchungstext, Ausgang/Eingang; Girokonto, Tagesgeld, Visa.
3. Konten aus Finanzreport/PDF mit bestehenden comdirect-/DKB-Konten zusammenführen (IBAN, sonst Bank + Kontoart + Kontonummer-Endung).

### F – Transparenz und Fehlermeldungen (Teammitglied „Transparenz“)
Dateien: `views/DocViewer.svelte`, `views/Documents.svelte`, `views/Sources.svelte`/`ProgressBar.svelte`, `detect/index.js` (nur Ausgabe der Punktwerte).
1. „Warum dieser Typ?“ im Dokument: die drei besten Typen mit Punkten und den auslösenden Wörtern.
2. „Erkennungsbericht kopieren“: Textstruktur des Dokuments **anonymisiert** (Ziffern → 0, Namen/IBAN ausgeblendet, Schlüsselwörter bleiben) – damit können echte Problemfälle ohne persönliche Daten weitergegeben werden.
3. Importfehler in Klartext mit nächstem Schritt („Neu einlesen“), Sammelanzeige „N Dateien nicht gelesen – erneut versuchen“.

### G – Integration und Abnahme (ich)
1. Branches zusammenführen, Konflikte lösen, Gesamttests, Messbasis.
2. Abnahmetest aus Abschnitt 2 im Browser mit allen B-Vorlagen + den 9 Originalen (Scan) + Worker-Ausfall.
3. Neueinlesen nach Update (Parser-Version 5): alle bisher gescheiterten Dateien und alle Wertpapier-/Kontoauszug-/Finanzreport-Dokumente; Nutzerentscheidungen bleiben.
4. Build, Push, kurze Anleitung für den Nutzer (was er prüfen soll, wie er einen Erkennungsbericht schickt).

## 4. Risiken
- Die echte Textebene kann trotz Nachbau abweichen → F.2 liefert echte, anonymisierte Strukturen für die schnelle Nachbesserung.
- Firefox ist hier nicht installiert → Worker-Ausfall wird in Chromium simuliert; der Rückfallweg (Fake-Worker) wird ausdrücklich getestet.
