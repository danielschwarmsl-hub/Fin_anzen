// Kategorien-Katalog (verbindlich laut SPEC). Farben funktionieren auf hellem und dunklem Grund.
// kind: income | expense | neutral | tax | saving

const sub = (id, label) => ({ id, label });

export const CATEGORIES = [
  {
    id: 'einkommen', label: 'Einkommen', color: '#2fb67c', icon: 'wallet', kind: 'income',
    subs: [sub('gehalt', 'Gehalt'), sub('zinsen', 'Zinsen'), sub('dividenden', 'Dividenden & Ausschüttungen'), sub('erstattung', 'Steuererstattung'),
      sub('rente', 'Rente & Versorgung'), sub('nebenjob', 'Nebenverdienst'), sub('mieteinnahmen', 'Mieteinnahmen'),sub('verkauf', 'Verkäufe'), sub('sonstiges', 'Sonstige Einnahmen')],
  },
  {
    id: 'steuern_abgaben', label: 'Steuern & Abgaben', color: '#8a6fd1', icon: 'tax', kind: 'tax',
    subs: [sub('lohnsteuer', 'Lohnsteuer'), sub('soli', 'Solidaritätszuschlag'), sub('kirchensteuer', 'Kirchensteuer'), sub('kv', 'Krankenversicherung'),
      sub('pv', 'Pflegeversicherung'), sub('rv', 'Rentenversicherung'), sub('av', 'Arbeitslosenversicherung'), sub('kapitalertragsteuer', 'Kapitalertragsteuer'),
      sub('einkommensteuer', 'Einkommensteuer'), sub('kfz_steuer', 'Kfz-Steuer'), sub('mwst_geschaetzt', 'MwSt (geschätzt)')],
  },
  {
    id: 'wohnen', label: 'Wohnen', color: '#4c8bf5', icon: 'home', kind: 'expense',
    subs: [sub('miete', 'Miete'), sub('nebenkosten', 'Nebenkosten'), sub('wasser', 'Wasser'), sub('strom_gas', 'Strom & Gas'),sub('internet_telefon', 'Internet & Telefon'),
      sub('rundfunk', 'Rundfunkbeitrag'), sub('handwerker', 'Handwerker & Reparaturen'), sub('einrichtung', 'Einrichtung & Haushalt'), sub('garten', 'Garten')],
  },
  {
    id: 'lebensmittel', label: 'Lebensmittel', color: '#f2a03d', icon: 'cart', kind: 'expense',
    subs: [sub('supermarkt', 'Supermarkt'), sub('drogerie', 'Drogerie'), sub('baeckerei', 'Bäckerei & Markt'), sub('restaurant', 'Restaurant & Café'),
      sub('lieferdienst', 'Lieferdienst'), sub('kiosk', 'Kiosk & Snacks')],
  },
  {
    id: 'mobilitaet', label: 'Mobilität', color: '#27b5c9', icon: 'car', kind: 'expense',
    subs: [sub('tanken', 'Tanken'), sub('e_laden', 'E-Laden'), sub('oepnv', 'ÖPNV & Deutschlandticket'), sub('bahn_fernverkehr', 'Bahn & Fernbus'), sub('taxi_sharing', 'Taxi & Sharing'),
      sub('auto', 'Auto (Werkstatt, Parken, Maut)'), sub('autowaesche', 'Autowäsche'), sub('fahrrad', 'Fahrrad')],
  },
  {
    id: 'versicherungen', label: 'Versicherungen', color: '#5b6fe0', icon: 'shield', kind: 'expense',
    subs: [sub('haftpflicht', 'Haftpflicht'), sub('hausrat', 'Hausrat'), sub('bu', 'Berufsunfähigkeit'), sub('kranken_zusatz', 'Kranken-Zusatz'),
      sub('kfz', 'Kfz-Versicherung'), sub('rechtsschutz', 'Rechtsschutz'), sub('leben', 'Lebensversicherung'), sub('unfall', 'Unfallversicherung')],
  },
  {
    id: 'vorsorge_sparen', label: 'Vorsorge & Sparen', color: '#22a891', icon: 'piggy', kind: 'saving',
    subs: [sub('privatrente', 'Privatrente'), sub('riester_ruerup', 'Riester / Rürup'), sub('sparplan_depot', 'Sparplan & Depot'), sub('tagesgeld', 'Tagesgeld & Festgeld'),
      sub('bausparen', 'Bausparen'), sub('betriebsrente', 'Betriebliche Altersvorsorge')],
  },
  {
    id: 'abos_medien', label: 'Abos & Medien', color: '#e0587c', icon: 'repeat', kind: 'expense',
    subs: [sub('streaming', 'Streaming'), sub('musik', 'Musik'), sub('software', 'Software & KI'), sub('cloud', 'Cloud & Speicher'), sub('zeitung', 'Zeitung & Magazine'),
      sub('fitness', 'Fitness & Sport'), sub('gaming', 'Gaming'), sub('hoerbuch', 'Bücher & Hörbücher')],
  },
  {
    id: 'gesundheit', label: 'Gesundheit', color: '#e5645a', icon: 'heart', kind: 'expense',
    subs: [sub('apotheke', 'Apotheke'), sub('arzt', 'Arzt & Therapie'), sub('zahnarzt', 'Zahnarzt'), sub('brille', 'Brille & Optik'), sub('krankenkasse', 'Krankenkasse'), sub('wellness', 'Wellness')],
  },
  {
    id: 'freizeit_reisen', label: 'Freizeit & Reisen', color: '#f0b429', icon: 'sparkles', kind: 'expense',
    subs: [sub('urlaub', 'Urlaub & Reisen'), sub('fluege', 'Flüge'), sub('hotel', 'Unterkunft & Hotel'), sub('kreuzfahrt', 'Kreuzfahrt'),sub('kultur', 'Kultur & Events'), sub('hobby', 'Hobby'), sub('sport', 'Sport'), sub('geschenke', 'Geschenke')],
  },
  {
    id: 'shopping', label: 'Shopping', color: '#c26ad6', icon: 'tag', kind: 'expense',
    subs: [sub('online', 'Online-Shopping'), sub('kleidung', 'Kleidung & Schuhe'), sub('elektronik', 'Elektronik'), sub('moebel', 'Möbel & Wohnen'), sub('buecher', 'Bücher & Medien'), sub('sonstiges', 'Sonstiges Shopping')],
  },
  {
    id: 'beruf', label: 'Beruf & Bildung', color: '#6b8e9b', icon: 'file', kind: 'expense',
    subs: [sub('arbeitsmittel', 'Arbeitsmittel'), sub('fortbildung', 'Fortbildung'), sub('gewerkschaft', 'Gewerkschaft & Verband'), sub('kinderbetreuung', 'Kinderbetreuung'), sub('schule', 'Schule & Studium')],
  },
  {
    id: 'spenden', label: 'Spenden', color: '#ef7d57', icon: 'heart', kind: 'expense',
    subs: [sub('organisation', 'Hilfsorganisation'), sub('kirche', 'Kirche & Gemeinde'), sub('politik', 'Partei & Initiative')],
  },
  {
    id: 'finanzen', label: 'Finanzen & Gebühren', color: '#8d98a8', icon: 'bank', kind: 'expense',
    subs: [sub('kontofuehrung', 'Kontoführung'), sub('zinsen_kredit', 'Kreditzinsen'), sub('kredit', 'Kredit-Rate'), sub('gebuehren', 'Gebühren'), sub('paypal_gebuehr', 'PayPal-Gebühren')],
  },
  {
    id: 'bargeld', label: 'Bargeld', color: '#a1887f', icon: 'wallet', kind: 'expense',
    subs: [sub('auszahlung', 'Bargeldauszahlung'), sub('einzahlung', 'Bargeldeinzahlung'), sub('ausland', 'Auslandsabhebung')],
  },
  {
    id: 'umbuchung', label: 'Umbuchung', color: '#9aa3ad', icon: 'split', kind: 'neutral',
    subs: [sub('eigene_konten', 'Zwischen eigenen Konten'), sub('paypal', 'PayPal-Aufladung'), sub('kreditkarte', 'Kreditkartenabrechnung')],
  },
  {
    id: 'sonstiges', label: 'Sonstiges', color: '#7d8590', icon: 'tag', kind: 'expense',
    subs: [sub('privat', 'Private Überweisung'), sub('behoerden', 'Behörden & Gebühren'), sub('unbekannt', 'Nicht zugeordnet')],
  },
];

const BY_ID = new Map(CATEGORIES.map(c => [c.id, c]));

export function getCategory(id) { return BY_ID.get(id) || null; }

export function getSub(id, subId) {
  const c = BY_ID.get(id);
  return c?.subs.find(s => s.id === subId) || null;
}

/** "Wohnen › Miete" bzw. nur "Wohnen" */
export function categoryLabel(id, subId) {
  const c = BY_ID.get(id);
  if (!c) return 'Nicht zugeordnet';
  const s = subId && getSub(id, subId);
  return s ? `${c.label} › ${s.label}` : c.label;
}
