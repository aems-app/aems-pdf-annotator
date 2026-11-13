"""New manually created fitted FreeText must paint on all supported native engines."""

from pathlib import Path

import pytest

from aems_pdf_annotator import (
    AnnotationColor,
    AnnotationType,
    BBox,
    PDFAnnotation,
    PDFAnnotator,
)
from aems_pdf_annotator._fitz import fitz


@pytest.mark.parametrize("page_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("native_rotation", [0, 90])
def test_new_manual_textbox_add_save_has_complete_native_appearance(
    tmp_path: Path, page_rotation: int, native_rotation: int,
) -> None:
    source = tmp_path / "new-manual-source.pdf"
    saved = tmp_path / "new-manual-saved.pdf"
    text = "This is a fully visible comment. FINALWORD"
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        page.set_rotation(page_rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(
            PDFAnnotation(
                id="synthetic-new-manual", page_index=0, kind=AnnotationType.TEXTBOX,
                color=AnnotationColor.RED, source="HUMAN", comment=text,
                grader_name="fixture-actor", bbox=BBox(x0=50, y0=50, x1=160, y1=72),
            ),
            textbox_rotation=native_rotation,
        )
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == text
        assert "".join(annotation.get_text().split()) == "".join(text.split()), (
            "new fitted manual textbox add/save produced a blank or clipped native appearance"
        )
        assert any(channel < 250 for channel in page.get_pixmap().samples), (
            "new fitted manual textbox has no painted native pixels"
        )
