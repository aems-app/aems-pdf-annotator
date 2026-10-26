import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let viewers = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="pdfPreviewModal"><span id="pdfPreviewStudent"></span>
    <div id="pdfOriginalTabContainer"></div><div id="pdfGradedTabContainer"></div>
    <button id="pdfOriginalTab"></button><button id="pdfGradedTab"></button>
    <div id="pdfOriginalPane" class="active show"><div id="pdfOriginalContainer"></div></div>
    <div id="pdfGradedPane"><div id="pdfGradedContainer"><div id="pdfGradedLoading"></div></div></div>
    <div id="pdfAnnotationsMissingBanner" class="d-none"></div></div>`;
  Object.defineProperty(document.getElementById('pdfGradedContainer'), 'clientWidth', { value: 800 });
  window.PdfPreviewModalUtils = { debugLog() {} };
  window.pdfjsLib = { getDocument: vi.fn() };
  window.bootstrap = { Modal: class {
    constructor(el) { this.el = el; }
    show() { this.el.dispatchEvent(new Event('shown.bs.modal')); }
    static getInstance() { return null; }
  } };
  URL.createObjectURL = vi.fn(() => 'blob:pdf');
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
});

afterEach(() => {
  viewers.forEach((v) => v.destroy());
  viewers = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ['PdfPreviewModal', 'PdfPreviewModalViewer', 'PdfPreviewModalDocumentController',
    'PdfPreviewModalStateCore', 'PdfPreviewModalAnnotationController', '__pdfGradedViewer', '__pdfOriginalViewer', 'pdfjsLib', 'bootstrap']) delete window[key];
});

async function viewerHarness() {
  await import('../src/pdf-preview-modal/pdf-viewer.js');
  const viewer = new window.PdfPreviewModalViewer.PDFViewer('canvas', 'pdfGradedContainer', 'pdfGradedLoading', 'pdfGradedControls');
  viewers.push(viewer);
  vi.spyOn(viewer, 'renderSkeleton').mockImplementation(async () => {
    viewer.container.innerHTML = `<canvas data-document="${viewer.pdf.name}"></canvas><div class="textLayer"></div>`;
  });
  vi.spyOn(viewer, 'renderSpecificPage').mockResolvedValue();
  return viewer;
}

describe('viewer document ownership', () => {
  it.each(['clear', 'destroy'])('discards and destroys a PDF resolving after %s', async (action) => {
    const viewer = await viewerHarness();
    const pending = deferred();
    const pdf = { numPages: 1, destroy: vi.fn() };
    window.pdfjsLib.getDocument.mockReturnValue({ promise: pending.promise });
    const loading = viewer.loadPDF('/old');
    if (action === 'clear') viewer.clearPDF();
    else viewer.destroy();
    pending.resolve(pdf);
    await loading;
    expect(viewer.pdf).toBeNull();
    expect(pdf.destroy).toHaveBeenCalledOnce();
    expect(viewer.container.querySelector('canvas, .alert-danger')).toBeNull();
  });

  it('discards a load superseded while waiting for document replacement permission', async () => {
    const viewer = await viewerHarness();
    const pending = deferred();
    viewer.beforeDocumentReplace(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue());
    const pdf = { name: 'second', numPages: 1, destroy() {} };
    window.pdfjsLib.getDocument.mockReturnValue({ promise: Promise.resolve(pdf) });
    const loading = viewer.loadPDF('/first');
    await viewer.loadPDF('/second');
    pending.resolve();
    await loading;
    expect(window.pdfjsLib.getDocument).toHaveBeenCalledTimes(1);
    expect(viewer.pdf).toBe(pdf);
  });

  it('does not rebuild pages from a superseded skeleton getPage await', async () => {
    const viewer = await viewerHarness();
    viewer.renderSkeleton.mockRestore();
    const pending = deferred();
    const page = { getViewport: () => ({ width: 600, height: 800 }) };
    window.pdfjsLib.getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 3, getPage: () => pending.promise, destroy() {} }) })
      .mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1, getPage: async () => page, destroy() {} }) });
    const loading = viewer.loadPDF('/first');
    await flush();
    await viewer.loadPDF('/second');
    const currentCanvas = viewer.container.querySelector('canvas');
    pending.resolve(page);
    await loading;
    expect(viewer.container.querySelector('canvas'), 'old skeleton replaced the current canvas').toBe(currentCanvas);
  });

  it.each(['getPage', 'render'])('renders the second single-page PDF while the first awaits %s', async (phase) => {
    const viewer = await viewerHarness();
    viewer.useSinglePageMode = true;
    viewer.canvas = document.createElement('canvas');
    viewer.container.appendChild(viewer.canvas);
    viewer.canvas.getContext = vi.fn(() => ({}));
    const pending = deferred();
    const cancel = vi.fn();
    const oldPage = { getViewport: () => ({ width: 111, height: 111 }), render: vi.fn(() => ({ promise: pending.promise, cancel })) };
    const page = { getViewport: () => ({ width: 222, height: 222 }), render: vi.fn(() => ({ promise: Promise.resolve() })) };
    window.pdfjsLib.getDocument.mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1, getPage: () => phase === 'getPage' ? pending.promise : Promise.resolve(oldPage), destroy() {} }) })
      .mockReturnValueOnce({ promise: Promise.resolve({ numPages: 1, getPage: async () => page, destroy() {} }) });
    const loading = viewer.loadPDF('/first');
    await flush();
    await viewer.loadPDF('/second');
    pending.resolve(oldPage);
    await loading;
    expect(page.render, 'the current PDF was skipped because the old render held isRendering').toHaveBeenCalledOnce();
    if (phase === 'getPage') expect(oldPage.render).not.toHaveBeenCalled();
    else expect(cancel).toHaveBeenCalledOnce();
    expect(viewer.currentPageObj).toBe(page);
    expect(viewer.isRendering).toBe(false);
  });

  it('keeps the second document when the first PDF.js load resolves last', async () => {
    const viewer = await viewerHarness();
    const first = deferred();
    const second = { name: 'second', numPages: 1, destroy: vi.fn() };
    const old = { name: 'first', numPages: 1, destroy: vi.fn() };
    window.pdfjsLib.getDocument.mockReturnValueOnce({ promise: first.promise }).mockReturnValueOnce({ promise: Promise.resolve(second) });
    const loading = viewer.loadPDF('/first');
    await viewer.loadPDF('/second');
    first.resolve(old);
    await loading;
    expect(viewer.pdf, 'the late first document replaced the current document').toBe(second);
    expect(viewer.container.querySelector('canvas').dataset.document).toBe('second');
    expect(old.destroy).toHaveBeenCalledOnce();
  });

  it('does not display a late error from a superseded load', async () => {
    const viewer = await viewerHarness();
    const first = deferred();
    window.pdfjsLib.getDocument.mockReturnValueOnce({ promise: first.promise }).mockReturnValueOnce({ promise: Promise.resolve({ name: 'second', numPages: 1, destroy() {} }) });
    const loading = viewer.loadPDF('/first');
    await viewer.loadPDF('/second');
    first.reject(new Error('network error'));
    await loading;
    expect(viewer.container.querySelector('.alert-danger'), 'a stale error replaced the current PDF').toBeNull();
  });
});

async function modalHarness(withController) {
  const viewer = await viewerHarness();
  window.__pdfGradedViewer = viewer;
  window.__pdfOriginalViewer = { loadPDF: vi.fn().mockResolvedValue(), renderPage: vi.fn() };
  await import('../src/pdf-preview-modal/modal-state.js');
  await import('../src/pdf-preview-modal/annotation-controller.js');
  if (withController) await import('../src/pdf-preview-modal/document-controller.js');
  await import('../src/pdf-preview-modal.js');
  const open = async (id, fetchAnnotatedPdf) => {
    const modal = window.PdfPreviewModal.createPdfPreviewModal({
      submissionId: id, assignmentId: 10, studentName: `Student ${id}`, mode: 'offline',
      modeAdapter: { fetchAnnotatedPdf, listAnnotations: async () => ({ success: true, annotations: {} }) },
    });
    await modal.open();
    await flush();
    await vi.advanceTimersByTimeAsync(60);
    return modal;
  };
  return { viewer, open, banner: document.getElementById('pdfAnnotationsMissingBanner') };
}

describe.each([true, false])('modal loading (document controller: %s)', (withController) => {
  it.each([404, 500])('classifies a direct HTTP %s response without an adapter fetch', async (status) => {
    const h = await modalHarness(withController);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
    await h.open(1, undefined);
    expect(h.banner.classList.contains('d-none')).toBe(status !== 404);
    expect(!!h.viewer.container.querySelector('.alert-danger')).toBe(status !== 404);
  });

  it('removes the previous PDF and text layer before fetching another student', async () => {
    const h = await modalHarness(withController);
    window.pdfjsLib.getDocument.mockReturnValue({ promise: Promise.resolve({ name: 'first', numPages: 1, destroy: vi.fn() }) });
    await h.open(1, async () => new Blob(['pdf']));
    expect(h.viewer.container.querySelector('canvas')).not.toBeNull();
    const pending = deferred();
    const fetchNext = vi.fn(() => {
      expect(h.viewer.pdf, 'previous student document still present when the new fetch starts').toBeNull();
      expect(h.viewer.container.querySelector('canvas, .textLayer'), 'previous student pages still visible').toBeNull();
      return pending.promise;
    });
    await h.open(2, fetchNext);
    expect(fetchNext).toHaveBeenCalledOnce();
    // Also assert outside the event handler, whose catch displays errors.
    expect(h.viewer.pdf).toBeNull();
    expect(h.viewer.container.querySelector('canvas, .textLayer')).toBeNull();
    pending.resolve(null);
    await flush();
  });

  it.each([
    ['404 error', () => Promise.reject(Object.assign(new Error('missing'), { status: 404 })), true],
    ['synchronous 404', () => { throw Object.assign(new Error('missing'), { status: 404 }); }, true],
    ['not-found result', async () => ({ notFound: true }), true],
    ['500', () => Promise.reject(Object.assign(new Error('server failure'), { status: 500 })), false],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch')), false],
    ['timeout', () => Promise.reject(new Error('request timed out')), false],
    ['cancelled result', async () => null, false],
    ['aborted fetch', () => Promise.reject(new DOMException('aborted', 'AbortError')), false],
  ])('claims missing annotations only for definitive absence: %s', async (name, fetchPdf, missing) => {
    const h = await modalHarness(withController);
    // An unexpected server fallback must not conceal the host result.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchSpy);
    await h.open(1, fetchPdf);
    expect(h.banner.classList.contains('d-none'), `${name} incorrectly classified as deleted`).toBe(!missing);
    const isFailure = ['500', 'network error', 'timeout'].includes(name);
    expect(!!h.viewer.container.querySelector('.alert-danger'), `${name} generic error state`).toBe(isFailure);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores a superseded fetch even when it later reports 404', async () => {
    const h = await modalHarness(withController);
    const first = deferred();
    await h.open(1, () => first.promise);
    window.pdfjsLib.getDocument.mockReturnValue({ promise: Promise.resolve({ name: 'second', numPages: 1, destroy() {} }) });
    await h.open(2, async () => new Blob(['pdf']));
    first.reject(Object.assign(new Error('missing'), { status: 404 }));
    await flush();
    expect(h.banner.classList.contains('d-none')).toBe(true);
    expect(h.viewer.container.querySelector('canvas').dataset.document).toBe('second');
    expect(h.viewer.container.querySelector('.alert-danger')).toBeNull();
  });
});
