"""The browser must know which identities are globally unique explicit subjects."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata


@pytest.mark.parametrize(
    "identity,expected",
    [
        ("encoded", True),
        ("nm", False),
        ("legacy_subject", False),
        ("anonymous", False),
        ("type_subject", False),
        ("encoded_type_subject", False),
    ],
)
def test_reader_emits_explicit_identity_classification_as_a_real_boolean(
    tmp_path: Path,
    identity: str,
    expected: bool,
) -> None:
    path = tmp_path / "identity-classification.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 220, 100), "Synthetic", fontsize=8
        )
        subjects = {
            "encoded": _encode_subject_metadata("canonical-id", "HUMAN"),
            "legacy_subject": "legacy-id|HUMAN",
            "type_subject": "Text|HUMAN",
            "encoded_type_subject": _encode_subject_metadata("Text", "HUMAN"),
        }
        if identity in subjects:
            annotation.set_info(subject=subjects[identity])
        document.xref_set_key(
            annotation.xref,
            "NM",
            "null" if identity == "anonymous" else fitz.get_pdf_str("native-id"),
        )
        document.xref_set_key(annotation.xref, "Name", "null")
        document.save(path)
    with PDFAnnotator(path) as reader:
        row = reader.get_annotations_on_page(0)[0]
        assert (
            row.get("has_explicit_stable_id") is expected
        ), "wire identity classification is absent or mistakes a native fallback for an explicit ID"
