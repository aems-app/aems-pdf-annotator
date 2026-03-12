from aems_pdf_annotator.validator import (
    AnnotationValidator, validate_annotations,
    BBoxIssueSeverity,
)
from aems_pdf_annotator.models import (
    PDFAnnotation, BBox, AnnotationType, AnnotationColor,
)


def test_valid_annotation_passes():
    annotations = [PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=100),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )]
    fixed, result = validate_annotations(
        annotations, page_dimensions=[(612, 792)]
    )
    assert result.passed


def test_zero_area_bbox_fails():
    annotations = [PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=50, y1=50),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )]
    fixed, result = validate_annotations(
        annotations, page_dimensions=[(612, 792)]
    )
    assert not result.passed
    assert any(i.severity == BBoxIssueSeverity.ERROR for i in result.issues)


def test_out_of_bounds_clamped():
    annotations = [PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=-10, y0=-10, x1=700, y1=900),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )]
    fixed, result = validate_annotations(
        annotations, page_dimensions=[(612, 792)], fix_issues=True
    )
    assert result.annotations_fixed == 1
    assert fixed[0].bbox.x0 >= 0
    assert fixed[0].bbox.x1 <= 612
