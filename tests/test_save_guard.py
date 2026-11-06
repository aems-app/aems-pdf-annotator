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


@pytest.mark.parametrize("explicit_count,refused", [(0, False), (1, False), (2, True)])
@pytest.mark.parametrize(
    "subjects", [
        ("AEMS|HUMAN|synthetic", "AEMS|AI|synthetic"),
        ("AEMS", "AEMS"),
        ("", "Text"),
        ("AEMS#invalid", "AEMS#invalid"),
        ("#QUk=", "#QUk="),
    ],
)
def test_legacy_pdf_save_counts_only_explicit_subject_ids(
    tmp_path: Path, subjects: tuple[str, str], explicit_count: int, refused: bool
) -> None:
    """Legacy placeholders must not block saves (AEMS phase-B5 booklet shape)."""
    path = tmp_path / "legacy.pdf"
    # phase_b4_support.booklet: four pages, notes on pages 0/3, legacy AI/HUMAN subjects.
    with fitz.open() as doc:
        for index in range(4):
            page = doc.new_page(width=300, height=400)
            if index in (0, 3):
                annotation = page.add_text_annot((10, 10), "Synthetic annotation")
                annotation.set_info(subject=subjects[index // 3])
                annotation.update()
                # Exercise the reader's legacy /NM fallback as well.
                doc.xref_set_key(annotation.xref, "NM", "(AEMS)")
        doc.save(path)

    before = path.read_bytes()
    with PDFAnnotator(path) as annotator:
        for index in range(explicit_count):
            page = annotator.doc[index]
            annotation = page.add_text_annot((40, 40), "Explicit verdict")
            annotation.set_info(subject=_encode_subject_metadata("AEMS", "AI"))
            annotation.update()
        if refused:
            from aems_pdf_annotator import DuplicateAnnotationIdError

            with pytest.raises(DuplicateAnnotationIdError) as error:
                annotator.save()
            assert error.value.stable_id == "AEMS"
            assert path.read_bytes() == before
        else:
            assert annotator.save() == path

    with fitz.open(path) as reopened:
        assert sum(len(list(page.annots())) for page in reopened) == (
            2 if refused else 2 + explicit_count
        )
