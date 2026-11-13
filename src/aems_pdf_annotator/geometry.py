"""Coordinate conversion for PDF.js requests and native annotation geometry."""

from typing import Any, Sequence


def pdf_point_to_native(point: Sequence[float], page: Any) -> list[float]:
    """Map raw PDF user space to crop-normalized, unrotated MuPDF space."""
    crop = page.cropbox
    top = page.mediabox.y1 - crop.y0
    return [point[0] - crop.x0, top - point[1]]


def native_point_to_pdf(point: Sequence[float], page: Any) -> list[float]:
    """Map native annotation coordinates back to raw PDF user space."""
    crop = page.cropbox
    top = page.mediabox.y1 - crop.y0
    return [point[0] + crop.x0, top - point[1]]


def pdf_rect_to_native(rect: Sequence[float], page: Any) -> list[float]:
    """Convert a raw PDF rectangle without using the rotated page height."""
    bottom_left = pdf_point_to_native(rect[:2], page)
    top_right = pdf_point_to_native(rect[2:], page)
    return [bottom_left[0], top_right[1], top_right[0], bottom_left[1]]
