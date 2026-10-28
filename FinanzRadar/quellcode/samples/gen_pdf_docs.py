"""Non-bank PDFs: payslip, tax and insurance documents, invoices, donation receipt, subscription."""
from __future__ import annotations

from reportlab.lib.units import mm

from gen_model import (AMAZON_MONITOR_GROSS, CITY, ELEKTRO_GROSS, EMPLOYER, GROSS_2026,
                       GROSS_2025_MONTH, KIST_2026, KV_ALLG_2026, KV_ZUSATZ_2026, LSTAX_2026,
                       LSTAX_2025_MONTH, NET_SALARY, OWNER, PV_2026, RV_2026, AV_2026,
                       SOLI_2026, STREET, SV_2025_MONTH, fmt_de, iban_spaced, prop, ING_IBAN)
from gen_pdf import H1, H2, BODY, SMALL, build_pdf, grid, kv, p, spacer


def lohnabrechnung(path: str) -> dict:
    """Gehaltsabrechnung März 2026; Netto equals the ING salary credit."""
    deductions = [
        ("Lohnsteuer (Steuerklasse I, vereinfacht)", LSTAX_2026),
        ("Solidaritätszuschlag", SOLI_2026),
        ("Kirchensteuer 9 % (Hamburg)", KIST_2026),
        ("Krankenversicherung Arbeitnehmeranteil 7,3 %", KV_ALLG_2026),
        ("Zusatzbeitrag Krankenversicherung 1,25 %", KV_ZUSATZ_2026),
        ("Pflegeversicherung Arbeitnehmeranteil 2,4 %", PV_2026),
        ("Rentenversicherung Arbeitnehmeranteil 9,3 %", RV_2026),
        ("Arbeitslosenversicherung Arbeitnehmeranteil 1,3 %", AV_2026),
    ]
    total_ded = sum(v for _, v in deductions)
    assert GROSS_2026 - total_ded == NET_SALARY, "payslip does not sum to net"

    rows = [["Bezeichnung", "Betrag EUR"], ["Bruttogehalt", fmt_de(GROSS_2026)]]
    rows += [[label, fmt_de(-v)] for label, v in deductions]
    rows += [["Summe Abzüge", fmt_de(-total_ded)], ["Nettoentgelt (Auszahlung)", fmt_de(NET_SALARY)]]

    story = [
        p(f"{EMPLOYER} – Entgeltabrechnung", H1),
        kv([("Mitarbeiter", OWNER), ("Anschrift", f"{STREET}, {CITY}"),
            ("Personalnummer", "10472"), ("Abrechnungszeitraum", "03/2026"),
            ("Steuerklasse / Freibeträge", "I / 0,0"), ("Konfession", "ev"),
            ("Krankenkasse", "Muster-Krankenkasse (fiktiv)"),
            ("Sozialversicherungsnummer", "12 150390 M 000"),
            ("Bankverbindung", f"ING, IBAN {iban_spaced(ING_IBAN)}")]),
        spacer(4),
        p("Entgelt und Abzüge", H2),
        grid(rows, [120 * mm, 40 * mm], right_cols=(1,), bold_last=True),
        spacer(4),
        p(f"Auszahlung netto {fmt_de(NET_SALARY)} EUR per Überweisung am 27.03.2026.", BODY),
        spacer(2),
        p("Testdaten: Steuer- und Sozialversicherungsbeträge sind vereinfacht berechnet "
          "und nicht amtlich. Dieser Beleg ist ausschließlich für Testzwecke bestimmt.", SMALL),
    ]
    build_pdf(path, story, "Lohnabrechnung 03/2026")
    return {"gross": GROSS_2026, "net": NET_SALARY, "deductions": total_ded}


def lohnsteuerbescheinigung(path: str) -> dict:
    """Lohnsteuerbescheinigung 2025, simplified line numbers (see FORMATS.md)."""
    year = {k: v * 12 for k, v in SV_2025_MONTH.items()}
    sv_total = sum(year.values())
    gross = GROSS_2025_MONTH * 12
    lstax = LSTAX_2025_MONTH * 12
    kist = prop(lstax, 9, 100)
    rows = [
        ["Zeile", "Bezeichnung", "Betrag EUR"],
        ["3", "Bruttoarbeitslohn", fmt_de(gross)],
        ["4", "Einbehaltene Lohnsteuer", fmt_de(lstax)],
        ["5", "Solidaritätszuschlag", fmt_de(0)],
        ["6", "Kirchensteuer des Arbeitnehmers", fmt_de(kist)],
        ["22", "Rentenversicherung (Arbeitnehmeranteil)", fmt_de(year["rv"])],
        ["23", "Arbeitslosenversicherung", fmt_de(year["av"])],
        ["24", "Krankenversicherung allgemeiner Beitrag", fmt_de(year["kv_allg"])],
        ["25", "Krankenversicherung Zusatzbeitrag", fmt_de(year["kv_zusatz"])],
        ["26", "Pflegeversicherung", fmt_de(year["pv"])],
        ["27", "Summe Sozialversicherungsbeiträge", fmt_de(sv_total)],
    ]
    story = [
        p("Lohnsteuerbescheinigung 2025", H1),
        kv([("Arbeitgeber", EMPLOYER), ("Arbeitnehmer", f"{OWNER}, {STREET}, {CITY}"),
            ("Steuerklasse", "I"), ("Zeitraum", "01.01.2025 – 31.12.2025")]),
        spacer(4),
        grid(rows, [16 * mm, 110 * mm, 34 * mm], right_cols=(2,)),
        spacer(3),
        p("Testdokument: Zeilennummern vereinfacht, nicht amtliches Formular.", SMALL),
    ]
    build_pdf(path, story, "Lohnsteuerbescheinigung 2025")
    return {"gross": gross, "lstax": lstax, "kist": kist, "sv_total": sv_total}


def elektro_rechnung(path: str) -> dict:
    """Handwerkerrechnung Elektro Meyer, 19 % MwSt, paid by transfer."""
    labour, material = 23000, 11647
    net = labour + material
    mwst = prop(net, 19, 100)
    gross = net + mwst
    assert gross == ELEKTRO_GROSS, (gross, ELEKTRO_GROSS)
    rows = [
        ["Pos.", "Leistung / Material", "Netto EUR"],
        ["1", "Arbeitskosten Elektroinstallation Küche (6 h, Steckdosen, FI-Schalter)", fmt_de(labour)],
        ["2", "Material: Leitungen NYM-J 3x1,5, Schalter, Dosen, Kleinteile", fmt_de(material)],
    ]
    totals = [
        ["", "Nettobetrag", fmt_de(net)],
        ["", "zzgl. 19 % Umsatzsteuer", fmt_de(mwst)],
        ["", "Rechnungsbetrag brutto", fmt_de(gross)],
    ]
    story = [
        p("Elektro Meyer GmbH – Elektrotechnik-Meisterbetrieb", H1),
        p("Beispielweg 4, 22765 Hamburg · Tel. 040 000000"),
        spacer(3),
        kv([("Rechnungsnummer", "RE-2026-0213"), ("Rechnungsdatum", "20.02.2026"),
            ("Steuernummer", "19/123/45678"), ("Kunde", f"{OWNER}, {STREET}, {CITY}"),
            ("Leistungszeitraum", "10.02.2026 – 19.02.2026")]),
        spacer(4),
        grid(rows, [12 * mm, 128 * mm, 30 * mm], right_cols=(2,)),
        spacer(2),
        grid(totals, [12 * mm, 128 * mm, 30 * mm], right_cols=(2,), header=False, bold_last=True),
        spacer(4),
        p(f"Arbeitskosten enthalten: {fmt_de(labour)} EUR netto (Hinweis für Steuerbonus).", BODY),
        p("Zahlbar binnen 14 Tagen ohne Abzug per Überweisung auf IBAN "
          f"{iban_spaced('DE00500100000000000014')}, Verwendungszweck RE-2026-0213.", BODY),
        spacer(2),
        p("Testdokument mit fiktiven Angaben.", SMALL),
    ]
    build_pdf(path, story, "Rechnung Elektro Meyer RE-2026-0213")
    return {"net": net, "mwst": mwst, "gross": gross, "labour": labour}


def amazon_rechnung(path: str) -> dict:
    """Rechnung Monitor 249,00 EUR incl. 19 % MwSt (Arbeitsmittel)."""
    net = round(AMAZON_MONITOR_GROSS / 1.19)
    mwst = AMAZON_MONITOR_GROSS - net
    assert prop(net, 19, 100) == mwst
    rows = [
        ["Pos.", "Artikel", "Menge", "Netto EUR", "MwSt", "Brutto EUR"],
        ["1", "Monitor 27 Zoll Full HD IPS, Arbeitsmittel Homeoffice", "1",
         fmt_de(net), "19 %", fmt_de(AMAZON_MONITOR_GROSS)],
    ]
    totals = [
        ["", "Summe netto", fmt_de(net)],
        ["", "19 % Umsatzsteuer", fmt_de(mwst)],
        ["", "Gesamtbetrag brutto", fmt_de(AMAZON_MONITOR_GROSS)],
    ]
    story = [
        p("Amazon EU S.à r.l. – Rechnung (Testdokument)", H1),
        kv([("Rechnungsnummer", "RE-AMZ-2026-0407-7781"), ("Rechnungsdatum", "07.04.2026"),
            ("Bestellnummer", "171-2233445"), ("Kunde", f"{OWNER}, {STREET}, {CITY}"),
            ("Zahlungsart", "Kreditkarte (comdirect), Belastung 09.04.2026")]),
        spacer(4),
        grid(rows, [10 * mm, 80 * mm, 14 * mm, 26 * mm, 14 * mm, 30 * mm],
             right_cols=(3, 5)),
        spacer(2),
        grid(totals, [10 * mm, 130 * mm, 30 * mm], right_cols=(2,), header=False, bold_last=True),
        spacer(3),
        p("Lieferung 08.04.2026. Dieser Beleg dient als Nachweis für Arbeitsmittel.", BODY),
        spacer(2),
        p("Testdokument mit fiktiven Angaben.", SMALL),
    ]
    build_pdf(path, story, "Rechnung Monitor 04/2026")
    return {"net": net, "mwst": mwst, "gross": AMAZON_MONITOR_GROSS}


def allianz_standmitteilung(path: str) -> dict:
    """Standmitteilung fondsgebundene Privatrente, Stichtag 31.12.2025."""
    monthly = 15000                       # 150,00 EUR
    paid_2025 = monthly * 12
    paid_total = monthly * 82             # Mar 2019 – Dec 2025
    fund = 1648237
    surrender = 1491000
    guaranteed_rente = 41200
    rows = [
        ["Kennzahl", "Wert"],
        ["Vertragsnummer", "4711-0815"],
        ["Tarif", "Fondsgebundene Privatrente (Testtarif)"],
        ["Versicherungsbeginn", "01.03.2019"],
        ["Monatlicher Beitrag", fmt_de(monthly) + " EUR"],
        ["Beiträge im Kalenderjahr 2025", fmt_de(paid_2025) + " EUR"],
        ["Beiträge seit Vertragsbeginn", fmt_de(paid_total) + " EUR"],
        ["Fondsguthaben am 31.12.2025", fmt_de(fund) + " EUR"],
        ["Rückkaufswert am 31.12.2025", fmt_de(surrender) + " EUR"],
        ["Garantierte monatliche Rente ab 01.03.2056", fmt_de(guaranteed_rente) + " EUR"],
    ]
    story = [
        p("Allianz Lebensversicherungs-AG – Standmitteilung", H1),
        p(f"Versicherungsnehmer: {OWNER}, {STREET}, {CITY}"),
        p("Stichtag: 31.12.2025", BODY),
        spacer(4),
        grid(rows, [100 * mm, 60 * mm], right_cols=(1,)),
        spacer(4),
        p("Die Standmitteilung ist unverbindlich. Das Fondsguthaben schwankt mit dem "
          "Marktwert der Fondsanteile.", SMALL),
        p("Testdokument mit fiktiven Angaben.", SMALL),
    ]
    build_pdf(path, story, "Allianz Standmitteilung 2025")
    return {"paid_2025": paid_2025, "fund": fund, "surrender": surrender}


def bu_bescheinigung(path: str) -> dict:
    """Beitragsbescheinigung Berufsunfähigkeitsversicherung 2025."""
    yearly = 6230 * 12
    rows = [
        ["Position", "Wert"],
        ["Versicherungsnehmer", f"{OWNER}, {STREET}, {CITY}"],
        ["Vertragsnummer", "55-778899"],
        ["Versicherte Person", OWNER],
        ["Versicherte BU-Rente (monatlich)", fmt_de(150000) + " EUR"],
        ["Beitrag monatlich", fmt_de(6230) + " EUR"],
        ["Beitragsjahr", "2025"],
        ["Jahresbeitrag 2025 (gezahlt)", fmt_de(yearly) + " EUR"],
    ]
    story = [
        p("Alte Leipziger Versicherung AG – Beitragsbescheinigung BU", H1),
        p("Bescheinigung für die Steuererklärung 2025", BODY),
        spacer(4),
        grid(rows, [80 * mm, 80 * mm], right_cols=(1,)),
        spacer(4),
        p("Hinweis: Die Beiträge zur Berufsunfähigkeitsversicherung können als sonstige "
          "Vorsorgeaufwendungen berücksichtigt werden. Diese Bescheinigung ersetzt keine "
          "Steuerberatung.", BODY),
        spacer(2),
        p("Testdokument mit fiktiven Angaben.", SMALL),
    ]
    build_pdf(path, story, "BU Beitragsbescheinigung 2025")
    return {"yearly": yearly}


def comdirect_steuer(path: str) -> dict:
    """comdirect Jahressteuerbescheinigung 2025 with Freistellungsauftrag."""
    income = 124055
    freistellung = 100000
    taxable = income - freistellung
    kapest = prop(taxable, 25, 100)
    soli = prop(kapest, 55, 1000)
    kist = prop(kapest, 9, 100)
    rows = [
        ["Bezeichnung", "Betrag EUR"],
        ["Kapitalerträge 2025 (Ausschüttungen Depot)", fmt_de(income)],
        ["Freistellungsauftrag genutzt", fmt_de(-freistellung)],
        ["Steuerpflichtige Kapitalerträge", fmt_de(taxable)],
        ["Kapitalertragsteuer 25 %", fmt_de(-kapest)],
        ["Solidaritätszuschlag 5,5 % der KapESt", fmt_de(-soli)],
        ["Kirchensteuer 9 % der KapESt", fmt_de(-kist)],
        ["Einbehaltene Steuern gesamt", fmt_de(-(kapest + soli + kist))],
    ]
    story = [
        p("comdirect – Jahressteuerbescheinigung 2025", H1),
        kv([("Kunde", f"{OWNER}, {STREET}, {CITY}"), ("Depot-Nr.", "123456789"),
            ("Steuer-ID", "12 345 678 901"), ("Zeitraum", "01.01.2025 – 31.12.2025"),
            ("Freistellungsauftrag", "1.000,00 EUR")]),
        spacer(4),
        grid(rows, [110 * mm, 50 * mm], right_cols=(1,), bold_last=True),
        spacer(4),
        p("Testdokument mit fiktiven Angaben. Bank- und Depotbezeichnungen dienen nur als "
          "Kopfzeile.", SMALL),
    ]
    build_pdf(path, story, "Jahressteuerbescheinigung 2025")
    return {"income": income, "kapest": kapest, "soli": soli, "kist": kist}


def spendenquittung(path: str) -> dict:
    """Zuwendungsbestätigung for a 50,00 EUR donation on 14.05.2026."""
    amount = 5000
    story = [
        p("Ärzte ohne Grenzen e.V. – Zuwendungsbestätigung 2026", H1),
        kv([("Zuwendender", f"{OWNER}, {STREET}, {CITY}"),
            ("Betrag", fmt_de(amount) + " EUR"),
            ("Zuwendungsdatum", "14.05.2026"),
            ("Zahlungsweg", f"Überweisung, IBAN {iban_spaced(ING_IBAN)}"),
            ("Zweck", "Spende für Projekte weltweit (allgemeine humanitäre Hilfe)"),
            ("Steuernummer des Vereins", "00/000/00000 (Testdaten)"),
            ("Ausstellungsdatum", "15.06.2026")]),
        spacer(4),
        p("Wir bestätigen, dass die Zuwendung ausschließlich und unmittelbar für gemeinnützige "
          "Zwecke verwendet wird. Es wurde keine Gegenleistung gewährt.", BODY),
        spacer(3),
        p("Die Zuwendung dient als Spendennachweis für die Steuererklärung 2026.", BODY),
        spacer(2),
        p("Testdokument mit fiktiven Angaben.", SMALL),
    ]
    build_pdf(path, story, "Zuwendungsbestaetigung 2026")
    return {"amount": amount, "date": "14.05.2026"}


def netflix_bestaetigung(path: str) -> dict:
    """Short email-style subscription confirmation (fictional)."""
    story = [
        p("Mitgliedschaftsbestätigung", H1),
        kv([("Betreff", "Ihre Netflix-Mitgliedschaft ist aktiv"),
            ("Datum", "09.06.2026"),
            ("Empfänger", f"{OWNER}, {STREET}, {CITY}"),
            ("Tarif", "Standard (HD)"),
            ("Preis", "13,99 EUR pro Monat"),
            ("Abrechnung", "monatlich am 9. des Monats"),
            ("Zahlungsart", f"Lastschrift, ING IBAN {iban_spaced(ING_IBAN)}")]),
        spacer(4),
        p("Hallo Max, vielen Dank für Ihre Mitgliedschaft. Sie können Ihren Tarif jederzeit im "
          "Konto unter „Mitgliedschaft“ ändern oder kündigen.", BODY),
        spacer(3),
        p("Diese E-Mail-Nachricht ist ein Testdokument. Absender und Inhalt sind fiktiv.", SMALL),
    ]
    build_pdf(path, story, "Netflix Mitgliedschaft Bestaetigung")
    return {"price": 1399, "date": "09.06.2026"}
