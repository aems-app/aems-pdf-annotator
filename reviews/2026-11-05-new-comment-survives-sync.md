# New comment disappears before save

Scope: `fix/2026-11-05-new-comment-survives-rerender`, base `7f81edf`.
All edits, build output, caches and test logs stay in this worktree. The AEMS
host at `C:/Temp/aems/worktrees/wt-ui3-1105` was inspected read-only. No push,
vendor update or deployment was performed.

## Proven cause

At the base revision, `annotation-controller.js:1111` only sets its private
`_skipNextPoll`; its `_checkVersion` is a transitional no-op. Create calls this
hook before the POST finishes (`:2365`) and never tells the actual version-sync
instance about the resulting server version. The modal's working bridge,
`pdf-preview-modal.js:1781`, is not wired into the controller.

Consequently, the next 10-second version poll sees the teacher's own POST as an
external change and calls the controller's reload. At base
`annotation-controller.js:2192`, reload invokes `cleanupPlaceholderAnnotations`
(`pdf-preview-modal.js:6458`). That cleanup DELETEs every unedited placeholder
from the freshly fetched list, including this teacher's newly created comment
and another reviewer's empty draft. A later PUT to the original ID then fails.
The integration regression exercises the real modal, controller, version sync
and overlay renderer, with a stateful host adapter that rejects PUT after DELETE.

Geometry changes alone did not reproduce deletion: scroll, resize and fullscreen
cases pass even with the fix reverted. The existing overlay guard at
`overlay-renderer.js:202` already preserves an inline editor across forced
geometry renders. This evidence does not establish why the production incidence
increased today, or attribute that increase to PR #19 or #20.

## Changes

- After a successful POST, and after update/delete/other controller mutations,
  notify the active version tracker through the existing epoch-protected bridge.
- Defer list loads while an editor is open, without a timeout that expires an
  active edit. Recheck after drawing-idle waits and network completion. Discard
  a response that raced opening an editor and refetch after close, rather than
  replaying a stale snapshot over the teacher's save. Cancel retries on teardown
  or document-epoch changes.
- Preserve an existing sidebar textarea during rendering, including its draft,
  focus and selection. Explicit save closes the inline editor before rendering.
- Remove list-load placeholder garbage collection. Only explicit close/cancel
  paths discard empty drafts; focus loss does not delete them.
- Retain lifecycle and stale-document coverage, updating expectations for the
  intentionally preserved textarea and retaining a separate no-delete blur case.

## Test-first history and verification

`c0afeea` commits the initial production regression before implementation.
`005d18a` adds in-flight reload, own mutation version, sidebar and blur cases,
also before the fix commit. Both retain the requested attribution trailers.

The continuation independently replaced the two changed implementation files
with their committed pre-fix contents, ran the committed regression suite, and
restored both files byte-for-byte in a `finally` block:

- Reverted fix: **7 failed, 3 passed** (10 tests), exit 1. The three passing cases
  are scroll, resize and fullscreen geometry renders. Log:
  `.test-output/red-continuation.log`.
- Fixed full Vitest suite: **548 passed, 33 files**, exit 0. Log:
  `.test-output/vitest-final.log`.
- Python: **106 passed**, exit 0, including real PyMuPDF tests. Log:
  `.test-output/python-continuation.log`.
- `npm run build`: exit 0. Rollup generated `web/annotator-ui/dist/annotator-ui.js`,
  its source map and CSS. `git ls-files web/annotator-ui/dist` is empty and
  `git check-ignore` confirms the bundle is ignored. Log:
  `.test-output/build-continuation.log`.

Fake timers cover own POST then the 10-second poll, typing and PUT to the same
ID, own update/delete version adoption without list reload, an external change
held beyond the drawing timeout and applied after save, a response already in
flight when an existing editor opens, sidebar focus/caret retention, explicit
cancellation, focus loss, and another reviewer's empty placeholder.
