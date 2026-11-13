"""F1: a duplicate legacy NM must never redirect mutation to an unrelated annotation."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata

SHARED_NM = "fitz-A3"


def _pdf(path: Path, *, duplicate_implicit: bool) -> list[int]:
    xrefs = []
    with fitz.open() as document:
        count = 4 if duplicate_implicit else 3
        for _ in range(count):
            document.new_page(width=300, height=400)
        for index in range(count):
            page = document[index]
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 220, 100),
                f"ORIGINAL-{index}",
                fontsize=11,
            )
            if index < 2:
                annotation.set_info(
                    subject=_encode_subject_metadata(f"explicit-{index}", "HUMAN")
                )
            document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(SHARED_NM))
            document.xref_set_key(annotation.xref, "Name", "null")
            xrefs.append(annotation.xref)
        document.save(path)
    return xrefs


@pytest.mark.parametrize("action", ["find", "update", "delete"])
def test_effective_subject_identity_masks_its_unrelated_native_nm(
    tmp_path: Path,
    action: str,
) -> None:
    path = tmp_path / "subject-masks-nm.pdf"
    _pdf(path, duplicate_implicit=False)
    with PDFAnnotator(path) as writer:
        if action == "find":
            located = writer.find_annotation_by_id(SHARED_NM)
            assert (
                located is not None and located[0] == 2
            ), "native alias shadowed a different effective identity"
        elif action == "update":
            assert writer.update_annotation(SHARED_NM, new_content="EDITED-TARGET")
            assert (
                writer.get_annotations_on_page(0)[0]["content"] == "ORIGINAL-0"
            ), "editing an NM-only target changed an explicit-ID sibling"
            assert writer.get_annotations_on_page(2)[0]["content"] == "EDITED-TARGET"
        else:
            assert writer.delete_annotation(SHARED_NM)
            assert (
                len(writer.get_annotations_on_page(0)) == 1
            ), "deleting an NM-only target removed an explicit-ID sibling"
            assert writer.get_annotations_on_page(2) == []


def test_unscoped_ambiguous_implicit_identity_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "ambiguous-nm.pdf"
    _pdf(path, duplicate_implicit=True)
    with PDFAnnotator(path) as writer:
        assert (
            writer.find_annotation_by_id(SHARED_NM) is None
        ), "ambiguous legacy ID selected the first document-wide match"


@pytest.mark.parametrize("action", ["update", "delete"])
def test_composite_xref_disambiguates_duplicate_implicit_identity(
    tmp_path: Path, action: str
) -> None:
    path = tmp_path / "scoped-nm.pdf"
    xrefs = _pdf(path, duplicate_implicit=True)
    identifier = f"xref:{xrefs[3]}|id:{SHARED_NM}"
    with PDFAnnotator(path) as writer:
        if action == "update":
            assert writer.update_annotation(identifier, new_content="EDITED-TARGET")
        else:
            assert writer.delete_annotation(identifier)
        for index in range(3):
            entries = writer.get_annotations_on_page(index)
            assert len(entries) == 1, "scoped mutation removed a different annotation"
            assert (
                entries[0]["content"] == f"ORIGINAL-{index}"
            ), "scoped mutation changed a different annotation"
        if action == "update":
            assert writer.get_annotations_on_page(3)[0]["content"] == "EDITED-TARGET"
        else:
            assert writer.get_annotations_on_page(3) == []


def test_mismatched_implicit_xref_scope_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "mismatched-scope.pdf"
    xrefs = _pdf(path, duplicate_implicit=False)
    with PDFAnnotator(path) as writer:
        assert (
            writer._find_annotation(annotation_id=SHARED_NM, xref=xrefs[0]) is None
        ), "xref scope was accepted despite a different effective subject identity"


def test_explicit_stable_identity_survives_an_obsolete_xref(tmp_path: Path) -> None:
    path = tmp_path / "explicit-stale-xref.pdf"
    xrefs = _pdf(path, duplicate_implicit=False)
    with PDFAnnotator(path) as writer:
        located = writer._find_annotation(annotation_id="explicit-1", xref=xrefs[0])
        assert (
            located is not None and located[0] == 1
        ), "stale xref overrode a unique explicit stable identity"


def test_xref_only_lookup_remains_precise(tmp_path: Path) -> None:
    path = tmp_path / "xref-only.pdf"
    xrefs = _pdf(path, duplicate_implicit=True)
    with PDFAnnotator(path) as writer:
        located = writer.find_annotation_by_xref(xrefs[3])
        assert located is not None and located[0] == 3


@pytest.mark.parametrize("implicit_form", ["native", "subject"])
def test_matching_implicit_xref_wins_over_a_different_explicit_annotation_with_same_id(
    tmp_path: Path,
    implicit_form: str,
) -> None:
    path = tmp_path / "explicit-implicit-collision.pdf"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.new_page(width=300, height=400)
        for index in range(2):
            page = document[index]
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 220, 100),
                f"ORIGINAL-{index}",
                fontsize=11,
            )
            if index == 0:
                annotation.set_info(
                    subject=_encode_subject_metadata("same-id", "HUMAN")
                )
            elif implicit_form == "subject":
                annotation.set_info(subject="same-id|HUMAN")
            document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str("same-id"))
            if index == 1:
                target_xref = annotation.xref
        document.save(path)
    with PDFAnnotator(path) as writer:
        located = writer._find_annotation(annotation_id="same-id", xref=target_xref)
        assert (
            located is not None and located[0] == 1
        ), "unique explicit sibling overrode a matching implicit xref scope"


def test_matching_xref_disambiguates_duplicate_explicit_identity_for_lookup(
    tmp_path: Path,
) -> None:
    """Lookup preserves scope even when a separate save guard will refuse duplicate explicit IDs."""
    path = tmp_path / "explicit-duplicate-lookup.pdf"
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=400)
        for index in range(2):
            page = document[index]
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 220, 100), "Synthetic", fontsize=11
            )
            annotation.set_info(
                subject=_encode_subject_metadata("duplicate-explicit", "HUMAN")
            )
            if index == 1:
                target_xref = annotation.xref
        document.save(path)
    with PDFAnnotator(path) as writer:
        located = writer._find_annotation(
            annotation_id="duplicate-explicit", xref=target_xref
        )
        assert (
            located is not None and located[0] == 1
        ), "duplicate explicit lookup ignored its matching xref"
