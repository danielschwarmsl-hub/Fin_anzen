# Plan: Erkennung Bank-/Depot-Dokumente (7 echte, geschwärzte Beispiele)

Testvorlagen: `tests/fixtures/real-ocr/*.json` (OCR-Text je Seite, so wie die App ihn bei Scans erzeugt).

## Ausgangslage (Ist-Erkennung)
| Dokument | Ist | Soll |
|---|---|---|
| comdirect Finanzreport (5 S.: Giro, Tagesgeld, Visa, Depotbestand, Steuerübersicht) | Sonstiges Finanzdokument | Kontoauszug (Finanzreport), Buchungen je Konto, Depotbestand als Info |
| comdirect Dividendengutschrift (Microsoft, 3,32 EUR) | Rechnung (!) | Wertpapier › Dividende, Betrag +3,32 €, Valuta 14.09.2026 |
| comdirect Kosteninformation zum Wertpapiergeschäft (2×) | Sonstiges | Wertpapier › Kosteninformation (nur Info, keine Zahlung, kein Beleg-Abgleich) |
| MLP Reporting Konten & Depots (Vermögensdepot) | Sonstiges, „Typ unsicher“ | Wertpapier › Depot-Reporting (Info) |
| comdirect Geschäftsabrechnung Wertpapierkauf (1.077,30 EUR) | Steuerbescheinigung (wegen „KEINE STEUERBESCHEINIGUNG“!) | Wertpapier › Kauf, −1.077,30 €, Valuta 21.08.2026, Beleg zur Girobuchung |
| DKB Kontoauszug mit Spalten „Betrag Soll EUR | Betrag Haben EUR“ | Sonstiges | Kontoauszug; Vorzeichen aus Spalte; „Gesamtumsatzsummen … Anzahl 51 / 3“ als Vollständigkeitsprüfung; bei fehlenden Beträgen klare Meldung |

## Arbeitspakete (Team)
1. **Kontoauszüge** (`parsers/statements/*`): DKB Soll/Haben-Layout (Spalte bestimmt Vorzeichen; Kopfzeile als ein Textstück), „Kontostand am …, Auszug Nr.“ = Anfangssaldo, „Gesamtumsatzsummen“ = Soll-Anzahl + Haben-Anzahl, OCR-Varianten („05.02.2026/Basislastschrift“), Scan-Auszug ohne Beträge → Kontoauszug erkannt + Diagnose „Beträge nicht lesbar (geschwärzt/Scan)“. comdirect Finanzreport: als Kontoauszug erkennen, Abschnitte Girokonto / Tagesgeld / Visa-Karte je eigenes Konto, Depot-/Steuerteil nicht als Buchungen.
2. **Wertpapier-Dokumente** (Erkennung `detect/index.js`, neuer Parser `parsers/docs/securities.js`, `parsers/index.js`, `parsers/naming.js`): neuer Dokumenttyp `wertpapier` mit Untertypen `kauf`, `verkauf`, `dividende`, `kosteninfo`, `depotreport`. Felder: Datum (Geschäftstag), Valuta, Betrag (Endbetrag mit Vorzeichen), WKN/ISIN, Stück, Wertpapier, Entgelte, Quellensteuer. Verneinung „keine Steuerbescheinigung“ zählt nicht. Kosteninformation und Reporting erzeugen keinen Beleg-Abgleich.
3. **Zuordnung & Vorsorge** (`classify/*`, `analyze/receipts.js`, `analyze/vat.js`, `classify/taxFlags.js`): Rentenbausteine (Riester, Rürup, private/fondsgebundene Rentenversicherung, Fondsrente, bAV, Vermögensdepot/Sparplan, VL) immer „Vorsorge & Sparen“, auch wenn Versicherer-Name (Allianz, Alte Leipziger, MLP …) im Text steht; reine Risikoversicherungen bleiben Versicherungen. Dividende/Kupon/Erträgnisgutschrift → Einkommen › Kapitalerträge; Wertpapierabrechnung ↔ Girobuchung („Wertpapiere“, Betrag, Valuta) als Beleg verknüpfen; Steuerflag für Dividende/Kapitalerträge.
4. **Integration** (ich): Zusammenführen, Gesamttests, Messbasis, Build, Browser-Test, Push.
