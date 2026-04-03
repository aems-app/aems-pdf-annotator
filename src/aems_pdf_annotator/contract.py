"""Wire contract validation and feedback-item-to-annotation conversion."""

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from pydantic import ValidationError

from aems_pdf_annotator.models import (
    PDFAnnotation,
    BBox,
    AnnotationColor,
    AnnotationType,
    AnnotationSource,
)

logger = logging.getLogger(__name__)

CURRENT_CONTRACT_VERSION = 1
CURRENT_COORDINATE_SPACE = "visual_top_left_normalized_v1"
SUPPORTED_CONTRACT_VERSIONS = frozenset({1})

# Standard annotation dimensions (points).
# A US-letter page is 612pt wide. Keep highlights narrow enough to
# mark a phrase without drowning surrounding text.
_HIGHLIGHT_WIDTH = 80.0
_HIGHLIGHT_HEIGHT = 14.0
_TEXT_NOTE_SIZE = 18.0


class ContractValidationError(ValueError):
    """Raised when a payload fails contract validation."""

    pass


def _require_number(
    value: Any,
    field_name: str,
    *,
    minimum: Optional[float] = None,
    maximum: Optional[float] = None,
) -> float:
    """Validate a numeric contract field and return it as float."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractValidationError(f"{field_name} must be a number")

    numeric = float(value)
    if minimum is not None and numeric < minimum:
        raise ContractValidationError(f"{field_name} must be >= {minimum}")
    if maximum is not None and numeric > maximum:
        raise ContractValidationError(f"{field_name} must be <= {maximum}")
    return numeric


def _validate_feedback_item(item: Any, index: int) -> None:
    """Validate the required structure of one feedback item."""
    if not isinstance(item, dict):
        raise ContractValidationError(f"feedback_items[{index}] must be an object")

    page = item.get("page")
    if isinstance(page, bool) or not isinstance(page, int):
        raise ContractValidationError(
            f"feedback_items[{index}].page must be an integer"
        )
    if page < 1:
        raise ContractValidationError(f"feedback_items[{index}].page must be >= 1")

    _require_number(
        item.get("x_normalized"),
        f"feedback_items[{index}].x_normalized",
        minimum=0.0,
        maximum=1.0,
    )
    _require_number(
        item.get("y_normalized"),
        f"feedback_items[{index}].y_normalized",
        minimum=0.0,
        maximum=1.0,
    )

    comment = item.get("comment")
    if not isinstance(comment, str) or not comment.strip():
        raise ContractValidationError(
            f"feedback_items[{index}].comment must be a non-empty string"
        )


def validate_contract_version(payload: Dict[str, Any]) -> bool:
    """Validate that payload matches the supported v1 annotation contract.

    Args:
        payload: JSON payload with annotation_contract_version field.

    Returns:
        True if valid.

    Raises:
        ContractValidationError: If the payload is missing required fields or
            uses unsupported metadata.
    """
    if not isinstance(payload, dict):
        raise ContractValidationError("Contract payload must be an object")

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

    rendered_annotations = payload.get("rendered_annotations")
    if rendered_annotations is not None:
        if not isinstance(rendered_annotations, list):
            raise ContractValidationError("rendered_annotations must be an array")
        try:
            for item in rendered_annotations:
                PDFAnnotation.model_validate(item)
        except ValidationError as exc:
            raise ContractValidationError(
                "rendered_annotations failed validation"
            ) from exc
        return True

    feedback_items = payload.get("feedback_items")
    if feedback_items is None:
        raise ContractValidationError("Missing required field: feedback_items")
    if not isinstance(feedback_items, list):
        raise ContractValidationError("feedback_items must be an array")

    for index, item in enumerate(feedback_items):
        _validate_feedback_item(item, index)

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
    """Map priority + verdict flag to annotation type.

    All automated annotations use TEXT (point marker / icon) rather than
    highlight overlays so they don't obscure the student's work.
    """
    return AnnotationType.TEXT


def _normalized_to_bbox(
    x_norm: float,
    y_norm: float,
    page_width: float,
    page_height: float,
    kind: AnnotationType,
) -> BBox:
    """Convert normalized coordinates to a BBox in visual top-left page space.

    Args:
        x_norm: Horizontal position 0.0-1.0 (left to right).
        y_norm: Vertical position 0.0-1.0 (top to bottom, web convention).
        page_width: Page width in points.
        page_height: Page height in points.
        kind: Annotation type (affects bbox dimensions).

    Returns:
        BBox in the same top-left coordinate space consumed by PDFAnnotator.
    """
    x = x_norm * page_width
    y = y_norm * page_height

    if kind == AnnotationType.TEXT:
        # Text notes are point annotations; give them a small bbox
        half = _TEXT_NOTE_SIZE / 2
        return BBox(
            x0=max(0, x - half),
            y0=max(0, y - half),
            x1=min(page_width, x + half),
            y1=min(page_height, y + half),
        )
    else:
        # Highlights/squiggly: horizontal strip
        _MIN_DIM = 1.0  # minimum 1pt to avoid zero-width/height at edges
        x0 = max(0, x)
        x1 = min(page_width, x + _HIGHLIGHT_WIDTH)
        y0 = max(0, y - _HIGHLIGHT_HEIGHT / 2)
        y1 = min(page_height, y + _HIGHLIGHT_HEIGHT / 2)
        # Clamp inward so highlights at the page edge still have visible area
        if x1 - x0 < _MIN_DIM:
            x0 = max(0, x1 - _MIN_DIM)
        if y1 - y0 < _MIN_DIM:
            y0 = max(0, y1 - _MIN_DIM)
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
        # Assign icons based on verdict/priority:
        #   PASS  -> Check  (green checkmark)
        #   FAIL  -> Help   (red question mark)
        #   other -> Comment (amber note)
        verdict = str(item.get("verdict", "")).upper()
        if verdict == "PASS" or priority == "low":
            icon = "Check"
        elif verdict == "FAIL" or priority == "high":
            icon = "Help"
        else:
            icon = "Comment"

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
            item,
            page_width=width,
            page_height=height,
            grader_name=grader_name,
        )
        # Override page_index with clamped value
        annot.page_index = page_index
        annotations.append(annot)

    return annotations


def payload_to_annotations(
    payload: Dict[str, Any],
    page_dimensions: List[Tuple[float, float]],
    grader_name: Optional[str] = None,
) -> List[PDFAnnotation]:
    """Materialize PDF annotations from a validated contract payload."""
    rendered_annotations = payload.get("rendered_annotations")

    if rendered_annotations is not None:
        # rendered_annotations path: only validate version/coordinate_space,
        # feedback_items is not required.
        if not isinstance(payload, dict):
            raise ContractValidationError("Contract payload must be an object")
        version = payload.get("annotation_contract_version")
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
        if not isinstance(rendered_annotations, list):
            raise ContractValidationError("rendered_annotations must be an array")
        try:
            return [PDFAnnotation.model_validate(item) for item in rendered_annotations]
        except ValidationError as exc:
            raise ContractValidationError(
                "rendered_annotations failed validation"
            ) from exc

    # Normal path: validate everything including feedback_items
    validate_contract_version(payload)

    effective_grader_name = grader_name or payload.get("grader_name")
    return feedback_items_to_annotations(
        payload["feedback_items"],
        page_dimensions,
        grader_name=effective_grader_name,
    )
