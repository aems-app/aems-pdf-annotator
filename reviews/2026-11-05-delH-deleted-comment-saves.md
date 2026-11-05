# delH: deleted comment saves

Scope: `fix/2026-11-05-deleted-comment-saves`, base `259d53a` (#25).
No push, host checkout edits, dependency installation, grading changes, or deployment.

## Behavior and reuse

- Successful DELETE records the old identity for the current document, blocks queued and subsequent writes, ignores late PUT responses, closes matching editors, and retires retained create-retry callbacks. Existing delete undo explicitly POSTs a replacement and `remapAnnotationHistory` moves its timeline to the replacement identity. Earlier history remains usable after recreation.
- Content PUT 404 retains the live draft and offers one translated recovery action. Save, blur, and joined callers share the handled failure. Recovery POSTs the latest text once; failures retain the draft and permit another explicit attempt. Document epochs guard recovery callbacks and responses.
- Starting another box calls existing `closeEmptyNewDrafts`, `_silentDeletes`, and captured document cleanup. It closes the empty editor immediately, waits for its pending create identity, and deletes once. Meaningful drafts retain their text and their separate persisted-content snapshot.

Reused: `resolveAnnotationWriteIdentity`, identity aliases, the content save lane, `isMissingAnnotationFailure`, `historyIdentityMatches`, `collapseInlineLabel`, `createAnnotationRequest`, rect conversion, local remove/upsert, history remapping, toast rendering, and the existing gesture/delayed-adapter harness. No new persisted submission fields.

## Test-first commits and reverted-fix evidence

| Item | Test commits before implementation | Fix | Reverted result |
| --- | --- | --- | --- |
| Deleted identity/editor/queue/retry handling | `6f328c0`, `dc57209`, `e8bfe50` | `54e4f4a` | 5 failed, 62 passed, 0 skipped across gesture and package modules |
| 404 draft recovery | `b6c7fcf`, `81b5c8a` | `800e0a9` | JS: 8 failed, 50 passed; catalog: 1 failed; 0 skipped |
| Empty box handoff | `e890d7c`, `2d227c2` | `45e2efc` | 5 failed, 58 passed, 0 skipped |
| Joined 404 outcome | `869b6f0` | `a515504` | 1 failed, 71 passed, 0 skipped |

Reverted checks used actual `git checkout <pre-fix> -- <implementation file>` and restored saved implementation bytes in `finally`. The new catalog was removed and restored for its reverted check. Logs: `.test-output/logs/delH-item1-reverted.log`, `delH-item2-reverted.log`, `delH-translation-reverted.log`, `delH-item3-reverted.log`, and `delH-joined-reverted.log`.

`dc57209` preserves the existing explicit recreation alternative allowed by the task. `e8bfe50` changes a package harness wait to observe DELETE instead of requiring a marker after its deletion; request identity and server-state assertions remain. `2b65dc2` adds lifecycle and legacy DOM identity checks without another implementation change.

## Verification

- Full Vitest: **645 passed, 0 failed, 0 skipped, 34 files**. Every source importer is included in this suite.
- Gesture module: **77 passed, 0 failed, 0 skipped**.
- Python: **107 passed, 0 failed, 0 skipped** using `D:/temp/artem/aems/venv/Scripts/python.exe -m pytest tests -q --basetemp=.test-output/pytest-delH`. `PYTHONPATH` used this worktree's Windows-form `src;vendor-packages/aems-pdf-annotator/src`, and the imported `aems_pdf_annotator.__file__` was printed from this checkout. `AEMS_TEST_RUN_KIND=delH`.
- `npm run build`: passed. Generated JS, map, and CSS remain ignored under `web/annotator-ui/dist`.
- Babel compile: passed with `python -m babel.messages.frontend compile -d src/aems/web/translations -l sv`. The Python catalog test reads the actual compiled Swedish MO file.
- ESLint: 0 errors, 3 warnings in unchanged code. The same constructs are present at base `259d53a`.
- `git diff --check`: passed. DRY review covered both changed modules and neighboring save/delete/history paths.

Baseline: the first run lacked generated `dist`, causing two test failures and one collection failure. Building the unchanged base resolved these prerequisites. The built baseline had 611 existing passing tests and only the seven then-new gesture regressions failing; no pre-existing test failures remained.

Logs and coverage artifacts live in ignored `.test-output/`. The focused V8 changed-line branch collection measured **100/108 (92.59%)**. The full-suite collection measured **97/108 (89.81%)**; the collection results differ, so the focused result is not a claim that full-suite collection exceeds 90%. `.test-output/changed-coverage.py` intersects V8 branch start lines with added/changed lines from `git diff --unified=0 259d53a`.

Uncovered focused arcs: `pdf-preview-modal.js:1568` (id fallback), `1723` (already registered recovery), `1726` (no local entry), `1840` (no local entry during invalidation), `3683` (concurrent-save suppression), `4645` (canceled history failure); `annotation-controller.js:2478` (deleted delayed-open callback without discard). Full-suite tests cover some of these paths; retain both collection artifacts when comparing results.

Added test shape: 1 Python unit test and 34 DOM integration cases, no browser end-to-end tests. The DOM cases exercise actual editor, controller, host transport, timer, and history wiring required by the requested regression sources. The harness replaces layout/PDF decoding and transport only.

## Not yet verified

- The exact production gesture and live browser/PDF behavior.
- Host bundle sync, host translation catalog integration, deployment, and production probes. The requested `src/aems/web/translations/sv/LC_MESSAGES/messages.po` is a catalog fragment in this source worktree, not an edit to the AEMS checkout or its existing full catalog.
