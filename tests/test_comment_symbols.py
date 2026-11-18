"""Teacher notation must survive the native FreeText appearance writer."""

from pathlib import Path

from aems_pdf_annotator import AnnotationColor, AnnotationType, BBox, PDFAnnotation, PDFAnnotator
from aems_pdf_annotator._fitz import fitz


SYMBOL_ROWS = (
    "α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω ϕ ϑ",
    "Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω",
    "± × · ÷ ° ≈ ≠ ≤ ≥ ∞ √ ∂ ∇ ∑ ∫ → ⇒ ∝ ′ ″ ² ³ ⁻¹ ₀ ₁ ₂ ₓ ᵧ",
)


def test_teacher_symbols_paint_and_extract(tmp_path: Path) -> None:
    source = tmp_path / "blank.pdf"
    saved = tmp_path / "teacher-symbols.pdf"
    text = "\n".join(SYMBOL_ROWS)
    with fitz.open() as document:
        document.new_page(width=420, height=125)
        document.save(source)
    with PDFAnnotator(source) as writer:
        assert writer.add_annotation(PDFAnnotation(
            id="teacher-symbols", page_index=0, kind=AnnotationType.TEXTBOX,
            color=AnnotationColor.RED, source="HUMAN", comment=text,
            grader_name="fixture-teacher", bbox=BBox(x0=20, y0=20, x1=400, y1=105),
        ))
        writer.save(saved)
    with fitz.open(saved) as document:
        page = document[0]
        annotation = next(page.annots())
        assert annotation.info["content"] == text
        assert annotation.get_text().split() == text.split()
        page.get_pixmap(matrix=fitz.Matrix(3, 3)).save(tmp_path / "teacher-symbols.png")
        document.bake(annots=True, widgets=False)
        # A ToUnicode map can extract correctly even while a font paints .notdef.
        painted = {
            chr(codepoint)
            for span in document[0].get_texttrace()
            for codepoint, glyph_id, *_ in span["chars"]
            if glyph_id > 0
        }
        assert set("".join(text.split())) <= painted
