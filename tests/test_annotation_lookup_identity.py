"""F1: a duplicate legacy NM must never redirect mutation to an unrelated annotation."""

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _encode_subject_metadata

SHARED_NM = "fitz-A3"


@pytest.mark.parametrize("native_prefix", ["id", "xref"])
@pytest.mark.parametrize("action", ["find", "update", "delete"])
def test_composite_native_identity_with_wire_prefix_is_parsed_only_once(
    tmp_path: Path, native_prefix: str, action: str,
) -> None:
    path = tmp_path / "literal-wire-prefix.pdf"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.new_page(width=300, height=400)
        first_page = document[0]
        bystander = first_page.add_freetext_annot(
            fitz.Rect(30, 30, 220, 80), "EXPLICIT-BYSTANDER", fontsize=8,
        )
        bystander.set_info(subject=_encode_subject_metadata("foo", "HUMAN"))
        native_id = "id:foo" if native_prefix == "id" else f"xref:{bystander.xref}"
        page = document[1]
        target = page.add_freetext_annot(
            fitz.Rect(30, 30, 220, 80), "IMPLICIT-TARGET", fontsize=8,
        )
        document.xref_set_key(target.xref, "NM", fitz.get_pdf_str(native_id))
        target_xref = target.xref
        document.save(path)
    with PDFAnnotator(path) as writer:
        identifier = f"xref:{target_xref}|id:{native_id}"
        if action == "find":
            located = writer.find_annotation_by_id(identifier)
            assert located is not None and located[1].xref == target_xref
        elif action == "update":
            assert writer.update_annotation(identifier, new_content="EDITED-TARGET")
        else:
            assert writer.delete_annotation(identifier)
        bystanders = writer.get_annotations_on_page(0)
        assert len(bystanders) == 1, (
            "literal native wire prefix was parsed again and deleted the explicit sibling"
        )
        assert bystanders[0]["content"] == "EXPLICIT-BYSTANDER", (
            "literal native wire prefix was parsed again and redirected to the explicit sibling"
        )
        expected = [] if action == "delete" else [
            "EDITED-TARGET" if action == "update" else "IMPLICIT-TARGET",
        ]
        assert [row["content"] for row in writer.get_annotations_on_page(1)] == expected


def _same_page_pdf(path: Path, *, explicit: bool) -> list[int]:
    """Keep two native objects on one page so ordinal reload must select the second."""
    xrefs = []
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        for index in range(2):
            annotation = page.add_freetext_annot(
                fitz.Rect(30, 30 + index * 70, 220, 80 + index * 70),
                f"ORIGINAL-{index}",
                fontsize=11,
            )
            if explicit:
                annotation.set_info(
                    subject=_encode_subject_metadata(SHARED_NM, "HUMAN")
                )
            document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(SHARED_NM))
            document.xref_set_key(annotation.xref, "Name", "null")
            xrefs.append(annotation.xref)
        document.save(path)
    return xrefs


@pytest.mark.parametrize("action", ["find", "update", "delete"])
def test_same_page_composite_targets_second_duplicate_implicit_object(
    tmp_path: Path,
    action: str,
) -> None:
    path = tmp_path / "same-page-implicit.pdf"
    xrefs = _same_page_pdf(path, explicit=False)
    with PDFAnnotator(path) as writer:
        identifier = f"xref:{xrefs[1]}|id:{SHARED_NM}"
        if action == "find":
            located = writer.find_annotation_by_id(identifier)
            assert (
                located is not None and located[1].xref == xrefs[1]
            ), "same-page lookup reloaded the first ordinal instead of the scoped object"
        elif action == "update":
            assert writer.update_annotation(
                identifier, new_content="EDITED-SECOND"
            ), "same-page composite update did not accept the scoped duplicate target"
        else:
            assert writer.delete_annotation(
                identifier
            ), "same-page composite deletion did not accept the scoped duplicate target"
        entries = writer.get_annotations_on_page(0)
        assert (
            entries[0]["xref"] == xrefs[0]
        ), "same-page operation removed/recreated the first sibling"
        assert (
            entries[0]["content"] == "ORIGINAL-0"
        ), "scoped operation changed the first sibling"
        expected = (
            ["ORIGINAL-0"]
            if action == "delete"
            else [
                "ORIGINAL-0",
                "EDITED-SECOND" if action == "update" else "ORIGINAL-1",
            ]
        )
        assert [entry["content"] for entry in entries] == expected


@pytest.mark.parametrize("namespace", ["id", "xref"])
def test_public_find_accepts_explicit_identity_and_xref_namespaces(
    tmp_path: Path,
    namespace: str,
) -> None:
    path = tmp_path / "public-namespace.pdf"
    xrefs = _pdf(path, duplicate_implicit=False)
    token = "id:explicit-1" if namespace == "id" else f"xref:{xrefs[1]}"
    with PDFAnnotator(path) as writer:
        located = writer.find_annotation_by_id(token)
        assert (
            located is not None and located[0] == 1 and located[1].xref == xrefs[1]
        ), "public namespaced lookup failed to retain the requested identity/scope"


@pytest.mark.parametrize("action", ["find", "update", "delete"])
def test_unscoped_duplicate_explicit_identity_refuses_without_mutating_comments(
    tmp_path: Path,
    action: str,
) -> None:
    path = tmp_path / "ambiguous-explicit.pdf"
    _same_page_pdf(path, explicit=True)
    original = path.read_bytes()
    with PDFAnnotator(path) as writer:
        if action == "find":
            result = writer.find_annotation_by_id(SHARED_NM)
        elif action == "update":
            result = writer.update_annotation(
                SHARED_NM, new_content="MUST-NOT-BE-WRITTEN"
            )
        else:
            result = writer.delete_annotation(SHARED_NM)
        assert (
            not result
        ), "ambiguous explicit identity selected a document-wide first match"
        assert [entry["content"] for entry in writer.get_annotations_on_page(0)] == [
            "ORIGINAL-0",
            "ORIGINAL-1",
        ], "ambiguous lookup dropped or rewrote a comment before save"
    assert path.read_bytes() == original


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


@pytest.mark.parametrize("prefix", ["Note", "Text"])
def test_exact_explicit_prefixed_identity_is_not_reinterpreted_as_a_legacy_alias(
    tmp_path: Path,
    prefix: str,
) -> None:
    path = tmp_path / "prefixed-explicit.pdf"
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=400)
        for index in range(2):
            page = document[index]
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 220, 100), f"ORIGINAL-{index}", fontsize=11
            )
            if index == 0:
                document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str("1"))
            else:
                annotation.set_info(
                    subject=_encode_subject_metadata(f"{prefix}:1", "HUMAN")
                )
        document.save(path)
    with PDFAnnotator(path) as writer:
        assert writer.update_annotation(f"{prefix}:1", new_content="EXPLICIT-EDIT")
        assert (
            writer.get_annotations_on_page(0)[0]["content"] == "ORIGINAL-0"
        ), "explicit prefixed ID edited a legacy numeric alias"
        assert writer.get_annotations_on_page(1)[0]["content"] == "EXPLICIT-EDIT"


@pytest.mark.parametrize("prefix", ["Note", "Text"])
def test_unambiguous_legacy_prefix_alias_remains_supported(
    tmp_path: Path, prefix: str
) -> None:
    path = tmp_path / "legacy-prefixed-alias.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 220, 100), "Original", fontsize=11
        )
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str("1"))
        document.save(path)
    with PDFAnnotator(path) as writer:
        assert writer.update_annotation(f"{prefix}:1", new_content="LEGACY-EDIT")
        assert writer.get_annotations_on_page(0)[0]["content"] == "LEGACY-EDIT"
