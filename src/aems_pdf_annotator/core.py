"""
PDF annotation module using PyMuPDF for color-coded marking.

Supports green (correct), amber (review), and red (incorrect) annotations
with highlights, squiggly underlines, strikeouts, and text notes.
"""

import base64
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Type, Union

try:
    from aems_pdf_annotator._fitz import fitz  # PyMuPDF
except ImportError:
    raise ImportError(
        "PyMuPDF is required for PDF annotation. " "Install with: pip install pymupdf"
    )

from aems_pdf_annotator.models import (
    PDFAnnotation,
    AnnotationType,
    AnnotationColor,
    BBox,
)

logger = logging.getLogger(__name__)


# PDF annotation type names that should not be used as stable IDs
ANNOTATION_TYPE_NAMES = {
    "Text",
    "Note",
    "Highlight",
    "Underline",
    "Squiggly",
    "StrikeOut",
    "FreeText",
    "Square",
    "Circle",
    "Line",
    "Polygon",
    "PolyLine",
    "Stamp",
    "Caret",
    "Ink",
    "Popup",
    "FileAttachment",
    "Sound",
}


def _is_annotation_type_name(value: Optional[str]) -> bool:
    """Check if a value is a PDF annotation type name (not a valid stable ID)."""
    if not value:
        return False
    return str(value).strip() in ANNOTATION_TYPE_NAMES


def _safe_set_info(annot: Any, key: str, value: str) -> None:
    """PyMuPDF set_info expects a dict in newer versions; handle both."""
    try:
        annot.set_info({key: value})
    except TypeError:
        annot.set_info(**{key: value})


def _normalize_pdf_author_name(grader_name: str) -> str:
    """Normalize annotation author title for PDF viewers."""
    raw_name = str(grader_name).strip()
    if not raw_name:
        return ""
    # Strip role suffixes like "(Teacher)" / "(Lid)" so author is stable and concise in PDF popups.
    normalized = re.sub(r"\s+\([^)]*\)\s*$", "", raw_name).strip()
    return normalized or raw_name


def _format_pdf_datetime(value: Optional[datetime] = None) -> str:
    """Format datetime to PDF date string: D:YYYYMMDDHHmmSS+HH'mm'."""
    dt = value or datetime.now(timezone.utc)
    if dt.tzinfo is None or dt.utcoffset() is None:
        dt = dt.replace(tzinfo=timezone.utc)

    offset = dt.utcoffset() or timedelta(0)
    sign = "+" if offset >= timedelta(0) else "-"
    total_minutes = abs(int(offset.total_seconds())) // 60
    offset_hours = total_minutes // 60
    offset_minutes = total_minutes % 60

    return f"D:{dt:%Y%m%d%H%M%S}{sign}{offset_hours:02d}'{offset_minutes:02d}'"


def _pymupdf_rect_to_pdf(
    rect: "fitz.Rect", page_height: float
) -> Tuple[float, float, float, float]:
    """Convert a PyMuPDF rect (top-left origin) to PDF rect (bottom-left origin)."""
    return (rect.x0, page_height - rect.y1, rect.x1, page_height - rect.y0)


def _pdf_rect_to_pymupdf(
    rect: Sequence[float],
    page_height: float,
) -> Tuple[float, float, float, float]:
    """Convert a PDF rect (bottom-left origin) to PyMuPDF rect (top-left origin)."""
    x0, y0, x1, y1 = rect
    return (x0, page_height - y1, x1, page_height - y0)


def _rgb_ints_to_floats(rgb: Optional[Sequence[int]]) -> Optional[Tuple[float, float, float]]:
    """Convert 0-255 RGB values to PyMuPDF's 0.0-1.0 float tuple."""
    if rgb is None or len(rgb) != 3:
        return None
    return (rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)


def _parse_rgb_token(token: str) -> Optional[List[int]]:
    """Parse an r,g,b metadata token into integer RGB values."""
    parts = [part.strip() for part in token.split(",")]
    if len(parts) != 3:
        return None
    try:
        rgb = [int(part) for part in parts]
    except ValueError:
        return None
    if any(component < 0 or component > 255 for component in rgb):
        return None
    return rgb


def _decode_subject_metadata(subject_value: Any) -> Dict[str, Any]:
    """Decode stable ID and metadata from the PDF annotation subject field."""
    subject_text = str(subject_value or "").strip()
    metadata: Dict[str, Any] = {
        "stable_id": None,
        "source": None,
        "original_source": None,
        "is_verdict": False,
        "drawing_style": None,
        "stroke_width": None,
        "stroke_opacity": None,
        "stroke_color_rgb": None,
        "textbox_color_rgb": None,
    }
    if not subject_text:
        return metadata

    encoded_payload = ""
    if "#" in subject_text:
        stable_id, encoded_payload = subject_text.split("#", 1)
    elif "|" in subject_text:
        parts = subject_text.split("|")
        stable_id = parts[0]
        encoded_payload = "|".join(parts[1:])
    else:
        stable_id = subject_text

    metadata["stable_id"] = stable_id or None

    if not encoded_payload:
        return metadata

    decoded_payload = encoded_payload
    if "#" in subject_text:
        try:
            decoded_payload = base64.b64decode(encoded_payload).decode("utf-8")
        except Exception:
            return metadata

    tokens = decoded_payload.split("|")
    if tokens:
        metadata["source"] = tokens[0] or None

    for token in tokens[1:]:
        if not token:
            continue
        if token == "V":
            metadata["is_verdict"] = True
            continue
        if token.startswith("D:"):
            drawing_parts = token.split(":")
            if len(drawing_parts) >= 4:
                metadata["drawing_style"] = drawing_parts[1]
                try:
                    metadata["stroke_width"] = float(drawing_parts[2])
                    metadata["stroke_opacity"] = float(drawing_parts[3])
                except ValueError:
                    logger.debug("Invalid drawing metadata token: %s", token)
                if len(drawing_parts) >= 5:
                    metadata["stroke_color_rgb"] = _parse_rgb_token(drawing_parts[4])
            continue
        if token.startswith("T:"):
            metadata["textbox_color_rgb"] = _parse_rgb_token(token[2:])
            continue
        if metadata["original_source"] is None:
            metadata["original_source"] = token

    return metadata


def _encode_subject_metadata(
    stable_id: str,
    source: str,
    *,
    original_source: Optional[str] = None,
    is_verdict: bool = False,
    drawing_style: Optional[str] = None,
    stroke_width: Optional[float] = None,
    stroke_opacity: Optional[float] = None,
    stroke_color_rgb: Optional[Sequence[int]] = None,
    textbox_color_rgb: Optional[Sequence[int]] = None,
) -> str:
    """Encode stable ID and metadata into the PDF annotation subject field."""
    tokens = [source]
    metadata_tokens: List[str] = []
    if is_verdict:
        metadata_tokens.append("V")
    if drawing_style:
        stroke_w = 2.0 if stroke_width is None else stroke_width
        stroke_o = 1.0 if stroke_opacity is None else stroke_opacity
        drawing_token = f"D:{drawing_style}:{stroke_w}:{stroke_o}"
        if stroke_color_rgb and len(stroke_color_rgb) == 3:
            drawing_token += f":{','.join(str(component) for component in stroke_color_rgb)}"
        metadata_tokens.append(drawing_token)
    if textbox_color_rgb and len(textbox_color_rgb) == 3:
        metadata_tokens.append(f"T:{','.join(str(component) for component in textbox_color_rgb)}")

    if original_source is not None or metadata_tokens:
        tokens.append(original_source or "")
    tokens.extend(metadata_tokens)

    encoded_payload = base64.b64encode("|".join(tokens).encode("utf-8")).decode("ascii")
    return f"{stable_id}#{encoded_payload}"


class PDFAnnotator:
    """
    PDF annotator using PyMuPDF to add color-coded annotations.

    This class handles opening PDFs, adding various types of annotations
    (highlights, squiggly underlines, strikeouts, text notes), and saving
    the annotated PDFs.
    """

    def __init__(self, pdf_path: Union[Path, str]):
        """
        Initialize the annotator with a PDF file.

        Args:
            pdf_path: Path to the PDF file to annotate
        """
        self.pdf_path = Path(pdf_path)
        if not self.pdf_path.exists():
            raise FileNotFoundError(f"PDF not found: {self.pdf_path}")

        self.doc: Optional[fitz.Document] = None
        self._open()

    def _open(self) -> None:
        """Open the PDF document."""
        try:
            self.doc = fitz.open(self.pdf_path)
            logger.info(f"Opened PDF: {self.pdf_path} ({self.doc.page_count} pages)")
        except Exception as e:
            logger.error(f"Failed to open PDF {self.pdf_path}: {e}")
            raise

    def close(self) -> None:
        """Close the PDF document."""
        if self.doc:
            self.doc.close()
            self.doc = None

    def __enter__(self) -> "PDFAnnotator":
        """Context manager entry."""
        return self

    def __exit__(
        self, exc_type: Optional[Type[BaseException]], exc_val: Optional[BaseException], exc_tb: Any
    ) -> None:
        """Context manager exit."""
        self.close()

    def add_annotation(self, annotation: PDFAnnotation) -> bool:
        """
        Add a single annotation to the PDF.

        Args:
            annotation: PDFAnnotation object with all details

        Returns:
            True if annotation was added successfully, False otherwise
        """
        if not self.doc:
            logger.error("PDF document not opened")
            return False

        if annotation.page_index >= self.doc.page_count:
            logger.error(
                f"Page {annotation.page_index} out of range "
                f"(PDF has {self.doc.page_count} pages)"
            )
            return False

        try:
            page = self.doc[annotation.page_index]
            rgb = annotation.get_rgb_color()

            # Add annotation based on type
            if annotation.kind == AnnotationType.HIGHLIGHT:
                rect = fitz.Rect(annotation.bbox.to_rect())
                annot = page.add_highlight_annot(rect)
                annot.set_colors(stroke=rgb)

            elif annotation.kind == AnnotationType.SQUIGGLY:
                rect = fitz.Rect(annotation.bbox.to_rect())
                annot = page.add_squiggly_annot(rect)
                annot.set_colors(stroke=rgb)

            elif annotation.kind == AnnotationType.STRIKEOUT:
                rect = fitz.Rect(annotation.bbox.to_rect())
                annot = page.add_strikeout_annot(rect)
                annot.set_colors(stroke=rgb)

            elif annotation.kind == AnnotationType.UNDERLINE:
                rect = fitz.Rect(annotation.bbox.to_rect())
                annot = page.add_underline_annot(rect)
                annot.set_colors(stroke=rgb)

            elif annotation.kind == AnnotationType.TEXT:
                # Text annotation (sticky note) - only needs position, not rectangle
                position = fitz.Point(annotation.bbox.x0, annotation.bbox.y0)
                # Use icon from annotation, default to "Comment" if not specified
                icon = getattr(annotation, "icon", None) or "Comment"
                annot = page.add_text_annot(
                    position,  # Position of note icon
                    annotation.format_comment(),
                    icon=icon,  # Add icon parameter
                )
                # Set color for text notes to match the requested priority
                annot.set_colors(stroke=rgb)

                # Apply opacity if specified
                if hasattr(annotation, "opacity") and annotation.opacity is not None:
                    annot.set_opacity(annotation.opacity)
                    annot.update()  # Ensure opacity is persisted

            elif annotation.kind == AnnotationType.DRAWING:
                if not annotation.points or len(annotation.points) < 2:
                    logger.warning("Drawing annotation has no points, skipping")
                    return False

                # Convert points from PDF coords (bottom-left) to PyMuPDF coords (top-left)
                page_height = page.rect.height
                converted_points: list[tuple[float, float]] = []
                for pt in annotation.points:
                    pymupdf_y = page_height - pt[1]
                    converted_points.append((float(pt[0]), float(pymupdf_y)))

                # Determine stroke properties
                width = annotation.stroke_width or (
                    2.0 if annotation.drawing_style == "pen" else 14.0
                )
                opacity = (
                    annotation.stroke_opacity
                    if annotation.stroke_opacity is not None
                    else (1.0 if annotation.drawing_style == "pen" else 0.35)
                )

                # Get color
                drawing_rgb = _rgb_ints_to_floats(annotation.stroke_color_rgb)
                if drawing_rgb:
                    rgb = drawing_rgb
                else:
                    rgb = annotation.get_rgb_color()

                # Create ink annotation (freehand drawing in PyMuPDF)
                annot = page.add_ink_annot([converted_points])
                annot.set_colors(stroke=rgb)
                annot.set_border(width=width)
                annot.set_opacity(opacity)
                annot.update()

            elif annotation.kind == AnnotationType.TEXTBOX:
                # Create a free text annotation (text box)
                pymupdf_rect = fitz.Rect(annotation.bbox.to_rect())

                text = annotation.comment or ""
                textbox_rgb = _rgb_ints_to_floats(annotation.stroke_color_rgb)
                if textbox_rgb:
                    text_color = textbox_rgb
                else:
                    text_color = (0.0, 0.0, 0.0)

                annot = page.add_freetext_annot(
                    pymupdf_rect,
                    text,
                    fontsize=11,
                    fontname="helv",
                    text_color=text_color,
                    fill_color=(1.0, 1.0, 1.0),
                )
                annot.set_opacity(0.9)
                annot.update()

            else:
                logger.error(f"Unknown annotation type: {annotation.kind}")
                return False

            annot_id = str(getattr(annotation, "id", None) or uuid.uuid4())
            grader_name = getattr(annotation, "grader_name", None)

            annotation_source = getattr(annotation, "source", None)
            if annotation_source:
                try:
                    original_source = getattr(annotation, "original_source", None)
                    subject_value = _encode_subject_metadata(
                        annot_id,
                        annotation_source.value,
                        original_source=(
                            original_source.value if original_source is not None else None
                        ),
                        is_verdict=bool(getattr(annotation, "is_verdict", False)),
                        drawing_style=annotation.drawing_style,
                        stroke_width=annotation.stroke_width,
                        stroke_opacity=annotation.stroke_opacity,
                        stroke_color_rgb=annotation.stroke_color_rgb,
                        textbox_color_rgb=(
                            annotation.stroke_color_rgb
                            if annotation.kind == AnnotationType.TEXTBOX
                            else None
                        ),
                    )
                    _safe_set_info(annot, "subject", subject_value)
                    annot.update()
                    logger.debug(
                        "Stored annotation metadata in subject '%s' (xref=%s)",
                        subject_value,
                        getattr(annot, "xref", None),
                    )
                except Exception as source_error:
                    logger.warning(
                        "Failed to store source metadata for annotation %s: %s",
                        annot_id,
                        source_error,
                    )

            # Store grader name in "title" field (this is what PDF viewers display as author)
            if grader_name:
                try:
                    grader_name_str = _normalize_pdf_author_name(str(grader_name))
                    _safe_set_info(annot, "title", grader_name_str)
                    logger.debug(
                        "Stored grader_name in PDF annotation title field: '%s'", grader_name_str
                    )
                except Exception as e:
                    logger.error(
                        "[ANNOTATOR] Failed to store grader_name '%s' in title field: %s",
                        grader_name,
                        e,
                        exc_info=True,
                    )
            else:
                logger.warning(
                    "[ANNOTATOR] No grader_name provided - annotation will have no author attribution"
                )

            # Persist PDF timestamp tags for external viewer auditability.
            try:
                created_at = getattr(annotation, "created_at", None)
                modified_at = getattr(annotation, "modified_at", None) or created_at
                if created_at is not None:
                    _safe_set_info(annot, "creationDate", _format_pdf_datetime(created_at))
                _safe_set_info(annot, "modDate", _format_pdf_datetime(modified_at))
            except Exception as date_error:
                logger.warning(
                    "Failed to store PDF timestamp metadata for annotation %s: %s",
                    annot_id,
                    date_error,
                )

            # Add comment to all annotation types (except text which has it built-in)
            if annotation.kind != AnnotationType.TEXT:
                formatted_comment = annotation.format_comment(include_check_id=True)
                if formatted_comment:
                    try:
                        _safe_set_info(annot, "content", formatted_comment)
                    except Exception as info_error:
                        logger.error(
                            "[ANNOTATOR] Failed to persist annotation content: %s",
                            info_error,
                        )

            # Update annotation appearance
            annot.update()

            logger.debug(
                f"Added {annotation.kind.value} annotation "
                f"(color={annotation.color.value}) on page {annotation.page_index}"
            )
            return True

        except Exception as e:
            logger.error(f"Failed to add annotation: {e}")
            return False

    def _extract_ink_points_pdf(self, annot: Any, page_height: float) -> List[List[float]]:
        """Extract ink annotation points in PDF-space coordinates."""
        paths = getattr(annot, "vertices", None)
        if not paths:
            legacy_paths = getattr(annot, "ink_list", None)
            if legacy_paths:
                paths = legacy_paths
        if not paths:
            return []

        first_path = paths[0] if isinstance(paths[0], (list, tuple)) else paths
        points: List[List[float]] = []
        for point in first_path:
            if hasattr(point, "x") and hasattr(point, "y"):
                x_value = float(point.x)
                y_value = float(point.y)
            else:
                x_value = float(point[0])
                y_value = float(point[1])
            points.append([x_value, page_height - y_value])
        return points

    def _replace_drawing_annotation(
        self,
        page_index: int,
        annot: Any,
        annotation_identifier: str,
        new_points: Optional[List[List[float]]],
        new_stroke_color_rgb: Optional[List[int]],
        grader_name: Optional[str],
        new_source: Optional[str],
        new_is_verdict: Optional[bool],
    ) -> Union[bool, Tuple[bool, Optional[int], Optional[int]]]:
        """Replace an ink annotation to persist drawing point or color updates."""
        if self.doc is None:
            return False

        page = self.doc[page_index]
        info = annot.info or {}
        metadata = _decode_subject_metadata(info.get("subject", ""))
        page_height = page.rect.height
        current_points = self._extract_ink_points_pdf(annot, page_height)
        points_to_store = new_points or current_points
        if len(points_to_store) < 2:
            logger.error(
                "Cannot replace drawing annotation %s without at least 2 points",
                annotation_identifier,
            )
            return False

        stroke_rgb = new_stroke_color_rgb or metadata.get("stroke_color_rgb")
        stroke_rgb_float = _rgb_ints_to_floats(stroke_rgb)

        drawing_style = metadata.get("drawing_style") or "pen"
        stroke_width = metadata.get("stroke_width")
        if stroke_width is None:
            stroke_width = 14.0 if drawing_style == "highlighter" else 2.0
        stroke_opacity = metadata.get("stroke_opacity")
        if stroke_opacity is None:
            stroke_opacity = 0.35 if drawing_style == "highlighter" else 1.0

        converted_points = [
            (float(point[0]), float(page_height - point[1])) for point in points_to_store
        ]

        try:
            new_annot = page.add_ink_annot([converted_points])
            if stroke_rgb_float:
                new_annot.set_colors(stroke=stroke_rgb_float)
            new_annot.set_border(width=stroke_width)
            new_annot.set_opacity(stroke_opacity)

            effective_grader_name = grader_name or info.get("title")
            if effective_grader_name:
                _safe_set_info(
                    new_annot, "title", _normalize_pdf_author_name(str(effective_grader_name))
                )

            subject_value = _encode_subject_metadata(
                metadata.get("stable_id") or str(uuid.uuid4()),
                new_source or metadata.get("source") or "AI",
                original_source=metadata.get("original_source"),
                is_verdict=(
                    metadata.get("is_verdict") if new_is_verdict is None else bool(new_is_verdict)
                ),
                drawing_style=drawing_style,
                stroke_width=stroke_width,
                stroke_opacity=stroke_opacity,
                stroke_color_rgb=stroke_rgb,
            )
            _safe_set_info(new_annot, "subject", subject_value)

            creation_date = info.get("creationDate")
            if creation_date:
                _safe_set_info(new_annot, "creationDate", str(creation_date))
            _safe_set_info(new_annot, "modDate", _format_pdf_datetime())

            content = info.get("content")
            if content:
                _safe_set_info(new_annot, "content", str(content))

            new_annot.update()
            new_xref = new_annot.xref if hasattr(new_annot, "xref") else None
            page.delete_annot(annot)
            return (True, page_index, new_xref)
        except Exception as e:
            logger.error("Failed to replace drawing annotation %s: %s", annotation_identifier, e)
            return False

    def _replace_textbox_annotation(
        self,
        page_index: int,
        annot: Any,
        annotation_identifier: str,
        new_rect: Optional[Tuple[float, float, float, float]],
        new_content: Optional[str],
        new_stroke_color_rgb: Optional[List[int]],
        grader_name: Optional[str],
        new_source: Optional[str],
        new_is_verdict: Optional[bool],
    ) -> Union[bool, Tuple[bool, Optional[int], Optional[int]]]:
        """Replace a free-text annotation when properties require recreation."""
        if self.doc is None:
            return False

        page = self.doc[page_index]
        info = annot.info or {}
        metadata = _decode_subject_metadata(info.get("subject", ""))
        rect = fitz.Rect(new_rect) if new_rect is not None else annot.rect

        textbox_rgb = new_stroke_color_rgb or metadata.get("textbox_color_rgb")
        text_color = _rgb_ints_to_floats(textbox_rgb) or (0.0, 0.0, 0.0)
        content = info.get("content", "") if new_content is None else new_content

        try:
            new_annot = page.add_freetext_annot(
                rect,
                content,
                fontsize=11,
                fontname="helv",
                text_color=text_color,
                fill_color=(1.0, 1.0, 1.0),
            )
            new_annot.set_opacity(0.9)

            effective_grader_name = grader_name or info.get("title")
            if effective_grader_name:
                _safe_set_info(
                    new_annot, "title", _normalize_pdf_author_name(str(effective_grader_name))
                )

            subject_value = _encode_subject_metadata(
                metadata.get("stable_id") or str(uuid.uuid4()),
                new_source or metadata.get("source") or "AI",
                original_source=metadata.get("original_source"),
                is_verdict=(
                    metadata.get("is_verdict") if new_is_verdict is None else bool(new_is_verdict)
                ),
                textbox_color_rgb=textbox_rgb,
            )
            _safe_set_info(new_annot, "subject", subject_value)

            creation_date = info.get("creationDate")
            if creation_date:
                _safe_set_info(new_annot, "creationDate", str(creation_date))
            _safe_set_info(new_annot, "modDate", _format_pdf_datetime())
            if content:
                _safe_set_info(new_annot, "content", str(content))

            new_annot.update()
            new_xref = new_annot.xref if hasattr(new_annot, "xref") else None
            page.delete_annot(annot)
            return (True, page_index, new_xref)
        except Exception as e:
            logger.error("Failed to replace textbox annotation %s: %s", annotation_identifier, e)
            return False

    def _find_annotation(
        self,
        *,
        annotation_id: Optional[str] = None,
        xref: Optional[int] = None,
    ) -> Optional[Tuple[int, Any]]:
        """
        Locate an annotation either by its stable ID or legacy xref.

        Handles various identifier formats:
        - UUID strings (e.g., "49cf44f5-4b1d-4699-b8c3-f9eb8f7710f0")
        - Simple IDs (e.g., "1", "Note:1")
        - XRef numbers
        """
        if not self.doc:
            logger.debug("Document not opened, cannot find annotation")
            return None

        # Normalize search identifier - handle "Note:1" format by extracting the ID part
        # Also handle composite formats like "xref:138|id:fitz-A3" - prefer xref
        search_id = None
        if annotation_id:
            search_id = str(annotation_id).strip()

            # Handle composite format "xref:138|id:fitz-A3" - prefer explicit IDs before xref
            if "|" in search_id:
                parts = search_id.split("|")
                xref_part = None
                id_part = None
                for part in parts:
                    part = part.strip()
                    if part.startswith("xref:"):
                        try:
                            xref_part = int(part.split(":", 1)[1])
                        except (ValueError, TypeError):
                            pass
                    elif part.startswith("id:"):
                        temp_id = part.split(":", 1)[1]
                        # Only use ID if it's not a PyMuPDF internal ID
                        if temp_id and not temp_id.startswith("fitz-"):
                            id_part = temp_id
                if id_part:
                    search_id = id_part
                if xref_part is not None:
                    xref = xref_part

            # Handle "Note:1" or "Text:1" format - extract the numeric/ID part after colon
            if search_id and ":" in search_id and not search_id.startswith(("xref:", "id:")):
                parts = search_id.split(":", 1)
                if len(parts) == 2:
                    search_id = parts[1].strip()

        for page_idx in range(self.doc.page_count):
            page = self.doc[page_idx]
            for annot in page.annots():
                actual_xref = getattr(annot, "xref", None)

                # Skip annotations that are no longer bound to a page
                try:
                    if hasattr(annot, "parent"):
                        parent = getattr(annot, "parent", None)
                        if parent is None:
                            continue
                except Exception as e:
                    logger.debug("Could not check annotation parent: %s", e)

                info = annot.info or {}

                # Collect all possible ID candidates from annotation metadata.
                # The "subject" field stores UUIDs (may contain UUID#base64 or UUID|source format).
                subject_value = info.get("subject")
                subject_uuid = None
                if subject_value:
                    subject_str = str(subject_value).strip()
                    # Handle UUID#base64 format (new)
                    if "#" in subject_str:
                        subject_uuid = subject_str.split("#", 1)[0]
                    # Handle UUID|source|original format (legacy)
                    elif "|" in subject_str:
                        subject_uuid = subject_str.split("|", 1)[0]
                    else:
                        subject_uuid = subject_str

                candidates = [
                    subject_uuid,  # UUID extracted from subject field (highest priority)
                    info.get("id"),
                    info.get("name"),
                    info.get("title"),
                ]
                # Remove None values
                candidates = [c for c in candidates if c is not None]

                # Try matching by stable ID first
                if search_id:
                    for candidate in candidates:
                        candidate_str = str(candidate).strip()
                        # Exact match
                        if candidate_str == search_id:
                            return (page_idx, annot)
                        # Partial match (in case of "Note:1" vs just "1")
                        if candidate_str.endswith(f":{search_id}"):
                            return (page_idx, annot)

                # Fallback: try matching by xref
                if xref is not None and actual_xref == xref:
                    return (page_idx, annot)

        logger.debug("Annotation not found: id=%s, xref=%s", annotation_id, xref)
        return None

    def find_annotation_by_id(self, annotation_id: str) -> Optional[Tuple[int, object]]:
        return self._find_annotation(annotation_id=annotation_id)

    def find_annotation_by_xref(self, xref: int) -> Optional[Tuple[int, object]]:
        return self._find_annotation(xref=xref)

    def update_annotation_by_xref(
        self,
        xref: int,
        new_content: Optional[str] = None,
        new_rect: Optional[Tuple[float, float, float, float]] = None,
        new_color: Optional[str] = None,
        new_page_index: Optional[int] = None,
    ) -> Union[bool, Tuple[bool, Optional[int], Optional[int]]]:
        return self.update_annotation(
            annotation_identifier=str(xref),
            new_content=new_content,
            new_rect=new_rect,
            new_color=new_color,
            new_page_index=new_page_index,
        )

    @staticmethod
    def _parse_annotation_identifier(
        identifier: Optional[str],
    ) -> Tuple[Optional[int], Optional[str]]:
        """
        Parse annotation identifier into (xref, annotation_id) tuple.

        Handles formats:
        - "xref:123" -> (123, None)
        - "id:uuid-here" -> (None, "uuid-here")
        - "Note:1" -> (None, "1")  # Extract ID part after colon
        - "123" -> (123, None)  # Pure numeric treated as xref
        - "uuid-string" -> (None, "uuid-string")  # Non-numeric treated as ID
        """
        if identifier is None:
            return None, None

        identifier_str = str(identifier).strip()
        if not identifier_str:
            return None, None

        xref = None
        annotation_id = None

        # Handle composite formats like "xref:123|id:uuid" or "xref:123|uuid"
        if "xref:" in identifier_str or "id:" in identifier_str or "|" in identifier_str:
            parts = identifier_str.split("|")
            for part in parts:
                part = part.strip()
                if not part:
                    continue
                if part.startswith("xref:"):
                    value = part.split(":", 1)[1]
                    if value:
                        try:
                            xref = int(value)
                            continue
                        except (TypeError, ValueError):
                            pass
                elif part.startswith("id:"):
                    value = part.split(":", 1)[1]
                    if value:
                        annotation_id = value
                        continue

                if xref is None:
                    try:
                        xref = int(part)
                        continue
                    except (TypeError, ValueError):
                        pass
                if annotation_id is None:
                    annotation_id = part

            return xref, annotation_id

        # Handle "Note:1" or "Text:1" format - extract the ID part after colon
        if ":" in identifier_str and not identifier_str.startswith(("xref:", "id:")):
            parts = identifier_str.split(":", 1)
            if len(parts) == 2:
                annotation_id = parts[1].strip()
                return None, annotation_id

        # Try pure numeric as xref
        try:
            return int(identifier_str), None
        except (TypeError, ValueError):
            # Non-numeric treated as stable ID
            return None, identifier_str

    def update_annotation(
        self,
        annotation_identifier: str,
        new_content: Optional[str] = None,
        new_rect: Optional[Tuple[float, float, float, float]] = None,
        new_color: Optional[str] = None,
        new_page_index: Optional[int] = None,
        grader_name: Optional[str] = None,
        new_source: Optional[str] = None,
        new_is_verdict: Optional[bool] = None,
        new_points: Optional[List[List[float]]] = None,
        new_stroke_color_rgb: Optional[List[int]] = None,
    ) -> Union[bool, Tuple[bool, Optional[int], Optional[int]]]:
        """
        Update an existing annotation's content, position, color, and/or page using a stable ID or xref.

        When a teacher modifies another grader's annotation, it gets retagged with the teacher's name.

        Args:
            annotation_identifier: Stable annotation ID (preferred) or legacy/xref composite identifier
            new_content: New comment text (None to keep unchanged)
            new_rect: Optional new bounding box (x0, y0, x1, y1) in PDF coordinates (None to keep unchanged)
            new_color: Optional new color/priority: "red", "amber", or "green" (None to keep unchanged)
            new_page_index: Optional new page index to move annotation to (None to keep on same page)
            grader_name: Display name with role of modifier (e.g., "Prof. Smith (Teacher)")
            new_is_verdict: Optional verdict flag (None to keep unchanged)
            new_points: Optional updated drawing points in PDF coordinates
            new_stroke_color_rgb: Optional updated markup RGB color

        Returns:
            bool: True/False for same-page updates
            Tuple[bool, int, int]: (success, new_page_index, new_xref) for cross-page moves

        Note (PDF-5 FIX): Cross-page moves return a tuple to provide the new xref
        after PyMuPDF reassigns it. Callers must check isinstance(result, tuple).
        """
        xref, annotation_id = self._parse_annotation_identifier(annotation_identifier)

        result = self._find_annotation(annotation_id=annotation_id, xref=xref)
        if not result:
            logger.error(
                "Annotation not found: identifier='%s' (xref=%s, id=%s)",
                annotation_identifier,
                xref,
                annotation_id,
            )
            return False

        # _find_annotation guarantees self.doc is not None when returning a result
        assert self.doc is not None  # nosec B101
        page_index, annot = result

        if new_page_index is not None:
            if new_page_index < 0 or new_page_index >= self.doc.page_count:
                logger.error(
                    "Target page %d out of range (PDF has %d pages)",
                    new_page_index,
                    self.doc.page_count,
                )
                return False

        # Refresh annotation reference from page to avoid "not bound to a page" error
        page = self.doc[page_index]
        annot_xref = annot.xref if hasattr(annot, "xref") else None

        if annot_xref:
            # Reload the annotation from the page using its xref
            fresh_annot = None
            for a in page.annots():
                if hasattr(a, "xref") and a.xref == annot_xref:
                    fresh_annot = a
                    break

            if fresh_annot:
                annot = fresh_annot
            else:
                logger.error("Failed to refresh annotation xref=%s", annot_xref)

        if new_rect is not None:
            target_page_index = new_page_index if new_page_index is not None else page_index
            target_page = self.doc[target_page_index]
            new_rect = _pdf_rect_to_pymupdf(new_rect, target_page.rect.height)

        # Auto-transfer ownership from AI to HUMAN if any field ACTUALLY changes
        # This ensures any human modification takes ownership
        if new_source is None:
            info = annot.info or {}
            subject_metadata = _decode_subject_metadata(info.get("subject", ""))
            current_source = subject_metadata.get("source") or "AI"
            if current_source == "AI":
                # Read current values to compare
                old_content = info.get("content", "")
                old_rect = tuple(annot.rect) if hasattr(annot, "rect") and annot.rect else None

                # Determine current color name from RGB stroke
                old_colors = annot.colors or {}
                old_stroke = old_colors.get("stroke")
                current_color_name = None
                if old_stroke and len(old_stroke) >= 3:
                    r, g, _b = old_stroke[0], old_stroke[1], old_stroke[2]
                    # Match the same logic used in get_annotations_on_page
                    if r > 0.8 and g < 0.4:
                        current_color_name = "red"
                    elif r > 0.8 and g > 0.4:
                        current_color_name = "amber"
                    elif r < 0.4 and g > 0.5:
                        current_color_name = "green"
                    else:
                        current_color_name = "amber"  # default

                # Check if anything ACTUALLY changed
                content_changed = (
                    new_content is not None and new_content.strip() != (old_content or "").strip()
                )
                color_changed = (
                    new_color is not None
                    and current_color_name is not None
                    and new_color.lower() != current_color_name
                )
                position_changed = (
                    new_rect is not None and old_rect is not None and tuple(new_rect) != old_rect
                )
                page_changed = new_page_index is not None and new_page_index != page_index
                points_changed = new_points is not None

                # Transfer ownership if ANY field actually changed
                if (
                    content_changed
                    or color_changed
                    or position_changed
                    or page_changed
                    or points_changed
                ):
                    new_source = "HUMAN"
                    logger.info(
                        "Auto-transferring ownership to HUMAN for annotation %s "
                        "(content=%s, color=%s, position=%s, page=%s, points=%s)",
                        annotation_identifier,
                        content_changed,
                        color_changed,
                        position_changed,
                        page_changed,
                        points_changed,
                    )

        # Check if moving to a different page
        if new_page_index is not None and new_page_index != page_index:
            logger.info(
                "Moving annotation %s from page %d to page %d",
                annotation_identifier,
                page_index,
                new_page_index,
            )
            move_result = self._move_annotation_to_page(
                page_index,
                annot,
                new_page_index,
                new_content,
                new_rect,
                new_color,
                annotation_id,
                grader_name,
                new_source,
                new_is_verdict,
                new_points,
                new_stroke_color_rgb,
            )
            if isinstance(move_result, tuple):
                return move_result
            return move_result

        try:
            annot_type_code = annot.type[0] if hasattr(annot, "type") else None
            if annot_type_code == fitz.PDF_ANNOT_INK and (
                new_points is not None or new_stroke_color_rgb is not None
            ):
                return self._replace_drawing_annotation(
                    page_index,
                    annot,
                    annotation_identifier,
                    new_points,
                    new_stroke_color_rgb,
                    grader_name,
                    new_source,
                    new_is_verdict,
                )

            if annot_type_code == fitz.PDF_ANNOT_FREE_TEXT and new_stroke_color_rgb is not None:
                return self._replace_textbox_annotation(
                    page_index,
                    annot,
                    annotation_identifier,
                    new_rect,
                    new_content,
                    new_stroke_color_rgb,
                    grader_name,
                    new_source,
                    new_is_verdict,
                )

            # Update content if provided
            if new_content is not None:
                _safe_set_info(annot, "content", new_content)
                annot.update()

            # Update rect if provided
            if new_rect is not None:
                x0, y0, x1, y1 = new_rect
                annot.set_rect(fitz.Rect(x0, y0, x1, y1))
                annot.update()

            # Update color if provided
            if new_color is not None:
                color_map = {
                    "red": (1.0, 0.0, 0.0),
                    "amber": (1.0, 0.647, 0.0),
                    "yellow": (1.0, 0.9, 0.0),
                    "green": (0.0, 0.784, 0.0),
                }
                rgb = color_map.get(new_color.lower())
                if rgb:
                    annot.set_colors(stroke=rgb)
                    annot.update()
                    logger.debug(
                        "Updated annotation %s color to %s (%s)",
                        annotation_identifier,
                        new_color,
                        rgb,
                    )
                else:
                    logger.warning("Unknown color '%s', skipping color update", new_color)

            # Retag annotation with modifier's grader name
            if grader_name is not None:
                try:
                    _safe_set_info(annot, "title", _normalize_pdf_author_name(str(grader_name)))
                    annot.update()
                    logger.info(
                        "Retagged annotation %s with grader name: %s",
                        annotation_identifier,
                        grader_name,
                    )
                except Exception as e:
                    logger.error(
                        "FAILED to update grader_name in title field: %s", e, exc_info=True
                    )

            try:
                _safe_set_info(annot, "modDate", _format_pdf_datetime())
                annot.update()
            except Exception as date_error:
                logger.warning(
                    "Failed to update modDate for annotation %s: %s",
                    annotation_identifier,
                    date_error,
                )

            # Update source and/or verdict in subject field using base64 encoding: UUID#<base64-encoded-source>
            if new_source is not None or new_is_verdict is not None:
                try:
                    info = annot.info or {}
                    subject_metadata = _decode_subject_metadata(info.get("subject", ""))

                    source_to_store = (
                        new_source
                        if new_source is not None
                        else subject_metadata.get("source") or "AI"
                    )
                    original_source_to_store = subject_metadata.get("original_source")
                    if source_to_store == "HUMAN" and not original_source_to_store:
                        original_source_to_store = subject_metadata.get("source") or "AI"
                    is_verdict_to_store = (
                        subject_metadata.get("is_verdict")
                        if new_is_verdict is None
                        else bool(new_is_verdict)
                    )

                    new_subject = _encode_subject_metadata(
                        subject_metadata.get("stable_id") or annotation_id or str(uuid.uuid4()),
                        source_to_store,
                        original_source=original_source_to_store,
                        is_verdict=is_verdict_to_store,
                        drawing_style=subject_metadata.get("drawing_style"),
                        stroke_width=subject_metadata.get("stroke_width"),
                        stroke_opacity=subject_metadata.get("stroke_opacity"),
                        stroke_color_rgb=subject_metadata.get("stroke_color_rgb"),
                        textbox_color_rgb=subject_metadata.get("textbox_color_rgb"),
                    )

                    _safe_set_info(annot, "subject", new_subject)
                    annot.update()

                    # Force refresh annotation info - PyMuPDF may cache it
                    # Reload annotation from page to get fresh info dict
                    if annot_xref:
                        fresh_annot = None
                        for a in page.annots():
                            if hasattr(a, "xref") and a.xref == annot_xref:
                                fresh_annot = a
                                break
                        if fresh_annot:
                            annot = fresh_annot
                            info_after = annot.info or {}
                            source_from_subject = _decode_subject_metadata(
                                info_after.get("subject", "")
                            ).get("source")

                            logger.debug(
                                "Source after refresh: %s (from subject), Full info keys: %s",
                                source_from_subject,
                                list(info_after.keys()),
                            )
                            # Verify source was actually set
                            if source_from_subject != new_source:
                                logger.error(
                                    "CRITICAL: Source not set correctly! Expected %s, got %s (from subject: %s)",
                                    new_source,
                                    source_from_subject,
                                    str(info_after.get("subject", ""))[:50] or "None",
                                )

                    logger.info(
                        "Updated annotation %s source to %s",
                        annotation_identifier,
                        new_source,
                    )
                except Exception as e:
                    logger.error("FAILED to update source: %s", e, exc_info=True)

            logger.debug(
                "Updated annotation %s on page %s (content=%s, rect=%s, color=%s, grader=%s, source=%s)",
                annotation_identifier,
                page_index,
                "updated" if new_content is not None else "unchanged",
                "updated" if new_rect is not None else "unchanged",
                "updated" if new_color is not None else "unchanged",
                "updated" if grader_name is not None else "unchanged",
                "updated" if new_source is not None else "unchanged",
            )
            return True

        except Exception as e:
            logger.error("Failed to update annotation %s: %s", annotation_identifier, e)
            return False

    def _move_annotation_to_page(
        self,
        old_page_index: int,
        annot: Any,
        new_page_index: int,
        new_content: Optional[str],
        new_rect: Optional[Tuple[float, float, float, float]],
        new_color: Optional[str],
        stable_id: Optional[str],
        grader_name: Optional[str] = None,
        new_source: Optional[str] = None,
        new_is_verdict: Optional[bool] = None,
        new_points: Optional[List[List[float]]] = None,
        new_stroke_color_rgb: Optional[List[int]] = None,
    ) -> Union[bool, Tuple[bool, Optional[int], Optional[int]]]:
        """
        Move an annotation from one page to another by deleting and recreating it.

        Args:
            old_page_index: Source page index
            annot: Annotation object to move
            new_page_index: Target page index
            new_content: Optional new content
            new_rect: Optional new rect (required for move)
            new_color: Optional new color
            stable_id: Stable ID to preserve
            grader_name: Grader name to preserve or update
            new_source: Optional new source (AI or HUMAN)

        Returns:
            Tuple (success: bool, new_page_index: int | None, new_xref: int | None)
        """
        try:
            # Ensure document is open
            if self.doc is None:
                logger.error("Document not open, cannot move annotation")
                return (False, None, None)

            # Validate target page
            if new_page_index >= self.doc.page_count or new_page_index < 0:
                logger.error(
                    "Target page %d out of range (PDF has %d pages)",
                    new_page_index,
                    self.doc.page_count,
                )
                return (False, None, None)

            # Extract annotation properties
            info = annot.info or {}
            old_content = info.get("content", "")
            content = new_content if new_content is not None else old_content

            # Preserve grader_name from old annotation if not provided
            if grader_name is None:
                title_value = info.get("title")

                grader_name = title_value if title_value else None

            # Get annotation type
            annot_type_code = annot.type[0] if hasattr(annot, "type") else None
            annot_type = annot.type[1] if hasattr(annot, "type") else "Text"
            annot_type_name = str(annot_type).replace(" ", "").lower()
            is_text = annot_type_code == fitz.PDF_ANNOT_TEXT or annot_type_name == "text"
            is_freetext = annot_type_code == fitz.PDF_ANNOT_FREE_TEXT or annot_type_name in {
                "freetext",
                "textbox",
            }
            is_ink = annot_type_code == fitz.PDF_ANNOT_INK or annot_type_name in {"ink", "drawing"}

            # Get colors
            old_colors = annot.colors or {}
            old_stroke = old_colors.get("stroke", (1.0, 0.647, 0.0))  # Default amber

            # Determine RGB for new annotation
            if new_color:
                color_map = {
                    "red": (1.0, 0.0, 0.0),
                    "amber": (1.0, 0.647, 0.0),
                    "yellow": (1.0, 0.9, 0.0),
                    "green": (0.0, 0.784, 0.0),
                }
                rgb = color_map.get(new_color.lower(), old_stroke)
            else:
                rgb = old_stroke

            # Get rect (use new_rect if provided, otherwise use old rect)
            if new_rect:
                rect = fitz.Rect(new_rect)
            else:
                rect = fitz.Rect(annot.rect) if isinstance(annot.rect, tuple) else annot.rect

            # Preserve or generate a stable ID
            subject_metadata = _decode_subject_metadata(info.get("subject", ""))
            candidate_id = (
                stable_id
                or subject_metadata.get("stable_id")
                or info.get("name")
                or info.get("id")
                or info.get("title")
            )
            preserved_id = None if _is_annotation_type_name(candidate_id) else candidate_id
            effective_drawing_style = subject_metadata.get("drawing_style")
            effective_stroke_width = subject_metadata.get("stroke_width")
            effective_stroke_opacity = subject_metadata.get("stroke_opacity")

            logger.debug("Moving %s from page %d to %d", annot_type, old_page_index, new_page_index)

            # Get target page
            target_page = self.doc[new_page_index]

            # Create new annotation on target page
            new_annot = None
            if annot_type_name == "highlight":
                new_annot = target_page.add_highlight_annot(rect)
            elif annot_type_name == "squiggly":
                new_annot = target_page.add_squiggly_annot(rect)
            elif annot_type_name == "strikeout":
                new_annot = target_page.add_strikeout_annot(rect)
            elif annot_type_name == "underline":
                new_annot = target_page.add_underline_annot(rect)
            elif is_text:
                position = fitz.Point(rect.x0, rect.y0)
                new_annot = target_page.add_text_annot(position, content)
            elif is_freetext:
                textbox_rgb = new_stroke_color_rgb or subject_metadata.get("textbox_color_rgb")
                text_color = _rgb_ints_to_floats(textbox_rgb) or (0.0, 0.0, 0.0)
                new_annot = target_page.add_freetext_annot(
                    rect,
                    content,
                    fontsize=11,
                    fontname="helv",
                    text_color=text_color,
                    fill_color=(1.0, 1.0, 1.0),
                )
                new_annot.set_opacity(0.9)
            elif is_ink:
                source_page = self.doc[old_page_index]
                source_page_height = source_page.rect.height
                points_to_store = new_points or self._extract_ink_points_pdf(
                    annot, source_page_height
                )
                if len(points_to_store) < 2:
                    annot_ref = preserved_id or (
                        str(annot.xref) if hasattr(annot, "xref") and annot.xref else "unknown"
                    )
                    logger.error(
                        "Cannot move drawing annotation %s without at least 2 points",
                        annot_ref,
                    )
                    return (False, None, None)

                stroke_rgb = new_stroke_color_rgb or subject_metadata.get("stroke_color_rgb")
                stroke_rgb_float = _rgb_ints_to_floats(stroke_rgb)
                effective_drawing_style = effective_drawing_style or "pen"
                if effective_stroke_width is None:
                    effective_stroke_width = (
                        14.0 if effective_drawing_style == "highlighter" else 2.0
                    )
                if effective_stroke_opacity is None:
                    effective_stroke_opacity = (
                        0.35 if effective_drawing_style == "highlighter" else 1.0
                    )

                converted_points = [
                    (float(point[0]), float(target_page.rect.height - point[1]))
                    for point in points_to_store
                ]
                new_annot = target_page.add_ink_annot([converted_points])
                if stroke_rgb_float:
                    new_annot.set_colors(stroke=stroke_rgb_float)
                new_annot.set_border(width=effective_stroke_width)
                new_annot.set_opacity(effective_stroke_opacity)
            else:
                position = fitz.Point(rect.x0, rect.y0)
                new_annot = target_page.add_text_annot(position, content)

            if not new_annot:
                logger.error("Failed to create annotation on target page")
                return (False, None, None)

            # Set colors on the new annotation
            if not is_freetext and not is_ink:
                try:
                    new_annot.set_colors(stroke=rgb)
                except Exception as e:
                    logger.warning("Failed to set color: %s", e)

            # Set content for non-text annotations
            if not is_text and content:
                try:
                    _safe_set_info(new_annot, "content", content)
                except Exception as e:
                    logger.warning("Could not set content: %s", e)

            # Store UUID and source/verdict metadata in "subject" field (base64 encoded)
            try:
                if not preserved_id:
                    preserved_id = str(uuid.uuid4())
                source_to_set = (
                    new_source if new_source else (subject_metadata.get("source") or "AI")
                )
                original_source_to_set = subject_metadata.get("original_source")
                if new_source == "HUMAN" and not original_source_to_set:
                    original_source_to_set = subject_metadata.get("source") or "AI"

                effective_stroke_color_rgb = (
                    (new_stroke_color_rgb or subject_metadata.get("stroke_color_rgb"))
                    if is_ink
                    else subject_metadata.get("stroke_color_rgb")
                )
                effective_textbox_color_rgb = (
                    (new_stroke_color_rgb or subject_metadata.get("textbox_color_rgb"))
                    if is_freetext
                    else subject_metadata.get("textbox_color_rgb")
                )

                new_subject = _encode_subject_metadata(
                    preserved_id,
                    source_to_set,
                    original_source=original_source_to_set,
                    is_verdict=(
                        bool(subject_metadata.get("is_verdict"))
                        if new_is_verdict is None
                        else bool(new_is_verdict)
                    ),
                    drawing_style=effective_drawing_style,
                    stroke_width=effective_stroke_width,
                    stroke_opacity=effective_stroke_opacity,
                    stroke_color_rgb=effective_stroke_color_rgb,
                    textbox_color_rgb=effective_textbox_color_rgb,
                )
                _safe_set_info(new_annot, "subject", new_subject)
            except Exception as e:
                logger.error("Failed to set UUID/source in subject field: %s", e, exc_info=True)

            # Store grader_name in "title" field
            if grader_name:
                try:
                    _safe_set_info(new_annot, "title", _normalize_pdf_author_name(str(grader_name)))
                except Exception as e:
                    logger.error(
                        "Failed to set grader_name on moved annotation: %s", e, exc_info=True
                    )

            # Preserve creation date when moving; always refresh modification time.
            try:
                existing_creation_date = info.get("creationDate")
                if existing_creation_date:
                    _safe_set_info(new_annot, "creationDate", str(existing_creation_date))
                else:
                    _safe_set_info(new_annot, "creationDate", _format_pdf_datetime())
                _safe_set_info(new_annot, "modDate", _format_pdf_datetime())
            except Exception as date_error:
                logger.warning(
                    "Failed to store timestamp metadata on moved annotation: %s", date_error
                )

            # Update the new annotation
            new_annot.update()

            # Get the new annotation's xref BEFORE deleting the old one
            new_xref = new_annot.xref if hasattr(new_annot, "xref") else None

            # Delete old annotation from source page
            old_page = self.doc[old_page_index]
            try:
                old_page.delete_annot(annot)
            except Exception as e:
                logger.error("Failed to delete annotation from source page: %s", e)

            return (True, new_page_index, new_xref)

        except Exception as e:
            logger.error("Failed to move annotation: %s", e)
            return (False, None, None)

    def delete_annotation_by_xref(self, xref: int) -> bool:
        return self.delete_annotation(annotation_identifier=str(xref))

    def delete_annotation(self, annotation_identifier: str) -> bool:
        """
        Delete an annotation using its stable ID or xref number.

        Args:
            annotation_identifier: Stable annotation ID or legacy xref value

        Returns:
            True if deleted successfully, False otherwise
        """
        xref, annotation_id = self._parse_annotation_identifier(annotation_identifier)

        result = self._find_annotation(annotation_id=annotation_id, xref=xref)
        if not result:
            logger.warning("Annotation %s not found", annotation_identifier)
            return False

        page_index, annot = result

        try:
            # Refresh annotation reference from page
            if self.doc is None:
                logger.error("Document is not open")
                return False
            page = self.doc[page_index]
            annot_xref = annot.xref if hasattr(annot, "xref") else None

            if annot_xref:
                try:
                    annot = page.load_annot(annot_xref)
                except Exception as refresh_error:
                    logger.error(
                        "Failed to refresh annotation xref=%s for deletion: %s",
                        annot_xref,
                        refresh_error,
                    )
                    return False

                if annot is None:
                    logger.error("Failed to refresh annotation xref=%s for deletion", annot_xref)
                    return False

            page.delete_annot(annot)
            logger.info("Deleted annotation %s from page %d", annotation_identifier, page_index)
            return True

        except Exception as e:
            logger.error("Failed to delete annotation %s: %s", annotation_identifier, e)
            return False

    def add_annotations(self, annotations: List[PDFAnnotation]) -> int:
        """
        Add multiple annotations to the PDF.

        Args:
            annotations: List of PDFAnnotation objects

        Returns:
            Number of annotations successfully added
        """
        count = 0
        for annotation in annotations:
            if self.add_annotation(annotation):
                count += 1
        return count

    def save(self, output_path: Optional[Union[Path, str]] = None) -> Path:
        """
        Save the annotated PDF.

        Args:
            output_path: Path to save the annotated PDF. If None, overwrites original.

        Returns:
            Path to the saved PDF
        """
        if not self.doc:
            raise RuntimeError("PDF document not opened")

        if output_path is None:
            output_path = self.pdf_path
        else:
            output_path = Path(output_path)

        # Ensure output directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            # Use incremental save if overwriting, or full save if new file
            if output_path == self.pdf_path:
                # Force flush annotation metadata by accessing info dicts
                # This ensures PyMuPDF writes the info to disk

                sources_before_save = {}
                for page_num in range(self.doc.page_count):
                    page = self.doc[page_num]
                    for annot in page.annots():
                        info = annot.info or {}
                        xref = getattr(annot, "xref", None)
                        if xref:
                            sources_before_save[xref] = info.get("source")
                        _ = annot.info  # Access to force refresh

                self.doc.save(
                    str(output_path),
                    incremental=True,
                    encryption=fitz.PDF_ENCRYPT_KEEP,
                )
            else:
                self.doc.save(str(output_path))

            logger.info(f"Saved annotated PDF: {output_path}")
            return output_path

        except Exception as e:
            logger.error(f"Failed to save PDF to {output_path}: {e}")
            raise

    def get_annotations_on_page(self, page_index: int) -> List[dict]:
        """
        Get existing annotations on a page with stable xref identifiers.

        Args:
            page_index: Page number (0-indexed)

        Returns:
            List of annotation dictionaries with type, rect, color, content, xref, page_index.
            Rect coordinates are in PDF space (origin at bottom-left).
        """
        if not self.doc:
            logger.error("PDF document not opened")
            return []

        if page_index >= self.doc.page_count:
            logger.warning(f"Page {page_index} out of range")
            return []

        page = self.doc[page_index]
        annotations = []

        for annot in page.annots():
            try:
                info = annot.info or {}

                # Map color to our color names
                colors = annot.colors or {}
                stroke = colors.get("stroke", (0, 0, 0))
                if isinstance(stroke, (list, tuple)) and len(stroke) >= 3:
                    r, g, _b = stroke[0], stroke[1], stroke[2]
                    # Red: high red, low green
                    if r > 0.8 and g < 0.4:
                        color = "red"
                    # Amber: high red AND medium-high green (e.g., 1.0, 0.647, 0.0)
                    elif r > 0.8 and g > 0.4:
                        color = "amber"
                    # Green: low red, high green
                    elif r < 0.4 and g > 0.5:
                        color = "green"
                    else:
                        color = "amber"  # default
                else:
                    color = "amber"

                subject_metadata = _decode_subject_metadata(info.get("subject", ""))
                stable_id = subject_metadata.get("stable_id")

                grader_name = info.get("title")

                # If no stable ID in subject, check for legacy ID storage
                if not stable_id or _is_annotation_type_name(stable_id):
                    stable_id = info.get("name") or info.get("id")

                # Combine xref and stable_id for maximum compatibility
                xref = getattr(annot, "xref", None)
                if stable_id and xref:
                    combined_id = f"xref:{xref}|id:{stable_id}"
                elif stable_id:
                    combined_id = stable_id
                elif xref:
                    combined_id = str(xref)
                else:
                    combined_id = None

                page_height = page.rect.height
                rect = None
                if annot.rect:
                    rect = list(_pymupdf_rect_to_pdf(annot.rect, page_height))
                # Determine annotation type, with special handling for ink/freetext
                annot_type_str: str = annot.type[1] if hasattr(annot, "type") else "Unknown"
                extra_fields: dict[str, Any] = {}

                if hasattr(annot, "type") and annot.type[0] == fitz.PDF_ANNOT_INK:
                    annot_type_str = "drawing"
                    try:
                        pdf_points = self._extract_ink_points_pdf(annot, page_height)
                        if pdf_points:
                            extra_fields["points"] = pdf_points
                    except Exception as e:
                        logger.warning("Failed to extract ink points: %s", e)

                elif hasattr(annot, "type") and annot.type[0] == fitz.PDF_ANNOT_FREE_TEXT:
                    annot_type_str = "textbox"
                    if subject_metadata.get("textbox_color_rgb"):
                        extra_fields["stroke_color_rgb"] = subject_metadata["textbox_color_rgb"]

                if subject_metadata.get("drawing_style"):
                    extra_fields["drawing_style"] = subject_metadata["drawing_style"]
                if subject_metadata.get("stroke_width") is not None:
                    extra_fields["stroke_width"] = subject_metadata["stroke_width"]
                if subject_metadata.get("stroke_opacity") is not None:
                    extra_fields["stroke_opacity"] = subject_metadata["stroke_opacity"]
                if subject_metadata.get("stroke_color_rgb"):
                    extra_fields["stroke_color_rgb"] = subject_metadata["stroke_color_rgb"]

                annotation_data = {
                    "type": annot_type_str,
                    "rect": rect,
                    "color": color,
                    "content": info.get("content", ""),
                    "xref": xref,
                    "page_index": page_index,
                    "id": combined_id,
                    "stable_id": stable_id,  # Expose raw stable ID for direct lookup
                    "grader_name": grader_name,
                    "source": subject_metadata.get("source")
                    or "AI",  # Extract from subject field, default to AI
                    "original_source": subject_metadata.get("original_source"),
                    "is_verdict": bool(subject_metadata.get("is_verdict")),
                    **extra_fields,
                }
                # Debug: log what source is being read for this annotation
                logger.debug(
                    "Reading annotation xref=%s, stable_id=%s: source=%s (from info keys: %s), full_info=%s",
                    xref,
                    stable_id,
                    annotation_data["source"],
                    list(info.keys()) if info else [],
                    dict(info) if info else {},
                )
                annotations.append(annotation_data)

            except Exception as e:
                logger.warning(f"Error reading annotation: {e}")
                continue

        return annotations

    def find_text_location(
        self, page_index: int, search_text: str, fuzzy: bool = True
    ) -> Optional[BBox]:
        """
        Find the bounding box of specific text on a page.

        Args:
            page_index: Page number (0-indexed)
            search_text: Text to search for
            fuzzy: If True, allow partial/fuzzy matching

        Returns:
            BBox if found, None otherwise
        """
        if not self.doc:
            logger.error("PDF document not opened")
            return None

        if page_index >= self.doc.page_count:
            return None

        page = self.doc[page_index]
        text_instances = page.search_for(search_text)

        if text_instances:
            rect = text_instances[0]
            return BBox(x0=rect.x0, y0=rect.y0, x1=rect.x1, y1=rect.y1)

        if fuzzy and len(search_text) > 10:
            partial = search_text[:10]
            text_instances = page.search_for(partial)
            if text_instances:
                rect = text_instances[0]
                return BBox(x0=rect.x0, y0=rect.y0, x1=rect.x1, y1=rect.y1)

        return None

    def add_smart_annotation(
        self,
        page_index: int,
        search_text: str,
        annotation_type: AnnotationType,
        color: AnnotationColor,
        comment: str = "",
        check_id: str = "",
        fallback_bbox: Optional[BBox] = None,
    ) -> bool:
        """
        Add an annotation with smart positioning based on text search.

        Finds the text location automatically and places the annotation there.

        Args:
            page_index: Page number (0-indexed)
            search_text: Text to search for and annotate
            annotation_type: Type of annotation
            color: Color/priority of annotation
            comment: Comment text
            check_id: Check ID for tracking
            fallback_bbox: Fallback bounding box if text not found

        Returns:
            True if annotation was added, False otherwise
        """
        bbox = self.find_text_location(page_index, search_text)

        if not bbox:
            if fallback_bbox:
                bbox = fallback_bbox
                logger.warning(f"Text '{search_text}' not found, using fallback position")
            else:
                logger.error(f"Text '{search_text}' not found and no fallback provided")
                return False

        annotation = PDFAnnotation(
            page_index=page_index,
            bbox=bbox,
            kind=annotation_type,
            color=color,
            comment=comment,
            check_id=check_id,
        )

        return self.add_annotation(annotation)
