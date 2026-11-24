"""PDF ``/T`` (author) of markers: AI markers read "AEMS", teacher markers keep the teacher.

Defect class: wrong attribution. The writer stamped the grading account's name on every marker,
including AI-generated ones, so generated text read as personally written by the teacher
(AEMS MASTER 502, owner decision ASTRA_DEC_1124 Q1). Provenance is explicit (``source`` /
``original_source``), never inferred from the comment wording:

* an AI-created marker reads exactly ``AEMS``, whoever the grading account is;
* a teacher-created marker keeps the teacher's (normalised) name;
* an AI marker that a teacher edits stays ``AEMS`` (``source`` becomes HUMAN, the author does not).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator
from aems_pdf_annotator.models import (
    AnnotationColor,
    AnnotationSource,
    AnnotationType,
    BBox,
    PDFAnnotation,
)

TEACHER = "Artem Kulachenko"
OTHER_TEACHER = "Reader Grader"
KINDS = [AnnotationType.TEXT, AnnotationType.TEXTBOX, AnnotationType.HIGHLIGHT]


@pytest.fixture
def pdf(tmp_path: Path) -> Path:
    path = tmp_path / "base.pdf"
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "Sample exam answer text here.", fontsize=12)
    doc.new_page(width=612, height=792)
    doc.save(str(path))
    doc.close()
    return path


def make(kind: AnnotationType, ident: str, *, human: bool, grader: str | None) -> PDFAnnotation:
    source = AnnotationSource.HUMAN if human else AnnotationSource.AI
    extra: dict[str, Any] = {}
    if kind == AnnotationType.DRAWING:
        extra = {"drawing_style": "pen", "points": [[50.0, 300.0], [120.0, 340.0], [150.0, 310.0]]}
    return PDFAnnotation(
        id=ident,
        page_index=0,
        bbox=BBox(x0=50, y0=50, x1=200, y1=80),
        kind=kind,
        color=AnnotationColor.GREEN,
        comment="feedback",
        grader_name=grader,
        source=source,
        original_source=source,
        **extra,
    )


def titles(path_or_annotator: Any, page: int = 0) -> list[str]:
    annotator = path_or_annotator
    return [a.info.get("title", "") for a in annotator.doc[page].annots()]


def reopened(annotator: PDFAnnotator, tmp_path: Path) -> Path:
    out = tmp_path / "out.pdf"
    annotator.doc.save(str(out))
    return out


@pytest.mark.parametrize("kind", KINDS, ids=lambda k: k.name)
def test_ai_created_marker_is_authored_by_aems_not_the_grading_account(
    pdf: Path, tmp_path: Path, kind: AnnotationType
) -> None:
    with PDFAnnotator(pdf) as annotator:
        assert annotator.add_annotation(make(kind, "ai-1", human=False, grader=TEACHER))
        assert titles(annotator) == ["AEMS"]
        out = reopened(annotator, tmp_path)
    with PDFAnnotator(out) as again:
        assert titles(again) == ["AEMS"]
        assert again.get_annotations_on_page(0)[0]["grader_name"] == "AEMS"


def test_ai_created_marker_without_a_grader_name_still_reads_aems(pdf: Path) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(AnnotationType.TEXT, "ai-2", human=False, grader=None))
        assert titles(annotator) == ["AEMS"]


@pytest.mark.parametrize("kind", KINDS, ids=lambda k: k.name)
def test_teacher_created_marker_keeps_the_teachers_name(
    pdf: Path, tmp_path: Path, kind: AnnotationType
) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(kind, "t-1", human=True, grader=f"{TEACHER} (Teacher)"))
        assert titles(annotator) == [TEACHER]
        out = reopened(annotator, tmp_path)
    with PDFAnnotator(out) as again:
        assert titles(again) == [TEACHER]


@pytest.mark.parametrize("kind", KINDS, ids=lambda k: k.name)
@pytest.mark.parametrize("edit", ["content", "move", "page", "color"])
def test_ai_marker_edited_by_a_teacher_stays_aems(
    pdf: Path, tmp_path: Path, kind: AnnotationType, edit: str
) -> None:
    if edit == "color" and kind == AnnotationType.TEXTBOX:
        pytest.skip("the writer does not recolour FreeText (pre-existing limitation)")
    kwargs: dict[str, Any] = {
        "content": {"new_content": "edited by teacher"},
        "move": {"new_rect": (60, 60, 210, 90)},
        "page": {"new_page_index": 1},
        "color": {"new_color": "red"},
    }[edit]
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(kind, "ai-edit", human=False, grader=TEACHER))
        result = annotator.update_annotation("ai-edit", grader_name=OTHER_TEACHER, **kwargs)
        assert result[0] if isinstance(result, tuple) else result
        page = 1 if edit == "page" else 0
        assert titles(annotator, page) == ["AEMS"]
        out = reopened(annotator, tmp_path)
    with PDFAnnotator(out) as again:
        (entry,) = again.get_annotations_on_page(page)
        assert entry["grader_name"] == "AEMS"
        assert entry["original_source"] == "AI"
        assert titles(again, page) == ["AEMS"]


def test_ai_ink_marker_edited_by_a_teacher_stays_aems(pdf: Path) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(AnnotationType.DRAWING, "ai-ink", human=False, grader=TEACHER))
        assert titles(annotator) == ["AEMS"]
        result = annotator.update_annotation(
            "ai-ink",
            grader_name=OTHER_TEACHER,
            new_points=[[50.0, 50.0], [80.0, 70.0]],
        )
        assert result[0] if isinstance(result, tuple) else result
        assert titles(annotator) == ["AEMS"]


def test_teacher_marker_edited_by_another_teacher_is_retagged(pdf: Path) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(AnnotationType.TEXT, "t-edit", human=True, grader=TEACHER))
        annotator.update_annotation("t-edit", new_content="x", grader_name=OTHER_TEACHER)
        assert titles(annotator) == [OTHER_TEACHER]


def test_edit_without_grader_name_keeps_existing_author(pdf: Path) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(AnnotationType.TEXT, "t-keep", human=True, grader=TEACHER))
        annotator.update_annotation("t-keep", new_content="x")
        assert titles(annotator) == [TEACHER]


@pytest.mark.parametrize("human, expected", [(False, "AEMS"), (True, OTHER_TEACHER)])
def test_highlight_quad_replacement_authorship(pdf: Path, human: bool, expected: str) -> None:
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(
            make(AnnotationType.HIGHLIGHT, "hl-q", human=human, grader=TEACHER)
        )
        result = annotator.update_annotation(
            "hl-q", new_quads=[[50, 50, 180, 75]], grader_name=OTHER_TEACHER
        )
        assert result[0] if isinstance(result, tuple) else result
        assert titles(annotator) == [expected]


def _legacy(annotator: PDFAnnotator, ident: str) -> None:
    annot = annotator.doc[0].add_text_annot((60, 60), "legacy")
    annot.set_info(title="Legacy Teacher", subject="", content="legacy")
    annot.set_name(ident)
    annot.update()


def test_marker_without_provenance_is_retagged_not_renamed_aems(pdf: Path) -> None:
    """Legacy markers carry no provenance; AEMS is never inferred for them (ASTRA_DEC_1124 Q1)."""
    with PDFAnnotator(pdf) as annotator:
        _legacy(annotator, "legacy-1")
        annotator.update_annotation("legacy-1", grader_name=OTHER_TEACHER)
        assert titles(annotator) == [OTHER_TEACHER]

