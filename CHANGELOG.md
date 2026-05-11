# Changelog

All notable changes to `aems-pdf-annotator` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [SemVer](https://semver.org/).

## 0.2.0 — 2026-05-11

First public OSS release. The `v0.1.0` version was previously published to PyPI from a private-repo iteration; PyPI does not allow re-uploading any version, so the first public-OSS tag is `v0.2.0`. The Python API is unchanged versus `v0.1.0`; this release adds the public surface required for an open-source project.

### Added

- `README.md` with install / minimal-usage / contract / licensing sections.
- `CONTRIBUTING.md` describing the dev workflow and test/lint commands.
- `SECURITY.md` with the disclosure address.
- `CHANGELOG.md` (this file).
- `[project.urls]` block in `pyproject.toml` (Homepage, Repository, Issues, Changelog).
- Project metadata: `readme`, `keywords`, `classifiers`, `authors[].email`, longer `description`.
- `.github/workflows/ci.yml` — pytest + mypy + ruff on push and PR (Python 3.10 and 3.12 on Ubuntu), plus a separate job for the `web/annotator-ui/` Rollup + Vitest UI bundle.

### Changed

- Version bumped from `0.1.0` to `0.2.0`. No breaking changes to the Python API.

## 0.1.0 — (internal pre-release, not in public history)

Internal-only PyPI release from a private repo. Established the annotation engine: typed models (`PDFAnnotation`, `BBox`, `AnnotationBatch`), schema-driven payload contract (`payload_to_annotations`, `feedback_items_to_annotations`), the `PDFAnnotator` renderer, and the validator suite.
