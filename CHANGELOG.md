# Changelog

All notable changes to `aems-pdf-annotator` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [SemVer](https://semver.org/).

## Unreleased

### Added

- Redo in the review modal (issue #540). Ctrl+Y and Ctrl+Shift+Z (Cmd+Y and Cmd+Shift+Z on macOS) re-apply the last undone edit, priority change, move, highlight resize, delete, pen-stroke delete, or creation of a pen stroke or text box, with the same request as the original action, so the annotation, its ownership included, returns to its post-action state. Any new operation, clearing the undo history, and opening another document clear the redo history. Inside text fields the browser keeps its own redo. A redo whose request fails or is refused stays queued, and one whose annotation no longer exists is dropped.
- Ctrl+Z undoes creating a pen stroke or a text box. It deletes the markup the way the Delete key does, and redo brings it back as it was when undone.

### Fixed

- Opening an inline comment editor initialises focus and the caret immediately, preserving typing, selection changes, and deliberate focus moves during its first 50 ms. Deferred resizing ignores closed or replaced editors.
- An undo or redo the server refuses no longer counts as done: nothing changes on the page, and it can be retried. A pen-stroke deletion refused on redo no longer disappears from the page, and a later undo no longer creates a duplicate.
- An undo or redo still in flight when another submission opens no longer changes that submission or its history.
- An operation completed while an undo or redo is in flight is recorded and can be undone. It clears redo, and the late step goes below it.
- A priority change the server stores without echoing the annotation no longer shows it as transferred to the teacher.

- Ctrl+Z after opening another submission in the review modal no longer replays the previous submission's last operation against the new one. The modal's undo history now starts empty for each document, as the annotation controller's already did.
- Split-view comments now move to the teacher panel after a text-anchored ownership transfer, and back to the AI panel when undoing a same-page ownership move. PDF author naming is unchanged.

## 0.3.0 — 2026-05-21

Sidebar action wiring + PDF render reliability fixes uncovered during the hosted-Canvas live verification on `api.aems.app`. All changes are in the `web/annotator-ui` bundle; the Python rendering API is unchanged.

### Fixed

- **Page renders no longer get stuck blank when the modal reflows mid-render.** When the `ResizeObserver`-driven `reRenderAllPages → renderSkeleton` ran while `renderSpecificPage(pageNum)` was awaiting its `page.render(...).promise`, the captured canvas could be detached and replaced by a fresh blank canvas. The render task still resolved against the orphaned canvas and `renderedPages.add(pageNum)` was called, so the `IntersectionObserver` skipped re-rendering and the fresh canvas stayed transparent forever. `renderSpecificPage` now drops the result when `canvas.isConnected` is false or the wrapper's current canvas no longer matches the captured one, letting the observer re-render onto the live canvas. Symptom (was): page 5 on a real Heine submission rendering as a solid gray rectangle in fullscreen + split view. (BUG-5)
- **Sidebar Delete button always shows the inline `Delete? / Cancel` confirm.** The previous implementation only mounted the confirm pair when the source button had a `.btn-group` ancestor, which the current stacked `.annotation-action-row` markup does not. A single click destroyed the annotation server-side with no warning. The mount now matches `.annotation-action-row, .btn-group`, and `deleteAnnotation` refuses to fall through to a real `DELETE` when the source button has been detached by an overlapping handler (the controller's delegate now also consumes the click via `preventDefault + stopPropagation + stopImmediatePropagation` so the monolith's outer handler does not replay it). (BUG-4)
- **Sidebar Revert-to-AI button now reaches the endpoint with the stable server identifier.** The click previously sent the composite `xref|id` token, which the server rejected silently. The controller now extracts the stable id explicitly via `extractAnnotationStableName` (preferring `stable_id` over the composite), and the monolith fallback uses the same extractor + `dataset.annotationStableId` from the button before calling the request helper. (BUG-3)
- **Annotation marker drag transfers ownership AI → Human in place.** Source flips on the sidebar card and the on-PDF marker without reopening the modal, and a Revert-to-AI affordance surfaces on the row.
- **Split view is fullscreen-only.** Toggling out of fullscreen drops split mode immediately and the split toggle hides; reopening the modal defaults to single-panel.
- **Sidebar layout no longer overlaps at narrow widths.** Meta-row (verdict, source badge, author, priority dots) wraps cleanly above the action row at the Comments column width.
- **Coordinate validation and annotation lookup hardened.** Scan-time defenses against malformed coordinates and lookup mismatches.

### Added

- `extractAnnotationStableName` is now exposed on the `_h` host helpers from `pdf-preview-modal.js`, so any wiring that needs to resolve an annotation's stable name does so through a single normalizer.
- New vitest regressions:
  - `tests/annotation-controller.test.js` — revert button calls with the stable id; first delete click shows `Delete? / Cancel` without sending a DELETE; stale detached delete button replayed by overlapping handlers is a no-op.
  - `tests/pdf-viewer.test.js` — a page render whose canvas is detached mid-flight is discarded and the page is left out of `renderedPages` so the observer can re-render against the live canvas.

### Note
This release is the consolidated outcome of the five `master`-branch commits between `0.2.0` and this tag: `5bb9453` (coordinate / lookup hardening), `be4e3cf` (layout, fullscreen-only split, drag-ownership), `af9a46a` (BUG-3 stable-id wiring), `79a9f4f` (BUG-4 confirm + stale-detached-button guard), and `0f84574` (BUG-5 orphaned-canvas guard). Web bundle version `@aems/pdf-annotator-ui` bumps `0.1.0 → 0.3.0` to keep in step with the Python package.

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
