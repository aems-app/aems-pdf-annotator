import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/overlay-renderer.js';

const loadOverlayRendererModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalOverlayRenderer;
};

describe('overlay-renderer', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalOverlayRenderer;
    window.PdfPreviewModalUtils = { debugLog: () => {} };
    window.PdfPreviewModalRendering = {
      TEXT_ICON_SIZE: 22,
      MIN_MARKER_SIZE: 16,
      convertTopLeftRectToViewport: (rect, viewport) => {
        const scale = Number(viewport?.scale) || 1;
        return rect.map((value) => Number(value) * scale);
      },
    };
    document.body.innerHTML = `
      <div id="pdfGradedContainer">
        <div class="pdf-page-wrapper" data-page-num="1">
          <canvas class="pdf-page-canvas"></canvas>
          <div class="pdf-annotation-overlay"></div>
        </div>
      </div>
    `;
    const canvas = document.querySelector('.pdf-page-canvas');
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 800 });
    canvas.getBoundingClientRect = () => ({ width: 600, height: 800, left: 0, top: 0, right: 600, bottom: 800 });
    window.__pdfGradedViewer = {
      getViewportForPage: vi.fn().mockReturnValue({
        width: 600,
        height: 800,
        scale: 1,
        convertToViewportRectangle: (rect) => rect,
        convertToPdfPoint: (x, y) => [x, y],
      }),
      renderedPages: new Set([1]),
      isGradedViewer: true,
      pdf: {
        getPage: vi.fn().mockResolvedValue({ view: [0, 0, 612, 792] }),
      },
    };
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      cb();
      return 1;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps AI icons and highlight quads on the PDF page through fullscreen and resize', async () => {
    await import('../src/pdf-preview-modal/rendering.js');
    const mod = await loadOverlayRendererModule();
    const canvas = document.querySelector('.pdf-page-canvas');
    const overlay = document.querySelector('.pdf-annotation-overlay');
    const modal = document.createElement('div');
    modal.id = 'pdfPreviewModal';
    modal.className = 'show';
    const container = document.getElementById('pdfGradedContainer');
    container.before(modal);
    modal.append(container);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({ 0: [
        { xref: 1, type: 'Text', rect: [40, 200, 60, 220], source: 'AI' },
        { xref: 2, type: 'Highlight', rect: [80, 200, 180, 220], quads: [[80, 200, 180, 220]], source: 'AI' },
      ] }),
    });
    // A 1366x768 modal changes its page origin independently of the overlay
    // when header/toolbar layout changes. Include a transformed ancestor too:
    // DOMRects are screen px; marker styles must remain overlay-local px.
    const layouts = [
      { top: 160, left: 50, gap: 0, factor: 1 },
      { top: 60, left: 20, gap: 30, factor: 1 },
      { top: 80, left: 35, gap: 30, factor: 0.8 },
      { top: 160, left: 50, gap: 0, factor: 1 },
    ];
    // Exercise the shell/document resize lifecycle used by the modal, rather
    // than manually forcing a marker repaint after each layout change.
    await import('../src/pdf-preview-modal/modal-shell.js');
    await import('../src/pdf-preview-modal/document-controller.js');
    window.__pdfGradedViewer.relayoutPagesForContainer = vi.fn().mockResolvedValue();
    const shell = window.PdfPreviewModalShell.createModalShell({}, {});
    const doc = window.PdfPreviewModalDocumentController.createDocumentController({}, {});
    doc.onResizeComplete(() => renderer.renderPage(1));
    shell.onFullscreenChanged(() => doc.handleResize());
    shell.onResizeNeeded(() => doc.handleResize());
    Object.defineProperty(overlay, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(overlay, 'clientHeight', { configurable: true, value: 800 });
    for (const [index, { top, left, gap, factor }] of layouts.entries()) {
      canvas.getBoundingClientRect = () => ({ left, top, width: 600 * factor, height: 800 * factor });
      overlay.getBoundingClientRect = () => ({ left, top: top - gap, width: 600 * factor, height: 800 * factor });
      // Deliberately do not force: origin changes must invalidate the cache.
      if (index === 0) renderer.renderPage(1);
      else if (index === 2) window.dispatchEvent(new Event('resize'));
      else shell.setFullscreen(index === 1);
      await vi.advanceTimersByTimeAsync(600);
      expect(modal.classList.contains('preview-fullscreen')).toBe(index === 1 || index === 2);
      const markers = [...overlay.querySelectorAll('.annotation-marker')];
      expect(markers).toHaveLength(2);
      for (const marker of markers) {
        const renderedPageY = (parseFloat(marker.style.top) * factor - gap) / factor;
        expect(renderedPageY, 'AI marker must use the live page origin, like teacher pointer coordinates').toBeCloseTo(200);
      }
      const quad = overlay.querySelector('.annotation-highlight-quad');
      const quadPageY = ((parseFloat(quad.parentElement.style.top) + parseFloat(quad.style.top)) * factor - gap) / factor;
      expect(quadPageY).toBeCloseTo(200);
    }
    expect(window.__pdfGradedViewer.relayoutPagesForContainer).toHaveBeenCalledTimes(3);
    shell.destroy();
    doc.destroy();
    renderer.destroy();
  });

  it('renders non-markup annotations and emits marker clicks', async () => {
    const mod = await loadOverlayRendererModule();
    const annotationsData = {
      0: [
        { id: 'stable-1', stable_id: 'stable-1', xref: 11, type: 'Text', rect: [10, 20, 60, 80], content: 'Visible comment', color: 'amber', source: 'AI', task_id: 'Q1', check_id: 'Q1-1', is_verdict: false },
        { id: 'drawing-1', xref: 12, type: 'drawing', rect: [10, 20, 60, 80], content: '', color: 'amber', source: 'HUMAN' },
      ],
    };
    const onMarkerClicked = vi.fn();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => annotationsData,
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: (type) => type === 'drawing' || type === 'textbox',
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });
    renderer.onMarkerClicked(onMarkerClicked);

    renderer.renderPage(1, true);
    vi.runAllTimers();

    const markers = document.querySelectorAll('.annotation-marker');
    expect(markers).toHaveLength(1);
    expect(markers[0].dataset.annotationStableId).toBe('stable-1');
    expect(markers[0].dataset.annotationTaskId).toBe('Q1');
    expect(markers[0].dataset.annotationCheckId).toBe('Q1-1');
    expect(markers[0].dataset.annotationIsVerdict).toBe('false');
    markers[0].click();
    expect(onMarkerClicked).toHaveBeenCalledWith({ pageIdx: 0, identifier: 'stable-1' });
  });

  it('scrolls to markers with quote-bearing identifiers', async () => {
    const payload = 'stable"quote';
    const mod = await loadOverlayRendererModule();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [
          { id: payload, stable_id: payload, xref: 14, type: 'Text', rect: [10, 20, 60, 80], content: 'Quoted id', color: 'amber', source: 'AI' },
        ],
      }),
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    vi.runAllTimers();
    const marker = document.querySelector('.annotation-marker');
    marker.scrollIntoView = vi.fn();

    expect(() => renderer.scrollToMarker(0, payload)).not.toThrow();
    expect(marker.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(marker.classList.contains('ownership-transferred')).toBe(true);
  });

  it('renders compact labels as single-line preview pills', async () => {
    const mod = await loadOverlayRendererModule();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [
          {
            id: 'stable-wrap',
            stable_id: 'stable-wrap',
            xref: 13,
            type: 'Text',
            rect: [10, 20, 60, 80],
            content: 'A somewhat longer preview comment',
            color: 'amber',
            source: 'AI',
          },
        ],
      }),
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    vi.runAllTimers();

    const label = document.querySelector('.annotation-label');
    expect(label).not.toBeNull();
    expect(label.style.whiteSpace).toBe('nowrap');
    expect(label.style.maxWidth).toBe('180px');
  });

  it('uses top-left annotation rectangles without vertically flipping marker placement', async () => {
    window.__pdfGradedViewer.getViewportForPage = vi.fn().mockReturnValue({
      width: 600,
      height: 800,
      scale: 1,
      // Simulate PDF.js bottom-left conversion. The renderer must ignore this.
      convertToViewportRectangle: (rect) => [rect[0], 800 - rect[1], rect[2], 800 - rect[3]],
      convertToPdfPoint: (x, y) => [x, y],
    });

    const mod = await loadOverlayRendererModule();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [
          {
            id: 'stable-top-left',
            stable_id: 'stable-top-left',
            xref: 42,
            type: 'Text',
            rect: [30, 120, 70, 160],
            content: 'Top-left rect',
            color: 'green',
            source: 'AI',
          },
        ],
      }),
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    vi.runAllTimers();

    const marker = document.querySelector('.annotation-marker');
    expect(marker).not.toBeNull();
    expect(marker.style.top).toBe('120px');
    expect(marker.style.left).toBe('30px');
  });

  it('repositions existing markers after zoom changes even when the xref set is unchanged', async () => {
    const mod = await loadOverlayRendererModule();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [
          {
            id: 'stable-zoom',
            stable_id: 'stable-zoom',
            xref: 77,
            type: 'Text',
            rect: [30, 120, 70, 160],
            content: 'Zoom-sensitive rect',
            color: 'green',
            source: 'AI',
          },
        ],
      }),
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    vi.runAllTimers();

    const canvas = document.querySelector('.pdf-page-canvas');
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 400 });
    canvas.getBoundingClientRect = () => ({ width: 300, height: 400, left: 0, top: 0, right: 300, bottom: 400 });
    window.__pdfGradedViewer.getViewportForPage = vi.fn().mockReturnValue({
      width: 300,
      height: 400,
      scale: 0.5,
      convertToViewportRectangle: (rect) => rect.map((value) => Number(value) * 0.5),
      convertToPdfPoint: (x, y) => [x, y],
    });

    renderer.renderPage(1, false);
    vi.runAllTimers();

    const marker = document.querySelector('.annotation-marker');
    expect(marker).not.toBeNull();
    expect(marker.style.left).toBe('15px');
    expect(marker.style.top).toBe('60px');
  });

  it('unobserves old markers before a forced overlay rebuild detaches them', async () => {
    const mod = await loadOverlayRendererModule();
    const observeAnnotationMarker = vi.fn();
    const unobserveAnnotationMarker = vi.fn();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [{
          id: 'stable-observed',
          stable_id: 'stable-observed',
          xref: 81,
          type: 'Highlight',
          rect: [30, 120, 70, 160],
          quads: [[30, 120, 70, 160]],
          content: 'Observed highlight',
          color: 'green',
          source: 'AI',
        }],
      }),
      getSelectedAnnotation: () => ({ pageIdx: null, identifier: null }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker,
        unobserveAnnotationMarker,
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    const oldMarker = document.querySelector('.annotation-marker');
    expect(observeAnnotationMarker).toHaveBeenCalledWith(oldMarker);

    renderer.renderPage(1, true);

    expect(unobserveAnnotationMarker).toHaveBeenCalledTimes(1);
    expect(unobserveAnnotationMarker).toHaveBeenCalledWith(oldMarker);
    expect(oldMarker.isConnected).toBe(false);
    expect(document.querySelector('.annotation-marker')).not.toBe(oldMarker);
  });

  it('cleans overlay DOM and handlers on destroy', async () => {
    const mod = await loadOverlayRendererModule();
    const renderer = mod.createOverlayRenderer({
      getAnnotationsData: () => ({
        0: [{ id: 'stable-2', stable_id: 'stable-2', xref: 22, type: 'Text', rect: [10, 20, 60, 80], content: 'Selected', color: 'red', source: 'HUMAN' }],
      }),
      getSelectedAnnotation: () => ({ pageIdx: 0, identifier: 'stable-2' }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value || '',
        resolveAnnotationIdParts: ({ xref, identifier }) => ({ xref, stableId: identifier }),
        resolveAnnotationIdentifierValue: (ann) => ann.id || ann.stable_id || '',
        deriveAnnotationPriority: (ann) => ann.color || 'amber',
        resolveAnnotationSource: (ann) => ann.source || 'AI',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: (label, number, text) => {
          label.textContent = number + ' ' + text;
        },
        positionLabelOptimally: () => {},
        repositionAllLabels: () => {},
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => ({}),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
      capabilities: { annotationCrud: true },
    });

    renderer.renderPage(1, true);
    expect(document.querySelectorAll('.annotation-marker')).toHaveLength(1);

    renderer.destroy();

    expect(document.querySelectorAll('.annotation-marker')).toHaveLength(0);
    expect(document.querySelector('.pdf-annotation-overlay').innerHTML).toBe('');
  });
});
