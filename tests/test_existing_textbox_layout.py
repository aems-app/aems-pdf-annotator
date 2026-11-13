"""O4: untouched legacy FreeText appearances must not stay clipped after saving."""

from pathlib import Path
import re

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata

TEXT = "This is a fully visible comment. FINALWORD"


def _without_font_size(value: str) -> str:
    return re.sub(r"[\d.]+\s+Tf", "SIZE Tf", value)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("rgb", [(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)])
def test_saving_an_untouched_legacy_textbox_paints_all_text_without_editing_its_evidence(
    tmp_path: Path,
    rotation: int,
    rgb: tuple[float, float, float],
) -> None:
    source = tmp_path / "untouched-legacy.pdf"
    destination = tmp_path / "normalized-legacy.pdf"
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        page.set_rotation(rotation)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 160, 72), TEXT, fontsize=11, text_color=rgb
        )
        annotation.set_info(
            subject=_encode_subject_metadata("untouched-explicit-id", "HUMAN"),
            title="Synthetic Reviewer",
            creationDate="D:20200102030405Z",
            modDate="D:20210102030405Z",
        )
        document.xref_set_key(
            annotation.xref, "NM", fitz.get_pdf_str("legacy-native-nm")
        )
        document.save(source)
    with fitz.open(source) as document:
        page = document[0]
        annotation = next(page.annots())
        before_info = annotation.info
        before_rect = tuple(annotation.rect)
        assert annotation.info["content"] == TEXT
        assert (
            "FINALWORD" not in annotation.get_text()
        ), "legacy red fixture did not reproduce clipping"
    with PDFAnnotator(source) as writer:
        writer.save(destination)
    with fitz.open(destination) as document:
        page = document[0]
        annotation = next(page.annots())
        assert (
            annotation.info == before_info
        ), "appearance normalization altered review evidence"
        assert tuple(annotation.rect) == pytest.approx(before_rect)
        assert "".join(annotation.get_text().split()) == "".join(
            TEXT.split()
        ), "untouched legacy textbox stays clipped in the saved PDF"
        expected_color = sum(
            round(component * 255) << shift for component, shift in zip(rgb, (16, 8, 0))
        )
        colors = {
            span["color"]
            for block in annotation.get_text("dict")["blocks"]
            for line in block.get("lines", [])
            for span in line["spans"]
        }
        assert colors == {expected_color}, "normalization changed the native ink colour"


@pytest.mark.parametrize(
    "font_name,appearance",
    [
        ("helv", "rgb"),
        ("cour", "rgb"),
        ("tiro", "rgb"),
        ("helv", "gray"),
        ("helv", "cmyk"),
        ("helv", "missing"),
    ],
)
def test_existing_reflow_preserves_font_and_native_default_appearance(
    tmp_path: Path,
    font_name: str,
    appearance: str,
) -> None:
    source = tmp_path / "legacy-font.pdf"
    destination = tmp_path / "legacy-font-fitted.pdf"
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 160, 72),
            TEXT,
            fontsize=11,
            fontname=font_name,
            text_color=(1.0, 0.0, 0.0) if appearance == "rgb" else (0.0, 0.0, 0.0),
        )
        annotation.set_info(
            title="Synthetic Reviewer",
            creationDate="D:20200102030405Z",
            modDate="D:20210102030405Z",
        )
        default_appearance = document.xref_get_key(annotation.xref, "DA")[1]
        resource = re.search(r"/(\S+)\s+[\d.]+\s+Tf", default_appearance).group(1)
        if appearance in ("gray", "cmyk"):
            operator = ".4 g" if appearance == "gray" else "0 1 1 0 k"
            document.xref_set_key(
                annotation.xref, "DA", fitz.get_pdf_str(f"/{resource} 11 Tf {operator}")
            )
        elif appearance == "missing":
            document.xref_set_key(annotation.xref, "DA", "null")
        document.save(source)
    with fitz.open(source) as document:
        page = document[0]
        annotation = next(page.annots())
        before_info = annotation.info
        before_rect = tuple(annotation.rect)
        before_da = document.xref_get_key(annotation.xref, "DA")[1]
        before_font = annotation.get_text("dict")["blocks"][0]["lines"][0]["spans"][0][
            "font"
        ]
        assert (
            "FINALWORD" not in annotation.get_text()
        ), "font fixture did not reproduce clipping"
    with PDFAnnotator(source) as writer:
        writer.save(destination)
    with fitz.open(destination) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info == before_info
        assert tuple(annotation.rect) == pytest.approx(before_rect)
        after_da = document.xref_get_key(annotation.xref, "DA")[1]
        if appearance != "missing":
            assert _without_font_size(after_da) == _without_font_size(
                before_da
            ), "reflow changed native DA font/color operators"
        spans = [
            span
            for block in annotation.get_text("dict")["blocks"]
            for line in block.get("lines", [])
            for span in line["spans"]
        ]
        assert {span["font"] for span in spans} == {
            before_font
        }, "reflow changed native font family"
        assert "".join(annotation.get_text().split()) == "".join(
            TEXT.split()
        ), "existing native-font box remains clipped"


@pytest.mark.parametrize("text", ["", "Already fitted FINALWORD"])
def test_already_complete_existing_appearance_is_untouched(
    tmp_path: Path, text: str
) -> None:
    source = tmp_path / "complete.pdf"
    destination = tmp_path / "complete-saved.pdf"
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 350, 150), text, fontsize=11
        )
        document.save(source)
    with fitz.open(source) as document:
        page = document[0]
        annotation = next(page.annots())
        before_info = annotation.info
        before_da = document.xref_get_key(annotation.xref, "DA")
        appearance_xref = int(
            document.xref_get_key(annotation.xref, "AP/N")[1].split()[0]
        )
        before_stream = document.xref_stream(appearance_xref)
        assert "".join(annotation.get_text().split()) == "".join(text.split())
    with PDFAnnotator(source) as writer:
        writer.save(destination)
    with fitz.open(destination) as document:
        page = document[0]
        annotation = next(page.annots())
        appearance_xref = int(
            document.xref_get_key(annotation.xref, "AP/N")[1].split()[0]
        )
        assert (
            document.xref_stream(appearance_xref) == before_stream
        ), "complete appearance was unnecessarily rewritten"
        assert annotation.info == before_info
        assert document.xref_get_key(annotation.xref, "DA") == before_da


def test_existing_complete_but_outside_page_textbox_is_clamped_without_losing_evidence(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legacy-offpage.pdf"
    destination = tmp_path / "legacy-offpage-fitted.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = page.add_freetext_annot(
            fitz.Rect(250, 350, 450, 500), TEXT, fontsize=11
        )
        document.save(source)
    with fitz.open(source) as document:
        page = document[0]
        annotation = next(page.annots())
        before_info = annotation.info
        assert (
            "FINALWORD" in annotation.get_text()
        ), "offpage fixture should have complete AP but clipped page ink"
        assert not page.rect.contains(annotation.rect)
    with PDFAnnotator(source) as writer:
        writer.save(destination)
    with fitz.open(destination) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info == before_info
        assert page.rect.contains(
            annotation.rect
        ), "legacy appearance still extends beyond the visible page"
        assert "".join(annotation.get_text().split()) == "".join(TEXT.split())
