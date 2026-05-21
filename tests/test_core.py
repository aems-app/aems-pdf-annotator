# tests/test_core.py
import pytest
from pathlib import Path
from unittest.mock import MagicMock
from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import (
    PDFAnnotator,
    _encode_subject_metadata,
    _decode_subject_metadata,
    _format_pdf_datetime,
    _infer_check_id,
    _looks_like_check_id,
    _normalize_pdf_author_name,
    _pdf_rect_to_pymupdf,
    _pymupdf_rect_to_pdf,
    ANNOTATION_TYPE_NAMES,
)
from aems_pdf_annotator.models import (
    PDFAnnotation, BBox, AnnotationColor, AnnotationType, AnnotationSource,
)


@pytest.fixture
def sample_pdf(tmp_path) -> Path:
    """Create a minimal single-page PDF for testing."""
    pdf_path = tmp_path / "test.pdf"
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # US Letter
    page.insert_text((72, 72), "Sample exam answer text here.", fontsize=12)
    doc.save(str(pdf_path))
    doc.close()
    return pdf_path


class TestCoordinateConversion:
    def test_pymupdf_to_pdf_round_trip(self):
        page_height = 792.0
        pdf_rect = (100, 600, 200, 700)  # bottom-left origin
        pymupdf_rect = _pdf_rect_to_pymupdf(pdf_rect, page_height)
        assert pymupdf_rect[0] == 100  # x0 unchanged
        assert pymupdf_rect[2] == 200  # x1 unchanged

    def test_pdf_to_pymupdf(self):
        page_height = 792.0
        pdf_rect = (50, 100, 200, 300)
        result = _pdf_rect_to_pymupdf(pdf_rect, page_height)
        assert result == (50, 792 - 300, 200, 792 - 100)

    def test_round_trip_pymupdf_to_pdf_to_pymupdf(self):
        """Verify that converting PyMuPDF -> PDF -> PyMuPDF gives back original."""
        page_height = 792.0
        # Create a fitz.Rect to simulate PyMuPDF rect
        original = fitz.Rect(50, 100, 200, 300)
        pdf_coords = _pymupdf_rect_to_pdf(original, page_height)
        back = _pdf_rect_to_pymupdf(pdf_coords, page_height)
        assert abs(back[0] - original.x0) < 0.001
        assert abs(back[1] - original.y0) < 0.001
        assert abs(back[2] - original.x1) < 0.001
        assert abs(back[3] - original.y1) < 0.001


class TestMetadataEncoding:
    def test_encode_decode_round_trip(self):
        encoded = _encode_subject_metadata(
            "abc-123", "AI",
            check_id="Q1-1",
            original_source="AI",
            is_verdict=True,
        )
        decoded = _decode_subject_metadata(encoded)
        assert decoded["stable_id"] == "abc-123"
        assert decoded["check_id"] == "Q1-1"
        assert decoded["source"] == "AI"
        assert decoded["is_verdict"] is True

    def test_encode_drawing_metadata(self):
        encoded = _encode_subject_metadata(
            "draw-1", "HUMAN",
            drawing_style="pen",
            stroke_width=2.0,
            stroke_opacity=1.0,
            stroke_color_rgb=[255, 0, 0],
        )
        decoded = _decode_subject_metadata(encoded)
        assert decoded["drawing_style"] == "pen"
        assert decoded["stroke_width"] == 2.0
        assert decoded["stroke_color_rgb"] == [255, 0, 0]

    def test_encode_textbox_metadata(self):
        encoded = _encode_subject_metadata(
            "tb-1", "AI",
            textbox_color_rgb=[0, 128, 255],
        )
        decoded = _decode_subject_metadata(encoded)
        assert decoded["textbox_color_rgb"] == [0, 128, 255]

    def test_decode_empty_string(self):
        decoded = _decode_subject_metadata("")
        assert decoded["stable_id"] is None
        assert decoded["source"] is None

    def test_decode_plain_id(self):
        decoded = _decode_subject_metadata("some-uuid-here")
        assert decoded["stable_id"] == "some-uuid-here"
        assert decoded["source"] is None

    def test_decode_ignores_unknown_legacy_original_source_tokens(self):
        decoded = _decode_subject_metadata("legacy-id|AI|surprise|C:Q1-1")
        assert decoded["stable_id"] == "legacy-id"
        assert decoded["source"] == "AI"
        assert decoded["original_source"] is None
        assert decoded["check_id"] == "Q1-1"

    def test_uuid_like_stable_id_is_not_treated_as_check_id(self):
        stable_id = "c8e2181b-151f-4d6c-bb69-5a0aaeda6314"
        assert _looks_like_check_id(stable_id) is False
        assert _infer_check_id(stable_id, "Plain comment") is None


class TestAuthorNormalization:
    def test_strips_role_suffix(self):
        assert _normalize_pdf_author_name("Alice Smith (Teacher)") == "Alice Smith"

    def test_preserves_plain_name(self):
        assert _normalize_pdf_author_name("Bob Jones") == "Bob Jones"

    def test_strips_swedish_role(self):
        assert _normalize_pdf_author_name("Erik Svensson (Lid)") == "Erik Svensson"

    def test_empty_string(self):
        assert _normalize_pdf_author_name("") == ""

    def test_whitespace_only(self):
        assert _normalize_pdf_author_name("   ") == ""


class TestFormatPdfDatetime:
    def test_format_produces_valid_prefix(self):
        result = _format_pdf_datetime()
        assert result.startswith("D:")

    def test_format_with_utc(self):
        from datetime import datetime, timezone
        dt = datetime(2026, 3, 12, 14, 30, 0, tzinfo=timezone.utc)
        result = _format_pdf_datetime(dt)
        assert result == "D:20260312143000+00'00'"


class TestAnnotationTypeNames:
    def test_contains_common_types(self):
        assert "Highlight" in ANNOTATION_TYPE_NAMES
        assert "Text" in ANNOTATION_TYPE_NAMES
        assert "Ink" in ANNOTATION_TYPE_NAMES


class TestPDFAnnotator:
    def test_add_highlight(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            result = annotator.add_annotation(PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=50, x1=200, y1=80),
                kind=AnnotationType.HIGHLIGHT,
                color=AnnotationColor.GREEN,
                comment="Correct",
                grader_name="Test Grader",
            ))
            assert result is True
            output = annotator.save(sample_pdf.parent / "out.pdf")
        assert output.exists()

    def test_add_squiggly(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            result = annotator.add_annotation(PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=100, x1=200, y1=130),
                kind=AnnotationType.SQUIGGLY,
                color=AnnotationColor.RED,
                comment="Error",
                grader_name="Test Grader",
            ))
            assert result is True
            output = annotator.save(sample_pdf.parent / "out.pdf")
        doc = fitz.open(str(output))
        page = doc[0]
        annots = list(page.annots())
        assert len(annots) >= 1
        doc.close()

    def test_add_text_note(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            result = annotator.add_annotation(PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=200, x1=80, y1=230),
                kind=AnnotationType.TEXT,
                color=AnnotationColor.AMBER,
                comment="Needs review",
                grader_name="Test Grader",
            ))
            assert result is True
            output = annotator.save(sample_pdf.parent / "out.pdf")
        assert output.exists()

    def test_add_drawing(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            result = annotator.add_annotation(PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=300, x1=200, y1=350),
                kind=AnnotationType.DRAWING,
                color=AnnotationColor.RED,
                drawing_style="pen",
                points=[[50, 300], [100, 320], [200, 350]],
                stroke_width=2.0,
                stroke_opacity=1.0,
                grader_name="Test Grader",
            ))
            assert result is True
            output = annotator.save(sample_pdf.parent / "out.pdf")
        assert output.exists()

    def test_invalid_page_index(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            result = annotator.add_annotation(PDFAnnotation(
                page_index=99,
                bbox=BBox(x0=50, y0=50, x1=200, y1=80),
                kind=AnnotationType.HIGHLIGHT,
                color=AnnotationColor.GREEN,
            ))
            assert result is False

    def test_file_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            PDFAnnotator(tmp_path / "nonexistent.pdf")

    def test_invalid_pdf_magic_raises_value_error(self, tmp_path):
        bad_pdf = tmp_path / "not-really-a-pdf.pdf"
        bad_pdf.write_text("plain text", encoding="utf-8")

        with pytest.raises(ValueError, match="Not a PDF file"):
            PDFAnnotator(bad_pdf)

    def test_add_annotations_batch(self, sample_pdf):
        annotations = [
            PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=50 + i * 40, x1=200, y1=80 + i * 40),
                kind=AnnotationType.HIGHLIGHT,
                color=AnnotationColor.GREEN,
                comment=f"Item {i}",
                grader_name="Batch Grader",
            )
            for i in range(3)
        ]
        with PDFAnnotator(sample_pdf) as annotator:
            count = annotator.add_annotations(annotations)
            assert count == 3
            output = annotator.save(sample_pdf.parent / "out.pdf")
        doc = fitz.open(str(output))
        assert len(list(doc[0].annots())) == 3
        doc.close()

    def test_context_manager_closes(self, sample_pdf):
        """Verify the context manager properly closes the document."""
        annotator = PDFAnnotator(sample_pdf)
        assert annotator.doc is not None
        annotator.close()
        assert annotator.doc is None

    def test_save_to_same_path(self, sample_pdf):
        """Verify incremental save when output_path matches pdf_path."""
        with PDFAnnotator(sample_pdf) as annotator:
            annotator.add_annotation(PDFAnnotation(
                page_index=0,
                bbox=BBox(x0=50, y0=50, x1=200, y1=80),
                kind=AnnotationType.HIGHLIGHT,
                color=AnnotationColor.GREEN,
                grader_name="Grader",
            ))
            output = annotator.save()  # Save to same path
        assert output == sample_pdf
        assert output.exists()

    def test_get_annotations_on_page(self, sample_pdf):
        """Verify reading back annotations from a page."""
        with PDFAnnotator(sample_pdf) as annotator:
            annotator.add_annotation(PDFAnnotation(
                id="Q4-06",
                page_index=0,
                bbox=BBox(x0=50, y0=50, x1=200, y1=80),
                kind=AnnotationType.HIGHLIGHT,
                color=AnnotationColor.GREEN,
                comment="Test comment",
                check_id="Q4-06",
                grader_name="Reader Grader",
            ))
            annots = annotator.get_annotations_on_page(0)
            assert len(annots) >= 1
            entry = next(annot for annot in annots if annot.get("check_id") == "Q4-06")
            assert entry["check_id"] == "Q4-06"
            assert entry["task_id"] == "Q4"

    def test_get_annotations_on_page_uses_check_id_not_uuid_prefix(self, sample_pdf):
        """Rubric IDs must survive PDF round-tripping even when stable IDs are UUIDs."""
        with PDFAnnotator(sample_pdf) as annotator:
            annotator.add_annotation(PDFAnnotation(
                id="c8e2181b-151f-4d6c-bb69-5a0aaeda6314",
                page_index=0,
                bbox=BBox(x0=50, y0=120, x1=200, y1=150),
                kind=AnnotationType.TEXT,
                color=AnnotationColor.GREEN,
                comment="Anchored by rubric ID",
                check_id="Q1-1",
                grader_name="Reader Grader",
            ))
            annots = annotator.get_annotations_on_page(0)
            entry = next(
                annot
                for annot in annots
                if annot.get("content", "").endswith("Anchored by rubric ID")
            )
            assert entry["check_id"] == "Q1-1"
            assert entry["task_id"] == "Q1"

    def test_update_annotation_rect_uses_top_left_coordinates(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            annotator.add_annotation(PDFAnnotation(
                id="ann-top-left",
                page_index=0,
                bbox=BBox(x0=50, y0=50, x1=200, y1=80),
                kind=AnnotationType.TEXTBOX,
                color=AnnotationColor.GREEN,
                comment="Move me",
                grader_name="Reader Grader",
                stroke_color_rgb=[0, 0, 0],
            ))

            updated = annotator.update_annotation(
                "ann-top-left",
                new_rect=(60, 60, 210, 90),
            )

            assert updated is True
            page = annotator.doc[0]
            moved = next(page.annots())
            assert moved.rect.x0 == pytest.approx(60, abs=0.5)
            assert moved.rect.y0 == pytest.approx(60, abs=0.5)

    def test_delete_annotation_refreshes_by_xref_with_load_annot(self, sample_pdf):
        """Deletion should reload by xref directly instead of scanning all annotations."""
        with PDFAnnotator(sample_pdf) as annotator:
            page = MagicMock()
            loaded_annot = MagicMock()
            loaded_annot.xref = 321
            stale_annot = MagicMock()
            stale_annot.xref = 321
            annotator.doc = MagicMock()
            annotator.doc.__getitem__.return_value = page
            page.load_annot.return_value = loaded_annot
            annotator._find_annotation = MagicMock(return_value=(0, stale_annot))

            assert annotator.delete_annotation("321") is True
            page.load_annot.assert_called_once_with(321)
            page.delete_annot.assert_called_once_with(loaded_annot)

    def test_find_annotation_by_id_does_not_suffix_match_colon_ids(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            page = MagicMock()
            annot = MagicMock()
            annot.info = {"subject": "uuid:1"}
            annot.xref = None
            page.annots.return_value = [annot]
            annotator.doc = MagicMock()
            annotator.doc.page_count = 1
            annotator.doc.__getitem__.return_value = page

            assert annotator.find_annotation_by_id("1") is None

    def test_extract_ink_points_skips_malformed_points(self, sample_pdf):
        with PDFAnnotator(sample_pdf) as annotator:
            annot = MagicMock()
            valid_point = MagicMock()
            valid_point.x = 10
            valid_point.y = 20
            annot.vertices = [[valid_point, object(), (30, 40)]]

            points = annotator._extract_ink_points_pdf(annot, 100)

            assert points == [[10.0, 80.0], [30.0, 60.0]]
