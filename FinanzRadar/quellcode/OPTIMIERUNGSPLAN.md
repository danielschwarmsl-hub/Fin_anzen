# FinanzRadar – Optimierungsplan: Erkennung, Zuordnung, Überlappungen

Grundlage: Brainstorming mit vier Subagenten (Okt. 2026), gegen den Code geprüft.
Pfade relativ zu `src/lib/`. Status: **geprüft** = Stelle im Code gelesen und bestätigt, **abgeleitet** = plausibel aus dem Code, nicht ausgeführt.

## Leitbild: automatisch entscheiden, sichtbar machen, leicht korrigieren, aus Korrekturen lernen

Die App soll möglichst viel selbst erledigen. Der Nutzer greift nur ein, wo Geld oder Steuer wirklich betroffen ist.

| Sicherheit | Verhalten | Sichtbarkeit |
|---|---|---|
| hoch | automatisch übernehmen | still, im Detail erklärbar („Warum?“) |
| mittel | automatisch übernehmen, aber markiert | gesammelt in der Prüfliste, Bestätigen mit einem Klick |
| niedrig | nur Vorschlag, keine Wirkung auf Summen | Prüfliste, sortiert nach Geldwirkung |

Regeln dazu:
1. **Nutzerentscheidungen sind endgültig.** Kein automatischer Lauf darf sie überschreiben.
2. **Jede Korrektur lehrt.** Zwei gleiche Korrekturen erzeugen automatisch eine Regel (mit Trefferzahl-Vorschau und Rückgängig).
3. **Eine Prüfliste statt verstreuter Hinweise.** Sortiert nach Euro-Wirkung, mit Sammelaktion „alle ähnlichen bestätigen“.
4. **Nichts verschwindet still.** Übersprungene Dubletten, ignorierte Dateien und unsichere Paare werden im Importbericht gezählt.

## Bewertung des Brainstormings

### Übernommen (sinnvoll, belegt)

| # | Befund | Stelle | Status |
|---|---|---|---|
| 1 | Vorsteuer doppelt: unverknüpfter Beleg und Buchung zählen beide | `analyze/vat.js:42–56` | geprüft |
| 2 | Belegsperre greift nie, `receiptSource` wird nie geschrieben; gelöste Verknüpfungen kehren zurück, veraltete bleiben | `analyze/receipts.js:28,35`, `store/postprocess.js:95` | geprüft |
| 3 | Regel-`contains` ist Teilstring („ING“ trifft „Shopping“) | `classify/rules.js:131–140` | geprüft |
| 4 | Bestätigen ohne Änderung wird nicht als Nutzerentscheidung gespeichert | `views/Review.svelte:111`, `classify/rules.js:248` | teilweise geprüft |
| 5 | Menge wird aus der Betragsspalte gelesen | `parsers/docs/invoice.js:149–150` | geprüft |
| 6 | Bilder ohne erkannten Text werden `ignored` und beim Re-Import übersprungen | `detect/index.js:156`, `store/importer.js:163,207` | geprüft |
| 7 | KI-URL wird nicht auf localhost beschränkt | `ai/ollama.js:3`, `ai/engine.svelte.js:29` | geprüft |
| 8 | `aiHooks.detect`/`aiHooks.parse` werden nie gesetzt (toter Code) | `store/importer.js:203–213`, `ai/engine.svelte.js:256–259` | geprüft |
| 9 | KI-Steuerflags werden überschrieben (`isLocked` kennt `ai` nicht) | `classify/taxFlags.js:19` | geprüft |
| 10 | Übersprungene Dubletten werden nicht gezählt | `store/importer.js:300–313` | geprüft |
| 11 | PayPal-Zeilen in Fremdwährung werden verworfen | `parsers/statements/csv-paypal.js:83` | geprüft |
| 12 | Belegzuordnung nur 1:1 und gierig, Score wird verworfen | `analyze/receipts.js:56–74` | geprüft |
| 13 | Konto ohne IBAN wird mit fremdem Konto derselben Bank zusammengeführt | `store/importer.js:240–242` | abgeleitet |
| 14 | Einseitig gesetzte Umbuchung: Gegenseite zählt als Einkommen | `views/TxDrawer.svelte:74`, `classify/rules.js:232–233` | abgeleitet |
| 15 | Kartenabrechnung ohne Namens-/IBAN-Treffer zählt doppelt | `analyze/transfers.js:142–153` | abgeleitet |
| 16 | PayPal-Mischzahlung (Guthaben + Einzug) wird nicht gepaart | `analyze/transfers.js:69–100` | abgeleitet |
| 17 | Unsichere Typerkennung setzt kein `needsReview` | `detect/index.js:158–168` | abgeleitet |
| 18 | Summenzeilen („Gesamt“, „Zwischensumme“) können Positionen werden | `parsers/docs/invoice.js`, `receipt.js` | abgeleitet |
| 19 | OCR-Kassenbon: Preis und Name in getrennten Zeilen gehen verloren | `parsers/docs/util.js:28–37` | abgeleitet |
| 20 | KI-Werte (Betrag, Datum, Positionen, MwSt) werden kaum validiert | `ai/engine.svelte.js:199–225` | abgeleitet |
| 21 | KI darf `umbuchung` vergeben, Vorzeichen wird nicht geprüft | `ai/engine.svelte.js:181–183` | teilweise geprüft |
| 22 | Dedupe-Test prüft eine Kopie der Logik, nicht den Importer | `tests/realworld.test.js:46–83` | abgeleitet |
| 23 | `EXPECTED.json` ist keine vollständige Soll-Basis | `samples/out/EXPECTED.json` | abgeleitet |

### Angepasst (Richtung stimmt, Vorschlag widerspricht dem Automatisierungsziel)

- **Umbuchungspaare ohne Hinweis nur vorschlagen** → stattdessen weiter automatisch paaren, aber als „mittel sicher“ markieren und **nicht** aus Steuer-Flag und USt-Schätzung nehmen, bis bestätigt. Sonst entsteht viel Handarbeit.
- **`needsReview` bei unsicherem Typ** → nur bei echtem Abstand-Problem und gebündelt in der Prüfliste, sonst flutet sie.
- **Positionen als Split vorbelegen** → nur automatisch, wenn Positionen eindeutig in zwei Kategorien fallen und die Summe exakt passt; sonst als Vorschlag.
- **Tierarzt-Regex** → richtig (Tierarztkosten sind keine Krankheitskosten), aber niedrige Priorität.

### Zurückgestellt (geringer Nutzen)

- Einkaufszettel zerlegen (kein Geldbezug).
- Wortstämme „euro“/„reis“ schärfen – erst wenn die Messbasis Fehlerkennungen zeigt.
- Race-Condition in `saveResult` – erst beheben, wenn ein Test sie reproduziert.
- PDF-Vorzeichen-Einzelfehler lokalisieren – nach Phase 4, falls Auszüge mit Soll/Haben auftauchen.

## Kategorien

| Kategorie | Befunde |
|---|---|
| A. Korrekte Summen (keine Doppelzählung) | 1, 11, 13, 14, 15, 16, Depot-Käufe |
| B. Vertrauen & Lernen | 2, 3, 4, 9 |
| C. Erkennung & Posten | 5, 6, 17, 18, 19 |
| D. Zuordnung & Verknüpfung | 12, Zahlungskette, Verträge, Splits, Outlook |
| E. KI absichern | 7, 8, 20, 21 |
| F. Messbarkeit | 10, 22, 23 |
| G. User Experience | Prüfliste, Importbericht, „Warum?“-Erklärungen |

## Plan

### Phase 0 – Messbasis (Voraussetzung für alles)
Ziel: Jede Änderung wird messbar, Regressionen fallen sofort auf.
- `EXPECTED.json` um App-Typ, Beträge, Kategorie je Buchung und Dublettenbezug erweitern.
- Skript `npm run score`: Trefferquote je Bereich (Typ, Betrag, Positionen, Kategorie, Dubletten, Umbuchungen).
- Neue Beispieldateien: PayPal-Mischzahlung, PayPal-USD-Kauf, PayPal-Einzug mit Bankgegenbuchung, Depot-Kauf (Giro + Depot-Umsatz), CSV+PDF-Überlappung desselben Kontos, Konto ohne IBAN, Storno + Erstattung.
- Dedupe-Test gegen den echten Importer (`saveResult` mit Fake-DB).

### Phase 1 – Korrekte Summen und Nutzerentscheidungen (Quick Wins, je Aufwand S)
- Vorsteuer: Beleg nur zählen, wenn keine passende Buchung existiert (1).
- Belegsperre: `receiptSource: 'user'` beim Verknüpfen/Lösen setzen, abgelehnte Beleg-ID merken, verwaiste Auto-Links entfernen (2).
- Bestätigen = Nutzerentscheidung für Kategorie, Steuer-Flag und Umbuchung (4); `ai` in `isLocked` (9).
- Regeln mit Wortgrenzen (3).
- Rechnungsmenge nur aus echter Mengenspalte, sonst 1; Plausibilität Menge × Preis = Gesamt (5).
- Summenzeilen als Endmarke der Positionsliste (18).
- Kartenabrechnung ohne Paar umbuchen, wenn genau ein Kreditkartenkonto existiert (15).
- KI-URL auf localhost/127.0.0.1/[::1] begrenzen (7); `umbuchung` aus KI-Kategorien, Vorzeichen prüfen (21).

### Phase 2 – Prüfliste und Importbericht (UX-Kern)
- **Eine Prüfliste** für alles Unsichere: Kategorien, Belegtreffer, Umbuchungspaare, unlesbare Belege, unsichere Dokumenttypen. Sortierung nach Geldwirkung; jede Karte zeigt den Grund in einem Satz.
- **Sammelaktionen**: „Alle ähnlichen bestätigen“, „Regel daraus machen“ mit Trefferzahl.
- **Automatisches Lernen**: zwei gleiche Korrekturen → Regel vorschlagen, nach Bestätigung dauerhaft; Rückgängig jederzeit.
- **Importbericht**: neu / Dubletten übersprungen / ergänzt / ignoriert / braucht dich (10).
- **„Warum?“ im Detail** jeder Buchung: Quelle der Kategorie, Paar-Begründung, Belegtreffer mit Score.
- Unlesbare Belege nicht ignorieren, sondern mit „Neu prüfen“ (zweiter OCR-Lauf, höhere Auflösung) in die Prüfliste (6).

### Phase 3 – Überlappungen zwischen Konten
- **Zahlungskette** als Konzept: Beleg → PayPal-Zeile → Bankeinzug. Nur ein Glied zählt als Ausgabe; die Kette ist im Detail sichtbar.
- PayPal-Mischzahlung: Bankeinzug mit Teilbetrag einer PayPal-Zahlung zuordnen (Zugehöriger Transaktionscode, Zeitfenster) (16).
- PayPal-Fremdwährung: Zeile übernehmen, Betrag aus der EUR-Umrechnungszeile; Händler bleibt erhalten (11).
- Depot: Sparplan-/Wertpapierkauf als Sparen buchen; Giro-Seite und Depot-Umsatz paaren.
- Storno-/Erstattungspaare erkennen (Zahlung + Gutschrift heben sich auf).
- Einseitige Umbuchung im Drawer: Gegenbuchung vorschlagen und beide Seiten setzen (14).
- Konto-Zusammenführung nur bei passender Nummer/Name, sonst neues Konto + Hinweis (13).

### Phase 4 – Zuordnung ausbauen
- Belegtreffer speichern Score und Abstand zum Zweitbesten; knappe Fälle → Prüfliste (12).
- n:m-Zuordnung: Sammelbelege (mehrere Belege → eine Buchung) und Teilzahlungen per Teilsummensuche im Zeitfenster und beim selben Händler; Konflikte global statt gierig lösen.
- Eindeutige Referenzen stärker nutzen: Bestellnummer, Mandatsreferenz, End-to-End-ID.
- Verträge mit Zahlungsserien verbinden; „Vertrag ohne Zahlung“ anzeigen.
- Positionen eines verknüpften Belegs als Split vorbelegen (siehe Anpassung oben).
- OCR-Kassenbons: Preis- und Namenszeilen nach Y-Position zusammenführen (19).
- Unsichere Typerkennung gebündelt markieren, Zweitbester Typ als Alternative (17).

### Phase 5 – KI als stiller Helfer
- KI-Ausgaben validieren: Betrag muss im Text vorkommen, Datum per Round-Trip, Positionssumme ±2 ct, MwSt nur 0/7/19 (20).
- Entscheidung zu `aiHooks.detect`/`parse`: anschließen (Typ- und Parse-Fallback bei niedriger Sicherheit) oder entfernen (8).
- KI-Ergebnisse immer mit Begründung, mittlere Sicherheit → Prüfliste.

### Phase 6 – Outlook / E-Mail-Belege
- Stufe A: `.eml`-Import über die Ordner-Quelle. Mailtext als Beleg (Bestellbestätigung), Anhänge durch die bestehende Pipeline. Dubletten (Bestätigung, Versand, Rechnung zur selben Bestellung) über Bestellnummer zusammenfassen.
- Stufe B (optional): Microsoft Graph mit OAuth2/PKCE wie bei Dropbox, Scope `Mail.Read`, nur ein gewählter Ordner. Erfordert Azure-App-Registrierung und Anpassung des Hinweises „Alles bleibt auf diesem Gerät“.

## Erfolgsmessung
- Trefferquoten aus `npm run score` je Phase (Ziel: keine Verschlechterung, sichtbare Verbesserung im jeweiligen Bereich).
- Anzahl offener Prüffälle nach einem Standard-Import (Ziel: sinkt mit jeder Phase).
- Keine Doppelzählung in den neuen Beispielfällen (Summen, Netto, Sparquote, Vorsteuer).

## Offene Entscheidungen
1. KI-Hooks für Typerkennung und Parsing anschließen oder entfernen?
2. Outlook: nur `.eml`-Import oder zusätzlich Live-Anbindung (Microsoft 365 oder Outlook.com)?
3. Steuerliche Einordnung von Tierarztkosten bestätigen.
