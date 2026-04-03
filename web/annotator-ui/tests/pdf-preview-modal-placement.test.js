import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal.js';

const loadPlacementHelpers = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModal.__test;
};

function createMarker({
  taskId = '',
  checkId = '',
  labelText = '',
  fullText = '',
  page = '0',
} = {}) {
  const marker = document.createElement('div');
  marker.className = 'annotation-marker';
  marker.dataset.annotationTaskId = taskId;
  marker.dataset.annotationCheckId = checkId;
  marker.dataset.annotationPage = String(page);

  const label = document.createElement('div');
  label.className = 'annotation-label';
  if (fullText) {
    label.dataset.fullText = fullText;
  }
  label.textContent = labelText || fullText;
  marker.appendChild(label);
  document.body.appendChild(marker);

  return { marker, label };
}

async function loadOverlayRendererModule() {
  await import('../src/pdf-preview-modal/overlay-renderer.js');
  return window.PdfPreviewModalOverlayRenderer;
}

function createPlacementEntry({
  taskGroupKey = '',
  checkId = '',
  top,
  left = 0,
  height = 12,
  width = 120,
  baseTop = top,
  baseBottom,
  page = '0',
} = {}) {
  const { marker, label } = createMarker({ checkId, page });
  const bottom = top + height;
  return {
    label,
    marker,
    taskGroupKey,
    markerRect: {
      top,
      left,
      height,
      width,
      right: left + width,
      bottom,
    },
    baseRect: {
      top: baseTop,
      left,
      width,
      height,
      right: left + width,
      bottom: baseBottom ?? (baseTop + height),
    },
  };
}

function sumTranslateOffsets(transform) {
  const translatePattern = /translate\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\s*\)/g;
  let match;
  let x = 0;
  let y = 0;
  while ((match = translatePattern.exec(String(transform || ''))) !== null) {
    x += Number.parseFloat(match[1]) || 0;
    y += Number.parseFloat(match[2]) || 0;
  }
  return { x, y };
}

describe('pdf-preview-modal placement helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.AEMSPdfAnnotator;
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalUtils;
    delete window.PdfPreviewModalStateCore;
    delete window.PdfPreviewModalViewer;
    delete window.PDFViewer;
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div>
      <div id="pdfOriginalPane"></div>
      <div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button>
      <button id="pdfGradedTab"></button>
      <button id="pdfPreviewFullscreenToggle"></button>
      <button id="pdfPreviewSplitPanelToggle"></button>
      <button class="js-toggle-markup"></button>
      <div id="pdfGradedCommentsList"></div>
      <div id="pdfGradedAICommentsList"></div>
      <div id="pdfModelACommentsList"></div>
      <div id="pdfModelBCommentsList"></div>
      <div id="pdfGradedContainer"></div>
      <div id="pdfOriginalContainer"></div>
    `;
    window.bootstrap = {
      Modal: {
        getInstance: () => null,
      },
    };
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('derives the task group key from task id, check id, or label text', async () => {
    const { deriveMarkerTaskGroupKey } = await loadPlacementHelpers();

    const direct = createMarker({
      taskId: 'Q2',
      checkId: 'Q9-1',
      labelText: 'Q7: ignored',
    }).marker;
    const fromCheck = createMarker({
      checkId: 'q4-3_SUMMARY',
    }).marker;
    const fromLabel = createMarker({
      labelText: 'q6: final answer',
    }).marker;

    expect(deriveMarkerTaskGroupKey(direct)).toBe('Q2');
    expect(deriveMarkerTaskGroupKey(fromCheck)).toBe('Q4');
    expect(deriveMarkerTaskGroupKey(fromLabel)).toBe('Q6');
  });

  it('detects summary placement entries from the marker check id', async () => {
    const { isSummaryPlacementEntry } = await loadPlacementHelpers();
    const summaryEntry = createPlacementEntry({
      checkId: 'Q3_SUMMARY',
      top: 40,
    });
    const normalEntry = createPlacementEntry({
      checkId: 'Q3-2',
      top: 60,
    });

    expect(isSummaryPlacementEntry(summaryEntry)).toBe(true);
    expect(isSummaryPlacementEntry(normalEntry)).toBe(false);
  });

  it('sorts summaries last and otherwise orders entries by top then left', async () => {
    const { compareTaskPlacementEntries } = await loadPlacementHelpers();
    const entries = [
      createPlacementEntry({
        checkId: 'Q5_SUMMARY',
        top: 20,
        left: 0,
      }),
      createPlacementEntry({
        checkId: 'Q5-2',
        top: 100,
        left: 60,
      }),
      createPlacementEntry({
        checkId: 'Q5-1',
        top: 100.5,
        left: 20,
      }),
    ];

    const orderedCheckIds = entries
      .slice()
      .sort(compareTaskPlacementEntries)
      .map((entry) => entry.marker.dataset.annotationCheckId);

    expect(orderedCheckIds).toEqual(['Q5-1', 'Q5-2', 'Q5_SUMMARY']);
  });

  it('builds non-overlapping placement bands between adjacent task groups', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 400 };
    const q1 = createPlacementEntry({
      taskGroupKey: 'Q1',
      top: 40,
      baseTop: 30,
      baseBottom: 60,
    });
    const q2 = createPlacementEntry({
      taskGroupKey: 'Q2',
      top: 140,
      baseTop: 130,
      baseBottom: 160,
    });

    const bands = buildTaskPlacementBands([q1, q2], pageBounds, 8);

    expect(bands.get('Q1')).toEqual({
      left: 0,
      right: 300,
      top: 0,
      bottom: 87,
    });
    expect(bands.get('Q2')).toEqual({
      left: 0,
      right: 300,
      top: 103,
      bottom: 400,
    });
    expect(bands.get('Q1').bottom).toBeLessThan(bands.get('Q2').top);
  });

  it('falls back to midpoint-only bands when seam padding would collapse a middle group', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 300 };
    const entries = [
      createPlacementEntry({
        taskGroupKey: 'Q1',
        top: 90,
        baseTop: 80,
        baseBottom: 100,
      }),
      createPlacementEntry({
        taskGroupKey: 'Q2',
        top: 104,
        baseTop: 104,
        baseBottom: 108,
      }),
      createPlacementEntry({
        taskGroupKey: 'Q3',
        top: 112,
        baseTop: 112,
        baseBottom: 120,
      }),
    ];

    const bands = buildTaskPlacementBands(entries, pageBounds, 8);

    expect(bands.get('Q2')).toEqual({
      left: 0,
      right: 300,
      top: 103,
      bottom: 114,
    });
  });

  it('assigns an ungrouped entry to a page fallback band when no task anchors exist', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 300 };
    const entry = createPlacementEntry({
      top: 24,
      baseTop: 18,
      baseBottom: 42,
      page: '7',
    });

    const bands = buildTaskPlacementBands([entry], pageBounds, 6);

    expect(entry.taskGroupKey).toBe('page-7');
    expect(bands.get('page-7')).toEqual({
      left: 0,
      right: 300,
      top: 0,
      bottom: 300,
    });
  });

  it('ignores inline blur cleanup for detached rerendered editors', async () => {
    const { shouldIgnoreDetachedInlineBlur } = await loadPlacementHelpers();
    const { label } = createMarker({ labelText: 'Placeholder' });
    const textarea = document.createElement('textarea');
    label.appendChild(textarea);

    expect(shouldIgnoreDetachedInlineBlur(textarea, label)).toBe(false);

    textarea.remove();
    expect(shouldIgnoreDetachedInlineBlur(textarea, label)).toBe(true);
  });

  it('restores the compact label anchor after hover expansion collapses', async () => {
    const {
      collapseInlineLabel,
      expandInlineLabelReadOnly,
      positionLabelOptimally,
      renderCompactInlineLabelContent,
    } = await loadPlacementHelpers();

    const container = document.getElementById('pdfGradedContainer');
    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 640,
      width: 480,
      height: 640,
    });

    const overlay = document.createElement('div');
    overlay.className = 'pdf-annotation-overlay';
    overlay.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 640,
      width: 480,
      height: 640,
    });
    container.appendChild(overlay);

    const marker = document.createElement('div');
    marker.className = 'annotation-marker';
    marker.dataset.annotationPage = '0';
    marker.getBoundingClientRect = () => ({
      left: 182,
      top: 166,
      right: 204,
      bottom: 188,
      width: 22,
      height: 22,
    });

    const markerBelow = document.createElement('div');
    markerBelow.className = 'annotation-marker';
    markerBelow.getBoundingClientRect = () => ({
      left: 194,
      top: 214,
      right: 216,
      bottom: 236,
      width: 22,
      height: 22,
    });

    const label = document.createElement('div');
    label.className = 'annotation-label';
    label.dataset.fullText = 'Identify the correct stress tensor and explain the strain relation.';
    label.style.position = 'absolute';
    label.style.maxWidth = '180px';
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'visible';
    label.style.transform = 'translate(2px, 2px)';

    Object.defineProperty(label, 'offsetWidth', {
      configurable: true,
      get() {
        return label.classList.contains('label-expanded') ? 216 : 88;
      },
    });
    Object.defineProperty(label, 'offsetHeight', {
      configurable: true,
      get() {
        return label.classList.contains('label-expanded') ? 88 : 24;
      },
    });

    label.getBoundingClientRect = () => {
      const markerRect = marker.getBoundingClientRect();
      const { x, y } = sumTranslateOffsets(label.style.transform);
      const width = label.offsetWidth;
      const height = label.offsetHeight;
      return {
        left: markerRect.left + x,
        top: markerRect.top + y,
        right: markerRect.left + x + width,
        bottom: markerRect.top + y + height,
        width,
        height,
      };
    };

    marker.appendChild(label);
    overlay.appendChild(marker);
    overlay.appendChild(markerBelow);

    renderCompactInlineLabelContent(label, '2.3', label.dataset.fullText);
    positionLabelOptimally(marker, label, overlay);

    const compactTransform = label.style.transform;
    const compactPosition = label.dataset.position;

    expandInlineLabelReadOnly(label);
    vi.runAllTimers();

    expect(label.style.transform).not.toBe(compactTransform);
    expect(label.dataset.position).not.toBe(compactPosition);

    collapseInlineLabel(label);
    vi.runAllTimers();

    expect(label.classList.contains('label-expanded')).toBe(false);
    expect(label.dataset.position).toBe(compactPosition);
    expect(label.style.transform).toBe(compactTransform);
  });

  it('does not rewrite compact label transforms on plain hover', async () => {
    const helpers = await loadPlacementHelpers();
    const overlayModule = await loadOverlayRendererModule();

    const container = document.getElementById('pdfGradedContainer');
    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 640,
      width: 480,
      height: 640,
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.dataset.pageNum = '1';
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => 480 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => 640 });
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 640,
      width: 480,
      height: 640,
    });

    const overlay = document.createElement('div');
    overlay.className = 'pdf-annotation-overlay';
    overlay.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 480,
      bottom: 640,
      width: 480,
      height: 640,
    });
    wrapper.appendChild(canvas);
    wrapper.appendChild(overlay);
    container.appendChild(wrapper);

    window.__pdfGradedViewer = {
      getViewportForPage: () => ({ width: 480, height: 640 }),
      zoom: 1,
    };

    const annotation = {
      id: 'ann-1',
      stable_id: 'ann-1',
      requestIdentifier: 'ann-1',
      xref: 'ann-1',
      page_index: 0,
      type: 'Text',
      rect: [180, 190, 202, 212],
      content: 'Compact hover anchor should stay attached',
      source: 'HUMAN',
      color: 'amber',
    };

    const renderer = overlayModule.createOverlayRenderer({
      getAnnotationsData: () => ({ 0: [annotation] }),
      helpers: {
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        resolveAnnotationIdParts: ({ xref, requestId, identifier }) => ({
          xref: xref || null,
          stableId: requestId || identifier || null,
        }),
        resolveAnnotationIdentifierValue: (entry) => entry.requestIdentifier || entry.stable_id || entry.id || entry.xref,
        deriveAnnotationPriority: () => 'amber',
        resolveAnnotationSource: () => 'HUMAN',
        isPlaceholderAnnotation: () => false,
        isMarkupType: () => false,
        renderCompactInlineLabelContent: helpers.renderCompactInlineLabelContent,
        positionLabelOptimally: helpers.positionLabelOptimally,
        repositionAllLabels: helpers.repositionAllLabels,
        setupLabelTooltipEvents: () => {},
        buildDisplayOrderByPagePosition: () => new Map([['ann-1', 1]]),
        resolveDisplayOrderFromLookup: () => 1,
        observeAnnotationMarker: () => {},
        makeAnnotationDraggable: () => {},
      },
    });

    renderer.renderPage(1, true);

    const label = overlay.querySelector('.annotation-label');
    expect(label).not.toBeNull();

    const compactTransform = label.style.transform;
    label.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    expect(label.style.transform).toBe(compactTransform);
    label.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
    expect(label.style.transform).toBe(compactTransform);
  });

  it('keeps compact labels anchored without residual drift near the left boundary', async () => {
    const {
      positionLabelOptimally,
      renderCompactInlineLabelContent,
      repositionAllLabels,
    } = await loadPlacementHelpers();

    const overlay = document.createElement('div');
    overlay.className = 'pdf-annotation-overlay';
    overlay.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 520,
      bottom: 760,
      width: 520,
      height: 760,
    });
    document.body.appendChild(overlay);

    const makeMarker = ({ left, top, text }) => {
      const marker = document.createElement('div');
      marker.className = 'annotation-marker';
      marker.dataset.annotationPage = '0';
      marker.getBoundingClientRect = () => ({
        left,
        top,
        right: left + 22,
        bottom: top + 22,
        width: 22,
        height: 22,
      });

      const label = document.createElement('div');
      label.className = 'annotation-label';
      label.dataset.fullText = text;
      label.style.position = 'absolute';
      label.style.maxWidth = '180px';
      label.style.whiteSpace = 'nowrap';
      label.style.overflow = 'visible';
      label.style.transform = 'translate(2px, 2px)';
      Object.defineProperty(label, 'offsetWidth', {
        configurable: true,
        get() {
          return 128;
        },
      });
      Object.defineProperty(label, 'offsetHeight', {
        configurable: true,
        get() {
          return 28;
        },
      });
      label.getBoundingClientRect = () => {
        const markerRect = marker.getBoundingClientRect();
        const { x, y } = sumTranslateOffsets(label.style.transform);
        const width = label.offsetWidth;
        const height = label.offsetHeight;
        return {
          left: markerRect.left + x,
          top: markerRect.top + y,
          right: markerRect.left + x + width,
          bottom: markerRect.top + y + height,
          width,
          height,
        };
      };

      marker.appendChild(label);
      overlay.appendChild(marker);
      renderCompactInlineLabelContent(label, '4.1', text);
      positionLabelOptimally(marker, label, overlay);
      return { marker, label };
    };

    const leftEdge = makeMarker({
      left: 18,
      top: 180,
      text: 'Left boundary marker',
    });
    const center = makeMarker({
      left: 188,
      top: 236,
      text: 'Center marker',
    });

    repositionAllLabels(overlay);

    expect(leftEdge.label.dataset.residualDx).toBeUndefined();
    expect(leftEdge.label.dataset.residualDy).toBeUndefined();
    expect(leftEdge.label.style.transform).toBe(leftEdge.label.dataset.anchorTransform);
    expect(leftEdge.label.dataset.position).toMatch(/right|bottom/);

    expect(center.label.dataset.residualDx).toBeUndefined();
    expect(center.label.dataset.residualDy).toBeUndefined();
    expect(center.label.style.transform).toBe(center.label.dataset.anchorTransform);
  });

  it('waits 800ms before hover expands a compact label', async () => {
    const {
      renderCompactInlineLabelContent,
      setupLabelTooltipEvents,
    } = await loadPlacementHelpers();

    const marker = document.createElement('div');
    marker.className = 'annotation-marker';
    marker.dataset.pageIdx = '0';
    marker.dataset.identifier = 'ann-1';

    const label = document.createElement('div');
    label.className = 'annotation-label';
    label.style.transform = 'translate(2px, 2px)';
    label.dataset.fullText = 'Hover delay should not expand immediately.';
    marker.appendChild(label);
    document.body.appendChild(marker);

    renderCompactInlineLabelContent(label, '2.3', label.dataset.fullText);
    setupLabelTooltipEvents(label, label.dataset.fullText);
    vi.spyOn(label, 'matches').mockImplementation((selector) => selector === ':hover');

    label.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
    vi.advanceTimersByTime(799);
    expect(label.classList.contains('label-expanded')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(label.classList.contains('label-expanded')).toBe(true);
  });
});
