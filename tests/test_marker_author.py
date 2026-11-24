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
from aems_pdf_annotator.core import PDFAnnotator, _decode_subject_metadata
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


# --- Markers with no recorded provenance (H1, astra review round 1) -------------------------
#
# Defect class: inferred authorship. A marker whose subject carries no ``source`` /
# ``original_source`` (a pre-provenance AEMS PDF, an external viewer, an imported PDF) was
# treated as AI-created, so any edit, retag, move or replacement rewrote the teacher's ``/T``
# to "AEMS". Provenance must be explicit: with none recorded, the existing author stays, and a
# retag uses the modifier's name -- never "AEMS". Comments stay under their original author.

LEGACY_TEACHER = "Legacy Teacher"
LEGACY_ID = "legacy-1"

_LEGACY_EDITS: dict[str, dict[str, Any]] = {
    "content": {"new_content": "Teacher's own note, edited"},
    "move_rect": {"new_rect": (120, 200, 320, 240)},
    "cross_page": {"new_page_index": 1},
    "quads": {"new_quads": [[60, 60, 200, 80]]},
    "points": {"new_points": [[60.0, 300.0], [90.0, 330.0]]},
}
_LEGACY_CASES = [
    ("text", "content"), ("text", "move_rect"), ("text", "cross_page"),
    ("freetext", "content"), ("freetext", "move_rect"), ("freetext", "cross_page"),
    ("highlight", "content"), ("highlight", "quads"), ("highlight", "cross_page"),
    ("ink", "content"), ("ink", "points"), ("ink", "cross_page"),
]


def _add_legacy(annotator: PDFAnnotator, kind: str) -> None:
    page = annotator.doc[0]
    if kind == "text":
        annot = page.add_text_annot((100, 100), "Teacher's own note")
    elif kind == "freetext":
        annot = page.add_freetext_annot(fitz.Rect(100, 100, 300, 140), "Teacher's own note")
    elif kind == "highlight":
        annot = page.add_highlight_annot(fitz.Rect(70, 60, 250, 76))
    else:
        annot = page.add_ink_annot([[(50.0, 300.0), (120.0, 340.0), (150.0, 310.0)]])
    annot.set_info(title=LEGACY_TEACHER, subject="", content="Teacher's own note")
    annot.set_name(LEGACY_ID)
    annot.update()


def _all_titles(annotator: PDFAnnotator) -> list[str]:
    return [a.info.get("title", "") for p in annotator.doc for a in p.annots()]


def _ok(result: Any) -> bool:
    return bool(result[0] if isinstance(result, tuple) else result)


@pytest.mark.parametrize("kind, edit", _LEGACY_CASES, ids=lambda v: str(v))
@pytest.mark.parametrize(
    "grader, new_source, expected",
    [
        (None, None, LEGACY_TEACHER),
        (LEGACY_TEACHER, "HUMAN", LEGACY_TEACHER),
        (OTHER_TEACHER, "HUMAN", OTHER_TEACHER),
        (OTHER_TEACHER, None, OTHER_TEACHER),
    ],
    ids=["keep", "human-same", "retag-human", "retag"],
)
def test_marker_without_provenance_is_never_relabelled_aems(
    pdf: Path,
    tmp_path: Path,
    kind: str,
    edit: str,
    grader: str | None,
    new_source: str | None,
    expected: str,
) -> None:
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        first = annotator.update_annotation(
            LEGACY_ID, grader_name=grader, new_source=new_source, **_LEGACY_EDITS[edit]
        )
        assert _ok(first)
        assert _all_titles(annotator) == [expected]
        out = reopened(annotator, tmp_path)
    # A second, plain edit must not turn the first edit's stored metadata into "AI" authorship.
    with PDFAnnotator(out) as again:
        (row,) = [r for p in range(2) for r in again.get_annotations_on_page(p)]
        ident = row.get("id") or row.get("annotation_id")
        assert _ok(again.update_annotation(ident, new_content="second edit", grader_name=expected))
        assert _all_titles(again) == [expected]
        assert "AEMS" not in _all_titles(again)


def test_marker_without_provenance_retag_only_uses_the_modifier(pdf: Path) -> None:
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, "text")
        assert _ok(annotator.update_annotation(LEGACY_ID, grader_name=OTHER_TEACHER))
        assert _all_titles(annotator) == [OTHER_TEACHER]


# --- A defaulted source is never stored, reported or echoed back (H1, astra review round 2) --
#
# Defect class: inferred authorship through a defaulted source. The read path reported an
# unrecorded source as "AI"; the review UI echoed that value back as explicit provenance on a
# verdict toggle (and on undo/redo), and the writers stored the same default on a verdict-only
# or colour-only edit. Either way a legacy teacher marker read "AEMS" after one click, or after
# the next edit. An update can never make an existing marker AI-created: AI markers are created
# AI, so an "AI" sent for a marker that records no provenance is an echo, not provenance.

R2_KINDS = ["text", "freetext", "highlight", "ink"]


def _provenance(annotator: PDFAnnotator) -> list[tuple[str, Any, Any]]:
    rows = []
    for page in annotator.doc:
        for annot in page.annots():
            meta = _decode_subject_metadata(annot.info.get("subject", ""))
            rows.append((annot.info.get("title", ""), meta["source"], meta["original_source"]))
    return rows


def _second_edit_keeps_the_teacher(out: Path) -> None:
    """Reopen, edit again as the teacher: the marker still reads the teacher, never AEMS."""
    with PDFAnnotator(out) as again:
        (row,) = [r for p in range(2) for r in again.get_annotations_on_page(p)]
        assert row["source"] in (None, "HUMAN")
        ident = row.get("id") or row.get("annotation_id")
        assert _ok(
            again.update_annotation(ident, new_content="second edit", grader_name=LEGACY_TEACHER)
        )
        ((title, source, original),) = _provenance(again)
        # A second human edit may record the first edit's HUMAN as the origin; never AI.
        assert (title, source) == (LEGACY_TEACHER, "HUMAN")
        assert original in (None, "HUMAN")


@pytest.mark.parametrize("kind", R2_KINDS)
@pytest.mark.parametrize("grader", [None, LEGACY_TEACHER], ids=["no-grader", "grader"])
def test_verdict_only_toggle_on_a_marker_without_provenance_stores_no_source(
    pdf: Path, tmp_path: Path, kind: str, grader: str | None
) -> None:
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        assert _ok(annotator.update_annotation(LEGACY_ID, new_is_verdict=True, grader_name=grader))
        assert _provenance(annotator) == [(LEGACY_TEACHER, None, None)]
        (row,) = annotator.get_annotations_on_page(0)
        assert row["is_verdict"] is True
        out = reopened(annotator, tmp_path)
    _second_edit_keeps_the_teacher(out)


@pytest.mark.parametrize("kind", ["ink", "freetext"])
def test_colour_only_change_on_a_marker_without_provenance_keeps_the_teacher(
    pdf: Path, tmp_path: Path, kind: str
) -> None:
    """A colour change is a human edit: it transfers to HUMAN, recording no invented origin."""
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        assert _ok(annotator.update_annotation(LEGACY_ID, new_stroke_color_rgb=[0, 0, 255]))
        assert _provenance(annotator) == [(LEGACY_TEACHER, "HUMAN", None)]
        out = reopened(annotator, tmp_path)
    _second_edit_keeps_the_teacher(out)


@pytest.mark.parametrize("kind", R2_KINDS)
def test_read_path_reports_no_source_for_a_marker_without_provenance(pdf: Path, kind: str) -> None:
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        (row,) = annotator.get_annotations_on_page(0)
        assert row["source"] is None
        assert row["original_source"] is None


@pytest.mark.parametrize("kind", R2_KINDS)
@pytest.mark.parametrize("echoed", ["read-path", "stale-ai"])
def test_echoed_source_on_a_verdict_toggle_keeps_the_teacher(
    pdf: Path, tmp_path: Path, kind: str, echoed: str
) -> None:
    """The UI sends back the source it was shown (or a stale "AI" from an older client)."""
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        (row,) = annotator.get_annotations_on_page(0)
        source = row["source"] if echoed == "read-path" else "AI"
        assert _ok(
            annotator.update_annotation(
                LEGACY_ID, new_is_verdict=True, new_source=source, grader_name=LEGACY_TEACHER
            )
        )
        assert _provenance(annotator) == [(LEGACY_TEACHER, None, None)]
        out = reopened(annotator, tmp_path)
    _second_edit_keeps_the_teacher(out)


@pytest.mark.parametrize("kind", R2_KINDS)
def test_echoed_ai_source_on_an_edit_of_a_marker_without_provenance_keeps_the_teacher(
    pdf: Path, tmp_path: Path, kind: str
) -> None:
    """An undo/redo replays the stale "AI" together with a real edit: still a human edit."""
    with PDFAnnotator(pdf) as annotator:
        _add_legacy(annotator, kind)
        assert _ok(
            annotator.update_annotation(
                LEGACY_ID, new_content="restored", new_source="AI", grader_name=LEGACY_TEACHER
            )
        )
        assert _all_titles(annotator) == [LEGACY_TEACHER]
        out = reopened(annotator, tmp_path)
    _second_edit_keeps_the_teacher(out)


def test_explicit_ai_source_on_a_recorded_ai_marker_still_reads_aems(pdf: Path) -> None:
    """Reverting a teacher-edited AI marker to AI (recorded origin AI) stays AEMS."""
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(AnnotationType.TEXT, "ai-rev", human=False, grader=None))
        assert _ok(annotator.update_annotation("ai-rev", new_content="edited", grader_name=TEACHER))
        assert _provenance(annotator) == [("AEMS", "HUMAN", "AI")]
        assert _ok(annotator.update_annotation("ai-rev", new_content="feedback", new_source="AI"))
        assert _provenance(annotator) == [("AEMS", "AI", "AI")]


@pytest.mark.parametrize(
    "kind", [AnnotationType.DRAWING, AnnotationType.TEXTBOX], ids=lambda k: k.name
)
def test_colour_only_change_on_an_ai_marker_transfers_ownership(
    pdf: Path, kind: AnnotationType
) -> None:
    """Pre-existing gap: an RGB-only recolour was not a human edit, so ownership never moved."""
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(kind, "ai-rgb", human=False, grader=TEACHER))
        assert _ok(
            annotator.update_annotation(
                "ai-rgb", new_stroke_color_rgb=[0, 0, 255], grader_name=TEACHER
            )
        )
        assert _provenance(annotator) == [("AEMS", "HUMAN", "AI")]


@pytest.mark.parametrize(
    "kind", [AnnotationType.DRAWING, AnnotationType.TEXTBOX], ids=lambda k: k.name
)
def test_same_colour_rgb_on_an_ai_marker_is_not_an_edit(pdf: Path, kind: AnnotationType) -> None:
    rgb = [0, 0, 255]
    with PDFAnnotator(pdf) as annotator:
        annotator.add_annotation(make(kind, "ai-same", human=False, grader=TEACHER))
        assert _ok(annotator.update_annotation("ai-same", new_stroke_color_rgb=rgb, new_source="AI"))
        assert _ok(annotator.update_annotation("ai-same", new_stroke_color_rgb=rgb))
        assert _provenance(annotator) == [("AEMS", "AI", "AI")]
