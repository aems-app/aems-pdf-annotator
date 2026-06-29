# Security Review — Annotation Identifier DOM XSS (verification + fix)

- Date: `2026-06-24`
- Reviewer action: verified the submitted finding, fixed the valid problems, added regression tests.
- Status legend: `CONFIRMED`, `CONFIRMED + CORRECTED`, `NEW (report missed)`, `SYSTEMIC (out of fix scope)`, `NOT REACHABLE`.

## TL;DR

The reported **DOM XSS through unescaped annotation identifiers in the comments sidebar is REAL and CONFIRMED** in both renderers. Independent data-flow analysis shows it is **reachable by an unprivileged student** (not just "an attacker who can influence identifiers"), so the High severity stands and the confidence is higher than the report stated.

The report also contained one important **inaccuracy**: it described `displayIdentifier`/`domId` as already-safe because they pass through `escapeHtml()`. They are **not** safe — `escapeHtml()` does not escape quotes — and that gap is the real root cause. The fix therefore could not be "wrap the other fields in `escapeHtml()`"; it required a quote-aware attribute escaper.

Two sinks the report did not list were also found and fixed. The `aems-agent` repo is not affected.

---

## 1. CONFIRMED — the two reported sinks are real

Both renderers assign attacker-influenced identifier strings into `innerHTML` with the identifier values concatenated **raw** into double-quoted `data-*` attributes:

- `web/annotator-ui/src/pdf-preview-modal/annotation-controller.js` — `_renderSidebarHtml()` (human / main comments panel; sink at `listEl.innerHTML` in `renderSidebar()`).
- `web/annotator-ui/src/pdf-preview-modal.js` — `renderAIAnnotationsList()` (AI split panel; sink at `listEl.innerHTML = html`).

Raw-interpolated values were `requestId`, `xrefValue`, `stableId`, and `ann.xref`. `normalizeAnnotationIdentifierValue()` only does `String(value).trim()`, so a `"` survives to the sink. A `"` in any of those fields breaks out of the attribute and injects an event handler (`onmouseover`, `onfocus`, …) that runs in the grader's authenticated origin → **stored DOM XSS**.

The report's PoC (jsdom, `evil" autofocus onfocus=...`) correctly demonstrates the sink primitive.

## 2. CONFIRMED + CORRECTED — `escapeHtml()` does not escape quotes (true root cause)

The report stated the renderer "escapes `displayIdentifier`" and framed the bug as *only* the other, un-escaped fields. That is misleading:

`escapeHtml()` (both the annotator copy in `utils.js` and the canonical `aems` `src/aems/web/static/js/core/utils.js:36-41`) is implemented as:

```js
var div = document.createElement('div');
div.textContent = String(text);
return div.innerHTML;   // text-node serialisation escapes & < >  — NEVER " or '
```

Text-node HTML serialisation encodes `&`, `<`, `>` (and `nbsp`) only. It does **not** encode `"` or `'`, because quotes are not special in element *text* content. Therefore:

- `escapeHtml('evil" onmouseover=...')` returns the string **unchanged** — no `<`, `>`, `&`.
- `displayIdentifier`, `domId`, the grader-name `title="…"`, and the comparison-mode `data-feedback-id="…"` — all of which used `escapeHtml()` in **attribute** context — were **also vulnerable**, contrary to the report.

Consequence: a fix that merely wraps the remaining fields in the existing `escapeHtml()` would **not** close the hole. An attribute-context escaper that also encodes `"`/`'` is required.

## 3. Reachability — unprivileged student, no special access (severity confirmed High)

Independent backend data-flow tracing found at least two paths that put a literal `"` into the identifier fields, the strongest requiring no privilege:

- **(a) Student-uploaded PDF metadata — REACHABLE, unprivileged.** A student submits a PDF that already contains a PDF annotation whose `/NM` (name) or `/T` (title) is a payload containing a `"`. During grading the student PDF is opened and re-saved with `PDFAnnotator` (`src/aems/grading/batch.py`), and PyMuPDF preserves the student's pre-existing annotation objects. When a grader opens the review UI, the list-annotations endpoints re-enumerate **every** annotation on the page (`get_annotations_on_page`, `core.py` `for annot in page.annots()`) and copy `info.name`/`info.id`/`info.title` verbatim into `stable_id`/`id`/`grader_name`. Both serializers — `_serialize_offline_annotation_entry` (`src/aems/web/offline/api.py`) and `_serialize_annotation_entry` (`src/aems/web/api/v1/canvas/annotations.py`) — apply **no charset filter, length cap, or escaping** (only `is_annotation_type_name()`, which just rejects literal PDF type names). PDF strings allow a literal `"`. The inbound identifier validator `_resolve_annotation_identifier` (regex `^[a-zA-Z0-9:|\-_]+$`) guards CRUD lookups but is **not** applied to the outbound serialized response.
- **(b) LLM `check_id` via prompt injection — REACHABLE, model-dependent.** No code in `src/aems/grading` ever sets `stable_id`, so the annotation `id` falls back to the LLM-emitted `check_id` (`vendor-packages/.../contract.py`). `check_id` is taken from model JSON with no charset validation (`multimodal_grading.py`, `contextual_annotation.py`); the contract schema types it as a bare string. Reachable if the model can be steered to emit a quote.
- **(c) Schema `check_id` — NEEDS-PRIVILEGE.** Teacher/admin-authored; unconstrained charset but not student-settable.

`xref` (always an integer object number) and `source` (effectively an `AI`/`HUMAN` enum) are **NOT REACHABLE**.

## 4. NEW — sinks the report did not list (also fixed)

- **`web/annotator-ui/src/pdf-preview-modal/comparison-mode.js`** `renderComparisonFeedbackList()`:
  - `data-feedback-id="${escapeHtml(feedbackId)}"` — same quote-blind `escapeHtml()` in attribute context (`feedbackId = ann.id`, attacker-influenced).
  - `data-page="${page}"` — `ann.page` interpolated raw and uncoerced into a double-quoted attribute and as text.
- **Grader-name `title` attribute** in both main renderers used `escapeHtml()` in attribute context (`grader_name`/`author_name` are in the report's own field list and are reachable via path (a)).

## 5. NOT REACHABLE — `aems-agent`

The `aems-agent` repo has **no HTML rendering layer** (pure Python FastAPI + tkinter/pystray; endpoints return JSON/FileResponse only). `annotation_crud.py` builds dicts, never markup, and additionally constrains identifiers to `^[a-zA-Z0-9:|\-_]+$` (max len 500). No analogous sink exists. No change needed there.

---

## Fix applied

Introduced a dedicated **attribute-context escaper** `escapeHtmlAttribute()` that encodes `& < > " '`, and routed every identifier/metadata value that lands in an HTML attribute through it. The encoded entities decode back to the original value when read via `element.dataset.*` / `getAttribute()`, so attribute round-trips used by event handlers and CSS-selector lookups remain **lossless** — no behavioural change for normal (safe-ASCII) identifiers.

Files changed (source repo `aems-pdf-annotator`):

| File | Change |
|---|---|
| `src/pdf-preview-modal/utils.js` | New `escapeHtmlAttribute()` export (escapes the 5 metacharacters incl. quotes). |
| `src/pdf-preview-modal/annotation-controller.js` | `_renderSidebarHtml()` now attribute-escapes `requestId`, `xrefValue`, `stableId`, `ann.xref`, `source`, grader-name `title`, `displayIdentifier`, `domId`. Resolver added with a safe local fallback. |
| `src/pdf-preview-modal.js` | `renderAIAnnotationsList()` same treatment; added `escapeHtmlAttribute` definition + wired it into the helpers bag passed to the controller. |
| `src/pdf-preview-modal/comparison-mode.js` | `feedbackId` attribute-escaped; `page` coerced via `Number(ann.page) || 1`. |
| `tests/utils.test.js` | Unit tests: `escapeHtml` does NOT escape quotes (locks the contract); `escapeHtmlAttribute` encodes quotes and cannot break out of a double-quoted attribute. |
| `tests/annotation-controller.test.js` | End-to-end regression: a quote-bearing identifier renders no executable attribute, does not run injected script, and still round-trips losslessly through `dataset`. |

`escapeHtml()` (text/body context) is deliberately left unchanged; body-context usages (`displayContent`, comment text, toasts) are not quote-sensitive.

Vendor bundle rebuilt (`rollup -c`) and synced into AEMS via `vendor-packages/sync.sh`:
`src/aems/web/static/vendor/aems-pdf-annotator/annotator-ui.js` (+ `.js.map`).

## Verification performed

- `vitest run` — **96 passed** (89 baseline + 7 new).
- **Fixture-first proof:** temporarily reverting one identifier escape makes the new end-to-end test **fail** (`[onmouseover]` attribute appears); restoring it passes. The test reproduces the defect.
- `eslint src/` — 0 errors (4 pre-existing unrelated unused-var warnings).
- `rollup -c` — bundle builds; 32 `escapeHtmlAttribute` occurrences present in `dist/` and in the synced vendor copy.
- Codex follow-up verification found and fixed three post-fix deficiencies: edit-mode comparisons now use raw DOM IDs while only markup uses attribute-escaped IDs; overlay/comparison selector lookups now use CSS escaping for quote-bearing IDs; page values are coerced to numeric page indexes before attribute/text interpolation.
- AEMS-side synced-bundle check added/passed: `npm run test:unit -- tests/js/pdf-preview-annotation-routing.test.js tests/js/pdf-preview-wrapper.test.js` (12 passed), including a vendored-bundle `escapeHtmlAttribute()` regression.

**NOT verified:** no live GUI / runtime PoC (no PDF with a quote-bearing `/NM` was pushed through grading and back out the API). Findings and fix are confirmed by code reading + unit/integration tests, not a browser exploit demonstration. Per the three-repo rule, committing the source repo, committing the synced AEMS vendor files, and deploying are still pending (not performed without an explicit request).

---

## Residual / systemic issues — recommended, NOT changed here (scoped out deliberately)

1. **SYSTEMIC: canonical `escapeHtml()` is quote-blind app-wide.** The same `textContent → innerHTML` helper in `aems` `core/utils.js:36-41` is used in `title="${escapeHtml(...)}"` / `data-*="${escapeHtml(...)}"` patterns across ~56 static-JS files (e.g. `charts.js`, `canvas_selection.js`). Any of those attribute usages with attacker-influenced data is a latent XSS of the same class. **Recommendation:** either harden `escapeHtml()` to also encode `"`/`'` (industry-standard; output renders identically), or introduce an `escapeHtmlAttribute()` in core utils and migrate attribute-context call sites. This is a separate, larger-blast-radius change that should ship in its own security PR with its own UI verification — it is **not** bundled here to keep this fix reviewable and to avoid changing 56 unaudited surfaces.

2. **Defense-in-depth: backend output validation.** The annotation serializers copy PDF/LLM-derived `id`/`stable_id`/`check_id`/`author_name` verbatim. Output encoding at the sink (this fix) is the canonical and sufficient XSS defense, but a server-side allowlist/length cap on these fields (mirroring the existing inbound `^[a-zA-Z0-9:|\-_]+$`) would add a layer. **Caveat:** identifiers are used as CRUD lookup keys, so any server-side rewriting must preserve the value the PDF/store actually holds, or it will desync edit/delete. Recommended as a follow-up, not applied here.
