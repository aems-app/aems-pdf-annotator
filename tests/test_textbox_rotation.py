"""F2: native glyph direction survives textbox recreation and page movement."""

from pathlib import Path
from typing import Any

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator

TEXT = "NATIVE ROTATION TARGET"


def _direction(annotation: Any) -> tuple[float, float]:
    lines = [
        line
        for block in annotation.get_text("dict")["blocks"]
        for line in block.get("lines", [])
        if line.get("spans")
    ]
    assert lines, "native glyph fixture did not contain extractable text"
    return tuple(lines[0]["dir"])


@pytest.mark.parametrize("annotation_rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("operation", ["content", "geometry", "colour"])
def test_same_page_textbox_recreation_preserves_native_rotation_and_glyph_direction(
    tmp_path: Path,
    annotation_rotation: int,
    operation: str,
) -> None:
    source = tmp_path / "same-page-native-rotation.pdf"
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        page.set_rotation(90)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 250, 150),
            TEXT,
            fontsize=8,
            rotate=annotation_rotation,
        )
        document.save(source)
    with PDFAnnotator(source) as writer:
        page = writer.doc[0]
        original = next(page.annots())
        before_direction = _direction(original)
        before_rotation = max(0, original.rotation)
        original_id = original.info["id"]
        changes = {
            "content": {"new_content": TEXT + " EDITED"},
            "geometry": {"new_rect": (60, 60, 260, 160)},
            "colour": {"new_stroke_color_rgb": [20, 30, 40]},
        }[operation]
        result = writer.update_annotation(str(original.xref), **changes)
        assert result[0] if isinstance(result, tuple) else result
        page = writer.doc[0]
        updated = next(page.annots())
        assert updated.info["id"] == original_id
        assert (
            max(0, updated.rotation) == before_rotation
        ), "textbox recreation reset native annotation rotation"
        assert _direction(updated) == pytest.approx(
            before_direction
        ), "same-page recreation turned painted glyphs"


@pytest.mark.parametrize(
    "page_rotations", [(0, 90), (90, 0), (90, 180), (270, 90), (180, 180)]
)
@pytest.mark.parametrize("annotation_rotation", [0, 90])
def test_page_move_preserves_the_native_display_glyph_direction(
    tmp_path: Path,
    page_rotations: tuple[int, int],
    annotation_rotation: int,
) -> None:
    source = tmp_path / "move-native-rotation.pdf"
    with fitz.open() as document:
        for rotation in page_rotations:
            document.new_page(width=595, height=842).set_rotation(rotation)
        page = document[0]
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 250, 150),
            TEXT,
            fontsize=8,
            rotate=annotation_rotation,
        )
        document.save(source)
    with PDFAnnotator(source) as writer:
        page = writer.doc[0]
        original = next(page.annots())
        before_direction = _direction(original)
        original_id = original.info["id"]
        result = writer.update_annotation(str(original.xref), new_page_index=1)
        assert result[0] if isinstance(result, tuple) else result
        page = writer.doc[1]
        updated = next(page.annots())
        assert updated.info["id"] == original_id
        assert _direction(updated) == pytest.approx(
            before_direction
        ), "cross-page move changed the viewer glyph direction"
