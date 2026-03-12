"""AEMS PDF Annotator — shared annotation engine."""
__version__ = "0.1.0"

from aems_pdf_annotator.models import (
    PDFAnnotation,
    BBox,
    AnnotationBatch,
    AnnotationColor,
    AnnotationType,
    AnnotationSource,
)

__all__ = [
    "PDFAnnotation",
    "BBox",
    "AnnotationBatch",
    "AnnotationColor",
    "AnnotationType",
    "AnnotationSource",
]
