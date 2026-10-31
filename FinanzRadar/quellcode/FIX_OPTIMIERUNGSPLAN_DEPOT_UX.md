# Fix- und Optimierungsplan: Depot, Vermögen, Verläufe, Verträge, Suche

Stand: 31.10.2026 · Grundlage: Rückmeldung des Nutzers (Punkte 1–7) und Code-Analyse.

## Befunde und Ursachen

| # | Rückmeldung | Ursache im Code (Analyse) |
|---|---|---|
| 1 | Depotkauf wird als „ausgegeben“ gezählt, comdirect-Konto „im Minus“ | Kauf erscheint zweimal: als Abbuchung auf dem Girokonto und als Depotumsatz. Ohne erkannte Gegenbuchung (Umbuchung Giro → Depot) zählt die Girobuchung je nach Kategorie als Ausgabe; Kontostände ohne Saldo-Anker (CSV ohne Kontostand) werden nur aus Umsätzen aufsummiert und rutschen ins Minus. Depot-Umsätze selbst ändern den Depotwert nicht (`analyze/networth.js`), tauchen aber in Listen/Auswertungen als negative Beträge auf. |
| 2 | Kontoart-Auswahl auf der Kachel, Kachel springt danach weg | `views/Assets.svelte`: Dropdown direkt auf jeder Kachel; die Gruppen (Girokonten, Tagesgeld, Depots …) werden aus der Kontoart gebildet – ändert man sie, wandert die Kachel ohne Hinweis in eine andere Gruppe. |
| 3 | Depotüberblick: Gesamt-Plus sehen, Liste sortieren | Positionen sind fest nach Wert sortiert; Gesamt-Gewinn/Verlust (Kurswert − Kaufwert bzw. Wert − Einzahlungen) wird nicht als Kopfzahl gezeigt. |
| 4 | MLP-Depot zeigt z. B. 1.000 € mit +2.000 € – Werte vermischt, es gibt zwei Depots | MLP-Parser nimmt **ein** Depot je Reporting an; das Reporting („Konten und Depots“) kann mehrere Depots enthalten → Positionen/Kennzahlen mehrerer Depots landen in einem Konto. Kennzahlen (Gesamtergebnis, Einzahlungen) des Reports werden neben Summen aus Positionen gezeigt, die zu einem anderen Depot/Stichtag gehören. |
| 5 | Verläufe interaktiver: Hoch, Kursverlust vs. Verkauf erkennen | Verlauf ist eine reine Monatslinie des Gesamtwerts; keine Ereignisse (Käufe, Verkäufe, Einzahlungen, Dividenden), keine Zerlegung in Marktentwicklung und Geldflüsse, kein Tooltip je Punkt. |
| 6 | Vertrag „13× gebucht“, tatsächlich 1 Buchung (und storniert) | `analyze/recurring.js`: Gruppenbildung über Gläubiger-ID/Mandat – bei PayPal-Lastschriften tragen alle Einkäufe dieselbe Gläubiger-ID/dasselbe Mandat → verschiedene Käufe landen in einer „Serie“; Stornopaare (`stornoPairId`) werden nicht herausgenommen; `count` zählt die ganze Gruppe. |
| 7 | Suche mit mehreren Begriffen liefert zu viel | `store/search.js`: Orama-Suche mit allen Begriffen als ein Suchtext → ein Treffer auf **irgendeinen** Begriff genügt (ODER), dazu Tippfehler-Toleranz ab 5 Zeichen. |
| 0 | „error loading dynamically imported module … pdf-polyfills-….js“ | Nach einem Update hält der Browser die alte Seite; die nachgeladenen Dateien heißen im neuen Build anders → Ladefehler. |

## Arbeitspakete und Team

Reihenfolge: P0, P1, P4, P5 sofort parallel (unabhängig); P2 nach P1 (gleiche Ansicht); P3 nach P1 (braucht saubere Depotdaten).

### P0 – Update-Sicherheit (ich)
- Ladefehler nachgeladener Module abfangen (`vite:preloadError` / dynamischer Import): Hinweis „Neue Version verfügbar – neu laden“ bzw. einmal automatisch neu laden.
- Start-Server: `index.html` ohne Cache ausliefern, gehashte Dateien lange cachen.

### P1 – Depot-Logik und Kennzahlen (Teammitglied „Depot-Logik“) – Punkte 1 und 4
1. Nachstellen mit Testdaten: comdirect Giro-CSV + Depot-CSV + Wertpapierabrechnungen + Finanzreport; MLP-Reporting + DKB-Sparplan-Abbuchung.
2. Wertpapierkauf/-verkauf auf dem Girokonto: immer Sparen/Entnahme (nie Ausgabe), mit vorhandenem Depot desselben Instituts als **Umbuchung ins Depot** verbinden (comdirect Giro ↔ comdirect Depot, MLP-Sparplan ↔ MLP Vermögensdepot; Zuordnung über Institut statt „genau ein Depot“).
3. Depotumsätze (Kauf/Verkauf im Depot) nie als Einnahme/Ausgabe zählen und in Listen klar als „Depotumsatz“ kennzeichnen.
4. Kontostand: Saldo-Anker aus Auszügen/Finanzreport/Kontoübersicht bevorzugen; fehlt ein Anker, kein „Minus“ aus unvollständigen Umsätzen vortäuschen (Hinweis „Kontostand unbekannt – Auszug importieren“).
5. MLP-Reporting mit **mehreren Depots**: je Depotnummer eigenes Konto, eigene Positionen, eigene Kennzahlen; Liquiditätskonto eindeutig zuordnen.
6. Kennzahlen je Depot eindeutig und nicht vermischt: Wert, Einstand/Kaufwert, Gewinn/Verlust (€, %), Einzahlungen, Auszahlungen, Erträge – jeweils mit Quelle und Stichtag; Werte aus verschiedenen Depots/Stichtagen nie in eine Zahl.

### P2 – Vermögen-Ansicht (Teammitglied „Vermögen-UX“) – Punkte 2 und 3
1. Kontoart nicht mehr als Dropdown auf der Kachel: „⋯“-Menü „Konto bearbeiten“ (Name, Kontoart, eigenes Konto, ausblenden). Nach Änderung der Kontoart: Kachel bleibt sichtbar markiert, Hinweis „verschoben nach Depots“, Ansicht scrollt mit.
2. Depotüberblick: Kopf mit Gesamtwert, Einstand, **Gewinn/Verlust gesamt (€ und %)**, Erträge; je Depot dieselben Zahlen.
3. Positionsliste sortier- und filterbar (Name, Wert, Anteil, Gewinn/Verlust €, %, Anlageklasse/Region), Gruppieren nach Depot oder Anlageklasse, Sortierung merken.
4. Positionen über mehrere Depots zusammenfassen (gleiche ISIN) als Option.

### P3 – Interaktive Verläufe (Teammitglied „Verläufe“) – Punkt 5
Brainstorming (umzusetzen in dieser Reihenfolge):

**Muss**
- Tooltip je Punkt: Datum, Wert, Veränderung zum Vormonat, und **woraus sie besteht**: Marktentwicklung vs. Einzahlungen/Käufe vs. Auszahlungen/Verkäufe vs. Erträge.
- Zwei Linien: **Wert** und **eingezahltes Kapital** (Einstand) – die Fläche dazwischen ist Gewinn/Verlust. So sieht man sofort, ob der Wert fällt, weil Kurse fallen, oder weil verkauft/entnommen wurde.
- Ereignis-Markierungen auf der Zeitachse: Kauf, Verkauf, Sparplan, Dividende, Ein-/Auszahlung (Symbole; Klick zeigt die Buchung/Abrechnung).
- Hoch und Tief im Zeitraum markieren, Abstand vom Hoch („−8 % vom Höchststand am …“).
- Zeitraum wählbar (1M, 3M, YTD, 1J, 3J, max) und per Ziehen markieren → Auswertung genau dieses Zeitraums.

**Soll**
- Wasserfall „Was hat sich verändert?“: Startwert → + Einzahlungen → − Entnahmen → ± Kursentwicklung → + Erträge → Endwert.
- Rendite zweifach: zeitgewichtet (Leistung der Anlagen) und geldgewichtet (eigene Rendite inkl. Zeitpunkte) mit Erklärung per Tip.
- Verlauf je Position (Klick auf Position): Stück, Kurs, Wert, Einstand über die Zeit; Käufe/Verkäufe als Punkte.
- Vergleich der Depots untereinander (normiert auf 100) und Anteil am Gesamtvermögen über die Zeit (gestapelte Fläche).
- Datenlücken ehrlich zeigen (gestrichelt zwischen zwei Stichtagen, „kein Stand zwischen … und …“).

**Kann**
- Drawdown-Kurve (Abstand vom jeweiligen Hoch).
- Monats-/Jahresrendite als Kacheln (Heatmap).
- „Was wäre wenn“: Sparrate weiterlaufen lassen, Prognose-Korridor.
- Hinweise: „Wert gesunken, aber 1.200 € Verkauf am 03.03. – Kursentwicklung +2 %“.

### P4 – Verträge und Abos (Teammitglied „Verträge“) – Punkt 6
1. Stornopaare und Rückbuchungen aus Serien nehmen (zählen nicht als Zahlung; Hinweis „1 Rückbuchung“).
2. Keine Serienbildung allein über Gläubiger-ID/Mandat von Zahlungsdiensten (PayPal, Klarna, Amazon Payments …) – dort zählt der Händler aus dem Verwendungszweck.
3. „13× gebucht“ = exakt die verknüpften Buchungen; Klick öffnet genau diese Buchungen in der Buchungsliste.
4. Plausibilität: Serie nur bei passendem Rhythmus und ähnlichem Betrag; Einzelbuchung nur als „möglicher Vertrag“ (Prüfliste), nicht als bestätigtes Abo.

### P5 – Suche (Teammitglied „Suche“) – Punkt 7
1. Mehrere Begriffe = **alle** müssen vorkommen (UND), in beliebigen Feldern (Gegenpartei, Zweck, Kategorie, Betrag, Konto).
2. Tippfehler-Toleranz nur, wenn ein Begriff sonst nichts findet; Wortanfang zählt („tele“ → Telekom).
3. Reihenfolge: Gegenpartei-Treffer vor Zweck-Treffern, exakte Wörter vor ähnlichen.
4. Optional „oder“: `netflix | spotify`; Ausschluss: `-paypal`; Phrase: `"amazon prime"` (vorhanden, prüfen).
5. Trefferzahl und gefundene Begriffe anzeigen; Treffer markieren.

### G – Integration und Abnahme (ich)
- Zusammenführen, Gesamttests, Messbasis; Browser-Abnahme mit Testdaten (comdirect Giro + Depot + Abrechnungen, MLP mit zwei Depots, PayPal-Abo-Fall mit Storno, Suchbeispiele).
- Build, Push, kurze Prüfanleitung.

## Abnahmekriterien
1. Wertpapierkauf über 1.077,30 €: Ausgaben unverändert, Sparen +1.077,30 €, comdirect-Girokonto nicht künstlich im Minus, Depot +Position.
2. Kontoart ändern: Kachel springt nicht unbemerkt; Änderung nur über „Konto bearbeiten“.
3. Depotüberblick zeigt Gesamt-Gewinn/Verlust; Positionen nach jeder Spalte sortierbar.
4. MLP-Reporting mit zwei Depots → zwei Depotkonten mit getrennten Werten und Kennzahlen; keine Summe aus beiden in einer Kachel.
5. Verlauf: Tooltip mit Zerlegung, Linie „eingezahlt“, Ereignis-Markierungen, Hoch/Tief.
6. Vertrag mit 1 Buchung + Storno: kein „13× gebucht“; Anzahl = verknüpfte Buchungen, anklickbar.
7. Suche „telekom 2026“ bzw. „amazon prime“: nur Buchungen, die alle Begriffe enthalten.
