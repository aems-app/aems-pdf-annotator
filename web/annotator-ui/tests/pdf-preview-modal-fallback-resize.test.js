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
    loadPDF: vi.fn().mockResolvedValue(undefined),
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
    window.PdfPreviewModalViewer = {
      PDFViewer: class {},
      resolvePdfjsLib: () => ({}),
    };
    delete window.__pdfOriginalViewer;

    await import(new URL(MODULE_PATH, import.meta.url));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalDrawingCanvas;
    delete window.PdfPreviewModalViewer;
    delete window.__pdfGradedViewer;
    delete window.loadPdfForComparison;
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

  it('clears the drawing-persistence bookkeeping when the modal closes', async () => {
    // _pendingDrawingSaves is module scope. A save that never settled would
    // otherwise stay above zero and poison EVERY modal opened afterwards on this
    // page: the guard would block a document swap and the markup refresh for a
    // stroke that no longer exists, and closing/reopening would not help.
    const seam = window.PdfPreviewModal.__test;
    seam.setPendingDrawingSaves(3);
    expect(seam.getPendingDrawingSaves()).toBe(3);

    document.getElementById('pdfPreviewModal')
      .dispatchEvent(new Event('hidden.bs.modal'));

    expect(
      seam.getPendingDrawingSaves(),
      'a stuck counter survives the modal and poisons the next session',
    ).toBe(0);
    expect(seam.isDrawingPersistenceActive()).toBe(false);
  });

  it('resets the bookkeeping on the SHELL close path, not only the fallback', async () => {
    // The reset originally lived only inside the monolith's `hidden.bs.modal`
    // listener, whose first line is `if (_currentShell) return;`. Production
    // always creates the shell, so it never ran where it mattered -- and the
    // test above passed anyway because it exercises the fallback. A guard on a
    // path production does not take is not a guard, so the reset is now a shared
    // function and this pins that BOTH callers use it.
    const seam = window.PdfPreviewModal.__test;
    expect(typeof seam.resetDrawingPersistenceBookkeeping).toBe('function');

    seam.setPendingDrawingSaves(4);
    seam.resetDrawingPersistenceBookkeeping();
    expect(seam.getPendingDrawingSaves()).toBe(0);
    expect(seam.isDrawingPersistenceActive()).toBe(false);

    // That the SHELL path calls it is pinned structurally in
    // no-graded-viewer-rebuild.test.js: the shell close path only runs when a
    // real modal is composed, which this harness cannot do.
  });

  it('leaves no self-rescheduling timer running after the modal closes', async () => {
    // The markup-refresh retry re-arms itself every 50 ms while persistence is
    // active. Left running past teardown it fires refreshMarkupFromAnnotations()
    // at 20 Hz against a torn-down DOM for the rest of the page's life.
    const seam = window.PdfPreviewModal.__test;
    seam.setPendingDrawingSaves(1);

    // Arm the retry loop, then close before it can finish.
    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(500);

    document.getElementById('pdfPreviewModal')
      .dispatchEvent(new Event('hidden.bs.modal'));
    loadStrokes.mockClear();

    await vi.advanceTimersByTimeAsync(20000);

    expect(
      loadStrokes,
      'a timer kept firing markup refreshes after the modal was gone',
    ).not.toHaveBeenCalled();
  });

  it('re-arms the document-replace guard rather than arming it once', async () => {
    // The graded viewer is a window-lifetime singleton and its destroy() nulls
    // this callback, so arming it only at construction left the guard inert for
    // every modal opened after the first -- and that guard is the only thing
    // between a document swap and an unsaved stroke.
    const seam = window.PdfPreviewModal?.__test;
    expect(typeof seam?.armDocumentReplaceGuard).toBe('function');

    window.__pdfGradedViewer.beforeDocumentReplace = vi.fn();
    seam.armDocumentReplaceGuard();
    expect(window.__pdfGradedViewer.beforeDocumentReplace).toHaveBeenCalledTimes(1);

    // A later open must arm it again, not assume the first one stuck.
    seam.armDocumentReplaceGuard();
    expect(
      window.__pdfGradedViewer.beforeDocumentReplace,
      'the guard is armed once and never refreshed',
    ).toHaveBeenCalledTimes(2);

    const armedWith = window.__pdfGradedViewer.beforeDocumentReplace.mock.calls[0][0];
    expect(typeof armedWith, 'armed with something that is not the wait').toBe('function');
  });

  it('a save from a closed session cannot mark new ink safe', async () => {
    // The pending count was one module-scope scalar. Close reset it to 0, but an
    // in-flight request from the CLOSED session still ran its .finally and
    // decremented -- so a save that belongs to nobody could take the new
    // session's stroke below zero and declare it safe, letting a destructive
    // refresh clear ink that was never persisted.
    const seam = window.PdfPreviewModal.__test;

    const oldToken = seam.beginDrawingSave();          // session 1 starts a save
    expect(seam.isDrawingPersistenceActive()).toBe(true);

    // Session 1 closes; session 2 opens and starts its own save.
    seam.resetDrawingPersistenceBookkeeping();
    const newToken = seam.beginDrawingSave();
    expect(seam.isDrawingPersistenceActive()).toBe(true);

    // Session 1's request finally lands. Against the fresh set its delete is a
    // no-op, so session 2's live stroke stays guarded.
    seam.endDrawingSave(oldToken);

    expect(
      seam.isDrawingPersistenceActive(),
      "a closed session's save cleared the guard for a live stroke",
    ).toBe(true);

    seam.endDrawingSave(newToken);
    expect(seam.isDrawingPersistenceActive()).toBe(false);
  });

  it('does not spend the wait budget on external calls', async () => {
    // _markupRefreshDeadline counted EVERY invocation, not only timer retries.
    // refreshMarkupFromAnnotations is called from page renders, resizes and each
    // create-POST .then(), so a busy page burned the whole 8s budget in a few
    // hundred milliseconds and then forced the destructive refresh early.
    const seam = window.PdfPreviewModal.__test;
    seam.setPendingDrawingSaves(1);          // never settles
    loadStrokes.mockClear();

    // 200 external calls, no time passing at all. The budget is 160 retries, so
    // if callers spent it these alone would exhaust it.
    for (let i = 0; i < 200; i += 1) seam.refreshMarkupFromAnnotations();

    expect(
      seam.getMarkupRefreshState().deadline,
      'external callers spent the wait budget; a busy page would force the '
      + 'destructive refresh in milliseconds instead of 8 seconds',
    ).toBe(0);
    expect(loadStrokes).not.toHaveBeenCalled();

    seam.setPendingDrawingSaves(0);
  });

  it('tells the teacher when a stroke has not saved, not just the console', async () => {
    // The expiry path warned to the console and nothing else. A teacher whose
    // ink is unsaved sees no signal at all, so they carry on and may redraw --
    // which is how a silent loss becomes a visible duplicate on the paper. An
    // 8-second timeout should CHANGE THE UI STATE, not quietly authorise data
    // loss; that phrasing is the reviewer's and it is right.
    const seam = window.PdfPreviewModal.__test;
    const toasts = [];
    seam.setToastSink((kind, message) => toasts.push({ kind, message }));
    seam.setPendingDrawingSaves(1);          // never settles

    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(20000);

    expect(
      toasts.filter((x) => x.kind === 'warning' || x.kind === 'error'),
      'the teacher was told nothing about ink that has not saved',
    ).not.toEqual([]);
    expect(toasts.some((x) => /sav/i.test(x.message))).toBe(true);

    seam.setPendingDrawingSaves(0);
    seam.setToastSink(null);
  });

  it('keeps local ink when the wait expires instead of clearing it', async () => {
    // On expiry the refresh used to run in full, and its first act is
    // DrawingCanvas.loadStrokesFromAnnotations() -> pageStrokes.clear(),
    // repopulated from an annotationsData that does not contain the unsaved
    // stroke. So the timeout AUTHORISED the exact loss the guard exists to
    // prevent. Expiry must repaint what is safe and leave the stroke store
    // alone; a stale marker layer is recoverable, deleted ink is not.
    const seam = window.PdfPreviewModal.__test;
    seam.setPendingDrawingSaves(1);          // never settles
    loadStrokes.mockClear();

    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(20000);

    expect(
      loadStrokes,
      'the expiry cleared the stroke store, losing ink that was never saved',
    ).not.toHaveBeenCalled();

    seam.setPendingDrawingSaves(0);
  });

  it('gives up waiting for a stroke save that never completes', async () => {
    // The guard added for the remaining stroke-loss paths polls until
    // isDrawingPersistenceActive() goes false, and loadPDF() now awaits it
    // unconditionally. A create-POST that never settles -- fetch has no default
    // timeout -- would leave _pendingDrawingSaves stuck above zero, and then the
    // graded PDF never loads again and the markup never refreshes again, with no
    // recovery short of reloading the page.
    //
    // Trading the loss of one in-flight stroke for a permanently wedged viewer is
    // the wrong trade, so the wait is bounded. This is deliberately NOT a
    // deferral of geometry -- it delays a document swap and a markup repaint,
    // never a CSS relayout.
    const seam = window.PdfPreviewModal?.__test;
    expect(typeof seam?.waitForDrawingPersistence, 'no seam to test the wait')
      .toBe('function');

    seam.setPendingDrawingSaves(1);        // a save that will never resolve
    let settled = false;
    const waiting = seam.waitForDrawingPersistence().then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(2000);
    expect(settled, 'gave up far too early to be a guard at all').toBe(false);

    await vi.advanceTimersByTimeAsync(10000);
    await waiting;
    expect(settled, 'the wait never ended: the viewer is wedged').toBe(true);

    seam.setPendingDrawingSaves(0);
  });

  it('stops retrying rather than looping forever when a save never completes', async () => {
    // The guard re-schedules itself every 50 ms while persistence is active.
    // Unbounded, a single stuck save means it spins at 20 Hz for the rest of the
    // session. It must stop -- but NOT by reloading the stroke store, which is
    // covered by 'keeps local ink when the wait expires'. Observable here as the
    // timer going quiet: no further work is scheduled once the budget is gone.
    drawing = false;
    const seam = window.PdfPreviewModal.__test;
    seam.setPendingDrawingSaves(1);          // never resolves

    document.dispatchEvent(new Event('fullscreenchange'));
    await vi.advanceTimersByTimeAsync(20000);

    expect(
      seam.getMarkupRefreshState().retryArmed,
      'the guard is still spinning at 20 Hz after its budget expired',
    ).toBe(false);
    expect(seam.getMarkupRefreshState().deadline).toBe(0);

    seam.setPendingDrawingSaves(0);
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

  it('does not replace the graded PDF for comparison while a stroke save is pending', async () => {
    window.PdfPreviewModal.__test.setPendingDrawingSaves(1);

    const loading = window.loadPdfForComparison('/comparison.pdf');
    await Promise.resolve();

    expect(
      window.__pdfGradedViewer.loadPDF,
      'comparison replaced the page DOM before the create-POST resolved',
    ).not.toHaveBeenCalled();

    window.PdfPreviewModal.__test.setPendingDrawingSaves(0);
    await vi.advanceTimersByTimeAsync(100);
    await loading;

    expect(window.__pdfGradedViewer.loadPDF).toHaveBeenCalledWith('/comparison.pdf');
  });
});
