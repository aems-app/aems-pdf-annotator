"""Legacy subject identity, native fields and namespace survive every mutation path."""

from pathlib import Path
from typing import Any

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _decode_subject_metadata, _encode_subject_metadata


KINDS = ["text", "textbox", "highlight", "drawing"]
OPERATIONS = ["source", "verdict", "edit", "move"]
IDENTITIES = ["legacy_subject", "name", "id", "explicit", "delimiter_name", "delimiter_id", "anonymous"]


def _create_annotation(page: Any, kind: str) -> Any:
    if kind == "text":
        return page.add_text_annot((50, 50), "Original synthetic comment", icon="Comment")
    if kind == "textbox":
        return page.add_freetext_annot(fitz.Rect(50, 50, 220, 100), "Original synthetic comment", fontsize=11)
    if kind == "highlight":
        annotation = page.add_highlight_annot(fitz.Rect(50, 50, 180, 75))
    else:
        annotation = page.add_ink_annot([[(50, 50), (100, 90)]])
    annotation.set_info(content="Original synthetic comment")
    return annotation


def _set_native_identity(document: Any, annotation: Any, identity: str) -> str | None:
    native_id = "native-id"
    native_name = "Comment"
    subject = ""
    if identity == "legacy_subject":
        subject = "legacy-review-id|AI"
        expected = "legacy-review-id"
    elif identity == "explicit":
        subject = _encode_subject_metadata("canonical-explicit-id", "AI")
        expected = "canonical-explicit-id"
    elif identity == "name":
        expected = native_name
    elif identity == "delimiter_name":
        native_name = "native-name|#id"
        expected = native_name
    elif identity in ("id", "delimiter_id"):
        native_name = ""
        native_id = "native|id#suffix" if identity == "delimiter_id" else native_id
        expected = native_id
    else:
        native_id = ""
        native_name = ""
        expected = None
    # set_info may allocate a native NM if it is absent, so clear/set the final
    # raw fields afterwards when constructing truly anonymous fixture objects.
    annotation.set_info(subject=subject)
    document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(native_id) if native_id else "null")
    pdf_name = "/" + native_name.replace("#", "#23").replace("|", "#7C")
    document.xref_set_key(annotation.xref, "Name", pdf_name if native_name else "null")
    return expected


def _changes(kind: str, operation: str) -> dict[str, Any]:
    if operation == "source":
        return {"new_source": "HUMAN"}
    if operation == "verdict":
        return {"new_is_verdict": True}
    if operation == "move":
        return {"new_page_index": 1}
    if kind == "highlight":
        return {"new_quads": [[50, 50, 200, 75]]}
    if kind == "drawing":
        return {"new_stroke_color_rgb": [20, 30, 40]}
    return {"new_content": "Edited synthetic comment"}


def _native_fields(document: Any, xref: int) -> dict[str, tuple[str, str]]:
    return {key: document.xref_get_key(xref, key) for key in ("NM", "Name")}


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("identity", IDENTITIES)
def test_every_annotation_mutation_retains_legacy_and_native_identities(
    tmp_path: Path, kind: str, operation: str, identity: str,
) -> None:
    """Subject, Name and NM may all differ; preserving one must not overwrite another."""
    source = tmp_path / "legacy-native-fields.pdf"
    destination = tmp_path / "updated-native-fields.pdf"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.new_page(width=300, height=400)
        page = document[0]
        annotation = _create_annotation(page, kind)
        expected_id = _set_native_identity(document, annotation, identity)
        document.save(source)
    with PDFAnnotator(source) as writer:
        before = writer.get_annotations_on_page(0)[0]
        if expected_id is None:
            assert not before["stable_id"]
        else:
            assert before["stable_id"] == expected_id
        old_fields = _native_fields(writer.doc, before["xref"])
        result = writer.update_annotation(str(before["xref"]), **_changes(kind, operation))
        assert result[0] if isinstance(result, tuple) else result
        page_index = 1 if operation == "move" else 0
        after = writer.get_annotations_on_page(page_index)[0]
        if expected_id is None:
            assert after["stable_id"], "anonymous mutation did not create a usable identity"
        else:
            assert after["stable_id"] == expected_id, "mutation changed the reader's legacy identity"
        assert _native_fields(writer.doc, after["xref"]) == old_fields, "mutation overwrote native NM/Name fields"
        page = writer.doc[page_index]
        metadata = _decode_subject_metadata(next(page.annots()).info["subject"])
        assert metadata["has_explicit_stable_id"] == (identity in ("explicit", "anonymous")), (
            "mutation changed implicit/explicit identity namespace"
        )
        writer.save(destination)
    with PDFAnnotator(destination) as reader:
        row = reader.get_annotations_on_page(page_index)[0]
        assert row["stable_id"] == after["stable_id"]
        assert _native_fields(reader.doc, row["xref"]) == old_fields


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("operation", ["source", "edit", "move"])
def test_unencodable_malformed_legacy_subject_refuses_update_without_touching_file(
    tmp_path: Path, kind: str, operation: str,
) -> None:
    """A malformed hash prefix with a reserved pipe cannot become a valid legacy pipe ID."""
    source = tmp_path / "malformed-legacy-subject.pdf"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.new_page(width=300, height=400)
        page = document[0]
        annotation = _create_annotation(page, kind)
        # A one-character base64 payload really fails decoding. Punctuation-only
        # payloads may decode as empty and become explicit under legacy parsing.
        annotation.set_info(subject="bad|legacy#x")
        document.save(source)
    original_bytes = source.read_bytes()
    with PDFAnnotator(source) as writer:
        row = writer.get_annotations_on_page(0)[0]
        assert row["stable_id"] == "bad|legacy"
        page = writer.doc[0]
        assert not _decode_subject_metadata(next(page.annots()).info["subject"])["has_explicit_stable_id"]
        result = writer.update_annotation(str(row["xref"]), **_changes(kind, operation))
        assert not (result[0] if isinstance(result, tuple) else result), (
            "unencodable malformed subject was silently rewritten"
        )
    assert source.read_bytes() == original_bytes
