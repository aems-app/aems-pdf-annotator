# aems-pdf-annotator

Schema-driven PDF annotation engine for AEMS — the [Assisted Exam Marking System](https://aems.app).

## What this is

A small, focused library that takes a structured annotation payload (LLM output, rubric verdicts, page-anchored highlights) and draws it onto a PDF using [PyMuPDF](https://pymupdf.readthedocs.io). It powers the annotated marker PDFs that AEMS returns to instructors.

Key surfaces:

- `PDFAnnotation`, `BBox`, `AnnotationBatch` — typed models for the annotation payload (Pydantic v2).
- `payload_to_annotations()`, `feedback_items_to_annotations()` — convert AEMS LLM output (the "annotation contract") into typed annotation objects.
- `PDFAnnotator`, `apply_annotations()`, `apply_annotation_batch()` — open a PDF, draw the annotations, save.
- Validator + schemas — invariants on coordinates, colours, icons, verdicts.

## Installation

```bash
pip install aems-pdf-annotator
```

Or from source:

```bash
pip install git+https://github.com/aems-app/aems-pdf-annotator
```

Requires Python 3.10+.

## Minimal example

```python
from aems_pdf_annotator import (
    PDFAnnotation, BBox, AnnotationColor, AnnotationType,
    apply_annotations,
)

annotations = [
    PDFAnnotation(
        page=1,
        bbox=BBox(x=0.10, y=0.20, width=0.40, height=0.04),
        annotation_type=AnnotationType.HIGHLIGHT,
        color=AnnotationColor.GREEN,
        content="Correct identification of the boundary condition.",
        is_verdict=False,
    ),
    PDFAnnotation(
        page=1,
        bbox=BBox(x=0.80, y=0.20, width=0.03, height=0.03),
        annotation_type=AnnotationType.STAR,
        color=AnnotationColor.GREEN,
        content="PASS",
        is_verdict=True,
    ),
]

apply_annotations(
    input_pdf_path="input.pdf",
    output_pdf_path="annotated.pdf",
    annotations=annotations,
)
```

Coordinates are normalised (`0.0`–`1.0`) with `(0, 0)` at the **top-left** of the page; the renderer converts to PDF bottom-left internally.

## Contract version

The LLM-output payload format follows a versioned contract. Current values are exported as `CURRENT_CONTRACT_VERSION` and `CURRENT_COORDINATE_SPACE`. `payload_to_annotations()` validates the incoming payload's contract version against `SUPPORTED_CONTRACT_VERSIONS` and raises `ContractValidationError` on a mismatch.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

This package wraps [PyMuPDF](https://github.com/pymupdf/PyMuPDF), which is itself licensed under AGPL-3.0. **Any program that imports `aems_pdf_annotator` in-process inherits the AGPL combined-work obligations.** If that does not fit your distribution model, commercial PyMuPDF licensing is available from [Artifex](https://artifex.com).

## Links

- Homepage: [https://aems.app](https://aems.app)
- Source: [https://github.com/aems-app/aems-pdf-annotator](https://github.com/aems-app/aems-pdf-annotator)
- Issues: [https://github.com/aems-app/aems-pdf-annotator/issues](https://github.com/aems-app/aems-pdf-annotator/issues)
