"""Wire contract validation and feedback-item-to-annotation conversion."""

import importlib.resources
import json
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from aems_pdf_annotator.models import (
    PDFAnnotation, BBox, AnnotationColor, AnnotationType, AnnotationSource,
)

logger = logging.getLogger(__name__)

CURRENT_CONTRACT_VERSION = 1
CURRENT_COORDINATE_SPACE = "visual_top_left_normalized_v1"
SUPPORTED_CONTRACT_VERSIONS = frozenset({1})

# Standard annotation dimensions (points)
_HIGHLIGHT_WIDTH = 200.0
_HIGHLIGHT_HEIGHT = 20.0
_TEXT_NOTE_SIZE = 24.0


class ContractValidationError(ValueError):
    """Raised when a payload fails contract validation."""
    pass


def validate_contract_version(payload: Dict[str, Any]) -> bool:
    """Validate that payload contains a supported contract version.

    Args:
        payload: JSON payload with annotation_contract_version field.

    Returns:
        True if valid.

    Raises:
        ContractValidationError: If version is missing or unsupported.
    """
    version = payload.get("annotation_contract_version")
    if version is None:
        raise ContractValidationError(
            "Missing required field: annotation_contract_version"
        )
    if version not in SUPPORTED_CONTRACT_VERSIONS:
        raise ContractValidationError(
            f"Unsupported annotation_contract_version: {version}. "
            f"Supported: {sorted(SUPPORTED_CONTRACT_VERSIONS)}"
        )
    coordinate_space = payload.get("coordinate_space")
    if coordinate_space != CURRENT_COORDINATE_SPACE:
        raise ContractValidationError(
            f"Unsupported coordinate_space: {coordinate_space!r}. "
            f"Expected: {CURRENT_COORDINATE_SPACE!r}"
        )
    return True


def _priority_to_color(priority: str) -> AnnotationColor:
    """Map priority string to annotation color."""
    mapping = {
        "low": AnnotationColor.GREEN,
        "medium": AnnotationColor.AMBER,
        "high": AnnotationColor.RED,
    }
    return mapping.get(priority, AnnotationColor.AMBER)


def _priority_to_kind(priority: str, is_verdict: bool) -> AnnotationType:
    """Map priority + verdict flag to annotation type."""
    if is_verdict:
        return AnnotationType.TEXT
    if priority == "high":
        return AnnotationType.SQUIGGLY
    return AnnotationType.HIGHLIGHT


def _normalized_to_bbox(
    x_norm: float,
    y_norm: float,
    page_width: float,
    page_height: float,
    kind: AnnotationType,
) -> BBox:
    """Convert normalized coordinates to a BBox in PDF space (bottom-left origin).

    Args:
        x_norm: Horizontal position 0.0-1.0 (left to right).
        y_norm: Vertical position 0.0-1.0 (top to bottom, web convention).
        page_width: Page width in points.
        page_height: Page height in points.
        kind: Annotation type (affects bbox dimensions).

    Returns:
        BBox in PDF coordinate space.
    """
    x = x_norm * page_width
    # y_norm is top-to-bottom (web convention); PDF is bottom-to-top
    y_pdf = page_height - (y_norm * page_height)

    if kind == AnnotationType.TEXT:
        # Text notes are point annotations; give them a small bbox
        half = _TEXT_NOTE_SIZE / 2
        return BBox(
            x0=max(0, x - half),
            y0=max(0, y_pdf - half),
            x1=min(page_width, x + half),
            y1=min(page_height, y_pdf + half),
        )
    else:
        # Highlights/squiggly: horizontal strip
        x0 = max(0, x)
        x1 = min(page_width, x + _HIGHLIGHT_WIDTH)
        y0 = max(0, y_pdf - _HIGHLIGHT_HEIGHT / 2)
        y1 = min(page_height, y_pdf + _HIGHLIGHT_HEIGHT / 2)
        return BBox(x0=x0, y0=y0, x1=x1, y1=y1)


def feedback_item_to_annotation(
    item: Dict[str, Any],
    page_width: float,
    page_height: float,
    grader_name: Optional[str] = None,
) -> PDFAnnotation:
    """Convert a single wire-contract feedback item to a PDFAnnotation.

    Args:
        item: Feedback item dict matching the v1 contract schema.
        page_width: Width of the target page in points.
        page_height: Height of the target page in points.
        grader_name: Optional grader name for PDF author attribution.

    Returns:
        PDFAnnotation ready for application to a PDF.
    """
    page_1based = item.get("page", 1)
    page_index = max(0, int(page_1based) - 1)

    priority = str(item.get("priority", "medium")).lower()
    is_verdict = bool(item.get("is_verdict", False))

    color = _priority_to_color(priority)
    kind = _priority_to_kind(priority, is_verdict)

    x_norm = float(item.get("x_normalized", 0.1))
    y_norm = float(item.get("y_normalized", 0.5))

    bbox = _normalized_to_bbox(x_norm, y_norm, page_width, page_height, kind)

    icon = item.get("icon")
    if icon is None and kind == AnnotationType.TEXT:
        # Default icons for verdict summaries
        if is_verdict:
            verdict = str(item.get("verdict", "")).upper()
            icon = "Check" if verdict == "PASS" else "Help"

    return PDFAnnotation(
        id=str(item.get("stable_id") or item.get("check_id") or uuid.uuid4()),
        page_index=page_index,
        bbox=bbox,
        kind=kind,
        color=color,
        comment=item.get("comment", ""),
        check_id=item.get("check_id"),
        grader_name=grader_name,
        source=AnnotationSource.AI,
        original_source=AnnotationSource.AI,
        is_verdict=is_verdict,
        icon=icon,
    )


def feedback_items_to_annotations(
    items: List[Dict[str, Any]],
    page_dimensions: List[Tuple[float, float]],
    grader_name: Optional[str] = None,
) -> List[PDFAnnotation]:
    """Convert a list of feedback items to annotations.

    Skips items with empty comments. Clamps page indices to valid range.

    Args:
        items: List of feedback item dicts.
        page_dimensions: List of (width, height) for each page.
        grader_name: Optional grader name for attribution.

    Returns:
        List of PDFAnnotation objects.
    """
    max_page = len(page_dimensions)
    annotations: List[PDFAnnotation] = []

    for item in items:
        comment = (item.get("comment") or "").strip()
        if not comment:
            continue

        page_1based = item.get("page", 1)
        page_index = max(0, min(int(page_1based) - 1, max_page - 1))

        width, height = page_dimensions[page_index]
        annot = feedback_item_to_annotation(
            item, page_width=width, page_height=height,
            grader_name=grader_name,
        )
        # Override page_index with clamped value
        annot.page_index = page_index
        annotations.append(annot)

    return annotations
