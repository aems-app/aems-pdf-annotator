"""Regressions for duplicate stable IDs escaping through PDFAnnotator.save."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata


@pytest.fixture
def pdf_path(tmp_path: Path) -> Path:
    path = tmp_path / "source.pdf"
    with fitz.open() as doc:
        doc.new_page()
        doc.new_page()
        doc.save(path)
    return path


@pytest.mark.parametrize("destination", ["original", "existing", "new"])
@pytest.mark.parametrize(
    "identity_format,second_page,second_source",
    [
        ("encoded", 0, "AI"),
        ("encoded", 1, "HUMAN"),
        ("raw", 1, "AI"),
        ("legacy_subject", 0, "HUMAN"),
        ("legacy_id", 1, "AI"),
        ("type_subject", 0, "AI"),
    ],
)
def test_duplicate_stable_ids_refuse_save_without_changing_disk(
    pdf_path: Path,
    tmp_path: Path,
    destination: str,
    identity_format: str,
    second_page: int,
    second_source: str,
) -> None:
    """Repaint copies must fail loudly, retaining every comment and stored byte."""
    output = pdf_path if destination == "original" else tmp_path / "output.pdf"
    if destination == "existing":
        output.write_bytes(pdf_path.read_bytes())
    source_before = pdf_path.read_bytes()
    output_before = output.read_bytes() if output.exists() else None

    with PDFAnnotator(pdf_path) as annotator:
        for page_index, source in [(0, "AI"), (second_page, second_source)]:
            page = annotator.doc[page_index]
            annotation = page.add_rect_annot(fitz.Rect(72, 72, 90, 90))
            annotation.set_info(content=f"{source} verdict")
            if identity_format == "encoded":
                subject = _encode_subject_metadata("shared-id", source, is_verdict=True)
            elif identity_format == "legacy_subject":
                subject = f"shared-id|{source}|V"
            elif identity_format == "raw":
                subject = "shared-id"
            else:
                subject = "Text" if identity_format == "type_subject" else ""
                annotator.doc.xref_set_key(annotation.xref, "NM", "(shared-id)")
            annotation.set_info(subject=subject)
            annotation.update()

        rows = [
            row
            for page_index in range(annotator.doc.page_count)
            for row in annotator.get_annotations_on_page(page_index)
        ]
        assert len({row["id"] for row in rows}) == 2
        assert [row["stable_id"] for row in rows] == ["shared-id", "shared-id"]

        with pytest.raises(RuntimeError, match="Duplicate annotation stable ID") as error:
            annotator.save(output)

        from aems_pdf_annotator import DuplicateAnnotationIdError

        assert type(error.value) is DuplicateAnnotationIdError
        assert error.value.stable_id == "shared-id"
        assert sum(len(list(annotator.doc[i].annots())) for i in range(2)) == 2

    assert pdf_path.read_bytes() == source_before
    if output_before is None:
        assert not output.exists()
    else:
        assert output.read_bytes() == output_before


@pytest.mark.parametrize("overwrite", [False, True])
def test_unique_stable_ids_save(pdf_path: Path, tmp_path: Path, overwrite: bool) -> None:
    output = pdf_path if overwrite else tmp_path / "unique.pdf"
    with PDFAnnotator(pdf_path) as annotator:
        for page_index, source in enumerate(["AI", "HUMAN"]):
            page = annotator.doc[page_index]
            annotation = page.add_text_annot((72, 72), f"{source} verdict")
            annotation.set_info(
                subject=_encode_subject_metadata(f"id-{page_index}", source)
            )
            annotation.update()
        assert annotator.save(output) == output

    with PDFAnnotator(output) as reopened:
        assert [reopened.get_annotations_on_page(i)[0]["stable_id"] for i in range(2)] == [
            "id-0", "id-1"
        ]


@pytest.mark.parametrize("subject", ["", "Text"])
def test_annotations_without_stable_ids_are_ignored(pdf_path: Path, subject: str) -> None:
    with PDFAnnotator(pdf_path) as annotator:
        for page_index in range(2):
            page = annotator.doc[page_index]
            annotation = page.add_rect_annot(fitz.Rect(72, 72, 90, 90))
            annotation.set_info(content="External comment")
            annotation.set_info(subject=subject)
            annotation.update()
            annotator.doc.xref_set_key(annotation.xref, "NM", "null")
            assert annotator.get_annotations_on_page(page_index)[0]["stable_id"] == ""
        annotator.save()

    with fitz.open(pdf_path) as reopened:
        assert sum(len(list(reopened[i].annots())) for i in range(2)) == 2
