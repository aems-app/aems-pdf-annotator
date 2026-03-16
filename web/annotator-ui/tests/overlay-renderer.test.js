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
    window.PdfPreviewModalRendering = { TEXT_ICON_SIZE: 22, MIN_MARKER_SIZE: 16 };
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

  it('renders non-markup annotations and emits marker clicks', async () => {
    const mod = await loadOverlayRendererModule();
    const annotationsData = {
      0: [
        { id: 'stable-1', stable_id: 'stable-1', xref: 11, type: 'Text', rect: [10, 20, 60, 80], content: 'Visible comment', color: 'amber', source: 'AI' },
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
    markers[0].click();
    expect(onMarkerClicked).toHaveBeenCalledWith({ pageIdx: 0, identifier: 'stable-1' });
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
