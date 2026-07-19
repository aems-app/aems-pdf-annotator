"""Wire contract validation and feedback-item-to-annotation conversion."""

import logging
import math
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
    if not math.isfinite(numeric):
        raise ContractValidationError(f"{field_name} must be a finite number")
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


def _priority_to_kind(
    priority: str, is_verdict: bool, has_highlight_quads: bool = False
) -> AnnotationType:
    """Map priority + verdict flag to annotation type.

    Body comments that resolve to a phrase on a text-layer page carry per-line
    ``highlight_quads`` and are rendered as HIGHLIGHT overlays anchored to the
    phrase (comment attached to the highlight). Verdict markers (right-margin
    summary icons) and any item without resolved quads keep the TEXT point marker
    so they never obscure student work where no phrase could be located.
    """
    if has_highlight_quads and not is_verdict:
        return AnnotationType.HIGHLIGHT
    return AnnotationType.TEXT


def _normalized_quads_to_bboxes(
    quads: Any, page_width: float, page_height: float
) -> Optional[List[BBox]]:
    """Convert normalized per-line highlight quads to page-point BBoxes.

    Each quad is ``[x0, y0, x1, y1]`` in visual top-left normalized space (0..1).
    Malformed or degenerate quads are dropped defensively (grading must never
    crash on a slightly-off coordinate); returns ``None`` if none survive.
    """
    if not isinstance(quads, (list, tuple)) or not quads:
        return None

    result: List[BBox] = []
    for quad in quads:
        if not isinstance(quad, (list, tuple)) or len(quad) < 4:
            continue
        try:
            xs = (float(quad[0]), float(quad[2]))
            ys = (float(quad[1]), float(quad[3]))
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(v) for v in xs + ys):
            continue

        x0 = max(0.0, min(1.0, min(xs))) * page_width
        x1 = max(0.0, min(1.0, max(xs))) * page_width
        y0 = max(0.0, min(1.0, min(ys))) * page_height
        y1 = max(0.0, min(1.0, max(ys))) * page_height
        # Guarantee a minimum visible extent at page edges. When the quad
        # clamps to the FAR edge (x0 == page_width), expanding x1 alone still
        # yields a zero-width box — pull the origin back inside the page first
        # so the box always has positive area.
        if x1 - x0 < 1.0:
            x0 = max(0.0, min(x0, page_width - 1.0))
            x1 = min(page_width, x0 + 1.0)
        if y1 - y0 < 1.0:
            y0 = max(0.0, min(y0, page_height - 1.0))
            y1 = min(page_height, y0 + 1.0)
        result.append(BBox(x0=x0, y0=y0, x1=x1, y1=y1))

    return result or None


def _union_bbox(quads: List[BBox]) -> BBox:
    """Return the bounding box that covers all per-line highlight quads."""
    return BBox(
        x0=min(q.x0 for q in quads),
        y0=min(q.y0 for q in quads),
        x1=max(q.x1 for q in quads),
        y1=max(q.y1 for q in quads),
    )


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

    # A resolved prose quote on a text-layer page arrives with per-line
    # ``highlight_quads`` (normalized, top-left). When present on a non-verdict
    # item, render a HIGHLIGHT anchored to the phrase; otherwise fall back to the
    # TEXT margin icon at the point coordinate.
    quad_bboxes = _normalized_quads_to_bboxes(
        item.get("highlight_quads"), page_width, page_height
    )
    has_quads = quad_bboxes is not None and not is_verdict
    kind = _priority_to_kind(priority, is_verdict, has_highlight_quads=has_quads)

    quads: Optional[List[BBox]]
    if kind == AnnotationType.HIGHLIGHT and quad_bboxes:
        quads = quad_bboxes
        bbox = _union_bbox(quad_bboxes)
    else:
        quads = None
        x_norm = float(item.get("x_normalized", 0.1))
        y_norm = float(item.get("y_normalized", 0.5))
        bbox = _normalized_to_bbox(x_norm, y_norm, page_width, page_height, kind)

    anchor_text_raw = item.get("anchor_text")
    anchor_text = (
        anchor_text_raw.strip() or None
        if isinstance(anchor_text_raw, str)
        else None
    )

    icon = item.get("icon")
    if icon is None and kind in (AnnotationType.TEXT, AnnotationType.HIGHLIGHT):
        # Verdict markers carry the per-task summary glyph (Star=PASS,
        # Help=FAIL/UNCERTAIN/PARTIAL or high-priority). Body comments
        # default to Comment, but when the LLM emitted an explicit
        # FAIL/UNCERTAIN/PARTIAL verdict for the per-check item, lift
        # the glyph to Help so the icon matches the comment's tone
        # (2026-05-06 SE1020-2025 bench audit Defect 4: every body
        # annotation across all 8 PDFs shipped with `icon=Comment`,
        # including bodies whose rationale clearly explained a deduction).
        verdict = str(item.get("verdict", "")).upper()
        if is_verdict:
            if verdict in {"FAIL", "UNCERTAIN", "PARTIAL"} or priority == "high":
                icon = "Help"
            else:
                icon = "Star"
        elif verdict in {"FAIL", "UNCERTAIN", "PARTIAL"}:
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
        quads=quads,
        anchor_text=anchor_text,
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
        requested_page_index = int(page_1based) - 1
        page_index = max(0, min(requested_page_index, max_page - 1))
        if page_index != requested_page_index:
            logger.warning(
                "feedback item page %s out of range; clamped to page %s",
                page_1based,
                page_index + 1,
            )

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
