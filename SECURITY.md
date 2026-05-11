# Security policy

## Reporting a vulnerability

Please email **security@aems.app** with the details. Do not file a public GitHub issue for security-sensitive reports.

When reporting, include:

- A description of the issue.
- Steps to reproduce, or a proof-of-concept.
- The version (`aems_pdf_annotator.__version__`).
- Your assessment of impact.

We will acknowledge within a reasonable time. There is currently no bug-bounty programme.

## Supported versions

This is a fast-moving library. Only the current `main` branch and the latest released version on PyPI are supported. Older releases will not receive backports.

## Scope

The library renders annotations onto user-supplied PDFs via [PyMuPDF](https://pymupdf.readthedocs.io). Vulnerabilities in PyMuPDF itself are tracked upstream. Issues that are specific to this library — invalid contract payloads, coordinate-injection, validator bypasses, etc. — are in scope here.
