"""Teacher notation must survive the native FreeText appearance writer."""

import json
import re
from pathlib import Path
from unicodedata import name

import pytest

from aems_pdf_annotator import AnnotationColor, AnnotationType, BBox, PDFAnnotation, PDFAnnotator
from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator._textbox_font import embed_textbox_sans
from aems_pdf_annotator.core import _add_fitted_textbox

UI_DIRECTORY = Path(__file__).resolve().parents[1] / "web" / "annotator-ui"


def _picker_entries() -> list[tuple[str, str, str]]:
    source = (UI_DIRECTORY / "src/pdf-preview-modal/comment-symbols.js").read_text(encoding="utf-8")
    declaration = source.split("const commentSymbolGroups = ", 1)[1]
    groups, _ = json.JSONDecoder().raw_decode(declaration)
    return [
        (shortcut, glyph, attributes[0] if attributes else shortcut)
        for _, entries in groups
        for shortcut, glyph, *attributes in entries
    ]


def test_teacher_symbols_paint_and_extract(tmp_path: Path) -> None:
    source = tmp_path / "blank.pdf"
    saved = tmp_path / "teacher-symbols.pdf"
    glyphs = [glyph for _, glyph, _ in _picker_entries()]
    rows = [" ".join(glyphs[offset : offset + 24]) for offset in range(0, len(glyphs), 24)]
    text = "Sträckgräns, höjd och ångström. Ä Ö Å\n" + "\n".join(rows)
    with fitz.open() as document:
        document.new_page(width=420, height=125)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(
            PDFAnnotation(
                id="teacher-symbols",
                page_index=0,
                kind=AnnotationType.TEXTBOX,
                color=AnnotationColor.RED,
                source="HUMAN",
                comment=text,
                grader_name="fixture-teacher",
                bbox=BBox(x0=20, y0=20, x1=400, y1=105),
            )
        )
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == text
        assert annotation.get_text().split() == text.split()
        page.get_pixmap(matrix=fitz.Matrix(3, 3)).save(tmp_path / "teacher-symbols.png")
        document.bake(annots=True, widgets=False)
        spans = document[0].get_texttrace()
        assert {span["font"] for span in spans} == {"DejaVuSans"}
        # A ToUnicode map can extract correctly even while a font paints .notdef.
        painted = {
            chr(codepoint)
            for span in spans
            for codepoint, glyph_id, *_ in span["chars"]
            if glyph_id > 0
        }
        assert set("".join(text.split())) <= painted


def test_picker_shortcuts_and_labels_match_unicode_names() -> None:
    greek = (
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi "
        "omicron pi rho sigma tau upsilon phi chi psi omega"
    ).split()
    capitals = "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split()
    unicode_names = {"lambda": "LAMDA"}
    expected = {
        shortcut: (
            shortcut,
            "GREEK SMALL LETTER " + unicode_names.get(shortcut, shortcut.upper()),
        )
        for shortcut in greek
    }
    expected.update(
        {
            shortcut: (
                "upsilon" if shortcut == "Upsilon" else shortcut,
                "GREEK CAPITAL LETTER " + unicode_names.get(shortcut.lower(), shortcut.upper()),
            )
            for shortcut in capitals
        }
    )
    # LaTeX uses the Unicode symbol form for \phi, and the letter for \varphi.
    expected.update(
        {
            "phi": ("phi", "GREEK PHI SYMBOL"),
            "varphi": ("variant phi", "GREEK SMALL LETTER PHI"),
            "vartheta": ("variant theta", "GREEK THETA SYMBOL"),
            "pm": ("plus-minus", "PLUS-MINUS SIGN"),
            "times": ("multiplication", "MULTIPLICATION SIGN"),
            "cdot": ("middle dot", "MIDDLE DOT"),
            "div": ("division", "DIVISION SIGN"),
            "deg": ("degree", "DEGREE SIGN"),
            "approx": ("approximately equal", "ALMOST EQUAL TO"),
            "ne": ("not equal", "NOT EQUAL TO"),
            "le": ("less than or equal", "LESS-THAN OR EQUAL TO"),
            "ge": ("greater than or equal", "GREATER-THAN OR EQUAL TO"),
            "inf": ("infinity", "INFINITY"),
            "sqrt": ("square root", "SQUARE ROOT"),
            "partial": ("partial derivative", "PARTIAL DIFFERENTIAL"),
            "nabla": ("nabla", "NABLA"),
            "sum": ("summation", "N-ARY SUMMATION"),
            "int": ("integral", "INTEGRAL"),
            "to": ("right arrow", "RIGHTWARDS ARROW"),
            "implies": ("implies", "RIGHTWARDS DOUBLE ARROW"),
            "propto": ("proportional to", "PROPORTIONAL TO"),
            "prime": ("prime", "PRIME"),
            "dprime": ("double prime", "DOUBLE PRIME"),
            "sup2": ("superscript two", "SUPERSCRIPT TWO"),
            "sup3": ("superscript three", "SUPERSCRIPT THREE"),
            "inv": ("superscript minus one", "SUPERSCRIPT MINUS, SUPERSCRIPT ONE"),
            "sub0": ("subscript zero", "SUBSCRIPT ZERO"),
            "sub1": ("subscript one", "SUBSCRIPT ONE"),
            "sub2": ("subscript two", "SUBSCRIPT TWO"),
            "subx": ("subscript x", "LATIN SUBSCRIPT SMALL LETTER X"),
        }
    )
    entries = _picker_entries()
    assert len(entries) == len(expected)
    actual = {
        shortcut: (label, ", ".join(name(character) for character in glyph))
        for shortcut, glyph, label in entries
    }
    assert actual == expected


def test_each_teacher_symbol_paints_in_isolation(tmp_path: Path) -> None:
    source = tmp_path / "individual-source.pdf"
    saved = tmp_path / "individual-symbols.pdf"
    entries = [(shortcut, f"Höjd {glyph}") for shortcut, glyph, _ in _picker_entries()]
    with fitz.open() as document:
        page = document.new_page(width=600, height=800)
        for index, (_, text) in enumerate(entries):
            left = 8 + (index % 5) * 115
            top = 8 + (index // 5) * 56
            page.add_freetext_annot(fitz.Rect(left, top, left + 98, top + 48), text)
        document.save(source)
    with PDFAnnotator(source) as writer:
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        for (shortcut, text), annotation in zip(entries, page.annots(), strict=True):
            assert annotation.get_text().strip() == text, shortcut
            fonts = {
                span["font"]
                for block in annotation.get_text("dict")["blocks"]
                for line in block.get("lines", ())
                for span in line["spans"]
            }
            assert len(fonts) == 1, (shortcut, fonts)


def test_tight_rotated_notation_uses_pdf_decimal_operands(tmp_path: Path) -> None:
    source = tmp_path / "native.pdf"
    saved = tmp_path / "rotated.pdf"
    text = "Åtgärd: ε₀ ≤ Δx₁"
    with fitz.open() as document:
        page = document.new_page(width=250, height=250)
        _add_fitted_textbox(page, fitz.Rect(25, 90, 75, 104), text, (0, 0, 0), 90)
        document.save(source)
    with PDFAnnotator(source) as writer:
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        xref = int(document.xref_get_key(annotation.xref, "AP/N")[1].split()[0])
        appearance = document.xref_stream(xref)
        assert b"/AEMSSans 1 Tf" in appearance
        for line in appearance.splitlines():
            if b" Tm " in line:
                operands = line.split(b" Tm ", 1)[0]
                assert not re.search(rb"[eE]", operands), operands
        assert "".join(annotation.get_text().split()) == "".join(text.split())


def test_edit_and_move_keep_the_single_symbol_font(tmp_path: Path) -> None:
    source = tmp_path / "blank.pdf"
    first_save = tmp_path / "first-save.pdf"
    edited = tmp_path / "edited.pdf"
    rect = BBox(x0=30, y0=30, x1=270, y1=90)
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=130)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(
            PDFAnnotation(
                id="notation",
                page_index=0,
                kind=AnnotationType.TEXTBOX,
                color=AnnotationColor.RED,
                source="HUMAN",
                comment="Höjd Δx₀",
                grader_name="fixture-teacher",
                bbox=rect,
            )
        )
        writer.save(first_save)
    with PDFAnnotator(first_save) as writer:
        assert writer.update_annotation("notation", new_page_index=1, new_content="Höjd Δx₁")
        writer.save(edited)
    with PDFAnnotator(edited) as writer:
        # A second save without an edit must retain the already-embedded font.
        writer.save()
    with fitz.open(edited) as document:
        page = document[1]
        annotation = next(page.annots())
        assert tuple(annotation.rect) == rect.to_rect()
        assert annotation.info["content"] == "Höjd Δx₁"
        assert annotation.get_text().strip() == "Höjd Δx₁"
        document.bake(annots=True, widgets=False)
        assert {span["font"] for span in document[1].get_texttrace()} == {"DejaVuSans"}


@pytest.mark.parametrize(
    "alteration",
    [
        "unsupported script",
        "missing form",
        "no stream",
        "rich text",
        "no text",
        "incomplete text stream",
        "multiple text objects",
        "inconsistent content",
        "extra painted text",
        "missing painted text",
        "no painted text",
    ],
)
def test_unrecognized_textbox_appearance_is_left_intact(alteration: str) -> None:
    with fitz.open() as document:
        page = document.new_page()
        painted = "α₁x" if alteration == "extra painted text" else "α₁"
        annotation = page.add_freetext_annot(fitz.Rect(40, 40, 200, 140), painted)
        normal = document.xref_get_key(annotation.xref, "AP/N")[1]
        xref = int(normal.split()[0])
        stream = document.xref_stream(xref)
        text = "α₁"
        if alteration == "unsupported script":
            text = "α₁ 中文"
        elif alteration == "missing form":
            document.xref_set_key(annotation.xref, "AP/N", "null")
        elif alteration == "no stream":
            document.xref_set_key(annotation.xref, "AP/N", f"{annotation.xref} 0 R")
        elif alteration == "rich text":
            document.xref_set_key(annotation.xref, "RC", "(external author HTML)")
        elif alteration == "no text":
            document.update_stream(xref, b"q Q")
        elif alteration == "incomplete text stream":
            document.update_stream(xref, b"BT\n")
        elif alteration == "multiple text objects":
            document.update_stream(xref, stream + b"BT\nET\n")
        elif alteration == "inconsistent content":
            text = "β₁"
        elif alteration == "extra painted text":
            pass  # Contents has fewer characters than the original appearance.
        elif alteration == "missing painted text":
            text = "α₁₁"
        else:
            document.update_stream(xref, b"BT\nET\n")
        before = document.xref_stream(xref)
        embed_textbox_sans(annotation, text)
        assert document.xref_stream(xref) == before
        assert document.xref_get_key(xref, "Resources/Font/AEMSSans")[0] == "null"
