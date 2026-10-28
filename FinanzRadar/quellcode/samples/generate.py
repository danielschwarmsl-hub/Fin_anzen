#!/usr/bin/env python3
"""Generate fictional finanzradar test samples into samples/out/.

Deterministic (random seed 42). Everything is fictional: names, IBANs, amounts.
Run:  python3 generate.py
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import gen_model as m
from gen_csv_xml import camt053, comdirect_csv, comdirect_depot_csv, ing_csv, paypal_csv
from gen_images import edeka_receipt, irrelevant_photo, optiker_scan, rewe_receipt
from gen_pdf_bank import ing_march_statement, renault_june_statement
from gen_pdf_docs import (allianz_standmitteilung, amazon_rechnung, bu_bescheinigung,
                          comdirect_steuer, elektro_rechnung, lohnabrechnung,
                          lohnsteuerbescheinigung, netflix_bestaetigung, spendenquittung)

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
MARK = "MUSTER – Testdokument"


def _verify(ing, cd, pp) -> None:
    """Cross-document coherence checks. Any mismatch aborts generation."""
    def ing_on(day, cents, payee_part=""):
        hits = [b for b in ing if b.booked == day and b.cents == cents and payee_part in b.payee]
        assert hits, f"no ING booking {day} {cents} {payee_part}"
        return hits[0]

    salary = [b for b in ing if b.kind == "salary" and b.booked.month == 3]
    assert len(salary) == 1 and salary[0].cents == m.NET_SALARY, "payslip net != ING salary"

    for ev_day, _, kind, name, cents in m.PAYPAL_EVENTS:
        if kind == "bank_in":
            debit = [b for b in ing if b.kind == "paypal_debit" and b.booked == ev_day
                     and b.cents == -cents]
            assert debit, f"PayPal bank_in {ev_day} {cents} without ING debit"
    paypal_bank = [r for r in pp if r["type"].startswith("Bankgutschrift")]
    assert len(paypal_bank) == sum(1 for e in m.PAYPAL_EVENTS if e[2] == "bank_in")

    ing_on(m.d(6, 5), -50000, "Max Mustermann")                 # Tagesgeld June, Renault credit
    ing_on(m.dt.date(2026, 5, 4), -m.EDEKA_TOTAL, "Edeka")      # Edeka receipt
    cd_rewe = [b for b in cd if b.booked == m.d(4, 13) and b.cents == -m.REWE_TOTAL]
    assert cd_rewe, "REWE receipt total not on comdirect"
    cd_amz = [b for b in cd if b.booked == m.d(4, 9) and b.cents == -m.AMAZON_MONITOR_GROSS]
    assert cd_amz, "Amazon monitor invoice not on comdirect"
    ing_on(m.d(3, 6), -m.ELEKTRO_GROSS, "Elektro Meyer")       # Handwerker by transfer


def _ex(expected: dict, rel: str, **fields) -> None:
    expected[rel] = fields


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    ing = m.ing_bookings()          # consumes RNG first (card payments)
    cd = m.comdirect_bookings()
    pp = m.paypal_rows()            # consumes RNG (transaction codes)
    _verify(ing, cd, pp)

    expected: dict = {}
    f = m.fmt_plain

    # ---- Banken
    r = ing_csv(OUT / "Banken/ING/ing_girokonto_2026H1.csv", ing, m.ING_OPENING)
    _ex(expected, "Banken/ING/ing_girokonto_2026H1.csv", type="bank_csv", issuer="ING",
        encoding="cp1252", delimiter=";", period="2026-01-01/2026-06-30",
        bookings=r["bookings"], opening_eur=f(m.ING_OPENING), closing_eur=f(r["closing"]),
        salary_eur_monthly=f(m.NET_SALARY), salary_bookings=6)

    r = comdirect_csv(OUT / "Banken/comdirect/comdirect_girokonto_2026H1.csv", cd,
                      m.COMDIRECT_OPENING)
    _ex(expected, "Banken/comdirect/comdirect_girokonto_2026H1.csv", type="bank_csv",
        issuer="comdirect", encoding="iso-8859-1", delimiter=";",
        period="2026-01-01/2026-06-30", bookings=r["bookings"],
        opening_eur=f(m.COMDIRECT_OPENING), closing_eur=f(r["closing"]))

    r = comdirect_depot_csv(OUT / "Banken/comdirect/comdirect_depot_2026-06-30.csv")
    _ex(expected, "Banken/comdirect/comdirect_depot_2026-06-30.csv", type="depot_csv",
        issuer="comdirect", encoding="iso-8859-1", date="2026-06-30", positions=r["positions"],
        total_eur=f(r["total"]))

    r = paypal_csv(OUT / "Banken/PayPal/paypal_aktivitaeten_2026H1.csv", pp)
    bank_total = sum(e[4] for e in m.PAYPAL_EVENTS if e[2] == "bank_in")
    _ex(expected, "Banken/PayPal/paypal_aktivitaeten_2026H1.csv", type="paypal_csv",
        issuer="PayPal", encoding="utf-8-bom", delimiter=",", rows=r["lines"],
        bank_funded_in_eur=f(bank_total), final_balance_eur=f(r["final_balance"]),
        ing_paypal_debits=sum(1 for b in ing if b.kind == "paypal_debit"))

    r = renault_june_statement(OUT / "Banken/Renault/renaultbank_tagesgeld_2026-06.pdf")
    _ex(expected, "Banken/Renault/renaultbank_tagesgeld_2026-06.pdf", type="savings_statement_pdf",
        issuer="Renault Bank direkt", period="2026-06", opening_eur=f(r["opening"]),
        closing_eur=f(r["closing"]), entries=r["entries"], credit_from_ing_eur="500.00")

    r = ing_march_statement(OUT / "Banken/ING/ing_kontoauszug_2026-03.pdf", ing, m.ING_OPENING)
    _ex(expected, "Banken/ING/ing_kontoauszug_2026-03.pdf", type="bank_statement_pdf",
        issuer="ING", period="2026-03", bookings=r["bookings"], opening_eur=f(r["opening"]),
        closing_eur=f(r["closing"]))

    r = camt053(OUT / "Banken/ING/camt053_ing_2026-05.xml", ing, m.ING_OPENING, month=5)
    _ex(expected, "Banken/ING/camt053_ing_2026-05.xml", type="camt053",
        issuer="ING", schema="camt.053.001.08", period="2026-05", bookings=r["bookings"],
        opening_eur=f(r["opening"]), closing_eur=f(r["closing"]))

    # ---- Belege
    r = lohnabrechnung(OUT / "Belege/lohnabrechnung_2026-03.pdf")
    _ex(expected, "Belege/lohnabrechnung_2026-03.pdf", type="payslip_pdf", issuer="Frigotechnik GmbH",
        period="2026-03", gross_eur=f(r["gross"]), net_eur=f(r["net"]),
        deductions_eur=f(r["deductions"]), credited_on_ing="2026-03-27")

    r = elektro_rechnung(OUT / "Belege/rechnung_elektro_meyer_2026-02.pdf")
    _ex(expected, "Belege/rechnung_elektro_meyer_2026-02.pdf", type="invoice_pdf",
        issuer="Elektro Meyer GmbH", invoice_no="RE-2026-0213", date="2026-02-20",
        net_eur=f(r["net"]), vat_19_eur=f(r["mwst"]), total_eur=f(r["gross"]),
        labour_net_eur=f(r["labour"]), paid_by="transfer", paid_on="2026-03-06")

    r = amazon_rechnung(OUT / "Belege/rechnung_amazon_monitor_2026-04.pdf")
    _ex(expected, "Belege/rechnung_amazon_monitor_2026-04.pdf", type="invoice_pdf",
        issuer="Amazon EU S.à r.l.", invoice_no="RE-AMZ-2026-0407-7781", date="2026-04-07",
        net_eur=f(r["net"]), vat_19_eur=f(r["mwst"]), total_eur=f(r["gross"]),
        paid_by="card (comdirect)", paid_on="2026-04-09")

    r = rewe_receipt(OUT / "Belege/kassenbon_rewe_2026-04-12.png")
    _ex(expected, "Belege/kassenbon_rewe_2026-04-12.png", type="receipt_image", issuer="REWE",
        date="2026-04-12", total_eur=f(r["total"]), paid_by="card (comdirect)",
        booked_on="2026-04-13", scan_effect=False)

    r = edeka_receipt(OUT / "Belege/kassenbon_edeka_2026-05-03.jpg")
    _ex(expected, "Belege/kassenbon_edeka_2026-05-03.jpg", type="receipt_image", issuer="EDEKA",
        date="2026-05-03", total_eur=f(r["total"]), paid_by="card (ING)", booked_on="2026-05-04",
        scan_effect=True)

    r = netflix_bestaetigung(OUT / "Belege/vertrag_netflix_bestaetigung.pdf")
    _ex(expected, "Belege/vertrag_netflix_bestaetigung.pdf", type="subscription_confirmation_pdf",
        issuer="Netflix International B.V.", date="2026-06-09", price_monthly_eur=f(r["price"]))

    r = optiker_scan(OUT / "Belege/scan_rechnung_optiker.png")
    _ex(expected, "Belege/scan_rechnung_optiker.png", type="invoice_image_only",
        issuer="Optik Muster GmbH", invoice_no="OPT-2026-0327", date="2026-03-27",
        net_eur=f(r["net"]), vat_19_eur=f(r["mwst"]), total_eur=f(r["gross"]),
        text_layer=False, paid_on="2026-03-30")

    # ---- Versicherungen
    r = allianz_standmitteilung(OUT / "Versicherungen/allianz_privatrente_standmitteilung_2025.pdf")
    _ex(expected, "Versicherungen/allianz_privatrente_standmitteilung_2025.pdf",
        type="insurance_statement_pdf", issuer="Allianz Lebensversicherungs-AG",
        contract_no="4711-0815", stichtag="2025-12-31", paid_2025_eur=f(r["paid_2025"]),
        fund_value_eur=f(r["fund"]), surrender_value_eur=f(r["surrender"]))

    r = bu_bescheinigung(OUT / "Versicherungen/bu_beitragsbescheinigung_2025.pdf")
    _ex(expected, "Versicherungen/bu_beitragsbescheinigung_2025.pdf", type="tax_certificate_pdf",
        issuer="Alte Leipziger Versicherung AG", contract_no="55-778899", year=2025,
        yearly_premium_eur=f(r["yearly"]))

    # ---- Steuer
    r = lohnsteuerbescheinigung(OUT / "Steuer/lohnsteuerbescheinigung_2025.pdf")
    _ex(expected, "Steuer/lohnsteuerbescheinigung_2025.pdf", type="tax_certificate_pdf",
        issuer="Frigotechnik GmbH", year=2025, gross_eur=f(r["gross"]), lohnsteuer_eur=f(r["lstax"]),
        kirchensteuer_eur=f(r["kist"]), soli_eur="0.00", sv_total_eur=f(r["sv_total"]))

    r = comdirect_steuer(OUT / "Steuer/comdirect_jahressteuerbescheinigung_2025.pdf")
    _ex(expected, "Steuer/comdirect_jahressteuerbescheinigung_2025.pdf", type="tax_certificate_pdf",
        issuer="comdirect", year=2025, kapitalertraege_eur=f(r["income"]),
        freistellung_used_eur="1000.00", kapest_eur=f(r["kapest"]), soli_eur=f(r["soli"]),
        kist_eur=f(r["kist"]))

    r = spendenquittung(OUT / "Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf")
    _ex(expected, "Steuer/spendenquittung_aerzte_ohne_grenzen_2026.pdf", type="donation_receipt_pdf",
        issuer="Ärzte ohne Grenzen e.V.", year=2026, amount_eur=f(r["amount"]), date=r["date"],
        paid_on="2026-05-14")

    # ---- Misc, non-finance and notes
    _write_text(OUT / "einkaufszettel_handschrift.txt", [
        MARK, "Einkaufszettel (abgetippt)", "- Milch", "- Brot", "- Eier (10er)",
        "- Kaffee", "- Bananen", "- Zahnpasta"])
    _ex(expected, "einkaufszettel_handschrift.txt", type="note_text", is_finance=False)

    irrelevant_photo(OUT / "Privat/irrelevant_urlaubsfoto.jpg")
    _ex(expected, "Privat/irrelevant_urlaubsfoto.jpg", type="photo", is_finance=False)

    _write_text(OUT / "Privat/irrelevant_rezept.txt", [
        MARK, "Rezept: Kartoffelsuppe für 4 Personen",
        "Zutaten: 600 g Kartoffeln, 1 Zwiebel, 1 l Gemüsebrühe, 200 ml Sahne, Salz, Schnittlauch",
        "Zubereitung: Zwiebel würfeln, Kartoffeln schälen und in Stücke schneiden. Alles in der",
        "Brühe weich kochen, pürieren, mit Sahne verfeinern und mit Schnittlauch servieren."])
    _ex(expected, "Privat/irrelevant_rezept.txt", type="note_text", is_finance=False)

    with open(OUT / "EXPECTED.json", "w", encoding="utf-8") as fh:
        json.dump({"seed": m.SEED, "household": f"{m.OWNER}, {m.STREET}, {m.CITY}",
                   "files": expected}, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    files = sorted(p for p in OUT.rglob("*") if p.is_file())
    print(f"wrote {len(files)} files to {OUT}")
    for p in files:
        print(f"  {p.relative_to(OUT)}  ({p.stat().st_size} bytes)")


def _write_text(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
