# guardJ: refuse duplicate stable annotation identities

## Decision

`PDFAnnotator.save()` raises the exported `DuplicateAnnotationIdError(RuntimeError)`
before writing when any stable ID repeats, irrespective of page or AI/HUMAN source.
Its `stable_id` attribute identifies the collision. No annotation is deleted or
silently selected; original and existing destination bytes are preserved, and a
new destination is not created. This is intentionally a failed save, not a
validation `ValueError` that a host might map to an ordinary input error.

The guard reuses `_decode_subject_metadata`, the reader's legacy identity lookup
(extracted as `_annotation_stable_id`), and the prior save-time annotation-info
traversal. It does not use the xref-bearing row `id`, reopen the PDF, or call the
reader that catches and skips annotation-read errors. Empty identities and type/icon
placeholders are ignored. Existing reader behavior is preserved.

## Verification (2026-11-06, this worktree)

- Test-first commit: `9b87994`; initial regression result: **18 failed, 4 passed**.
  Each failure was `DID NOT RAISE RuntimeError`, with colliding stable IDs but
  distinct xref-bearing row IDs verified before the attempted save.
- Restoring `core.py` and `__init__.py` with `git checkout 6f4a934 -- <files>`:
  full Python suite **18 failed, 111 passed, 0 skipped**. Fixed files restored
  afterward. No stash was used.
- Fixed full Python suite: **129 passed, 0 failed, 0 skipped**, including every
  local importer (`__init__`, `convenience`, and all Python test modules).
- All 107 pre-existing Python tests pass unchanged. **No existing duplicate-
  producing test required correction.**
- Added test shape: **22 integration cases, 0 unit, 0 E2E**. Real PyMuPDF and
  disk files are necessary to check persisted byte identity, incremental/full
  writes, and real subject/legacy-field decoding rather than mock behavior.
- `--cov-branch`: **10/10 changed-line branch arcs covered (100%)**, no missing
  changed-line arcs. Whole `core.py` is 60%; that is not the new-code metric.
- Full `npx vitest run`: **645 passed, 0 failed, 0 skipped**, 34 test files.
  Initial run before the required build: 636 passed, 2 failed, 1 suite-load
  error because ignored `dist/annotator-ui.js` did not exist. `npm run build`
  succeeded; the subsequent full suite has no remaining pre-existing failures.
- Timing: **30 pages, 300 annotations, 101 runs after one warmup** on the same
  open document: guard median **22.262 ms**, min 17.060 ms, max 35.137 ms.
  One complete new-file save including validation: **32.663 ms**. Timed with
  `perf_counter_ns`; generation, initial open, and warmup excluded from guard
  timing. Local reproducibility/evidence: `.test-output/measure_guard.py`,
  `.test-output/guardJ-measurements.json`, `.test-output/guard-coverage.json`.
- DRY sweep: shared extraction replaces the reader's original inline block;
  validation replaces the save path's redundant info-only walk. No second
  metadata parser or persisted identity mechanism was introduced.
- OpenWolf searches were attempted, but this source repository has no initialized
  OpenWolf project/index. No unrelated `.wolf` metadata was created.

## AEMS host call sites

Read-only audit of `C:/Temp/aems/worktrees/wt-rel-1106/src`, verified by grep and
reading the host wrapper. `aems.pdf.annotator.core.PDFAnnotator` subclasses the
shared annotator and does not override `save`. These **13 runtime calls** inherit
the guard after the host adopts this package. Paths below are relative to
`src/aems/`; line numbers reflect the audit snapshot and may move in other lanes.

| File:line | Function / operation |
| --- | --- |
| `pdf/annotator/convenience.py:65` | `apply_annotations` |
| `export/teacher_feedback_note.py:111` | `with_teacher_feedback_note` |
| `grading/batch.py:769` | `annotate_pdf` |
| `offline/task_score_edit.py:168` | `persist_task_points_with_verdict` |
| `canvas/workflow/gated_repaint.py:132` | `strip_ai_annotations` |
| `pdf/feedback_box.py:207` | `sync_feedback_box` |
| `web/annotation_restore.py:217` | `restore_annotation_to_ai` |
| `web/offline/api.py:2887,3221,3355` | annotation create/update/delete |
| `web/api/v1/canvas/annotations.py:1712,2073,2238` | annotation create/update/delete |

The CRUD handlers currently turn a `RuntimeError` into a generic HTTP 500.
The restore helper propagates to its route; non-API helpers also propagate
(task-score persistence restores original bytes and re-raises). Higher-level
`apply_annotations` callers can catch it: annotation placement retries once and
then returns `None`; general-feedback rendering catches and returns `None`.
The host can catch `DuplicateAnnotationIdError` explicitly for a clean message.
No host handling or translations were modified in this source-only lane.

Two actual annotated-export writes **bypass this guard**:

- `pdf/student_release.py:123`, `strip_unconverted_uncertain`:
  `annotator.doc.save(str(target), no_new_id=True)`.
- `pdf/feedback_box.py:190`, `with_feedback_box`:
  `annotator.doc.save(str(target), no_new_id=True)`.

The claim that every annotated-PDF write uses `PDFAnnotator.save()` is therefore
not true of this host snapshot. Those direct native saves need host follow-up;
this lane does not modify the host worktree or broaden the save signature.

## Not yet verified

- Host package adoption, clean localized exception presentation, and removal of
  the two native-save bypasses: outside this worktree's authorized edit scope.
- Live GUI, production PDF writes, and deployment: not performed; nothing pushed.
