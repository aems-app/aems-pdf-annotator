"""Native FreeText does not break words at TAB."""
from __future__ import annotations

from pathlib import Path

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import _add_fitted_textbox


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('separator', [' ', '\t'], ids=['space-control', 'tab'])
def test_native_unbreakable_whitespace_keeps_full_saved_tail(
    tmp_path: Path, rotation: int, separator: str,
) -> None:
    text = ('First' + separator + 'second' + separator + 'third' + separator) * 15 + 'FINALWORD'
    path = tmp_path / 'native-whitespace.pdf'
    with fitz.open() as doc:
        page = doc.new_page(width=595, height=842)
        page.set_rotation(rotation)
        _add_fitted_textbox(page, fitz.Rect(50, 50, 160, 72), text, (0., 0., 0.), rotation)
        doc.save(path)
    with fitz.open(path) as doc:
        page = doc[0]
        annotation = next(page.annots())
        assert annotation.info['content'] == text
        painted = annotation.get_text()
        assert ''.join(painted.split()) == ''.join(text.split()), (
            f'native whitespace clips {len("".join(painted.split()))}/249 characters'
        )
        assert 'FINALWORD' in painted
