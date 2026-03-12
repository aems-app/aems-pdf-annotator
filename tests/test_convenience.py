import pytest
from pathlib import Path
from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.convenience import apply_annotations, apply_annotation_batch
from aems_pdf_annotator.models import (
    PDFAnnotation, BBox, AnnotationBatch,
    AnnotationType, AnnotationColor,
)


@pytest.fixture
def sample_pdf(tmp_path) -> Path:
    pdf_path = tmp_path / "test.pdf"
    doc = fitz.open()
    doc.new_page(width=612, height=792)
    doc.save(str(pdf_path))
    doc.close()
    return pdf_path


def test_apply_annotations_creates_output(sample_pdf):
    annotations = [PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=80),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
        comment="Test",
        grader_name="Tester",
    )]
    output, count = apply_annotations(sample_pdf, annotations)
    assert output.exists()
    assert count == 1
    assert output.name == "test_annotated.pdf"


def test_apply_annotations_custom_output(sample_pdf, tmp_path):
    custom = tmp_path / "custom_output.pdf"
    annotations = [PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=80),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )]
    output, count = apply_annotations(sample_pdf, annotations, output_path=custom)
    assert output == custom
    assert output.exists()


def test_apply_annotation_batch(sample_pdf):
    batch = AnnotationBatch(pdf_path=str(sample_pdf))
    batch.add_annotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=80),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )
    output, count = apply_annotation_batch(batch)
    assert output.exists()
    assert count == 1
