"""241 review (2026-11-08): undoing a moved ink stroke must restore its points on disk.

The review modal's undo of a markup move used to send only ``rect``. PyMuPDF ignores a
Rect on Ink ("Ink annotations have no Rect property"), the update still reported success,
and the reopened PDF kept the moved stroke. The modal now sends the stroke's original
``points``; this pins that this request shape persists and that a rect-only one does not.
"""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator
from aems_pdf_annotator.models import AnnotationColor, AnnotationType, BBox, PDFAnnotation

ORIGINAL = [[50.0, 300.0], [100.0, 320.0], [200.0, 350.0]]
MOVED = [[x + 40.0, y + 60.0] for x, y in ORIGINAL]


@pytest.fixture
def ink_pdf(tmp_path: Path) -> Path:
    pdf_path = tmp_path / "ink.pdf"
    doc = fitz.open()
    doc.new_page(width=612, height=792)
    doc.save(str(pdf_path))
    doc.close()
    with PDFAnnotator(pdf_path) as annotator:
        assert annotator.add_annotation(PDFAnnotation(
            page_index=0, bbox=BBox(x0=50, y0=300, x1=200, y1=350), kind=AnnotationType.DRAWING,
            color=AnnotationColor.RED, drawing_style="pen", points=ORIGINAL,
            stroke_width=2.0, stroke_opacity=1.0, grader_name="Synthetic Teacher",
        ))
        annotator.save()
    return pdf_path


def _ink(pdf_path: Path) -> dict:
    with PDFAnnotator(pdf_path) as annotator:
        (ink,) = [ann for ann in annotator.get_annotations_on_page(0) if ann.get("type") == "drawing"]
    return ink


def _identifier(ink: dict) -> str:
    return str(ink.get("stable_id") or ink.get("id") or ink["xref"])


def _update(pdf_path: Path, **changes: object) -> None:
    with PDFAnnotator(pdf_path) as annotator:
        assert annotator.update_annotation(_identifier(_ink(pdf_path)), **changes)
        annotator.save()


def _points(ink: dict) -> list[list[float]]:
    return [[round(float(x), 1), round(float(y), 1)] for x, y in ink["points"]]


def test_the_move_itself_persists(ink_pdf: Path) -> None:
    _update(ink_pdf, new_points=MOVED)
    assert _points(_ink(ink_pdf)) == MOVED


def test_undo_with_the_original_points_restores_the_stroke_after_reopening(ink_pdf: Path) -> None:
    _update(ink_pdf, new_points=MOVED)
    _update(ink_pdf, new_points=ORIGINAL)
    assert _points(_ink(ink_pdf)) == ORIGINAL


def test_a_rect_only_undo_leaves_the_stroke_moved(ink_pdf: Path) -> None:
    """The defect's request shape: success is reported, nothing moves back."""
    _update(ink_pdf, new_points=MOVED)
    _update(ink_pdf, new_rect=(50.0, 442.0, 200.0, 492.0))
    assert _points(_ink(ink_pdf)) == MOVED


@pytest.mark.parametrize("kind", [AnnotationType.TEXTBOX, AnnotationType.TEXT])
def test_rect_annotations_the_drag_can_move_restore_by_rect(tmp_path: Path, kind: AnnotationType) -> None:
    """Text boxes and notes keep their position in Rect, so a rect undo restores them.

    The annotator creates no shape annotations (CIRCLE is refused as unknown); pen and
    highlighter strokes are Ink, covered above.
    """
    pdf_path = tmp_path / f"{kind.value}.pdf"
    doc = fitz.open()
    doc.new_page(width=612, height=792)
    doc.save(str(pdf_path))
    doc.close()
    with PDFAnnotator(pdf_path) as annotator:
        assert annotator.add_annotation(PDFAnnotation(
            id=f"move-{kind.value}", page_index=0, bbox=BBox(x0=50, y0=50, x1=200, y1=80), kind=kind,
            color=AnnotationColor.GREEN, comment="Move me", grader_name="Synthetic Teacher",
            stroke_color_rgb=[0, 0, 0] if kind == AnnotationType.TEXTBOX else None,
        ))
        annotator.save()

    def stored_rect() -> list[float]:
        with PDFAnnotator(pdf_path) as annotator:
            (ann,) = annotator.get_annotations_on_page(0)
            return [round(float(value), 1) for value in ann["rect"]]

    original = stored_rect()
    for rect in [(150.0, 250.0, 300.0, 280.0), tuple(original)]:
        with PDFAnnotator(pdf_path) as annotator:
            assert annotator.update_annotation(f"move-{kind.value}", new_rect=rect)
            annotator.save()
    assert stored_rect() == original
