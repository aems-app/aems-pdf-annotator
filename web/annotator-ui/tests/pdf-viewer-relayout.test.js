import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Non-destructive container reflow.
//
// A pure container-width change does not need the PDF bitmap rebuilt: the page
// canvas is sized `scale * zoom` and never reads the container width at all, so
// only the CSS box moves. But the resize path called reRenderAllPages(), which
// clears pageViewports and calls renderSkeleton() -> `container.innerHTML = ''`,
// destroying the drawing overlay mid-stroke. That is the #472 teardown hazard.
//
// A previous attempt DEFERRED that rebuild behind an arbiter and was reverted:
// deferring the canvas rebuild does not defer the CSS relayout, so a stroke
// spanning a fullscreen toggle landed ~3.4x further out. This is the opposite
// approach -- make the resize non-destructive rather than late.
//
// TWO independent oracles are used here, because the last regression in this
// area passed every automated check including the 76-check live gate:
//   1. A DIFFERENTIAL against the shipping rebuild path. The reflow must produce
//      byte-identical style strings to what renderSkeleton()/renderSpecificPage()
//      write at the same width. Neither side is authored by the reflow.
//   2. An arithmetic oracle written from the formula in the rebuild code, so a
//      matched pair of wrong numbers still fails.

let resizeObserverCallback = null;

function stubGlobals() {
  vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { resizeObserverCallback = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
}

const PAGE_W = 612;   // points
const PAGE_H = 792;

function fakeViewport(scale) {
  return { width: PAGE_W * scale, height: PAGE_H * scale };
}

// jsdom has no 2d context. Every canvas the viewer creates itself (skeleton
// pages) must still hand one back, or renderSpecificPage() throws before it
// reaches the code under comparison.
const fakeCtx = { clearRect: () => {}, drawImage: () => {}, fillRect: () => {} };

function stubCanvasContext() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx);
}

function fakePdf() {
  return {
    numPages: 2,
    destroy: () => {},
    getPage: async () => ({
      getViewport: ({ scale }) => fakeViewport(scale),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    }),
  };
}

async function makeViewer(containerWidth) {
  await import('../src/pdf-preview-modal/pdf-viewer.js');
  const viewer = window.PdfPreviewModalViewer.createViewer(
    'pdfGradedCanvas', 'pdfGradedContainer', 'pdfGradedLoading', 'pdfGradedControls',
  );
  viewer.useSinglePageMode = false;
  viewer.pdf = fakePdf();
  const container = document.getElementById('pdfGradedContainer');
  Object.defineProperty(container, 'clientWidth', {
    configurable: true,
    get: () => containerWidth.value,
  });
  return viewer;
}

// Build the DOM a rendered page leaves behind, plus a drawing overlay.
function buildRenderedPage(viewer, pageNum, displayW, displayH) {
  const container = document.getElementById('pdfGradedContainer');
  const wrapper = document.createElement('div');
  wrapper.className = 'pdf-page-wrapper';
  wrapper.dataset.pageNum = String(pageNum);
  wrapper.style.width = `${displayW}px`;
  wrapper.style.height = `${displayH}px`;

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-page-canvas';
  canvas.dataset.pageNum = String(pageNum);
  canvas.getContext = () => fakeCtx;
  canvas.width = PAGE_W * viewer.scale * viewer.zoom;
  canvas.height = PAGE_H * viewer.scale * viewer.zoom;
  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;
  wrapper.appendChild(canvas);

  const overlay = document.createElement('canvas');
  overlay.className = 'drawing-canvas-overlay';
  overlay.dataset.pageIdx = String(pageNum - 1);
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  wrapper.appendChild(overlay);

  container.appendChild(wrapper);
  viewer.pageViewports.set(pageNum, fakeViewport(viewer.scale * viewer.zoom));
  viewer.renderedPages.add(pageNum);
  return { wrapper, canvas, overlay };
}

// Oracle 2: the dimensions a rebuild computes, transcribed from the formula in
// renderSkeleton()/renderSpecificPage() rather than from the reflow. The
// container's own effective width (which subtracts padding and a 16px gutter)
// is shared by both paths and is not what is under test here.
function expectedDisplay(viewer) {
  const cw = viewer.getEffectiveContainerWidth();
  const baseW = PAGE_W * viewer.scale;
  const baseH = PAGE_H * viewer.scale;
  const fit = Math.min(1, cw / baseW);
  return { w: baseW * fit * viewer.zoom, h: baseH * fit * viewer.zoom };
}

describe('pdf-viewer non-destructive container reflow', () => {
  beforeEach(() => {
    vi.resetModules();
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
    stubCanvasContext();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('exposes relayoutPagesForContainer', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    expect(typeof viewer.relayoutPagesForContainer).toBe('function');
  });

  // ---- Oracle 1: differential against the shipping rebuild path -------------

  it('DIFFERENTIAL: a reflowed skeleton page matches what renderSkeleton writes', async () => {
    const cw = { value: 800 };

    // Rebuild path: skeleton at 800, then skeleton again at 500.
    const rebuilt = await makeViewer(cw);
    await rebuilt.renderSkeleton();
    cw.value = 500;
    await rebuilt.renderSkeleton();
    const rebuiltWrapper = document.querySelector('.pdf-page-wrapper[data-page-num="1"]');
    const rebuiltW = rebuiltWrapper.style.width;
    const rebuiltH = rebuiltWrapper.style.height;

    // Reflow path: skeleton at 800, then reflow to 500.
    document.getElementById('pdfGradedContainer').innerHTML = '';
    cw.value = 800;
    const reflowed = await makeViewer(cw);
    await reflowed.renderSkeleton();
    cw.value = 500;
    await reflowed.relayoutPagesForContainer();
    const reflowedWrapper = document.querySelector('.pdf-page-wrapper[data-page-num="1"]');

    expect(rebuiltW).not.toBe('');
    expect(reflowedWrapper.style.width).toBe(rebuiltW);
    expect(reflowedWrapper.style.height).toBe(rebuiltH);
  });

  it('DIFFERENTIAL: a reflowed rendered page matches what renderSpecificPage writes', async () => {
    const cw = { value: 800 };

    // Rebuild path: render page 1 at 500 from scratch.
    const rebuilt = await makeViewer(cw);
    cw.value = 500;
    await rebuilt.renderSkeleton();
    await rebuilt.renderSpecificPage(1);
    const rebuiltCanvas = document.querySelector('.pdf-page-canvas[data-page-num="1"]');
    const rebuiltW = rebuiltCanvas.style.width;
    const rebuiltH = rebuiltCanvas.style.height;
    const rebuiltWrapperW = rebuiltCanvas.parentElement.style.width;

    // Reflow path: render page 1 at 800, then reflow to 500.
    document.getElementById('pdfGradedContainer').innerHTML = '';
    cw.value = 800;
    const reflowed = await makeViewer(cw);
    await reflowed.renderSkeleton();
    await reflowed.renderSpecificPage(1);
    cw.value = 500;
    await reflowed.relayoutPagesForContainer();
    const reflowedCanvas = document.querySelector('.pdf-page-canvas[data-page-num="1"]');

    expect(rebuiltW).not.toBe('');
    expect(rebuiltW).not.toBe('100%');
    expect(reflowedCanvas.style.width).toBe(rebuiltW);
    expect(reflowedCanvas.style.height).toBe(rebuiltH);
    expect(reflowedCanvas.parentElement.style.width).toBe(rebuiltWrapperW);
  });

  // ---- Oracle 2: arithmetic ------------------------------------------------

  it('produces exactly the dimensions the fitting formula gives', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    const { wrapper, canvas } = buildRenderedPage(viewer, 1, before.w, before.h);

    cw.value = 500;                       // the container narrows
    await viewer.relayoutPagesForContainer();

    const after = expectedDisplay(viewer);
    expect(after.w).not.toBe(before.w);   // the test would be vacuous otherwise
    expect(wrapper.style.width).toBe(`${after.w}px`);
    expect(wrapper.style.height).toBe(`${after.h}px`);
    expect(canvas.style.width).toBe(`${after.w}px`);
    expect(canvas.style.height).toBe(`${after.h}px`);
  });

  it('clamps the fit factor at 1 when the container is wider than the page', async () => {
    const cw = { value: 4000 };
    const viewer = await makeViewer(cw);
    const { wrapper } = buildRenderedPage(viewer, 1, 10, 10);

    await viewer.relayoutPagesForContainer();

    // fit = min(1, ...) -> the page never scales up past its natural size.
    expect(wrapper.style.width).toBe(`${PAGE_W * viewer.scale * viewer.zoom}px`);
  });

  // ---- The property the reflow exists for ----------------------------------

  it('never touches the bitmap, the viewports, or the DOM identity', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    const { wrapper, canvas, overlay } = buildRenderedPage(viewer, 1, before.w, before.h);
    const bitmapW = canvas.width;
    const bitmapH = canvas.height;
    const skeleton = vi.spyOn(viewer, 'renderSkeleton');

    cw.value = 460;
    await viewer.relayoutPagesForContainer();

    // The whole point: nothing is destroyed and no stroke can be lost.
    expect(skeleton).not.toHaveBeenCalled();
    expect(canvas.width).toBe(bitmapW);
    expect(canvas.height).toBe(bitmapH);
    expect(viewer.pageViewports.get(1)).toBeTruthy();
    expect(viewer.renderedPages.has(1)).toBe(true);
    expect(document.querySelector('#pdfGradedContainer .drawing-canvas-overlay')).toBe(overlay);
    expect(overlay.isConnected).toBe(true);
    expect(wrapper.isConnected).toBe(true);
  });

  it('leaves a skeleton canvas on its percentage sizing', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    const canvas = document.querySelector('.pdf-page-canvas[data-page-num="1"]');
    expect(canvas.style.width).toBe('100%');

    cw.value = 500;
    await viewer.relayoutPagesForContainer();

    // The skeleton canvas fills its wrapper; overwriting it with a px value
    // would fight the wrapper on the next rebuild.
    expect(canvas.style.width).toBe('100%');
  });

  it('reflows pages that have not been rendered yet', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    buildRenderedPage(viewer, 1, before.w, before.h);
    // A stored base viewport is what renderSkeleton() leaves behind.
    viewer._skeletonBaseViewport = { width: PAGE_W * viewer.scale, height: PAGE_H * viewer.scale };

    // Page 2 exists as a skeleton wrapper with no stored viewport.
    const container = document.getElementById('pdfGradedContainer');
    const wrapper2 = document.createElement('div');
    wrapper2.className = 'pdf-page-wrapper';
    wrapper2.dataset.pageNum = '2';
    wrapper2.style.width = `${before.w}px`;
    wrapper2.style.height = `${before.h}px`;
    container.appendChild(wrapper2);

    cw.value = 500;
    await viewer.relayoutPagesForContainer();

    const after = expectedDisplay(viewer);
    expect(wrapper2.style.width).toBe(`${after.w}px`);
  });

  it('notifies the host so px-positioned annotation markers reposition', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    buildRenderedPage(viewer, 1, before.w, before.h);
    const seen = [];
    viewer.onResizeComplete((v) => seen.push(v));

    cw.value = 500;
    await viewer.relayoutPagesForContainer();

    // No page renders during a reflow, so onPageRendered never fires; without
    // this callback the markers keep their pre-resize geometry.
    expect(seen).toEqual([viewer]);
  });

  // ---- Scroll anchoring ----------------------------------------------------

  // jsdom lays nothing out, so give the container a faithful stacked-block
  // model: each wrapper's offsetTop is the sum of the inline heights above it,
  // and its client rect is that offset minus the container's scrollTop. This
  // models the browser, not the implementation -- the code reads
  // getBoundingClientRect() before resizing and offsetTop/offsetHeight after,
  // and both must reflect whatever the inline styles currently say.
  function installLayout(container, gap = 20) {
    let scrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v) => { scrollTop = v; },
    });
    container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: 600 });
    const offsetOf = (el) => {
      let acc = 0;
      for (const w of container.querySelectorAll('.pdf-page-wrapper')) {
        if (w === el) return acc;
        acc += parseFloat(w.style.height || '0') + gap;
      }
      return acc;
    };
    for (const w of container.querySelectorAll('.pdf-page-wrapper')) {
      Object.defineProperty(w, 'offsetTop', { configurable: true, get: () => offsetOf(w) });
      Object.defineProperty(w, 'offsetHeight', {
        configurable: true,
        get: () => parseFloat(w.style.height || '0'),
      });
      w.getBoundingClientRect = () => ({
        top: offsetOf(w) - container.scrollTop,
        left: 0,
        width: parseFloat(w.style.width || '0'),
        height: parseFloat(w.style.height || '0'),
      });
    }
  }

  it('keeps the current page anchored when the resize changes page heights', async () => {
    // The rebuild this replaced captured a {page, ratio} anchor and restored
    // container.scrollTop afterwards (reRenderAllPages), and the viewer's OTHER
    // in-place resize (zoomResizeAndRenderVisible) still does. A reflow that
    // rewrites every wrapper height without re-anchoring leaves scrollTop
    // pointing at a stale pixel offset, so the reader is thrown pages away.
    const cw = { value: 516 };            // effective 500 -> fit 500/918, short pages
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    const container = document.getElementById('pdfGradedContainer');
    installLayout(container);

    const page2 = container.querySelector('.pdf-page-wrapper[data-page-num="2"]');
    viewer.currentPage = 2;
    container.scrollTop = page2.offsetTop;          // page 2 flush with the top
    expect(page2.getBoundingClientRect().top).toBe(0);
    const shortHeight = page2.offsetHeight;

    cw.value = 1416;                                 // effective 1400 -> fit clamps to 1
    await viewer.relayoutPagesForContainer();

    expect(page2.offsetHeight).toBeGreaterThan(shortHeight);   // heights really changed
    expect(
      Math.abs(page2.getBoundingClientRect().top),
      'the anchored page drifted out of view after the reflow',
    ).toBeLessThanOrEqual(1);
  });

  // ---- Zoom is not an identity in this arithmetic --------------------------

  it('reflows correctly at a zoom other than 1', async () => {
    // Every other test here runs at zoom 1.0, where `* zoom` and `/ zoom` are
    // identity operations and a zoom-blind implementation (`const zoom = 1`)
    // would pass. This one makes the zoom terms load-bearing.
    const cw = { value: 816 };            // effective 800
    const viewer = await makeViewer(cw);
    viewer.zoom = 1.25;
    await viewer.renderSkeleton();
    await viewer.renderSpecificPage(1);
    const canvas = document.querySelector('.pdf-page-canvas[data-page-num="1"]');
    const wrapper = canvas.parentElement;
    // The bitmap is scale*zoom and must not move; only the box may.
    const bitmap = Math.trunc(PAGE_W * viewer.scale * 1.25);   // canvas.width is an int
    expect(canvas.width).toBe(bitmap);

    cw.value = 616;                        // effective 600
    await viewer.relayoutPagesForContainer();

    const base = PAGE_W * viewer.scale;    // 918 -- zoom-independent
    const fit = Math.min(1, 600 / base);
    expect(wrapper.style.width).toBe(`${base * fit * 1.25}px`);
    expect(canvas.width).toBe(bitmap);     // still untouched
  });

  // ---- Lifecycle -----------------------------------------------------------

  it('never reflows a single-page viewer, whose bitmap DOES follow the container', async () => {
    // renderPage() builds its viewport as scale * fitScaleFactor * zoom and
    // assigns it to canvas.width, so for that mode the load-bearing invariant
    // is false and a CSS-only reflow would leave the page at the wrong size.
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    const wrapper = document.querySelector('.pdf-page-wrapper[data-page-num="1"]');
    const before = wrapper.style.width;

    viewer.useSinglePageMode = true;
    cw.value = 516;
    await viewer.relayoutPagesForContainer();

    expect(wrapper.style.width).toBe(before);
  });

  it('destroy() releases the resize-complete callback like every other one', async () => {
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    viewer.onResizeComplete(() => {});
    expect(viewer._onResizeComplete).toBeTypeOf('function');

    viewer.destroy();

    // The graded viewer is a window-lifetime singleton, so a retained closure
    // keeps the whole controller graph (including the page-text cache) alive.
    expect(viewer._onResizeComplete).toBeNull();
  });

  it('forgets the previous document base size when a new PDF is loaded', async () => {
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    expect(viewer._skeletonBaseViewport).toBeTruthy();

    // loadPDF resets every other per-document cache before assigning this.pdf;
    // a stale base here would size a differently-shaped document's pages.
    viewer._resetDocumentCaches();

    expect(viewer._skeletonBaseViewport).toBeNull();
  });

  it('refreshes the page indicator so the slider and comparison mode follow', async () => {
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    const info = vi.spyOn(viewer, 'updatePageInfo');

    cw.value = 616;
    await viewer.relayoutPagesForContainer();

    // The rebuild reached updatePageInfo() through scrollToPage(); it fires
    // _onSliderSync and PdfPreviewModalComparison.onPageChange.
    expect(info).toHaveBeenCalled();
  });

  // ---- Mixed page sizes ----------------------------------------------------

  it('sizes a rendered page from its OWN viewport, not page 1s', async () => {
    // Every other test uses a uniform document. A rendered page must be sized
    // from the viewport renderSpecificPage() stored for THAT page; only pages
    // with no stored viewport may fall back to page 1's base, which is exactly
    // what renderSkeleton() does for the whole document.
    const cw = { value: 816 };                 // effective 800
    const viewer = await makeViewer(cw);
    const LANDSCAPE_W = 1008;                  // A4 landscape, points
    const LANDSCAPE_H = 612;

    // page 1: portrait, rendered.  page 2: landscape, rendered.
    const before = expectedDisplay(viewer);
    const p1 = buildRenderedPage(viewer, 1, before.w, before.h);
    const p2 = buildRenderedPage(viewer, 2, before.w, before.h);
    viewer.pageViewports.set(2, {
      width: LANDSCAPE_W * viewer.scale * viewer.zoom,
      height: LANDSCAPE_H * viewer.scale * viewer.zoom,
    });
    // page 3: skeleton only, no stored viewport.
    const container = document.getElementById('pdfGradedContainer');
    const w3 = document.createElement('div');
    w3.className = 'pdf-page-wrapper';
    w3.dataset.pageNum = '3';
    container.appendChild(w3);
    viewer._skeletonBaseViewport = { width: PAGE_W * viewer.scale, height: PAGE_H * viewer.scale };

    cw.value = 616;                            // effective 600
    await viewer.relayoutPagesForContainer();

    const fitOf = (baseW) => Math.min(1, 600 / baseW);
    const portraitBase = PAGE_W * viewer.scale;      // 918
    const landscapeBase = LANDSCAPE_W * viewer.scale; // 1512

    expect(p1.wrapper.style.width).toBe(`${portraitBase * fitOf(portraitBase)}px`);
    expect(p2.wrapper.style.width).toBe(`${landscapeBase * fitOf(landscapeBase)}px`);

    // Both pages are wider than the container, so both fit to its width -- the
    // WIDTHS coincide and cannot discriminate. The heights are what prove the
    // landscape page was sized from its own viewport: if the reflow had used
    // page 1's base for it, it would be portrait-tall.
    expect(p1.wrapper.style.height)
      .toBe(`${PAGE_H * viewer.scale * fitOf(portraitBase)}px`);
    expect(p2.wrapper.style.height)
      .toBe(`${LANDSCAPE_H * viewer.scale * fitOf(landscapeBase)}px`);
    expect(p2.wrapper.style.height).not.toBe(p1.wrapper.style.height);

    // The unrendered page falls back to page 1's base, as renderSkeleton does.
    expect(w3.style.width).toBe(p1.wrapper.style.width);
    expect(w3.style.height).toBe(p1.wrapper.style.height);
  });

  // ---- The CSS clamp -------------------------------------------------------

  it('keeps the page box square with its content when CSS clamps the width', async () => {
    // annotator-ui.css:1223 sets `.pdf-page-wrapper { max-width: calc(100% - 1rem) }`
    // under .preview-fullscreen.split-panel-mode, and the canvas there is
    // `max-width:100%; height:auto`. So the browser can make the wrapper
    // NARROWER than the inline width without any JS, while the inline height
    // stays as written -- the wrapper ends up taller than the page it contains,
    // and the drawing overlay (100% x 100% of the wrapper) inherits that extra
    // height. The result is a vertical offset that grows down the page.
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    const { wrapper } = buildRenderedPage(viewer, 1, before.w, before.h);

    // Model the clamp: the used width is 20% below whatever is asked for.
    const CLAMP = 0.8;
    wrapper.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      width: parseFloat(wrapper.style.width || '0') * CLAMP,
      height: parseFloat(wrapper.style.height || '0'),
    });

    cw.value = 616;
    await viewer.relayoutPagesForContainer();

    const usedW = parseFloat(wrapper.style.width) * CLAMP;
    const aspect = PAGE_H / PAGE_W;                       // the page's own ratio
    expect(parseFloat(wrapper.style.height)).toBeCloseTo(usedW * aspect, 1);
  });

  // ---- Routing -------------------------------------------------------------

  it('the ResizeObserver reflows instead of rebuilding', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    buildRenderedPage(viewer, 1, before.w, before.h);
    const rebuild = vi.spyOn(viewer, 'reRenderAllPages').mockResolvedValue(undefined);
    const reflow = vi.spyOn(viewer, 'relayoutPagesForContainer').mockResolvedValue(undefined);
    viewer.lastRenderContainerWidth = 800;

    cw.value = 500;
    expect(typeof resizeObserverCallback).toBe('function');
    resizeObserverCallback([]);
    await vi.waitFor(() => expect(reflow).toHaveBeenCalled(), { timeout: 2000 });

    expect(rebuild, 'a container resize must not rebuild the page DOM').not.toHaveBeenCalled();
  });

  it('an observer-driven resize leaves the real overlay in place', async () => {
    // The test above mocks both methods, so it proves routing and nothing else:
    // any OTHER destructive call in the observer body would be invisible to it.
    // This one lets the real code run and checks the node identity that #472 is
    // actually about.
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    const { wrapper, overlay, canvas } = buildRenderedPage(viewer, 1, before.w, before.h);
    viewer._skeletonBaseViewport = { width: PAGE_W * viewer.scale, height: PAGE_H * viewer.scale };
    viewer.lastRenderContainerWidth = viewer.getEffectiveContainerWidth();
    const bitmapW = canvas.width;

    cw.value = 516;
    resizeObserverCallback([]);
    await vi.waitFor(
      () => expect(wrapper.style.width).not.toBe(`${before.w}px`),
      { timeout: 2000 },
    );

    expect(document.querySelector('#pdfGradedContainer .drawing-canvas-overlay')).toBe(overlay);
    expect(overlay.isConnected).toBe(true);
    expect(canvas.width).toBe(bitmapW);
    expect(viewer.pageViewports.get(1)).toBeTruthy();
  });

  it('re-arms the observer dead-band so a width round trip is not swallowed', async () => {
    // `lastRenderContainerWidth` has exactly two consumers, both the
    // ResizeObserver's 16px dead-band. The reflow's write to it is the only
    // thing that re-arms that band now that the destructive paths no longer run
    // on a resize: without it the record permanently says "laid out for the
    // width before the first reflow", so going 800 -> 500 -> 800 leaves the
    // pages stuck narrow inside a wide container. Asserted behaviourally, not
    // by reading the field.
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    const before = expectedDisplay(viewer);
    const { wrapper } = buildRenderedPage(viewer, 1, before.w, before.h);
    viewer._skeletonBaseViewport = { width: PAGE_W * viewer.scale, height: PAGE_H * viewer.scale };
    viewer.lastRenderContainerWidth = viewer.getEffectiveContainerWidth();
    const wideWidth = wrapper.style.width;

    cw.value = 516;
    resizeObserverCallback([]);
    await vi.waitFor(() => expect(wrapper.style.width).not.toBe(wideWidth), { timeout: 2000 });
    const narrowWidth = wrapper.style.width;

    cw.value = 816;                       // back to where we started
    resizeObserverCallback([]);
    await vi.waitFor(() => expect(wrapper.style.width).not.toBe(narrowWidth), { timeout: 2000 });

    expect(wrapper.style.width).toBe(wideWidth);
  });

  it('a zoom change does NOT take the reflow path, because the bitmap changes', async () => {
    // The reflow is only sound while scale*zoom is unchanged: it never assigns
    // canvas.width. Routing zoom through it would leave every page rendered at
    // the old resolution.
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    const reflow = vi.spyOn(viewer, 'relayoutPagesForContainer');
    const zoomPath = vi.spyOn(viewer, 'zoomResizeAndRenderVisible').mockResolvedValue(undefined);

    await viewer.zoomIn();

    expect(zoomPath).toHaveBeenCalled();
    expect(reflow).not.toHaveBeenCalled();
  });

  it('does not size pages from a stale viewport while a zoom is in flight', async () => {
    // zoomIn() sets this.zoom synchronously and only clears pageViewports after
    // it has awaited getPage(1). A ResizeObserver debounce timer that comes due
    // in that gap finds zoom=1.25 alongside viewports still built at zoom=1.0,
    // and `base = viewport / zoom` is then 20% too small. The rebuild path this
    // replaced could not get this wrong: renderSkeleton() re-read the page.
    // 816 clientWidth -> 800 effective. base = 612*1.5 = 918, so:
    //   before  = 918 * (800/918)          = 800px
    //   correct = 918 * (800/918) * 1.25   = 1000px
    //   stale   = (918/1.25) * 1 * 1.25    = 918px   <- distinct from both, so
    // the assertion cannot pass by coincidence.
    const cw = { value: 816 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();         // leaves _skeletonBaseViewport set
    await viewer.renderSpecificPage(1);
    const wrapper = document.querySelector('.pdf-page-wrapper[data-page-num="1"]');
    const beforeWidth = wrapper.style.width;
    const fit = Math.min(1, viewer.getEffectiveContainerWidth() / (PAGE_W * viewer.scale));
    const correctAfterZoom = `${PAGE_W * viewer.scale * fit * 1.25}px`;
    expect(beforeWidth).not.toBe(correctAfterZoom);

    const zooming = viewer.zoomIn();       // suspends at getPage(1); zoom is already 1.25
    // Not awaited, and read synchronously: the reflow writes its widths in the
    // same tick, and the zoom continuation overwrites them one microtask later.
    // Awaiting here would measure the corrected value and hide the defect.
    viewer.relayoutPagesForContainer();
    const midWidth = wrapper.style.width;
    await zooming;

    expect(viewer.zoom).toBeCloseTo(1.25, 5);
    expect(
      [beforeWidth, correctAfterZoom],
      `reflow wrote ${midWidth} from a viewport built at the previous zoom`,
    ).toContain(midWidth);
    expect(wrapper.style.width).toBe(correctAfterZoom);
  });

  it('the zoom path really does re-render at the new resolution', async () => {
    const cw = { value: 800 };
    const viewer = await makeViewer(cw);
    await viewer.renderSkeleton();
    await viewer.renderSpecificPage(1);
    const canvas = document.querySelector('.pdf-page-canvas[data-page-num="1"]');
    const bitmapAtZoom1 = canvas.width;

    await viewer.zoomIn();   // 1.0 -> 1.25

    const after = document.querySelector('.pdf-page-canvas[data-page-num="1"]');
    expect(viewer.zoom).toBeCloseTo(1.25, 5);
    expect(after.width).toBeGreaterThan(bitmapAtZoom1);
  });
});
