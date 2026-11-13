"""Raw PDF.js ink points must match native PDF /InkList geometry across page transforms."""

from pathlib import Path
import re
from typing import Any

import pytest

from aems_pdf_annotator import (
    AnnotationColor,
    AnnotationType,
    BBox,
    PDFAnnotation,
    PDFAnnotator,
)
from aems_pdf_annotator._fitz import fitz

GEOMETRIES = [
    (rotation, crop, shift)
    for rotation in (0, 90, 180, 270)
    for crop in (False, True)
    for shift in (False, True)
]


def _geometry(page: Any, rotation: int, crop: bool, shift: bool) -> None:
    if shift:
        page.set_mediabox(fitz.Rect(11, 19, 606, 861))
    if crop:
        page.set_cropbox(fitz.Rect(28 if shift else 17, 23, 577 if shift else 566, 811))
    page.set_rotation(rotation)


def _native_points(annotation: Any) -> list[list[float]]:
    return [
        [float(point[0]), float(point[1])]
        for stroke in annotation.vertices
        for point in stroke
    ]


@pytest.mark.parametrize("geometry", GEOMETRIES)
@pytest.mark.parametrize("operation", ["read", "create", "update", "move"])
def test_native_ink_points_round_trip_raw_pdf_coordinates(
    tmp_path: Path,
    geometry: tuple[int, bool, bool],
    operation: str,
) -> None:
    """Native /InkList is the independent raw-PDF oracle, not another height-flip formula."""
    source = tmp_path / "native-ink.pdf"
    target_page_index = 1 if operation == "move" else 0
    with fitz.open() as document:
        document.new_page(width=595, height=842)
        document.new_page(width=595, height=842)
        page = document[target_page_index]
        _geometry(page, *geometry)
        reference = page.add_ink_annot([[(40, 65), (160, 105)]])
        expected_native = _native_points(reference)
        raw = document.xref_get_key(reference.xref, "InkList")[1]
        numbers = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", raw)]
        assert len(numbers) == 4, "native ink oracle did not contain two points"
        raw_points = [numbers[:2], numbers[2:]]
        if operation == "read":
            original_xref = reference.xref
        else:
            page.delete_annot(reference)
            if operation in ("update", "move"):
                old_page = document[0]
                original = old_page.add_ink_annot([[(20, 30), (50, 60)]])
                original_xref = original.xref
        document.save(source)
    with PDFAnnotator(source) as writer:
        if operation == "create":
            assert writer.add_annotation(
                PDFAnnotation(
                    page_index=0,
                    kind=AnnotationType.DRAWING,
                    color=AnnotationColor.RED,
                    source="HUMAN",
                    comment="",
                    grader_name="Synthetic Reviewer",
                    drawing_style="pen",
                    points=raw_points,
                    bbox=BBox(x0=40, y0=65, x1=160, y1=105),
                )
            )
        elif operation in ("update", "move"):
            changes = {"new_points": raw_points}
            if operation == "move":
                changes["new_page_index"] = 1
            result = writer.update_annotation(str(original_xref), **changes)
            assert result[0] if isinstance(result, tuple) else result
        page = writer.doc[target_page_index]
        annotation = next(page.annots())
        if operation != "read":
            for actual, expected in zip(_native_points(annotation), expected_native):
                assert actual == pytest.approx(
                    expected, abs=0.02
                ), "raw PDF ink points were painted at the wrong native position"
        row = writer.get_annotations_on_page(target_page_index)[0]
        assert len(row["points"]) == len(raw_points)
        for actual, expected in zip(row["points"], raw_points):
            assert actual == pytest.approx(
                expected, abs=0.02
            ), "ink readback is not in raw PDF.js point space"
