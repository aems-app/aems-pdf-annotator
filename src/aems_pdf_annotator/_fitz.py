"""Utility module to import PyMuPDF with warning suppression."""

import warnings

warnings.filterwarnings(
    "ignore",
    message="builtin type swigvarlink has no __module__ attribute",
    category=DeprecationWarning,
)

import pymupdf as fitz  # type: ignore  # noqa: E402

__all__ = ["fitz"]
