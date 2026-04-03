import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  });

  afterEach(() => {
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

    for (let pageNum = 1; pageNum <= 6; pageNum += 1) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrapper';
      wrapper.dataset.pageNum = String(pageNum);
      wrapper.scrollIntoView = vi.fn();
      container.appendChild(wrapper);
    }

    const renderSpy = vi
      .spyOn(viewer, 'renderSpecificPage')
      .mockResolvedValue(undefined);

    viewer.scrollToPage(5, false);

    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(renderSpy).toHaveBeenNthCalledWith(1, 4);
    expect(renderSpy).toHaveBeenNthCalledWith(2, 5);
    expect(renderSpy).toHaveBeenNthCalledWith(3, 6);
    expect(document.getElementById('pdfGradedPageInput').value).toBe('5');
  });
});
