# tests/test_contract.py
import pytest
from aems_pdf_annotator import apply_annotations
from aems_pdf_annotator.contract import (
    CURRENT_CONTRACT_VERSION,
    validate_contract_version,
    feedback_item_to_annotation,
    feedback_items_to_annotations,
    payload_to_annotations,
    ContractValidationError,
)
from aems_pdf_annotator.models import (
    AnnotationType, AnnotationColor, AnnotationSource,
)


class TestContractValidation:
    def test_valid_version(self):
        payload = {
            "annotation_contract_version": 1,
            "coordinate_space": "visual_top_left_normalized_v1",
            "feedback_items": [],
        }
        assert validate_contract_version(payload) is True

    def test_missing_version_raises(self):
        with pytest.raises(ContractValidationError, match="annotation_contract_version"):
            validate_contract_version({})

    def test_unsupported_version_raises(self):
        with pytest.raises(ContractValidationError, match="Unsupported"):
            validate_contract_version({"annotation_contract_version": 99})

    def test_current_version_is_1(self):
        assert CURRENT_CONTRACT_VERSION == 1

    def test_missing_feedback_items_raises(self):
        with pytest.raises(ContractValidationError, match="feedback_items"):
            validate_contract_version(
                {
                    "annotation_contract_version": 1,
                    "coordinate_space": "visual_top_left_normalized_v1",
                }
            )

    def test_invalid_feedback_item_type_raises(self):
        with pytest.raises(ContractValidationError, match=r"feedback_items\[0\]\.page"):
            validate_contract_version(
                {
                    "annotation_contract_version": 1,
                    "coordinate_space": "visual_top_left_normalized_v1",
                    "feedback_items": [
                        {
                            "page": "not-an-int",
                            "x_normalized": 0.1,
                            "y_normalized": 0.2,
                            "comment": "Bad item",
                        }
                    ],
                }
            )

    @pytest.mark.parametrize(
        "bad_value",
        [float("nan"), float("inf"), float("-inf")],
    )
    def test_non_finite_normalized_coords_rejected(self, bad_value):
        with pytest.raises(ContractValidationError, match="finite"):
            validate_contract_version(
                {
                    "annotation_contract_version": 1,
                    "coordinate_space": "visual_top_left_normalized_v1",
                    "feedback_items": [
                        {
                            "page": 1,
                            "x_normalized": bad_value,
                            "y_normalized": 0.5,
                            "comment": "Bad coord",
                        }
                    ],
                }
            )

    def test_rendered_annotations_rejects_non_finite_bbox(self):
        payload = {
            "annotation_contract_version": 1,
            "coordinate_space": "visual_top_left_normalized_v1",
            "rendered_annotations": [
                {
                    "id": "ann-1",
                    "page_index": 0,
                    "bbox": {"x0": float("nan"), "y0": 0, "x1": 10, "y1": 10},
                    "kind": "text",
                    "color": "green",
                }
            ],
        }
        with pytest.raises(ContractValidationError):
            payload_to_annotations(payload, [(612, 792)])


class TestFeedbackItemConversion:
    def test_low_priority_produces_green_text_marker_with_comment_icon(self):
        item = {
            "stable_id": "ann-q1-01",
            "check_id": "Q1-01",
            "page": 1,
            "x_normalized": 0.1,
            "y_normalized": 0.2,
            "comment": "Good work",
            "priority": "low",
            "verdict": "PASS",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.id == "ann-q1-01"
        assert annot.kind == AnnotationType.TEXT
        assert annot.color == AnnotationColor.GREEN
        assert annot.icon == "Comment"
        assert annot.page_index == 0  # 1-based to 0-based
        assert annot.comment == "Good work"
        assert annot.check_id == "Q1-01"

    def test_fail_body_item_uses_help_icon(self):
        # 2026-05-06 bench audit (Hadi SE1020-2025): every body annotation
        # across all 8 PDFs shipped with `icon=Comment`, including FAIL
        # bodies that carried clearly-negative comments ("Saknar
        # kompatibilitet, grovt fel!"). Body items must mirror the verdict
        # marker's gradient: PASS body == Comment, FAIL/UNCERTAIN body == Help.
        item = {
            "check_id": "Q2-03",
            "page": 2,
            "x_normalized": 0.5,
            "y_normalized": 0.6,
            "comment": "Error in derivation",
            "priority": "high",
            "verdict": "FAIL",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.kind == AnnotationType.TEXT
        assert annot.color == AnnotationColor.RED
        assert annot.icon == "Help"
        assert annot.page_index == 1

    def test_uncertain_body_item_uses_help_icon(self):
        item = {
            "page": 1,
            "x_normalized": 0.3,
            "y_normalized": 0.4,
            "comment": "Partially correct",
            "priority": "medium",
            "verdict": "UNCERTAIN",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.kind == AnnotationType.TEXT
        assert annot.color == AnnotationColor.AMBER
        assert annot.icon == "Help"

    def test_unknown_verdict_body_item_keeps_comment_icon(self):
        # No verdict supplied — preserve the legacy default so callers that
        # have not started populating `verdict` on body items do not flip
        # silently. PASS body items stay on Comment too.
        item = {
            "page": 1,
            "x_normalized": 0.3,
            "y_normalized": 0.4,
            "comment": "Partially correct",
            "priority": "medium",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.kind == AnnotationType.TEXT
        assert annot.color == AnnotationColor.AMBER
        assert annot.icon == "Comment"

    def test_verdict_item_produces_text_note(self):
        item = {
            "check_id": "Q1_SUMMARY",
            "page": 1,
            "x_normalized": 0.1,
            "y_normalized": 0.9,
            "comment": "Task 1: 8/10",
            "priority": "low",
            "is_verdict": True,
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.kind == AnnotationType.TEXT
        assert annot.is_verdict is True
        assert annot.icon == "Star"

    def test_verdict_fail_item_uses_help_icon(self):
        item = {
            "check_id": "Q2_SUMMARY",
            "page": 2,
            "x_normalized": 0.4,
            "y_normalized": 0.8,
            "comment": "Task 2: 0/10",
            "priority": "high",
            "verdict": "FAIL",
            "is_verdict": True,
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.kind == AnnotationType.TEXT
        assert annot.icon == "Help"

    def test_grader_name_passed_through(self):
        item = {
            "page": 1,
            "x_normalized": 0.1,
            "y_normalized": 0.2,
            "comment": "OK",
            "priority": "low",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792,
            grader_name="Prof. Smith",
        )
        assert annot.grader_name == "Prof. Smith"

    def test_bbox_calculated_from_normalized_coords(self):
        item = {
            "page": 1,
            "x_normalized": 0.5,
            "y_normalized": 0.5,
            "comment": "Middle of page",
            "priority": "low",
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        # Text marker bbox should be centered around (306, 396).
        assert ((annot.bbox.x0 + annot.bbox.x1) / 2.0) == pytest.approx(306, abs=1)
        assert ((annot.bbox.y0 + annot.bbox.y1) / 2.0) == pytest.approx(396, abs=1)

    def test_unknown_fields_ignored(self):
        item = {
            "page": 1,
            "x_normalized": 0.1,
            "y_normalized": 0.2,
            "comment": "OK",
            "priority": "low",
            "future_field": "should be ignored",
            "another_new_thing": 42,
        }
        annot = feedback_item_to_annotation(
            item, page_width=612, page_height=792
        )
        assert annot.comment == "OK"


class TestBatchConversion:
    def test_multiple_items(self):
        items = [
            {
                "page": 1, "x_normalized": 0.1, "y_normalized": 0.2,
                "comment": "Good", "priority": "low",
            },
            {
                "page": 1, "x_normalized": 0.5, "y_normalized": 0.6,
                "comment": "Bad", "priority": "high",
            },
            {
                "page": 2, "x_normalized": 0.3, "y_normalized": 0.4,
                "comment": "OK", "priority": "medium",
            },
        ]
        page_dimensions = [(612, 792), (612, 792)]
        annotations = feedback_items_to_annotations(items, page_dimensions)
        assert len(annotations) == 3
        assert annotations[0].color == AnnotationColor.GREEN
        assert annotations[1].color == AnnotationColor.RED
        assert annotations[2].page_index == 1

    def test_skips_items_with_no_comment(self):
        items = [
            {"page": 1, "x_normalized": 0.1, "y_normalized": 0.2, "comment": "", "priority": "low"},
            {"page": 1, "x_normalized": 0.5, "y_normalized": 0.6, "comment": "Real feedback", "priority": "high"},
        ]
        annotations = feedback_items_to_annotations(items, [(612, 792)])
        assert len(annotations) == 1

    def test_page_out_of_range_clamped(self):
        items = [
            {"page": 5, "x_normalized": 0.1, "y_normalized": 0.2, "comment": "Test", "priority": "low"},
        ]
        # Only 2 pages available
        annotations = feedback_items_to_annotations(items, [(612, 792), (612, 792)])
        # Should clamp to last valid page
        assert annotations[0].page_index == 1

    def test_page_out_of_range_logs_warning(self, caplog):
        items = [
            {"page": 5, "x_normalized": 0.1, "y_normalized": 0.2, "comment": "Test", "priority": "low"},
        ]
        with caplog.at_level("WARNING"):
            annotations = feedback_items_to_annotations(items, [(612, 792), (612, 792)])

        assert annotations[0].page_index == 1
        assert "out of range" in caplog.text

    def test_visual_top_left_coordinates_render_near_top_of_page(self, tmp_path):
        from aems_pdf_annotator._fitz import fitz

        pdf_path = tmp_path / "submission.pdf"
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 72), "Student answer", fontsize=12)
        doc.save(str(pdf_path))
        doc.close()

        items = [
            {
                "check_id": "Q1_SUMMARY",
                "page": 1,
                "x_normalized": 0.1,
                "y_normalized": 0.1,
                "comment": "Near top",
                "priority": "low",
                "verdict": "PASS",
                "is_verdict": True,
            }
        ]
        annotations = feedback_items_to_annotations(items, [(612, 792)])
        output_path, count = apply_annotations(pdf_path, annotations, tmp_path / "annotated.pdf")

        assert count == 1

        rendered = fitz.open(str(output_path))
        page = rendered[0]
        annots = list(page.annots())
        assert annots[0].rect.y0 < 120
        rendered.close()

    def test_payload_to_annotations_prefers_rendered_annotations(self):
        payload = {
            "annotation_contract_version": 1,
            "coordinate_space": "visual_top_left_normalized_v1",
            "feedback_items": [
                {
                    "page": 1,
                    "x_normalized": 0.1,
                    "y_normalized": 0.2,
                    "comment": "Fallback item",
                }
            ],
            "rendered_annotations": [
                {
                    "id": "ann-1",
                    "page_index": 0,
                    "bbox": {"x0": 10, "y0": 20, "x1": 30, "y1": 40},
                    "kind": "text",
                    "color": "green",
                    "comment": "Exact placement",
                    "source": "AI",
                    "original_source": "AI",
                }
            ],
        }
        annotations = payload_to_annotations(payload, [(612, 792)])
        assert len(annotations) == 1
        assert annotations[0].comment == "Exact placement"
        assert annotations[0].bbox.x0 == 10

    def test_validate_contract_version_accepts_rendered_annotations_only(self):
        payload = {
            "annotation_contract_version": 1,
            "coordinate_space": "visual_top_left_normalized_v1",
            "rendered_annotations": [
                {
                    "id": "ann-1",
                    "page_index": 0,
                    "bbox": {"x0": 10, "y0": 20, "x1": 30, "y1": 40},
                    "kind": "text",
                    "color": "green",
                    "comment": "Exact placement",
                    "source": "AI",
                }
            ],
        }

        assert validate_contract_version(payload) is True
