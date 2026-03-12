# tests/test_models.py
import pytest
from aems_pdf_annotator.models import (
    PDFAnnotation, BBox, AnnotationBatch,
    AnnotationColor, AnnotationType, AnnotationSource,
)


def test_bbox_creation_and_properties():
    bbox = BBox(x0=10, y0=20, x1=100, y1=200)
    assert bbox.width == 90
    assert bbox.height == 180
    assert bbox.is_valid()
    assert bbox.to_rect() == (10, 20, 100, 200)


def test_bbox_clamp_to_bounds():
    bbox = BBox(x0=-5, y0=-10, x1=700, y1=900)
    clamped = bbox.clamp_to_bounds(612, 792)
    assert clamped.x0 == 0
    assert clamped.y0 == 0
    assert clamped.x1 == 612
    assert clamped.y1 == 792


def test_annotation_color_values():
    assert AnnotationColor.GREEN.value == "green"
    assert AnnotationColor.RED.value == "red"
    assert AnnotationColor.AMBER.value == "amber"


def test_pdf_annotation_defaults():
    annot = PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=10, y0=20, x1=100, y1=50),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )
    assert annot.source == AnnotationSource.AI
    assert annot.is_system_generated is True
    assert len(annot.id) > 0


def test_pdf_annotation_get_rgb_color():
    annot = PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=0, y0=0, x1=1, y1=1),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.RED,
    )
    assert annot.get_rgb_color() == (1.0, 0.0, 0.0)


def test_annotation_batch_operations():
    batch = AnnotationBatch(pdf_path="/tmp/test.pdf")
    batch.add_annotation(
        page_index=0,
        bbox=BBox(x0=10, y0=20, x1=100, y1=50),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
        comment="Good work",
    )
    batch.add_annotation(
        page_index=0,
        bbox=BBox(x0=10, y0=60, x1=100, y1=90),
        kind=AnnotationType.SQUIGGLY,
        color=AnnotationColor.RED,
        comment="Error here",
    )
    assert len(batch.annotations) == 2
    assert len(batch.get_by_color(AnnotationColor.GREEN)) == 1
    assert len(batch.get_by_page(0)) == 2


def test_drawing_annotation_validation():
    annot = PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=0, y0=0, x1=1, y1=1),
        kind=AnnotationType.DRAWING,
        color=AnnotationColor.RED,
        drawing_style="pen",
        points=[[0, 0], [10, 10], [20, 5]],
        stroke_width=2.0,
        stroke_opacity=1.0,
    )
    assert annot.drawing_style == "pen"
    assert len(annot.points) == 3


def test_drawing_annotation_invalid_style():
    with pytest.raises(ValueError, match="drawing_style"):
        PDFAnnotation(
            page_index=0,
            bbox=BBox(x0=0, y0=0, x1=1, y1=1),
            kind=AnnotationType.DRAWING,
            color=AnnotationColor.RED,
            drawing_style="crayon",
        )


def test_transfer_ownership_to_human():
    annot = PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=0, y0=0, x1=1, y1=1),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )
    assert annot.source == AnnotationSource.AI
    result = annot.transfer_ownership_to_human("user-123", "Prof. Smith")
    assert result is True
    assert annot.source == AnnotationSource.HUMAN
    assert annot.original_source == AnnotationSource.AI
    assert annot.grader_name == "Prof. Smith"
