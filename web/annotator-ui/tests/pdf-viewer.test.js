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
});
