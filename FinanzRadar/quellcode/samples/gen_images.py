"""Image samples (PIL): receipts, optician invoice scan, irrelevant photo.

Every image carries a diagonal "MUSTER – Testdokument" watermark.
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from gen_model import EDEKA_TOTAL, OPTIK_GROSS, REWE_TOTAL, SEED, fmt_de, prop

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
WATERMARK = "MUSTER – Testdokument"
WIDTH = 600

REWE_ITEMS = [
    ("Vollmilch 1,5% 1L", 109, "A"), ("Vollkornbrot", 249, "A"), ("Bio Äpfel 1kg", 299, "A"),
    ("Gouda jung 150g", 219, "A"), ("Bananen 1kg", 179, "A"), ("Kaffee gemahlen 500g", 649, "A"),
    ("Waschmittel 40WL", 1199, "B"), ("Zahnpasta 75ml", 219, "B"), ("Spülmittel", 139, "B"),
    ("Lachsfilet 200g", 1899, "A"), ("Sahne 250g", 189, "A"), ("Müsli 750g", 749, "B"),
]
EDEKA_ITEMS = [
    ("Haferdrink 1L", 129, "A"), ("Eier Bodenhaltung 10er", 289, "A"), ("Toastbrot", 159, "A"),
    ("Parmesan 200g", 349, "A"), ("Tomaten 500g", 199, "A"), ("Olivenöl 500ml", 849, "B"),
    ("Nudeln Hartweizen 500g", 129, "A"), ("Geschirrspüler-Tabs", 1399, "B"), ("Cola 1,5L", 119, "B"),
    ("Hackfleisch gemischt 500g", 699, "A"), ("Kräuter Basilikum", 169, "A"),
]


def _tse(rng: random.Random) -> list[str]:
    sig = "".join(rng.choice("0123456789ABCDEF") for _ in range(64))
    return [
        "TSE-Transaktion: 000" + str(rng.randint(100, 999)),
        "Signaturzaehler: " + str(rng.randint(1000, 9999)),
        "TSE-Seriennr.: DEMO-TSE-0001",
        "TSE-Signatur:",
        sig[:32],
        sig[32:],
    ]


def _receipt_lines(store: str, address: str, items: list[tuple[str, int, str]],
                   total: int, date: str, time: str, bon: str, rng: random.Random) -> list[str]:
    assert sum(c for _, c, _ in items) == total, "items do not sum to total"
    gross = {"A": 0, "B": 0}
    for _, cents, code in items:
        gross[code] += cents
    tax = {"A": prop(gross["A"], 7, 107), "B": prop(gross["B"], 19, 119)}
    lines = [
        store,
        address,
        "USt-IdNr.: DE123456789",
        "-" * 46,
        f"Datum {date}   Zeit {time}",
        f"Kasse 04   Bon-Nr. {bon}",
        "-" * 46,
    ]
    for name, cents, code in items:
        lines.append(f"{name:<36}{fmt_de(cents):>8} {code}")
    lines += [
        "-" * 46,
        f"{'SUMME EUR':<36}{fmt_de(total):>9}",
        "-" * 46,
        f"{'Code':<6}{'Satz':>6}{'Netto':>11}{'MwSt':>10}{'Brutto':>11}",
    ]
    for code, rate in (("A", "7%"), ("B", "19%")):
        if gross[code]:
            netto = gross[code] - tax[code]
            lines.append(f"{code:<6}{rate:>6}{fmt_de(netto):>11}{fmt_de(tax[code]):>10}"
                         f"{fmt_de(gross[code]):>11}")
    lines += [
        "-" * 46,
        f"Kartenzahlung VISA            EUR {fmt_de(total)}",
        "",
    ]
    lines += _tse(rng)
    lines += ["", "Vielen Dank für Ihren Einkauf!", "Testbon – alle Angaben fiktiv"]
    return lines


def _render(lines: list[str]) -> Image.Image:
    font = ImageFont.truetype(MONO, 18)
    line_h = 24
    pad = 30
    height = pad * 2 + line_h * len(lines)
    img = Image.new("RGB", (WIDTH, height), "white")
    draw = ImageDraw.Draw(img)
    for i, text in enumerate(lines):
        draw.text((pad, pad + i * line_h), text, font=font, fill=(20, 20, 20))
    return img


def watermark(img: Image.Image) -> Image.Image:
    """Diagonal semi-transparent MUSTER watermark over the whole image."""
    base = img.convert("RGBA")
    size = max(26, base.width // 14)
    font = ImageFont.truetype(SANS_BOLD, size)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    tw = draw.textlength(WATERMARK, font=font)
    draw.text(((base.width - tw) / 2, (base.height - size) / 2), WATERMARK,
              font=font, fill=(110, 110, 110, 85))
    layer = layer.rotate(32, resample=Image.BICUBIC, expand=False)
    return Image.alpha_composite(base, layer).convert("RGB")


def _scan_effect(img: Image.Image, angle: float, rng: random.Random) -> Image.Image:
    """Slight rotation, faint noise and softening to look like a phone scan."""
    turned = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor="white")
    noise = Image.effect_noise(turned.size, 24).convert("RGB")
    blended = Image.blend(turned, noise, 0.05)
    return blended.filter(ImageFilter.GaussianBlur(0.35))


def rewe_receipt(path: Path) -> dict:
    rng = random.Random(SEED + 1)
    rest = REWE_TOTAL - sum(c for _, c, _ in REWE_ITEMS)
    items = REWE_ITEMS + [("Rinderhack 500g", rest, "A")]
    lines = _receipt_lines("REWE Markt Hamburg-Eimsbüttel", "Beispielweg 12, 20259 Hamburg",
                           items, REWE_TOTAL, "12.04.2026", "10:24", "0231", rng)
    img = watermark(_render(lines))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    return {"total": REWE_TOTAL, "items": len(items)}


def edeka_receipt(path: Path) -> dict:
    rng = random.Random(SEED + 2)
    rest = EDEKA_TOTAL - sum(c for _, c, _ in EDEKA_ITEMS)
    items = EDEKA_ITEMS + [("Bio Zitronen 3er", rest, "A")]
    lines = _receipt_lines("EDEKA Markt Eimsbüttel", "Fruchtallee 22, 20259 Hamburg",
                           items, EDEKA_TOTAL, "03.05.2026", "11:42", "0412", rng)
    img = _scan_effect(watermark(_render(lines)), 1.6, rng)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=82)
    return {"total": EDEKA_TOTAL, "items": len(items)}


def optiker_scan(path: Path) -> dict:
    """Image-only invoice (no text layer) for OCR tests."""
    net = round(OPTIK_GROSS / 1.19)
    mwst = OPTIK_GROSS - net
    rows = [
        ("Rechnung Nr. OPT-2026-0327", ""),
        ("Datum 27.03.2026", ""),
        ("Kunde: Max Mustermann, Musterstraße 1, 20095 Hamburg", ""),
        ("", ""),
        ("Gleitsichtgläser Index 1.6, entspiegelt", fmt_de(21000)),
        ("Fassung Metall, Pos. 2", fmt_de(8200)),
        ("Etui und Pflegetuch, Pos. 3", fmt_de(net - 21000 - 8200)),
        ("", ""),
        ("Nettobetrag", fmt_de(net)),
        ("19 % Umsatzsteuer", fmt_de(mwst)),
        ("Rechnungsbetrag brutto", fmt_de(OPTIK_GROSS) + " EUR"),
        ("", ""),
        ("Zahlbar sofort per Kartenzahlung. Optik Muster GmbH (Testdaten)", ""),
    ]
    width, line_h = 1000, 44
    img = Image.new("RGB", (width, 120 + line_h * len(rows)), "white")
    draw = ImageDraw.Draw(img)
    title = ImageFont.truetype(SANS_BOLD, 36)
    body = ImageFont.truetype(SANS, 26)
    draw.text((60, 40), "Optik Muster GmbH – Rechnung", font=title, fill=(10, 10, 10))
    for i, (left, right) in enumerate(rows):
        y = 120 + i * line_h
        draw.text((60, y), left, font=body, fill=(30, 30, 30))
        if right:
            rw = draw.textlength(right, font=body)
            draw.text((width - 60 - rw, y), right, font=body, fill=(30, 30, 30))
    img = _scan_effect(watermark(img), -1.0, random.Random(SEED + 3))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")
    return {"gross": OPTIK_GROSS, "net": net, "mwst": mwst}


def irrelevant_photo(path: Path) -> dict:
    """Colored gradient, no finance content. Must be ignored by the parser."""
    w, h = 800, 600
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (255 - x * 255 // w, 120 + y * 100 // h, 200 - y * 120 // h)
    img = watermark(img)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "JPEG", quality=85)
    return {"size": [w, h]}
