"""Fictional household model for the finanzradar test samples.

Single source of truth: every writer reads from here, so amounts match across
documents. Money is integer cents, dates are datetime.date. All names, IBANs and
numbers are fictional.
"""
from __future__ import annotations

import datetime as dt
import random
import zlib
from dataclasses import dataclass

SEED = 42
rng = random.Random(SEED)

OWNER = "Max Mustermann"
STREET = "Musterstraße 1"
CITY = "20095 Hamburg"
EMPLOYER = "Frigotechnik GmbH"
CREDITOR_ID = "DE98ZZZ09999999999"
PAYPAL_CREDITOR_ID = "LU96ZZZ0000000000000000058"
PAYPAL_MAIL = "max.mustermann@example.com"

ING_IBAN = "DE12500105170000000001"
COMDIRECT_IBAN = "DE00100100000000000002"
RENAULT_IBAN = "DE00123400000000000003"

MONTHS = (1, 2, 3, 4, 5, 6)
MONTH_NAME = {1: "Januar", 2: "Februar", 3: "März", 4: "April", 5: "Mai", 6: "Juni"}

ING_OPENING = 425000        # 01.01.2026
COMDIRECT_OPENING = 120000  # 01.01.2026
RENAULT_OPENING_JUNE = 582000
RENAULT_INTEREST_JUNE = 873

REWE_TOTAL = 6784           # REWE receipt 2026-04-12, card payment on comdirect
EDEKA_TOTAL = 4738          # Edeka receipt 2026-05-03, card payment on ING
ELEKTRO_GROSS = 41230       # Elektro Meyer invoice, paid by transfer
OPTIK_GROSS = 38900         # Optik invoice, paid by card
AMAZON_MONITOR_GROSS = 24900


# ---------------------------------------------------------------- helpers
def fake_iban(key: str) -> str:
    """Deterministic fictional DE IBAN (checksum not valid)."""
    a = zlib.crc32(key.encode()) % 10**10
    b = zlib.crc32((key + "#").encode()) % 10**8
    return f"DE00{a:010d}{b:08d}"


def fmt_de(cents: int, plus: bool = False) -> str:
    """German money format: 1.150,00 / -12,34."""
    sign = "-" if cents < 0 else ("+" if plus else "")
    a = abs(cents)
    whole = f"{a // 100:,}".replace(",", ".")
    return f"{sign}{whole},{a % 100:02d}"


def fmt_plain(cents: int) -> str:
    """Plain decimal with point: -12.34."""
    return f"{cents / 100:.2f}"


def iban_spaced(iban: str) -> str:
    return " ".join(iban[i:i + 4] for i in range(0, len(iban), 4))


def prop(cents: int, num: int, den: int) -> int:
    """cents * num / den, rounded half up (non-negative values)."""
    return (cents * num * 2 + den) // (2 * den)


def d(m: int, day: int) -> dt.date:
    """Date in 2026, shifted back over weekends (no holiday calendar)."""
    x = dt.date(2026, m, day)
    while x.weekday() >= 5:
        x -= dt.timedelta(days=1)
    return x


def dd(x: dt.date) -> str:
    return x.strftime("%d.%m.%Y")


# ---------------------------------------------------------------- payslip (March 2026)
GROSS_2026 = 520000
KV_ALLG_2026 = prop(GROSS_2026, 730, 10000)    # 7,3 %
KV_ZUSATZ_2026 = prop(GROSS_2026, 125, 10000)  # 1,25 % Zusatzbeitrag
PV_2026 = prop(GROSS_2026, 240, 10000)         # 2,4 % inkl. Kinderlosenzuschlag
RV_2026 = prop(GROSS_2026, 930, 10000)         # 9,3 %
AV_2026 = prop(GROSS_2026, 130, 10000)         # 1,3 %
SV_2026 = KV_ALLG_2026 + KV_ZUSATZ_2026 + PV_2026 + RV_2026 + AV_2026
LSTAX_2026 = 72332                             # vereinfacht, nicht amtlich
KIST_2026 = prop(LSTAX_2026, 9, 100)           # 9 % (Hamburg)
SOLI_2026 = 0                                  # unter Freigrenze
NET_SALARY = GROSS_2026 - SV_2026 - LSTAX_2026 - KIST_2026 - SOLI_2026

# ---------------------------------------------------------------- Lohnsteuerbescheinigung 2025
GROSS_2025_MONTH = 500000
LSTAX_2025_MONTH = prop(GROSS_2025_MONTH, 1391, 10000)  # vereinfacht
SV_2025_MONTH = {
    "kv_allg": prop(GROSS_2025_MONTH, 730, 10000),
    "kv_zusatz": prop(GROSS_2025_MONTH, 125, 10000),
    "pv": prop(GROSS_2025_MONTH, 240, 10000),
    "rv": prop(GROSS_2025_MONTH, 930, 10000),
    "av": prop(GROSS_2025_MONTH, 130, 10000),
}


# ---------------------------------------------------------------- bookings
@dataclass(frozen=True)
class Booking:
    account: str           # "ING" or "COMDIRECT"
    booked: dt.date        # Buchungstag
    valuta: dt.date        # Wertstellung
    payee: str             # Auftraggeber / Empfänger
    text: str              # Buchungstext / Vorgang
    purpose: str           # Verwendungszweck
    cents: int             # signed, negative = debit
    kind: str = "other"    # tag for EXPECTED.json
    iban: str = ""         # counterparty IBAN
    mandate: str = ""      # SEPA mandate reference
    creditor_id: str = ""  # Gläubiger-ID
    end_to_end: str = ""   # EndToEndId


def _lastschrift(m, day, payee, purpose, cents, kind, mandate="", cid=CREDITOR_ID):
    x = d(m, day)
    return Booking("ING", x, x, payee, "Lastschrift", purpose, cents, kind,
                   fake_iban(payee), mandate, cid, f"E2E-{kind}-{m:02d}")


def _card(account, x, merchant, cents, kind="card"):
    return Booking(account, x, x, merchant, "Kartenzahlung",
                   f"VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ {x.strftime('%d.%m')}",
                   cents, kind, fake_iban(merchant))


CARD_MERCHANTS = [
    ("dm drogerie markt", 899, 3450),
    ("Rossmann Filiale", 999, 2490),
    ("Bäckerei Junge", 310, 1190),
    ("Penny Markt", 1550, 5890),
    ("Tankstelle Shell", 4500, 7200),
]

# PayPal activity (date, time, kind, counterparty, signed amount in PayPal)
# kind: bank_in = Bankgutschrift auf PayPal-Konto (funded by ING debit),
#       pay = Allgemeine Zahlung, refund = Rueckzahlung, send = Geld senden
PAYPAL_EVENTS = [
    (d(1, 14), "09:12:41", "bank_in", "ABC Shop", 8990),
    (d(1, 14), "09:13:05", "pay", "ABC Shop", -8990),
    (d(1, 21), "18:02:17", "bank_in", "Sportartikel Beispiel", 3495),
    (d(1, 21), "18:03:44", "pay", "Sportartikel Beispiel", -3495),
    (d(2, 2), "07:55:10", "bank_in", "PayPal Aufladung", 10000),
    (d(2, 11), "12:30:02", "bank_in", "ABC Shop", 12900),
    (d(2, 11), "12:31:19", "pay", "ABC Shop", -12900),
    (d(2, 19), "20:44:58", "pay", "eBay Sarl", -3990),
    (d(2, 25), "13:02:09", "pay", "Kiosk Ecke", -350),
    (d(3, 18), "10:08:33", "bank_in", "Buchhandlung Muster", 2240),
    (d(3, 18), "10:09:02", "pay", "Buchhandlung Muster", -2240),
    (d(3, 27), "16:20:11", "refund", "ABC Shop", 1500),
    (d(4, 2), "19:40:12", "pay", "Lieferdienst Probe", -1290),
    (d(4, 9), "08:47:26", "bank_in", "Gartenmarkt Testhof", 7430),
    (d(4, 9), "08:48:09", "pay", "Gartenmarkt Testhof", -7430),
    (d(4, 20), "21:15:40", "send", "Anna Beispiel", -2500),
    (d(5, 20), "11:05:52", "bank_in", "ABC Shop", 5999),
    (d(5, 20), "11:06:30", "pay", "ABC Shop", -5999),
    (d(6, 12), "17:33:21", "bank_in", "Reisebüro Probe", 18000),
    (d(6, 12), "17:34:50", "pay", "Reisebüro Probe", -18000),
]


def ing_bookings() -> list[Booking]:
    out: list[Booking] = []
    for m in MONTHS:
        g = d(m, 27)
        out.append(Booking("ING", g, g, EMPLOYER, "Eingang", f"Gehalt {m:02d}/2026",
                           NET_SALARY, "salary", fake_iban("frigotechnik")))
        out.append(Booking("ING", d(m, 3), d(m, 3), "Hausverwaltung Elbblick", "Dauerauftrag",
                           f"Miete {m:02d}/2026 Musterstraße 1", -115000, "rent",
                           fake_iban("hv-elbblick")))
        out.append(_lastschrift(m, 12, "Vattenfall Europe Sales GmbH",
                                f"Abschlag Strom Kd.-Nr. 5009123 Monat {m:02d}/2026",
                                -8450, "utility", "VATT-MM-4711"))
        out.append(_lastschrift(m, 15, "Telekom Deutschland GmbH",
                                f"Rechnung 2026-{m:02d} Kd.-Nr. 88310042",
                                -4995, "telecom", "TEL-MM-0042"))
        out.append(_lastschrift(m, 9, "Netflix International B.V.",
                                f"Netflix Standard 2026-{m:02d}", -1399, "streaming"))
        out.append(_lastschrift(m, 6, "Spotify AB", "Spotify Premium 1 Konto",
                                -1099, "streaming"))
        out.append(_lastschrift(m, 2, "Verkehrsgesellschaft Musterstadt GmbH",
                                f"Deutschlandticket Abo 2026-{m:02d} Kd. 7788",
                                -5800, "ticket", "VGM-7788"))
        out.append(_lastschrift(m, 2, "Allianz Lebensversicherungs-AG",
                                "Vertragsnr. 4711-0815 Beitrag Privatrente",
                                -15000, "privatrente", "ALZ-4711-0815"))
        out.append(_lastschrift(m, 10, "Alte Leipziger Versicherung AG",
                                "BU-Vertrag 55-778899 Beitrag", -6230, "bu", "AL-55-778899"))
        out.append(_lastschrift(m, 6, "Urban Sports Club GmbH",
                                f"Mitgliedschaft Club 2026-{m:02d}", -4900, "fitness", "USC-0042"))
        out.append(_lastschrift(m, 18, "OpenAI Ireland Ltd.", "ChatGPT Plus Abo",
                                -2000, "subscription"))
        out.append(_lastschrift(m, 20, "Adobe Systems Software Ireland Ltd",
                                "Adobe Creative Cloud Abo", -2439, "subscription"))
        out.append(Booking("ING", d(m, 14), d(m, 14), "Geldautomat Hamburg-Eimsbüttel",
                           "Auszahlung Geldautomat", "Bargeldauszahlung", -10000, "cash"))
        out.append(Booking("ING", d(m, 4), d(m, 4), OWNER, "Überweisung",
                           "Umbuchung Verrechnungskonto comdirect Sparplan", -30000,
                           "sparplan", COMDIRECT_IBAN))
        out.append(Booking("ING", d(m, 5), d(m, 5), OWNER, "Überweisung",
                           f"Tagesgeld Sparen {m:02d}/2026", -50000, "tagesgeld", RENAULT_IBAN))
        if m in (1, 4):
            out.append(_lastschrift(m, 5, "Gewerkschaft ver.di",
                                    "Mitgliedsbeitrag Quartal", -3850, "union", "VERDI-9911"))
            out.append(_lastschrift(m, 22, "ARD ZDF Deutschlandradio Beitragsservice",
                                    "Rundfunkbeitrag Quartal", -5508, "rundfunk", "RBS-0042"))
        if m == 2:
            out.append(_lastschrift(m, 16, "Haftpflicht Musterversicherung AG",
                                    "Jahresbeitrag Privathaftpflicht Vertr.-Nr. 77-112233",
                                    -12690, "haftpflicht", "HAFT-77-112233"))
        if m == 3:
            out.append(Booking("ING", d(m, 6), d(m, 6), "Elektro Meyer GmbH", "Überweisung",
                               "RE-2026-0213 Elektroinstallation Küche", -ELEKTRO_GROSS,
                               "handwerker", fake_iban("elektro-meyer")))
            out.append(Booking("ING", d(m, 30), d(m, 30), "Optik Muster GmbH", "Kartenzahlung",
                               "VISA Debitkarte Rechnung OPT-2026-0327", -OPTIK_GROSS, "optiker"))
        if m == 5:
            out.append(Booking("ING", d(m, 14), d(m, 14), "Ärzte ohne Grenzen e.V.", "Überweisung",
                               "Spende Projekte weltweit", -5000, "spende",
                               fake_iban("aerzte-ohne-grenzen")))
            out.append(Booking("ING", dt.date(2026, 5, 4), dt.date(2026, 5, 4), "Edeka Eimsbüttel",
                               "Kartenzahlung",
                               "VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ 03.05", -EDEKA_TOTAL,
                               "card_edeka"))
        for _ in range(3):
            name, lo, hi = CARD_MERCHANTS[rng.randrange(len(CARD_MERCHANTS))]
            out.append(_card("ING", d(m, rng.randint(2, 27)), name, -rng.randint(lo, hi)))
    for ev_day, ev_time, kind, name, cents in PAYPAL_EVENTS:
        if kind == "bank_in":
            purpose = (f"PP.1234.PP . {name}, Ihr Einkauf bei {name}" if name != "PayPal Aufladung"
                       else "PP.1234.PP . Aufladung PayPal-Guthaben")
            out.append(Booking("ING", ev_day, ev_day, "PayPal Europe S.a.r.l. et Cie S.C.A",
                               "Lastschrift", purpose, -cents, "paypal_debit",
                               fake_iban("paypal-europe"), "PAYPAL-MANDAT-0001", PAYPAL_CREDITOR_ID))
    out.sort(key=lambda b: (b.booked, b.valuta, b.payee))
    return out


def comdirect_bookings() -> list[Booking]:
    out: list[Booking] = []
    for m in MONTHS:
        x = d(m, 4)
        out.append(Booking("COMDIRECT", x, x, OWNER, "Überweisung",
                           "Umbuchung Sparplan ETF", 30000, "sparplan_in", ING_IBAN))
        out.append(Booking("COMDIRECT", x, x, "comdirect Depot", "Wertpapierkauf ETF",
                           "Sparplan ETF Ausführung", -30000, "sparplan_buy"))
    fixed = [
        (d(1, 20), -4127, "REWE Markt Hamburg-Eimsbüttel", "card_rewe"),
        (d(2, 14), -2980, "REWE Markt Hamburg-Eimsbüttel", "card_rewe"),
        (d(3, 21), -5210, "REWE Markt Hamburg-Eimsbüttel", "card_rewe"),
        (d(4, 13), -REWE_TOTAL, "REWE Markt Hamburg-Eimsbüttel", "card_rewe"),
        (d(6, 5), -3845, "REWE Markt Hamburg-Eimsbüttel", "card_rewe"),
        (d(1, 17), -2398, "Amazon Payments Europe S.C.A.", "amazon"),
        (d(4, 9), -AMAZON_MONITOR_GROSS, "Amazon Payments Europe S.C.A.", "amazon_monitor"),
        (d(5, 2), -1249, "Amazon Payments Europe S.C.A.", "amazon"),
        (d(2, 3), -5840, "Aral Tankstelle Hamburg", "fuel"),
        (d(3, 10), -6215, "Aral Tankstelle Hamburg", "fuel"),
        (d(5, 18), -7190, "Aral Tankstelle Hamburg", "fuel"),
        (d(2, 27), -3450, "Restaurant Zum Alten Hafen", "restaurant"),
        (d(6, 19), -4820, "Restaurant Zum Alten Hafen", "restaurant"),
    ]
    purposes = {
        "card_rewe": "VISA Debitkarte REWE Markt Hamburg",
        "amazon": "AMZN Mktp DE Bestellung 171-2233445",
        "amazon_monitor": "AMZN Mktp DE RE-AMZ-2026-0407-7781",
        "fuel": "VISA Debitkarte Tankstelle Hamburg",
        "restaurant": "VISA Debitkarte Gastronomie Hamburg",
    }
    for x, cents, payee, kind in fixed:
        out.append(Booking("COMDIRECT", x, x, payee, "Kartenzahlung", purposes[kind], cents, kind))
    out.sort(key=lambda b: (b.booked, b.payee))
    return out


def paypal_rows() -> list[dict]:
    """PayPal activity with running balance (Guthaben), starting at 0,00."""
    rows, balance = [], 0
    for day, time, kind, name, cents in PAYPAL_EVENTS:
        balance += cents
        assert balance >= 0, f"PayPal balance negative on {day}"
        typ = {"bank_in": "Bankgutschrift auf PayPal-Konto", "pay": "Allgemeine Zahlung",
               "refund": "Zahlungsrückerstattung", "send": "Geld gesendet"}[kind]
        rows.append({
            "date": day, "time": time, "name": name, "type": typ, "cents": cents,
            "balance": balance, "code": f"{rng.randrange(16**17):017X}",
        })
    return rows
