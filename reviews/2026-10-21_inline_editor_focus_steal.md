# Inline editor closes after a real double-click

Date: 2026-10-21

Fixed and verified locally in `D:\Temp\Artem\aems-pdf-annotator-redo540`.
The brief identifies the starting branch as `fix/inline-editor-focus-steal` and
base as `226555d`. No git commands were run; those identifiers were not independently
checked. Regression tests were written and run before changing production source.

## Root cause

PR #10 made `expandInlineLabelEdit` focus and place the caret synchronously.
`enterEditFromLabel` then rendered the sidebar and called
`highlightAnnotationSelection`, which focused the matching list item. The inline
textarea's existing 100 ms blur handler consequently saved/collapsed the editor.

The real label sequence is `click`, `click`, `dblclick`: the first click expands
read-only and focuses the sidebar; the second click enters editing; the final
double-click event sees editing already active. A synthetic double-click without
a matching focusable sidebar item misses the focus steal.

Selection normally delegates to `annotation-controller.js`, whose
`highlightSelection` also focused the list item. Its marker double-click
`beginEdit` path additionally scheduled sidebar textarea focus after 50 ms.
Both implementations therefore needed the focus policy, and the marker path
needed to stop its existing callback from taking focus after inline opening.

## Change

- Added `{ focusListItem = true } = {}` to both selection implementations.
  Marker/list selection styling and selection state still update when false.
- Label editing and fallback marker double-click editing pass
  `{ focusListItem: false }`. Monolith delegation, the controller's
  `selectAnnotation`, and the helper bridge forward the option.
- Controller `beginEdit` records the inline textarea it opens. It highlights
  without list focus when that textarea exists, and its existing 50 ms callback
  only focuses the sidebar textarea when no inline editor opened. Sidebar
  auto-resize still runs.
- Synchronous inline focus/caret initialization is unchanged. No timers were
  added or extended; the existing blur/save logic is unchanged.

Production source changed in `web/annotator-ui/src/pdf-preview-modal.js` and
`web/annotator-ui/src/pdf-preview-modal/annotation-controller.js`.

## Every selection caller

Line numbers refer to the resulting source. A search of all UI source found the
following calls and bridges; the overlay renderer also mentions the function in
a comment but does not call it directly.

| File and line | Caller | Focus classification |
| --- | --- | --- |
| `pdf-preview-modal.js:1846` | `enterEditFromLabel`, shared by click-on-expanded and double-click-from-collapsed | Passes false; retain inline textarea focus. |
| `pdf-preview-modal.js:1882` | Collapsed label single-click read-only expansion | Default true; keep focusing the list item. |
| `pdf-preview-modal.js:5729` | `highlightAnnotationSelection` delegates to controller `selectAnnotation` | Forwards the caller's focus option, default true. |
| `pdf-preview-modal.js:9870` | Overlay marker single-click fallback without annotation controller | Default true; keep focusing the list item. |
| `pdf-preview-modal.js:9900` | Overlay marker double-click fallback after opening inline editor | Passes false; retain inline textarea focus. |
| `pdf-preview-modal.js:9946` | Controller helper bridge back to monolith selection implementation | Forwards options; omitted options retain default true. The current controller uses its own selection implementation. |
| `pdf-preview-modal.js:10041` | Overlay marker single-click with annotation controller | Calls `selectAnnotation` with default true; keep focusing the list item. |
| `annotation-controller.js:2104` | Sidebar list-item mousedown | Calls `highlightSelection` with default true; keep focusing the list item. |
| `annotation-controller.js:2248` | `beginEdit`, including active overlay marker double-click | False when an inline textarea opened; true for selection without an inline editor. Existing deferred sidebar focus is likewise limited to sidebar-only editing. |
| `annotation-controller.js:3378` | Public `selectAnnotation` wrapper | Forwards options to `highlightSelection`; default true. |
| `annotation-controller.js:3375` | Public `highlightSelection` export | Direct function reference; callers inherit default true unless opting out. |

Other inline opening sites (priority-change restoration, temporary creation,
and create-response replacement) do not subsequently call either selection
function. They need no new selection option.

## Tests and verification

New file: `web/annotator-ui/tests/inline-editor-focus-steal.test.js`.
The fixture uses the real controller, real sidebar renderer, and a matching
focusable list item (`tabindex="0"`). Host API and PDF viewer are stubbed;
geometry is supplied because jsdom has no layout. Tests dispatch DOM MouseEvents
in order and advance fake timers asynchronously to 160 ms, allowing blur promises
to settle.

The six cases cover:

1. `click`, `click`, `dblclick` on a label, retaining the same focused textarea
   immediately and after the blur deadline, without persistence or collapse.
2. Direct double-click entry from collapsed with the focusable sidebar present.
3. A click on an already expanded read-only label.
4. Single-click read-only expansion still focusing the sidebar item.
5. Immediate typing across the former 50 ms caret deadline produces
   `Caret probe text.` with selection `[17, 17]`. The insertion helper never
   refocuses the textarea, so it cannot mask a focus steal.
6. Overlay marker double-click through the real controller, including its
   existing deferred sidebar callback.

| Stage | Command from `web/annotator-ui` | Result |
| --- | --- | --- |
| RED, before production source edits | `npm test -- --configLoader runner tests/inline-editor-focus-steal.test.js` | 5 failed, 1 passed; no unhandled errors. The single-click guard passed. Label editors lost focus immediately and collapsed after 100 ms. Marker editing also lost focus to the deferred sidebar textarea. |
| GREEN, new regressions plus previous caret tests | `npm test -- --configLoader runner tests/inline-editor-focus-steal.test.js tests/inline-editor-caret.test.js` | 14 passed across 2 files (6 new, 8 existing). |
| Full suite | `npm test -- --configLoader runner` | 361 passed across 24 files; exit 0. |
| Lint | `npm run lint` | Exit 0; 0 errors, 3 warnings on untouched code. |
| Bundle build | `npm run build` | Exit 0; Rollup generated the distribution bundle, source map, and CSS. |

The initial plain `npm test -- tests/inline-editor-focus-steal.test.js` could not
start: `node_modules` is a junction to the sibling checkout, and Vite attempted
to write its bundled configuration into that dependency tree's `.vite-temp`
directory (`EPERM`). Using the supported `--configLoader runner` flag avoids
that configuration write without changing dependencies or project configuration.
The installed test runner reports Vitest 4.1.0.

Lint warnings:

- `pdf-preview-modal.js:1699`: unused caught `e`.
- `pdf-preview-modal.js:2448`: unused `scoreResidualPlacementRect`.
- `pdf-preview-modal/overlay-renderer.js:52`: unused `positionLabelOptimally`.

## Built artifact and scope

Rebuilt `web/annotator-ui/dist/annotator-ui.js` (1,230,641 bytes) and
`annotator-ui.js.map` (2,036,581 bytes); CSS was also emitted (63,995 bytes).
Inspection of the generated JavaScript confirms both selection implementations,
both inline-edit opt-outs, option forwarding, and the guarded existing callback.

Bundle SHA-256:
`FEBC8EBAE493DECCBB1533A3A448C01C8ACF33497DD35619570C1AE94E47EF6B`.

Verification here is local jsdom regression coverage, lint, and bundle generation.
No AEMS vendor sync, deployment, or live browser retest was performed.
