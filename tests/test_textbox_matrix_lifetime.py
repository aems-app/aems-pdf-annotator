"""The raw SWIG matrix must retain its owning wrapper through the native call."""

from types import SimpleNamespace
from typing import Any
import weakref

import pytest

from aems_pdf_annotator import core


def test_identity_matrix_owner_survives_native_glyph_measurement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Matrix:
        def internal(self) -> Any:
            return SimpleNamespace(owner=weakref.ref(self))

    def bound_text(text: Any, stroke: Any, matrix: Any) -> Any:
        assert (
            matrix.owner() is not None
        ), "Native matrix owner was released before glyph measurement"
        return SimpleNamespace(x0=1, y0=2, x1=3, y1=4)

    device = core._TextboxInkBounds(local=True)
    monkeypatch.setattr(core.fitz.mupdf, "FzMatrix", Matrix)
    monkeypatch.setattr(core.fitz.mupdf, "ll_fz_bound_text", bound_text)
    device.fill_text(None, None, None)
    assert tuple(device.bounds) == (1, 2, 3, 4)
