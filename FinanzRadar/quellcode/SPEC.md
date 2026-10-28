# FinanzRadar – Technische Spezifikation (verbindlich für alle Module)

Reine Browser-App, Svelte 5 (Runes, **JavaScript, kein TypeScript**), Vite. Läuft über `http://localhost`.
Ziel-Browser: Chrome/Edge (voll), Firefox (ohne `showDirectoryPicker`). Alle Daten lokal (IndexedDB via Dexie).
UI-Sprache: Deutsch. Zahlenformat deutsch. Kein Fülltext in der UI – Erklärungen nur im Tooltip (`<Tip>`).

## Grundregeln
- **Beträge immer in Cent als Integer** (`amount`), negativ = Abfluss/Ausgabe, positiv = Zufluss. Währung `currency` (Default `EUR`).
- **Datum** als ISO-String `YYYY-MM-DD`.
- Hilfsfunktionen in `src/lib/util/format.js` benutzen: `parseGermanAmount`, `parseGermanDate`, `fmtEUR`, `fmtDate`, `normalizeIban`, `slug`, `uid`, `sha256Hex`.
- Module sind reine ES-Module ohne Seiteneffekte beim Import (außer UI). Keine globalen Variablen.
- Jede Parser-/Analyse-Funktion ist **synchron oder async, aber DOM-frei** (läuft auch in Node/Vitest).
- Keine neuen npm-Abhängigkeiten ohne Rücksprache. Vorhanden: dexie, pdfjs-dist, tesseract.js, heic2any, papaparse, xlsx, @orama/orama, @orama/stemmers, echarts, d3-sankey, d3-shape, client-zip, fast-xml-parser, vitest.
- Beispieldateien zum Testen: `samples/out/**` (fiktiv), erwartete Werte: `samples/out/EXPECTED.json`.

## Datenfluss
```
sources/* → enumerate() → store/importer (Hash, Dedupe, Herkunft) → extract/index.extract()
 → detect/index.detectType() → parsers/index.parse() → classify/* → analyze/* → store → views
```

## Extrahiertes Objekt (`Extracted`) – Ausgabe von `extract(fileMeta, blob, opts)`
```js
{
  kind: 'pdf'|'image'|'csv'|'xlsx'|'xml'|'text'|'unsupported',
  text: string,              // gesamter Text (Seiten mit \n\f\n getrennt)
  pages: [{ n, text, lines: [{ y, text, items: [{ x, w, str }] }] }], // nur pdf/image(OCR)
  rows: string[][] | null,   // csv/xlsx: Zeilen (bereits dekodiert, Trennzeichen erkannt)
  rawText: string | null,    // csv/text/xml: dekodierter Rohtext
  xml: string | null,        // xml-Datei oder eingebettete E-Rechnung (ZUGFeRD/XRechnung)
  ocr: boolean,              // true wenn Text per OCR gewonnen wurde
  ocrConfidence: number|null,// 0..100
  thumbnail: Blob|null,      // kleine Vorschau (PNG/JPEG) erste Seite/Bild, max 360px Breite
  meta: { pageCount, encoding, delimiter }
}
```
`fileMeta = { name, path, ext, mime, size }`. `opts = { onProgress?(p0to1, label), signal?, ocr?: true }`.

## Erkennung – `detectType(extracted, fileMeta) => Detection`
```js
{ type, subtype, institution, format, confidence /*0..1*/, signals: string[] }
```
`type` ∈ `kontoauszug | kreditkarte | paypal | depot | lohn | lohnsteuerbescheinigung | rechnung | kassenbon | versicherung | rente | steuerbescheinigung | spende | vertrag | einkaufszettel | finanz_sonstiges | irrelevant`
`format` (nur Kontoumsätze): `ing_csv | comdirect_csv | comdirect_depot_csv | paypal_csv | camt053 | camt052 | mt940 | generic_csv | pdf_statement | null`.
`institution` z. B. `ING`, `comdirect`, `Renault Bank`, `PayPal`, `Allianz`, …

## Parser – `parse(detection, extracted, fileMeta) => ParseResult`
```js
{
  document: {            // Pflicht
    type, subtype, institution, date, periodFrom, periodTo, issuer, amount /*Cent, Gesamtbetrag falls sinnvoll*/,
    currency, title /*kurz, z.B. "Kontoauszug ING Girokonto 03/2026"*/, fields: {} /*typspezifisch*/,
    confidence, needsReview, reviewReason
  },
  account: null | { kind, institution, name, iban, currency, number },   // Konto, zu dem die Umsätze gehören
  transactions: [ Transaction-ohne-id ],
  lineItems: [ { text, qty, unitPrice, total, vatRate } ],
  holdings: [ { name, isin, wkn, qty /*float*/, price /*Cent*/, value /*Cent*/, date } ],
  valuations: [ { date, value /*Cent*/, label } ],  // Kontostand / Fondsguthaben / Rückkaufswert / Depotwert
  balance: null | { opening, closing, openingDate, closingDate, check /*bool: opening+Summe==closing*/ },
  payroll: null | { gross, net, payout, lohnsteuer, soli, kirchensteuer, kv, pv, rv, av, period } // Cent, nur lohn/lohnsteuerbescheinigung
  vat: null | [ { rate /*19|7|0*/, net, tax, gross } ] // Cent, nur Rechnung/Bon
}
```

## Transaction (Tabelle `transactions`)
```js
{ id, accountId, documentId, fileId, bookingDate, valueDate, amount, currency,
  counterparty /*normalisiert, Anzeigename*/, counterpartyRaw, counterpartyIban,
  purpose /*Verwendungszweck*/, bookingText /*z.B. Lastschrift, Gutschrift, Kartenzahlung*/,
  mandateId, creditorId, endToEndId, gvc, fee /*Cent, PayPal*/,
  category, subcategory, categorySource /*'rule'|'merchant'|'keyword'|'user'|'ai'|'transfer'*/, confidence,
  transferPairId /*id der Gegenbuchung bei Umbuchung*/, isTransfer, contractId, receiptDocId,
  taxRelevant, taxReason, needsReview, dedupeKey }
```
`dedupeKey = accountKey|bookingDate|amount|slug(counterpartyRaw+purpose).slice(0,40)` – damit Umsätze aus CSV und PDF desselben Kontos nicht doppelt zählen.

## Kategorien – `src/lib/classify/categories.js`
Export `CATEGORIES = [{ id, label, color, icon, kind:'income'|'expense'|'neutral'|'tax'|'saving', subs:[{id,label}] }]`.
Hauptkategorien (ids): `einkommen, steuern_abgaben, wohnen, lebensmittel, mobilitaet, versicherungen, vorsorge_sparen, abos_medien, gesundheit, freizeit_reisen, shopping, beruf, spenden, finanzen, bargeld, umbuchung, sonstiges`.

## Steuer-Flag (schlank)
Nur `taxRelevant: boolean` + `taxReason` ∈ `lohn | beruf | versicherung_vorsorge | kapitalertraege | haushalt_handwerker | spenden | gesundheit | kinder_bildung | sonstiges`. Keine Steuerberechnung. Export als ZIP (Ordner je Grund).

## Insights – `analyze/insights.js: computeInsights(data, { from, to, accountIds? }) => Insights`
`data = { accounts, transactions, documents, contracts, holdings, valuations, assets }`
```js
{
  period: { from, to, months: ['2026-01', …] },
  totals: { income, expense, saving, net, savingsRate /*0..1*/, transfers },
  byCategory: [{ id, label, color, amount /*positiv, Ausgaben*/, share, subs:[{id,label,amount}] }],
  incomeBySource: [{ id, label, amount }],
  byMonth: [{ month, income, expense /*positiv*/, net }],
  topMerchants: [{ name, amount, count, category }],
  recurring: { monthlyTotal, yearlyTotal, count },
  taxes: { payroll: { gross, lohnsteuer, soli, kirchensteuer, kv, pv, rv, av, net } | null,
           vatEstimate: { total, fromReceipts, estimated }, capitalGainsTax, total, quote },
  netWorth: { total, byAccount: [{ accountId, name, kind, value, date }], series: [{ date, value }] },
  sankey: { nodes: [{ id, label, kind:'source'|'tax'|'account'|'category'|'saving', color }],
            links: [{ source, target, value /*Cent, >0*/ }] },
  flags: { needsReview, taxRelevant, uncategorized }
}
```
Sankey-Aufbau: Quellen (Brutto-Gehalt bzw. Netto, sonstige Einnahmen) → [Steuern/SV als Abzweig, falls Lohndaten vorhanden & „Steuern zeigen“] → Konten → Kategorien (+ Sparen/Investieren). Umbuchungen zwischen eigenen Konten **nicht** als Ausgabe.

## Speicher – `src/lib/store/db.js` (Dexie, fertig vorhanden)
Tabellen: `sources, files, blobs, documents, accounts, transactions, lineItems, contracts, holdings, valuations, assets, rules, settings`.

## App-State – `src/lib/store/state.svelte.js` (fertig vorhanden)
`app` (reaktiv, `$state`): `{ ready, view, data:{…alle Tabellen als Arrays}, filter:{from,to,accountIds,search}, progress:{…}, settings:{…} }` + Funktionen `reload()`, `setView(v, params)`, `updateTransaction(id, patch)`, `updateDocument(id, patch)`, `toast(msg)`.

## UI-Bausteine (fertig vorhanden in `src/lib/ui/`)
`Button.svelte, Tip.svelte (ⓘ-Tooltip), Collapsible.svelte, Chip.svelte, Modal.svelte, Empty.svelte, Stat.svelte, Money.svelte, Select.svelte, Toggle.svelte, Icon.svelte`. CSS-Variablen in `src/app.css` (`--bg, --surface, --surface-2, --border, --text, --text-2, --accent, --good, --warn, --bad, --radius, --gap`). Klassen: `.card, .row, .stack, .grid, .muted, .num, .tbl`.
