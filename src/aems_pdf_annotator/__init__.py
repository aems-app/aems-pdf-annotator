"""AEMS PDF Annotator — shared annotation engine."""

__version__ = "0.3.0"

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
from aems_pdf_annotator.contract import (
    CURRENT_CONTRACT_VERSION,
    CURRENT_COORDINATE_SPACE,
    SUPPORTED_CONTRACT_VERSIONS,
    feedback_item_to_annotation,
    feedback_items_to_annotations,
    payload_to_annotations,
    validate_contract_version,
    ContractValidationError,
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
    "CURRENT_CONTRACT_VERSION",
    "CURRENT_COORDINATE_SPACE",
    "SUPPORTED_CONTRACT_VERSIONS",
    "feedback_item_to_annotation",
    "feedback_items_to_annotations",
    "payload_to_annotations",
    "validate_contract_version",
    "ContractValidationError",
    "PDFAnnotator",
    "apply_annotations",
    "apply_annotation_batch",
]
