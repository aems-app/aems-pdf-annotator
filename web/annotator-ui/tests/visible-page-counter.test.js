import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let observerCallback;
let viewer;
beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = `<div id="pdfPreviewModal" class="preview-fullscreen">
    <div id="pdfGradedContainer"><div class="pdf-page-wrapper" data-page-num="1"></div>
    <div class="pdf-page-wrapper" data-page-num="2"></div></div>
    <input id="pdfGradedPageInput"><div id="pdfGradedPageInfo"><span></span><span></span></div></div>`;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { observerCallback = callback; }
    observe() {} disconnect() {}
  });
  await import('../src/pdf-preview-modal/pdf-viewer.js');
  viewer = window.PdfPreviewModalViewer.createViewer('pdfGradedCanvas', 'pdfGradedContainer', 'pdfGradedLoading', 'pdfGradedControls');
  viewer.pdf = { numPages: 2, destroy() {} };
  viewer.useSinglePageMode = false;
  viewer.renderedPages = new Set([1, 2]);
  viewer.container.getBoundingClientRect = () => ({ top: 50, bottom: 550, height: 500, width: 1093 });
  viewer.setupIntersectionObserver();
});
afterEach(() => { viewer.destroy(); vi.unstubAllGlobals(); });

function geometry(top1, top2, height = 500) {
  const pages = [...viewer.container.children];
  [top1, top2].forEach((top, index) => {
    pages[index].getBoundingClientRect = () => ({ top, bottom: top + height, height, width: 700 });
  });
  return pages;
}

it.each([false, true])('counter uses visible area, independent of observer entry order %s', reverse => {
  const pages = geometry(50, 570, 100);
  let entries = pages.map(target => ({ target, isIntersecting: true, intersectionRatio: 0.8 }));
  if (reverse) entries = entries.reverse();
  observerCallback(entries);
  expect(viewer.currentPage).toBe(1);
  expect(document.getElementById('pdfGradedPageInput').value).toBe('1');
});

it('scroll updates a tall visible page even below the observer half-page threshold', () => {
  geometry(50, 2070, 2000);
  viewer.currentPage = 2;
  viewer.container.dispatchEvent(new Event('scroll'));
  expect(viewer.currentPage).toBe(1);
  expect(document.getElementById('pdfGradedPageInput').value).toBe('1');
});

it('scroll updates counter, slider and annotations to the most visible page', () => {
  geometry(-410, 110);
  viewer._onSliderSync = vi.fn();
  viewer._onAnnotationsPageChange = vi.fn();
  viewer.container.dispatchEvent(new Event('scroll'));
  expect(viewer.currentPage).toBe(2);
  expect(document.getElementById('pdfGradedPageInput').value).toBe('2');
  expect(viewer._onSliderSync).toHaveBeenCalledWith(viewer);
  expect(viewer._onAnnotationsPageChange).toHaveBeenCalledWith(1);
});
