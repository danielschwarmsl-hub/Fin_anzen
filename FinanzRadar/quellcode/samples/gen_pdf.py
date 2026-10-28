"""reportlab helpers shared by all PDF samples.

Every page carries a diagonal "MUSTER – Testdokument" watermark. Bank names
appear only as plain header text, never as logos.
"""
from __future__ import annotations

import io
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Flowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

WATERMARK = "MUSTER – Testdokument"
FOOTER = "MUSTER – Testdokument · Fiktive Daten: Namen, IBANs und Beträge sind erfunden."
WM_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
_WM_IMAGE = None

_ss = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=_ss["Heading1"], fontName="Helvetica-Bold",
                    fontSize=14, leading=18, spaceAfter=4)
H2 = ParagraphStyle("H2", parent=_ss["Heading2"], fontName="Helvetica-Bold",
                    fontSize=10.5, leading=14, spaceBefore=8, spaceAfter=3)
BODY = ParagraphStyle("Body", parent=_ss["BodyText"], fontName="Helvetica",
                      fontSize=9.5, leading=12.5)
CELL = ParagraphStyle("Cell", parent=BODY, fontSize=8.2, leading=10)
CELL_B = ParagraphStyle("CellB", parent=CELL, fontName="Helvetica-Bold")
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=7.5, leading=9.5,
                       textColor=colors.HexColor("#555555"))


def _watermark_image() -> ImageReader:
    """Diagonal watermark as a transparent PNG.

    Drawn as an image, not as text, so the page text layer stays clean for
    pdftotext and the parsers under test.
    """
    global _WM_IMAGE
    if _WM_IMAGE is None:
        from PIL import Image, ImageDraw, ImageFont
        size = (1400, 800)
        layer = Image.new("RGBA", size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        font = ImageFont.truetype(WM_FONT, 80)
        width = draw.textlength(WATERMARK, font=font)
        draw.text(((size[0] - width) / 2, size[1] / 2 - 60), WATERMARK, font=font,
                  fill=(110, 110, 110, 70))
        layer = layer.rotate(35, resample=Image.BICUBIC, expand=False)
        buf = io.BytesIO()
        layer.save(buf, "PNG")
        buf.seek(0)
        _WM_IMAGE = ImageReader(buf)
    return _WM_IMAGE


def _watermark(canvas, doc) -> None:
    canvas.saveState()
    width = A4[0] * 0.95
    height = width * 800 / 1400
    canvas.drawImage(_watermark_image(), (A4[0] - width) / 2, (A4[1] - height) / 2,
                     width=width, height=height, mask="auto")
    canvas.restoreState()
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(colors.HexColor("#777777"))
    canvas.drawString(20 * mm, 12 * mm, FOOTER)
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"Seite {doc.page}")
    canvas.restoreState()


def build_pdf(path, story: list, title: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=18 * mm, bottomMargin=20 * mm, title=title,
                            author="finanzradar test fixtures")
    doc.build(story, onFirstPage=_watermark, onLaterPages=_watermark)


def p(text: str, style: ParagraphStyle = BODY) -> Paragraph:
    """Paragraph with escaped text. Use <b>...</b> manually where needed."""
    return Paragraph(escape(text), style)


def cell(value, bold: bool = False) -> Paragraph:
    style = CELL_B if bold else CELL
    return Paragraph(escape(str(value)), style)


def multi(*lines: str) -> Paragraph:
    """Cell with several lines (line breaks via <br/>)."""
    return Paragraph("<br/>".join(escape(x) for x in lines), CELL)


def grid(rows: list[list], widths: list[float], right_cols: tuple[int, ...] = (),
         header: bool = True, bold_last: bool = False) -> Table:
    """Table with wrapped cells. rows[0] is the header row when header=True.

    Values may be plain strings or prebuilt Flowables (e.g. multi()).
    """
    data = []
    for r_i, row in enumerate(rows):
        bold = (header and r_i == 0) or (bold_last and r_i == len(rows) - 1)
        data.append([v if isinstance(v, Flowable) else cell(v, bold) for v in row])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
        ("LINEBELOW", (0, -1), (-1, -1), 0.4, colors.grey),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEEEEE")))
    for c in right_cols:
        style.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
    t.setStyle(TableStyle(style))
    return t


def kv(rows: list[tuple[str, str]], widths: tuple[float, float] = (55 * mm, 110 * mm)) -> Table:
    """Two-column label/value table without header."""
    data = [[cell(k, bold=True), cell(v)] for k, v in rows]
    t = Table(data, colWidths=list(widths))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def spacer(h: float = 4) -> Spacer:
    return Spacer(1, h * mm)


def address_block(lines: list[str]) -> list:
    out = [p(line) for line in lines]
    out.append(spacer(4))
    return out
