// Umsatzsteuer: exakt aus Belegen (vat[]), geschätzt für übrige Ausgaben nach Kategorie.
// estimateVat(txs, documents, { from, to }?) → { total, fromReceipts, estimated }   (Cent)
// Jede Zahlung zählt einmal: Beleg (genauer) ersetzt die Schätzung seiner Buchung, auch ohne gespeicherte Verknüpfung.
import { isFirmTransfer } from './transfers.js';

// Steuersatz je Kategorie.Unterkategorie (Fallback: Kategorie). Nicht aufgeführt = keine/unklare USt.
const RATES = {
  'lebensmittel.supermarkt': 0.07, 'lebensmittel.baeckerei': 0.07, 'lebensmittel.restaurant': 0.07, 'lebensmittel.lieferdienst': 0.07,
  'lebensmittel.drogerie': 0.19, 'lebensmittel.kiosk': 0.19,
  shopping: 0.19, abos_medien: 0.19,
  'wohnen.wasser': 0.07, 'freizeit_reisen.fluege': 0.19, 'freizeit_reisen.kreuzfahrt': 0.19, 'mobilitaet.e_laden': 0.19, 'mobilitaet.autowaesche': 0.19,
  'mobilitaet.tanken': 0.19, 'mobilitaet.auto': 0.19, 'mobilitaet.oepnv': 0.07, 'mobilitaet.bahn_fernverkehr': 0.07, 'mobilitaet.taxi_sharing': 0.19, 'mobilitaet.fahrrad': 0.19,
  'wohnen.strom_gas': 0.19, 'wohnen.internet_telefon': 0.19, 'wohnen.handwerker': 0.19, 'wohnen.einrichtung': 0.19, 'wohnen.garten': 0.19,
  'gesundheit.apotheke': 0.19, 'gesundheit.brille': 0.19, 'gesundheit.wellness': 0.19,
  'freizeit_reisen.hotel': 0.07, 'freizeit_reisen.kultur': 0.07, 'freizeit_reisen.hobby': 0.19, 'freizeit_reisen.geschenke': 0.19, 'freizeit_reisen.sport': 0.19,
  'beruf.arbeitsmittel': 0.19,
};

const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);

export function vatRateFor(category, sub) {
  return RATES[`${category}.${sub}`] ?? RATES[category] ?? 0;
}

export function estimateVat(txs = [], documents = [], range = {}) {
  const docById = new Map(documents.map(d => [d.id, d]));
  const withVat = (d) => d && Array.isArray(d.vat) && d.vat.length && (d.type === 'rechnung' || d.type === 'kassenbon');
  const taxOf = (d) => d.vat.reduce((s, v) => s + (v.tax || 0), 0);

  const counted = new Set();
  let fromReceipts = 0, estimated = 0;

  // 1. Belege, die einer Buchung im Zeitraum zugeordnet sind (Sammelbuchung: mehrere Belege je Buchung)
  const covered = new Set();
  for (const t of txs) {
    const ids = t.receiptDocIds?.length ? t.receiptDocIds : t.receiptDocId ? [t.receiptDocId] : [];
    for (const id of ids) {
      const d = docById.get(id);
      if (!withVat(d)) continue;
      covered.add(t.id);
      if (!counted.has(d.id)) { counted.add(d.id); fromReceipts += taxOf(d); }
    }
  }
  // 2. Übrige Belege im Zeitraum. Gibt es eine passende, noch nicht belegte Buchung (Betrag ±1 ct, Datum −2/+10 Tage,
  //    keine sichere Umbuchung), ersetzt der genauere Beleg deren Schätzung – sonst zählt er allein (z. B. Barzahlung).
  let from = range.from, to = range.to;
  if (!from || !to) {
    for (const t of txs) if (t.bookingDate) { if (!from || t.bookingDate < from) from = t.bookingDate; if (!to || t.bookingDate > to) to = t.bookingDate; }
  }
  const byAmount = new Map();
  for (const t of txs) {
    if (!(t.amount < 0) || !t.bookingDate || covered.has(t.id) || isFirmTransfer(t)) continue;
    let l = byAmount.get(-t.amount);
    if (!l) byAmount.set(-t.amount, l = []);
    l.push(t);
  }
  const docs = documents.filter(d => withVat(d) && !counted.has(d.id) && d.date && !(from && to && (d.date < from || d.date > to)));
  docs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const d of docs) {
    counted.add(d.id);
    fromReceipts += taxOf(d);
    const gross = d.amount > 0 ? d.amount : d.vat.reduce((s, v) => s + (v.gross || 0), 0);
    if (!gross) continue;
    const dd = dayNum(d.date);
    let best = null, bestDiff = Infinity;
    for (const amt of [gross, gross - 1, gross + 1]) {
      for (const t of byAmount.get(amt) || []) {
        if (covered.has(t.id) || t.receiptRejected?.includes(d.id)) continue;
        const diff = dayNum(t.bookingDate) - dd;
        if (diff < -2 || diff > 10) continue;
        if (Math.abs(diff) < bestDiff) { best = t; bestDiff = Math.abs(diff); }
      }
    }
    if (best) covered.add(best.id);
  }
  // 3. Schätzung für Ausgaben ohne Beleg (mittel sichere, unbestätigte Umbuchungen zählen mit; Storno-Paare heben sich auf)
  for (const t of txs) {
    if (covered.has(t.id) || isFirmTransfer(t) || !t.amount || t.stornoPairId) continue;
    if (t.category === 'umbuchung' && !(t.transferConfidence === 'medium' && t.transferSource !== 'user')) continue;
    const r = vatRateFor(t.category, t.subcategory);
    if (!r) continue;
    // Ausgaben erhöhen, Erstattungen mindern die geschätzte Vorsteuer
    estimated += Math.round((-t.amount) * r / (1 + r));
  }
  estimated = Math.max(0, estimated);
  return { total: fromReceipts + estimated, fromReceipts, estimated };
}
