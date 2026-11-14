"""L1b: measure the writer's unclipped glyphs, not a second layout engine.

Real native PDFs are necessary to observe fallback-font advances and clipping.
"""

import re

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import _add_fitted_textbox


@pytest.mark.parametrize("separator", [chr(n) for n in range(0x7F, 0xA0)] + [
    "\u0903", "\u0301", "\u20dd", "\u200d", "\t", "\r\n", " ",
])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_writer_fallback_glyphs_cannot_clip_letters(separator: str, rotation: int) -> None:
    text = ("First" + separator + "second" + separator + "third" + separator) * 15 + "FINALWORD"
    with fitz.open() as document:
        page = document.new_page()
        annotation = _add_fitted_textbox(
            page, fitz.Rect(50, 50, 160, 72), text, (0.0, 0.0, 0.0), rotation
        )
        payload = document.tobytes()
    with fitz.open(stream=payload, filetype="pdf") as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == text
        painted = annotation.get_text()
        assert re.sub("[^A-Za-z]", "", painted) == re.sub("[^A-Za-z]", "", text)
        assert "FINALWORD" in painted


@pytest.mark.parametrize("text", ["abc \u20dddef FINALWORD", "abc def \u20ddFINALWORD"])
@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_tall_glyph_bearings_are_independent_of_word_order(text: str, rotation: int) -> None:
    with fitz.open() as document:
        page = document.new_page()
        annotation = _add_fitted_textbox(
            page, fitz.Rect(50, 50, 160, 72), text, (0.0, 0.0, 0.0), rotation
        )
        painted = annotation.get_text()
        assert re.sub("[^A-Za-z]", "", painted) == re.sub("[^A-Za-z]", "", text)
        assert "FINALWORD" in painted
