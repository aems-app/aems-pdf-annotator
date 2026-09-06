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

  it('reflows geometry IMMEDIATELY, never waiting on ink', async () => {
    // This test used to assert the opposite, and that was the reverted arbiter
    // rebuilt by hand: relayoutPagesForContainer() IS the geometry, and deferring
    // it while the CSS box has already moved is exactly what made the earlier
    // attempt land a stroke 3.4x further out. Waiting became possible only when
    // the host predicate widened from "pointer is down" to "pointer is down OR a
    // save is pending", so a FINISHED stroke could hold the layout hostage.
    //
    // Only the destructive markup/reload half may wait. Geometry never does.
    vi.useFakeTimers();
    try {
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {
        isDrawingFn: () => true,             // never becomes safe
      });

      controller.handleResize();
      await vi.advanceTimersByTimeAsync(500);

      expect(
        window.__pdfGradedViewer.relayoutPagesForContainer,
        'geometry was deferred behind ink -- this is the reverted arbiter',
      ).toHaveBeenCalled();
      expect(window.__pdfGradedViewer.reRenderAllPages).not.toHaveBeenCalled();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting before emitting resize-complete if a save never settles', async () => {
    vi.useFakeTimers();
    try {
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {
        isDrawingFn: () => true,
      });
      const seen = [];
      controller.onResizeComplete(() => seen.push(1));
      window.PdfPreviewModalViewer = {
        PDFViewer: function FakeOriginalViewer() {},
        resolvePdfjsLib: () => ({}),
      };
      controller.ensureViewers();
      expect(typeof gradedResizeCompleteHandler).toBe('function');

      gradedResizeCompleteHandler();
      await vi.advanceTimersByTimeAsync(2000);
      expect(seen, 'gave up so fast it is not a guard').toEqual([]);

      await vi.advanceTimersByTimeAsync(20000);
      expect(seen, 'markers never reposition again after a resize').toEqual([1]);
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never disarms an already-armed document-replace guard', async () => {
    // The guard is what stands between a document swap and an unsaved stroke.
    // A controller created WITHOUT beforeDocumentReplaceFn used to re-register
    // `undefined` over it, silently disarming it for the rest of the session.
    const armed = vi.fn();
    window.__pdfGradedViewer.beforeDocumentReplace = vi.fn();
    const controllerModule = await loadDocumentControllerModule();

    const withGuard = controllerModule.createDocumentController({}, {
      beforeDocumentReplaceFn: armed,
    });
    window.PdfPreviewModalViewer = {
      PDFViewer: function FakeOriginalViewer() {},
      resolvePdfjsLib: () => ({}),
    };
    withGuard.ensureViewers();
    expect(window.__pdfGradedViewer.beforeDocumentReplace).toHaveBeenCalledWith(armed);
    withGuard.destroy();

    window.__pdfGradedViewer.beforeDocumentReplace.mockClear();
    const withoutGuard = controllerModule.createDocumentController({}, {});
    withoutGuard.ensureViewers();

    expect(
      window.__pdfGradedViewer.beforeDocumentReplace,
      'a controller with no guard overwrote the armed one',
    ).not.toHaveBeenCalled();
    withoutGuard.destroy();
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

  it('reflows during a stroke but holds the markup refresh until it ends', async () => {
    // I wrote this test asserting the reflow was DEFERRED while drawing, and
    // that was wrong: relayoutPagesForContainer() is the geometry, and the
    // reverted attempt at #472 failed precisely by holding geometry back while
    // the CSS box moved. The correct split is geometry now, destructive markup
    // later -- the reflow only writes CSS boxes and never replaces the overlay,
    // so there is nothing about it to defer.
    vi.useFakeTimers();
    try {
      let drawing = true;
      const controllerModule = await loadDocumentControllerModule();
      const controller = controllerModule.createDocumentController({}, {
        isDrawingFn: () => drawing,
      });
      const seen = [];
      controller.onResizeComplete(() => seen.push(1));

      controller.handleResize();
      await vi.advanceTimersByTimeAsync(400);
      expect(
        window.__pdfGradedViewer.relayoutPagesForContainer,
        'geometry waited on ink',
      ).toHaveBeenCalledTimes(1);
      expect(seen, 'the destructive markup refresh ran mid-stroke').toEqual([]);

      drawing = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(seen, 'the markup refresh never arrived after the stroke ended')
        .not.toEqual([]);
      expect(window.__pdfGradedViewer.reRenderAllPages).not.toHaveBeenCalled();
      controller.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
