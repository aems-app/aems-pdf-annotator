"""O4: untouched legacy FreeText appearances must not stay clipped after saving."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata

TEXT = "This is a fully visible comment. FINALWORD"


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
