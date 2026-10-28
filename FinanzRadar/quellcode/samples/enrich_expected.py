"""Ergänzt samples/out/EXPECTED.json um Soll-Werte aus der Generator-Wahrheit (gen_model.py).
Bestehende Felder bleiben unverändert; nur neue Schlüssel werden hinzugefügt.
Aufruf: python3 enrich_expected.py <quellcode-Ordner>"""
import json
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / "samples"))
import gen_model as m  # noqa: E402

ing = m.ing_bookings()          # gleiche RNG-Reihenfolge wie generate.py
cd = m.comdirect_bookings()
pp = m.paypal_rows()

# ---- Soll-Kategorie je Buchungsart (nur wo eindeutig; None = nicht bewertet)
KIND_CAT = {
    "salary": ("einkommen", "gehalt"), "rent": ("wohnen", "miete"), "utility": ("wohnen", "strom_gas"),
    "telecom": ("wohnen", "internet_telefon"), "ticket": ("mobilitaet", "oepnv"),
    "privatrente": ("vorsorge_sparen", "privatrente"), "bu": ("versicherungen", "bu"),
    "fitness": ("abos_medien", "fitness"), "cash": ("bargeld", "auszahlung"),
    "sparplan": ("umbuchung", "eigene_konten"), "tagesgeld": ("umbuchung", "eigene_konten"),
    "union": ("beruf", "gewerkschaft"), "rundfunk": ("wohnen", "rundfunk"),
    "haftpflicht": ("versicherungen", "haftpflicht"), "handwerker": ("wohnen", "handwerker"),
    "optiker": ("gesundheit", "brille"), "spende": ("spenden", "organisation"),
    "card_edeka": ("lebensmittel", "supermarkt"), "paypal_debit": ("umbuchung", "paypal"),
    "sparplan_in": ("umbuchung", "eigene_konten"), "sparplan_buy": ("vorsorge_sparen", "sparplan_depot"),
    "card_rewe": ("lebensmittel", "supermarkt"), "amazon": ("shopping", "online"),
    "amazon_monitor": ("shopping", None), "fuel": ("mobilitaet", "tanken"),
    "restaurant": ("lebensmittel", "restaurant"),
}
PAYEE_CAT = {
    "Netflix International B.V.": ("abos_medien", "streaming"), "Spotify AB": ("abos_medien", "musik"),
    "OpenAI Ireland Ltd.": ("abos_medien", "software"), "Adobe Systems Software Ireland Ltd": ("abos_medien", "software"),
    "dm drogerie markt": ("lebensmittel", "drogerie"), "Rossmann Filiale": ("lebensmittel", "drogerie"),
    "Bäckerei Junge": ("lebensmittel", "baeckerei"), "Penny Markt": ("lebensmittel", "supermarkt"),
    "Tankstelle Shell": ("mobilitaet", "tanken"),
}
TRANSFER_KINDS = {"sparplan", "tagesgeld", "paypal_debit", "sparplan_in"}


def cat_of(b):
    c = PAYEE_CAT.get(b.payee) or KIND_CAT.get(b.kind)
    return c if c else (None, None)


def booking(b, label):
    cat, sub = cat_of(b)
    return {"id": label, "date": b.booked.isoformat(), "amount": b.cents, "payee": b.payee, "kind": b.kind,
            "category": cat, "subcategory": sub, "transfer": b.kind in TRANSFER_KINDS}


def unique_ids(bookings, prefix):
    out, seen = [], {}
    for b in bookings:
        k = f"{prefix}:{b.booked.isoformat()}:{b.cents}:{b.kind}"
        seen[k] = seen.get(k, 0) + 1
        out.append(booking(b, k + (f"#{seen[k]}" if seen[k] > 1 else "")))
    return out


ing_list = unique_ids(ing, "ING")
cd_list = unique_ids(cd, "CD")

PP_CAT = {  # (Art, Name) → Soll; None = nicht eindeutig
    ("pay", "ABC Shop"): ("shopping", "online"), ("refund", "ABC Shop"): ("shopping", "online"),
    ("pay", "eBay Sarl"): ("shopping", "online"), ("pay", "Kiosk Ecke"): ("lebensmittel", "kiosk"),
    ("pay", "Buchhandlung Muster"): ("shopping", "buecher"), ("pay", "Lieferdienst Probe"): ("lebensmittel", "lieferdienst"),
    ("pay", "Reisebüro Probe"): ("freizeit_reisen", "urlaub"), ("send", "Anna Beispiel"): ("sonstiges", "privat"),
    ("pay", "Sportartikel Beispiel"): (None, None), ("pay", "Gartenmarkt Testhof"): (None, None),
}
pp_list = []
for (day, time, kind, name, cents) in m.PAYPAL_EVENTS:
    cat, sub = ("umbuchung", "paypal") if kind == "bank_in" else PP_CAT[(kind, name)]
    pp_list.append({"id": f"PP:{day.isoformat()}:{cents}:{kind}", "date": day.isoformat(), "amount": cents,
                    "payee": name, "kind": kind, "category": cat, "subcategory": sub, "transfer": kind == "bank_in"})

renault_list = [
    {"id": "RB:2026-06-05:50000:tagesgeld_in", "date": "2026-06-05", "amount": 50000, "payee": m.OWNER,
     "kind": "tagesgeld_in", "category": "umbuchung", "subcategory": "eigene_konten", "transfer": True},
    {"id": f"RB:2026-06-30:{m.RENAULT_INTEREST_JUNE}:interest", "date": "2026-06-30", "amount": m.RENAULT_INTEREST_JUNE,
     "payee": "Renault Bank direkt", "kind": "interest", "category": "einkommen", "subcategory": "zinsen", "transfer": False},
]

path = ROOT / "samples/out/EXPECTED.json"
data = json.loads(path.read_text(encoding="utf-8"))
F = data["files"]


def add(rel, **kw):
    for k, v in kw.items():
        assert k not in F[rel] or F[rel][k] == v, (rel, k)
        F[rel][k] = v


def cents(s):
    return round(float(s) * 100)


march = [x for x in ing_list if x["date"][5:7] == "03"]
may = [x for x in ing_list if x["date"][5:7] == "05"]
ING_CSV = "Banken/ING/ing_girokonto_2026H1.csv"
CD_CSV = "Banken/comdirect/comdirect_girokonto_2026H1.csv"
DEPOT = "Banken/comdirect/comdirect_depot_2026-06-30.csv"
PP_CSV = "Banken/PayPal/paypal_aktivitaeten_2026H1.csv"
total = lambda xs: sum(x["amount"] for x in xs)  # noqa: E731

add(ING_CSV, appType="kontoauszug", appFormat="ing_csv", institution="ING", accountKey="ING",
    expect={"transactions": len(ing_list), "openingCents": m.ING_OPENING, "closingCents": cents(F[ING_CSV]["closing_eur"]),
            "sumCents": total(ing_list)},
    bookingsExpected=ing_list)
add(CD_CSV, appType="kontoauszug", appFormat="comdirect_csv", institution="comdirect", accountKey="COMDIRECT",
    expect={"transactions": len(cd_list), "openingCents": m.COMDIRECT_OPENING, "closingCents": cents(F[CD_CSV]["closing_eur"]),
            "sumCents": total(cd_list)},
    bookingsExpected=cd_list)
add(DEPOT, appType="depot", appFormat="comdirect_depot_csv", institution="comdirect", accountKey="DEPOT",
    expect={"transactions": 0, "holdings": 3, "holdingsValueCents": cents(F[DEPOT]["total_eur"])})
add(PP_CSV, appType="paypal", appFormat="paypal_csv", institution="PayPal", accountKey="PAYPAL",
    expect={"transactions": len(pp_list), "openingCents": 0, "closingCents": cents(F[PP_CSV]["final_balance_eur"]),
            "sumCents": total(pp_list)},
    bookingsExpected=pp_list)
add("Banken/Renault/renaultbank_tagesgeld_2026-06.pdf", appType="kontoauszug", appFormat="pdf_statement",
    institution="Renault Bank", accountKey="RENAULT",
    expect={"transactions": 2, "openingCents": m.RENAULT_OPENING_JUNE,
            "closingCents": m.RENAULT_OPENING_JUNE + total(renault_list), "sumCents": total(renault_list)},
    bookingsExpected=renault_list)
for rel, fmt, part in (("Banken/ING/ing_kontoauszug_2026-03.pdf", "pdf_statement", march),
                       ("Banken/ING/camt053_ing_2026-05.xml", "camt053", may)):
    add(rel, appType="kontoauszug", appFormat=fmt, institution="ING", accountKey="ING",
        expect={"transactions": len(part), "openingCents": cents(F[rel]["opening_eur"]),
                "closingCents": cents(F[rel]["closing_eur"]), "sumCents": total(part)},
        duplicateOf={"file": ING_CSV, "count": len(part), "ids": [x["id"] for x in part]})

# ---- Belege und Dokumente: App-Typ, Gesamtbetrag (doc.amount), Positionen (Anzahl/Summe der Positionsbeträge)
optik_net = round(m.OPTIK_GROSS / 1.19)
amz_net = round(m.AMAZON_MONITOR_GROSS / 1.19)
docs = {
    "Belege/lohnabrechnung_2026-03.pdf": dict(appType="lohn", expect={"amountCents": m.NET_SALARY, "grossCents": m.GROSS_2026, "date": "2026-03-27"}),
    "Belege/rechnung_elektro_meyer_2026-02.pdf": dict(appType="rechnung", expect={
        "amountCents": m.ELEKTRO_GROSS, "vatCents": cents(F["Belege/rechnung_elektro_meyer_2026-02.pdf"]["vat_19_eur"]), "date": "2026-02-20",
        "lineItems": 2, "lineItemsSumCents": 23000 + 11647, "lineItemsBasis": "netto"}),
    "Belege/rechnung_amazon_monitor_2026-04.pdf": dict(appType="rechnung", expect={
        "amountCents": m.AMAZON_MONITOR_GROSS, "vatCents": m.AMAZON_MONITOR_GROSS - amz_net, "date": "2026-04-07",
        "lineItems": 1, "lineItemsSumCents": m.AMAZON_MONITOR_GROSS, "lineItemsBasis": "brutto"}),
    "Belege/kassenbon_rewe_2026-04-12.png": dict(appType="kassenbon", ocrFixture="rewe.ocr.txt", expect={
        "amountCents": m.REWE_TOTAL, "date": "2026-04-12", "lineItems": 13, "lineItemsSumCents": m.REWE_TOTAL, "lineItemsBasis": "brutto"}),
    "Belege/kassenbon_edeka_2026-05-03.jpg": dict(appType="kassenbon", ocrFixture="edeka.ocr.txt", expect={
        "amountCents": m.EDEKA_TOTAL, "date": "2026-05-03", "lineItems": 12, "lineItemsSumCents": m.EDEKA_TOTAL, "lineItemsBasis": "brutto"}),
    "Belege/vertrag_netflix_bestaetigung.pdf": dict(appType="vertrag", expect={"amountCents": 1399}),
    "Belege/scan_rechnung_optiker.png": dict(appType="rechnung", ocrFixture="optiker.ocr.txt", expect={
        "amountCents": m.OPTIK_GROSS, "vatCents": m.OPTIK_GROSS - optik_net, "date": "2026-03-27",
        "lineItems": 3, "lineItemsSumCents": optik_net, "lineItemsBasis": "netto"}),
    "Versicherungen/allianz_privatrente_standmitteilung_2025.pdf": dict(appType="rente", expect={
        "amountCents": cents(F["Versicherungen/allianz_privatrente_standmitteilung_2025.pdf"]["fund_value_eur"])}),
    "Versicherungen/bu_beitragsbescheinigung_2025.pdf": dict(appType="versicherung", expect={
        "amountCents": cents(F["Versicherungen/bu_beitragsbescheinigung_2025.pdf"]["yearly_premium_eur"])}),
    "Steuer/lohnsteuerbescheinigung_2025.pdf": dict(appType="lohnsteuerbescheinigung", expect={
        "grossCents": cents(F["Steuer/lohnsteuerbescheinigung_2025.pdf"]["gross_eur"])}),
    "Steuer/comdirect_jahressteuerbescheinigung_2025.pdf": dict(appType="steuerbescheinigung", expect={}),
    "Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf": dict(appType="spende", expect={"amountCents": 5000}),
    "einkaufszettel_handschrift.txt": dict(appType="einkaufszettel", expect={"lineItems": 6}),
    "Privat/irrelevant_urlaubsfoto.jpg": dict(appType="irrelevant", ocrFixture="urlaubsfoto.ocr.txt", expect={}),
    "Privat/irrelevant_rezept.txt": dict(appType="irrelevant", expect={}),
}
for rel, kw in docs.items():
    add(rel, **kw)

# ---- Querbezüge über den Gesamtbestand
pairs = []
for (day, time, kind, name, c) in m.PAYPAL_EVENTS:
    if kind == "bank_in":
        pairs.append({"a": f"ING:{day.isoformat()}:{-c}:paypal_debit", "b": f"PP:{day.isoformat()}:{c}:bank_in", "kind": "paypal"})
for mm in m.MONTHS:
    x = m.d(mm, 4).isoformat()
    pairs.append({"a": f"ING:{x}:-30000:sparplan", "b": f"CD:{x}:30000:sparplan_in", "kind": "eigene_konten"})
pairs.append({"a": f"ING:{m.d(6, 5).isoformat()}:-50000:tagesgeld", "b": "RB:2026-06-05:50000:tagesgeld_in", "kind": "eigene_konten"})
one_sided = [f"ING:{m.d(mm, 5).isoformat()}:-50000:tagesgeld" for mm in (1, 2, 3, 4, 5)]
receipts = [
    {"doc": "Belege/kassenbon_rewe_2026-04-12.png", "tx": f"CD:{m.d(4, 13).isoformat()}:{-m.REWE_TOTAL}:card_rewe"},
    {"doc": "Belege/kassenbon_edeka_2026-05-03.jpg", "tx": f"ING:2026-05-04:{-m.EDEKA_TOTAL}:card_edeka"},
    {"doc": "Belege/rechnung_amazon_monitor_2026-04.pdf", "tx": f"CD:{m.d(4, 9).isoformat()}:{-m.AMAZON_MONITOR_GROSS}:amazon_monitor"},
    {"doc": "Belege/rechnung_elektro_meyer_2026-02.pdf", "tx": f"ING:{m.d(3, 6).isoformat()}:{-m.ELEKTRO_GROSS}:handwerker"},
    {"doc": "Belege/scan_rechnung_optiker.png", "tx": f"ING:{m.d(3, 30).isoformat()}:{-m.OPTIK_GROSS}:optiker"},
]
all_ids = {x["id"] for x in ing_list + cd_list + pp_list + renault_list}
assert len(all_ids) == len(ing_list) + len(cd_list) + len(pp_list) + len(renault_list)
for p in pairs:
    assert p["a"] in all_ids and p["b"] in all_ids, p
for r in receipts:
    assert r["tx"] in all_ids, r
for o in one_sided:
    assert o in all_ids, o
assert len(ing_list) == F[ING_CSV]["bookings"] and len(cd_list) == F[CD_CSV]["bookings"]
assert len(march) == F["Banken/ING/ing_kontoauszug_2026-03.pdf"]["bookings"]
assert len(may) == F["Banken/ING/camt053_ing_2026-05.xml"]["bookings"]
assert m.ING_OPENING + total(ing_list) == cents(F[ING_CSV]["closing_eur"])

data["crossChecks"] = {
    "_hinweis": "Soll-Wirkung über alle Dateien in samples/out (abgeleitet aus samples/gen_model.py). IDs verweisen auf files[*].bookingsExpected[].id.",
    "accounts": ["ING", "COMDIRECT", "DEPOT", "PAYPAL", "RENAULT", "RENTE (Allianz 4711-0815)", "BU (Alte Leipziger 55-778899)"],
    "uniqueTransactions": {"ING": len(ing_list), "COMDIRECT": len(cd_list), "PAYPAL": len(pp_list), "RENAULT": len(renault_list)},
    "transferPairs": pairs,
    "oneSidedTransfers": one_sided,
    "receiptLinks": receipts,
}
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("ok", len(ing_list), len(cd_list), len(pp_list), len(pairs))
