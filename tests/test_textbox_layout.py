"""L1b: saved freetext must wrap all content into the visible PDF page.

The synthetic fixture captures actual editor rectangles at three display scales,
on portrait, landscape and small pages. It contains no student material.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from aems_pdf_annotator import (
    AnnotationColor,
    AnnotationSource,
    AnnotationType,
    BBox,
    PDFAnnotation,
    PDFAnnotator,
)
from aems_pdf_annotator._fitz import fitz


CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "textbox-measurements.json").read_text(encoding="utf-8")
)


def _assert_visible(path: Path, text: str, page_index: int = 0) -> None:
    """Metadata, rendered glyph text and geometry are separate assertions."""
    with fitz.open(path) as document:
        page = document[page_index]
        annotation = next(page.annots())
        assert annotation.info["content"] == text, "stored textbox content changed"
        visible = "".join(annotation.get_text().split())
        expected = "".join(text.split())
        assert visible == expected, "saved textbox appearance clips comment text"
        # Rectangles are unrotated; extracted words are in rotated display space.
        rect_bounds = page.rect * page.derotation_matrix
        assert rect_bounds.contains(annotation.rect), "textbox extends beyond page"
        word_bounds = page.rect + (-0.01, -0.01, 0.01, 0.01)
        assert all(
            word_bounds.contains(fitz.Rect(word[:4])) for word in annotation.get_text("words")
        ), "visible textbox words extend beyond page"


def _model(rect: list[float], text: str) -> PDFAnnotation:
    return PDFAnnotation(
        page_index=0,
        kind=AnnotationType.TEXTBOX,
        color=AnnotationColor.RED,
        source=AnnotationSource.HUMAN,
        comment=text,
        grader_name="Synthetic Reviewer",
        bbox=BBox.from_list(rect),
    )


@pytest.mark.parametrize("case_index", range(len(CASES)))
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_editor_rectangles_save_all_visible_text(
    tmp_path: Path, case_index: int, rotation: int,
) -> None:
    case = CASES[case_index]
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        document.new_page(width=case["width"], height=case["height"]).set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(case["rect"], case["text"]))
        writer.save(target)
    _assert_visible(target, case["text"])


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("operation", ["add", "edit", "move"])
@pytest.mark.parametrize("text", [
    "Detailed explanation " * 12 + "FINALWORD",
    "LongUnbrokenWord" * 12 + "FINALWORD",
])
def test_edge_creation_edit_and_move_keep_entire_comment_visible(
    tmp_path: Path, rotation: int, operation: str, text: str,
) -> None:
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=400).set_rotation(rotation)
        document.save(source)
    model = _model([220, 378, 296, 396], "Draft" if operation == "edit" else text)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(model)
        if operation == "edit":
            assert writer.update_annotation(model.id, new_content=text)
        elif operation == "move":
            assert writer.update_annotation(model.id, new_page_index=1)
        writer.save(target)
    _assert_visible(target, text, page_index=1 if operation == "move" else 0)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize("cropped", [False, True])
@pytest.mark.parametrize(("text", "rect"), [
    ("", [50, 50, 110, 80]),
    ("First line\n\nSecond line FINALWORD\n", [220, 300, 270, 370]),
    ("Text at negative origin FINALWORD", [-30, -20, 80, 10]),
    ("Text beyond right bottom FINALWORD", [295, 395, 360, 440]),
])
def test_crop_newlines_empty_and_offpage_rectangles(
    tmp_path: Path, rotation: int, cropped: bool, text: str, rect: list[float],
) -> None:
    source = tmp_path / "source.pdf"
    target = tmp_path / "saved.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        if cropped:
            page.set_cropbox(fitz.Rect(20, 30, 280, 370))
        page.set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(rect, text))
        writer.save(target)
    _assert_visible(target, text)


@pytest.mark.parametrize(
    "kind,changes",
    [
        ("textbox", {"new_content": "Updated synthetic text FINALWORD"}),
        ("textbox", {"new_rect": (60, 60, 180, 100)}),
        ("textbox", {"new_stroke_color_rgb": [20, 30, 40]}),
        ("drawing", {"new_stroke_color_rgb": [20, 30, 40]}),
        ("highlight", {"new_quads": [[50, 50, 180, 75]]}),
    ],
    ids=["textbox-content", "textbox-geometry", "textbox-colour", "drawing", "highlight"],
)
@pytest.mark.parametrize("identity_field", ["id", "name"])
def test_legacy_recreation_retains_reader_identity_for_later_edit_and_delete(
    tmp_path: Path, kind: str, changes: dict[str, Any], identity_field: str,
) -> None:
    """Recreating a legacy annotation must not orphan its existing client identity."""
    source = tmp_path / "legacy.pdf"
    stable_id = f"legacy-{kind}-identity"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        if kind == "textbox":
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 170, 100), "Original synthetic text", fontsize=11,
            )
        elif kind == "drawing":
            annotation = page.add_ink_annot([[(50, 50), (100, 90)]])
        else:
            annotation = page.add_highlight_annot(fitz.Rect(50, 50, 150, 75))
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(stable_id))
        if identity_field == "name":
            document.xref_set_key(annotation.xref, "Name", f"/{stable_id}")
        assert annotation.info[identity_field] == stable_id
        assert not annotation.info["subject"]
        document.save(source)
    with PDFAnnotator(source) as writer:
        before = writer.get_annotations_on_page(0)[0]
        assert before["stable_id"] == stable_id
        result = writer.update_annotation(stable_id, **changes)
        assert isinstance(result, tuple) and result[0] is True
        after = writer.get_annotations_on_page(0)[0]
        assert after["stable_id"] == stable_id, "recreation changed the legacy client identity"
        assert writer.find_annotation_by_id(stable_id) is not None
        followup = writer.update_annotation(stable_id, new_content="Follow-up synthetic text")
        assert followup[0] if isinstance(followup, tuple) else followup
        assert writer.delete_annotation(stable_id)
        assert writer.get_annotations_on_page(0) == []


@pytest.mark.parametrize("identity_field", ["id", "name"])
def test_recreating_repeated_legacy_ids_does_not_promote_them_to_explicit_ids(
    tmp_path: Path, identity_field: str,
) -> None:
    """Legacy NM/name values may repeat across pages without violating the save guard."""
    from aems_pdf_annotator.core import _decode_subject_metadata

    source = tmp_path / "repeated-legacy.pdf"
    destination = tmp_path / "edited-legacy.pdf"
    stable_id = "legacy-shared-identity"
    with fitz.open() as document:
        for index in range(2):
            page = document.new_page(width=300, height=400)
            annotation = page.add_freetext_annot(
                fitz.Rect(50, 50, 180, 100), f"Synthetic page {index}", fontsize=11,
            )
            backend_id = stable_id if identity_field == "id" else f"legacy-backend-{index}"
            document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(backend_id))
            if identity_field == "name":
                document.xref_set_key(annotation.xref, "Name", f"/{stable_id}")
            assert annotation.info[identity_field] == stable_id
        document.save(source)
    with PDFAnnotator(source) as writer:
        for index in range(2):
            row = writer.get_annotations_on_page(index)[0]
            assert row["stable_id"] == stable_id
            # Duplicate fallback ids are ambiguous on their own: the existing xref
            # identifies the intended page's annotation for its first mutation.
            result = writer.update_annotation(
                str(row["xref"]), new_content=f"Updated synthetic page {index}",
            )
            assert isinstance(result, tuple) and result[0] is True
            updated = writer.get_annotations_on_page(index)[0]
            assert updated["stable_id"] == stable_id, "recreation replaced a legacy fallback id"
            page = writer.doc[index]
            metadata = _decode_subject_metadata(next(page.annots()).info["subject"])
            assert not metadata["has_explicit_stable_id"], "implicit duplicate was promoted to explicit"
        writer.save(destination)
    with PDFAnnotator(destination) as reader:
        rows = [reader.get_annotations_on_page(index)[0] for index in range(2)]
        assert [row["stable_id"] for row in rows] == [stable_id, stable_id]
        assert [row["content"] for row in rows] == [
            "Updated synthetic page 0", "Updated synthetic page 1",
        ]


def test_anonymous_textbox_recreation_assigns_an_editable_stable_identity(tmp_path: Path) -> None:
    """An annotation with no existing identity needs a new one during recreation."""
    source = tmp_path / "anonymous.pdf"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 180, 100), "Anonymous synthetic text", fontsize=11,
        )
        document.xref_set_key(annotation.xref, "NM", "null")
        document.xref_set_key(annotation.xref, "Name", "null")
        assert not annotation.info.get("id")
        assert not annotation.info.get("name")
        assert not annotation.info.get("subject")
        document.save(source)
    with PDFAnnotator(source) as writer:
        before = writer.get_annotations_on_page(0)[0]
        assert not before["stable_id"]
        result = writer.update_annotation(str(before["xref"]), new_content="Updated synthetic text")
        assert isinstance(result, tuple) and result[0] is True
        after = writer.get_annotations_on_page(0)[0]
        stable_id = after["stable_id"]
        assert stable_id, "anonymous recreation must assign a usable identity"
        followup = writer.update_annotation(stable_id, new_content="Follow-up synthetic text")
        assert followup[0] if isinstance(followup, tuple) else followup
        assert writer.delete_annotation(stable_id)
        assert writer.get_annotations_on_page(0) == []


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_precomputed_inpage_box_keeps_its_rectangle_for_caller_font_layout(
    tmp_path: Path, rotation: int,
) -> None:
    """Managed writers precompute geometry and may set their own font after creation."""
    source = tmp_path / "managed-layout.pdf"
    saved = tmp_path / "managed-saved.pdf"
    requested = fitz.Rect(24, 24, 571, 818)
    text = "\n".join(f"Line {index}: Keep the complete feedback." for index in range(80))
    with fitz.open() as document:
        document.new_page(width=595, height=842).set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(list(requested), text))
        page = writer.doc[0]
        annotation = next(page.annots())
        assert tuple(annotation.rect) == pytest.approx(tuple(requested), abs=0.01), (
            "shared writer moved a precomputed in-page feedback rectangle"
        )
        annotation.update(fontsize=6.5)
        writer.save(saved)
    _assert_visible(saved, text)


@pytest.mark.parametrize("width", [0.5, 1.0])
def test_narrow_nonempty_textbox_uses_positive_font_and_keeps_its_text(
    tmp_path: Path, width: float,
) -> None:
    source = tmp_path / "narrow.pdf"
    saved = tmp_path / "narrow-saved.pdf"
    with fitz.open() as document:
        document.new_page(width=300, height=400)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model([50, 50, 50 + width, 100], "A"))
        page = writer.doc[0]
        annotation = next(page.annots())
        default_appearance = writer.doc.xref_get_key(annotation.xref, "DA")[1]
        font_match = re.search(r"([\d.]+)\s+Tf", default_appearance)
        assert font_match is not None
        font_size = float(font_match.group(1))
        assert font_size > 0, "narrow textbox selected a zero font"
        assert fitz.get_text_length("A", fontsize=font_size) <= annotation.rect.width + 0.01, (
            "zero fitted font fell back to a native font that cannot fit the narrow box"
        )
        writer.save(saved)
    _assert_visible(saved, "A")


@pytest.mark.parametrize("lookup", ["xref", "stable_id"])
@pytest.mark.parametrize("changes", [{"new_source": "AI"}, {"new_is_verdict": True}])
def test_legacy_identity_remains_implicit_after_source_or_verdict_only_update(
    tmp_path: Path, lookup: str, changes: dict[str, Any],
) -> None:
    from aems_pdf_annotator.core import _decode_subject_metadata

    source = tmp_path / "legacy-retag.pdf"
    stable_id = "legacy-retag-identity"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = page.add_freetext_annot(fitz.Rect(50, 50, 180, 100), "Original", fontsize=11)
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(stable_id))
        document.save(source)
    with PDFAnnotator(source) as writer:
        result = writer.update_annotation(stable_id, new_content="Updated")
        assert isinstance(result, tuple) and result[0] is True
        row = writer.get_annotations_on_page(0)[0]
        assert row["stable_id"] == stable_id
        identifier = str(row["xref"]) if lookup == "xref" else stable_id
        assert writer.update_annotation(identifier, **changes)
        updated = writer.get_annotations_on_page(0)[0]
        assert updated["stable_id"] == stable_id, "retagging replaced the implicit legacy identity"
        page = writer.doc[0]
        metadata = _decode_subject_metadata(next(page.annots()).info["subject"])
        assert not metadata["has_explicit_stable_id"], "retagging promoted an implicit legacy id"


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_valid_page_edge_rectangle_is_not_inset(tmp_path: Path, rotation: int) -> None:
    source = tmp_path / "edge-valid.pdf"
    saved = tmp_path / "edge-valid-saved.pdf"
    requested = fitz.Rect(0, 0, 100, 40)
    with fitz.open() as document:
        document.new_page(width=300, height=400).set_rotation(rotation)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(_model(list(requested), "Edge text"))
        page = writer.doc[0]
        annotation = next(page.annots())
        assert tuple(annotation.rect) == pytest.approx(tuple(requested), abs=0.01), (
            "valid page-edge textbox was shifted by an unconditional inset"
        )
        assert annotation.info["content"] == "Edge text"
        assert "".join(annotation.get_text().split()) == "Edgetext"
        # Font word boxes include an ascender overhang beyond actual ink. At the
        # page edge, compare rendered pixels with the same box translated inward
        # rather than rejecting that metric overhang as a clipped glyph.
        control = fitz.Rect(120, 120, 220, 160)
        assert writer.add_annotation(_model(list(control), "Edge text"))
        edge_pixels = page.get_pixmap(
            matrix=fitz.Matrix(2, 2), clip=requested * page.rotation_matrix, annots=True,
        )
        control_pixels = page.get_pixmap(
            matrix=fitz.Matrix(2, 2), clip=control * page.rotation_matrix, annots=True,
        )
        assert (edge_pixels.width, edge_pixels.height) == (control_pixels.width, control_pixels.height)
        assert edge_pixels.samples == control_pixels.samples, "page edge clips native text pixels"
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == "Edge text"
        assert "".join(annotation.get_text().split()) == "Edgetext"


@pytest.mark.parametrize("text_color", [(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)])
@pytest.mark.parametrize("operation", ["content", "geometry", "move", "empty"])
def test_native_freetext_colour_survives_recreation_without_aems_metadata(
    tmp_path: Path, text_color: tuple[float, float, float], operation: str,
) -> None:
    source = tmp_path / "native-colour.pdf"
    stable_id = "legacy-native-colour"
    with fitz.open() as document:
        for _ in range(2):
            document.new_page(width=300, height=400)
        page = document[0]
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 220, 100), "Native colour", fontsize=11, text_color=text_color,
        )
        document.xref_set_key(annotation.xref, "NM", fitz.get_pdf_str(stable_id))
        document.save(source)
    changes = {
        "content": {"new_content": "Edited native colour"},
        "geometry": {"new_rect": (60, 60, 230, 110)},
        "move": {"new_page_index": 1},
        "empty": {"new_content": ""},
    }[operation]
    with PDFAnnotator(source) as writer:
        result = writer.update_annotation(stable_id, **changes)
        assert isinstance(result, tuple) and result[0] is True
        page = writer.doc[1 if operation == "move" else 0]
        annotation = next(page.annots())
        default_appearance = writer.doc.xref_get_key(annotation.xref, "DA")[1]
        rgb = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", default_appearance)
        assert rgb is not None, "native colour missing from the default appearance"
        assert tuple(float(value) for value in rgb.groups()) == pytest.approx(text_color), (
            "recreation replaced native FreeText colour with black"
        )
        if operation != "empty":
            colors = [
                span["color"]
                for block in annotation.get_text("dict")["blocks"]
                for line in block.get("lines", [])
                for span in line["spans"]
            ]
            expected_color = sum(round(component * 255) << shift for component, shift in zip(
                text_color, (16, 8, 0),
            ))
            assert colors and set(colors) == {expected_color}, "painted native colour changed"


def _native_colour_fixture(page: Any, text: str, appearance: str | None) -> Any:
    annotation = page.add_freetext_annot(fitz.Rect(50, 50, 220, 100), text, fontsize=11)
    if appearance is not None:
        page.parent.xref_set_key(annotation.xref, "DA", fitz.get_pdf_str(appearance))
        annotation.update()
    else:
        # Retain MuPDF's black appearance stream but remove the optional DA entry.
        page.parent.xref_set_key(annotation.xref, "DA", "null")
    return annotation


@pytest.mark.parametrize("appearance", [None, "/Helv 11 Tf .4 g", "/Helv 11 Tf 0 1 1 0 k"])
@pytest.mark.parametrize("empty", [False, True])
def test_native_default_gray_and_cmyk_colour_survive_empty_and_nonempty_recreation(
    tmp_path: Path, appearance: str | None, empty: bool,
) -> None:
    """Use a native letter's painted colour as oracle, including empty comments."""
    with fitz.open() as oracle_document:
        page = oracle_document.new_page(width=300, height=400)
        oracle = _native_colour_fixture(page, "A", appearance)
        expected_color = oracle.get_text("dict")["blocks"][0]["lines"][0]["spans"][0]["color"]
        if appearance is not None:
            assert expected_color != 0, "native coloured fixture unexpectedly painted black"
    source = tmp_path / "native-colour-space.pdf"
    original_text = "" if empty else "Native colour-space text"
    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        annotation = _native_colour_fixture(page, original_text, appearance)
        xref = annotation.xref
        document.save(source)
    with PDFAnnotator(source) as writer:
        result = writer.update_annotation(str(xref), new_rect=(60, 60, 230, 110))
        assert isinstance(result, tuple) and result[0] is True
        page = writer.doc[0]
        updated = next(page.annots())
        assert updated.info["content"] == original_text
        # A separate native scratch letter using the resulting DA observes empty
        # comments without implementing RGB/gray/CMYK conversion in the oracle.
        resulting_da = writer.doc.xref_get_key(updated.xref, "DA")[1]
        with fitz.open() as probe_document:
            probe_page = probe_document.new_page(width=300, height=400)
            probe = _native_colour_fixture(probe_page, "A", resulting_da)
            actual_color = probe.get_text("dict")["blocks"][0]["lines"][0]["spans"][0]["color"]
        assert all(
            abs(((actual_color >> shift) & 255) - ((expected_color >> shift) & 255)) <= 1
            for shift in (16, 8, 0)
        ), "recreation changed native gray/CMYK/default colour"


def test_impossible_text_layout_fails_before_creating_a_freetext_annotation() -> None:
    """An invalid layout must not become a zero-font annotation using native defaults."""
    from aems_pdf_annotator.core import _add_fitted_textbox

    with fitz.open() as document:
        page = document.new_page(width=300, height=400)
        with pytest.raises(ValueError, match="(?i)(fit|layout|font)"):
            _add_fitted_textbox(page, fitz.Rect(50, 50, 50, 90), "A", (0.0, 0.0, 0.0))
        assert not list(page.annots() or []), "invalid layout created a FreeText annotation"
