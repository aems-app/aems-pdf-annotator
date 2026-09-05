import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/document-controller.js';

const loadDocumentControllerModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalDocumentController;
};

describe('document-controller adapter routing', () => {
  let gradedPageChangeHandler;
  let gradedResizeCompleteHandler;
let gradedPageRenderedHandler;

  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalDocumentController;
    window.PdfPreviewModalUtils = { debugLog: () => {} };
    document.body.innerHTML = '';

    window.__pdfOriginalViewer = {
      pdf: { numPages: 2 },
      loadPDF: vi.fn().mockResolvedValue(undefined),
      renderPage: vi.fn(),
    };
    window.__pdfGradedViewer = {
      pdf: { numPages: 3 },
      currentPage: 1,
      loadPDF: vi.fn().mockResolvedValue(undefined),
      renderPage: vi.fn(),
      reRenderAllPages: vi.fn().mockResolvedValue(undefined),
      relayoutPagesForContainer: vi.fn().mockResolvedValue(undefined),
      onAnnotationsPageChange: vi.fn((cb) => { gradedPageChangeHandler = cb; }),
      onPageRendered: vi.fn((cb) => { gradedPageRenderedHandler = cb; }),
      onSliderSync: vi.fn(),
      onResizeComplete: vi.fn((cb) => { gradedResizeCompleteHandler = cb; }),
    };

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue('blob:test-url'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the original PDF through modeAdapter when available', async () => {
    const controllerModule = await loadDocumentControllerModule();
    const state = {};
    const adapter = {
      fetchOriginalPdf: vi.fn().mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' })),
    };
    const controller = controllerModule.createDocumentController(
      state,
      {
        modeAdapter: adapter,
        assignmentId: 501,
        submissionId: 1001,
        mode: 'local',
        capabilities: {},
      },
    );

    await controller.loadOriginalPdf(501, 1001);

    expect(adapter.fetchOriginalPdf).toHaveBeenCalledWith(501, 1001);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(window.__pdfOriginalViewer.loadPDF).toHaveBeenCalledWith('blob:test-url');
    expect(state.originalPdfLoaded).toBe(true);
    expect(state.pageCount).toBe(2);
  });

  it('loads the graded PDF through modeAdapter with course/offline context', async () => {
    const controllerModule = await loadDocumentControllerModule();
    const state = {};
    const adapter = {
      fetchAnnotatedPdf: vi.fn().mockResolvedValue(new Blob(['graded'], { type: 'application/pdf' })),
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const controller = controllerModule.createDocumentController(
      state,
      {
        modeAdapter: adapter,
        assignmentId: 501,
        submissionId: 1001,
        courseId: 101,
        mode: 'offline',
        capabilities: {},
      },
    );

    await controller.loadGradedPdf(501, 1001);

    expect(adapter.fetchAnnotatedPdf).toHaveBeenCalledWith(
      501,
      1001,
      { courseId: 101, offline: true, annotatedPdfPolicy: 'server_allowed' },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.__pdfGradedViewer.loadPDF).toHaveBeenCalledWith('blob:test-url');
    expect(state.gradedPdfLoaded).toBe(true);
    expect(state.currentPage).toBe(0);
    expect(state.pageCount).toBe(3);
  });

  it('passes through annotatedPdfPolicy when provided', async () => {
    const controllerModule = await loadDocumentControllerModule();
    const adapter = {
      fetchAnnotatedPdf: vi.fn().mockResolvedValue(new Blob(['graded'], { type: 'application/pdf' })),
    };
    const controller = controllerModule.createDocumentController(
      {},
      {
        modeAdapter: adapter,
        assignmentId: 501,
        submissionId: 1001,
        courseId: 101,
        mode: 'local',
        annotatedPdfPolicy: 'local_required',
        capabilities: {},
      },
    );

    await controller.loadGradedPdf(501, 1001);

    expect(adapter.fetchAnnotatedPdf).toHaveBeenCalledWith(
      501,
      1001,
      { courseId: 101, offline: false, annotatedPdfPolicy: 'local_required' },
    );
  });

  it('tracks current page in document state when navigating directly', async () => {
    const controllerModule = await loadDocumentControllerModule();
    const state = {};
    const controller = controllerModule.createDocumentController(
      state,
      {
        modeAdapter: null,
        assignmentId: 501,
        submissionId: 1001,
        mode: 'server',
        capabilities: {},
      },
    );

    controller.goToPage(3);

    expect(state.currentPage).toBe(2);
  });

  it('navigates when the graded page input dispatches a change event', async () => {
    document.body.innerHTML = '<input id="pdfGradedPageInput" value="1">';

    const controllerModule = await loadDocumentControllerModule();
    const controller = controllerModule.createDocumentController(
      {},
      {
        modeAdapter: null,
        assignmentId: 501,
        submissionId: 1001,
        mode: 'server',
        capabilities: {},
      },
    );

    const pageInput = document.getElementById('pdfGradedPageInput');
    pageInput.value = '3';
    pageInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(window.__pdfGradedViewer.renderPage).toHaveBeenLastCalledWith(3);
    expect(pageInput.value).toBe('3');

    controller.destroy();
  });

  it('falls back to the server graded PDF URL when no adapter exists', async () => {
    const controllerModule = await loadDocumentControllerModule();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(new Blob(['graded'], { type: 'application/pdf' })),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const controller = controllerModule.createDocumentController(
      {},
      {
        assignmentId: 501,
        submissionId: 1001,
        mode: 'server',
        capabilities: {},
      },
    );

    await controller.loadGradedPdf(501, 1001);

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/canvas/submissions/1001/pdf-graded?assignment_id=501',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('coalesces duplicate fullscreen resize requests into one non-destructive reflow', async () => {
    vi.useFakeTimers();
    try {
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {});

      controller.handleResize();
      controller.handleResize();
      await vi.advanceTimersByTimeAsync(400);

      // The fullscreen path must not rebuild: reRenderAllPages(false) still
      // reached renderSkeleton()'s `container.innerHTML = ''` for any width
      // delta >= 2px, destroying the drawing overlay (#472).
      expect(window.__pdfGradedViewer.relayoutPagesForContainer).toHaveBeenCalledTimes(1);
      expect(window.__pdfGradedViewer.reRenderAllPages).not.toHaveBeenCalled();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds the resize-complete event while a stroke is in progress', async () => {
    // The event's consumers end in refreshMarkupFromAnnotations(), which does an
    // unconditional DrawingCanvas pageStrokes.clear() and repaints only from
    // annotationsData -- so firing it mid-stroke, or before a finished stroke's
    // create-POST resolves, erases the ink the reflow exists to protect. The
    // fullscreen path already deferred for this reason; the viewer-level
    // callback added for the reflow must too.
    vi.useFakeTimers();
    try {
      let drawing = true;
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {
        isDrawingFn: () => drawing,
      });
      const seen = [];
      controller.onResizeComplete(() => seen.push(1));
      // ensureModalViewers() is the only place the viewer callbacks are wired,
      // and it bails without a viewer module, so provide the minimum it needs.
      window.PdfPreviewModalViewer = {
        PDFViewer: function FakeOriginalViewer() {},
        resolvePdfjsLib: () => ({}),
      };
      controller.ensureViewers();          // wires the viewer callbacks
      expect(typeof gradedResizeCompleteHandler).toBe('function');

      gradedResizeCompleteHandler();
      await vi.advanceTimersByTimeAsync(200);
      expect(seen, 'fired while the pointer was still down').toEqual([]);

      drawing = false;
      await vi.advanceTimersByTimeAsync(60);
      expect(seen).toEqual([1]);
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers the fullscreen reflow until an active drawing stroke finishes', async () => {
    vi.useFakeTimers();
    try {
      let drawing = true;
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {
        isDrawingFn: () => drawing,
      });

      controller.handleResize();
      await vi.advanceTimersByTimeAsync(400);
      expect(window.__pdfGradedViewer.relayoutPagesForContainer).not.toHaveBeenCalled();

      drawing = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(window.__pdfGradedViewer.relayoutPagesForContainer).toHaveBeenCalledTimes(1);
      expect(window.__pdfGradedViewer.reRenderAllPages).not.toHaveBeenCalled();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
