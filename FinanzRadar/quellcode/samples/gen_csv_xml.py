"""CSV exports (ING, comdirect Girokonto and Depot, PayPal) and camt.053 XML."""
from __future__ import annotations

import csv
import io
from pathlib import Path
from xml.sax.saxutils import escape

from gen_model import ING_IBAN, OWNER, PAYPAL_MAIL, Booking, dd, fmt_de, iban_spaced

DEPOT = [
    # name, ISIN, WKN, quantity (thousandths), price (cents)
    ("Muster MSCI World UCITS ETF", "DE00MUST0001", "MUST01", 42518, 9875),
    ("Muster Euro Stoxx 50 ETF", "DE00MUST0002", "MUST02", 31204, 5210),
    ("Muster Emerging Markets ETF", "DE00MUST0003", "MUST03", 55771, 2740),
]

PAYPAL_HEADER = ["Datum", "Uhrzeit", "Zeitzone", "Name", "Typ", "Status", "Währung", "Brutto",
                 "Gebühr", "Netto", "Absender E-Mail-Adresse", "Empfänger E-Mail-Adresse",
                 "Transaktionscode", "Guthaben"]
BANK_TYPE = "Bankgutschrift auf PayPal-Konto"


def _write(path: Path, text: str, encoding: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding=encoding, newline="") as fh:
        fh.write(text)


def _clean(s: str) -> str:
    """Semicolons and newlines would break the delimited formats."""
    return s.replace(";", ",").replace("\n", " ")


def _chronological(bookings: list[Booking]) -> list[Booking]:
    return sorted(bookings, key=lambda b: (b.booked, b.valuta, b.payee, b.purpose))


def ing_csv(path: Path, bookings: list[Booking], opening: int) -> dict:
    """ING Umsatzanzeige: preamble, header 'Buchung;Wertstellungsdatum;...', newest first."""
    running, rows = opening, []
    for b in _chronological(bookings):
        running += b.cents
        rows.append((b, running))
    closing = running
    lines = [
        "Umsatzanzeige;Datei erstellt am: 30.06.2026 10:15",
        "",
        f"IBAN;{iban_spaced(ING_IBAN)}",
        "Kontoname;Girokonto",
        "Bank;ING",
        f"Kunde;{OWNER}",
        "Zeitraum;01.01.2026 - 30.06.2026",
        f"Saldo;{fmt_de(closing)};EUR",
        "",
        "Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;"
        "Saldo;Währung;Betrag;Währung",
    ]
    for b, balance in reversed(rows):
        lines.append(";".join([dd(b.booked), dd(b.valuta), _clean(b.payee), _clean(b.text),
                               _clean(b.purpose), fmt_de(balance), "EUR", fmt_de(b.cents), "EUR"]))
    _write(path, "\r\n".join(lines) + "\r\n", "cp1252")
    return {"opening": opening, "closing": closing, "bookings": len(rows)}


def comdirect_csv(path: Path, bookings: list[Booking], opening: int) -> dict:
    """comdirect Umsätze Girokonto: quoted fields, trailing ';', ISO-8859-1."""
    closing = opening + sum(b.cents for b in bookings)
    lines = [
        '"Umsätze Girokonto";',
        '"Zeitraum: 01.01.2026 - 30.06.2026";',
        f'"Alter Kontostand";"{fmt_de(opening)} EUR";',
        f'"Neuer Kontostand";"{fmt_de(closing)} EUR";',
        "",
        '"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";',
    ]
    for b in reversed(_chronological(bookings)):
        text = _clean(f"{b.payee} {b.purpose}")
        lines.append(f'"{dd(b.booked)}";"{dd(b.valuta)}";"{b.text}";"{text}";"{fmt_de(b.cents)}";')
    _write(path, "\r\n".join(lines) + "\r\n", "iso-8859-1")
    return {"opening": opening, "closing": closing, "bookings": len(bookings)}


def comdirect_depot_csv(path: Path) -> dict:
    """Depotbestand 30.06.2026: three fictional ETFs (layout UNVERIFIED)."""
    lines = [
        '"Depotbestand";"Depot-Nr. 123456789";',
        '"Stand";"30.06.2026";',
        "",
        '"Bezeichnung";"ISIN";"WKN";"Stück / Nom.";"Kurs";"Wert in EUR";',
    ]
    total = 0
    for name, isin, wkn, qty, price in DEPOT:
        value = round(qty * price / 1000)
        total += value
        qty_s = f"{qty / 1000:.3f}".replace(".", ",")
        lines.append(f'"{name}";"{isin}";"{wkn}";"{qty_s}";"{fmt_de(price)}";"{fmt_de(value)}";')
    lines.append(f'"Summe Depotwert";"";"";"";"";"{fmt_de(total)}";')
    _write(path, "\r\n".join(lines) + "\r\n", "iso-8859-1")
    return {"total": total, "positions": len(DEPOT)}


def paypal_csv(path: Path, rows: list[dict]) -> dict:
    """PayPal Aktivitäten: UTF-8 with BOM, comma delimiter, decimal comma inside quotes."""
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    writer.writerow(PAYPAL_HEADER)
    for r in rows:
        is_bank = r["type"] == BANK_TYPE
        name = "ING Girokonto" if is_bank else r["name"]
        sender = PAYPAL_MAIL if r["cents"] < 0 else ""
        receiver = PAYPAL_MAIL if r["cents"] > 0 else ""
        writer.writerow([dd(r["date"]), r["time"], "CET", name, r["type"], "Abgeschlossen",
                         "EUR", fmt_de(r["cents"]), "0,00", fmt_de(r["cents"]), sender,
                         receiver, r["code"], fmt_de(r["balance"])])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:  # UTF-8 with BOM
        fh.write(buf.getvalue())
    return {"lines": len(rows), "final_balance": rows[-1]["balance"] if rows else 0}


# ---------------------------------------------------------------- camt.053.001.08
_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"
_BKTX = {  # (family, sub family) per transaction kind, codes UNVERIFIED
    "Lastschrift": ("DDRD", "ESDD"),
    "Überweisung": ("ICDT", "ESCT"),
    "Dauerauftrag": ("ICDT", "ESCT"),
    "Kartenzahlung": ("CCRD", "POSD"),
    "Auszahlung Geldautomat": ("CCRD", "ATMW"),
    "Eingang": ("RCDT", "ESCT"),
}


def _ntry(i: int, b: Booking) -> str:
    dbit = b.cents < 0
    amt = f"{abs(b.cents) / 100:.2f}"
    fam, sub = _BKTX.get(b.text, ("PMNT", "OTHR"))
    refs = ""
    if b.end_to_end or b.mandate:
        refs = ("<Refs>"
                + (f"<EndToEndId>{escape(b.end_to_end)}</EndToEndId>" if b.end_to_end else "")
                + (f"<MndtId>{escape(b.mandate)}</MndtId>" if b.mandate else "")
                + "</Refs>")
    if dbit:
        party = (f"<Cdtr><Nm>{escape(b.payee)}</Nm></Cdtr>"
                 f"<CdtrAcct><Id><IBAN>{b.iban}</IBAN></Id></CdtrAcct>" if b.iban else
                 f"<Cdtr><Nm>{escape(b.payee)}</Nm></Cdtr>")
    else:
        party = (f"<Dbtr><Nm>{escape(b.payee)}</Nm></Dbtr>"
                 f"<DbtrAcct><Id><IBAN>{b.iban}</IBAN></Id></DbtrAcct>" if b.iban else
                 f"<Dbtr><Nm>{escape(b.payee)}</Nm></Dbtr>")
    addtl = (f"<AddtlTxInf>Glaeubiger-ID {escape(b.creditor_id)}</AddtlTxInf>"
             if b.creditor_id else "")
    return (
        "<Ntry>"
        f"<NtryRef>{i:06d}</NtryRef>"
        f'<Amt Ccy="EUR">{amt}</Amt>'
        f"<CdtDbtInd>{'DBIT' if dbit else 'CRDT'}</CdtDbtInd>"
        "<RvslInd>false</RvslInd>"
        "<Sts><Cd>BOOK</Cd></Sts>"
        f"<BookgDt><Dt>{b.booked.isoformat()}</Dt></BookgDt>"
        f"<ValDt><Dt>{b.valuta.isoformat()}</Dt></ValDt>"
        f"<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>{fam}</Cd><SubFmlyCd>{sub}</SubFmlyCd>"
        "</Fmly></Domn></BkTxCd>"
        "<NtryDtls><TxDtls>"
        f"{refs}"
        f'<AmtDtls><TxAmt><Amt Ccy="EUR">{amt}</Amt></TxAmt></AmtDtls>'
        f"<RltdPties>{party}</RltdPties>"
        f"<RmtInf><Ustrd>{escape(b.purpose)}</Ustrd></RmtInf>"
        f"{addtl}"
        "</TxDtls></NtryDtls>"
        "</Ntry>"
    )


def camt053(path: Path, bookings: list[Booking], opening: int, month: int = 5) -> dict:
    """camt.053.001.08 statement for one month of ING bookings."""
    before = opening + sum(b.cents for b in bookings if b.booked.month < month)
    month_b = _chronological([b for b in bookings if b.booked.month == month])
    closing = before + sum(b.cents for b in month_b)
    first = f"2026-{month:02d}-01"
    last = f"2026-{month:02d}-31"

    def bal(code: str, cents: int, day: str) -> str:
        ind = "CRDT" if cents >= 0 else "DBIT"
        return ("<Bal>"
                f"<Tp><CdOrPrtry><Cd>{code}</Cd></CdOrPrtry></Tp>"
                f'<Amt Ccy="EUR">{abs(cents) / 100:.2f}</Amt>'
                f"<CdtDbtInd>{ind}</CdtDbtInd>"
                f"<Dt><Dt>{day}</Dt></Dt>"
                "</Bal>")

    entries = "".join(_ntry(i, b) for i, b in enumerate(month_b, 1))
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<Document xmlns="{_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<BkToCstmrStmt>"
        "<GrpHdr><MsgId>MUSTER-CAMT-2026-05</MsgId><CreDtTm>2026-06-01T08:00:00</CreDtTm></GrpHdr>"
        "<Stmt>"
        f"<Id>MUSTER-STMT-ING-2026-{month:02d}</Id>"
        f"<ElctrncSeqNb>{month}</ElctrncSeqNb>"
        "<CreDtTm>2026-06-01T08:00:00</CreDtTm>"
        f"<FrToDt><FrDtTm>{first}T00:00:00</FrDtTm><ToDtTm>{last}T23:59:59</ToDtTm></FrToDt>"
        "<Acct>"
        f"<Id><IBAN>{ING_IBAN}</IBAN></Id>"
        "<Ccy>EUR</Ccy>"
        f"<Nm>{escape(OWNER)}</Nm>"
        "<Svcr><FinInstnId><BIC>INGDDEFFXXX</BIC></FinInstnId></Svcr>"
        "</Acct>"
        + bal("OPBD", before, first)
        + bal("CLBD", closing, last)
        + entries
        + "</Stmt></BkToCstmrStmt></Document>\n"
    )
    _write(path, xml, "utf-8")
    return {"opening": before, "closing": closing, "bookings": len(month_b)}
