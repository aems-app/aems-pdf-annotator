"""Independent acceptance contract: no accepted text may silently lose semantic letters."""

from __future__ import annotations

from pathlib import Path
import unicodedata

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, _add_fitted_textbox, _encode_subject_metadata
from aems_pdf_annotator.models import AnnotationColor, AnnotationType, BBox, PDFAnnotation

SEPARATORS = [
    ("space", " "),
    ("tab", "\t"),
    ("nbsp", "\u00a0"),
    ("cr", "\r"),
    ("lf", "\n"),
    ("crlf", "\r\n"),
    ("zero-width-space", "\u200b"),
    ("zero-width-joiner", "\u200d"),
    ("soft-hyphen", "\u00ad"),
    ("unbroken", ""),
    ("combining", "\u0301"),
    ("swedish", "\u00e5\u00e4\u00f6\u00c5\u00c4\u00d6"),
    ("narrow-nbsp", "\u202f"),
    ("figure-space", "\u2007"),
]
SEPARATORS += [(f"C0-{n:02x}", chr(n)) for n in range(1, 32) if n not in (9, 10, 13)]
SEPARATORS += [("DEL", "\x7f")]
RECT = fitz.Rect(50, 50, 160, 72)


def semantic_letters(text: str) -> str:
    """Invisible/control and replacement punctuation do not constitute painted letters."""
    return "".join(c for c in text if unicodedata.category(c).startswith("L"))


def make_native(path: Path, rotation: int, text: str) -> dict[str, object]:
    with fitz.open() as doc:
        page = doc.new_page(width=595, height=842)
        page.set_rotation(rotation)
        annotation = page.add_freetext_annot(
            RECT, text, fontsize=11, rotate=rotation, text_color=(0, 0, 1)
        )
        annotation.set_info(
            subject=_encode_subject_metadata(
                "independent-control", "HUMAN", original_source="HUMAN"
            ),
            title="Synthetic Reviewer",
            creationDate="D:20200102030405Z",
            modDate="D:20200102030405Z",
        )
        if any(0x18 <= ord(character) <= 0x1F for character in text):
            # Native creation otherwise encodes these bytes as PDFDocEncoding
            # accents before the legacy reader under test ever receives them.
            encoded = "feff" + text.encode("utf-16-be").hex()
            doc.xref_set_key(annotation.xref, "Contents", "<" + encoded + ">")
            annotation.update()
        assert annotation.info["content"] == text, "native fixture corrupted the input"
        annotation.set_opacity(0.45)
        before = {
            "info": annotation.info.copy(),
            "xref": annotation.xref,
            "rect": tuple(annotation.rect),
            "rotation": annotation.rotation,
            "opacity": annotation.opacity,
        }
        doc.save(path)
    return before


@pytest.mark.parametrize("name,separator", SEPARATORS, ids=[n for n, _ in SEPARATORS])
@pytest.mark.parametrize("rotation", [0, 90])
@pytest.mark.parametrize("surface", ["native-add", "public-add", "public-edit", "legacy-save"])
def test_accepted_text_preserves_metadata_and_every_semantic_letter(
    tmp_path: Path,
    name: str,
    separator: str,
    rotation: int,
    surface: str,
) -> None:
    text = ("First" + separator + "second" + separator + "third" + separator) * 15 + "FINALWORD"
    source = tmp_path / "source.pdf"
    saved = tmp_path / "saved.pdf"
    before = None
    if surface == "native-add":
        with fitz.open() as doc:
            page = doc.new_page(width=595, height=842)
            page.set_rotation(rotation)
            _add_fitted_textbox(page, RECT, text, (0.0, 0.0, 1.0), rotation)
            doc.save(saved)
    elif surface == "public-add":
        with fitz.open() as doc:
            page = doc.new_page(width=595, height=842)
            page.set_rotation(rotation)
            doc.save(source)
        with PDFAnnotator(source) as writer:
            assert writer.add_annotation(
                PDFAnnotation(
                    page_index=0,
                    kind=AnnotationType.TEXTBOX,
                    color=AnnotationColor.RED,
                    source="HUMAN",
                    comment=text,
                    bbox=BBox(x0=50, y0=50, x1=160, y1=72),
                ),
                textbox_rotation=rotation,
            )
            writer.save(saved)
    else:
        before = make_native(
            source, rotation, "Original intact" if surface == "public-edit" else text
        )
        with PDFAnnotator(source) as writer:
            if surface == "public-edit":
                assert writer.update_annotation("independent-control", new_content=text)
            writer.save(saved)
    with fitz.open(saved) as doc:
        page = doc[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == text, f"{surface}/{name}: saved metadata changed"
        if before is not None:
            assert annotation.xref == before["xref"]
            assert tuple(annotation.rect) == before["rect"]
            assert annotation.rotation == before["rotation"]
            assert annotation.opacity == before["opacity"]
            expected_info = dict(before["info"])
            expected_info["content"] = text
            # User edits can legitimately update the modification date.
            if surface == "public-edit":
                expected_info["modDate"] = annotation.info["modDate"]
            assert annotation.info == expected_info
        painted = annotation.get_text()
        assert semantic_letters(painted) == semantic_letters(text), (
            f'{surface}/{name}/rotation{rotation}: '
            f'{len(semantic_letters(painted))}/{len(semantic_letters(text))} semantic letters; '
            f'tail={"FINALWORD" in painted}'
        )
        assert "FINALWORD" in painted, f"{surface}/{name}: tail missing"


@pytest.mark.parametrize("surface", ["native-add", "public-add", "public-edit"])
def test_nul_is_rejected_atomically_instead_of_truncating(tmp_path: Path, surface: str) -> None:
    source = tmp_path / "nul-source.pdf"
    before = make_native(source, 0, "Original intact FINALWORD")
    text = "Accepted prefix\x00LOSTTAIL"
    if surface == "native-add":
        with fitz.open(source) as doc:
            page = doc[0]
            count = len(list(page.annots()))
            with pytest.raises(ValueError):
                _add_fitted_textbox(page, RECT, text, (0.0, 0.0, 0.0))
            assert len(list(page.annots())) == count
    else:
        with PDFAnnotator(source) as writer:
            if surface == "public-add":
                result = writer.add_annotation(
                    PDFAnnotation(
                        page_index=0,
                        kind=AnnotationType.TEXTBOX,
                        color=AnnotationColor.RED,
                        source="HUMAN",
                        comment=text,
                        bbox=BBox(x0=50, y0=50, x1=160, y1=72),
                    )
                )
            else:
                result = writer.update_annotation("independent-control", new_content=text)
            assert result is False, "NUL text accepted despite native C-string truncation"
            page = writer.doc[0]
            annotations = list(page.annots())
            assert len(annotations) == 1
            assert annotations[0].info == before["info"], "rejected mutation changed native content"
