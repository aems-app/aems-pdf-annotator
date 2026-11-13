"""L1b: saved freetext must wrap all content into the visible PDF page.

The synthetic fixture captures actual editor rectangles at three display scales,
on portrait, landscape and small pages. It contains no student material.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from aems_pdf_annotator import (
    AnnotationColor,
    AnnotationSource,
    AnnotationType,
    BBox,
    PDFAnnotation,
    PDFAnnotator,
)
from aems_pdf_annotator._fitz import fitz


CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "textbox-measurements.json").read_text(encoding="utf-8")
)


def _assert_visible(path: Path, text: str, page_index: int = 0) -> None:
    """Metadata, rendered glyph text and geometry are separate assertions."""
    with fitz.open(path) as document:
        page = document[page_index]
        annotation = next(page.annots())
        assert annotation.info["content"] == text, "stored textbox content changed"
        visible = "".join(annotation.get_text().split())
        expected = "".join(text.split())
        assert visible == expected, "saved textbox appearance clips comment text"
        # Rectangles are unrotated; extracted words are in rotated display space.
        rect_bounds = page.rect * page.derotation_matrix
        assert rect_bounds.contains(annotation.rect), "textbox extends beyond page"
        word_bounds = page.rect + (-0.01, -0.01, 0.01, 0.01)
        assert all(
            word_bounds.contains(fitz.Rect(word[:4])) for word in annotation.get_text("words")
        ), "visible textbox words extend beyond page"


def _model(rect: list[float], text: str) -> PDFAnnotation:
    return PDFAnnotation(
        page_index=0,
        kind=AnnotationType.TEXTBOX,
        color=AnnotationColor.RED,
        source=AnnotationSource.HUMAN,
        comment=text,
        grader_name="Synthetic Reviewer",
        bbox=BBox.from_list(rect),
    )


@pytest.mark.parametrize("case_index", range(len(CASES)))
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_editor_rectangles_save_all_visible_text(
    tmp_path: Path, case_index: int, rotation: int,
) -> None:
    case = CASES[case_index]
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        document.new_page(width=case["width"], height=case["height"]).set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(case["rect"], case["text"]))
        writer.save(target)
    _assert_visible(target, case["text"])


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("operation", ["add", "edit", "move"])
@pytest.mark.parametrize("text", [
    "Detailed explanation " * 12 + "FINALWORD",
    "LongUnbrokenWord" * 12 + "FINALWORD",
])
def test_edge_creation_edit_and_move_keep_entire_comment_visible(
    tmp_path: Path, rotation: int, operation: str, text: str,
) -> None:
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=400).set_rotation(rotation)
        document.save(source)
    model = _model([220, 378, 296, 396], "Draft" if operation == "edit" else text)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(model)
        if operation == "edit":
            assert writer.update_annotation(model.id, new_content=text)
        elif operation == "move":
            assert writer.update_annotation(model.id, new_page_index=1)
        writer.save(target)
    _assert_visible(target, text, page_index=1 if operation == "move" else 0)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize(("text", "rect"), [
    ("", [50, 50, 110, 80]),
    ("First line\n\nSecond line FINALWORD\n", [220, 300, 270, 370]),
    ("Text at negative origin FINALWORD", [-30, -20, 80, 10]),
    ("Text beyond right bottom FINALWORD", [295, 395, 360, 440]),
])
def test_crop_newlines_empty_and_offpage_rectangles(
    tmp_path: Path, rotation: int, cropped: bool, text: str, rect: list[float],
) -> None:
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        if cropped:
            page.set_cropbox(fitz.Rect(20, 30, 280, 370))
        page.set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(rect, text))
        writer.save(target)
    _assert_visible(target, text)
