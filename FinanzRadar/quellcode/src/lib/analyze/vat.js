// Umsatzsteuer: exakt aus Belegen (vat[]), geschätzt für übrige Ausgaben nach Kategorie.
// estimateVat(txs, documents, { from, to }?) → { total, fromReceipts, estimated }   (Cent)

// Steuersatz je Kategorie.Unterkategorie (Fallback: Kategorie). Nicht aufgeführt = keine/unklare USt.
const RATES = {
  'lebensmittel.supermarkt': 0.07, 'lebensmittel.baeckerei': 0.07, 'lebensmittel.restaurant': 0.07, 'lebensmittel.lieferdienst': 0.07,
  'lebensmittel.drogerie': 0.19, 'lebensmittel.kiosk': 0.19,
  shopping: 0.19, abos_medien: 0.19,
  'mobilitaet.tanken': 0.19, 'mobilitaet.auto': 0.19, 'mobilitaet.oepnv': 0.07, 'mobilitaet.bahn_fernverkehr': 0.07, 'mobilitaet.taxi_sharing': 0.19, 'mobilitaet.fahrrad': 0.19,
  'wohnen.strom_gas': 0.19, 'wohnen.internet_telefon': 0.19, 'wohnen.handwerker': 0.19, 'wohnen.einrichtung': 0.19, 'wohnen.garten': 0.19,
  'gesundheit.apotheke': 0.19, 'gesundheit.brille': 0.19, 'gesundheit.wellness': 0.19,
  'freizeit_reisen.hotel': 0.07, 'freizeit_reisen.kultur': 0.07, 'freizeit_reisen.hobby': 0.19, 'freizeit_reisen.geschenke': 0.19, 'freizeit_reisen.sport': 0.19,
  'beruf.arbeitsmittel': 0.19,
};

export function vatRateFor(category, sub) {
  return RATES[`${category}.${sub}`] ?? RATES[category] ?? 0;
}

export function estimateVat(txs = [], documents = [], range = {}) {
  const docById = new Map(documents.map(d => [d.id, d]));
  const withVat = (d) => d && Array.isArray(d.vat) && d.vat.length && (d.type === 'rechnung' || d.type === 'kassenbon');
  const taxOf = (d) => d.vat.reduce((s, v) => s + (v.tax || 0), 0);

  const counted = new Set();
  let fromReceipts = 0, estimated = 0;

  // 1. Belege, die einer Buchung im Zeitraum zugeordnet sind
  const covered = new Set();
  for (const t of txs) {
    if (!t.receiptDocId) continue;
    const d = docById.get(t.receiptDocId);
    if (!withVat(d)) continue;
    covered.add(t.id);
    if (!counted.has(d.id)) { counted.add(d.id); fromReceipts += taxOf(d); }
  }
  // 2. Übrige Belege im Zeitraum (z. B. Barzahlung)
  let from = range.from, to = range.to;
  if (!from || !to) {
    for (const t of txs) if (t.bookingDate) { if (!from || t.bookingDate < from) from = t.bookingDate; if (!to || t.bookingDate > to) to = t.bookingDate; }
  }
  for (const d of documents) {
    if (!withVat(d) || counted.has(d.id) || !d.date) continue;
    if (from && to && (d.date < from || d.date > to)) continue;
    counted.add(d.id);
    fromReceipts += taxOf(d);
  }
  // 3. Schätzung für Ausgaben ohne Beleg
  for (const t of txs) {
    if (covered.has(t.id) || t.isTransfer || !t.amount) continue;
    if (t.category === 'umbuchung') continue;
    const r = vatRateFor(t.category, t.subcategory);
    if (!r) continue;
    // Ausgaben erhöhen, Erstattungen mindern die geschätzte Vorsteuer
    estimated += Math.round((-t.amount) * r / (1 + r));
  }
  estimated = Math.max(0, estimated);
  return { total: fromReceipts + estimated, fromReceipts, estimated };
}
