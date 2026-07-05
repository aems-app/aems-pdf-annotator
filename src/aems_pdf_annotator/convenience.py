"""
Convenience functions for PDF annotation.

Provides high-level functions for applying annotations to PDFs.
"""

import logging
import os
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

try:
    from aems_pdf_annotator._fitz import fitz  # PyMuPDF
except ImportError:
    raise ImportError(
        "PyMuPDF is required for PDF annotation. " "Install with: pip install pymupdf"
    )

from aems_pdf_annotator.models import (
    PDFAnnotation,
    AnnotationBatch,
    AnnotationType,
    AnnotationColor,
    BBox,
)
from .core import PDFAnnotator

logger = logging.getLogger(__name__)


def apply_annotations(
    pdf_path: Path | str,
    annotations: List[PDFAnnotation],
    output_path: Optional[Path | str] = None,
) -> Tuple[Path, int]:
    """
    Apply annotations to a PDF file (convenience function).

    Args:
        pdf_path: Path to the input PDF
        annotations: List of annotations to apply
        output_path: Path for output (if None, creates *_annotated.pdf)

    Returns:
        Tuple of (output_path, number_of_annotations_added)
    """
    pdf_path = Path(pdf_path)

    if output_path is None:
        output_path = pdf_path.parent / f"{pdf_path.stem}_annotated.pdf"
    else:
        output_path = Path(output_path)

    final_output_path = output_path
    write_output_path = output_path
    same_output = final_output_path.resolve() == pdf_path.resolve()
    if same_output:
        write_output_path = final_output_path.with_name(
            f"{final_output_path.stem}.{uuid.uuid4().hex}.tmp{final_output_path.suffix}"
        )

    with PDFAnnotator(pdf_path) as annotator:
        count = annotator.add_annotations(annotations)
        saved_path = annotator.save(write_output_path)

    saved_path = Path(saved_path)
    if same_output:
        os.replace(str(saved_path), str(final_output_path))
        saved_path = final_output_path

    return saved_path, count


def apply_annotation_batch(batch: AnnotationBatch) -> Tuple[Path, int]:
    """
    Apply an AnnotationBatch to a PDF.

    Args:
        batch: AnnotationBatch with pdf_path and annotations

    Returns:
        Tuple of (output_path, number_of_annotations_added)
    """
    pdf_path = Path(batch.pdf_path)
    output_path = pdf_path.parent / f"{pdf_path.stem}_annotated.pdf"

    return apply_annotations(pdf_path, batch.annotations, output_path)


def create_demo_annotations(
    pdf_path: Path | str, output_path: Optional[Path | str] = None
) -> Path:
    """
    Create a demo PDF with sample annotations (for testing M0).

    Args:
        pdf_path: Path to input PDF
        output_path: Path for output (optional)

    Returns:
        Path to annotated PDF
    """
    logger.info("Creating demo annotations...")

    # Open PDF to get page dimensions
    with fitz.open(pdf_path) as doc:
        if doc.page_count == 0:
            raise ValueError("PDF has no pages")

        page = doc[0]
        width, height = page.rect.width, page.rect.height

    # Create sample annotations on first page
    annotations = [
        # Green highlight for "correct" area (top third)
        PDFAnnotation(
            page_index=0,
            bbox=BBox(x0=50, y0=50, x1=width - 50, y1=150),
            kind=AnnotationType.HIGHLIGHT,
            color=AnnotationColor.GREEN,
            comment="Correct derivation of initial equation",
            check_id="Q1a-01",
        ),
        # Red squiggly for "incorrect" area (middle third)
        PDFAnnotation(
            page_index=0,
            bbox=BBox(x0=50, y0=height / 2 - 50, x1=width - 50, y1=height / 2),
            kind=AnnotationType.SQUIGGLY,
            color=AnnotationColor.RED,
            comment="Sign error: should be +sigma not -sigma",
            check_id="Q1b-03",
        ),
        # Amber text note for "review needed"
        PDFAnnotation(
            page_index=0,
            bbox=BBox(x0=width - 100, y0=height - 150, x1=width - 50, y1=height - 100),
            kind=AnnotationType.TEXT,
            color=AnnotationColor.AMBER,
            comment="Uncertain: Novel solution method requires human review",
            check_id="Q2-05",
        ),
    ]

    return apply_annotations(pdf_path, annotations, output_path)[0]
