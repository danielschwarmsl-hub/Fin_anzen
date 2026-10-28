# Format research for fictional test samples

Searches run: 10 (budget reached). Pages opened are listed per section. Anything not
verified from a source is marked UNVERIFIED and follows the brief or general knowledge.

## a) comdirect

**Depot CSV (verified).** Source: https://forum.portfolio-performance.info/t/csv-import-von-comdirect/7679

```
"Umsätze Depot ";"Zeitraum: 20 Tage";

"Buchungstag";"Geschäftstag";"Stück / Nom.";"Bezeichnung";"WKN";"Währung";"Ausführungskurs";"Umsatz in EUR";
"10.02.2020";"07.02.2020";"2.5";"UBS-ETF-MSCI WLD.S.R.DLAD";"A1JA1R";"EUR";"98,51";"249,96";
```

- Semicolon delimiter, all fields quoted, trailing `;` on header and data lines.
- Dates DD.MM.YYYY. Amounts and prices use decimal comma. Quantities in the sample use a decimal point ("2.5", "12.145"). The generator follows the sample.
- Encoding not stated on the page. The brief says ISO-8859-1, and the user imported with UTF-8. We use cp1252/ISO-8859-1.

**Girokonto CSV (UNVERIFIED).** No sample was found. The brief's layout is used: preamble "Umsätze Girokonto", the header `"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR"`, trailing `;`, and "Alter/Neuer Kontostand" lines. Treat all of it as an assumption. The finanzfluss page (https://www.finanzfluss.de/copilot/hilfe/comdirect-konten-und-depots-importieren/) gives no layout details. It only says comdirect exports transactions for the last three years.

## b) ING

**Girokonto CSV (partly verified).** Source: https://forum.portfolio-performance.info/t/csv-import-von-ing/13936 and https://madflex.de/ing-csv-to-ledger-converter/

- Semicolon delimiter, encoding `cp1252`.
- The parser skips preamble lines until one starts with `Buchung;Valuta`.
- Example data row from madflex: `26.08.2022;26.08.2022;VISA ALDI SUED;Lastschrift;NR XXXX ...;100,00;EUR;-12,34;EUR`. This suggests the column order Buchung, Valuta, Auftraggeber, Buchungstext, Verwendungszweck, Betrag/Saldo, Währung, ... (the exact order is UNVERIFIED).
- **Uncertainty:** the verified header starts `Buchung;Valuta`. The brief says `Buchung;Wertstellungsdatum`. We follow the brief, so both spellings are plausible.
- The "Kategorie" column is NOT verified. Our sample omits it. Parsers should accept both.
- The forum notes that ING CSV exports only cover about 12 months.

## c) Renault Bank direkt Tagesgeld

- No Kontoauszug sample found. Source checked: product and terms PDFs on renault-bank-direkt.de (not useful for layout).
- No evidence of a CSV export. Assumed to be PDF-only.
- The layout used (Buchungstag | Wert | Vorgang | Betrag, alter/neuer Kontostand, Zinsgutschrift, Überweisung vom Referenzkonto) is UNVERIFIED and invented for testing.

## d) PayPal Aktivitäten CSV

**Verified (English).** Source: https://developer.paypal.com/docs/reports/online-reports/activity-download/ and https://propersoft.net/export-csv-paypal

- Encoding UTF-8. Delimiter comma. Date and time in separate columns, with time zone.
- Column names are documented in English only: `Date, Time, TimeZone, Name, Type, Status, Currency, Gross, Fee, Net, From Email Address, To Email Address, Transaction ID, ..., Balance, ..., Reference Txn ID, ...`
- The date format depends on the account country. For German accounts DD.MM.YYYY is typical, which is UNVERIFIED.
- The page shows no German column names and no BOM note.

**UNVERIFIED.** The German headers in the brief ("Datum", "Uhrzeit", "Zeitzone", "Brutto", "Gebühr", "Netto", "Absender E-Mail-Adresse", "Empfänger E-Mail-Adresse", "Transaktionscode", "Guthaben") and the German Typ values ("Allgemeine Zahlung", "Händlerzahlung", "Bankgutschrift auf PayPal-Konto", "Allgemeine Abbuchung – Bankkonto", "Zahlung im Einzugsverfahren mit Zahlungsrechnung") are not confirmed by any source. We use the German headers from the brief with a UTF-8 BOM and `,` delimiter, and treat the Typ values as placeholders. Parsers should tolerate both English and German headers.

## e) camt.053

**Partly verified.** Source: https://assets.ing.com/m/46de0ddc540d0b05/original/CAMT-053-Sample-IBP.pdf (ING sample)

- That sample uses `urn:iso:std:iso:20022:tech:xsd:camt.053.001.02`, not .08. The brief asks for .08, so we use the .08 namespace `urn:iso:std:iso:20022:tech:xsd:camt.053.001.08`.
- Structure confirmed: Document > BkToCstmrStmt > GrpHdr, Stmt (Id, CreDtTm, FrToDt, Acct, Bal, TxsSummry, Ntry, AddtlStmtInf).
- Balance types: OPBD (opening booked), CLBD (closing booked), CLAV, OPAV, PRCD, ITBD. Source: https://www.sepaforcorporates.com/swift-for-corporates/a-practical-guide-to-the-bank-statement-camt-053-format/
- `CdtDbtInd` values: CRDT and DBIT.
- Ntry contains NtryRef, Amt Ccy, CdtDbtInd, Sts, BookgDt, ValDt, BkTxCd, and NtryDtls/TxDtls (Refs with EndToEndId and MndtId, Amt, RltdPties, RmtInf/Ustrd).
- The exact BkTxCd domain/family codes are UNVERIFIED (PMNT with DDRD/ESDD, ICDT/ESCT, RCDT/ESCT, CCRD/POSD, CCRD/ATMW are used from general knowledge).
- CdtrSchmeId has no verified place in camt.053 here. The generator writes the Gläubiger-ID as text in AddtlTxInf ("Glaeubiger-ID ..."). Parsers should look for it in several places.
- Schema validation was not run. The file is well-formed (checked with ElementTree).
- Schema validation was not done. The XML is well-formed and follows the structure above.

## Pages opened
- https://forum.portfolio-performance.info/t/csv-import-von-comdirect/7679
- https://forum.portfolio-performance.info/t/csv-import-von-ing/13936
- https://madflex.de/ing-csv-to-ledger-converter/
- https://www.sepaforcorporates.com/swift-for-corporates/a-practical-guide-to-the-bank-statement-camt-053-format/
- https://assets.ing.com/m/46de0ddc540d0b05/original/CAMT-053-Sample-IBP.pdf
- https://developer.paypal.com/docs/reports/online-reports/activity-download/
- https://www.finanzfluss.de/copilot/hilfe/comdirect-konten-und-depots-importieren/
- https://propersoft.net/export-csv-paypal
