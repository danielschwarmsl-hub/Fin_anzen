"""Bank statement PDFs: ING Girokonto (March 2026) and Renault Bank direkt Tagesgeld (June 2026)."""
from __future__ import annotations

import datetime as dt

from reportlab.lib.units import mm

from gen_model import (ING_IBAN, OWNER, RENAULT_IBAN, RENAULT_OPENING_JUNE,
                       RENAULT_INTEREST_JUNE, STREET, CITY, Booking, dd, fmt_de, iban_spaced)
from gen_pdf import H1, H2, BODY, SMALL, build_pdf, grid, kv, multi, p, spacer


def ing_march_statement(path: str, bookings: list[Booking], opening: int) -> dict:
    """Kontoauszug März 2026: subset of the H1 ING bookings."""
    march = [b for b in bookings if b.booked.month == 3]
    alt = opening + sum(b.cents for b in bookings if b.booked.month < 3)
    neu = alt + sum(b.cents for b in march)

    rows = [["Buchung", "Valuta", "Vorgang / Auftraggeber / Verwendungszweck", "Betrag EUR"]]
    for b in march:
        rows.append([dd(b.booked), dd(b.valuta),
                     multi(b.text, b.payee, b.purpose), fmt_de(b.cents)])

    story = [
        p("ING-DiBa AG – Kontoauszug Girokonto", H1),
        p(f"Kontoinhaber: {OWNER}, {STREET}, {CITY}"),
        p(f"IBAN: {iban_spaced(ING_IBAN)}"),
        spacer(3),
        kv([("Zeitraum", "01.03.2026 – 31.03.2026"),
            ("Kontoauszug Nr.", "03/2026"),
            ("Alter Saldo (01.03.2026)", f"{fmt_de(alt)} EUR"),
            ("Neuer Saldo (31.03.2026)", f"{fmt_de(neu)} EUR")]),
        spacer(4),
        p("Umsätze", H2),
        grid(rows, [24 * mm, 22 * mm, 102 * mm, 26 * mm], right_cols=(3,)),
        spacer(4),
        p(f"Summe Umsätze März: {fmt_de(neu - alt, plus=True)} EUR", BODY),
        spacer(2),
        p("Dieser Auszug dient ausschließlich Testzwecken.", SMALL),
    ]
    build_pdf(path, story, "ING Kontoauszug 03/2026")
    return {"opening": alt, "closing": neu, "bookings": len(march)}


def renault_june_statement(path: str) -> dict:
    """Tagesgeld Kontoauszug Juni 2026: ING transfer in, interest credit."""
    alt = RENAULT_OPENING_JUNE
    entries = [
        (dt.date(2026, 6, 5), dt.date(2026, 6, 5), "Gutschrift Überweisung",
         ["Überweisung von ING Girokonto", f"IBAN {iban_spaced(ING_IBAN)}",
          f"{OWNER}", "Tagesgeld Sparen 06/2026"], 50000),
        (dt.date(2026, 6, 30), dt.date(2026, 6, 30), "Zinsgutschrift",
         ["Zinsgutschrift Tagesgeld", "Abrechnungszeitraum 01.06.2026 – 30.06.2026"],
         RENAULT_INTEREST_JUNE),
    ]
    neu = alt + sum(e[4] for e in entries)

    rows = [["Buchungstag", "Wert", "Vorgang", "Betrag EUR"]]
    for booked, valuta, vorgang, lines, cents in entries:
        rows.append([dd(booked), dd(valuta), multi(vorgang, *lines), fmt_de(cents, plus=True)])

    story = [
        p("Renault Bank direkt – Kontoauszug Tagesgeldkonto", H1),
        p(f"Kontoinhaber: {OWNER}, {STREET}, {CITY}"),
        p(f"Tagesgeldkonto IBAN: {iban_spaced(RENAULT_IBAN)}"),
        spacer(3),
        kv([("Zeitraum", "01.06.2026 – 30.06.2026"),
            ("Kontoauszug Nr.", "06/2026"),
            ("Alter Kontostand (01.06.2026)", f"{fmt_de(alt)} EUR"),
            ("Neuer Kontostand (30.06.2026)", f"{fmt_de(neu)} EUR")]),
        spacer(4),
        p("Buchungen", H2),
        grid(rows, [24 * mm, 22 * mm, 100 * mm, 28 * mm], right_cols=(3,)),
        spacer(4),
        p(f"Neuer Kontostand 30.06.2026: {fmt_de(neu)} EUR", BODY),
        spacer(2),
        p("Dieser Auszug dient ausschließlich Testzwecken.", SMALL),
    ]
    build_pdf(path, story, "Renault Bank Tagesgeld Kontoauszug 06/2026")
    return {"opening": alt, "closing": neu, "entries": len(entries)}
