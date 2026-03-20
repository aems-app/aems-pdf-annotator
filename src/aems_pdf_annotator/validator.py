"""
Annotation Validator

Validates PDF annotations before writing to ensure:
- Bounding boxes are within page bounds
- Coordinates are properly ordered
- No zero-area rectangles
- Page indices are valid
"""

import logging
from typing import List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

from aems_pdf_annotator.models import PDFAnnotation, BBox

logger = logging.getLogger(__name__)


class BBoxIssueSeverity(str, Enum):
    """Severity of bounding box issue."""

    ERROR = "error"  # Will cause PDF corruption
    WARNING = "warning"  # May cause visual issues
    INFO = "info"  # Informational


@dataclass
class BBoxIssue:
    """Issue found in bounding box validation."""

    severity: BBoxIssueSeverity
    annotation_id: str
    page_index: int
    message: str
    suggestion: Optional[str] = None

    def __str__(self) -> str:
        """Format issue as string."""
        prefix = {
            BBoxIssueSeverity.ERROR: "\u274c",
            BBoxIssueSeverity.WARNING: "\u26a0\ufe0f",
            BBoxIssueSeverity.INFO: "\u2139\ufe0f",
        }[self.severity]

        return f"{prefix} [Page {self.page_index}][{self.annotation_id}] {self.message}"


@dataclass
class AnnotationValidationResult:
    """Result of annotation validation."""

    passed: bool
    issues: List[BBoxIssue]
    annotations_checked: int
    annotations_fixed: int = 0

    @property
    def errors(self) -> List[BBoxIssue]:
        """Get only error-level issues."""
        return [i for i in self.issues if i.severity == BBoxIssueSeverity.ERROR]

    @property
    def warnings(self) -> List[BBoxIssue]:
        """Get only warning-level issues."""
        return [i for i in self.issues if i.severity == BBoxIssueSeverity.WARNING]


class AnnotationValidator:
    """
    Validator for PDF annotations.

    Ensures annotations won't corrupt PDFs or cause visual issues.
    """

    def __init__(
        self,
        page_dimensions: Optional[List[Tuple[float, float]]] = None,
    ):
        """
        Initialize validator.

        Args:
            page_dimensions: List of (width, height) tuples for each page
        """
        self.page_dimensions = page_dimensions or []

    def validate_bbox(
        self, bbox: BBox, page_index: int, annotation_id: str
    ) -> List[BBoxIssue]:
        """
        Validate a bounding box.

        Args:
            bbox: BBox to validate
            page_index: Page index for context
            annotation_id: Annotation ID for context

        Returns:
            List of issues found
        """
        issues = []

        # Check for zero area
        if not bbox.is_valid():
            if bbox.area == 0:
                issues.append(
                    BBoxIssue(
                        severity=BBoxIssueSeverity.ERROR,
                        annotation_id=annotation_id,
                        page_index=page_index,
                        message=f"Zero-area bbox: {bbox.to_rect()}",
                        suggestion="Ensure x1 > x0 and y1 > y0",
                    )
                )
            else:
                issues.append(
                    BBoxIssue(
                        severity=BBoxIssueSeverity.ERROR,
                        annotation_id=annotation_id,
                        page_index=page_index,
                        message=f"Invalid bbox coordinates: {bbox.to_rect()}",
                        suggestion="Coordinates must be properly ordered (x0 < x1, y0 < y1)",
                    )
                )

        # Check for negative coordinates
        if bbox.x0 < 0 or bbox.y0 < 0:
            issues.append(
                BBoxIssue(
                    severity=BBoxIssueSeverity.ERROR,
                    annotation_id=annotation_id,
                    page_index=page_index,
                    message=f"Negative coordinates: {bbox.to_rect()}",
                    suggestion="Coordinates must be non-negative",
                )
            )

        # Check page bounds if dimensions available
        if page_index >= 0 and page_index < len(self.page_dimensions):
            page_width, page_height = self.page_dimensions[page_index]

            if not bbox.is_within_bounds(page_width, page_height):
                issues.append(
                    BBoxIssue(
                        severity=BBoxIssueSeverity.WARNING,
                        annotation_id=annotation_id,
                        page_index=page_index,
                        message=f"BBox outside page bounds: {bbox.to_rect()} (page: {page_width}x{page_height})",
                        suggestion="Coordinates will be clamped to page bounds",
                    )
                )

        # Check for suspiciously small annotations
        if bbox.is_valid() and bbox.area < 1.0:
            issues.append(
                BBoxIssue(
                    severity=BBoxIssueSeverity.INFO,
                    annotation_id=annotation_id,
                    page_index=page_index,
                    message=f"Very small annotation area: {bbox.area:.2f}",
                    suggestion="Annotation may not be visible to users",
                )
            )

        return issues

    def validate_annotation(self, annotation: PDFAnnotation) -> List[BBoxIssue]:
        """
        Validate a single annotation.

        Args:
            annotation: PDFAnnotation to validate

        Returns:
            List of issues found
        """
        issues = []

        # Validate page index
        if annotation.page_index < 0:
            issues.append(
                BBoxIssue(
                    severity=BBoxIssueSeverity.ERROR,
                    annotation_id=annotation.id,
                    page_index=annotation.page_index,
                    message=f"Negative page index: {annotation.page_index}",
                    suggestion="Page index must be >= 0",
                )
            )

        if self.page_dimensions and annotation.page_index >= len(self.page_dimensions):
            issues.append(
                BBoxIssue(
                    severity=BBoxIssueSeverity.ERROR,
                    annotation_id=annotation.id,
                    page_index=annotation.page_index,
                    message=f"Page index {annotation.page_index} exceeds document pages ({len(self.page_dimensions)})",
                    suggestion="Page index must be within document bounds",
                )
            )

        # Validate bounding box
        bbox_issues = self.validate_bbox(
            annotation.bbox, annotation.page_index, annotation.id
        )
        issues.extend(bbox_issues)

        return issues

    def validate_and_fix(
        self, annotations: List[PDFAnnotation], fix_issues: bool = True
    ) -> Tuple[List[PDFAnnotation], AnnotationValidationResult]:
        """
        Validate annotations and optionally fix issues.

        Args:
            annotations: List of annotations to validate
            fix_issues: Whether to automatically fix correctable issues

        Returns:
            Tuple of (fixed_annotations, validation_result)
        """
        issues = []
        fixed_annotations = []
        fixes_applied = 0

        for annotation in annotations:
            annotation_issues = self.validate_annotation(annotation)
            issues.extend(annotation_issues)

            # Try to fix issues if requested
            if fix_issues and annotation_issues:
                fixed_annotation = self._fix_annotation(annotation)
                if fixed_annotation != annotation:
                    fixes_applied += 1
                fixed_annotations.append(fixed_annotation)
            else:
                fixed_annotations.append(annotation)

        # Determine if passed (no errors)
        passed = not any(i.severity == BBoxIssueSeverity.ERROR for i in issues)

        result = AnnotationValidationResult(
            passed=passed,
            issues=issues,
            annotations_checked=len(annotations),
            annotations_fixed=fixes_applied,
        )

        return fixed_annotations, result

    def _fix_annotation(self, annotation: PDFAnnotation) -> PDFAnnotation:
        """
        Attempt to fix annotation issues.

        Args:
            annotation: Annotation to fix

        Returns:
            Fixed annotation (or original if no fix possible)
        """
        # Get page dimensions if available
        if annotation.page_index < len(self.page_dimensions):
            page_width, page_height = self.page_dimensions[annotation.page_index]

            # Clamp bbox to page bounds
            if not annotation.bbox.is_within_bounds(page_width, page_height):
                fixed_bbox = annotation.bbox.clamp_to_bounds(page_width, page_height)

                # Create new annotation with fixed bbox
                return PDFAnnotation(**{**annotation.model_dump(), "bbox": fixed_bbox})

        return annotation

    def print_result(
        self, result: AnnotationValidationResult, verbose: bool = False
    ) -> None:
        """
        Log validation result.

        Args:
            result: Validation result to log
            verbose: Show all issues including info-level
        """
        if result.passed and not result.warnings:
            logger.info(
                "Validated %d annotations - all valid", result.annotations_checked
            )
            if result.annotations_fixed > 0:
                logger.info("Auto-fixed %d annotation(s)", result.annotations_fixed)
            return

        if result.errors:
            logger.error("Errors (%d):", len(result.errors))
            for issue in result.errors[:10]:
                logger.error("  %s", issue)
            if len(result.errors) > 10:
                logger.error("  ... and %d more errors", len(result.errors) - 10)

        if result.warnings:
            logger.warning("Warnings (%d):", len(result.warnings))
            for issue in result.warnings[:10]:
                logger.warning("  %s", issue)
            if len(result.warnings) > 10:
                logger.warning("  ... and %d more warnings", len(result.warnings) - 10)

        if verbose:
            info_issues = [
                i for i in result.issues if i.severity == BBoxIssueSeverity.INFO
            ]
            if info_issues:
                logger.info("Info (%d):", len(info_issues))
                for issue in info_issues:
                    logger.info("  %s", issue)


def validate_annotations(
    annotations: List[PDFAnnotation],
    page_dimensions: Optional[List[Tuple[float, float]]] = None,
    fix_issues: bool = True,
) -> Tuple[List[PDFAnnotation], AnnotationValidationResult]:
    """
    Convenience function to validate and fix annotations.

    Args:
        annotations: List of annotations to validate
        page_dimensions: Optional list of (width, height) for each page
        fix_issues: Whether to auto-fix correctable issues

    Returns:
        Tuple of (fixed_annotations, validation_result)
    """
    validator = AnnotationValidator(page_dimensions=page_dimensions)
    return validator.validate_and_fix(annotations, fix_issues=fix_issues)
