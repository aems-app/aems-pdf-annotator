"""Native appearance fallback when optional MuPDF device support fails."""

from pathlib import Path
import subprocess
import sys

import pytest

from aems_pdf_annotator._fitz import fitz
from aems_pdf_annotator.core import PDFAnnotator, fit_existing_textboxes


def test_import_and_native_textbox_without_fzdevice2(tmp_path: Path) -> None:
    # Fresh import with a monkeypatched MuPDF module, isolated from pytest's imports.
    script = """
from pathlib import Path
import sys
import pymupdf
from pytest import MonkeyPatch

with MonkeyPatch.context() as patch:
    patch.delattr(pymupdf.mupdf, 'FzDevice2')
    from aems_pdf_annotator import AnnotationColor, AnnotationType, BBox, PDFAnnotation, PDFAnnotator

    source = Path(sys.argv[1]) / 'blank.pdf'
    output = source.with_name('native.pdf')
    with pymupdf.open() as doc:
        doc.new_page()
        doc.save(source)
    with PDFAnnotator(source) as writer:
        for index, comment in enumerate(('A plain comment', 'Notation: \\u0394x\\u2080')):
            assert writer.add_annotation(PDFAnnotation(
                id=f'comment-{index}', page_index=0, kind=AnnotationType.TEXTBOX,
                color=AnnotationColor.RED, comment=comment, grader_name='Teacher',
                bbox=BBox(x0=20, y0=20 + 80 * index, x1=240, y1=80 + 80 * index),
            ))
        writer.save(output)
    with pymupdf.open(output) as doc:
        page = doc[0]
        plain, notation = page.annots()
        assert plain.get_text().strip() == 'A plain comment'
        assert notation.info['content'] == 'Notation: \\u0394x\\u2080'
        ap = int(doc.xref_get_key(notation.xref, 'AP/N')[1].split()[0])
        assert '/AEMSSans' not in doc.xref_get_key(ap, 'Resources/Font')[1]
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)], capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert len(result.stderr.splitlines()) == 1, result.stderr
    assert "notation" in result.stderr.lower()


@pytest.mark.parametrize("in_place", [False, True])
@pytest.mark.parametrize("needs_repair", [False, True])
def test_save_keeps_appearance_when_pdf_run_annot_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
    in_place: bool, needs_repair: bool,
) -> None:
    source = tmp_path / "original.pdf"
    text = "Notation: \u0394x\u2080"
    with fitz.open() as doc:
        page = doc.new_page(width=300, height=300)
        rect = fitz.Rect(20, 20, 200, 75) if not needs_repair else fitz.Rect(20, 20, 310, 75)
        annot = page.add_freetext_annot(rect, text)
        xref = annot.xref
        ap = int(doc.xref_get_key(xref, "AP/N")[1].split()[0])
        appearance = doc.xref_stream(ap)
        resources = doc.xref_get_key(ap, "Resources")
        doc.save(source)

    original_run = fitz.mupdf.pdf_run_annot

    def fail_on_original(annotation: object, device: object, *args: object) -> None:
        # Leave disposable sizing probes functional. An out-of-page rectangle
        # then fails at the post-update containment measurement.
        if not needs_repair or getattr(device, "local", False):
            raise RuntimeError("injected pdf_run_annot failure")
        original_run(annotation, device, *args)

    monkeypatch.setattr(fitz.mupdf, "pdf_run_annot", fail_on_original)
    saved = source if in_place else tmp_path / "saved.pdf"
    with PDFAnnotator(source) as writer:
        writer.save(saved)

    with fitz.open(saved) as doc:
        page = doc[0]
        annot = page.load_annot(xref)
        assert annot.info["content"] == text
        assert annot.rect == rect
        assert doc.xref_get_key(xref, "AP/N")[1] == f"{ap} 0 R"
        assert doc.xref_stream(ap) == appearance
        assert doc.xref_get_key(ap, "Resources") == resources
    warnings = [record.message for record in caplog.records if record.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "appearance" in warnings[0].lower()


def test_failed_repair_leaves_missing_appearance_unchanged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    original_run = fitz.mupdf.pdf_run_annot

    def fail_containment(annotation: object, device: object, *args: object) -> None:
        if getattr(device, "local", False):
            raise RuntimeError("injected containment failure")
        original_run(annotation, device, *args)

    monkeypatch.setattr(fitz.mupdf, "pdf_run_annot", fail_containment)
    with fitz.open() as doc:
        page = doc.new_page(width=300, height=300)
        rect = fitz.Rect(20, 20, 310, 75)
        annot = page.add_freetext_annot(rect, "Legacy textbox")
        doc.xref_set_key(annot.xref, "AP", "null")
        assert fit_existing_textboxes(doc) == 0
        assert doc.xref_get_key(annot.xref, "AP/N")[0] == "null"
        assert page.load_annot(annot.xref).rect == rect
    assert sum(record.levelname == "WARNING" for record in caplog.records) == 1
