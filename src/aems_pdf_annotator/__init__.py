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
from aems_pdf_annotator.validator import (
    AnnotationValidator,
    validate_annotations,
)

# core and convenience are imported lazily to avoid hard PyMuPDF dep at import
# time — import them explicitly when needed, or use the helpers below.
try:
    from aems_pdf_annotator.core import PDFAnnotator
    from aems_pdf_annotator.convenience import apply_annotations, apply_annotation_batch
    _has_fitz = True
except ImportError:
    _has_fitz = False

__all__ = [
    "PDFAnnotation",
    "BBox",
    "AnnotationBatch",
    "AnnotationColor",
    "AnnotationType",
    "AnnotationSource",
    "AnnotationValidator",
    "validate_annotations",
    "PDFAnnotator",
    "apply_annotations",
    "apply_annotation_batch",
]
