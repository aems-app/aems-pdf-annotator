"""Existing native FreeText font family is review evidence across fitted recreation."""

import re
from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator


@pytest.mark.parametrize("font_name,font_key", [("cour", "Cour"), ("tiro", "TiRo")])
@pytest.mark.parametrize("operation", ["content", "geometry", "move"])
@pytest.mark.parametrize("native_rotation", [0, 90])
def test_existing_native_font_survives_fitted_content_geometry_and_move(
    tmp_path: Path, font_name: str, font_key: str, operation: str, native_rotation: int,
) -> None:
    source = tmp_path / "legacy-native-font.pdf"
    saved = tmp_path / "native-font-saved.pdf"
    original_text = "Original native comment."
    edited_text = "Edited native comment. FINALWORD"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.new_page(width=300, height=400)
        page = document[0]
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 220, 100), original_text, fontname=font_name,
            fontsize=8, text_color=(0, 0, 1), rotate=native_rotation,
        )
        annotation.set_info(title="fixture-actor", subject="legacy-font-id|HUMAN",
                            creationDate="D:20200102030405Z")
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str("legacy-font-id"))
        document.save(source)
    with PDFAnnotator(source) as writer:
        kwargs = {"new_content": edited_text} if operation == "content" else (
            {"new_rect": (60, 60, 230, 110)} if operation == "geometry"
            else {"new_page_index": 1}
        )
        result = writer.update_annotation("legacy-font-id", **kwargs)
        assert result
        page_index = 1 if operation == "move" else 0
        page = writer.doc[page_index]
        annotation = next(page.annots())
        replacement_xref = annotation.xref
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[page_index]
        annotation = next(page.annots())
        default_appearance = document.xref_get_key(annotation.xref, "DA")[1]
        font_match = re.search(r"/([^\s]+)\s+[\d.]+\s+Tf", default_appearance)
        assert font_match and font_match[1] == font_key, (
            "fitted recreation changed the existing native font family"
        )
        assert annotation.xref == replacement_xref, "save recreated the already fitted object"
        assert annotation.info["title"] == "fixture-actor"
        assert annotation.info["creationDate"] == "D:20200102030405Z"
        expected_text = edited_text if operation == "content" else original_text
        assert annotation.info["content"] == expected_text
        assert "".join(annotation.get_text().split()) == "".join(expected_text.split())
        # Older PyMuPDF includes a signed alpha byte; compare the native RGB.
        colors = {span["color"] & 0xFFFFFF for block in annotation.get_text("dict")["blocks"]
                  for line in block.get("lines", []) for span in line["spans"]}
        assert colors == {255}, "native blue text color changed during font preservation"
        samples = page.get_pixmap().samples
        painted_pixels = [samples[index:index + 3] for index in range(0, len(samples), 3)
                          if min(samples[index:index + 3]) < 250]
        assert painted_pixels, "native comment has no painted pixels"
        assert all(red == green and blue == 255 for red, green, blue in painted_pixels), (
            "native raster ink changed from original blue"
        )
    with PDFAnnotator(saved) as reader:
        located = reader.find_annotation_by_id("legacy-font-id")
        assert located is not None and located[0] == page_index
        assert located[1].xref == replacement_xref
