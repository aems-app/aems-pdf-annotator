import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Architectural contract for the rebuild arbiter.
//
// The arbiter is only worth having if EVERY destructive rebuild goes through
// it. A new direct reRenderAllPages() call would reintroduce exactly the #472
// defect -- an unguarded rebuild destroying the drawing overlay mid-stroke --
// and it would do so silently, since the arbiter's own tests would still pass.
// These assertions are deliberately source-level: they guard the wiring, which
// no behavioural test of the arbiter in isolation can see.

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const MODAL = read('../src/pdf-preview-modal.js');
const CONTROLLER = read('../src/pdf-preview-modal/document-controller.js');
const VIEWER = read('../src/pdf-preview-modal/pdf-viewer.js');

describe('rebuild arbiter contract', () => {
  it('pdf-preview-modal.js never calls reRenderAllPages directly', () => {
    const hits = MODAL.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('reRenderAllPages('));
    expect(hits, `route these through requestRebuild(): ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('the document controller schedules through requestRebuild', () => {
    expect(CONTROLLER).toContain('requestRebuild(false)');
  });

  it('the viewer owns the arbiter and the recheck before the destructive clear', () => {
    expect(VIEWER).toContain('requestRebuild(force = false)');
    expect(VIEWER).toContain('flushPendingRebuild()');
    expect(VIEWER).toContain('_shouldDeferRebuildNow()');

    // The recheck must sit above the clear WITHIN reRenderAllPages. Scoped to
    // that function on purpose: pageViewports.clear() also appears earlier in
    // the file, and a whole-file indexOf compares the wrong occurrence -- which
    // is how the first draft of this test failed.
    const start = VIEWER.indexOf('async reRenderAllPages(force = false)');
    expect(start).toBeGreaterThan(-1);
    const body = VIEWER.slice(start, VIEWER.indexOf('\n        }', start));
    const recheck = body.indexOf('return REBUILD_DEFERRED;');
    const clear = body.indexOf('this.pageViewports.clear();');
    expect(recheck, 'no pre-destruction recheck in reRenderAllPages').toBeGreaterThan(-1);
    expect(clear, 'pageViewports.clear() not found in reRenderAllPages').toBeGreaterThan(-1);
    expect(recheck, 'the recheck must precede the destructive clear').toBeLessThan(clear);
  });

  it('the ResizeObserver goes through the arbiter, not straight to a rebuild', () => {
    // The observer callback is the path that actually fired in #472: its 120 ms
    // debounce beats the controller's 400 ms timer.
    const observerBlock = VIEWER.slice(
      VIEWER.indexOf('new ResizeObserver('),
      VIEWER.indexOf('this._resizeObserver.observe('),
    );
    expect(observerBlock).toContain('requestRebuild(true)');
    expect(observerBlock).not.toContain('reRenderAllPages(');
  });

  it('the viewer does not reach into the DrawingCanvas global', () => {
    // The dependency must point from the modal into the viewer, so the viewer
    // stays a generic component that defers for a reason it does not know.
    expect(VIEWER).not.toContain('PdfPreviewModalDrawingCanvas');
    expect(VIEWER).not.toContain('isDrawingActive');
  });

  it('the modal injects the predicate and flushes when a stroke ends', () => {
    expect(MODAL).toContain('shouldDeferRebuild = function');
    expect(MODAL).toContain('isDrawingActive()');
    expect(MODAL).toContain('flushPendingRebuild()');
  });

  it('the predicate is rewired outside the viewer-creation branch', () => {
    // Viewers are cached on window and outlive modal opens, so wiring the
    // predicate only inside `if (!window.__pdfGradedViewer)` would leave a
    // reopened modal with the guard off.
    const create = MODAL.indexOf("window.__pdfGradedViewer = new ViewerClass(");
    const wire = MODAL.indexOf('shouldDeferRebuild = function');
    expect(create).toBeGreaterThan(-1);
    expect(wire).toBeGreaterThan(create);

    // Indentation is the check that actually distinguishes the two placements:
    // 8 spaces is the function body, 12 would be inside the `if (!viewer)`
    // creation branch. Asserting on indentation is blunt but it is the only
    // thing in the source text that separates "runs every call" from "runs
    // once", and running once is the bug.
    expect(
      /\n {8}if \(window\.__pdfGradedViewer && 'shouldDeferRebuild' in window\.__pdfGradedViewer\)/
        .test(MODAL),
      'the predicate wiring is not at function-body indentation, so it may sit '
      + 'inside the creation branch and only run on the first modal open',
    ).toBe(true);
  });
});
