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


@pytest.mark.parametrize(
    "kind,changes",
    [
        ("textbox", {"new_content": "Updated synthetic text FINALWORD"}),
        ("textbox", {"new_rect": (60, 60, 180, 100)}),
        ("textbox", {"new_stroke_color_rgb": [20, 30, 40]}),
        ("drawing", {"new_stroke_color_rgb": [20, 30, 40]}),
        ("highlight", {"new_quads": [[50, 50, 180, 75]]}),
    ],
    ids=["textbox-content", "textbox-geometry", "textbox-colour", "drawing", "highlight"],
)
@pytest.mark.parametrize("identity_field", ["id", "name"])
def test_legacy_recreation_retains_reader_identity_for_later_edit_and_delete(
    tmp_path: Path, kind: str, changes: dict[str, Any], identity_field: str,
) -> None:
    """Recreating a legacy annotation must not orphan its existing client identity."""
    source = tmp_path / "legacy.pdf"
    stable_id = f"legacy-{kind}-identity"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        if kind == "textbox":
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 170, 100), "Original synthetic text", fontsize=11,
            )
        elif kind == "drawing":
            annotation = page.add_ink_annot([[(50, 50), (100, 90)]])
        else:
            annotation = page.add_highlight_annot(fitz.Rect(50, 50, 150, 75))
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(stable_id))
        if identity_field == "name":
            document.xref_set_key(annotation.xref, "Name", f"/{stable_id}")
        assert annotation.info[identity_field] == stable_id
        assert not annotation.info["subject"]
        document.save(source)
    with PDFAnnotator(source) as writer:
        before = writer.get_annotations_on_page(0)[0]
        assert before["stable_id"] == stable_id
        result = writer.update_annotation(stable_id, **changes)
        assert isinstance(result, tuple) and result[0] is True
        after = writer.get_annotations_on_page(0)[0]
        assert after["stable_id"] == stable_id, "recreation changed the legacy client identity"
        assert writer.find_annotation_by_id(stable_id) is not None
        followup = writer.update_annotation(stable_id, new_content="Follow-up synthetic text")
        assert followup[0] if isinstance(followup, tuple) else followup
        assert writer.delete_annotation(stable_id)
        assert writer.get_annotations_on_page(0) == []


@pytest.mark.parametrize("identity_field", ["id", "name"])
def test_recreating_repeated_legacy_ids_does_not_promote_them_to_explicit_ids(
    tmp_path: Path, identity_field: str,
) -> None:
    """Legacy NM/name values may repeat across pages without violating the save guard."""
    from aems_pdf_annotator.core import _decode_subject_metadata

    source = tmp_path / "repeated-legacy.pdf"
    destination = tmp_path / "edited-legacy.pdf"
    stable_id = "legacy-shared-identity"
    with fitz.open() as document:
        for index in range(2):
            page = document.new_page(width=300, height=400)
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 180, 100), f"Synthetic page {index}", fontsize=11,
            )
            backend_id = stable_id if identity_field == "id" else f"legacy-backend-{index}"
            document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(backend_id))
            if identity_field == "name":
                document.xref_set_key(annotation.xref, "Name", f"/{stable_id}")
            assert annotation.info[identity_field] == stable_id
        document.save(source)
    with PDFAnnotator(source) as writer:
        for index in range(2):
            row = writer.get_annotations_on_page(index)[0]
            assert row["stable_id"] == stable_id
            # Duplicate fallback ids are ambiguous on their own: the existing xref
            # identifies the intended page's annotation for its first mutation.
            result = writer.update_annotation(
                str(row["xref"]), new_content=f"Updated synthetic page {index}",
            )
            assert isinstance(result, tuple) and result[0] is True
            updated = writer.get_annotations_on_page(index)[0]
            assert updated["stable_id"] == stable_id, "recreation replaced a legacy fallback id"
            page = writer.doc[index]
            metadata = _decode_subject_metadata(next(page.annots()).info["subject"])
            assert not metadata["has_explicit_stable_id"], "implicit duplicate was promoted to explicit"
        writer.save(destination)
    with PDFAnnotator(destination) as reader:
        rows = [reader.get_annotations_on_page(index)[0] for index in range(2)]
        assert [row["stable_id"] for row in rows] == [stable_id, stable_id]
        assert [row["content"] for row in rows] == [
            "Updated synthetic page 0", "Updated synthetic page 1",
        ]
