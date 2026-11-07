"""Missing icons must follow the owner's vocabulary, independent of colour."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.contract import feedback_item_to_annotation
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata


@pytest.mark.parametrize("verdict", ["PASS", "FAIL", "UNCERTAIN", "PARTIAL", "", " uncertain "])
@pytest.mark.parametrize("is_verdict", [False, True])
@pytest.mark.parametrize("priority", ["low", "high"])
@pytest.mark.parametrize("explicit_icon", [None, "Circle"])
def test_contract_missing_icon_uses_owner_rule(
    verdict: str, is_verdict: bool, priority: str, explicit_icon: str | None,
) -> None:
    item = {
        "verdict": verdict, "is_verdict": is_verdict, "priority": priority,
        "comment": "Feedback", "icon": explicit_icon,
    }
    annotation = feedback_item_to_annotation(item, page_width=612, page_height=792)
    expected = "Star" if is_verdict else (
        "Help" if verdict.strip().upper() == "UNCERTAIN" else "Comment"
    )
    assert annotation.icon == (explicit_icon or expected)


@pytest.mark.parametrize("identity", ["body", "summary", "verdict"])
@pytest.mark.parametrize("stroke", [(1, 0, 0), (0, 1, 0), (1, 0.65, 0)])
@pytest.mark.parametrize("explicit_icon", [None, "Circle"])
def test_pdf_read_missing_icon_uses_owner_rule(
    tmp_path: Path, identity: str, stroke: tuple[float, float, float],
    explicit_icon: str | None,
) -> None:
    path = tmp_path / "legacy.pdf"
    with fitz.open() as document:
        page = document.new_page()
        note = page.add_text_annot((72, 72), "Feedback")
        note.set_colors(stroke=stroke)
        note.set_info(subject=_encode_subject_metadata(
            "legacy-id", "AI", check_id="Q1_SUMMARY" if identity == "summary" else "Q1-1",
            is_verdict=identity == "verdict", icon=explicit_icon,
        ))
        note.update()
        document.save(path)

    with PDFAnnotator(path) as annotator:
        row, = annotator.get_annotations_on_page(0)
        assert row["icon"] == (explicit_icon or ("Comment" if identity == "body" else "Star"))
