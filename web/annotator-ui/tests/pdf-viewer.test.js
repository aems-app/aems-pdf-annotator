import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let intersectionObserverCallback = null;

describe('pdf-viewer page jumps', () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) {
        intersectionObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    intersectionObserverCallback = null;
    vi.restoreAllMocks();
    delete window.pdfjsLib;
  });

  describe('navigation button bounds', () => {
    let viewer;
    let controller;

    const expectButtons = (prevDisabled, nextDisabled) => {
      expect.soft(document.getElementById('pdfGradedPrev').disabled, 'Prev.disabled').toBe(prevDisabled);
      expect.soft(document.getElementById('pdfGradedNext').disabled, 'Next.disabled').toBe(nextDisabled);
    };

    const loadDocument = async (numPages) => {
      window.pdfjsLib = {
        getDocument: vi.fn(() => ({
          promise: Promise.resolve({ numPages, destroy: vi.fn() }),
        })),
      };
      await viewer.loadPDF('/document.pdf');
      expect(viewer.pdf.numPages).toBe(numPages);
      expect(viewer.currentPage).toBe(1);
    };

    beforeEach(async () => {
      await import('../src/pdf-preview-modal/pdf-viewer.js');
      viewer = window.PdfPreviewModalViewer.createViewer(
        'pdfGradedCanvas',
        'pdfGradedContainer',
        'pdfGradedLoading',
        'pdfGradedControls',
      );
      // Keep navigation and loadPDF real; only replace the PDF rendering work,
      // using the same fake document and page wrappers as the page-jump tests.
      vi.spyOn(viewer, 'renderSkeleton').mockImplementation(async () => {
        viewer.container.innerHTML = '';
        for (let pageNum = 1; pageNum <= viewer.pdf.numPages; pageNum += 1) {
          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page-wrapper';
          wrapper.dataset.pageNum = String(pageNum);
          wrapper.scrollIntoView = vi.fn();
          viewer.container.appendChild(wrapper);
        }
      });
      vi.spyOn(viewer, 'renderSpecificPage').mockResolvedValue();
    });

    afterEach(() => {
      controller?.destroy();
      controller = undefined;
      viewer.destroy();
      delete window.__pdfGradedViewer;
      delete window.PdfPreviewModalDocumentController;
    });

    it('disables Prev and enables Next on the first page of a multi-page document', async () => {
      await loadDocument(3);
      expectButtons(true, false);
    });

    it('disables Next and enables Prev after nextPage reaches the last page', async () => {
      await loadDocument(3);
      viewer.nextPage();
      expect(viewer.currentPage).toBe(2);
      expectButtons(false, false);
      viewer.nextPage();
      expect(viewer.currentPage).toBe(3);
      expectButtons(false, true);
    });

    it('re-enables Next when previousPage leaves the last page', async () => {
      await loadDocument(3);
      await viewer.scrollToPage(3, false);
      expectButtons(false, true);
      viewer.previousPage();
      expect(viewer.currentPage).toBe(2);
      expectButtons(false, false);
    });

    it.each(['page input', 'page slider', 'goToPage'])(
      'refreshes both bounds when jumping via the %s',
      async (control) => {
        await loadDocument(3);
        document.body.insertAdjacentHTML('beforeend', '<input id="pdfGradedPageSlider" type="range" min="1" max="3">');
        window.__pdfGradedViewer = viewer;
        await import('../src/pdf-preview-modal/document-controller.js');
        controller = window.PdfPreviewModalDocumentController.createDocumentController({}, {});

        const jump = (pageNum) => {
          if (control === 'goToPage') {
            controller.goToPage(pageNum);
          } else {
            const isSlider = control === 'page slider';
            const input = document.getElementById(isSlider ? 'pdfGradedPageSlider' : 'pdfGradedPageInput');
            input.value = String(pageNum);
            input.dispatchEvent(new Event(isSlider ? 'input' : 'change', { bubbles: true }));
          }
          expect(viewer.currentPage).toBe(pageNum);
        };

        jump(3);
        expectButtons(false, true);
        jump(1);
        expectButtons(true, false);
        jump(2);
        expectButtons(false, false);
      },
    );

    it('disables both buttons for a single-page document', async () => {
      await loadDocument(1);
      expectButtons(true, true);
    });

    it('disables both buttons before any document is loaded', () => {
      expect(viewer.pdf).toBe(null);
      expectButtons(true, true);
    });

    it('disables both buttons for a zero-page document', async () => {
      await loadDocument(0);
      expectButtons(true, true);
    });

    it('resets the bounds when reloading documents with different page counts', async () => {
      await loadDocument(3);
      await viewer.scrollToPage(3, false);
      expectButtons(false, true);
      await loadDocument(5);
      expectButtons(true, false);
      await loadDocument(1);
      expectButtons(true, true);
      await loadDocument(2);
      expectButtons(true, false);
    });

    it('refreshes the bounds for scroll-driven current-page updates', async () => {
      await loadDocument(3);
      for (const pageNum of [3, 1, 2]) {
        intersectionObserverCallback([{
          target: viewer.container.querySelector(`[data-page-num="${pageNum}"]`),
          isIntersecting: true,
          intersectionRatio: 0.9,
        }]);
        expect(viewer.currentPage).toBe(pageNum);
        expectButtons(pageNum === 1, pageNum === 3);
      }
    });

    it('refreshes the bounds after rendering in single-page mode', async () => {
      await loadDocument(3);
      viewer.useSinglePageMode = true;
      viewer.canvas = document.createElement('canvas');
      viewer.canvas.getContext = vi.fn(() => ({}));
      viewer.pdf.getPage = vi.fn().mockResolvedValue({
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => ({ promise: Promise.resolve() }),
      });
      await viewer.renderPage(3);
      expect(viewer.currentPage).toBe(3);
      expectButtons(false, true);
      await viewer.renderPage(1);
      expect(viewer.currentPage).toBe(1);
      expectButtons(true, false);
    });

    it('refreshes the bounds when page information receives a changed page count', async () => {
      await loadDocument(3);
      await viewer.scrollToPage(3, false);
      expectButtons(false, true);
      viewer.pdf.numPages = 4;
      viewer.updatePageInfo();
      expectButtons(false, false);
      viewer.pdf.numPages = 3;
      viewer.updatePageInfo();
      expectButtons(false, true);
    });

    it('disables both buttons when the document is released', async () => {
      await loadDocument(3);
      await viewer.scrollToPage(2, false);
      expectButtons(false, false);
      viewer.destroy();
      expect(viewer.pdf).toBe(null);
      expectButtons(true, true);
    });
  });

  it('renders the jumped-to page and its neighbors immediately', async () => {
    await import('../src/pdf-preview-modal/pdf-viewer.js');

    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );

    viewer.useSinglePageMode = false;
    viewer.pdf = { numPages: 6 };

    const container = document.getElementById('pdfGradedContainer');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => 720,
    });

    const wrapperByPage = new Map();
    for (let pageNum = 1; pageNum <= 6; pageNum += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.scrollIntoView = vi.fn();
      container.appendChild(wrapper);
      wrapperByPage.set(pageNum, wrapper);
    }

    let resolveTargetRender;
    const targetRenderPromise = new Promise((resolve) => {
      resolveTargetRender = resolve;
    });
    const renderSpy = vi.spyOn(viewer, 'renderSpecificPage').mockImplementation((pageNum) => {
      if (pageNum === 5) {
        return targetRenderPromise;
      }
      return Promise.resolve();
    });

    const jumpPromise = viewer.scrollToPage(5, false);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenNthCalledWith(1, 5);
    expect(wrapperByPage.get(5).scrollIntoView).not.toHaveBeenCalled();

    resolveTargetRender();
    await jumpPromise;

    expect(wrapperByPage.get(5).scrollIntoView).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(renderSpy).toHaveBeenNthCalledWith(1, 5);
    expect(renderSpy).toHaveBeenNthCalledWith(2, 4);
    expect(renderSpy).toHaveBeenNthCalledWith(3, 6);
    expect(document.getElementById('pdfGradedPageInput').value).toBe('5');
  });

  it('tracks the requested page immediately during rapid next-page navigation', async () => {
    await import('../src/pdf-preview-modal/pdf-viewer.js');

    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );

    viewer.useSinglePageMode = false;
    viewer.pdf = { numPages: 6 };

    const container = document.getElementById('pdfGradedContainer');
    for (let pageNum = 1; pageNum <= 6; pageNum += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.scrollIntoView = vi.fn();
      container.appendChild(wrapper);
    }

    const pendingRenders = new Map();
    vi.spyOn(viewer, 'renderSpecificPage').mockImplementation((pageNum) => {
      if (!pendingRenders.has(pageNum)) {
        pendingRenders.set(pageNum, new Promise((resolve) => {
          pendingRenders.set(`${pageNum}:resolve`, resolve);
        }));
      }
      return pendingRenders.get(pageNum);
    });

    const firstAdvance = viewer.nextPage();
    const secondAdvance = viewer.nextPage();

    expect(viewer.currentPage).toBe(3);
    expect(document.getElementById('pdfGradedPageInput').value).toBe('3');

    pendingRenders.get('2:resolve')?.();
    pendingRenders.get('3:resolve')?.();
    await Promise.all([firstAdvance, secondAdvance]);
  });

  it('does not let a stale observer update absorb the next rapid click', async () => {
    await import('../src/pdf-preview-modal/pdf-viewer.js');

    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );

    viewer.useSinglePageMode = false;
    viewer.pdf = { numPages: 6 };

    const container = document.getElementById('pdfGradedContainer');
    const wrapperByPage = new Map();
    for (let pageNum = 1; pageNum <= 6; pageNum += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.scrollIntoView = vi.fn();
      container.appendChild(wrapper);
      wrapperByPage.set(pageNum, wrapper);
    }

    vi.spyOn(viewer, 'renderSpecificPage').mockResolvedValue();
    viewer.setupIntersectionObserver();

    await viewer.scrollToPage(2, false);
    viewer.nextPage();

    expect(viewer.currentPage).toBe(3);
    expect(viewer.pendingNavigationPage).toBe(3);

    intersectionObserverCallback?.([{
      target: wrapperByPage.get(2),
      isIntersecting: true,
      intersectionRatio: 0.9,
    }]);

    expect(viewer.currentPage).toBe(3);
    expect(viewer.pendingNavigationPage).toBe(3);

    viewer.nextPage();
    expect(viewer.currentPage).toBe(4);
    expect(document.getElementById('pdfGradedPageInput').value).toBe('4');

    intersectionObserverCallback?.([{
      target: wrapperByPage.get(4),
      isIntersecting: true,
      intersectionRatio: 0.9,
    }]);

    expect(viewer.pendingNavigationPage).toBe(null);
    expect(viewer.currentPage).toBe(4);
  });

  it('keeps the requested page stable while the observer settles around a jump target', async () => {
    await import('../src/pdf-preview-modal/pdf-viewer.js');

    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );

    viewer.useSinglePageMode = false;
    viewer.pdf = { numPages: 6 };

    const container = document.getElementById('pdfGradedContainer');
    const wrapperByPage = new Map();
    for (let pageNum = 1; pageNum <= 6; pageNum += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.scrollIntoView = vi.fn();
      container.appendChild(wrapper);
      wrapperByPage.set(pageNum, wrapper);
    }

    vi.spyOn(viewer, 'renderSpecificPage').mockResolvedValue();
    viewer.setupIntersectionObserver();

    await viewer.scrollToPage(3, false);
    expect(viewer.currentPage).toBe(3);
    expect(viewer.pendingNavigationPage).toBe(3);

    intersectionObserverCallback?.([{
      target: wrapperByPage.get(3),
      isIntersecting: true,
      intersectionRatio: 0.9,
    }]);
    expect(viewer.pendingNavigationPage).toBe(null);
    expect(viewer.currentPage).toBe(3);

    intersectionObserverCallback?.([{
      target: wrapperByPage.get(4),
      isIntersecting: true,
      intersectionRatio: 0.9,
    }]);
    expect(viewer.currentPage).toBe(3);
    expect(document.getElementById('pdfGradedPageInput').value).toBe('3');
  });

  it('does not mark a page rendered when its canvas was detached during render (BUG-5 guard)', async () => {
    // Repro of BUG-5 page-5-blank: a ResizeObserver-driven reRenderAllPages
    // can call renderSkeleton() (container.innerHTML = '') while a
    // renderSpecificPage(pageNum) is mid-await. The captured canvas becomes
    // detached, the wrapper is replaced by a fresh blank canvas, and the
    // render promise still resolves against the orphaned canvas. Before the
    // fix the page was added to renderedPages anyway, so the observer would
    // skip subsequent re-renders and the new blank canvas would stay blank.
    await import('../src/pdf-preview-modal/pdf-viewer.js');

    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );

    viewer.useSinglePageMode = false;
    const container = document.getElementById('pdfGradedContainer');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => 720,
    });

    const fakeCtx = { clearRect: vi.fn(), drawImage: vi.fn(), fillStyle: '', fillRect: vi.fn() };
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.pageNum = '5';
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.getContext = vi.fn(() => fakeCtx);
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    let resolveRender;
    const renderPromise = new Promise((resolve) => { resolveRender = resolve; });
    viewer.pdf = {
      numPages: 6,
      getPage: vi.fn().mockResolvedValue({
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => ({
          promise: renderPromise,
          cancel: () => {},
        }),
      }),
    };

    const renderInFlight = viewer.renderSpecificPage(5);
    // Mid-render, simulate reRenderAllPages: detach the wrapper + canvas and
    // install a fresh wrapper with a fresh canvas in the same data-page-num.
    await Promise.resolve();
    container.innerHTML = '';
    const freshWrapper = document.createElement('div');
    freshWrapper.className = 'pdf-page-wrapper';
    freshWrapper.dataset.pageNum = '5';
    const freshCanvas = document.createElement('canvas');
    freshCanvas.className = 'pdf-page-canvas';
    freshCanvas.getContext = vi.fn(() => fakeCtx);
    freshWrapper.appendChild(freshCanvas);
    container.appendChild(freshWrapper);

    // Now resolve the in-flight render task on the orphaned canvas.
    resolveRender();
    await renderInFlight;

    expect(canvas.isConnected).toBe(false);
    expect(viewer.renderedPages.has(5)).toBe(false);
  });

  it('waits for the drawing-persistence guard before replacing the graded page DOM', async () => {
    let releaseReplacement;
    const replacementAllowed = new Promise((resolve) => {
      releaseReplacement = resolve;
    });
    const beforeDocumentReplace = vi.fn(() => replacementAllowed);
    window.pdfjsLib = {
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({ numPages: 1 }),
      })),
    };

    await import('../src/pdf-preview-modal/pdf-viewer.js');
    const viewer = window.PdfPreviewModalViewer.createViewer(
      'pdfGradedCanvas',
      'pdfGradedContainer',
      'pdfGradedLoading',
      'pdfGradedControls',
    );
    viewer.beforeDocumentReplace(beforeDocumentReplace);
    const renderSkeleton = vi.spyOn(viewer, 'renderSkeleton').mockResolvedValue();
    vi.spyOn(viewer, 'renderSpecificPage').mockResolvedValue();

    const loading = viewer.loadPDF('/replacement.pdf');
    await Promise.resolve();
    await Promise.resolve();

    expect(beforeDocumentReplace, 'loadPDF bypassed the stroke-safety gate').toHaveBeenCalledOnce();
    expect(renderSkeleton, 'loadPDF rebuilt the page DOM before strokes were safe').not.toHaveBeenCalled();

    releaseReplacement();
    await loading;
    expect(renderSkeleton).toHaveBeenCalledOnce();
  });
});
