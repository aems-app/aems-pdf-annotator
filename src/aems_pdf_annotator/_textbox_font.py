"""Embed a single sans face when Helvetica needs fallback glyphs."""

import re
from collections.abc import Callable
from functools import cache
from pathlib import Path
from typing import Any

from aems_pdf_annotator._fitz import fitz


@cache
def textbox_fonts() -> tuple[fitz.Font, fitz.Font]:
    """Load the built-in Helvetica face and the packaged notation font."""
    path = Path(__file__).with_name("fonts") / "DejaVuSans.ttf"
    return fitz.Font("helv"), fitz.Font(fontbuffer=path.read_bytes())


class _PositionedSansText(fitz.mupdf.FzDevice2):
    """Read MuPDF's native baselines, advances, and line breaks from the form."""

    def __init__(self, font: fitz.Font, text: str) -> None:
        super().__init__()
        self.use_virtual_fill_text()
        self.font = font
        self.remaining = (ord(char) for char in text if not char.isspace())
        self.commands: list[str] = []
        self.unsupported = False

    def fill_text(self, ctx: Any, text: Any, ctm: Any, *args: Any) -> None:
        span = text.head
        while span:
            wrapped = fitz.mupdf.FzTextSpan(span)
            matrix = span.trm
            for index in range(span.len):
                item = wrapped.items(index)
                codepoint = item.ucs
                # Older MuPDF plain FreeText uses a middle dot for missing
                # characters. Recover it only if the paint order matches Contents.
                if codepoint < 0:
                    self.unsupported = True
                    return
                if not chr(codepoint).isspace():
                    expected = next(self.remaining, None)
                    if expected is None or (codepoint != expected and codepoint != 0xB7):
                        self.unsupported = True
                        return
                    codepoint = expected
                glyph = self.font.has_glyph(codepoint)
                if not glyph:
                    self.unsupported = True
                    return
                advance = self.font.glyph_advance(codepoint)
                # Keep the original advance so wider letters cannot overlap
                # their neighbours. Zero-width combining marks retain their width.
                scale = min(1.0, item.adv / advance) if item.adv > 0 and advance > 0 else 1.0
                # PDF numbers use decimal notation, even near zero after rotation.
                operands = (matrix.a * scale, matrix.b * scale, matrix.c, matrix.d, item.x, item.y)
                position = " ".join(f"{value:.8f}".rstrip("0").rstrip(".") for value in operands)
                self.commands.append(f"{position} Tm <{glyph:04x}> Tj")
            span = span.next


def textbox_sans_font_xref(doc: fitz.Document, font: fitz.Font) -> int:
    """Reuse a complete Identity-H font with the packaged font's glyph IDs."""
    for xref in range(1, doc.xref_length()):
        if doc.xref_get_key(xref, "BaseFont") != ("name", "/" + font.name):
            continue
        if doc.xref_get_key(xref, "Encoding") != ("name", "/Identity-H"):
            continue
        children = doc.xref_get_key(xref, "DescendantFonts")[1]
        child = re.fullmatch(r"\[\s*(\d+)\s+\d+\s+R\s*\]", children)
        if child is None:
            continue
        glyph_map = doc.xref_get_key(int(child[1]), "CIDToGIDMap")
        if glyph_map not in (("null", "null"), ("name", "/Identity")):
            continue
        if doc.extract_font(xref)[3] == font.buffer:
            return xref
    return fitz.mupdf.pdf_add_cid_font(fitz._as_pdf_document(doc), font.this).pdf_to_num()


def embed_textbox_sans(
    annot: fitz.Annot,
    text: str,
    font_xref: Callable[[fitz.Font], int] | None = None,
) -> None:
    """Replace only text glyphs in a native Helvetica FreeText appearance."""
    codepoints = {ord(char) for char in text if not char.isspace()}
    helvetica, font = textbox_fonts()
    # FreeText's native encoder can substitute a dot for a glyph in the font's cmap.
    if all(helvetica.has_glyph(codepoint) for codepoint in codepoints) and (
        "".join(annot.get_text().split()) == "".join(text.split())
    ):
        return
    if not all(font.has_glyph(codepoint) for codepoint in codepoints):
        return
    doc = annot.parent.parent
    kind, reference = doc.xref_get_key(annot.xref, "AP/N")
    if kind != "xref" or doc.xref_get_key(annot.xref, "RC")[0] != "null":
        return
    xref = int(reference.split()[0])
    stream = doc.xref_stream(xref)
    if not stream:
        return
    before, begin, body = stream.partition(b"BT\n")
    _, end, after = body.partition(b"ET\n")
    if not (begin and end) or b"BT\n" in after or b"/AEMSSans " in body:
        return

    native = fitz.mupdf
    device = _PositionedSansText(font, text)
    native.pdf_run_annot(annot.this, device, native.FzMatrix(), native.FzCookie())
    if device.unsupported or not device.commands or next(device.remaining, None) is not None:
        return
    font_ref = textbox_sans_font_xref(doc, font) if font_xref is None else font_xref(font)
    replacement = ("BT\n/AEMSSans 1 Tf\n" + "\n".join(device.commands) + "\nET\n").encode("ascii")
    original_fonts = doc.xref_get_key(xref, "Resources/Font")[1]
    try:
        doc.xref_set_key(xref, "Resources/Font", f"<< /AEMSSans {font_ref} 0 R >>")
        doc.update_stream(xref, before + replacement + after)
    except Exception:
        doc.xref_set_key(xref, "Resources/Font", original_fonts)
        if doc.xref_stream(xref) != stream:
            doc.update_stream(xref, stream)
        raise
