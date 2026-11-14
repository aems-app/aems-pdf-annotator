"""Native glyph ink must survive the annotation's own clipping paths."""

import re

import numpy as np
import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import _add_fitted_textbox, fit_existing_textboxes


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
@pytest.mark.parametrize(
    "text",
    [
        ("e\u0302\u0301B " * 12) + "FINALWORD",
        (("A" + "\u0300" * 8 + "B ") * 12) + "FINALWORD",
        ("j\u0323\u0329g " * 12) + "FINALWORD",
        "AB " * 12 + "FINALWORD",
    ],
)
def test_identical_unclipped_glyph_commands_have_no_ink_outside_box(
    text: str, rotation: int
) -> None:
    with fitz.open() as doc:
        page = doc.new_page()
        annotation = _add_fitted_textbox(
            page, fitz.Rect(50, 50, 160, 72), text, (0, 0, 0), rotation
        )
        assert annotation.info["content"] == text
        assert "FINALWORD" in annotation.get_text()
        xref = int(doc.xref_get_key(annotation.xref, "AP/N")[1].split()[0])
        before = doc.xref_stream(xref)
        assert fit_existing_textboxes(doc) == 0
        assert doc.xref_stream(xref) == before
        raw_rect = fitz.Rect(
            list(
                map(
                    float,
                    re.findall(
                        r"[-+0-9.eE]+", doc.xref_get_key(annotation.xref, "Rect")[1]
                    ),
                )
            )
        )
        expanded = raw_rect + (-20, -20, 20, 20)
        raw = "[" + " ".join(str(v) for v in expanded) + "]"
        doc.xref_set_key(annotation.xref, "Rect", raw)
        doc.xref_set_key(xref, "BBox", raw)
        # Independent review oracle: preserve glyph operators and positions,
        # removing only clipping. Expose strokes the saved PDF would hide.
        doc.update_stream(xref, re.sub(rb"\bW\*?\s+n\b", b"n", before))
        pix = page.get_pixmap(matrix=fitz.Matrix(8, 8), clip=fitz.Rect(30, 30, 180, 92))
        pixels = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n
        )
        dark = pixels[:, :, :3].min(axis=2) < 200
        outside = dark.copy()
        outside[160:336, 160:1040] = False
        assert not outside.any(), "Unclipped control exposes lost glyph strokes"


def test_complete_external_absolute_appearance_is_preserved() -> None:
    with fitz.open() as doc:
        page = doc.new_page()
        annotation = page.add_freetext_annot(
            fitz.Rect(50, 50, 160, 72), "FINALWORD", fontsize=11
        )
        xref = int(doc.xref_get_key(annotation.xref, "AP/N")[1].split()[0])
        stream = (
            b"q 50 770 110 22 re W n\nBT\n/Helv 11 Tf 50 780 Td (FINALWORD) Tj\nET\nQ"
        )
        doc.update_stream(xref, stream)
        assert "FINALWORD" in annotation.get_text()
        assert fit_existing_textboxes(doc) == 0
        assert doc.xref_stream(xref) == stream
