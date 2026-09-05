import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The monolith's OWN fullscreen resize path.
//
// pdf-preview-modal.js keeps a pre-shell fallback: when no document controller
// has been composed, `_monolithFullscreenChangeHandler` runs and calls
// `handleFullscreenResize()` directly. That path was the last place issue #472
// survived -- it called `reRenderAllPages(TRUE)`, and force=true bypasses the
// width guard, so it always reached renderSkeleton()'s `container.innerHTML = ''`
// and destroyed the drawing overlay 400 ms after every fullscreen toggle. Unlike
// the shell path it had no isDrawingActive() deferral at all.
//
// It then compounded that: after awaiting the resize it ran
// renderAllAnnotations(true) + refreshMarkupFromAnnotations() as a raw pair,
// stepping around the deferral that WAS added to the viewer callback. The first
// thing refreshMarkupFromAnnotations does is
// DrawingCanvas.loadStrokesFromAnnotations(...), whose first statement is an
// unconditional pageStrokes.clear() repopulated only from annotationsData -- and
// annotationsData gains a stroke only when its create-POST resolves. So a stroke
// drawn but not yet persisted was wiped by the very resize handling meant to
// protect it.
//
// This module was previously declared untested. It is not untested now.

const MODULE_PATH = '../src/pdf-preview-modal.js';

function makeGradedViewer() {
  return {
    pdf: { numPages: 3 },
    currentPage: 1,
    reRenderAllPages: vi.fn().mockResolvedValue(undefined),
    relayoutPagesForContainer: vi.fn().mockResolvedValue(undefined),
    onAnnotationsPageChange: vi.fn(),
    onPageRendered: vi.fn(),
    onSliderSync: vi.fn(),
    onResizeComplete: vi.fn(),
  };
}

describe('monolith fallback fullscreen resize', () => {
  let drawing;
  let loadStrokes;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    drawing = false;
    loadStrokes = vi.fn();

    document.body.innerHTML = `
      <div id="pdfPreviewModal"><div id="pdfGradedContainer"></div></div>
    `;

    // The monolith captures window.PdfPreviewModalDrawingCanvas at module load,
    // so it must exist before the import.
    window.PdfPreviewModalDrawingCanvas = {
      isDrawingActive: () => drawing,
      loadStrokesFromAnnotations: loadStrokes,
      ensureCanvasForPage: vi.fn(),
      redrawPage: vi.fn(),
      getPageStrokes: vi.fn(() => []),
      setActiveTool: vi.fn(),
      destroy: vi.fn(),
    };
    window.__pdfGradedViewer = makeGradedViewer();
    delete window.__pdfOriginalViewer;

    await import(new URL(MODULE_PATH, import.meta.url));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalDrawingCanvas;
    delete window.__pdfGradedViewer;
  });

  it('reflows instead of force-rebuilding, so the overlay is never torn down', async () => {
    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(500);

    expect(
      window.__pdfGradedViewer.reRenderAllPages,
      'reRenderAllPages(true) reaches renderSkeleton and empties the container',
    ).not.toHaveBeenCalled();
    expect(window.__pdfGradedViewer.relayoutPagesForContainer).toHaveBeenCalled();
  });

  it('does not clear the stroke store while a finished stroke is still saving', async () => {
    // isDrawingActive() goes false at pointer-up (drawing-canvas.js:619), but the
    // stroke only reaches annotationsData in the create-POST's .then(). A resize
    // landing in that window runs refreshMarkupFromAnnotations() ->
    // pageStrokes.clear(), repopulated from an annotationsData that does not yet
    // contain the stroke -- so the ink the user just drew disappears until
    // something else refreshes. Found by an external review, not by me.
    drawing = false;                       // pointer is already up
    window.PdfPreviewModal?.__test?.setPendingDrawingSaves?.(1);

    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(500);

    expect(loadStrokes, 'markup refreshed while the create-POST was in flight')
      .not.toHaveBeenCalled();

    window.PdfPreviewModal?.__test?.setPendingDrawingSaves?.(0);
    await vi.advanceTimersByTimeAsync(100);

    expect(loadStrokes, 'markup never refreshed after the POST resolved')
      .toHaveBeenCalled();
  });

  it('does not clear the stroke store while the pointer is still down', async () => {
    drawing = true;

    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(500);

    // loadStrokesFromAnnotations() begins with an unconditional
    // pageStrokes.clear(), so reaching it mid-stroke loses the ink.
    expect(loadStrokes, 'markup refreshed mid-stroke').not.toHaveBeenCalled();

    drawing = false;
    await vi.advanceTimersByTimeAsync(100);

    expect(loadStrokes, 'markup never refreshed after the stroke ended').toHaveBeenCalled();
  });
});
