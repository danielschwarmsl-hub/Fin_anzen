#!/usr/bin/env python3
"""Originalnahe Test-PDFs MIT Textebene (nur Entwicklung).

Baut die Bank- und Depotdokumente des Nutzers (geschwärzte Scans, siehe tests/fixtures/real-ocr) so nach, wie die
Originale aufgebaut sind: gleiche Seitenaufteilung, Spaltenlage über x-Positionen, Schriftarten (comdirect-Abrechnungen
in Courier als 132-Spalten-Druckzeilen, Rest Helvetica), Seitenkopf/-fuß auf jeder Seite, Formulierungen wortgleich.
Personen, Konten, Depot- und Referenznummern sind erfunden; Beträge sind plausibel und rechnen sich auf
(Salden, Summen, Stückzahl × Kurs). Dazu einige Formulierungsvarianten älterer/anderer Abrechnungen.

Ausgabe: tests/fixtures/real-like/<name>.pdf und tests/fixtures/real-like/EXPECTED.json (Sollwerte, Beträge in Cent).
Die Text-Snapshots (pdf.js der App) erzeugt danach: node scripts/snapshot-real-like.mjs

Aufruf (im Ordner quellcode):  python3 scripts/make-real-like-pdfs.py
Abhängigkeiten: reportlab (bringt Pillow mit). Ausgabe ist deterministisch (invariant=1).
"""
import io
import json
import os
from decimal import Decimal, ROUND_HALF_UP

from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tests', 'fixtures', 'real-like')
W, H = A4
PX = W / 1414.0  # Pixel der Vorlagen-Seitenbilder (200 dpi, angezeigt 1414 px breit) → pt

EXPECTED = {}

# ------------------------------------------------------------------ Zahlen, Kennungen


def cents(v):
    return int((Decimal(str(v)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def de(c, sign=False, dec=2):
    """Cent → '1.234,56' (deutsch); sign=True → mit '+'/'-'."""
    neg = c < 0
    v = Decimal(abs(c)) / 100
    s = f'{v:,.{dec}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
    if sign:
        return ('-' if neg else '+') + s
    return ('-' if neg else '') + s


def dnum(x, dec):
    """Dezimalzahl → deutsch mit fester Nachkommazahl ('1,0815')."""
    s = f'{Decimal(str(x)):,.{dec}f}'
    return s.replace(',', 'X').replace('.', ',').replace('X', '.')


def iban_de(blz, kto):
    bban = f'{blz}{int(kto):010d}'
    check = 98 - int(bban + '131400') % 97
    raw = f'DE{check:02d}{bban}'
    return ' '.join(raw[i:i + 4] for i in range(0, len(raw), 4)), raw


def isin_valid(isin):
    digits = ''.join(str(ord(c) - 55) if c.isalpha() else c for c in isin.upper())
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def isin(prefix11):
    for d in range(10):
        if isin_valid(prefix11 + str(d)):
            return prefix11 + str(d)
    raise ValueError(prefix11)


def iso(d):
    """'19.08.2026' → '2026-08-19'"""
    dd, mm, yy = d.split('.')
    if len(yy) == 2:
        yy = '20' + yy
    return f'{yy}-{mm}-{dd}'


# Fiktiver Kunde und fiktive Konten
KUNDE = ['Herrn', 'Jan Beispiel', 'Lindenallee 12', '22880 Wedel']
CD_GIRO_IBAN, CD_GIRO_RAW = iban_de('20041133', 7340061)
CD_TG_IBAN, CD_TG_RAW = iban_de('20041133', 7340062)
CD_KUNDENNR = '512 7340061'
CD_DEPOT = '7340061 00'
DKB_IBAN, DKB_RAW = iban_de('12030000', 1084470523)
MLP_IBAN, MLP_RAW = iban_de('67230000', 4711235)

# ------------------------------------------------------------------ Zeichnen


def logo_image(text, font_file, size, color=(35, 47, 52), symbol=None):
    """Schriftzug als Bild (Logos sind in echten PDFs Grafik, keine Textebene)."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype(font_file, size)
    except OSError:
        font = ImageFont.load_default()
    pad = int(size * 0.15)
    sym_w = int(size * 1.15) if symbol else 0
    dummy = ImageDraw.Draw(Image.new('L', (10, 10)))
    x0, y0, x1, y1 = dummy.textbbox((0, 0), text, font=font)
    img = Image.new('RGB', (x1 - x0 + 2 * pad + sym_w, y1 - y0 + 2 * pad), 'white')
    d = ImageDraw.Draw(img)
    if symbol:
        r = int(size * 0.48)
        cx, cy = pad + r, img.height // 2
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=symbol, width=int(size * 0.16))
        d.rectangle((cx - int(r * 0.35), cy - int(r * 0.2), cx - int(r * 0.05), cy + r + 2), fill=symbol)
    d.text((pad + sym_w - x0, pad - y0), text, font=font, fill=color)
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    buf.seek(0)
    return ImageReader(buf)


SANS_BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
_LOGOS = {}


def logo(name):
    if name not in _LOGOS:
        if name == 'comdirect':
            _LOGOS[name] = logo_image('comdirect', SANS_BOLD, 120)
        elif name == 'dkb':
            _LOGOS[name] = logo_image('DKB', SANS_BOLD, 120, color=(80, 80, 80))
        elif name == 'mlp':
            _LOGOS[name] = logo_image('MLP', SANS_BOLD, 120, color=(16, 61, 99), symbol=(176, 137, 104))
    return _LOGOS[name]


class Doc:
    """Dünne Hülle um reportlab: y-Angaben von oben (pt), Text immer als Textobjekt."""

    def __init__(self, name, title, author, subject='', creator='Druckausgabe'):
        os.makedirs(OUT, exist_ok=True)
        self.name = name
        self.path = os.path.join(OUT, name + '.pdf')
        self.c = canvas.Canvas(self.path, pagesize=A4, invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor(author)
        self.c.setSubject(subject)
        self.c.setCreator(creator)
        self.pages = 1

    def t(self, x, y, s, size=9, font='Helvetica', align='l', color=None, space=0):
        c = self.c
        if color:
            c.setFillColorRGB(*color)
        if space:
            to = c.beginText()
            to.setTextOrigin(x, H - y)
            to.setFont(font, size)
            to.setCharSpace(space)
            to.textOut(s)
            to.setCharSpace(0)  # Tc bleibt sonst im Grafikzustand und sperrt allen folgenden Text
            c.drawText(to)
        else:
            c.setFont(font, size)
            if align == 'l':
                c.drawString(x, H - y, s)
            elif align == 'r':
                c.drawRightString(x, H - y, s)
            else:
                c.drawCentredString(x, H - y, s)
        if color:
            c.setFillColorRGB(0, 0, 0)

    def tp(self, xpx, ypx, s, size=9, font='Helvetica', align='l', **kw):
        """Position in Vorlagen-Pixeln (Seitenbild 1414 × 2000)."""
        self.t(xpx * PX, ypx * PX, s, size, font, align, **kw)

    def fit(self, xpx, ypx, s, size, font='Helvetica', maxpx=1160):
        """Fließtextzeile; zu lange Zeilen leicht verkleinert (wie Blocksatz-Treiber)."""
        while stringWidth(s, font, size) > maxpx * PX and size > 6:
            size -= 0.1
        self.tp(xpx, ypx, s, size, font)

    def segs(self, xpx, ypx, parts, size=9):
        """Zeile aus Abschnitten in wechselnder Schrift (normal/fett) – je Abschnitt ein Textobjekt."""
        x = xpx * PX
        for font, s in parts:
            self.t(x, ypx * PX, s, size, font)
            x += stringWidth(s, font, size)

    def hline(self, x1px, x2px, ypx, width=0.6, dash=None, gray=0):
        c = self.c
        c.setLineWidth(width)
        c.setStrokeColorRGB(gray, gray, gray)
        if dash:
            c.setDash(*dash)
        c.line(x1px * PX, H - ypx * PX, x2px * PX, H - ypx * PX)
        if dash:
            c.setDash()
        c.setStrokeColorRGB(0, 0, 0)

    def vline(self, xpx, y1px, y2px, width=0.6):
        self.c.setLineWidth(width)
        self.c.line(xpx * PX, H - y1px * PX, xpx * PX, H - y2px * PX)

    def rect(self, x1px, y1px, x2px, y2px, fill=None, stroke=False, width=0.6):
        c = self.c
        if fill:
            c.setFillColorRGB(*fill)
        c.setLineWidth(width)
        c.rect(x1px * PX, H - y2px * PX, (x2px - x1px) * PX, (y2px - y1px) * PX,
               fill=1 if fill else 0, stroke=1 if stroke else 0)
        c.setFillColorRGB(0, 0, 0)

    def img(self, image, x1px, y1px, wpx):
        iw, ih = image.getSize()
        w = wpx * PX
        h = w * ih / iw
        self.c.drawImage(image, x1px * PX, H - y1px * PX - h, w, h)

    def page(self):
        self.c.showPage()
        self.pages += 1

    def save(self, expected):
        self.c.save()
        expected = {'file': self.name + '.pdf', 'pages': self.pages, **expected}
        EXPECTED[self.name] = expected
        print(f'{self.name}.pdf  ({self.pages} S.)')


# ------------------------------------------------------------------ comdirect: Kopf/Fuß


def cd_footer(d):
    d.hline(195, 1300, 1868, 0.8)
    d.tp(195, 1900, 'comdirect – eine Marke der Commerzbank AG', 7.5)
    d.tp(195, 1921, 'Pascalkehre 15, 25451 Quickborn', 7.5)
    d.tp(1105, 1900, 'USt-ID: DE 114 103 514', 7.5)


def cd_letterhead(d, left=195, telefax=True, sender='comdirect, 25449 Quickborn'):
    d.img(logo('comdirect'), 990, 125, 315)
    d.tp(left, 327, sender, 7)
    for i, line in enumerate(KUNDE):
        d.tp(left, 438 + i * 28, line, 10)
    d.tp(976, 440, 'Telefon:', 7.5, align='r')
    d.tp(1003, 440, '04106 - 708 25 00', 10)
    if telefax:
        d.tp(976, 468, 'Telefax:', 7.5, align='r')
        d.tp(1003, 468, '04106 - 708 25 85', 10)
    d.tp(976, 497, 'E-Mail:', 7.5, align='r')
    d.tp(1003, 497, 'www.comdirect.de/kontakt', 11)
    d.tp(1003, 518, '(E-Mail über Kontaktformular)', 7.5)
    d.tp(976, 569, 'Kundennummer:', 7.5, 'Helvetica-Bold', align='r')
    d.tp(1003, 569, CD_KUNDENNR, 10)


# ------------------------------------------------------------------ 1. comdirect Geschäftsabrechnung Wertpapierkauf (d7)

COUR = 'Courier'
COURB = 'Courier-Bold'


class Mono:
    """132-Spalten-Druckzeilen in Courier: jede Zeile ein einziger String, Spalten über Leerzeichen."""

    def __init__(self, d, xpx, size, cw_px):
        self.d, self.x, self.size, self.cw = d, xpx, size, cw_px

    def line(self, ypx, s, bold=False, col=0):
        self.d.tp(self.x + col * self.cw, ypx, s, self.size, COURB if bold else COUR)


def cols(*parts):
    """[(spalte, text, 'l'|'r')] → eine Zeile; 'r' = rechtsbündig bis einschließlich Spalte."""
    buf = []
    for col, text, al in parts:
        start = col - len(text) + 1 if al == 'r' else col
        if len(buf) < start:
            buf.extend(' ' * (start - len(buf)))
        buf[start:start + len(text)] = list(text)
    return ''.join(buf).rstrip()


def cd_trade_header(d, intro_new=True):
    """Kopf der Abrechnung: Hinweistext rechts oben, Logo, Bankanschrift, Kundenanschrift, Depotnummer."""
    d.img(logo('comdirect'), 134, 70, 305)
    x, s = 741, 8.6
    if intro_new:
        lines = ['Ihren Auftrag haben wir gemäß unseren produktbezogenen',
                 'Geschäftsbedingungen "Trading" wie nachstehend ausgeführt.', None,
                 'Die Wertpapiere haben wir der Abrechnung entsprechend gebucht.', None,
                 'Wir bitten Sie, diese Abrechnung auf ihre Richtigkeit und',
                 'Vollständigkeit zu überprüfen und etwaige Einwendungen', 'unverzüglich zu erheben.']
    else:
        lines = ['Ihren Auftrag haben wir gemäß unseren Sonderbe-', 'dingungen für Wertpapiergeschäfte wie nachstehend',
                 'ausgeführt.', None, 'Die Wertpapiere haben wir der Abrechnung entspre-', 'chend gebucht.', None,
                 'Wir bitten Sie, diese Abrechnung auf ihre Richtigkeit und',
                 'Vollständigkeit zu überprüfen und etwaige Einwendungen:', 'unverzüglich zu erheben.']
    y = 72
    for ln in lines:
        if ln is None:
            y += 9
            continue
        d.tp(x, y, ln, s)
        y += 20
    d.tp(262, 205, '25449 Quickborn', 11.5)
    d.tp(155, 236, 'Telefon  :  04106-708 25 00', 10.5)
    d.tp(364, 393, '48213 010', 9)
    for i, line in enumerate(KUNDE):
        d.tp(155, 425 + i * 28 + (14 if i > 1 else 0), line, 10)
    d.tp(741, 412, 'Depotnr.:', 9.5, 'Helvetica-Bold')
    d.tp(908, 412, CD_DEPOT, 9.5)
    d.tp(741, 437, 'BLZ:', 9.5, 'Helvetica-Bold')
    d.tp(908, 437, '200 411 33', 9.5)


def cd_kundenbox(d, datum, ref):
    """Seite 2 der Abrechnung: Kasten „Kundennr./BLZ | Bezeichnung“ und Bankanschrift rechts."""
    d.rect(134, 87, 694, 256, stroke=True, width=1)
    d.rect(135, 88, 297, 111, fill=(0.85, 0.85, 0.85))
    d.rect(297, 88, 693, 111, fill=(0.82, 0.82, 0.82))
    d.tp(147, 105, 'Kundennr.', 8.5)
    d.tp(240, 105, '/BLZ', 8.5)
    d.tp(495, 105, 'Bezeichnung', 8.5, align='c')
    d.vline(297, 111, 202)
    d.tp(166, 147, CD_KUNDENNR.split()[0] + ' ' + CD_KUNDENNR.split()[1], 8.5)
    d.tp(160, 186, '200 411 33', 8.5)
    for i, ln in enumerate(['Jan Beispiel', 'Lindenallee 12', '22880 Wedel']):
        d.tp(309, 132 + i * 24, ln, 8.5)
    d.rect(135, 202, 693, 226, fill=(0.88, 0.88, 0.88))
    d.tp(414, 219, 'abweichend wirtschaftlich Berechtigter', 8.5, align='c')
    d.tp(370, 251, '----', 8.5, align='c')
    d.img(logo('comdirect'), 1005, 115, 315)
    d.tp(807, 274, 'Pascalkehre 15', 10)
    d.tp(807, 307, '25451 Quickborn', 10)
    d.tp(510, 355, '48213 010', 9)
    for i, ln in enumerate(KUNDE):
        d.tp(147, 455 + i * 27, ln, 10)
    d.tp(807, 408, 'Telefon:', 10)
    d.tp(1010, 408, '04106 - 708 25 00', 10)
    d.tp(807, 448, 'Datum:', 10)
    d.tp(1010, 448, datum, 10)
    d.tp(807, 489, 'Depotnummer:', 10, 'Helvetica-Bold')
    d.tp(1015, 489, CD_DEPOT, 10)
    d.tp(807, 529, 'Referenz-Nummer:', 10)
    d.tp(1015, 529, ref, 10)


def cd_tax_page(d, nr, datum, stk, name, wkn, isin_, lasten, basis, kest, soli, kist, valuta, gunsten=False):
    """„Steuerliche Behandlung: …“ (Seite 2 der neuen Abrechnung) mit Fußzeile KEINE STEUERBESCHEINIGUNG."""
    cd_kundenbox(d, datum, '1SKG8H2L4ZT00R1X')
    art = 'Wertpapierverkauf' if gunsten else 'Wertpapierkauf'
    word = 'Gunsten' if gunsten else 'Lasten'
    d.tp(134, 852, f'Steuerliche Behandlung: {art} Nr. {nr} vom {datum}', 10.5, 'Helvetica-Bold')
    d.tp(134, 877, 'Stk.', 10.5, 'Helvetica-Bold')
    d.tp(262, 877, f'{stk} {name}, WKN / ISIN: {wkn}  / {isin_}', 10.5, 'Helvetica-Bold')
    sgn = 1 if gunsten else -1
    d.tp(134, 953, f'Zu Ihren {word} vor Steuern:', 10.5, 'Helvetica-Bold')
    d.tp(1078, 953, 'EUR', 10, COUR)
    d.tp(1362, 953, de(sgn * lasten), 10, COUR, align='r')
    d.tp(134, 1210, 'Steuerbemessungsgrundlage', 10.5, 'Helvetica-Bold')
    d.tp(780, 1210, 'EUR', 10, COUR)
    d.tp(1064, 1210, de(basis), 10, COUR, align='r')
    for i, (lab, v) in enumerate([('Kapitalertragsteuer', kest), ('Solidaritätszuschlag', soli), ('Kirchensteuer', kist)]):
        y = 1296 + i * 28.5
        d.tp(134, y, lab, 10.5)
        d.tp(780, y, 'EUR', 10, COUR)
        d.tp(1064, y, de(-v if v else 0), 10, COUR, align='r')
    d.hline(780, 1064, 1356, 0.5)
    taxes = kest + soli + kist
    d.tp(134, 1382, 'abgeführte Steuern', 10.5, 'Helvetica-Bold')
    d.tp(1078, 1382, 'EUR', 10, COUR)
    d.tp(1362, 1382, de(-taxes if taxes else 0), 10, COUR, align='r')
    d.hline(1078, 1362, 1386, 0.5)
    nach = sgn * lasten - taxes
    d.tp(134, 1439, f'Zu Ihren {word} nach Steuern:', 10.5, 'Helvetica-Bold')
    d.tp(1078, 1439, 'EUR', 10, COUR)
    d.tp(1362, 1439, de(nach), 10, COUR, align='r')
    verb = 'Gutschrift' if gunsten else 'Belastung'
    d.tp(134, 1668, f'Die {verb} erfolgt mit Valuta {valuta} auf Konto EUR mit der IBAN {CD_GIRO_IBAN}', 10.5,
         'Helvetica-Bold')
    d.tp(707, 1968, 'KEINE STEUERBESCHEINIGUNG', 12, align='c')
    for k in range(3):
        d.rect(1283 + k * 12, 1960, 1291 + k * 12, 1968, fill=(0, 0, 0))
    return nach


def make_wertpapierkauf():
    d = Doc('comdirect_wertpapierkauf', 'Wertpapierabrechnung', 'comdirect')
    cd_trade_header(d)
    qty, price = 3, 35400
    kurswert = qty * price
    fees = [('Abwickl.entgelt Clearstream', 290), ('Provision', 990), ('Börsenplatzabhäng. Entgelt', 250)]
    fee_sum = sum(v for _, v in fees)
    total = kurswert + fee_sum
    name1, name2, wkn, isin_ = 'Microsoft Corp.', 'Registered Shares DL-,00000625', '870747', 'US5949181045'
    d.tp(155, 693, 'GESCHÄFTSABRECHNUNG VOM 19.08.2026', 11, 'Helvetica-Bold')
    d.tp(80, 727, '*', 11, COUR)
    m = Mono(d, 155, 9.9, 14.1)
    m.line(745, 'Wertpapierkauf', bold=True)
    m.line(766, cols((0, 'Geschäftsnummer', 'l'), (18, ': 72 410938', 'l')))
    m.line(788, cols((0, 'Ordernummer', 'l'), (18, ': 000641927735-001', 'l'), (38, 'Rechnungsnummer', 'l'),
                     (56, ': 834729105562D2B7', 'l')))
    m.line(809, cols((0, 'Geschäftstag', 'l'), (18, ': 19.08.2026', 'l'), (38, 'Ausführungsplatz', 'l'),
                     (56, ': TRADEGATE', 'l')))
    m.line(831, cols((0, 'Handelszeit', 'l'), (18, ': 07:52 Uhr (MEZ/MESZ)', 'l'), (59, '(Kommissionsgeschäft)', 'l')))
    m.line(874, cols((0, 'Wertpapier-Bezeichnung', 'l'), (80, 'WPKNR/ISIN', 'r')), bold=True)
    m.line(895, cols((0, name1, 'l'), (80, wkn, 'r')))
    m.line(916, cols((0, name2, 'l'), (80, isin_, 'r')))
    m.line(981, cols((0, 'Nennwert', 'l'), (26, 'Zum Kurs von', 'l')), bold=True)
    m.line(1002, cols((0, 'St.', 'l'), (8, str(qty), 'r'), (26, 'EUR', 'l'), (37, de(price), 'r')))
    m.line(1024, cols((26, 'Kurswert', 'l'), (55, ':', 'l'), (57, 'EUR', 'l'), (80, de(kurswert), 'r')))
    m.line(1063, ' -' * 40)
    m.line(1088, 'Eigene Entgelte')
    for i, (lab, v) in enumerate(fees + [('Summe Entgelte', fee_sum)]):
        m.line(1109 + i * 21.5, cols((26, lab, 'l'), (55, ':', 'l'), (57, 'EUR', 'l'), (80, de(v), 'r')))
    m.line(1195, ' -' * 40)
    m.line(1259, cols((0, 'IBAN', 'l'), (38, 'Valuta', 'l'), (81, 'Zu Ihren Lasten vor Steuern', 'r')), bold=True)
    m.line(1280, cols((0, CD_GIRO_IBAN, 'l'), (30, 'EUR', 'l'), (38, '21.08.2026', 'l'), (57, 'EUR', 'l'),
                      (80, de(total), 'r')))
    m.line(1323, 'Verwahrungs-Art: WERTPAPIERRECHNUNG USA/KANADA (AKV)')
    m.line(1345, 'Ihre Wertpapier-Order wurde über das Online Banking erteilt.')
    m.line(1409, 'Informationen zur steuerlichen Behandlung dieses Geschäftsvorgangs und den auf')
    m.line(1430, 'Ihrem Konto gebuchten Endbetrag finden Sie auf der separaten Steuermitteilung.')
    m.line(1494, 'Bei Fragen geben Sie bitte die Ordernummer an.')
    d.tp(155, 1536, 'Ihre comdirect', 11, 'Helvetica-Bold')
    d.tp(155, 1578, 'Diese Abrechnung wird von der Bank nicht unterschrieben', 11)
    m.line(1600, 'Die Leistung ist gemäß §4 Nr.8 UStG umsatzsteuerfrei. USt-Id-Nr.: DE 114 103 514')
    d.rect(28, 1858, 42, 1995, fill=(0, 0, 0))
    d.c.saveState()
    d.c.translate(55 * PX, H - 1960 * PX)
    d.c.rotate(90)
    d.c.setFont('Helvetica', 7)
    d.c.drawString(0, 0, 'A113')
    d.c.restoreState()
    d.page()
    # Seite 2: Steuerliche Behandlung
    cd_tax_page(d, '72 410938', '19.08.2026', qty, f'{name1} {name2}', wkn, isin_, total, 0, 0, 0, 0, '21.08.2026')
    d.page()
    # Seite 3: Bisher einbehaltene Steuer / Verrechnungssalden
    d.img(logo('comdirect'), 1005, 115, 315)

    def table(ytitle, title, heads, rows):
        d.tp(101, ytitle, title, 8.5)
        d.tp(510, ytitle - 5, '(4)', 7.5)
        top = ytitle + 22
        xs = [101, 235, 505, 774, 1018, 1286]
        d.rect(101, top, 1286, top + 108, stroke=True, width=1.2)
        d.hline(101, 1286, top + 53, 1.2)
        for x in xs[1:-1]:
            d.vline(x, top, top + 108, 1.2)
        d.tp(105, top + 30, 'in', 8.5, 'Helvetica-Bold')
        d.tp(134, top + 32, '2026', 11.5, 'Helvetica-Bold')
        for i, (h1, h2) in enumerate(heads):
            cx = (xs[i + 1] + xs[i + 2]) / 2
            d.tp(cx, top + 22, h1, 8, 'Helvetica-Bold', align='c')
            d.tp(cx, top + 39, h2, 8, 'Helvetica-Bold', align='c')
        d.tp(105, top + 74, 'vor Ermittlung', 8.5, 'Helvetica-Bold')
        d.tp(105, top + 94, 'nach Ermittlung', 8.5, 'Helvetica-Bold')
        for i, (v1, v2) in enumerate(rows):
            cx = (xs[i + 1] + xs[i + 2]) / 2
            d.tp(cx, top + 76, v1, 8.5, align='c')
            d.tp(cx, top + 94, v2, 8.5, align='c')

    table(220, 'Bisher einbehaltene bzw. angerechnete Steuer in EUR',
          [('einbehaltene', 'Kapitalertragsteuer'), ('einbehaltener', 'Solidaritätszuschlag'),
           ('einbehaltene', 'Kirchensteuer'), ('angerechnete', 'ausländische Quellensteuer')],
          [('24,76', '24,76'), ('1,30', '1,30'), ('0,00', '0,00'), ('0,88', '0,88')])
    table(443, 'Verrechnungssalden in EUR',
          [('Gewinne / Verluste', 'aus Aktienverkäufen'), ('sonstige', 'Gewinne / Verluste'),
           ('anrechenbare', 'ausländische Quellensteuer'), ('verfügbarer', 'Freistellungsauftrag')],
          [('1.169,43', '1.169,43'), ('203,02', '203,02'), ('0,00', '0,00'), ('0,00', '0,00')])
    d.tp(101, 1682, 'Ihre comdirect', 13, 'Helvetica-Bold')
    d.tp(101, 1710, 'Diese Abrechnung ist maschinell erstellt und wird nicht unterschrieben.', 11)
    d.tp(101, 1881, '(4) Die ausgewiesenen EUR-Beträge spiegeln den Stand zum Abrechnungszeitpunkt wider.', 7.5)
    d.tp(675, 1968, 'KEINE STEUERBESCHEINIGUNG', 12, align='c')
    d.save({
        'source': 'd7', 'type': 'wertpapier', 'subtype': 'kauf', 'institution': 'comdirect',
        'amount': -total, 'date': '2026-08-19', 'valuta': '2026-08-21',
        'title': f'Wertpapierkauf {name1} 1.077,30 €',
        'fields': {'security': name1, 'wkn': wkn, 'isin': isin_, 'quantity': qty, 'price': price,
                   'venue': 'TRADEGATE', 'orderNo': '000641927735-001', 'marketValue': kurswert, 'fees': fee_sum,
                   'taxPaid': None, 'currency': 'EUR', 'valuta': '2026-08-21'},
        'receiptFor': {'bookingText': 'Wertpapiere', 'amount': -total, 'bookingDate': '2026-08-21'},
        'notTaxCert': True,
    })


# ------------------------------------------------------------------ 2. comdirect Dividendengutschrift (d2)

def make_dividende():
    d = Doc('comdirect_dividende', 'Dividendengutschrift', 'comdirect')
    S = 595.27 / 1454.0 / PX  # diese Vorlage ist 1454 px breit

    def p(v):
        return v * S

    d.img(logo('comdirect'), p(848), p(30), p(310))
    d.tp(p(912), p(122), '25449 Quickborn', 8.5)
    m = Mono(d, p(135), 8.7, p(12.75))
    def ml(y, s, bold=False):
        m.line(p(y), s, bold)

    d.tp(p(848), p(344), 'Depotnr.:', 8.7, COUR)
    d.tp(p(1076), p(344), CD_DEPOT, 8.7, COUR)
    d.tp(p(848), p(365), 'BLZ:', 8.7, COUR)
    d.tp(p(1076), p(365), '200 411 33', 8.7, COUR)
    d.tp(p(478), p(375), '48213     010', 8.7, COUR)
    for ln, y in zip(KUNDE, (402, 427, 481, 531)):
        d.tp(p(153), p(y), ln, 9.5)
    d.tp(p(848), p(570), '10.09.2026', 11)
    d.tp(p(135), p(677), 'Gutschrift fälliger Wertpapier-Erträge', 12, 'Helvetica-Bold')
    qty, per, gross_usd, wht_usd, fx = 5, Decimal('0.91'), 455, 68, Decimal('1.165900')
    net_usd = gross_usd - wht_usd
    eur = cents(Decimal(net_usd) / 100 / fx)
    y0 = 720
    rows = [
        (0, 'Dividendengutschrift', False),
        (1, None, None),
        (2, cols((0, 'Depotbestand', 'l'), (38, 'Wertpapier-Bezeichnung', 'l'), (84, 'WKN/ISIN', 'r')), False),
        (3, [cols((0, 'per 19.08.2026', 'l')), (38, 'Microsoft Corp.'), (84, '870747')], 'mixed'),
        (4, [cols((0, 'STK', 'l'), (23, '5,000', 'r')), (38, 'Registered Shares DL-,00000625'), (84, 'US5949181045')],
         'mixed'),
        (5, cols((38, 'Emissionsland: VEREINIGTE STAATEN', 'l')), False),
        (6, cols((0, 'USD ' + dnum(per, 2), 'l'), (15, 'Dividende pro Stück für Geschäftsjahr', 'l'),
                 (60, '01.07.25 bis 30.06.26', 'l')), False),
        (7, cols((0, 'zahlbar ab 10.09.2026', 'l'), (38, 'Quartalsdividende', 'l')), False),
        (8, None, None),
        (9, cols((25, 'Abrechnung Dividendengutschrift', 'l')), True),
        (10, None, None),
        (11, cols((0, 'Bruttobetrag:', 'l'), (34, 'USD', 'l'), (56, de(gross_usd), 'r')), False),
        (12, cols((0, '15,000 % Quellensteuer', 'l'), (34, 'USD', 'l'), (56, de(wht_usd), 'r'), (58, '-', 'l')), False),
        (13, cols((0, 'Ausmachender Betrag', 'l'), (34, 'USD', 'l'), (56, de(net_usd), 'r')), False),
        (14, cols((4, 'zum Devisenkurs: EUR/USD', 'l'), (34, dnum(fx, 6), 'l'), (59, 'EUR', 'l'), (81, de(eur), 'r')),
         False),
        (15, cols((0, 'Verrechnung über Konto (IBAN)', 'l'), (40, 'Valuta', 'l'), (81, 'Zu Ihren Gunsten vor Steuern', 'r')),
         False),
        (16, cols((0, CD_GIRO_IBAN, 'l'), (30, 'EUR', 'l'), (40, '14.09.2026', 'l'), (59, 'EUR', 'l'), (81, de(eur), 'r')),
         True),
        (17, None, None),
        (18, 'Information zur steuerlichen Behandlung dieses Geschäftsvorganges und den auf', False),
        (19, 'Ihrem Konto gebuchten Endbetrag finden Sie auf der separaten Steuermitteilung', False),
        (20, '(Referenz-Nr. 1SKG9M4P7RQ00L2W).', False),
        (21, None, None),
        (22, 'Ihre comdirect', False),
    ]
    for k, s, bold in rows:
        if s is None:
            continue
        y = y0 + k * 21.4 + (2 if k >= 9 else 0)
        if bold == 'mixed':
            left, (c2, mid), (c3, right) = s
            ml(y, left)
            m.line(p(y), mid, True, col=c2)
            m.line(p(y), right, False, col=c3 - len(right) + 1)
        else:
            ml(y, s, bold)
    d.tp(p(135), p(1276), '*Diese Abrechnung wird von der Bank nicht unterschrieben', 11)
    d.rect(p(34), p(1875), p(50), p(1960), fill=(0, 0, 0))
    d.save({
        'source': 'd2', 'type': 'wertpapier', 'subtype': 'dividende', 'institution': 'comdirect',
        'amount': eur, 'date': '2026-09-10', 'valuta': '2026-09-14', 'title': 'Dividende Microsoft Corp. 3,32 €',
        'fields': {'security': 'Microsoft Corp.', 'wkn': '870747', 'isin': 'US5949181045', 'quantity': qty,
                   'currency': 'USD', 'grossForeign': gross_usd, 'withholdingTax': wht_usd, 'fxRate': float(fx),
                   'perShare': float(per), 'capitalIncome': True, 'valuta': '2026-09-14'},
        'taxRelevant': True,
    })


# ------------------------------------------------------------------ 3. comdirect Kosteninformation (d4 / d3)

def make_kosteninfo(name, variant):
    d = Doc(name, 'Kosteninformation', 'comdirect')
    if variant == 'gettex':
        L, R = 195, 1218
        datum, uhr = '20.11.2025', '08:26'
        sec, wkn, qty, price, venue = 'Intel Corp. Registered Shares DL -,001', '855681', 30, Decimal('39.885'), 'gettex'
        buy = [('Börsenplatzabhängiges Entgelt [E]', 150, 'E'), ('Orderprovision [E]', 390, 'E'),
               ('Zahlung von Dritten an die Bank [E]', 10, 'E')]
        third = 20
    else:
        L, R = 155, 1160
        datum, uhr = '15.10.2026', '11:10'
        sec, wkn, qty, price, venue = 'Linde plc Registered Shares EO -,001 DATA 10', 'A3D7VW', 3, Decimal('403.00'), 'Xetra'
        buy = [('Börsenspesen [F]', 52, 'F'), ('Börsenplatzabhängiges Entgelt [E]', 200, 'E'),
               ('Abwicklungsentgelt "Clearstream" / "Streifband" [E]', 290, 'E'), ('Orderprovision [E]', 990, 'E')]
        third = 0
    kurswert = cents(price * qty)
    buy_sum = sum(v for _, v, _ in buy)
    order_costs = sum(v for lab, v, _ in buy if 'Dritten' not in lab)
    total5 = 2 * buy_sum  # Kauf + Verkauf, Haltedauer kostenlos
    fremd = 2 * sum(v for _, v, kind in buy if kind == 'F')
    bank = total5 - fremd
    years = 5

    def pct(c, base, n=1):
        return dnum((Decimal(c) / Decimal(base) * 100 / n).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), 2)

    rendite = pct(total5, kurswert, years)
    if variant == 'gettex':
        d.tp(L, 182, 'www.comdirect.de', 9, 'Helvetica-Bold')
        cd_letterhead(d, L, telefax=False, sender='comdirect, 25449 Quickborn')
    else:
        cd_letterhead(d, L, telefax=True)
    ytitle = 789 if variant == 'gettex' else 743
    d.tp(L, ytitle + 4, 'Kosteninformation zum Wertpapiergeschäft', 11, 'Helvetica-Bold')
    d.tp(1003, ytitle + 4, f'{datum} - {uhr} Uhr', 11)
    para = ['Nach der EU-Richtlinie „Markets in Financial Instruments Directive“ (MiFID II) sind wir',
            'verpflichtet, Ihnen die nachfolgende Kosteninformation zur Verfügung zu stellen. Sie erhalten',
            'damit einen Überblick aller Kosten und Nebenkosten, die mit dem geplanten',
            'Wertpapiergeschäft im Zusammenhang stehen. Dabei handelt es sich um eine',
            'Kostensimulation. Die tatsächlichen Kosten sind abhängig von der Ausführung Ihres',
            'Wertpapierauftrages. Hierfür erhalten Sie eine gesonderte Wertpapierabrechnung.']
    y = ytitle + 69
    for ln in para:
        d.tp(L, y, ln, 11)
        y += 29.5
    y += 50
    d.tp(L, y, sec, 11, 'Helvetica-Bold')
    for ln in [f'WKN: {wkn}', f'Kauf: {qty} Stück zu {dnum(price, 3 if price != price.quantize(Decimal("0.01")) else 2)} EUR',
               f'Kurswert: {de(kurswert)} EUR', f'Ausführungsplatz: {venue}', 'Abrechnung in EUR']:
        y += 29
        d.tp(L, y, ln, 11)
    y += 95
    d.tp(L + 7, y, 'Von den unten aufgelisteten Kosten werden Ihnen über die', 10.5, 'Helvetica-Bold')
    d.tp(R, y, de(order_costs), 10.5, 'Helvetica-Bold', align='r')
    d.tp(R + 15, y, 'EUR', 10.5, 'Helvetica-Bold')
    d.tp(L + 7, y + 29, 'Wertpapierabrechnung voraussichtlich folgende Orderkosten abgerechnet', 10.5, 'Helvetica-Bold')

    def band(yb, label, val, right):
        d.rect(L, yb - 24, right, yb + 14, fill=(0.84, 0.84, 0.84))
        d.tp(L + 7, yb, label, 10, 'Helvetica-Bold')
        if val is not None:
            d.tp(R, yb, val, 10, 'Helvetica-Bold', align='r')
            d.tp(R + 15, yb, 'EUR', 10, 'Helvetica-Bold')

    def row(yr, label, val, unit='EUR', sep=True, right=1300):
        if label:
            d.tp(L + 7, yr, label, 9)
        if val is not None:
            d.tp(R, yr, val, 9, align='r')
            d.tp(R + 15, yr, unit, 9)
        if sep:
            d.hline(L, right, yr + 12, 0.4, gray=0.75)

    right = 1300 if variant == 'gettex' else 1260
    y += 97
    band(y, 'Kosten des Wertpapierkaufes', de(buy_sum), right)
    for lab, v, _ in buy:
        y += 35
        row(y, lab, de(v), right=right)
    y += 107
    band(y, 'Kosten während der Haltedauer (pro Jahr)', '0,00', right)
    y += 36
    row(y, 'Depotentgelt [E]', '0,00', sep=False)
    d.tp(L, 1856, '[E] Eigene Entgelte der Bank, [F] Fremde Entgelte, [P] Produktkosten', 8)
    cd_footer(d)
    d.page()
    # Seite 2
    d.tp(L, 153, 'Kosteninformation zum Wertpapiergeschäft', 11, 'Helvetica-Bold')
    d.tp(L, 182, f'{datum} – Seite 2', 11)
    d.img(logo('comdirect'), 990, 125, 315)
    y = 291
    band(y, 'Kosten des Wertpapierverkaufes', de(buy_sum), right)
    for lab, v, _ in buy:
        y += 34
        row(y, lab, de(v), right=right)
    y += 92
    para2 = ['Die Gesamtkosten eines Wertpapiergeschäftes setzen sich aus den jeweiligen Kosten des',
             'Wertpapierkaufes, während der Haltedauer und des Wertpapierverkaufes zusammen. Bei einer',
             f'angenommenen Haltedauer von {years} Jahr(en) belaufen sich die voraussichtlichen Gesamtkosten',
             f'auf {de(total5)} EUR und reduzieren die Rendite um durchschnittlich {rendite} % pro Jahr. Die',
             'Zusammensetzung dieser Kosten ist im Folgenden näher erläutert. Die tatsächlichen',
             'Gesamtkosten können, z.B. bei kürzerer Haltedauer, davon abweichen.']
    for ln in para2:
        d.fit(L, y, ln, 11, maxpx=1105)
        y += 29
    y += 34
    band(y, 'Gesamtkosten im Detail (einschließlich durchschnittlicher Kosten pro Jahr)', None, right)
    rows2 = [('- Dienstleistungskosten der Bank', de(bank), 'EUR'), (None, pct(bank, kurswert, years), '% p.a.')]
    y += 36
    for lab, v, u in rows2:
        row(y, lab, v, u, sep=False)
        y += 33
    d.tp(L + 7, y, f'Davon erhält die Bank von Dritten {de(third)} EUR', 9)
    d.hline(L, right, y + 12, 0.4, gray=0.75)
    for lab, c in [('- Dienstleistungskosten fremd', fremd), ('- Produktkosten (nach Zahlung von Dritten)', 0)]:
        y += 34
        row(y, lab, de(c), 'EUR', sep=False)
        y += 33
        row(y, None, pct(c, kurswert, years), '% p.a.')
    y += 68
    band(y, 'Gesamtkosten im Zeitablauf und Auswirkung auf die Rendite', None, right)
    p1 = '-' + pct(buy_sum, kurswert)
    for lab, c, pc in [('- Im 1. Jahr (Kosten Wertpapierkauf und 1. Jahr Haltedauer)', buy_sum, p1),
                       ('- Ab dem 2. Jahr während der Haltedauer (pro Jahr)', 0, '0,00'),
                       ('- Im Jahr des Wertpapierverkaufes (zusätzlich zu den Kosten für Haltedauer)', buy_sum, p1)]:
        y += 35
        row(y, lab, de(c), 'EUR', sep=False)
        y += 31
        row(y, None, pc, '%', sep=c != buy_sum or 'Verkauf' not in lab)
    foot = [(1704, 'Eigene Entgelte [E]: Eigene Entgelte, die gemäß unserem Preis- und Leistungsverzeichnis bei der Orderausführung anfallen.'),
            (1748, 'Fremde Entgelte [F]: Fremde Spesen, die nach der Ausführung Ihres Auftrages auf der Wertpapierabrechnung aufgeführt und Ihrem'),
            (1772, 'Konto belastet werden.'),
            (1816, 'Produktkosten [P]: Indirekte Kosten, die bereits im Produktpreis enthalten sind und Ihrem Konto nicht zusätzlich belastet werden. Diese'),
            (1840, 'Kosten werden uns von dem jeweiligen Emittenten mitgeteilt und von diesem vereinnahmt.')]
    for yy, ln in foot:
        d.fit(L, yy, ln, 8, maxpx=1300 - L)
    cd_footer(d)
    d.save({
        'source': 'd4' if variant == 'gettex' else 'd3', 'type': 'wertpapier', 'subtype': 'kosteninfo',
        'institution': 'comdirect', 'amount': None, 'date': iso(datum), 'infoOnly': True, 'neverReceipt': True,
        'fields': {'security': sec, 'wkn': wkn, 'quantity': qty, 'price': cents(price), 'venue': venue,
                   'side': 'kauf', 'marketValue': kurswert, 'orderCosts': order_costs, 'buyCosts': buy_sum,
                   'sellCosts': buy_sum, 'holdingCostsPerYear': 0, 'totalCosts': total5,
                   'holdingYears': years, 'yieldReductionPct': float(rendite.replace(',', '.')),
                   'costItems': [{'label': lab, 'amount': v, 'kind': k} for lab, v, k in buy], 'infoOnly': True},
        'taxRelevant': False,
    })


# ------------------------------------------------------------------ 4. comdirect Finanzreport (d1)

HOLDINGS_FR = [
    # (WKN, Land, Verwahrart, Name, Anzahl, Kurs, Währung, Kaufwert-Cent)
    ('A2QL8M', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'ALPENROSE THERAPEUTICS INC.', 140, '1.107', 'EUR', 15088),
    ('A3C9RX', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'NORTHGATE MINING HLDGS', 12, '175.063', 'EUR', 209501),
    ('A2JF4K', 'GB', 'Girosammelverwahrung', None, 'VESTRA GR.HLDG NA 1/8', 50, '21.20', 'EUR', 109935),
    ('A0YJ7H', 'US', 'Girosammelverwahrung', None, 'LUMEN BRANDS CO.DL -,01', 3, '14.21', 'EUR', 4063),
    ('A1W2K5', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'HARBOR LANE INC. CL.B', 800, '3.795', 'EUR', 188938),
    ('A3E1PQ', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'HARBOR LANE INC. NEW CL.B', 22, '4.493', 'EUR', 0),
    ('A2PZ3D', 'US', 'Wertpapierrechnung', 'USA über AKV', 'SOLWAY CLEAN POWER ETF', 25, '62.6352', 'EUR', 152360),
    ('A0MKH2', 'US', 'Sonstige', 'Kanada/USA direkt', 'OAKMONT ENERGY CORP.', 400, '0.000', 'USD', 4200),
    ('A3DTU8', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'BRIGHTPATH MEDIA INC. A', 10, '4.96', 'EUR', 0),
    ('A1JXK2', 'US', 'Girosammelverwahrung', None, 'SILVERLINE FDG INC. O.N.', 30, '23.25', 'EUR', 46420),
    ('A2DK6R', 'US', 'Wertpapierrechnung', 'Kanada/USA über AKV', 'MERIDIAN HOLDINGS', 20, '0.555', 'EUR', 2000),
    ('A2N6WQ', 'IE', 'Wertpapierrechnung', 'Irland über AKV', 'GREENFIELD WORLD EQUITY UCITS ETF 1C', 3, '61.48', 'EUR', 19200),
    ('A1J5RX', 'DE', 'Girosammelverwahrung', None, 'BERGWERK DIGITAL AG NA O.N.', 15, '6.32', 'EUR', 9750),
    ('A0LD6E', 'DE', 'Girosammelverwahrung', None, 'HANSE AUTOMOBIL AG VZO O.N.', 20, '76.05', 'EUR', 157740),
    ('A0RJAT', 'US', 'Girosammelverwahrung', None, 'PACIFIC RAIL SYSTEMS DL 1', 6, '268.583', 'EUR', 157784),
    ('A2AFR3', 'US', 'Girosammelverwahrung', None, 'ORION PAYMENTS DL -,01', 8, '76.875', 'EUR', 60248),
    ('A1C7LP', 'US', 'Girosammelverwahrung', None, 'CEDAR RIDGE INC. DL-,10', 19, '13.64', 'EUR', 25841),
]


def fr_holdings():
    out = []
    for wkn, cc, verw, verw2, name, qty, kurs, cur, kauf in HOLDINGS_FR:
        k = Decimal(kurs)
        kw = 0 if cur == 'USD' else cents(k * qty)
        gv = 0 if kauf == 0 else kw - kauf  # ohne Kaufwert (z. B. Einbuchung aus Kapitalmaßnahme) zeigt comdirect +0,00
        prefix = cc + '000' + wkn if cc == 'DE' else cc + wkn + '000'
        out.append({'wkn': wkn, 'isin': isin(prefix), 'verwahrart': verw, 'name': name, 'qty': qty,
                    'priceText': dnum(k, len(kurs.split('.')[1])), 'currency': cur, 'value': kw, 'cost': kauf,
                    'gain': gv, 'line2': verw2})
    return out


def make_finanzreport():
    d = Doc('comdirect_finanzreport', 'Finanzreport', 'comdirect')
    hold = fr_holdings()
    depot = sum(h['value'] for h in hold)
    # Girokonto (5 Buchungen wie im Original)
    giro_open, giro_close = 383322, 282372
    kupon, wp, gericht, visa_lst, entgelt = 873, -95363, -2800, -3470, -190
    assert giro_open + kupon + wp + gericht + visa_lst + entgelt == giro_close
    visa_tx = [('12.11.2024', '11.11.2024', 'Visa-Umsatz', -470), ('18.11.2024', '16.11.2024', 'Visa-Umsatz', -3000),
               ('29.11.2024', '29.11.2024', 'Visa-Kartenabrechnung', 3470)]
    gesamt = giro_close + 0 + depot + 0
    wp_isin = isin('DE000A3E5TQ')
    # ---- Seite 1: Anschreiben
    d.tp(195, 182, 'www.comdirect.de', 9, 'Helvetica-Bold')
    cd_letterhead(d, 195)
    d.tp(195, 793, 'Finanzreport Nr. 11 per 02.12.2024', 11, 'Helvetica-Bold')
    d.tp(1003, 792, '03.12.2024', 11)
    d.tp(195, 893, 'Sehr geehrter Herr Beispiel,', 11)
    d.tp(195, 939, 'in Ihrem aktuellen Finanzreport finden Sie alle Informationen rund um Ihre Kundenverbindung.', 11)
    d.fit(195, 981, 'Haben Sie noch Fragen? Alle Informationen zu unseren Produkten und Services finden Sie unter', 11, maxpx=1105)
    d.tp(195, 1010, 'www.comdirect.de', 11, 'Helvetica-Bold')
    d.tp(195, 1067, 'Mit freundlichen Grüßen', 11)
    d.tp(195, 1125, 'Ihre comdirect', 11)
    d.tp(195, 1221, 'Aktuelle Informationen:', 11)
    d.hline(195, 1300, 1245, 0.8)
    B, N = 'Helvetica-Bold', 'Helvetica'
    info = [
        (1295, [(N, 'comdirect wird 30 – das feiern wir: Sichern Sie sich bis zu 5 x 30 Euro Prämie mit dem Girokonto')]),
        (1324, [(N, 'oder 30 Monate Sonderkonditionen³ beim Depot! Jetzt mehr erfahren unter')]),
        (1353, [(B, 'www.comdirect.de/aktionen')]),
        (1396, [(N, 'Mit dem '), (B, 'JuniorDepot'), (N, ' feiern wie die Großen! Zum comdirect Geburtstag mit '),
                (B, 'toller Prämie für')]),
        (1425, [(B, 'Kids'), (N, ': jetzt eröffnen und mit Wertpapieren für den Nachwuchs vorsorgen. Mehr erfahren unter')]),
        (1454, [(B, 'www.comdirect.de/junior-depot')]),
        (1497, [(B, 'Bis zu 1.250 Euro Prämie mit cominvest'), (N, ': Partytime für Ihre Geldanlage – bis 15.01.2025 mit')]),
        (1526, [(N, 'cominvest in Wertpapiere investieren und bis zu 1.250 Euro comdirect Geburtstagsprämie')]),
        (1555, [(N, 'kassieren. Mehr Informationen unter '), (B, 'www.comdirect.de/cominvest')]),
    ]
    for y, parts in info:
        d.segs(195, y, parts, 10.6)
    cd_footer(d)

    def head(n):
        d.tp(135, 153, f'Finanzreport Nr. 11 per 02.12.2024 - Seite {n}', 11)
        d.tp(135, 182, f'Kundennummer {CD_KUNDENNR}', 11)
        d.img(logo('comdirect'), 990, 125, 315)

    def band(y1, y2, title, size=11.5):
        d.rect(135, y1, 1320, y2, fill=(0.84, 0.84, 0.84))
        d.tp(142, (y1 + y2) / 2 + 8, title, size, 'Helvetica-Bold')

    def dots(y):
        d.hline(135, 1320, y, 0.5, dash=(1, 2))

    def colhead(y, visa=False):
        d.hline(135, 1320, y - 21, 1)
        if visa:
            d.tp(142, y, 'Buchungstag', 8.5, B)
            d.tp(279, y, 'Vorgang', 8.5, B)
            d.tp(515, y, 'Buchungstext', 8.5, B)
            d.tp(1313, y, 'Ausgang', 8.5, B, align='r')
            d.tp(142, y + 23, 'Valuta', 8.5, B)
            d.tp(279, y + 23, 'Referenz', 8.5, B)
            d.tp(1313, y + 23, 'Eingang', 8.5, B, align='r')
        else:
            d.tp(142, y, 'Buchungstag', 8.5, B)
            d.tp(279, y, 'Vorgang', 8.5, B)
            d.tp(448, y, 'Auftraggeber/Empfänger', 8.5, B)
            d.tp(734, y, 'Buchungstext', 8.5, B)
            d.tp(1313, y, 'Ausgang', 8.5, B, align='r')
            d.tp(142, y + 21, 'Valuta', 8.5, B)
            d.tp(279, y + 21, 'Referenz', 8.5, B)
            d.tp(448, y + 21, 'IBAN/BIC', 8.5, B)
            d.tp(1313, y + 21, 'Eingang', 8.5, B, align='r')
        d.hline(135, 1320, y + 38, 1)

    def booking(y, rows, amount):
        """rows: Liste je Zeile (Datum, Vorgang/Referenz, Auftraggeber, Buchungstext); Betrag in der ersten Zeile."""
        for i, (c1, c2, c3, c4) in enumerate(rows):
            yy = y + i * 23
            for x, s in ((142, c1), (279, c2), (448, c3), (734, c4)):
                if s:
                    d.tp(x, yy, s, 9)
            if i == 0:
                d.tp(1313, yy, de(amount, sign=True), 9, align='r')
        return y + len(rows) * 23

    # ---- Seite 2
    d.page()
    head(2)
    band(292, 333, 'Kontoübersicht')
    d.hline(135, 1320, 344, 1)
    d.tp(142, 366, 'Ihre aktuellen Salden', 8.5, B)
    d.tp(623, 366, 'IBAN', 8.5, B)
    d.tp(1313, 366, 'Saldo in', 8.5, B, align='r')
    d.tp(1313, 389, 'EUR', 8.5, B, align='r')
    d.hline(135, 1320, 402, 1)
    over = [('Girokonto', CD_GIRO_IBAN, giro_close), ('Tagesgeld PLUS-Konto', CD_TG_IBAN, 0),
            ('Depot', '', depot), ('Visa-Karte 4871', '', 0)]
    for i, (lab, ib, v) in enumerate(over):
        y = 433 + i * 36.5
        d.tp(142, y, lab, 9.5)
        if ib:
            d.tp(623, y, ib, 9.5)
        d.tp(1313, y, de(v, sign=True), 9.5, align='r')
        if i < 3:
            dots(y + 15)
    d.hline(135, 1320, 564, 1)
    d.segs(142, 586, [(B, 'Gesamtsaldo'), (N, ' 02.12.2024')], 9.5)
    d.tp(1313, 586, de(gesamt, sign=True), 9.5, B, align='r')
    d.hline(135, 1320, 600, 1)
    band(660, 701, 'Girokonto')
    d.tp(1313, 685, 'Dispositionskredit 0 EUR', 8.5, B, align='r')
    colhead(733)
    d.tp(142, 802, 'Alter Saldo', 9, B)
    d.tp(279, 802, '01.11.2024', 9)
    d.tp(1313, 802, de(giro_open, sign=True), 9, align='r')
    dots(817)
    y = booking(837, [('04.11.2024', 'Kupon', '', 'ERTRAEGNISGUTSCHRIFT VOM 01.11.24'),
                      ('05.11.2024', '4N2C7K1T0QX0', '', 'DEPOTBESTAND:            19,000'),
                      ('', '0174536', '', 'CEDAR RIDGE INC. DL-,10'),
                      ('', '', '', 'A1C7LP           USD 0,6775'),
                      ('', '', '', 'Abr.Betrag Brutto 11,04 EUR'),
                      ('', '', '', 'Steuerabzug 2,31- EUR')], kupon)
    dots(y - 11)
    y = booking(y + 10, [('12.11.2024', 'Wertpapiere', '', 'LINDENHOF PHARMA AG ORDER 6419277'),
                         ('14.11.2024', '5RT8W2M4K9HZ', '', f'WPKNR: A3E5TQ   ISIN: {wp_isin}'),
                         ('', '0188214', '', '')], wp)
    dots(y - 11)
    y = booking(y + 10, [('18.11.2024', 'Übertrag /', 'Gerichtskasse Hamburg', 'Kassenzeichen 220241118735'),
                         ('18.11.2024', 'Überweisung', 'DE81200505501234567890', 'End-to-End-Ref.:'),
                         ('', '7HD3L0PA2X5M', 'HASPDEHHXXX', 'nicht angegeben'),
                         ('', '0192077', '', '')], gericht)
    dots(y - 11)
    y = booking(y + 10, [('02.12.2024', 'Lastschrift /', 'comdirect', 'VISA-KARTE NR. 4871 XXXX XXXX 4871'),
                         ('02.12.2024', 'Belastung', 'Visa-Monatsabrechnung', 'SUMME MONATSABRECHNUNG VISA'),
                         ('', '9KQ2D7TR4M1L', '', 'JAN BEISPIEL'),
                         ('', '0201148', '', '')], visa_lst)
    dots(y - 11)
    y = booking(y + 10, [('02.12.2024', 'Kontoführungse', '', 'Entgelt'),
                         ('29.11.2024', 'ntgelt', '', 'Visa-Kreditkarte'),
                         ('', '3VB6N8C1X0Z4', '', 'Zeitraum: 01.11.2024'),
                         ('', '0201153', '', 'bis 30.11.2024')], entgelt)
    d.hline(135, 1320, y - 11, 1)
    d.tp(142, y + 13, 'Neuer Saldo', 9, B)
    d.tp(276, y + 13, '02.12.2024', 9)
    d.tp(1313, y + 13, de(giro_close, sign=True), 9, B, align='r')
    d.hline(135, 1320, y + 30, 1)
    band(1459, 1500, 'Tagesgeld PLUS-Konto')
    colhead(1531)
    d.tp(142, 1601, 'Alter Saldo', 9, B)
    d.tp(276, 1601, '01.11.2024', 9)
    d.tp(1313, 1601, '+0,00', 9, align='r')
    d.tp(142, 1636, 'Neuer Saldo', 9, B)
    d.tp(276, 1636, '02.12.2024', 9)
    d.tp(1313, 1636, '+0,00', 9, B, align='r')
    d.hline(135, 1320, 1649, 1)
    cd_footer(d)
    # ---- Seite 3: Visa, Depot
    d.page()
    head(3)
    d.rect(135, 292, 1320, 350, fill=(0.84, 0.84, 0.84))
    d.tp(142, 326, 'Visa-Karte 4871', 12, B)
    d.tp(944, 314, 'Visa Limit', 8.5, B, align='r')
    d.tp(944, 337, '1.500 EUR/Monat', 8.5, B, align='r')
    d.tp(1313, 314, 'Verfügungslimit am Geldautomat', 8.5, B, align='r')
    d.tp(1313, 337, '600 EUR/Tag', 8.5, B, align='r')
    colhead(383, visa=True)
    d.tp(142, 451, 'Alter Saldo', 9, B)
    d.tp(276, 451, '01.11.2024', 9)
    d.tp(1313, 451, '+0,00', 9, align='r')
    dots(466)
    vis = [
        [('12.11.2024', 'Visa-Umsatz', 'HEROKU  1BC77Q2', 'WWW.HEROKU.C400 Betrag: -5,00'),
         ('11.11.2024', '74420114316003391', 'USD Kurs: 1,0632', '')],
        [('18.11.2024', 'Visa-Umsatz', 'LGC UBER GIFTCARD', 'SCHIPHOL     003'),
         ('16.11.2024', '74420114320011834', '', '')],
        [('29.11.2024', 'Visa-Kartenabrechnung', 'SUMME MONATSABRECHNUNG VISA', ''),
         ('29.11.2024', '74420114333000018', '', '')],
    ]
    y = 486
    for rows, (_, _, _, amt) in zip(vis, visa_tx):
        for i, r in enumerate(rows):
            d.tp(142, y + i * 23, r[0], 9)
            d.tp(279, y + i * 23, r[1], 9 if len(r[1]) < 18 else 8.4)
            if r[2]:
                d.tp(515, y + i * 23, r[2], 9)
            if r[3]:
                d.tp(776 if 'HEROKU' in r[3] else 762, y + i * 23, r[3], 9)
        d.tp(1313, y, de(amt, sign=True), 9, align='r')
        y += 57.5
        if rows is not vis[-1]:
            dots(y - 22.5)
    d.hline(135, 1320, 645, 1)
    d.tp(142, 667, 'Neuer Saldo', 9, B)
    d.tp(276, 667, '02.12.2024', 9)
    d.tp(1313, 667, '+0,00', 9, B, align='r')
    d.hline(135, 1320, 681, 1)
    band(741, 782, 'Depot')

    def depot_head(y):
        d.hline(135, 1320, y - 18, 1)
        d.tp(142, y, 'Depotbestand', 8.5, B)
        for x in (989, 1137, 1313):
            d.tp(x, y, 'EUR', 8.5, B, align='r')
        d.hline(135, 1320, y + 16, 1)
        y2 = y + 38
        d.tp(142, y2, 'WKN / Verwahrart', 8.5, B)
        d.tp(633, y2, 'Anzahl / Nominal', 8.5, B, align='r')
        d.tp(754, y2, 'letzter', 8.5, B, align='r')
        d.tp(770, y2, 'Währung', 8.5, B)
        d.tp(989, y2, 'Kurswert', 8.5, B, align='r')
        d.tp(1137, y2, 'Kaufwert', 8.5, B, align='r')
        d.tp(1313, y2, 'Gewinn / Verlust', 8.5, B, align='r')
        d.tp(142, y2 + 23, 'Bezeichnung', 8.5, B)
        d.tp(754, y2 + 23, 'Kurs', 8.5, B, align='r')
        d.tp(989, y2 + 23, 'Stückzinsen', 8.5, B, align='r')
        d.hline(135, 1320, y2 + 40, 1)
        return y2 + 66

    def holding(y, h, last):
        d.tp(142, y, f'{h["wkn"]} / {h["verwahrart"]}', 9)
        d.tp(633, y, dnum(h['qty'], 3), 9, align='r')
        d.tp(754, y, h['priceText'], 9, align='r')
        d.tp(815, y, h['currency'], 9)
        d.tp(989, y, de(h['value']), 9, align='r')
        d.tp(1137, y, de(h['cost']), 9, align='r')
        d.tp(1313, y, de(h['gain'], sign=True), 9, align='r')
        d.tp(989, y + 23, '+0,00', 9, align='r')
        lines = [h['line2'], h['name']] if h['line2'] else [h['name']]
        for i, s in enumerate(lines):
            d.tp(142, y + 23 * (i + 1), s, 9)
        end = y + 23 * len(lines)
        if not last:
            dots(end + 12)
        return end + 34

    y = depot_head(815)
    for i, h in enumerate(hold[:11]):
        y = holding(y, h, i == 10)
    d.hline(135, 1320, y - 16, 1)
    cd_footer(d)
    # ---- Seite 4: Depot (Fortsetzung), Steuerübersicht
    d.page()
    head(4)
    y = depot_head(314)
    for i, h in enumerate(hold[11:]):
        y = holding(y, h, i == len(hold) - 12)
    d.hline(135, 1320, y - 16, 1)
    tot_cost = sum(h['cost'] for h in hold)
    tot_gain = sum(h['gain'] for h in hold)
    d.tp(142, y + 3, 'Gesamtkurswert', 9, B)
    d.tp(989, y + 3, de(depot), 9, align='r')
    d.tp(1137, y + 3, de(tot_cost), 9, align='r')
    d.tp(1313, y + 3, de(tot_gain, sign=True), 9, align='r')
    d.tp(142, y + 26, 'Stückzinsen gesamt', 9, B)
    d.tp(989, y + 26, '+0,00', 9, align='r')
    d.tp(142, y + 49, 'Gesamtwert', 9, B)
    d.tp(989, y + 49, de(depot), 9, align='r')
    d.tp(142, y + 82, 'Die Kaufwerte und damit die Gesamtbewertung in der Depotübersicht stellt lediglich eine vereinfachte', 9)
    d.tp(142, y + 105, 'Gewinn/Verlust-Rechnung dar. Steuerliche Gesichtspunkte werden bei dieser Darstellung nicht berücksichtigt.', 9)
    d.hline(135, 1320, y + 122, 1)
    ys = y + 182
    d.rect(135, ys, 1320, ys + 40, fill=(0.84, 0.84, 0.84))
    d.tp(142, ys + 28, 'Steuerübersicht', 11.5, B)
    d.tp(142 + stringWidth('Steuerübersicht', B, 11.5) / PX + 2, ys + 18, '1', 7)
    d.hline(135, 1320, ys + 52, 1)
    d.tp(142, ys + 74, 'Steuerliche Daten', 8.5, B)
    d.tp(1313, ys + 74, 'EUR', 8.5, B, align='r')
    d.hline(135, 1320, ys + 87, 1)
    tax = [('Gewinne/Verluste Aktien (Saldo)', -31226, 0), ('Verlustverrechnungstopf Aktien', -31226, 0),
           ('Gewinne/Verluste Sonstige (Saldo)', 1646, 14), ('Verlustverrechnungstopf Sonstige', 0, 0),
           ('Eingereichter Freibetrag', 0, 0), ('In Anspruch genommener Freibetrag', 0, 0),
           ('Verbleibender Freibetrag', 0, 0), ('Anrechenbare ausländische Quellensteuer', 0, 0),
           ('Abgeführte Kapitalertragsteuer', 1040, 14), ('Abgeführter Solidaritätszuschlag', 57, 0),
           ('Abgeführte Kirchensteuer', 83, 0), ('Angerechnete ausländische Quellensteuer', 175, 0)]
    yy = ys + 108
    for i, (lab, v, off) in enumerate(tax):
        d.tp(147, yy, lab, 9.5)
        d.tp(1313, yy + off, de(v), 9.5, align='r')
        gap = 34.5 + off + (13 if lab == 'Verlustverrechnungstopf Sonstige' else 0)
        if i < len(tax) - 1:
            dots(yy + off + 12)
        yy += gap
    d.tp(142, yy + 22, '1', 7)
    d.tp(157, yy + 30, 'Dieses ist keine Steuerbescheinigung.', 9.5)
    d.hline(135, 1320, yy + 47, 1)
    cd_footer(d)
    # ---- Seite 5: Zinsübersicht, Hinweise
    d.page()
    head(5)
    band(292, 333, 'Zinsübersicht')
    d.hline(135, 1320, 344, 1)
    d.tp(142, 371, 'Girokonto', 9.5, B)
    d.tp(142, 394, 'Zinssatz für die Inanspruchnahme des Dispositionskredites:', 9.5)
    d.tp(1313, 394, '9,90 % p. a. (gültig ab: 22.11.2024)', 9.5, align='r')
    d.tp(142, 417, 'Zinssatz für geduldete Überziehungen:', 9.5)
    d.tp(1313, 417, '11,40 % p. a. (gültig ab: 22.11.2024)', 9.5, align='r')
    dots(430)
    d.tp(142, 465, 'Verrechnungskonto/Tagesgeld PLUS-Konto/O&F-Konto', 9.5, B)
    d.tp(142, 488, 'Zinssatz für geduldete Überziehungen:', 9.5)
    d.tp(1313, 488, '11,40 % p. a. (gültig ab: 22.11.2024)', 9.5, align='r')
    dots(501)
    d.tp(142, 537, 'Zinsgleitklausel für variable Sollzinssätze:', 9, B)
    klausel = [
        'comdirect – eine Marke der Commerzbank AG (im Folgenden comdirect genannt) wird variable Sollzinssätze entsprechend den Änderungen des',
        'Hauptrefinanzierungszinssatzes der Europäischen Zentralbank (nachfolgend EZB-Zinssatz) nach folgender Maßgabe anpassen: Sofern am',
        'letzten Bankarbeitstag vor dem 15. eines Kalendermonats von comdirect eine Erhöhung des EZB-Zinssatzes um mindestens 0,25 Prozentpunkte',
        'gegenüber dem EZB-Zinssatz im Monat der letzten Zinsanpassung festgestellt wird, erhöht comdirect den variablen Sollzinssatz entsprechend.',
        'comdirect verpflichtet sich dagegen zur Senkung des variablen Sollzinssatzes um die Veränderung des EZB-Zinssatzes, wenn der EZB-Zinssatz',
        'um mindestens 0,25 Prozentpunkte gesunken ist. Die Zinsanpassungen werden 5 Bankarbeitstage nach dem 15. eines Kalendermonats ohne',
        'gesonderte Mitteilung wirksam. Den jeweils aktuellen EZB-Zinssatz können Sie im Preis- und Leistungsverzeichnis, im Internet sowie in',
        'anderen öffentlich zugänglichen Medien einsehen. Den aktuellen Sollzinssatz teilt comdirect Ihnen im Finanzreport mit; Sie können ihn auch in',
        'öffentlich zugänglichen Medien (insbesondere www.bundesbank.de) einsehen.',
    ]
    for i, ln in enumerate(klausel):
        d.fit(142, 557 + i * 20, ln, 7.6, maxpx=1170)
    d.hline(135, 1320, 729, 1)
    band(790, 830, 'Wichtige Hinweise')
    d.hline(135, 1320, 841, 1)
    d.tp(142, 875, '1. Ihre individuellen Vergünstigungen', 9, B)
    dots(889)
    d.tp(142, 911, 'Vergünstigungen', 9, B)
    d.tp(782, 911, 'Gültigkeit', 9, B)
    d.tp(142, 944, 'Kostenlose Depotführung (5,85 Euro pro Quartal gespart)', 9.5)
    d.tp(782, 944, '01.10.2024 bis 31.12.2024', 9.5)
    dots(958)
    hin = [
        (980, [(N, 'Details zu Ihren persönlichen Vergünstigungen können Sie unter '), (B, 'www.comdirect.de'),
               (N, ' im Persönlichen Bereich unter Verwaltung')]),
        (1003, [(N, '> Depot & Trading > Vergünstigungen einsehen. Es gilt das aktuelle Preis- und Leistungsverzeichnis.')]),
        (1036, [(B, '2. Einwendungen zu Konto- und Depotbuchungen')]),
        (1059, [(N, 'Sollten Sie Fragen oder Einwendungen zu den Konto- und Depotbuchungen haben, bitten wir Sie, uns dieses '),
                (B, 'innerhalb 6')]),
        (1083, [(B, 'Wochen nach Erhalt des Finanzreportes'), (N, ' unter Angabe Ihrer Kundennummer in Textform mitzuteilen.')]),
        (1117, [(B, '3. Ihre Kontodisposition')]),
        (1141, [(N, 'Der Kontostand berücksichtigt nicht die Valuta (Wertstellung) der einzelnen Buchungen. Das bedeutet, dass der angezeigte')]),
        (1164, [(N, 'Kontostand nicht dem tatsächlichen Kontoguthaben entsprechen muss und bei Verfügungen möglicherweise Zinsen für die')]),
        (1187, [(N, 'Inanspruchnahme einer eingeräumten oder geduldeten Kontoüberziehung anfallen können. Bitte berücksichtigen Sie bei Ihrer')]),
        (1210, [(N, 'Disposition daher ggf. die Wertstellungen der Kontoumsätze der letzten Tage.')]),
        (1244, [(B, '4. Hinweis zur Einlagensicherung')]),
        (1267, [(N, 'Guthaben sind als Einlagen nach Maßgabe des Einlagensicherungsgesetzes entschädigungsfähig. Nähere Informationen')]),
        (1290, [(N, 'können dem "Informationsbogen für den Einleger" entnommen werden. Diesen finden Sie unter www.comdirect.de/infobogen')]),
        (1324, [(B, '5. Information zu Ihren Wertpapieren')]),
        (1347, [(N, 'In Ihrem Depot verwahrte Wertpapiere und Kundengelder unterliegen der EU-Richtlinie 2014/65/EU (MIFID II-Richtlinie) und')]),
        (1370, [(N, 'ihren Durchführungsbestimmungen.')]),
        (1404, [(B, '6. Bestand mit mangelnder Liquidität')]),
        (1427, [(N, 'Wir haben Wertpapiere Ihres Depots mit 0,00 EUR bewertet, da wir keine höheren Marktkurse ermitteln konnten. Dies kann')]),
        (1450, [(N, 'auf mangelnde Liquidität des Finanzinstrumentes hindeuten.')]),
        (1484, [(B, '7. Hinweis zur standardisierten Zahlungskontenterminologie')]),
        (1508, [(N, 'Nachfolgende Begriffe entsprechen den Begriffen der standardisierten Zahlungskontenterminologie: girocard (Debitkarte),')]),
        (1531, [(N, 'Bankkarte (Visa-Debitkarte), Visa-Karte (Kreditkarte) und Dispositionskredit (eingeräumte Kontoüberziehung).')]),
    ]
    for y, parts in hin:
        width = sum(stringWidth(s, f, 9.3) for f, s in parts)
        size = 9.3 if width <= 1165 * PX else 9.3 * 1165 * PX / width
        d.segs(142, y, parts, size)
    d.tp(142, 1565, '8. Übersicht Ihrer Kontodaten', 9, B)
    d.tp(720, 1565, 'IBAN', 9, B)
    d.tp(1030, 1565, 'BIC', 9, B)
    dots(1580)
    d.tp(142, 1600, 'Girokonto', 9.5)
    d.tp(720, 1600, CD_GIRO_IBAN, 9.5)
    d.tp(1030, 1600, 'COBADEHD001', 9.5)
    dots(1614)
    d.tp(142, 1634, 'Tagesgeld PLUS-Konto', 9.5)
    d.tp(720, 1634, CD_TG_IBAN, 9.5)
    d.hline(135, 1320, 1647, 1)
    cd_footer(d)
    giro_tx = [
        {'bookingDate': '2024-11-04', 'valueDate': '2024-11-05', 'amount': kupon, 'bookingText': 'Kupon'},
        {'bookingDate': '2024-11-12', 'valueDate': '2024-11-14', 'amount': wp, 'bookingText': 'Wertpapiere'},
        {'bookingDate': '2024-11-18', 'valueDate': '2024-11-18', 'amount': gericht, 'bookingText': 'Übertrag / Überweisung',
         'counterparty': 'Gerichtskasse Hamburg'},
        {'bookingDate': '2024-12-02', 'valueDate': '2024-12-02', 'amount': visa_lst, 'bookingText': 'Lastschrift / Belastung',
         'counterparty': 'comdirect Visa-Monatsabrechnung'},
        {'bookingDate': '2024-12-02', 'valueDate': '2024-11-29', 'amount': entgelt, 'bookingText': 'Kontoführungsentgelt'},
    ]
    d.save({
        'source': 'd1', 'type': 'kontoauszug', 'format': 'pdf_statement', 'institution': 'comdirect',
        'date': '2024-12-02', 'period': {'from': '2024-11-01', 'to': '2024-12-02'},
        'accounts': [
            {'name': 'Girokonto', 'kind': 'giro', 'iban': CD_GIRO_RAW, 'opening': giro_open, 'closing': giro_close,
             'count': 5, 'transactions': giro_tx},
            {'name': 'Tagesgeld PLUS-Konto', 'kind': 'tagesgeld', 'iban': CD_TG_RAW, 'opening': 0, 'closing': 0, 'count': 0,
             'transactions': []},
            {'name': 'Visa-Karte 4871', 'kind': 'kreditkarte', 'opening': 0, 'closing': 0, 'count': 3,
             'transactions': [{'bookingDate': iso(a), 'valueDate': iso(b), 'amount': c, 'bookingText': t}
                              for a, b, t, c in visa_tx]},
        ],
        'overview': {'Girokonto': giro_close, 'Tagesgeld PLUS-Konto': 0, 'Depot': depot, 'Visa-Karte': 0, 'Gesamtsaldo': gesamt},
        'depot': {'date': '2024-12-02', 'value': depot, 'cost': tot_cost, 'gain': tot_gain, 'count': len(hold),
                  'holdings': [{k: h[k] for k in ('wkn', 'name', 'qty', 'currency', 'value', 'cost', 'gain', 'verwahrart')}
                               | {'priceText': h['priceText']} for h in hold]},
        'taxOverview': {lab: v for lab, v, _ in tax},
        'notTaxCert': True,
    })


# ------------------------------------------------------------------ 5. MLP Reporting Konten & Depots Q1 2025 (d6)

MLP_FUNDS = [
    # (WKN, ISIN-Präfix, Name-Zeilen, Schwerpunkt, Verwahrart, Währung, Kurs 31.03., Kursdatum, Börsenplatz, Kategorie,
    #  Kurse der 3 Käufe, Devisenkurse, Kaufdaten, Anteile vor Q1)
    ('A0NB6T', 'LU0552385', ['Nordstern Funds - Global Opportunity Fund'], 'Aktien Welt',
     'Wertpapierrechnung Luxemburg', 'EUR', '118.42', '31.03.2025', 'Fondsgesellschaft', 'Aktien',
     ['121.05', '124.88', '117.30'], None, ['02.01.25', '03.02.25', '03.03.25'], '5.912'),
    ('A2JSDC', 'IE00BP3QZ', ['iShares Edge MSCI World Value Factor UCITS', 'ETF'], 'Aktien Welt',
     'Wertpapierrechnung Irland', 'USD', '45.3120', '31.03.2025', '!NAV', 'Aktien',
     ['42.1180', '44.0475', '45.0310'], ['1.0365', '1.0303', '1.0630'], ['03.01.25', '04.02.25', '04.03.25'], '14.087'),
    ('A2DWBY', 'IE00BF4RF', ['iShares MSCI World Small Cap UCITS ETF'], 'Aktien Welt mittlere / kleine Unternehmen',
     'Wertpapierrechnung Irland', 'USD', '6.5462', '31.03.2025', '!NAV', 'Aktien',
     ['6.4210', '6.6638', '6.4417'], ['1.0365', '1.0303', '1.0630'], ['03.01.25', '04.02.25', '04.03.25'], '96.311'),
    ('A3CMRW', 'IE00BKM4G', ['Vantage MSCI EM Markets UCITS ETF'], 'Aktien Schwellenländer Welt',
     'Wertpapierrechnung Irland', 'USD', '33.0915', '31.03.2025', '!NAV', 'Aktien',
     ['31.9470', '32.4302', '33.2058'], ['1.0234', '1.0303', '1.0630'], ['02.01.25', '04.02.25', '04.03.25'], '19.704'),
    ('A1JX8P', 'LU0719421', ['Lumen Europa Aktienfonds'], 'Aktien Europa',
     'Wertpapierrechnung Luxemburg', 'EUR', '214.36', '31.03.2025', 'Fondsgesellschaft', 'Aktien',
     ['203.74', '211.55', '219.12'], None, ['03.01.25', '03.02.25', '03.03.25'], '2.418'),
    ('A2QJLA', 'LU2296537', ['Helios Clean Energy Fund'], 'Aktien Erneuerbare Energien',
     'Wertpapierrechnung Luxemburg', 'EUR', '86.17', '31.03.2025', 'Fondsgesellschaft', 'Aktien',
     ['88.62', '84.97', '87.40'], None, ['02.01.25', '03.02.25', '03.03.25'], '4.106'),
    ('A1H6XK', 'LU0533012', ['Atlas Global Real Estate', 'Equities'], 'Immobilienaktien Welt',
     'Wertpapierrechnung Luxemburg', 'EUR', '131.08', '31.03.2025', 'Investmentpreise', 'Aktien',
     ['128.60', '133.14', '130.25'], None, ['02.01.25', '03.02.25', '03.03.25'], '2.866'),
    ('A3DMU1', 'IE000GPV3', ['Summit Nasdaq Tech UCITS ETF'], 'Aktien Technologie',
     'Wertpapierrechnung Irland', 'USD', '11.8845', '31.03.2025', '!NAV', 'Aktien',
     ['12.4060', '12.8713', '11.9502'], ['1.0365', '1.0303', '1.0630'], ['03.01.25', '04.02.25', '04.03.25'], '55.318'),
    ('A0M430', 'LU0323578', ['PVF - Prisma Vermögensverwaltungsfonds', 'Dynamik R'], 'Vermögensverwalter - dynamisch',
     'Wertpapierrechnung Luxemburg', 'EUR', '172.55', '28.03.2025', 'Fondsgesellschaft', 'Mischfonds',
     ['168.31', '171.92', '173.68'], None, ['03.01.25', '04.02.25', '04.03.25'], '3.612'),
]
MLP_RATE = 2000  # Sparrate je Fonds und Monat (Cent)


def mlp_data():
    funds = []
    for (wkn, ipre, names, focus, verw, cur, price, pdate, venue, cat, buys, fxs, dates, pre) in MLP_FUNDS:
        tx = []
        units = Decimal(pre)
        for i, (bp, dt) in enumerate(zip(buys, dates)):
            bp = Decimal(bp)
            fx = Decimal(fxs[i]) if fxs else None
            eur_price = bp / fx if fx else bp
            u = (Decimal(MLP_RATE) / 100 / eur_price).quantize(Decimal('0.001'), rounding=ROUND_HALF_UP)
            units += u
            fee = 2 if cur == 'USD' else 0  # „Fremde Spesen“ (ETF) bzw. Ausgabeaufschlag 0,00
            tx.append({'date': iso(dt), 'dateText': dt, 'type': 'Kauf', 'amount': MLP_RATE, 'price': str(bp),
                       'priceCurrency': cur, 'fxRate': float(fx) if fx else None, 'units': float(u), 'fee': fee})
        p = Decimal(price)
        fx_end = Decimal('1.0815') if cur == 'USD' else None
        value = cents(units * (p / fx_end if fx_end else p))
        funds.append({'wkn': wkn, 'isin': isin((ipre + '00')[:11]),
                      'name': ' '.join(names), 'nameLines': names, 'focus': focus, 'custody': verw, 'currency': cur,
                      'price': str(p), 'priceDate': iso(pdate), 'priceDateText': pdate, 'venue': venue, 'category': cat,
                      'fxRate': float(fx_end) if fx_end else None, 'units': float(units), 'value': value,
                      'transactions': tx})
    liq = 4218
    total = sum(f['value'] for f in funds) + liq
    for f in funds:
        f['share'] = float((Decimal(f['value']) / total * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    return funds, liq, total


def wrap(text, font, size, maxpx):
    out, line = [], ''
    for w_ in text.split():
        cand = (line + ' ' + w_).strip()
        if line and stringWidth(cand, font, size) > maxpx * PX:
            out.append(line)
            line = w_
        else:
            line = cand
    return out + [line]


def make_mlp():
    funds, liq, total = mlp_data()
    d = Doc('mlp_depotreport', 'Reporting Konten und Depots', 'MLP Banking AG')
    B, N = 'Helvetica-Bold', 'Helvetica'
    NAVY = (0.02, 0.24, 0.39)
    LIGHT, MID, DARK = (0.90, 0.93, 0.97), (0.82, 0.89, 0.96), (0.65, 0.80, 0.93)
    ersteinzahlung = 360000
    einz_vor = ersteinzahlung + 6 * 9 * MLP_RATE  # Ersteinzahlung 01.07.2024 + Sparraten Jul–Dez
    einz = einz_vor + 3 * 9 * MLP_RATE
    gesamt_vj = 531240
    aussch, depotentgelt, spesen, vfp = 1236, -1500, -54, 212
    ergebnis = total - einz

    def pagenum(n):
        d.tp(1352, 1930, f'{n}/6', 9, align='r')

    def mlp_logo():
        d.img(logo('mlp'), 1072, 100, 210)

    # ---- Seite 1: Anschreiben
    mlp_logo()
    d.tp(168, 326, 'MLP Banking AG · Alte Heerstraße 40 · 69168 Wiesloch', 6.5)
    for i, ln in enumerate(['Herrn Jan Beispiel', 'Lindenallee 12', '22880 Wedel']):
        d.tp(168, 468 + i * 32, ln, 10.5)
    right = [(369, 'MLP Banking AG', B, 8.5), (418, 'MLP Bank-Kundenservice', B, 7.5),
             (441, 'Tel   +49 (0) 6222 • 3169 • 4000', N, 7.5), (462, 'Fax  +49 (0) 6222 • 3169 • 8933', N, 7.5),
             (485, 'service@mlp-banking.de', N, 7.5), (526, 'Ihr MLP Berater:', B, 7.5), (547, 'Thomas Wenzel', N, 7.5),
             (569, '+49 (0) 40 • 3290 • 117', N, 7.5), (592, 'thomas.wenzel@mlp.de', N, 7.5),
             (633, 'MLP Kundennummer:', B, 7.5), (655, '4711235', N, 7.5), (696, 'MLP Geschäftsstelle', N, 7.5),
             (718, 'Hamburg Alster', N, 7.5), (740, 'Ballindamm 7', N, 7.5), (761, '20095 Hamburg', N, 7.5),
             (804, 'www.mlp-banking.de', N, 7.5)]
    for y, s, f, sz in right:
        d.tp(1077, y, s, sz, f)
    d.tp(168, 735, 'Wiesloch, im Mai 2025', 11.5)
    d.tp(168, 799, 'Reporting für Ihre Konten und Depots zum 1. Quartal 2025', 11.5, B)
    d.tp(168, 895, 'Sehr geehrter Herr Beispiel,', 11.5)
    letter = [
        (956, 'anbei erhalten Sie Ihr persönliches Reporting für das 1. Quartal 2025. Wie gewohnt'),
        (986, 'bietet Ihnen das Reporting einen umfassenden Überblick über den Stand Ihrer Konten'),
        (1015, 'und Depots, Ihre Transaktionen sowie Ihre Anlagestruktur. Zusätzlich können Sie die'),
        (1045, 'Wertentwicklung aller Verträge auf einen Blick nachvollziehen.'),
        (1105, 'Ihr Reporting ist auch online unter www.mlp.de im „MLP Financial Home“ über das'),
        (1134, 'Postbox-Symbol unter Dokumente im Ordner „MLP Reporting“ abrufbar. Sie können'),
        (1164, 'den zusätzlichen Postversand abbestellen und damit einen wertvollen Beitrag zum'),
        (1193, 'Umweltschutz leisten. Das Formular „Vereinbarung zum elektronischen Versand“'),
        (1223, 'finden Sie online auf www.mlp.de/service, Formulare oder als Online-Formular direkt'),
        (1253, 'im Financial Home. Informationen zum Datenschutz erhalten Sie unter'),
        (1282, 'mlp.de/mlp/datenschutz.'),
        (1342, 'Für weitere Fragen stehen Ihnen Ihr MLP Berater und unser MLP Bank-Kundenservice'),
        (1371, 'gerne montags bis freitags von 8.00 bis 20.00 Uhr unter Tel +49 (0) 6222 • 3169 • 4000'),
        (1401, 'oder per Mail an service@mlp-banking.de zur Verfügung.'),
        (1459, 'Mit freundlichen Grüßen'),
        (1523, 'MLP Banking AG'),
    ]
    for y, s in letter:
        d.fit(168, y, s, 11.5, maxpx=915)
    c = d.c
    c.setLineWidth(0.8)
    for x0 in (180, 690):
        p = c.beginPath()
        p.moveTo(x0 * PX, H - 1620 * PX)
        for k in range(1, 9):
            p.curveTo((x0 + k * 22) * PX, H - (1570 + (k % 3) * 25) * PX, (x0 + k * 22 + 8) * PX,
                      H - (1640 - (k % 2) * 40) * PX, (x0 + k * 24) * PX, H - (1600 + (k % 4) * 8) * PX)
        c.drawPath(p)
    d.tp(168, 1663, 'ppa. Petra Lorenz', 11.5)
    d.tp(674, 1663, 'ppa. Dr. Markus Feld', 11.5)
    foot = [(168, ['Aufsichtsratsvorsitzende', None, 'Dr. Erika Muster']),
            (380, ['Vorstand', None, 'Max Vorbild', '(Vorstandssprecher)', 'Anna Beispielfrau', 'Ben Vorlage']),
            (602, ['Handelsregister', None, 'Registergericht Mannheim', 'HRB 123456', None, 'Sitz Wiesloch', None,
                   'SWIFT-BIC: MLPBDE61']),
            (818, ['Bankverbindung', None, 'Deutsche Bundesbank', 'Filiale Ludwigshafen', None, 'Kontokennung: 67200000'])]
    for x, lines in foot:
        y = 1814
        for i, s in enumerate(lines):
            if s:
                d.tp(x, y, s, 7, B if i == 0 else N)
            y += 22 if i else 30
    # ---- Seite 2: Depotübersicht
    d.page()

    def contact_block():
        for y, s in [(119, 'MLP Bank-Kundenservice'), (145, 'Tel +49 (0) 6222 • 3169 • 4000'),
                     (170, 'Fax +49 (0) 6222 • 3169 • 8933'), (198, 'service@mlp-banking.de')]:
            d.tp(168, y, s, 9)

    contact_block()
    mlp_logo()
    d.rect(471, 221, 1414, 356, fill=(0.65, 0.54, 0.42))
    d.rect(471, 221, 505, 356, fill=NAVY)
    d.tp(542, 274, 'Ihre Geldanlage:', 20, color=(1, 1, 1))
    d.tp(542, 331, 'Vermögensdepot', 20, color=(1, 1, 1))
    d.tp(168, 416, 'Jan Beispiel', 9.5)
    d.tp(1276, 416, '1. Quartal 2025 - Stand: 31. März 2025', 9.5, align='r')
    d.tp(168, 442, 'Kundennummer:', 8.5, B)
    d.tp(350, 442, '4711235', 8.5)
    d.tp(168, 480, 'Liquiditätskonto:', 8.5, B)
    d.tp(350, 480, MLP_IBAN, 8.5)
    d.tp(168, 506, 'Depot:', 8.5, B)
    d.tp(350, 506, '4711235001', 8.5)
    d.tp(168, 622, 'Depotübersicht', 12, B)
    XS = [168, 302, 639, 774, 908, 1077, 1272]

    def table_head(y0):
        d.hline(168, 1272, y0, 1, gray=0.6)
        for i in range(6):
            d.rect(XS[i], y0, XS[i + 1], y0 + 150, fill=MID if i % 2 == 0 else LIGHT)
        heads = [(175, 'l', ['WKN']), (309, 'l', ['Bezeichnung', 'Anlageschwerpunkt', 'Verwahrart',
                                                   'Sonderheit / Sperre / Stückeart']),
                 (767, 'r', ['Sparrate', 'Dynamik']), (902, 'r', ['Anzahl /', 'Nennwert']),
                 (1070, 'r', ['Wertpapierkurs', 'Kursdatum', 'Börsenplatz des', 'Kurses', 'Devisenkurs']),
                 (1266, 'r', ['Kurswert in EUR', 'Anteil'])]
        for x, al, lines in heads:
            for k, s in enumerate(lines):
                d.tp(x, y0 + 29 + k * 25, s, 8.5, B, align=al)
        d.hline(168, 1272, y0 + 150, 1, gray=0.6)
        return y0 + 150

    def body_bg(y1, y2):
        for i in range(6):
            d.rect(XS[i], y1, XS[i + 1], y2, fill=MID if i % 2 == 0 else LIGHT)

    y = table_head(647)
    NS, NW = 7.4, 330
    rows_h = sum(20 * (len(wrap(f['name'], B, NS, NW)) - 1) + 26.5 * 4 + 4 for f in funds)
    body_bg(y, max(1815, y + 20 + rows_h))
    y += 20
    for f in funds:
        lines = wrap(f['name'], B, NS, NW)
        d.tp(175, y, f['wkn'], 8.5)
        for k, s in enumerate(lines):
            d.tp(309, y + k * 20, s, NS, B)
        sub = [f['focus'], f'{f["custody"]}', '- / keine Sperre / normale Stücke']
        ys = y + 20 * (len(lines) - 1) + 26.5
        d.tp(770, y, f'{de(MLP_RATE)} EUR', 8.5, align='r')
        d.tp(904, y, dnum(Decimal(str(f['units'])), 3), 8.5, align='r')
        pr = Decimal(f['price'])
        d.tp(1073, y, f'{dnum(pr, 4 if f["currency"] == "USD" else 2)} {f["currency"]}', 8.5, align='r')
        d.tp(1268, y, f'{de(f["value"])} EUR', 8.5, align='r')
        for k, s in enumerate(sub):
            d.tp(309, ys + k * 26.5, s, 7.6)
        d.tp(1070, ys, f['priceDateText'], 8.5, align='r')
        d.tp(1265, ys, f'{dnum(Decimal(str(f["share"])), 2)} %', 8.5, align='r')
        d.tp(1070, ys + 26.5, f['venue'], 8.5, align='r')
        if f['fxRate']:
            d.tp(1070, ys + 53, dnum(Decimal(str(f['fxRate'])), 4), 8.5, align='r')
        y = ys + 26.5 * 3 + 4
    pagenum(1)
    # ---- Seite 3: Liquidität, Summe, Depotaufbau, Überblick
    d.page()
    mlp_logo()
    y = table_head(228)
    body_bg(y, y + 56)
    d.tp(309, y + 18, 'Liquiditätskonto', 8, B)
    d.tp(1268, y + 18, f'{de(liq)} EUR', 8.5, align='r')
    liq_share = float((Decimal(liq) / total * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
    d.tp(1265, y + 45, f'{dnum(Decimal(str(liq_share)), 2)} %', 8.5, align='r')
    d.rect(168, y + 56, 1272, y + 110, fill=DARK)
    d.tp(175, y + 75, 'Summe', 8.5, B)
    d.tp(1268, y + 75, f'{de(total)} EUR', 8.5, B, align='r')
    d.tp(1265, y + 102, '100,00 %', 8.5, B, align='r')
    d.hline(168, 1272, y + 110, 1.2, gray=0)
    d.tp(168, 518, 'Datenquellen: Deutsche Börse AG, boerse-stuttgart AG, software-systems.at und weitere. Fondspreise: FactSet', 7)
    d.tp(168, 625, 'Depotaufbau', 12, B)
    aktien = sum(f['value'] for f in funds if f['category'] == 'Aktien')
    misch = sum(f['value'] for f in funds if f['category'] == 'Mischfonds')
    d.rect(168, 649, 471, 790, fill=MID)
    d.rect(471, 649, 707, 790, fill=LIGHT)
    d.hline(168, 707, 649, 1, gray=0.6)
    d.tp(175, 672, 'Anlagepositionen', 7.5, B)
    d.tp(700, 672, 'Depotwert', 7.5, B, align='r')
    d.hline(168, 707, 682, 0.5, gray=0.6)
    for i, (lab, v) in enumerate([('Kapitalreserve', liq), ('Aktien', aktien), ('Mischfonds', misch)]):
        d.tp(175, 701 + i * 27, lab, 7.5)
        d.tp(703, 701 + i * 27, f'{de(v)} EUR', 7.5, align='r')
    d.rect(168, 764, 707, 790, fill=DARK)
    d.tp(175, 782, 'Summe', 7.5, B)
    d.tp(703, 782, f'{de(total)} EUR', 7.5, B, align='r')
    d.tp(870, 625, 'Anlagestruktur', 12, B)
    d.hline(870, 1280, 649, 1, gray=0.6)
    cx, cy, r = 987 * PX, H - 763 * PX, 82 * PX
    start = 90.0
    shares = [(liq, (0.62, 0.78, 0.92)), (aktien, (0.02, 0.24, 0.39)), (misch, (0.82, 0.86, 0.86))]
    for v, col in shares:
        ext = 360.0 * v / total
        c.setFillColorRGB(*col)
        c.wedge(cx - r, cy - r, cx + r, cy + r, start, -ext, stroke=0, fill=1)
        start -= ext
    c.setFillColorRGB(0, 0, 0)
    d.tp(1067, 727, f'{dnum(Decimal(misch) / total * 100, 1)} %', 7.5)
    d.tp(860, 803, f'{dnum(Decimal(aktien) / total * 100, 1)} %', 7.5)
    for i, (lab, col) in enumerate([('Kapitalreserve', (0.62, 0.78, 0.92)), ('Aktien', NAVY),
                                    ('Mischfonds', (0.82, 0.86, 0.86))]):
        d.rect(1146, 735 + i * 21, 1163, 752 + i * 21, fill=col)
        d.tp(1173, 748 + i * 21, lab, 7.5)
    d.hline(870, 1280, 872, 1, gray=0.6)
    d.tp(168, 965, 'Ihr Vermögensdepot im Überblick', 12, B)

    def kv_block(y1, rows, y2):
        d.rect(168, y1, 653, y2, fill=MID)
        d.rect(653, y1, 1279, y2, fill=LIGHT)
        d.hline(168, 1279, y1, 1, gray=0.6)
        for i, (lab, v) in enumerate(rows):
            yy = y1 + 21 + i * 33.6
            d.tp(181, yy, lab, 7.5)
            d.tp(1268, yy, f'{de(v)} EUR', 7.5, align='r')
        d.hline(168, 1279, y2, 1, gray=0.6)

    kv_block(990, [('Ausschüttungen/Zinsen/Dividenden', aussch), ('Depotentgelt (gebucht im Liquiditätskonto)', depotentgelt),
                   ('Fremde Spesen (gebucht im Liquiditätskonto)', spesen),
                   ('Erstattete Vertriebsfolgeprovision (gebucht im Liquiditätskonto)', vfp),
                   ('Gesamtwert 31.12.2024', gesamt_vj)], 1158)
    kv_block(1186, [('Aktuelle Sparrate', 9 * MLP_RATE), ('Ersteinzahlung', ersteinzahlung), ('Summe der Einzahlungen', einz),
                    ('Summe der Einlieferungen', 0), ('Summe der Auszahlungen', 0), ('Summe der Auslieferungen', 0),
                    ('Anrechenbare Steuern (bis 2008)', 0), ('Abgeltungssteuer (ab 2009)', 0),
                    ('Erstattete Abgeltungssteuer', 0)], 1489)
    d.rect(168, 1489, 1279, 1556, fill=DARK)
    d.tp(181, 1510, 'Gesamtwert', 10, B)
    d.tp(328, 1510, '31.03.2025', 10, B)
    d.tp(1268, 1510, f'{de(total)} EUR', 10, B, align='r')
    d.tp(181, 1544, 'Gesamtergebnis  01.07.2024 bis 31.03.2025', 10, B)
    d.tp(1268, 1544, f'{de(ergebnis)} EUR', 10, B, align='r')
    d.hline(168, 1279, 1556, 1.2, gray=0)
    d.tp(168, 1589, 'Weitere Details zu Kosten und Gebühren stellen wir auf Anfrage gerne zur Verfügung', 7)
    pagenum(2)
    # ---- Seite 4: Wertentwicklung
    d.page()
    mlp_logo()
    perf = {'twr': ['1,84', '1,84', '6,12'], 'mwr': ['1,77', '1,77', '5,46']}
    d.tp(168, 237, 'Wertentwicklung Ihres Vermögensdepot', 12, B)
    xs = [168, 437, 648, 858, 1068]
    for i in range(4):
        d.rect(xs[i], 262, xs[i + 1], 380, fill=MID if i % 2 == 0 else LIGHT)
    d.hline(168, 1068, 262, 1, gray=0.6)
    for x, (h1, h2) in zip((634, 845, 1055), [('Laufendes Jahr vom', '01.01.2025 bis 31.03.2025'),
                                              ('Im Berichtsquartal vom', '01.01.2025 bis 31.03.2025'),
                                              ('Seit Beginn vom', '01.07.2024 bis 31.03.2025')]):
        d.tp(x, 280, h1, 7.5, B, align='r')
        d.tp(x, 304, h2, 7.5, B, align='r')
    d.hline(168, 1068, 312, 0.5, gray=0.6)
    for k, (lab, key) in enumerate([('zeitgewichtete Rendite*', 'twr'), ('geldgewichtete Rendite*', 'mwr')]):
        yy = 334 + k * 33
        d.tp(181, yy, lab, 7.5)
        for x, v in zip((634, 845, 1055), perf[key]):
            d.tp(x, yy, f'{v} %', 7.5, align='r')
    d.hline(168, 1068, 380, 1.2, gray=0)
    d.tp(168, 420, '*vor Steuern, nach Gebühren', 6.5)
    for i, s in enumerate(['Die zeitgewichtete Rendite beschreibt die Performance des Portfolios in einem Zeitraum unabhängig davon, wie stark ein Anleger investiert war (Verwaltungsperformance).',
                           'Die geldgewichtete Rendite zeigt an, welche Performance der Kunde mit dem Portfolio erzielt hat. Hierbei wird explizit berücksichtigt, in welchem  Zeitraum der Anleger',
                           'in welchem Umfang investiert war (Vermögensperformance).']):
        d.fit(168, 444 + i * 17, s, 6.5, maxpx=1065)
    d.tp(168, 573, 'Wertentwicklung Ihrer Wertpapiere im Vermögensdepot', 12, B)
    xs = [168, 302, 673, 976, 1279]
    for i in range(4):
        d.rect(xs[i], 598, xs[i + 1], 975, fill=MID if i in (0, 2) else LIGHT)
    d.hline(168, 1279, 598, 1, gray=0.6)
    d.tp(175, 617, 'WKN', 7.5, B)
    d.tp(309, 617, 'Bezeichnung', 7.5, B)
    for x, lines in [(969, ['geldgewichtete Performance', 'seit erstmaligem Kauf', 'vom 01.07.2024 bis 31.03.2025']),
                     (1272, ['Ergebnis', 'seit erstmaligem Kauf', 'vom 01.07.2024 bis 31.03.2025'])]:
        for k, s in enumerate(lines):
            d.tp(x, 617 + k * 23.5, s, 7.5, B, align='r')
    d.hline(168, 1279, 672, 0.5, gray=0.6)
    perf_f = ['4,12', '7,85', '2,31', '5,02', '9,46', '-6,73', '1,58', '12,04', '3,37']
    res_f = [3712, 6034, 1388, 3135, 4890, -2604, 512, 7921, 2307]
    for i, f in enumerate(funds):
        yy = 694 + i * 33.6
        d.tp(175, yy, f['wkn'], 7.5)
        d.fit(309, yy, f['name'], 7.5, maxpx=520)
        d.tp(956, yy, perf_f[i], 7.5, align='r')
        d.tp(958, yy, ' %', 7.5)
        d.tp(1275, yy, f'{de(res_f[i])} EUR', 7.5, align='r')
    d.hline(168, 1279, 975, 1.2, gray=0)
    d.tp(168, 1065, 'Depotentwicklung Ihres Vermögensdepot vom 01.07.2024 bis 31.03.2025', 12, B)
    d.hline(168, 1279, 1090, 1, gray=0.6)
    # Flächendiagramm (Grafik) mit Achsenbeschriftung (Text)
    x0, x1, yb, yt = 205, 1170, 1442, 1110
    vals = [4700, 4720, 4760, 4690, 4880, 4950, 5120, 5230, 5480, 5520, 5600, 5830, 5900, 6110, 6060, 6230, 6310,
            6560, 6740, 6600, 6450, 6520, 6380]
    c.setFillColorRGB(0.6, 0.7, 0.75)
    p = c.beginPath()
    p.moveTo(x0 * PX, H - yb * PX)
    for i, v in enumerate(vals):
        p.lineTo((x0 + (x1 - x0) * i / (len(vals) - 1)) * PX, H - (yb - (yb - 1184) * v / 7000) * PX)
    p.lineTo(x1 * PX, H - yb * PX)
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    d.hline(168, 1170, yb, 0.8)
    d.vline(1170, 1118, yb, 0.8)
    d.tp(1201, 1140, 'EUR', 8.5)
    for k, lab in enumerate(['7.000', '6.000', '5.000', '4.000', '3.000', '2.000', '1.000', '0']):
        d.tp(1184, 1189 + k * 36.8, lab, 8.5)
    for x, lab in [(222, 'Jul.  2024'), (350, 'Aug.'), (460, 'Sep.'), (570, 'Okt.'), (678, 'Nov.'), (783, 'Dez.'),
                   (870, 'Jan.  2025'), (1002, 'Feb.'), (1101, 'Mär.')]:
        d.tp(x, 1469, lab, 8.5)
    c.setFillColorRGB(0.89, 0.47, 0.0)
    for x, yy in [(207, 1133), (207, 1159), (210, 1184), (316, 1133), (429, 1159), (532, 1184), (750, 1133),
                  (857, 1159), (973, 1184), (1072, 1133)]:
        c.circle(x * PX, H - yy * PX, 11 * PX, stroke=0, fill=1)
    c.circle(198 * PX, H - 1491 * PX, 11 * PX, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)
    d.tp(218, 1495, 'Einzahlungen/Einlieferungen', 7)
    d.tp(188, 1520, 'Hinweis: Es werden die 10 größten Transaktionen im Betrachtungszeitraum angezeigt.', 7)
    d.rect(1018, 1492, 1035, 1509, fill=(0.6, 0.7, 0.75))
    d.rect(1018, 1513, 1035, 1530, fill=(0.62, 0.78, 0.92))
    d.tp(1052, 1504, 'Depot', 7)
    d.tp(1052, 1525, 'Liquiditätskonto', 7)
    d.hline(168, 1279, 1556, 1, gray=0.6)
    pagenum(3)

    # ---- Seiten 5/6: Transaktionsübersicht
    def tx_block(y0, f):
        TX = [168, 309, 447, 589, 727, 865, 1003, 1141, 1279]
        for i in range(8):
            d.rect(TX[i], y0, TX[i + 1], y0 + 220, fill=MID if i % 2 == 0 else LIGHT)
        d.hline(168, 1279, y0, 1, gray=0.6)
        d.tp(181, y0 + 19, 'Bezeichnung', 10, B)
        d.fit(461, y0 + 19, f['name'], 10, B, maxpx=590)
        d.tp(1127, y0 + 19, 'WKN', 10, B, align='r')
        d.tp(1268, y0 + 19, f['wkn'], 10, B, align='r')
        d.hline(168, 1279, y0 + 33, 0.5, gray=0.6)
        etf = f['currency'] == 'USD'
        heads = [(181, 'l', ['Handelsdatum']), (434, 'r', ['Transaktion']), (575, 'r', ['Betrag']),
                 (714, 'r', ['AGS/Soli/KIST']), (852, 'r', ['Anteilspreis']), (990, 'r', ['Devisenkurs']),
                 (1127, 'r', ['Fremde', 'Spesen**'] if etf else ['Ausgabe-', 'aufschlag*']), (1266, 'r', ['Anteile'])]
        for x, al, lines in heads:
            for k, s in enumerate(lines):
                d.tp(x, y0 + 51 + k * 25, s, 7.5, B, align=al)
        d.hline(168, 1279, y0 + 85, 0.5, gray=0.6)
        for k, t in enumerate(f['transactions']):
            yy = y0 + 105 + k * 34
            d.tp(181, yy, t['dateText'], 7.5)
            d.tp(434, yy, 'Kauf', 7.5, align='r')
            d.tp(578, yy, f'{de(t["amount"])} EUR', 7.5, align='r')
            dec = 4 if etf else 2
            d.tp(852, yy, f'{dnum(Decimal(t["price"]), dec)} {t["priceCurrency"]}', 7.5, align='r')
            if t['fxRate']:
                d.tp(990, yy, f'{dnum(Decimal(str(t["fxRate"])), 4)} USD', 7.5, align='r')
            d.tp(1130, yy, f'{de(t["fee"])} EUR', 7.5, align='r')
            d.tp(1268, yy, dnum(Decimal(str(t['units'])), 3), 7.5, align='r')
        d.rect(168, y0 + 186, 1279, y0 + 220, fill=DARK)
        d.tp(181, y0 + 207, 'Kurswert zum 31.03.2025', 7.5)
        d.tp(1268, y0 + 207, f'{de(f["value"])} EUR', 7.5, align='r')
        d.hline(168, 1279, y0 + 220, 1.2, gray=0)

    d.page()
    mlp_logo()
    d.tp(168, 237, 'Transaktionsübersicht vom 01. Januar 2025 bis 31. März 2025', 12, B)
    d.tp(168, 270, 'Alle im folgenden aufgeführten Wertpapiergeschäfte wurden außerbörslich ausgeführt.', 9)
    for i, f in enumerate(funds[:5]):
        tx_block(296 + i * 275, f)
    pagenum(4)
    d.page()
    mlp_logo()
    for i, f in enumerate(funds[5:]):
        tx_block(222 + i * 275, f)
    d.tp(168, 1309, '* Ausgabeaufschläge sind bei Wertpapierkäufen im Anteilspreis schon enthalten.', 6.5)
    d.tp(168, 1326, '** Bei den fremden Spesen handelt es sich um eine Servicegebühr („Additional Trading Costs“), die bei ETFs für einen Abwicklungsdienstleister der MLP Banking AG anfällt.', 6.5)
    left = ['Zinsen, Ausschüttungen, Gebühren bzw. weitere Kosten kön-', 'nen den Gegenwert der Käufe und Verkäufe erhöhen oder',
            'reduzieren. Bitte prüfen Sie die Transaktionsübersicht auf ihre', 'Richtigkeit und Vollständigkeit. Einwendungen gegen diese',
            'müssen unverzüglich nach Zugang gegenüber der', 'MLP Banking AG, Revision, Alte Heerstraße 40, 69168 Wiesloch',
            'erhoben werden.']
    rightc = ['Besteht kein Freistellungsauftrag bei der MLP Banking AG', 'oder ist dieser bereits ausgeschöpft, können bei Verkäufen',
              'von Wertpapieren Kapitalertragsteuer, Solidaritätszuschlag', 'und gegebenenfalls Kirchensteuer berechnet und abgeführt',
              'werden. Der dabei entstandene negative Steuersaldo wird', 'durch nachfolgende Orders automatisiert ausgeglichen.',
              'Für diese negativen Salden berechnet die MLP Banking AG', 'keine Sollzinsen.']
    for i, s in enumerate(left):
        d.fit(168, 1370 + i * 25, s, 10, maxpx=545)
    for i, s in enumerate(rightc):
        d.fit(742, 1370 + i * 25, s, 10, maxpx=530)
    d.tp(168, 1665, 'Freistellungsauftrag', 12, B)
    d.rect(168, 1680, 673, 1741, fill=MID)
    d.rect(673, 1680, 875, 1741, fill=LIGHT)
    d.rect(875, 1680, 1077, 1741, fill=MID)
    d.hline(168, 1077, 1680, 1, gray=0.6)
    d.tp(862, 1700, 'beantragt', 9.5, B, align='r')
    d.tp(1063, 1700, 'Restfreibetrag', 9.5, B, align='r')
    d.hline(168, 1077, 1713, 0.5, gray=0.6)
    d.tp(181, 1730, 'MLP Banking AG (alle Konten und Depots)', 7.5)
    d.tp(864, 1730, '1.000,00 EUR', 7.5, align='r')
    d.tp(1066, 1730, '987,64 EUR', 7.5, align='r')
    d.hline(168, 1077, 1741, 1.2, gray=0)
    pagenum(5)
    # ---- Seite 7: Marktkommentar
    d.page()
    mlp_logo()
    charts = [('EuroStoxx 50 (in Punkten)', ['5.800', '5.600', '5.400', '5.200', '5.000', '4.800', '4.600']),
              ('Rendite 10-jähriger deutscher Bundesanleihen', ['3,0 %', '2,8 %', '2,6 %', '2,4 %', '2,2 %', '2,0 %']),
              ('Wechselkurs Euro in US-Dollar', ['1,10', '1,08', '1,06', '1,04', '1,02', '1,00']),
              ('Goldpreis (in USD)', ['3.200', '3.000', '2.800', '2.600', '2.400', '2.200'])]
    for k, (title, ticks) in enumerate(charts):
        y0 = 250 + k * 425
        d.tp(170, y0, title, 9, B)
        for i, t in enumerate(ticks):
            yy = y0 + 45 + i * 300 / len(ticks)
            d.tp(170, yy, t, 6.5)
            d.hline(250, 690, yy - 3, 0.3, gray=0.7)
        pth = c.beginPath()
        for i in range(40):
            xx = (255 + i * 11) * PX
            yy = H - (y0 + 250 - 120 * (0.5 + 0.4 * ((i * 7 + k * 3) % 13) / 13 + 0.01 * i)) * PX
            pth.moveTo(xx, yy) if i == 0 else pth.lineTo(xx, yy)
        c.setStrokeColorRGB(0.05, 0.25, 0.4)
        c.setLineWidth(1.4)
        c.drawPath(pth)
        c.setStrokeColorRGB(0, 0, 0)
        for i, lab in enumerate(['12/24', '01/25', '02/25', '03/25']):
            d.tp(250 + i * 140, y0 + 355, lab, 6.5)
    d.tp(170, 1965, 'Quelle: FERI AG, Bad Homburg', 7)
    comment = (
        'Marktkommentar|Das erste Quartal war an den Kapitalmärkten von deutlichen Schwankungen geprägt. '
        'Auslöser waren vor allem die handelspolitischen Ankündigungen der neuen US-Regierung, deren Tragweite '
        'sich zunächst nur schwer abschätzen ließ. Zahlreiche Maßnahmen wurden angekündigt, teilweise wieder '
        'zurückgenommen und später in veränderter Form erneut in Aussicht gestellt. Diese Unklarheit belastete '
        'die Stimmung von Unternehmen und Verbrauchern spürbar; die Frühindikatoren gaben in den Vereinigten '
        'Staaten zuletzt nach. Der US-Aktienmarkt verzeichnete im Quartalsverlauf merkliche Kursrückgänge, '
        'insbesondere bei hoch bewerteten Technologiewerten. Europäische Aktien entwickelten sich dagegen '
        'erfreulich und schnitten klar besser ab als der US-Markt. Unterstützt wurde dies durch die günstigere '
        'Bewertung und die Aussicht auf zusätzliche staatliche Investitionen in Deutschland. Die beschlossene '
        'Lockerung der Schuldenregel eröffnet Spielräume für Ausgaben in Infrastruktur und Verteidigung und '
        'verbessert die konjunkturellen Perspektiven für den gesamten Euroraum. Auch asiatische Märkte konnten '
        'zulegen, nachdem in China weitere Maßnahmen zur Stützung des Wachstums in Aussicht gestellt wurden. '
        'Weltweit bleiben die Risiken aus einer Eskalation der Zollpolitik hoch; die Auswirkungen auf Inflation '
        'und Wachstum dürften im zweiten Quartal stärker sichtbar werden. An den Rentenmärkten stiegen die '
        'Renditen deutscher Staatsanleihen angesichts des erwarteten höheren Finanzierungsbedarfs deutlich an. '
        'Der Euro wertete gegenüber dem US-Dollar spürbar auf, was die Ergebnisse in US-Dollar notierender '
        'Anlagen für Euro-Anleger schmälerte. Der Goldpreis erreichte im unsicheren Umfeld mehrfach neue '
        'Höchststände, während der Ölpreis nachgab. Für die kommenden Monate rechnen wir mit anhaltend '
        'erhöhten Schwankungen; eine breite Streuung über Regionen und Anlageklassen bleibt daher wichtig.')
    head_, body = comment.split('|')
    d.tp(745, 232, head_, 9, B)
    words, line, y = body.split(), '', 262
    for w_ in words:
        if stringWidth(line + ' ' + w_, N, 8.2) > 540 * PX * 1.0 * 1.05:
            d.tp(745, y, line.strip(), 8.2)
            y += 22.5
            line = w_
        else:
            line += ' ' + w_
    d.tp(745, y, line.strip(), 8.2)
    pagenum(6)
    tx_all = []
    for f in funds:
        for t in f['transactions']:
            tx_all.append({'wkn': f['wkn'], 'name': f['name'], **t})
    d.save({
        'source': 'd6', 'type': 'wertpapier', 'subtype': 'depotreport', 'institution': 'MLP',
        'date': '2025-03-31', 'period': {'from': '2025-01-01', 'to': '2025-03-31', 'label': 'Q1 2025'}, 'infoOnly': True,
        'depot': {'name': 'MLP Vermögensdepot', 'number': '4711235001', 'value': total, 'date': '2025-03-31',
                  'securitiesValue': total - liq, 'liquidity': {'iban': MLP_RAW, 'value': liq},
                  'structure': {'Kapitalreserve': liq, 'Aktien': aktien, 'Mischfonds': misch}},
        'holdings': [{k: f[k] for k in ('wkn', 'name', 'focus', 'currency', 'price', 'priceDate', 'fxRate', 'units',
                                        'value', 'share', 'category')} for f in funds],
        'figures': {'distributions': aussch, 'depotFee': depotentgelt, 'foreignFees': spesen, 'trailerRefund': vfp,
                    'valuePrevYearEnd': gesamt_vj, 'savingsRate': 9 * MLP_RATE, 'firstDeposit': ersteinzahlung,
                    'deposits': einz, 'withdrawals': 0, 'valueEnd': total, 'result': ergebnis,
                    'resultPeriod': {'from': '2024-07-01', 'to': '2025-03-31'}},
        'performance': {'twr': [1.84, 1.84, 6.12], 'mwr': [1.77, 1.77, 5.46]},
        'transactions': tx_all, 'transactionCount': len(tx_all),
        'freistellung': {'requested': 100000, 'remaining': 98764},
    })


# ------------------------------------------------------------------ 6. DKB Kontoauszug Soll/Haben (d8)

PAYPAL = 'PayPal Europe S.a.r.l. et Cie S.C.A'
PP_CID = 'LU96ZZZ0000000000000000058'


def pp_lines(ref, merchant_tail, line3, mref, extra=None):
    out = [PAYPAL, f'{ref} {merchant_tail}'.strip(), line3]
    if extra:
        out.append(extra)
    out += [f'{mref} Gläubiger-ID:', PP_CID]
    return out


def dkb_bookings():
    """54 Buchungen wie im Original (Reihenfolge, Datum, Art, Text); Seitenumbrüche 7/11/12/12/12."""
    S, Hb = 'S', 'H'
    T = []

    def b(date, kind, lines, amount, side=S, cp=None):
        T.append({'date': date, 'kind': kind, 'lines': lines, 'amount': amount, 'side': side, 'counterparty': cp})

    tel = lambda: ['Telefonica Germany GmbH + Co. OHG Kd-Nr.: 6037719245', 'Rg-Nr. 1403 22817 Ihre Tarifrechnung',
                   'vom 03.02.2026 EREF: 2026020300138852117',
                   'MREF: 6037719245000001 Gläubiger-ID:', 'DE11ZZZ00000040451']
    tk = lambda r, x: pp_lines(r, 'Takeaway .com Payments', 'B.V., Ihr Einkauf bei Takeaway.com Payments B.V.', x)
    miles = lambda r, x: pp_lines(r, 'MILES Mo bility GmbH, Ihr', 'Einkauf bei MILES Mobility GmbH', x)
    # Seite 1
    b('05.02.2026', 'Basislastschrift', tel(), 2999, cp='Telefonica Germany GmbH + Co. OHG')
    b('05.02.2026', 'Kartenzahlung FW', ['NAMECHEAP.COM/Phoenix/US 2026-02-04T23:25',
                                         'Debitk.05 2027-09 Original 20,00 USD 1 Euro=1,17090',
                                         'USD Zahl.System VISA Debit'], 1708, cp='NAMECHEAP.COM')
    b('06.02.2026', 'Basislastschrift', [PAYPAL, '1046318820754 PP.5521.PP . GitHub, Inc., Ihr Einkauf bei',
                                         'GitHub, Inc. 1046318820754', f'Gläubiger-ID: {PP_CID}'], 857, cp='GitHub, Inc.')
    b('09.02.2026', 'Basislastschrift', tk('1046512277310 PP.5521.PP .', '5KPJ224TK8HM2'), 2740, cp='Takeaway.com Payments B.V.')
    b('10.02.2026', 'Basislastschrift', ['PayPal Europe S.a.r.l. et Cie S.C.A 1046631190458/. Steam',
                                         'Ihr Einkauf b ei Valve Corporation 1046631190458',
                                         f'Gläubiger-ID: {PP_CID}'], 1599, cp='Valve Corporation')
    b('10.02.2026', 'Kartenzahlung FW', ['DIGITALOCEAN.COM/NEW YORK/US 2026-02-10T04:04',
                                         'Debitk.05 2027-09 Original 6,00 USD 1 Euro=1,17090',
                                         'USD Zahl.System VISA Debit'], 512, cp='DIGITALOCEAN.COM')
    b('10.02.2026', 'Basislastschrift', miles('1046701384422 PP.5521.PP .', '5KPJ224TK8HM2'), 1284, cp='MILES Mobility GmbH')
    # Seite 2
    b('10.02.2026', 'Basislastschrift', pp_lines('1046702210933 PP.5521.PP .', 'Chess.co m . ChessKid Ihr',
                                                 'Einkauf bei Chess .com . ChessKid 1046702210933', '5KPJ224TK8HM2'),
      749, cp='Chess.com')
    b('11.02.2026', 'Basislastschrift', tk('1046788103566 PP.5521.PP .', '5KPJ224TK8HM2'), 3190, cp='Takeaway.com Payments B.V.')
    b('11.02.2026', 'Basislastschrift', pp_lines('1046790057217 PP.5521.PP .', 'mars kin otickets.online',
                                                 'GmbH . Co. KG, Ihr Einkauf bei mars kinotickets.online', '5KPJ224TK8HM2',
                                                 extra='GmbH . Co. KG 1046790057217')[:4] + [f'Gläubiger-ID: {PP_CID}'],
      2400, cp='mars kinotickets.online GmbH & Co. KG')
    b('12.02.2026', 'Basislastschrift', ['AMAZON EU S.A R.L., NIEDERLASSUNG D', '028-4417092-3381164 AMZNPrime DE 1K',
                                         'EREF: 1ZA8W2VQ71LK4P0X', 'MREF: 5Y4H2J0TQFXBPR Gläubiger-ID:',
                                         'DE24ZZZ00000561652'], 899, cp='AMAZON EU S.A R.L., NIEDERLASSUNG D')
    b('12.02.2026', 'Kartenzahlung', ['ARAL Station 2741/Wedel/DE 2026-02-11T01:48 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 4317, cp='ARAL Station')
    b('13.02.2026', 'Basislastschrift', pp_lines('1046855190032 PP.5521.PP .', 'LogPay F inancial Services',
                                                 'GmbH, Ihr Einkauf bei LogPay Financial Services GmbH', '5KPJ224TK8HM2'),
      940, cp='LogPay Financial Services GmbH')
    b('13.02.2026', 'Basislastschrift', pp_lines('1046855190187 PP.5521.PP .', 'LogPay F inancial Services',
                                                 'GmbH, Ihr Einkauf bei LogPay Financial Services GmbH', '5KPJ224TK8HM2'),
      380, cp='LogPay Financial Services GmbH')
    b('13.02.2026', 'Basislastschrift', tk('1046861122490 PP.5521.PP .', '5KPJ224TK8HM2'), 2250, cp='Takeaway.com Payments B.V.')
    b('16.02.2026', 'Kartenzahlung onl', ['AMAZON.DE*7Q41R0KZ2/amazon.de/LU 2026-02-15T00:50',
                                          'Debitk.05 2027-09 Zahl.System VISA Debit'], 6499, cp='AMAZON.DE')
    mlp = lambda extra: ['MLP Banking AG MLP Finanzberatung VERMOEGENSDEPOT',
                         'SAMMELBUCH UNG SPARPLAN WKN A0NB6T A2JSDC A2DWBY',
                         f'A3CMRW A1JX8P {extra} Gläubiger-ID:', 'DE42ZZZ00000107723']
    b('16.02.2026', 'Basislastschrift', mlp('A2QJLA'), 18000, cp='MLP Banking AG')
    b('16.02.2026', 'Basislastschrift', ['PayPal Europe S.a.r.l. et Cie S.C.A 1046933451207/. Spotify',
                                         'Ihr Einkauf b ei Spotify AB 1046933451207',
                                         f'Gläubiger-ID: {PP_CID}'], 1199, cp='Spotify AB')
    # Seite 3
    b('16.02.2026', 'Kartenzahlung', ['EDEKA Nielsen/Wedel/DE 2026-02-14T07:22',
                                      'Debitk.05 2027-09 Zahl.System VISA Debit'], 5632, cp='EDEKA Nielsen')
    b('16.02.2026', 'Kartenzahlung', ['SHELL 1187/Hamburg/DE 2026-02-14T00:29 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 840, cp='SHELL')
    b('17.02.2026', 'Basislastschrift', pp_lines('1047010288841 PP.5521.PP .', 'OpenAI I reland Limited, Ihr',
                                                 'Einkauf bei OpenAI Ireland Limited 1047010288841', '5KPJ224TK8HM2'),
      2380, cp='OpenAI Ireland Limited')
    b('17.02.2026', 'Basislastschrift', pp_lines('1047019920376 PP.5521.PP . MILES', 'Ihr',
                                                 'Einkauf bei MILES Mobility GmbH 1047019920376', '5KPJ224TK8HM2'),
      913, cp='MILES Mobility GmbH')
    b('18.02.2026', 'Basislastschrift', ['AMAZON PAYMENTS EUROPE S.C.A.', '304-8812734-1102293 AMZN Mktp DE 2D7RT41X0',
                                         'EREF: 5H0QX3WWL9P2Z1AA', 'MREF: 0hFgW3pq-Tc8Lz Gläubiger-ID:',
                                         'DE94ZZZ00000561653'], 3798, cp='AMAZON PAYMENTS EUROPE S.C.A.')
    b('18.02.2026', 'Kartenzahlung', ['dm-drogerie markt/Wedel/DE 2026-02-18T06:05 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 1845, cp='dm-drogerie markt')
    b('23.02.2026', 'Basislastschrift', pp_lines('1047237011845 PP.5521.PP .', 'Takeaway .com Payments',
                                                 'B.V., Ihr Einkauf bei Takeaway.com Payments B.V.', '5KPJ224TK8HM2'),
      2870, cp='Takeaway.com Payments B.V.')
    b('23.02.2026', 'Kartenzahlung', ['Lidl sagt Danke/Hamburg/DE 2026-02-22T20:47 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 3426, cp='Lidl')
    b('23.02.2026', 'Basislastschrift', miles('1047240931177 PP.5521.PP .', '5KPJ224TK8HM2'), 1562, cp='MILES Mobility GmbH')
    b('23.02.2026', 'Basislastschrift', tk('1047241287703 PP.5521.PP .', '5KPJ224TK8HM2'), 1990, cp='Takeaway.com Payments B.V.')
    b('23.02.2026', 'Lohn, Gehalt, Rente', ['Nordlicht Logistik GmbH LOHN / GEHALT 02/26',
                                            'EREF: 2026022300174456 Personalnr. 004417'], 341258, Hb,
      cp='Nordlicht Logistik GmbH')
    b('24.02.2026', 'Kartenzahlung', ['Elbe Apotheke/Wedel/DE 2026-02-23T17:12 Debitk.05',
                                      '2027-09 Zahl.System VISA', 'Debit'], 1295, cp='Elbe Apotheke')
    # Seite 4
    b('24.02.2026', 'Basislastschrift', ['PayPal Europe S.a.r.l. et Cie S.C.A 1047322019884/. Kleinanzeigen',
                                         'Ihr Einkauf b ei Kleinanzeigen GmbH 1047322019884',
                                         f'Gläubiger-ID: {PP_CID}'], 699, cp='Kleinanzeigen GmbH')
    b('24.02.2026', 'Basislastschrift', [PAYPAL, '1047322510273 PP.5521.PP . Hanse Ticket Ver',
                                         'triebs-Marketing-Gesellschaft mbH, Ihr Einkauf bei Hanse',
                                         'Ticket Vertriebs-Mark eting-Gesellschaft mbH 1047322510273',
                                         '5KPJ224TK8HM2 Gläubiger-ID:', PP_CID], 4500,
      cp='Hanse Ticket Vertriebs-Marketing-Gesellschaft mbH')
    b('24.02.2026', 'Basislastschrift', pp_lines('1047322877156 PP.5521.PP . Thalia Bücher GmbH', 'Ihr',
                                                 'Einkauf bei Thalia Bücher GmbH 1047322877156', '5KPJ224TK8HM2'),
      1749, cp='Thalia Bücher GmbH')
    b('24.02.2026', 'Basislastschrift', pp_lines('1047322877157 PP.5521.PP . Thalia Bücher GmbH', 'Ihr',
                                                 'Einkauf bei Thalia Bücher GmbH 1047322877157', '5KPJ224TK8HM2'),
      1749, cp='Thalia Bücher GmbH')
    b('26.02.2026', 'Zahlungseingang', ['PayPal Europe S.a.r.l. et Cie S.C.A . Takeaway.com',
                                        'Payments B.V., Ihr E inkauf bei Takeaway.com Payments B.',
                                        'V./ABBUCHUNG VOM PAYPAL-KONTO 1047401183220'], 2250, Hb,
      cp='PayPal Europe S.a.r.l. et Cie S.C.A')
    b('27.02.2026', 'Dauerauftrag', ['Hausverwaltung Kranich Miete für den nächsten Monat :-+'], 98000,
      cp='Hausverwaltung Kranich')
    b('27.02.2026', 'Basislastschrift', ['Sportvereinigung Wedel-Schulau von 1909 e.V.',
                                         'Mitgliedsbeitrag Februar 2026 Mitglied 0815-22',
                                         'MREF: SVW-0815-22 Gläubiger-ID: DE33ZZZ00000938117'], 1500,
      cp='Sportvereinigung Wedel-Schulau von 1909 e.V.')
    b('27.02.2026', 'Basislastschrift', pp_lines('1047480055691 PP.5521.PP .', 'Takeaway .com Payments',
                                                 'B.V., Ihr Einkauf bei Takeaway.com Payments B.V.', '5KPJ224TK8HM2'),
      2640, cp='Takeaway.com Payments B.V.')
    b('27.02.2026', 'Basislastschrift', pp_lines('1047482207318 PP.5521.PP .', 'Microsof t Payments, Ihr',
                                                 'Einkauf bei Microsoft Payments 1047482207318', '5KPJ224TK8HM2'),
      999, cp='Microsoft Payments')
    b('27.02.2026', 'Zahlungseingang', ['Techniker Krankenkasse TK-Beleg 77120456',
                                        'Erstattun g 23.02.2026 Vers.-Nr. T123456789'], 4860, Hb,
      cp='Techniker Krankenkasse')
    b('27.02.2026', 'Dauerauftrag', ['Jan Beispiel girokonto comdirect wg gebühr'], 1000, cp='Jan Beispiel')
    b('02.03.2026', 'Basislastschrift', ['Allianz Lebensversicherungs-AG Vertrag 4M2 01.03.26 - 31',
                                         '.03.26 PrivRent InvestFlex MREF: AZL4M2 Gläubiger-ID:',
                                         'DE59ZZZ00000011111'], 10000, cp='Allianz Lebensversicherungs-AG')
    # Seite 5
    b('02.03.2026', 'Basislastschrift', ['Alte Leipziger Lebensversicherung a.G.',
                                         'Vertrag 31/7741902 Beitrag:03. 26',
                                         'MREF: AL317741902 EREF: 0302260417 Gläubiger-ID:',
                                         'DE14ZZZ00000011122'], 6450, cp='Alte Leipziger Lebensversicherung a.G.')
    b('02.03.2026', 'Basislastschrift', ['MLP Banking AG MLP Finanzberatung VERMOEGENSDEPOT',
                                         'SAMMELBUCH UNG SPARPLAN WKN A0NB6T A2JSDC A2DWBY',
                                         'A3CMRW A1JX8P A2QJLA u.a. SPARSP 4711235001',
                                         'MREF: MLP4711235 Gläubiger-ID: DE42ZZZ00000107723'], 18000, cp='MLP Banking AG')
    b('02.03.2026', 'Kartenzahlung', ['Bäckerei Junge/Wedel/DE 2026-03-01T20:39 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 2310, cp='Bäckerei Junge')
    b('02.03.2026', 'Basislastschrift', tel()[:2] + ['vom 01.03.2026 EREF: 2026030100139914002',
                                                     'MREF: 6037719245000001 Gläubiger-ID:', 'DE11ZZZ00000040451'],
      2999, cp='Telefonica Germany GmbH + Co. OHG')
    b('02.03.2026', 'Kartenzahlung', ['HVV Automat/Hamburg/DE 2026-02-27T23:25 Debitk.05',
                                      '2027-09 Zahl.System VISA Debit'], 780, cp='HVV Automat')
    b('02.03.2026', 'Basislastschrift', ['Barmenia Krankenversicherung AG',
                                         'Krankenversicherung/Vertrag 7K-5521873 03/2026',
                                         'MREF: BKV7K5521873 Gläubiger-ID:', 'DE66ZZZ00000155773'], 3845,
      cp='Barmenia Krankenversicherung AG')
    b('02.03.2026', 'Kartenzahlung', ['PASSAT.APOTHEKE/Wedel/DE 2026-02-28T10:16',
                                      'Debitk.05 2027-09 Zahl.System VISA Debit'], 2177, cp='PASSAT.APOTHEKE')
    b('02.03.2026', 'Kartenzahlung', ['Kiosk am Rosengarten/Wedel/DE 2026-02-28T23:21',
                                      'Debitk.05 2027-09 Zahl.System VISA Debit'], 420, cp='Kiosk am Rosengarten')
    b('02.03.2026', 'Kartenzahlung onl', ['Google CLOUD 7HX2L1/Dublin/../IE 2026-03-01T23:15',
                                          'Debitk.05 2027-09 Teillieferung 1 von 1 VISA Debit'], 231, cp='Google CLOUD')
    b('03.03.2026', 'Basislastschrift', pp_lines('1047611930025 PP.5521.PP .', 'MILES Mo bility GmbH, Ihr',
                                                 'Einkauf bei MILES Mobility GmbH 1047611930025', '5KPJ224TK8HM2'),
      1105, cp='MILES Mobility GmbH')
    b('03.03.2026', 'Basislastschrift', ['PayPal Europe S.a.r.l. et Cie S.C.A 1047613378461/. Kleinanzeigen',
                                         'Ihr Einkauf b ei Kleinanzeigen GmbH 1047613378461',
                                         f'Gläubiger-ID: {PP_CID}'], 699, cp='Kleinanzeigen GmbH')
    b('04.03.2026', 'Basislastschrift', ['Arbeiter-Samariter-Bund Deutschland ASB-Beitrag:',
                                         '2026/03 / Mitgliedsnummer: 220-77314',
                                         'MREF: ASB22077314 EREF: ASB-2026-03',
                                         'Gläubiger-ID:', 'DE08ZZZ00000123590'], 750, cp='Arbeiter-Samariter-Bund Deutschland')
    assert len(T) == 54
    return T, [7, 11, 12, 12, 12]


def dkb_footer(d):
    cols_ = [(165, ['Deutsche Kreditbank AG', 'Taubenstraße 7-9', '10117 Berlin', None, 'Ein Unternehmen der',
                    'Bayerischen Landesbank']),
             (401, ['Vorsitzender des Aufsichtsrats', 'Dr. Albert Muster', 'Vorstand',
                    'Dr. Bernd Beispiel (Vorsitzender)', 'Carla Vorlage, Dieter Fiktiv', 'Emil Exempel, Frieda Platz']),
             (758, ['Telefon 030 120 300 00', 'Telefax 030 120 300 01', None, 'info@dkb.de', 'www.dkb.de']),
             (994, ['BIC: BYLADEM1001', 'USt-ID: DE137178746', None, 'Handelsregister', 'Berlin-Charlottenburg',
                    '(HRB 34165 B)'])]
    for x, lines in cols_:
        for i, s in enumerate(lines):
            if s:
                d.tp(x, 1860 + i * 21.5, s, 7.6)


def dkb_page_head(d, n, total_pages, first=False):
    d.img(logo('dkb'), 158, 58, 145)
    d.tp(164, 130, 'Deutsche Kreditbank AG', 5.5)
    if first:
        for i, ln in enumerate(KUNDE):
            d.tp(163, 424 + i * 26, ln, 10)
        d.tp(1017, 430, 'Internes Zeichen:', 8.5)
        d.tp(1017, 455, 'BK 07 15', 8.5)
        d.tp(1351, 675, '5. März 2026', 11, 'Helvetica-Bold', align='r')
        d.tp(1351, 702, f'Seite {n} von {total_pages}', 11, align='r')
        d.tp(163, 702, 'Kontoauszug 3/2026', 11, 'Helvetica-Bold')
        d.tp(163, 730, f'Girokonto {DKB_IBAN}', 11, 'Helvetica-Bold')
        return 760
    d.tp(163, 243, 'Kontoauszug 3/2026', 11, 'Helvetica-Bold')
    d.tp(1351, 243, f'Seite {n} von {total_pages}', 11, align='r')
    d.tp(163, 273, f'Girokonto {DKB_IBAN}', 11, 'Helvetica-Bold')
    d.tp(163 + 0 + (stringWidth(f'Girokonto {DKB_IBAN}', 'Helvetica-Bold', 11) / PX) + 18, 273, 'Jan Beispiel', 11, 'Helvetica-Bold')
    return 304


def dkb_table_head(d, top):
    d.tp(169, top + 26, 'Datum', 11)
    d.tp(293, top + 26, 'Erläuterung', 11)
    d.tp(1101, top + 26, 'Betrag Soll EUR', 11, align='r')
    d.tp(1349, top + 26, 'Betrag Haben EUR', 11, align='r')


def dkb_table_frame(d, top, bottom):
    d.rect(165, top, 1353, bottom, stroke=True, width=0.8)
    for x in (289, 857, 1105):
        d.vline(x, top, bottom, 0.8)
    d.hline(165, 1353, top + 34, 0.8)


def make_dkb():
    T, split = dkb_bookings()
    opening = 214533
    debit = sum(t['amount'] for t in T if t['side'] == 'S')
    credit = sum(t['amount'] for t in T if t['side'] == 'H')
    closing = opening - debit + credit
    d = Doc('dkb_kontoauszug', 'Kontoauszug', 'DKB AG')
    k = 0
    for p, n in enumerate(split, 1):
        if p > 1:
            d.page()
        top = dkb_page_head(d, p, 6, first=p == 1)
        bottom = 1670 if p == 1 else 1703
        dkb_table_head(d, top)
        y = top + 60
        if p == 1:
            lab = 'Kontostand am 04.02.2026, Auszug Nr.'
            d.tp(293, y, lab, 11, 'Helvetica-Bold')
            d.tp(293 + stringWidth(lab, 'Helvetica-Bold', 11) / PX + 30, y, '2', 11, 'Helvetica-Bold')
            d.tp(1349, y, de(opening), 11, align='r')
            y += 33
        for t in T[k:k + n]:
            d.tp(167, y, t['date'], 9.8)
            d.tp(293, y, t['kind'], 11)
            d.tp(1101 if t['side'] == 'S' else 1349, y, de(t['amount']), 11, align='r')
            yy = y + 25
            for ln in t['lines']:
                d.fit(293, yy, ln, 9.2, maxpx=560)
                yy += 20.5
            y = yy + 13
        k += n
        if p == 5:
            d.tp(293, y, 'Kontostand am 04.03.2026 um 18:05 Uhr', 11, 'Helvetica-Bold')
            d.tp(1349, y, de(closing), 11, align='r')
            bottom = y + 10
            d.tp(165, y + 36, 'Ihr Dispositionskredit EUR:', 11)
            d.tp(700, y + 36, '1.500,00', 11, align='r')
        dkb_table_frame(d, top, max(bottom, y - 25))
        dkb_footer(d)
    d.page()
    dkb_page_head(d, 6, 6)
    d.tp(169, 353, 'Gesamtumsatzsummen', 11)
    d.tp(767, 353, 'Summe Soll EUR', 11, align='r')
    d.tp(896, 353, 'Anzahl', 11, align='r')
    d.tp(1220, 353, 'Summe Haben EUR', 11, align='r')
    d.tp(1350, 353, 'Anzahl', 11, align='r')
    d.tp(770, 377, de(debit), 11, align='r')
    d.tp(896, 377, '51', 11, align='r')
    d.tp(1224, 377, de(credit), 11, align='r')
    d.tp(1350, 377, '3', 11, align='r')
    d.tp(169, 466, 'Hinweise zum Kontoauszug:', 11, 'Helvetica-Bold')
    d.hline(165, 1353, 486, 0.8)
    bullets = [
        ['Bitte den Kontoauszug prüfen. Nicht autorisierte oder fehlerhaft ausgeführte Aufträge müssen uns unverzüglich angezeigt',
         'werden.'],
        ['Der Kontoauszug am Ende eines Kalenderquartals beinhaltet regelmäßig einen Rechnungsabschluss. Dieser gilt als genehmigt,',
         'wenn ihm nicht vor Ablauf von sechs Wochen nach Zugang widersprochen wird. Einwendungen gegen Rechnungsabschlüsse',
         'müssen der Deutschen Kreditbank AG in Textform zugehen. Zur Fristwahrung genügt die rechtzeitige Absendung (Nr. 7 Abs. 3',
         'der Allgemeinen Geschäftsbedingungen).'],
        ['Der angegebene Kontostand berücksichtigt nicht die Wertstellung der einzelnen Buchungen. Dies bedeutet, dass der genannte',
         'Betrag nicht dem für die Zinsrechnung maßgeblichen Kontostand entsprechen muss und bei Verfügungen möglicherweise',
         'Zinsen für die Inanspruchnahme einer eingeräumten oder geduldeten Kontoüberziehung anfallen können.'],
        ['Die Gutschrift von Schecks, Lastschriften oder anderen Einzugspapieren vor ihrer Einlösung geschieht unter Vorbehalt',
         '(E.v.-Gutschrift). Werden Schecks oder Lastschriften nicht eingelöst oder geht der DKB der Gegenwert nicht zu, so macht sie die',
         'Gutschrift gemäß Nr. 23 der AGB rückgängig (Stornobuchung), und zwar auch nach einem zwischenzeitlich erfolgten',
         'Rechnungsabschluss.'],
        ['Guthaben sind als Einlagen nach Maßgabe des Einlagensicherungsgesetzes entschädigungsfähig. Nähere Informationen: im',
         '"Informationsbogen für Einleger" sowie auf unserer Webseite unter dkb.de/kundenservice/einlagensicherung.'],
    ]
    y = 530
    for lines in bullets:
        d.tp(170, y, '•', 8.5)
        for ln in lines:
            d.fit(189, y, ln, 8.6, maxpx=1160)
            y += 19.3
    dkb_footer(d)
    tx = [{'bookingDate': iso(t['date']), 'amount': t['amount'] if t['side'] == 'H' else -t['amount'],
           'bookingText': t['kind'], 'counterparty': t['counterparty']} for t in T]
    d.save({
        'source': 'd8', 'type': 'kontoauszug', 'format': 'pdf_statement', 'institution': 'DKB',
        'date': '2026-03-04', 'period': {'from': '2026-02-05', 'to': '2026-03-04'}, 'statementNo': '3/2026',
        'accounts': [{'name': 'Girokonto', 'kind': 'giro', 'iban': DKB_RAW, 'opening': opening, 'closing': closing,
                      'openingDate': '2026-02-04', 'closingDate': '2026-03-04',
                      'count': 54, 'debitCount': 51, 'creditCount': 3, 'debitSum': debit, 'creditSum': credit,
                      'transactions': tx}],
        'expectedCount': 54, 'overdraft': 150000,
    })


# ------------------------------------------------------------------ Varianten (Formulierungen aus anderen Abrechnungen)

def make_wertpapierkauf_alt():
    """Älteres comdirect-Layout: „ABRECHNUNG VOM“, „Börsenplatz“, Teilausführung, „Zu Ihren Lasten“ ohne „vor Steuern“."""
    d = Doc('comdirect_wertpapierkauf_alt', 'Wertpapierabrechnung', 'comdirect bank AG')
    cd_trade_header(d, intro_new=False)
    parts = [('91 228014', 20), ('91 228015', 30)]
    price = 4812
    kw = [q * price for _, q in parts]
    total_kw = sum(kw)
    prov, boerse = 990, 150
    total = total_kw + prov + boerse
    m = Mono(d, 155, 9.9, 14.1)
    m.line(693, 'ABRECHNUNG VOM 12.03.2025', bold=True)
    m.line(735, 'Wertpapierkauf')
    m.line(756, cols((0, 'Geschäftsnummer', 'l'), (18, ': 91 228014 bis 91 228015', 'l')))
    m.line(778, cols((20, '000318840215', 'l'), (38, 'Rechnungsnummer', 'l'), (56, ': 562019937408DB51', 'l')))
    m.line(799, cols((0, 'Geschäftstag', 'l'), (18, ': 12.03.2025', 'l'), (38, 'Börsenplatz', 'l'), (56, ': XETRA', 'l')))
    m.line(864, cols((0, 'Wertpapier-Bezeichnung', 'l'), (69, 'WPKNR/ISIN', 'l')))
    m.line(885, cols((0, 'Deutsche Post AG', 'l'), (78, '555200', 'r')))
    m.line(906, cols((0, 'Namens-Aktien o.N.', 'l'), (78, 'DE0005552004', 'r')))
    m.line(949, 'Ihre Order wurde wie folgt ausgeführt:')
    m.line(992, cols((0, 'Geschäftsnr.', 'l'), (14, 'Nennwert', 'l'), (38, 'Zum Kurs von', 'l'), (71, 'Kurswert', 'l')))
    for i, ((nr, q), v) in enumerate(zip(parts, kw)):
        m.line(1013 + i * 21.5, cols((1, nr, 'l'), (14, 'St.', 'l'), (21, str(q), 'r'), (38, 'EUR', 'l'),
                                     (47, de(price), 'r'), (56, 'EUR', 'l'), (75, de(v), 'r')))
    m.line(1056, '-' * 80)
    m.line(1077, 'Zusammenfassung (ggf. gerundet)')
    m.line(1098, cols((14, 'St.', 'l'), (21, str(sum(q for _, q in parts)), 'r'), (38, 'EUR', 'l'), (47, de(price), 'r')))
    for i, (lab, v) in enumerate([('Gesamtkurswert', total_kw), ('Gesamtprovision', prov), ('Börsenplatzabhäng. Entgelt', boerse)]):
        m.line(1141 + i * 21.5, cols((26, lab, 'l'), (54, ':', 'l'), (56, 'EUR', 'l'), (75, de(v), 'r')))
    m.line(1249, cols((0, 'Verrechnung über Konto', 'l'), (31, 'Valuta', 'l'), (56, 'Zu Ihren Lasten', 'l')))
    m.line(1270, cols((4, CD_GIRO_RAW[12:19] + ' ' + CD_GIRO_RAW[19:], 'l'), (16, 'EUR', 'l'), (31, '14.03.2025', 'l'),
                      (56, 'EUR', 'l'), (75, de(total), 'r')))
    m.line(1313, 'Verwahrungs-Art: GIROSAMMELDEPOT')
    m.line(1335, 'Teilausführung Ihrer Order')
    m.line(1399, 'comdirect bank AG')
    m.line(1463, 'Diese Abrechnung wird von der Bank nicht unterschrieben')
    m.line(1485, 'Die Leistung ist gemäß §4 Nr.8 UStG umsatzsteuerfrei. USt-Id-Nr.: DE 812 279 461')
    m.line(1528, 'Kapitalerträge sind einkommensteuerpflichtig.')
    d.save({
        'variant': True, 'type': 'wertpapier', 'subtype': 'kauf', 'institution': 'comdirect', 'amount': -total,
        'date': '2025-03-12', 'valuta': '2025-03-14', 'title': f'Wertpapierkauf Deutsche Post AG {de(total)} €',
        'fields': {'security': 'Deutsche Post AG', 'wkn': '555200', 'isin': 'DE0005552004', 'quantity': 50,
                   'price': price, 'venue': 'XETRA', 'marketValue': total_kw, 'fees': prov + boerse,
                   'valuta': '2025-03-14', 'partialFills': [{'nr': n, 'quantity': q} for n, q in parts]},
        'phrases': ['ABRECHNUNG VOM', 'Börsenplatz', 'Zu Ihren Lasten (ohne „vor Steuern“)', 'Verrechnung über Konto',
                    'Gesamtkurswert', 'Gesamtprovision', 'Teilausführung', 'Geschäftsnummer … bis …'],
    })


def make_wertpapierverkauf():
    """Neues Layout, Verkauf: „Zum Preis von“, Entgelte mit nachgestelltem Minus, „Zu Ihren Gunsten vor Steuern“, Steuerseite."""
    d = Doc('comdirect_wertpapierverkauf', 'Wertpapierabrechnung', 'comdirect')
    cd_trade_header(d)
    qty, price = 12, 18735
    kurswert = qty * price
    fees = [('Abwickl.entgelt Clearstream', 290), ('Provision', 1052)]
    fee_sum = sum(v for _, v in fees)
    gunsten = kurswert - fee_sum
    name1, name2, wkn, isin_ = 'Siemens AG', 'Namens-Aktien o.N.', '723610', 'DE0007236101'
    d.tp(155, 693, 'GESCHÄFTSABRECHNUNG VOM 08.06.2026', 11, 'Helvetica-Bold')
    d.tp(80, 727, '*', 11, COUR)
    m = Mono(d, 155, 9.9, 14.1)
    m.line(745, 'Wertpapierverkauf', bold=True)
    m.line(766, cols((0, 'Geschäftsnummer', 'l'), (18, ': 92 377105', 'l')))
    m.line(788, cols((0, 'Ordernummer', 'l'), (18, ': 000672214930-001', 'l'), (38, 'Rechnungsnummer', 'l'),
                     (56, ': 771093364458D1C9', 'l')))
    m.line(809, cols((0, 'Geschäftstag', 'l'), (18, ': 08.06.2026', 'l'), (38, 'Abwicklung', 'l'), (56, ': Live Trading', 'l')))
    m.line(831, cols((0, 'Handelszeit', 'l'), (18, ': 15:31 Uhr (MEZ/MESZ)', 'l')))
    m.line(874, cols((0, 'Wertpapier-Bezeichnung', 'l'), (80, 'WPKNR/ISIN', 'r')), bold=True)
    m.line(895, cols((0, name1, 'l'), (80, wkn, 'r')))
    m.line(916, cols((0, name2, 'l'), (80, isin_, 'r')))
    m.line(981, cols((0, 'Nennwert', 'l'), (26, 'Zum Preis von', 'l')), bold=True)
    m.line(1002, cols((0, 'St.', 'l'), (8, str(qty), 'r'), (26, 'EUR', 'l'), (37, de(price), 'r')))
    m.line(1024, cols((26, 'Kurswert', 'l'), (55, ':', 'l'), (57, 'EUR', 'l'), (80, de(kurswert), 'r')))
    m.line(1063, ' -' * 40)
    m.line(1088, 'Eigene Entgelte')
    for i, (lab, v) in enumerate(fees + [('Summe Entgelte', fee_sum)]):
        m.line(1109 + i * 21.5, cols((26, lab, 'l'), (55, ':', 'l'), (57, 'EUR', 'l'), (80, de(v), 'r'), (81, '-', 'l')))
    m.line(1174, ' -' * 40)
    m.line(1238, cols((0, 'IBAN', 'l'), (38, 'Valuta', 'l'), (81, 'Zu Ihren Gunsten vor Steuern', 'r')), bold=True)
    m.line(1259, cols((0, CD_GIRO_IBAN, 'l'), (30, 'EUR', 'l'), (38, '10.06.2026', 'l'), (57, 'EUR', 'l'),
                      (80, de(gunsten), 'r')))
    m.line(1302, 'Verwahrungs-Art: GIROSAMMELDEPOT')
    m.line(1324, 'Ihre Wertpapier-Order wurde über das Online Banking erteilt.')
    m.line(1388, 'Informationen zur steuerlichen Behandlung dieses Geschäftsvorgangs und den auf')
    m.line(1409, 'Ihrem Konto gebuchten Endbetrag finden Sie auf der separaten Steuermitteilung.')
    m.line(1473, 'Bei Fragen geben Sie bitte die Ordernummer an.')
    d.tp(155, 1515, 'Ihre comdirect', 11, 'Helvetica-Bold')
    d.tp(155, 1557, 'Diese Abrechnung wird von der Bank nicht unterschrieben', 11)
    m.line(1579, 'Die Leistung ist gemäß §4 Nr.8 UStG umsatzsteuerfrei. USt-Id-Nr.: DE 114 103 514')
    d.page()
    basis = 31240
    kest = cents(Decimal(basis) / 100 * Decimal('0.25'))
    soli = cents(Decimal(kest) / 100 * Decimal('0.055'))
    nach = cd_tax_page(d, '92 377105', '08.06.2026', qty, f'{name1} {name2}', wkn, isin_, gunsten, basis, kest, soli, 0,
                       '10.06.2026', gunsten=True)
    d.save({
        'variant': True, 'type': 'wertpapier', 'subtype': 'verkauf', 'institution': 'comdirect', 'amount': nach,
        'amountBeforeTax': gunsten, 'date': '2026-06-08', 'valuta': '2026-06-10',
        'title': f'Wertpapierverkauf {name1} {de(nach)} €',
        'fields': {'security': name1, 'wkn': wkn, 'isin': isin_, 'quantity': qty, 'price': price, 'venue': None,
                   'marketValue': kurswert, 'fees': fee_sum, 'taxPaid': kest + soli, 'valuta': '2026-06-10'},
        'phrases': ['Wertpapierverkauf', 'Abwicklung : Live Trading (statt Ausführungsplatz)', 'Zum Preis von',
                    'Entgelte mit nachgestelltem Minus („2,90-“)', 'Zu Ihren Gunsten vor Steuern',
                    'Zu Ihren Gunsten nach Steuern', 'Die Gutschrift erfolgt mit Valuta'],
    })


def make_ertragsgutschrift():
    """Fonds-Ausschüttung: „Ertragsgutschrift“, „Ausschüttung pro Stück“, Überschrift gesperrt gesetzt."""
    d = Doc('comdirect_ertragsgutschrift', 'Ertragsgutschrift', 'comdirect')
    d.img(logo('comdirect'), 848 * 0.972, 30 * 0.972, 310 * 0.972)
    d.tp(890, 122, '25449 Quickborn', 8.5)
    m = Mono(d, 132, 8.7, 12.4)
    d.tp(825, 334, 'Depotnr.:', 8.7, COUR)
    d.tp(1046, 334, CD_DEPOT, 8.7, COUR)
    d.tp(825, 355, 'BLZ:', 8.7, COUR)
    d.tp(1046, 355, '200 411 33', 8.7, COUR)
    for i, ln in enumerate(KUNDE):
        d.tp(149, 391 + i * 25, ln, 9.5)
    d.tp(825, 554, '16.01.2026', 11)
    d.t(132 * PX, 660 * PX, 'Gutschrift fälliger Wertpapier-Erträge', 12, 'Helvetica-Bold', space=2.2)
    qty, per = Decimal('84.512'), Decimal('0.412300')
    brutto = cents(qty * per)
    rows = [
        'Ertragsgutschrift', '',
        cols((0, 'Depotbestand', 'l'), (38, 'Wertpapier-Bezeichnung', 'l'), (84, 'WKN/ISIN', 'r')),
        cols((0, 'per 13.01.2026', 'l'), (38, 'Nordlicht Dividenden-Fonds', 'l'), (84, 'A2NL7D', 'r')),
        cols((0, 'STK', 'l'), (23, dnum(qty, 3), 'r'), (38, 'Inhaber-Anteile A', 'l'), (84, isin('DE000A2NL7D'), 'r')),
        cols((38, 'Emissionsland: DEUTSCHLAND', 'l')),
        cols((0, 'EUR ' + dnum(per, 6), 'l'), (15, 'Ausschüttung pro Stück für Geschäftsjahr', 'l'),
             (60, '01.10.24 bis 30.09.25', 'l')),
        cols((0, 'zahlbar ab 16.01.2026', 'l')), '',
        cols((25, 'Abrechnung Ertragsgutschrift', 'l')), '',
        cols((0, 'Bruttobetrag:', 'l'), (34, 'EUR', 'l'), (56, de(brutto), 'r')),
        cols((0, 'Verrechnung über Konto (IBAN)', 'l'), (40, 'Valuta', 'l'), (81, 'Zu Ihren Gunsten vor Steuern', 'r')),
        cols((0, CD_GIRO_IBAN, 'l'), (30, 'EUR', 'l'), (40, '16.01.2026', 'l'), (59, 'EUR', 'l'), (81, de(brutto), 'r')), '',
        'Information zur steuerlichen Behandlung dieses Geschäftsvorganges und den auf',
        'Ihrem Konto gebuchten Endbetrag finden Sie auf der separaten Steuermitteilung',
        '(Referenz-Nr. 1SKH2A7N3WE00K9D).', '', 'Ihre comdirect',
    ]
    for i, s in enumerate(rows):
        if s:
            m.line(702 + i * 20.9, s, bold=i in (9, 13))
    d.tp(132, 1242, '*Diese Abrechnung wird von der Bank nicht unterschrieben', 11)
    d.save({
        'variant': True, 'type': 'wertpapier', 'subtype': 'dividende', 'institution': 'comdirect', 'amount': brutto,
        'date': '2026-01-16', 'valuta': '2026-01-16', 'title': f'Dividende Nordlicht Dividenden-Fonds {de(brutto)} €',
        'fields': {'security': 'Nordlicht Dividenden-Fonds', 'wkn': 'A2NL7D', 'isin': isin('DE000A2NL7D'),
                   'quantity': float(qty), 'currency': 'EUR', 'gross': brutto, 'withholdingTax': None,
                   'perShare': float(per), 'capitalIncome': True, 'valuta': '2026-01-16'},
        'taxRelevant': True,
        'phrases': ['Ertragsgutschrift', 'Ausschüttung pro Stück', 'Abrechnung Ertragsgutschrift',
                    'gesperrte Überschrift (Zeichenabstand) „G u t s c h r i f t …“', 'ohne Quellensteuer/Devisenkurs'],
    })


def make_dkb_alt():
    """Älteres DKB-Cash-Layout: „Bu.Tag Wert Wir haben für Sie gebucht Belastung in EUR Gutschrift in EUR“, Datum ohne Jahr,
    „ALTER/NEUER KONTOSTAND … H EUR“ (Kontostand auf Seite 2)."""
    d = Doc('dkb_kontoauszug_alt', 'Kontoauszug', 'DKB AG')
    opening = 123480
    T = [
        ('03.03.', '03.03.', 'Basislastschrift', ['STADTWERKE WEDEL GMBH', 'EREF+SW-2023-0303-4471 MREF+SWW00471',
                                                  'CRED+DE77ZZZ00000231187 SVWZ+Abschlag Strom 03/2023'], 8500, 'B'),
        ('06.03.', '06.03.', 'Kartenzahlung', ['REWE MARKT GMBH-ZW', 'SVWZ+2023-03-04T11.42 Debitk.0 2025-08'], 4237, 'B'),
        ('10.03.', '10.03.', 'Überweisung', ['Jan Beispiel', 'SVWZ+Sparen Tagesgeld DATUM 10.03.2023, 08.15 UHR1.TAN 271104'],
         20000, 'B'),
        ('15.03.', '15.03.', 'Zahlungseingang', ['TRADE REPUBLIC BANK GMBH', 'EREF+TRB-2023-0315-1 SVWZ+Auszahlung Depot'],
         15000, 'G'),
        ('28.03.', '28.03.', 'Dauerauftrag', ['Hausverwaltung Kranich', 'SVWZ+Miete April Lindenallee 12'], 95000, 'B'),
        ('30.03.', '30.03.', 'Lohn, Gehalt, Rente', ['Nordlicht Logistik GmbH', 'EREF+2023033000174456 SVWZ+LOHN/GEHALT 03/23',
                                                     'Verdienstabrechnung 03.23/1'], 312845, 'G'),
        ('31.03.', '31.03.', 'Abschluss', ['Abrechnung 31.03.2023', 'siehe Anlage'], 0, None),
    ]
    T = [t for t in T if t[5]]
    debit = sum(t[4] for t in T if t[5] == 'B')
    credit = sum(t[4] for t in T if t[5] == 'G')
    closing = opening - debit + credit
    d.img(logo('dkb'), 1150, 70, 160)
    d.tp(163, 300, 'Deutsche Kreditbank, Taubenstr. 7-9, 10117 Berlin', 6.5)
    for i, ln in enumerate(KUNDE[1:]):
        d.tp(163, 340 + i * 26, ln, 10)
    d.tp(900, 366, 'IHR DISPOKREDIT EUR 1.500,00', 9)
    d.tp(163, 520, 'DKB-Cash', 12, 'Helvetica-Bold')
    d.tp(163, 556, 'Kontoauszug Nummer 004 / 2023 vom 01.03.2023 bis 31.03.2023', 10)
    d.tp(163, 580, f'Kontonummer {DKB_RAW[12:]} / IBAN {DKB_IBAN}', 10)
    y = 640
    d.tp(163, y, 'Bu.Tag', 9, 'Helvetica-Bold')
    d.tp(240, y, 'Wert', 9, 'Helvetica-Bold')
    d.tp(320, y, 'Wir haben für Sie gebucht', 9, 'Helvetica-Bold')
    d.tp(1110, y, 'Belastung in EUR', 9, 'Helvetica-Bold', align='r')
    d.tp(1340, y, 'Gutschrift in EUR', 9, 'Helvetica-Bold', align='r')
    d.hline(163, 1345, y + 10, 0.6)
    y += 40
    for bt, wt, kind, lines, amt, side in T:
        d.tp(163, y, bt, 9.5)
        d.tp(240, y, wt, 9.5)
        d.tp(320, y, kind, 9.5)
        d.tp(1110 if side == 'B' else 1340, y, de(amt), 9.5, align='r')
        for k, ln in enumerate(lines):
            d.tp(320, y + 22 * (k + 1), ln, 9)
        y += 22 * (len(lines) + 1) + 12
    d.tp(163, 1880, 'DEUTSCHE KREDITBANK AG', 7.5)
    d.tp(163, 1900, 'TAUBENSTRASSE 7-9', 7.5)
    d.tp(163, 1920, '10117 BERLIN', 7.5)
    d.tp(700, 1880, f'IBAN: {DKB_RAW}', 7.5)
    d.tp(700, 1900, 'BIC: BYLADEM1001', 7.5)
    d.tp(700, 1920, 'USt-ID: DE137178746', 7.5)
    d.tp(1340, 1880, 'Seite 1 von 2', 7.5, align='r')
    d.page()
    d.img(logo('dkb'), 1150, 70, 160)
    d.tp(163, 300, 'Kontoauszug Nummer 004 / 2023 vom 01.03.2023 bis 31.03.2023', 10)
    d.tp(163, 324, f'Kontonummer {DKB_RAW[12:]} / IBAN {DKB_IBAN}', 10)
    d.tp(163, 390, 'ALTER KONTOSTAND', 10, 'Helvetica-Bold')
    d.tp(1250, 390, de(opening), 10, align='r')
    d.tp(1262, 390, 'H EUR', 10)
    d.tp(163, 420, 'NEUER KONTOSTAND', 10, 'Helvetica-Bold')
    d.tp(1250, 420, de(closing), 10, align='r')
    d.tp(1262, 420, 'H EUR', 10)
    for i, ln in enumerate(['Gemäß dem Finanzkonten-Informationsaustauschgesetz (FKAustG) ermittelt die DKB AG die nach diesem Gesetz',
                            'erforderlichen Daten zur steuerlichen Ansässigkeit und meldet diese, soweit aufgrund des Gesetzes',
                            'erforderlich, jährlich an das Bundeszentralamt für Steuern (BZSt).']):
        d.tp(163, 520 + i * 21, ln, 8.5)
    d.tp(163, 1880, 'DEUTSCHE KREDITBANK AG', 7.5)
    d.tp(163, 1900, 'TAUBENSTRASSE 7-9', 7.5)
    d.tp(163, 1920, '10117 BERLIN', 7.5)
    d.tp(700, 1880, f'IBAN: {DKB_RAW}', 7.5)
    d.tp(700, 1900, 'BIC: BYLADEM1001', 7.5)
    d.tp(700, 1920, 'USt-ID: DE137178746', 7.5)
    d.tp(1340, 1880, 'Seite 2 von 2', 7.5, align='r')
    tx = [{'bookingDate': f'2023-{t[0][3:5]}-{t[0][0:2]}', 'valueDate': f'2023-{t[1][3:5]}-{t[1][0:2]}',
           'amount': t[4] if t[5] == 'G' else -t[4], 'bookingText': t[2]} for t in T]
    d.save({
        'variant': True, 'type': 'kontoauszug', 'format': 'pdf_statement', 'institution': 'DKB',
        'period': {'from': '2023-03-01', 'to': '2023-03-31'},
        'accounts': [{'name': 'DKB-Cash', 'kind': 'giro', 'iban': DKB_RAW, 'opening': opening, 'closing': closing,
                      'count': len(T), 'debitCount': sum(1 for t in T if t[5] == 'B'),
                      'creditCount': sum(1 for t in T if t[5] == 'G'), 'debitSum': debit, 'creditSum': credit,
                      'transactions': tx}],
        'phrases': ['Bu.Tag Wert Wir haben für Sie gebucht Belastung in EUR Gutschrift in EUR', 'Datum ohne Jahr (dd.mm.)',
                    'ALTER KONTOSTAND … H EUR / NEUER KONTOSTAND … H EUR (erst auf Seite 2)',
                    'Kontoauszug Nummer 004 / 2023 vom … bis …', 'SVWZ+/EREF+/MREF+/CRED+-Tags'],
    })


def main():
    make_wertpapierkauf()
    make_dividende()
    make_kosteninfo('comdirect_kosteninfo_kauf', 'gettex')
    make_kosteninfo('comdirect_kosteninfo_kauf_spesen', 'spesen')
    make_finanzreport()
    make_mlp()
    make_dkb()
    make_wertpapierkauf_alt()
    make_wertpapierverkauf()
    make_ertragsgutschrift()
    make_dkb_alt()
    meta = {
        '_info': 'Sollwerte der originalnahen Test-PDFs (erzeugt von scripts/make-real-like-pdfs.py). Beträge in Cent, '
                 'Datum ISO. Personen, Konten und Nummern sind erfunden.',
    }
    with open(os.path.join(OUT, 'EXPECTED.json'), 'w', encoding='utf-8') as fh:
        json.dump({**meta, **EXPECTED}, fh, ensure_ascii=False, indent=1)
        fh.write('\n')


if __name__ == '__main__':
    main()
