# Inline editor deferred caret reset — 2026-10-20

The measured inline-opening race is fixed in the annotator source. Focus and caret
initialisation now happen synchronously after the textarea is attached. The 50 ms
callback performs only auto-resizing and ignores retired editor instances.

## Change and coverage

- `web/annotator-ui/src/pdf-preview-modal.js:3205`: initialise focus with the existing
  `focusElementWithoutScroll` helper and selection `(0, 0)` immediately. There is no
  deferred focus or selection write in this opener anymore, so typing, caret-only
  movement, backward selection, and deliberate focus changes cannot be overwritten
  by its opening timer. Initial focus and the visible caret-at-start result remain.
- `web/annotator-ui/src/pdf-preview-modal.js:3211`: retain the existing 50 ms
  `autoResize()` pass, guarded by document history epoch, connectivity, and the
  textarea identity within the label. A closed/replaced/detached editor cannot
  resize itself or reposition a replacement through this callback.
- The `autoResize` implementation, input listeners, repositioning calls, style
  limits, sidebar synchronisation, priority strip, and save/blur handlers are
  unchanged. Resizing still runs on input and at the original opening deadline.
- `web/annotator-ui/tests/inline-editor-caret.test.js:52`: eight fake-timer cases
  exercise the real double-click opener via `setupLabelTooltipEvents`, importing
  the source module. They cover typing across 50 ms; caret-only movement; backward
  selection without text changes; idle focus/caret both immediately and after
  50 ms; close/reopen with separate old/new deadlines; overlay detachment; focus
  moved to another control; and the retained deferred resize, 200 px input resize
  cap, and priority strip. Detached-editor checks spy on focus, selection, and
  layout reads, rather than relying on detached focus being a browser no-op.
- `CHANGELOG.md:14`: document the fix under Unreleased / Fixed.

## RED evidence, observed before the production change

Command (working directory `web/annotator-ui`):

```text
npm test -- tests/inline-editor-caret.test.js --configLoader native --cache=false
```

The fixture opens an empty placeholder editor, advances 10 ms, inserts `C` at the
live caret, advances another 40 ms, then inserts `aret probe text.` at the live
caret. jsdom has no default key-to-text insertion, so the helper uses
`setRangeText(..., 'end')` followed by an `input` event.

Exact failure at `tests/inline-editor-caret.test.js:59:28`:

```text
expect(textarea.value).toBe('Caret probe text.');
AssertionError: expected 'aret probe text.C' to be 'Caret probe text.' // Object.is equality
Expected: "Caret probe text."
Received: "aret probe text.C"
```

RED result: **2 passed, 6 failed, 0 skipped** in **1 failed test file**.
Other observed failures: selection `(3, 3, none)` became `(0, 0, none)`;
`(2, 8, backward)` became `(0, 0, none)`; retired and detached textarea `focus`
spies were each called once; and the focus-theft assertion received the textarea
instead of the deliberately focused button. Idle opening and resize passed.
No production code was changed before this run.

## Deferred caret/selection audit

Searched all `web/annotator-ui/src` timers, focus calls, textarea selection APIs,
value restorations, and contenteditable Range operations. Locations below refer
to the final source. Explicit selection writes, implicit selection changes from
draft value replacement, indirect editor reopening, and focus-only timers are
distinguished so focus-only work is not mistaken for a proven caret reset.

| Location | Delay and behaviour | Disposition / reason |
| --- | --- | --- |
| `web/annotator-ui/src/pdf-preview-modal.js:3211` (formerly :3206) | 50 ms after inline opening; previously focused and called `setSelectionRange(0, 0)`. | **Fixed.** Focus/selection moved to :3207–3208; only guarded layout work remains deferred. |
| `web/annotator-ui/src/pdf-preview-modal.js:7712` | 60 ms after priority-update recovery. Restores the sidebar draft (:7720), focuses it, explicitly moves selection to the end (:7724); alternate-ID fallback restores/focuses (:7730). May reopen inline editing (:7750) and replace its value (:7754), implicitly moving its caret if the value differs. | **Unchanged; remaining timing risk.** This is asynchronous priority/draft recovery, separate from opening initialisation. Fixing it requires preserving the intended draft and focus across the priority response; it is reported here rather than changing that flow without a response-race fixture. |
| `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2656` | 50 ms after successful comment creation replaces an optimistic editor. Restores sidebar/inline draft values (:2661, :2669), implicitly moving selection if values differ, and focuses the inline editor (:2670). | **Unchanged; remaining timing risk.** This restores an in-flight creation draft. It needs a separate create-response/draft preservation fixture; removing the initial opening reset does not protect these value writes. |
| `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2689` | Nested 50 ms create-response fallback restores sidebar/inline values (:2694, :2701), with implicit selection changes if values differ. | **Unchanged; remaining timing risk.** Same asynchronous draft-restoration concern as the previous row, through the fallback branch. |
| `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2676` | Outer 0 ms create-response fallback calls `beginEdit` (:2681), rebuilding editors and indirectly initialising their selection; schedules the preceding 50 ms restoration. | **Unchanged.** Deferred reopening after a create-response render, rather than resetting the selection of the editor just opened. Its draft/focus lifecycle belongs with the two restoration paths above. |
| `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2346` | 50 ms optimistic comment creation looks up a label and calls `expandInlineLabelEdit` (:2387) only if it is not already editing. | **Shared opener fixed.** The outer scheduling remains; once this callback actually opens an editor, selection is now initialised synchronously. It does not reset an already-editing label. Its delayed opening can still move focus; no broader create-flow focus claim is made. |
| `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2250` | 50 ms sidebar `beginEdit`: auto-resize setup, then `_focusElementWithoutScroll(textarea)` (:2260). No explicit caret/selection write. | **Unchanged, focus-only risk.** It can reclaim focus after a deliberate move. Separate sidebar focus policy; it is not the measured inline caret reset. |
| `web/annotator-ui/src/pdf-preview-modal.js:8927` | 150 ms add-comment modal opening: `addCommentText?.focus()`. No selection write. | **Unchanged, focus-only risk.** This modal uses Bootstrap show timing; changing its focus lifecycle is separate from the already-attached inline editor. |

No additional explicit deferred textarea selection resets were found. In
particular:

- `expandInlineLabelReadOnly`, `web/annotator-ui/src/pdf-preview-modal.js:2890`,
  creates a span and schedules label positioning, with no editor or caret reset.
  Its 50 ms hover opener at :1904 also only opens the read-only view.
- Sidebar setup callbacks at `web/annotator-ui/src/pdf-preview-modal.js:1838`
  and :9894 (100 ms), and temporary-sidebar binding at
  `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js:2391`
  (100 ms), resize/bind listeners without resetting opening selection.
- Auto-resize helper timers at `web/annotator-ui/src/pdf-preview-modal.js:5299`
  and `web/annotator-ui/src/pdf-preview-modal/utils.js:244` only resize.
- `web/annotator-ui/src/pdf-preview-modal/textbox.js:442` places a contenteditable
  caret at the end synchronously; there is no `setTimeout` in this module.
- `web/annotator-ui/src/pdf-preview-modal/inline-editor.js` contains helper
  definitions, not the stateful editor opener or another timed caret reset.

## Verification and bundle workflow

| Check | Result |
| --- | --- |
| Focused GREEN, same command as RED | 8 passed, 0 failed, 0 skipped; 1 passed file. |
| Final full suite: `npm test -- --configLoader native --cache=false` | **355 passed, 0 failed, 0 skipped; 23 passed files, 0 failed/skipped files.** Repeated after tightening the idle test to assert immediate focus and caret placement; same counts. |
| `npm run lint` | **Exit 0; 0 errors, 3 warnings.** Existing warnings in `pdf-preview-modal.js:1699`, `pdf-preview-modal.js:2448`, and `pdf-preview-modal/overlay-renderer.js:52`; none in the changed logic. |

Plain `npm test -- tests/inline-editor-caret.test.js` initially failed before
collecting tests: Vite tried to write its temporary bundled config under
`node_modules/.vite-temp` and received `EPERM`. `node_modules` is a junction to
the sibling source checkout, outside this task's writable repo. Native config
loading and disabling the test cache allow the installed suite to run without
writing through that junction. No dependency installation or config edits were
needed.

`web/annotator-ui/package.json` defines `build` as `rollup -c`.
`web/annotator-ui/rollup.config.js:66` generates `dist/annotator-ui.js`, its source
map, and the CSS asset from the ordered source list. `CONTRIBUTING.md:31` documents
the build, and `.github/workflows/ci.yml:62` builds after tests. `.gitignore:5`
ignores `dist/`; no requirement to commit generated bundle files was found.
Under the user's conditional rebuild instruction, **the bundle was not rebuilt**.

Two test files use the existing `../dist/annotator-ui.js`:
`web/annotator-ui/tests/annotator-ui-bundle.test.js:3` imports it for two export/API
tests, and `web/annotator-ui/tests/package-document-history.test.js:8` reads it for
seven package history tests. Those nine tests passed against the pre-existing
artifact. `package-comment-commit.test.js` instead reads and concatenates source
in the Rollup order. The new regression tests import the changed source;
the full-suite result is not evidence that an updated distribution bundle has
been built or served. The lead must build from the source commit when syncing
the AEMS distribution. No vendored AEMS files were edited, no git commands were
run, and no commit or live-browser verification was performed.
