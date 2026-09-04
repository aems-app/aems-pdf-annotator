import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The rebuild arbiter.
//
// Before this existed, PDFViewer's own ResizeObserver called
// reRenderAllPages(true) after a 120 ms debounce with NO drawing guard, so the
// "defer the redraw while drawing" check that PR #5 added to document-controller
// never protected the rebuild that actually fires -- the observer's 120 ms timer
// beats the controller's 400 ms one. A rebuild landing mid-stroke destroys the
// drawing overlay and clears pageViewports, which is the #472 defect.
//
// A guard that merely returns is not acceptable either: it would drop the
// resize permanently and leave the pages laid out for the old width.

let resizeObserverCallback = null;

function stubGlobals() {
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { resizeObserverCallback = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
}

async function makeViewer() {
  await import('../src/pdf-preview-modal/pdf-viewer.js');
  const viewer = window.PdfPreviewModalViewer.createViewer(
    'pdfGradedCanvas',
    'pdfGradedContainer',
    'pdfGradedLoading',
    'pdfGradedControls',
  );
  viewer.useSinglePageMode = false;
  viewer.pdf = { numPages: 3, getPage: vi.fn(), destroy: vi.fn() };
  const container = document.getElementById('pdfGradedContainer');
  Object.defineProperty(container, 'clientWidth', { configurable: true, get: () => 720 });
  return viewer;
}

describe('pdf-viewer rebuild arbiter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    resizeObserverCallback = null;
    delete window.PdfPreviewModalViewer;
    delete window.AEMS;
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedLoading"></div>
      <div id="pdfGradedPageInfo"><span></span><span></span></div>
      <input id="pdfGradedPageInput" value="1">
      <span id="pdfGradedZoomLevel"></span>
      <button id="pdfGradedPrev"></button>
      <button id="pdfGradedNext"></button>
      <button id="pdfGradedZoomIn"></button>
      <button id="pdfGradedZoomOut"></button>
    `;
    stubGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes a requestRebuild scheduler and an injectable defer predicate', async () => {
    const viewer = await makeViewer();
    expect(typeof viewer.requestRebuild).toBe('function');
    // Injected, not reached for: pdf-viewer must not know about DrawingCanvas.
    expect('shouldDeferRebuild' in viewer).toBe(true);
  });

  it('defers a rebuild while the predicate is true, then performs it once', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);

    let drawing = true;
    viewer.shouldDeferRebuild = () => drawing;

    viewer.requestRebuild(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(spy).not.toHaveBeenCalled();

    drawing = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('does not lose the resize: the deferred rebuild still happens', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    let drawing = true;
    viewer.shouldDeferRebuild = () => drawing;

    const done = viewer.requestRebuild(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).not.toHaveBeenCalled();
    drawing = false;
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests into one rebuild and keeps the strongest force', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    let drawing = true;
    viewer.shouldDeferRebuild = () => drawing;

    viewer.requestRebuild(false);
    viewer.requestRebuild(true);   // stronger
    viewer.requestRebuild(false);
    await vi.advanceTimersByTimeAsync(100);
    drawing = false;
    await vi.advanceTimersByTimeAsync(100);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('resolves the promise after the rebuild, not on deferral', async () => {
    const viewer = await makeViewer();
    let finished = false;
    let release;
    vi.spyOn(viewer, 'reRenderAllPages').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    let drawing = true;
    viewer.shouldDeferRebuild = () => drawing;

    viewer.requestRebuild(true).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(300);
    expect(finished).toBe(false);   // still deferred

    drawing = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);   // rebuild in flight, not done
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
  });

  it('routes the ResizeObserver through the arbiter, so a mid-stroke resize is deferred', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    viewer.shouldDeferRebuild = () => true;   // a stroke is in progress
    viewer.lastRenderContainerWidth = 100;    // force a >16px width delta

    expect(typeof resizeObserverCallback).toBe('function');
    resizeObserverCallback([]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(spy).not.toHaveBeenCalled();
  });

  it('rechecks immediately before the destructive clear, not only at timer entry', async () => {
    // renderSkeleton() awaits pdf.getPage(1) before wiping the container, and
    // reRenderAllPages clears pageViewports before that await. A stroke that
    // starts after the guard check but before the clear must still be honoured.
    const viewer = await makeViewer();
    viewer.pageViewports = new Map([[1, {}]]);
    viewer.renderSkeleton = vi.fn().mockResolvedValue(undefined);
    viewer.setupIntersectionObserver = vi.fn();
    viewer.updateZoomLevel = vi.fn();
    viewer.lastRenderContainerWidth = 100;

    viewer.shouldDeferRebuild = () => true;   // began drawing after scheduling
    await viewer.reRenderAllPages(true);

    expect(viewer.renderSkeleton).not.toHaveBeenCalled();
    expect(viewer.pageViewports.size).toBe(1);   // viewports NOT cleared
  });

  it('a stuck predicate cannot defer forever', async () => {
    // If isDrawing were ever left true, an unbounded retry would freeze the
    // layout at the old width for the life of the modal.
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    viewer.shouldDeferRebuild = () => true;   // never clears

    viewer.requestRebuild(true);
    await vi.advanceTimersByTimeAsync(30000);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('a throwing predicate does not block the rebuild', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    viewer.shouldDeferRebuild = () => { throw new Error('boom'); };

    viewer.requestRebuild(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('destroy() cancels a pending deferred rebuild', async () => {
    const viewer = await makeViewer();
    const spy = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    viewer.shouldDeferRebuild = () => true;

    viewer.requestRebuild(true);
    await vi.advanceTimersByTimeAsync(60);
    viewer.destroy();
    await vi.advanceTimersByTimeAsync(30000);

    expect(spy).not.toHaveBeenCalled();
  });
});
