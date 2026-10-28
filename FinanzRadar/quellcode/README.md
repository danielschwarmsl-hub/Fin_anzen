# FinanzRadar

Ordner rein – fertig sortiert. FinanzRadar liest Kontoauszüge, Kassenbons, Rechnungen, Lohnabrechnungen, Depot-, Versicherungs- und Rentenunterlagen aus und zeigt, wo das Geld herkommt und hinfließt. Alles läuft lokal im Browser.

## Starten

| System | So geht's |
| --- | --- |
| macOS | Doppelklick auf **FinanzRadar starten (Mac).command** (beim ersten Mal: Rechtsklick → Öffnen) |
| Windows | Doppelklick auf **FinanzRadar starten (Windows).bat** |

Der Browser öffnet `http://localhost:8765`. Das Fenster des Start-Skripts offen lassen. Empfohlen: Chrome oder Edge (Ordner lassen sich dort erneut scannen); Firefox funktioniert per Ordner-Auswahl und Drag & Drop.

## Erste Schritte

1. **Quellen** – Ordner wählen, Dateien hineinziehen oder Dropbox/Google Drive verbinden. Zum Ausprobieren: „Mit Beispieldaten ausprobieren“.
2. **Verarbeiten** – Text, Scans (OCR), CSV, Excel, camt/MT940, E-Rechnungen werden gelesen, erkannt, benannt und kategorisiert.
3. **Prüfen** – nur unsichere Fälle bestätigen (Tasten J/K, 1–9).
4. **Überblick** – Geldfluss, Kostenverteilung, Abos, Vermögen, Steuern & Abgaben. Suche mit Strg/⌘ + K.

Steuerrelevante Belege werden als „ggf. steuerrelevant“ markiert und unter **Steuer** als ZIP exportiert.

## Unterstützte Formate (Auswahl)

- Banken: ING, comdirect, Renault Bank direkt, PayPal, DKB, Sparkasse, N26 u. a. – CSV, PDF, camt.052/053, MT940; unbekannte CSV per Spalten-Zuordnung
- Belege: PDF, Fotos/Scans (JPG, PNG, HEIC, TIFF), ZUGFeRD/XRechnung
- Depot, Steuerbescheinigung, Lohnsteuerbescheinigung, Privatrente (z. B. Allianz), BU, Versicherungen, Spendenquittungen, Verträge

## Lokale KI (optional)

1. [Ollama](https://ollama.com/download) installieren und starten.
2. Modell laden, z. B. `ollama pull qwen3:4b` (Mac mit Apple Silicon ≥ 16 GB: `qwen3:8b`; optional für Bon-Fotos `ollama pull qwen2.5vl:7b`).
3. In FinanzRadar → Einstellungen → Lokale KI → „KI nutzen“.

Die KI klärt nur unsichere Fälle, eine kleine Aufgabe pro Aufruf. Dauert ein Lauf länger als 6 Minuten, schlägt FinanzRadar ein kleineres Modell vor. „No Thinking“ ist standardmäßig aktiv (schneller).

**Nur lokal:** Als Ollama-Adresse sind ausschließlich `localhost`, `127.0.0.1` und `[::1]` erlaubt (http/https, beliebiger Port). Andere Adressen werden nicht aufgerufen.

Was die KI automatisch tut (mit „Nach Import automatisch“):
- beim Import: unsicher erkannte Belege einordnen und fehlende Felder (Datum, Betrag, Aussteller, MwSt) ergänzen – Vorhandenes wird nie überschrieben,
- danach: unsichere Buchungen kategorisieren, Steuer-Hinweise geben, Bon-Positionen lesen (Bild-Modell) und Belegtreffer einschätzen (nur Hinweis, bestätigt wird nie automatisch).

Jede KI-Antwort wird geprüft: Beträge müssen im Belegtext stehen, Datum muss gültig sein, Positionen müssen zur Summe passen (±2 ct), MwSt nur 0/7/19 %, keine Umbuchungen, Einnahme/Ausgabe passend zum Vorzeichen. Jedes Ergebnis trägt eine kurze Begründung. Hohe Sicherheit wird übernommen, mittlere landet zusätzlich in der Prüfliste, niedrige bleibt ein Vorschlag. KI-Steuermarkierungen bleiben, bis du entscheidest.

## Dropbox / Google Drive (optional)

Unter Quellen → Dropbox bzw. Google Drive den eigenen App-Key / die Client-ID eintragen. Die Schritt-für-Schritt-Anleitung steht aufklappbar im Dialog.

## Datenschutz

Keine Server, kein Konto. Daten liegen in der Browser-Datenbank dieses Profils. Backup/Wiederherstellen und „Alle Daten löschen“ unter Einstellungen. Die Steuer-Markierung ist keine Steuerberatung.

## Entwicklung

```
npm install
npm run dev        # Entwicklungsserver
npm test           # Vitest (Parser, Analyse, KI-Client)
npm run build      # statischer Build nach dist/
```

Beispieldaten (fiktiv): `samples/generate.py` → `samples/out/`.
