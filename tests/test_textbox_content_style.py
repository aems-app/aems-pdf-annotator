"""Content-only saves retain native geometry/style while fitting genuinely longer text."""

import re
from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator


@pytest.mark.parametrize(
    "overflow", [False, True], ids=["fits-original-11pt", "requires-shrinking"]
)
def test_content_only_save_preserves_native_object_and_style(
    tmp_path: Path,
    overflow: bool,
) -> None:
    source = tmp_path / "native-style.pdf"
    saved = tmp_path / "native-style-edited.pdf"
    text = (
        "Repeated native feedback line.\n" * 12 + "FINALWORD"
        if overflow
        else "Edited short comment."
    )
    with fitz.open() as document:
        page = document.new_page(width=595, height=842)
        annotation = page.add_freetext_annot(
            fitz.Rect(40, 65, 260, 115),
            "Original short comment.",
            fontsize=11,
            fontname="helv",
            text_color=(0, 0, 1),
        )
        annotation.set_opacity(0.45)
        annotation.set_info(
            subject="native-style-id|HUMAN",
            title="fixture-actor",
            creationDate="D:20200102030405Z",
        )
        document.xref_set_key(
            annotation.xref, "NM", fitz.get_pdf_str("native-style-id")
        )
        xref = annotation.xref
        raw_rect = document.xref_get_key(xref, "Rect")
        native_rect = tuple(annotation.rect)
        opacity = annotation.opacity
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.update_annotation("native-style-id", new_content=text)
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        da = document.xref_get_key(annotation.xref, "DA")[1]
        match = re.search(r"/Helv\s+([\d.]+)\s+Tf", da)
        assert match, "content-only save changed native font family"
        size = float(match[1])
        if overflow:
            assert 0 < size < 11, "long feedback did not shrink to fit its original box"
        else:
            assert size == pytest.approx(
                11, abs=0.00001
            ), "content-only text that fits changed the native 11-point font"
        assert annotation.xref == xref, "content-only save recreated the native object"
        assert document.xref_get_key(xref, "Rect") == raw_rect
        assert tuple(annotation.rect) == native_rect
        assert annotation.opacity == opacity, "content-only save reset native opacity"
        assert annotation.info["title"] == "fixture-actor"
        assert annotation.info["creationDate"] == "D:20200102030405Z"
        assert annotation.info["content"] == text
        assert "".join(annotation.get_text().split()) == "".join(text.split())
        colors = {
            span["color"] & 0xFFFFFF
            for block in annotation.get_text("dict")["blocks"]
            for line in block.get("lines", [])
            for span in line["spans"]
        }
        assert colors == {255}, "content-only save changed native blue text"
