import pytest
from pathlib import Path
from types import SimpleNamespace
from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.convenience import apply_annotations, apply_annotation_batch
import aems_pdf_annotator.convenience as convenience_module
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


def test_apply_annotations_same_path_uses_atomic_replace(sample_pdf, monkeypatch):
    saved_paths = []
    replaced_paths = []

    class FakeAnnotator:
        def __init__(self, pdf_path):
            self.pdf_path = Path(pdf_path)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def add_annotations(self, annotations):
            return len(annotations)

        def save(self, output_path=None):
            path = Path(output_path)
            saved_paths.append(path)
            path.write_bytes(b"%PDF-1.7\n%temp\n")
            return path

    def fake_replace(src, dst):
        src_path = Path(src)
        dst_path = Path(dst)
        replaced_paths.append((src_path, dst_path))
        dst_path.write_bytes(src_path.read_bytes())
        src_path.unlink()

    monkeypatch.setattr(convenience_module, "PDFAnnotator", FakeAnnotator)
    monkeypatch.setattr(
        convenience_module,
        "os",
        SimpleNamespace(replace=fake_replace),
        raising=False,
    )

    annotation = PDFAnnotation(
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=80),
        kind=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
    )

    output, count = apply_annotations(sample_pdf, [annotation], output_path=sample_pdf)

    assert count == 1
    assert output == sample_pdf
    assert len(saved_paths) == 1
    assert saved_paths[0] != sample_pdf
    assert replaced_paths == [(saved_paths[0], sample_pdf)]
