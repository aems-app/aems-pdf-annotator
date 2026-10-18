import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELETE_UNDO_PAGE_HEIGHT,
  LOSSY_DELETE_HIGHLIGHT,
  cloneLossyDeleteHighlight,
} from './fixtures/lossy-delete-undo.fixture.js';

const MODULE_PATH = '../src/pdf-preview-modal.js';

const loadPlacementHelpers = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModal.__test;
};

async function createUndoHarness({
  controllerUndoStack = [],
  performHighlightExtendUndo = vi.fn().mockResolvedValue({ success: true }),
  createAnnotation = vi.fn().mockResolvedValue({ success: true }),
  updateAnnotation = vi.fn().mockResolvedValue({ success: true }),
  deleteAnnotation = vi.fn().mockResolvedValue({ success: true }),
  annotations = null,
  visibilityController = null,
  annotationControllerFactory = null,
} = {}) {
  let modalHelpers;
  let controllerOptions;
  let overlayHelpers;
  const markerClickHandlers = [];

  window.PdfPreviewModalStateCore = {
    createModalState: (options) => ({
      options: {
        capabilities: { annotationCrud: true },
        ...options,
      },
      ui: {},
      document: {},
      annotations: { undoStack: [] },
      sync: {},
    }),
  };
  window.PdfPreviewModalAnnotationController = {
    createAnnotationController: (options) => {
      modalHelpers = options.helpers;
      controllerOptions = options;
      if (annotationControllerFactory) return annotationControllerFactory(options);
      if (annotations) options.setAnnotationsData(annotations);
      return {
        peekUndoOperation: () => controllerUndoStack.at(-1) || null,
        popUndoOperation: () => controllerUndoStack.pop() || null,
        getUndoStack: () => controllerUndoStack,
        performHighlightExtendUndo,
        unobserveAnnotationMarker: visibilityController?.unobserveAnnotationMarker,
        getVisibleMarkers: visibilityController?.getVisibleMarkers,
        selectAnnotation: () => {},
        renderList: vi.fn(),
        onAnnotationsChanged: () => {},
        onAnnotationsLoaded: () => {},
        onRenderListNeeded: () => {},
        onRenderOverlaysNeeded: () => {},
        onScheduleUpdate: () => {},
        destroy: () => {},
      };
    },
  };
  if (visibilityController) {
    window.PdfPreviewModalOverlayRenderer = {
      createOverlayRenderer: (options) => {
        overlayHelpers = options.helpers;
        return {
          onMarkerClicked: (handler) => { markerClickHandlers.push(handler); },
          onMarkerDblClicked: () => {},
          onOverlayDblClicked: () => {},
          onOverlayReady: () => {},
          renderPage: visibilityController.renderPage || vi.fn(),
          renderAnnotations: vi.fn(),
          destroy: () => {},
        };
      },
    };
  }

  class FakeViewer {
    onAnnotationsPageChange() {}
    onPageRendered() {}
    onSliderSync() {}
    onResizeComplete() {}
  }
  window.PdfPreviewModalViewer = {
    PDFViewer: FakeViewer,
    resolvePdfjsLib: () => ({}),
  };

  const modalInstances = new WeakMap();
  class FakeModal {
    constructor(element) {
      this.element = element;
      modalInstances.set(element, this);
    }

    show() {}

    hide() {
      this.element.dispatchEvent(new window.Event('hidden.bs.modal'));
    }

    static getInstance(element) {
      return modalInstances.get(element) || null;
    }
  }
  window.bootstrap.Modal = FakeModal;

  const adapter = {
    createAnnotation,
    updateAnnotation,
    deleteAnnotation,
  };
  await loadPlacementHelpers();
  const handle = window.PdfPreviewModal.createPdfPreviewModal({
    assignmentId: 'assignment-1',
    submissionId: 'submission-1',
    modeAdapter: adapter,
  });
  await handle.open();

  return {
    handle,
    adapter,
    clickMarker: (data) => markerClickHandlers.forEach((handler) => handler(data)),
    getAnnotationsData: () => controllerOptions.getAnnotationsData(),
    buildApiAnnotationIdentifier: modalHelpers.buildApiAnnotationIdentifier,
    unobserveAnnotationMarker: overlayHelpers?.unobserveAnnotationMarker,
    pushLocalUndo: modalHelpers.pushUndoOperation,
    dispatchUndo: () => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
      }));
    },
    // Ctrl+Y by default; pass a key init for Ctrl+Shift+Z or the Cmd variants.
    dispatchRedo: (init = { key: 'y', ctrlKey: true }, target = document) => {
      const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    getUndoStacks: () => window.PdfPreviewModal.__test.getUndoStacks(),
  };
}

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

// Real list renderers and annotation model, with only the host API/PDF viewer stubbed.
async function createSplitOwnershipHarness({
  source = 'AI', updateResult = null, createAnnotation, deleteAnnotation,
} = {}) {
  await import('../src/pdf-preview-modal/utils.js');
  await import('../src/pdf-preview-modal/annotation-helpers.js');
  await import('../src/pdf-preview-modal/sidebar-panel.js');
  await import('../src/pdf-preview-modal/annotation-controller.js');
  const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
  const annotation = {
    id: 'owned-comment', stable_id: 'owned-comment', xref: 42, page_index: 0,
    type: 'Highlight', content: 'Teacher feedback', source, original_source: 'AI',
    grader_name: 'Artem Kulachenko', rect: [50, 50, 150, 70],
    quads: [[50, 50, 150, 70]], anchor_text: 'answer text',
  };
  const updateAnnotation = vi.fn(async (_assignment, _submission, _id, body) => (
    updateResult || { success: true, annotation: {
      ...annotation, ...body, page_index: body.page_index ?? 0,
    } }
  ));
  let controller;
  let options;
  const renderPage = vi.fn(() => {
    // Simulate the overlay render and visibility notification after page changes.
    const entry = Object.values(options.getAnnotationsData()).flat()[0];
    const currentMarker = document.querySelector('.annotation-marker');
    if (currentMarker && entry) {
      currentMarker.dataset.annotationPage = String(entry.page_index);
      currentMarker.dataset.annotationSource = entry.source;
      controller.renderList();
    }
  });
  const harness = await createUndoHarness({
    updateAnnotation,
    createAnnotation,
    deleteAnnotation,
    visibilityController: { renderPage },
    annotationControllerFactory: (opts) => {
      options = opts;
      opts.setAnnotationsData({ 0: [{ ...annotation }] });
      controller = factory({ ...opts, getSplitPanelActive: () => true });
      return controller;
    },
  });
  const container = document.getElementById('pdfGradedContainer');
  container.innerHTML = `
    <div class="pdf-page-wrapper" data-page-num="1">
      <canvas class="pdf-page-canvas"></canvas><div class="pdf-annotation-overlay">
        <div class="annotation-marker source-${source.toLowerCase()}"
          data-annotation-page="0" data-annotation-xref="42"
          data-annotation-request-id="owned-comment" data-annotation-source="${source}"></div>
      </div>
    </div>`;
  const marker = container.querySelector('.annotation-marker');
  container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792 });
  marker.getBoundingClientRect = () => ({ left: 60, top: 60, right: 160, bottom: 80, width: 100, height: 20 });
  const viewport = { width: 612, height: 792, scale: 1, convertToPdfPoint: (x, y) => [x, 792 - y] };
  window.__pdfGradedViewer.getViewportForPage = () => viewport;
  window.__pdfGradedViewer.pdf = { getPage: async () => ({ view: [0, 0, 612, 792] }) };
  window.__pdfGradedViewer.currentPage = 1;
  const secondPage = container.firstElementChild.cloneNode(true);
  secondPage.dataset.pageNum = '2';
  secondPage.querySelector('.annotation-marker').remove();
  container.appendChild(secondPage);
  container.querySelectorAll('canvas').forEach((canvas) => {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 612, height: 792 });
  });
  Object.defineProperties(marker, {
    offsetLeft: { value: 60 }, offsetTop: { value: 60 },
    offsetWidth: { value: 100 }, offsetHeight: { value: 20 },
  });
  controller.addVisibleMarker(options.helpers.buildAnnotationVisibilityKey(0, { annotation }));
  controller.renderList();
  const aiList = document.getElementById('pdfGradedAICommentsList');
  const humanList = document.getElementById('pdfGradedCommentsList');
  return {
    ...harness, annotation, marker, controller, options, updateAnnotation,
    expectBucket(expectedSource) {
      const target = expectedSource === 'AI' ? aiList : humanList;
      const other = expectedSource === 'AI' ? humanList : aiList;
      expect(target.querySelectorAll('.list-group-item')).toHaveLength(1);
      expect(other.querySelectorAll('.list-group-item')).toHaveLength(0);
      expect(target.textContent).toContain('A.K.');
      const entries = Object.values(options.getAnnotationsData()).flat();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ source: expectedSource, grader_name: annotation.grader_name });
    },
  };
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
  it('rebuilds a drawing viewport when the viewer cache was cleared', async () => {
    const helpers = await loadPlacementHelpers();
    const fallbackViewport = { convertToPdfPoint: vi.fn() };
    const getPage = vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue(fallbackViewport),
    });
    const viewer = {
      getViewportForPage: vi.fn().mockReturnValue(undefined),
      pdf: { getPage },
      scale: 1.5,
      zoom: 2,
    };

    await expect(helpers.resolveDrawingViewport(viewer, 3)).resolves.toBe(fallbackViewport);
    expect(getPage).toHaveBeenCalledWith(3);
  });

  beforeEach(() => {
    vi.resetModules();
    delete window.AEMSPdfAnnotator;
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalUtils;
    delete window.PdfPreviewModalStateCore;
    delete window.PdfPreviewModalViewer;
    delete window.PdfPreviewModalAnnotationHelpers;
    delete window.PdfPreviewModalAnnotationController;
    delete window.PdfPreviewModalDocumentController;
    delete window.PdfPreviewModalOverlayRenderer;
    delete window.PdfPreviewModalVersionSync;
    delete window.PdfPreviewModalShell;
    delete window.__pdfOriginalViewer;
    delete window.__pdfGradedViewer;
    delete window.PDFViewer;
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div>
      <div id="pdfPreviewStudent"></div>
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

  it.each([null, { success: true }])('re-buckets an anchored source-only transfer with response %j', async (updateResult) => {
    const h = await createSplitOwnershipHarness({ updateResult });
    h.expectBucket('AI');
    h.marker.dataset.annotationSource = 'HUMAN'; // optimistic mouseup state
    await window.PdfPreviewModal.__test.persistAnchoredOwnershipTransfer(h.marker, 'owned-comment');
    expect(h.updateAnnotation.mock.calls[0][3]).toEqual({ source: 'HUMAN' });
    h.expectBucket('HUMAN');
    h.handle.destroy();
  });

  it('keeps a rejected anchored transfer in the AI list', async () => {
    const h = await createSplitOwnershipHarness({ updateResult: { success: false } });
    h.marker.dataset.annotationSource = 'HUMAN';
    await window.PdfPreviewModal.__test.persistAnchoredOwnershipTransfer(h.marker, 'owned-comment');
    h.expectBucket('AI');
    expect(h.marker.dataset.annotationSource).toBe('AI');
    h.handle.destroy();
  });

  it('re-buckets a same-page move undo back to AI without reopening', async () => {
    const h = await createSplitOwnershipHarness({ source: 'HUMAN' });
    h.expectBucket('HUMAN');
    h.controller.pushUndoOperation({
      type: 'move', identifier: 'owned-comment', requestId: 'owned-comment', xref: '42',
      oldPageIdx: 0, newPageIdx: 0, oldRect: h.annotation.rect, newRect: [60, 60, 160, 80],
      oldSource: 'AI', newSource: 'HUMAN', isOwnershipTransfer: true,
    });
    h.dispatchUndo();
    await vi.advanceTimersByTimeAsync(350);
    expect(h.updateAnnotation.mock.calls[0][3].source).toBe('AI');
    h.expectBucket('AI');
    h.handle.destroy();
  });

  it.each([0, 1])('re-buckets a regular move to page %i and its undo', async (targetPage) => {
    const h = await createSplitOwnershipHarness();
    h.expectBucket('AI');
    await window.PdfPreviewModal.__test.updateAnnotationPosition(0, targetPage, 'owned-comment', h.marker, true);
    expect(h.updateAnnotation.mock.calls[0][3].source).toBe('HUMAN');
    h.expectBucket('HUMAN');
    h.dispatchUndo();
    await vi.advanceTimersByTimeAsync(350);
    expect(h.updateAnnotation.mock.calls[1][3].source).toBe('AI');
    h.expectBucket('AI');
    h.handle.destroy();
  });

  it('places reloaded persisted HUMAN feedback in the teacher list', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const h = await createSplitOwnershipHarness();
    h.expectBucket('AI');
    h.options.helpers.listAnnotationsRequest = vi.fn().mockResolvedValue({
      success: true, annotations: { 0: [{ ...h.annotation, source: 'HUMAN' }] },
    });
    await h.controller.loadAnnotations();
    h.controller.renderList();
    h.expectBucket('HUMAN');
    h.handle.destroy();
    vi.unstubAllGlobals();
  });

  it.each([120, 220])('re-buckets highlight resize to width %i and its undo', async (right) => {
    const h = await createSplitOwnershipHarness();
    await h.controller.persistHighlightExtend(h.marker, h.annotation, {
      pageIdx: 0, quadsPdf: [[50, 722, right, 742]], anchorText: 'resized answer text',
    });
    expect(h.updateAnnotation.mock.calls[0][3].source).toBe('HUMAN');
    h.expectBucket('HUMAN');
    await h.controller.performHighlightExtendUndo(h.controller.peekUndoOperation());
    expect(h.updateAnnotation.mock.calls[1][3].source).toBe('AI');
    h.expectBucket('AI');
    h.handle.destroy();
  });

  it('re-buckets an inline text edit when the server transfers ownership', async () => {
    const h = await createSplitOwnershipHarness();
    const label = document.createElement('div');
    label.className = 'annotation-label label-expanded label-editing';
    label.dataset.fullText = h.annotation.content;
    h.marker.appendChild(label);
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: 'Edited inline' },
    });
    await window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Edited inline');
    expect(h.updateAnnotation.mock.calls[0][3]).toEqual({ content: 'Edited inline' });
    h.expectBucket('HUMAN');
    h.handle.destroy();
  });

  // Issue #462 (criterion 29): an edit saved through the inline label pushed no undo entry, so Ctrl+Z left the
  // edited text in place. Undo must restore the previous text and, after an ownership transfer, the AI source.
  it('Ctrl+Z restores an inline text edit and its source', async () => {
    const h = await createSplitOwnershipHarness();
    const label = document.createElement('div');
    label.className = 'annotation-label label-expanded label-editing';
    label.dataset.fullText = h.annotation.content;
    label.dataset.originalFullText = h.annotation.content;
    h.marker.appendChild(label);
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: 'Edited inline' },
    });
    await window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Edited inline');
    h.expectBucket('HUMAN');

    h.dispatchUndo();
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
    expect(h.updateAnnotation.mock.calls[1][3]).toEqual({ content: 'Teacher feedback', source: 'AI' });
    await vi.waitFor(() => h.expectBucket('AI'));
    expect(Object.values(h.options.getAnnotationsData()).flat()[0].content).toBe('Teacher feedback');
    h.handle.destroy();
  });

  // Codex review of the #462 fix, round 1: the undo entry must record the last PERSISTED text, not a draft the
  // priority path kept in annotation.content, and a save that persists nothing new must push no entry.
  function inlineLabelFor(h, startedFrom) {
    const label = document.createElement('div');
    label.className = 'annotation-label label-expanded label-editing';
    label.dataset.fullText = startedFrom;
    label.dataset.originalFullText = startedFrom;
    h.marker.appendChild(label);
    return label;
  }

  it('Ctrl+Z after an inline save restores the persisted text, not an unsaved draft', async () => {
    const h = await createSplitOwnershipHarness();
    const entry = Object.values(h.options.getAnnotationsData()).flat()[0];
    entry._originalContent = 'Teacher feedback';
    entry.content = 'Edited inline'; // the draft the priority path preserves while editing
    const label = inlineLabelFor(h, 'Teacher feedback');
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: 'Edited inline' },
    });
    await window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Edited inline');

    h.dispatchUndo();
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
    expect(h.updateAnnotation.mock.calls[1][3].content).toBe('Teacher feedback');
    h.handle.destroy();
  });

  it('an inline save that persists nothing new pushes no undo entry', async () => {
    const h = await createSplitOwnershipHarness();
    const entry = Object.values(h.options.getAnnotationsData()).flat()[0];
    // The sidebar Save already persisted the edit; the inline blur handler then saves the same text again.
    entry._originalContent = 'Edited inline';
    entry.content = 'Edited inline';
    const label = inlineLabelFor(h, 'Teacher feedback');
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: 'Edited inline' },
    });
    await window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Edited inline');
    expect(window.PdfPreviewModal.__test.getUndoStacks().local.filter((op) => op.type === 'edit')).toEqual([]);
    h.handle.destroy();
  });

  // Codex review of the #462 fix, round 2: overlapping sidebar and inline saves of one edit. The undo entry is
  // decided when the response arrives, against the entry as it stands then, so whichever save lands second
  // pushes nothing, and every Ctrl+Z restores a distinct earlier text.
  function persistedEntry(h) {
    return Object.values(h.options.getAnnotationsData()).flat()[0];
  }

  function pendingUpdate(h) {
    let resolve;
    h.updateAnnotation.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    return (content) => resolve({ success: true, annotation: { ...h.annotation, source: 'HUMAN', content } });
  }

  function stackedEdits() {
    const { local, controller } = window.PdfPreviewModal.__test.getUndoStacks();
    return [...local, ...controller].filter((op) => op.type === 'edit');
  }

  it('an inline save that lands after a sidebar save of the same edit pushes no second entry', async () => {
    const h = await createSplitOwnershipHarness();
    const label = inlineLabelFor(h, 'Teacher feedback');
    const finishInline = pendingUpdate(h);
    const inline = window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Second edit');
    // The sidebar Save lands first and stores the same text.
    const index = h.options.getAnnotationsData()[0].indexOf(persistedEntry(h));
    h.options.getAnnotationsData()[0][index] = {
      ...persistedEntry(h), content: 'Second edit', _originalContent: 'Second edit',
    };
    finishInline('Second edit');
    await inline;
    expect(stackedEdits()).toEqual([]);
    h.handle.destroy();
  });

  it('a sidebar save that lands after an inline save of the same edit pushes no second entry', async () => {
    const h = await createSplitOwnershipHarness();
    h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
    document.getElementById('edit-annotation-text-owned-comment').value = 'Second edit';
    const finishSidebar = pendingUpdate(h);
    const sidebar = h.controller.saveAnnotationEdit('owned-comment');
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(1));
    // The inline save lands first and stores the same text.
    const index = h.options.getAnnotationsData()[0].indexOf(persistedEntry(h));
    h.options.getAnnotationsData()[0][index] = {
      ...persistedEntry(h), content: 'Second edit', _originalContent: 'Second edit',
    };
    finishSidebar('Second edit');
    await sidebar;
    expect(stackedEdits()).toEqual([]);
    h.handle.destroy();
  });

  // Codex review of the #462 fix, round 3: with two DIFFERENT overlapping edits, the first save that lands has
  // already transferred ownership, so the later entry's old source is the entry's source as it stands then
  // (HUMAN), not the stale AI snapshot taken before either request.
  it('an inline save landing after another edit records that edit as its old text and source', async () => {
    const h = await createSplitOwnershipHarness();
    const label = inlineLabelFor(h, 'Teacher feedback');
    const finishInline = pendingUpdate(h);
    const inline = window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Second edit');
    const index = h.options.getAnnotationsData()[0].indexOf(persistedEntry(h));
    h.options.getAnnotationsData()[0][index] = {
      ...persistedEntry(h), content: 'First edit', _originalContent: 'First edit', source: 'HUMAN',
    };
    finishInline('Second edit');
    await inline;
    expect(stackedEdits()).toEqual([
      expect.objectContaining({
        oldContent: 'First edit', newContent: 'Second edit', oldSource: 'HUMAN', isOwnershipTransfer: false,
      }),
    ]);
    h.handle.destroy();
  });

  it('a sidebar save landing after another edit records that edit as its old text and source', async () => {
    const h = await createSplitOwnershipHarness();
    h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
    document.getElementById('edit-annotation-text-owned-comment').value = 'Second edit';
    const finishSidebar = pendingUpdate(h);
    const sidebar = h.controller.saveAnnotationEdit('owned-comment');
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(1));
    const index = h.options.getAnnotationsData()[0].indexOf(persistedEntry(h));
    h.options.getAnnotationsData()[0][index] = {
      ...persistedEntry(h), content: 'First edit', _originalContent: 'First edit', source: 'HUMAN',
    };
    finishSidebar('Second edit');
    await sidebar;
    const edits = window.PdfPreviewModal.__test.getUndoStacks().controller.filter((op) => op.type === 'edit');
    expect(edits).toEqual([
      expect.objectContaining({
        oldContent: 'First edit', newContent: 'Second edit', oldSource: 'HUMAN', isOwnershipTransfer: false,
      }),
    ]);
    h.handle.destroy();
  });

  it('Ctrl+Z after a sidebar save restores the persisted text, not an unsaved draft', async () => {
    const h = await createSplitOwnershipHarness();
    h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
    persistedEntry(h).content = 'Edited feedback'; // a draft kept in content, as the priority path does
    document.getElementById('edit-annotation-text-owned-comment').value = 'Edited feedback';
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: 'Edited feedback' },
    });
    await h.controller.saveAnnotationEdit('owned-comment');
    h.dispatchUndo();
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
    expect(h.updateAnnotation.mock.calls[1][3].content).toBe('Teacher feedback');
    h.handle.destroy();
  });

  it('Ctrl+Z restores a sidebar text edit and its source', async () => {
    const h = await createSplitOwnershipHarness();
    h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
    const textarea = document.getElementById('edit-annotation-text-owned-comment');
    textarea.value = 'Edited feedback';
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: textarea.value },
    });
    await h.controller.saveAnnotationEdit('owned-comment');
    h.expectBucket('HUMAN');

    h.dispatchUndo();
    await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
    expect(h.updateAnnotation.mock.calls[1][3]).toEqual({ content: 'Teacher feedback', source: 'AI' });
    await vi.waitFor(() => h.expectBucket('AI'));
    expect(Object.values(h.options.getAnnotationsData()).flat()[0].content).toBe('Teacher feedback');
    h.handle.destroy();
  });

  it('re-buckets a sidebar text edit when the server transfers ownership', async () => {
    const h = await createSplitOwnershipHarness();
    h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
    const textarea = document.getElementById('edit-annotation-text-owned-comment');
    expect(textarea).not.toBeNull();
    textarea.value = 'Edited feedback';
    h.updateAnnotation.mockResolvedValueOnce({
      success: true, annotation: { ...h.annotation, source: 'HUMAN', content: textarea.value },
    });
    await h.controller.saveAnnotationEdit('owned-comment');
    expect(h.updateAnnotation.mock.calls[0][3]).toEqual({ content: 'Edited feedback' });
    h.expectBucket('HUMAN');
    h.handle.destroy();
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

    expect(label.dataset.position).toBe(compactPosition);
    expect(label.dataset.anchorTransform).toContain('translate(');

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

  it('uses corner anchors for compact labels even near page boundaries', async () => {
    const {
      positionLabelOptimally,
      renderCompactInlineLabelContent,
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

    const marker = document.createElement('div');
    marker.className = 'annotation-marker';
    marker.dataset.annotationPage = '0';
    marker.getBoundingClientRect = () => ({
      left: 16,
      top: 34,
      right: 38,
      bottom: 56,
      width: 22,
      height: 22,
    });

    const label = document.createElement('div');
    label.className = 'annotation-label';
    label.dataset.fullText = 'Compact labels should stay corner-attached.';
    label.style.position = 'absolute';
    label.style.maxWidth = '180px';
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'visible';
    label.style.transform = 'translate(2px, 2px)';
    Object.defineProperty(label, 'offsetWidth', {
      configurable: true,
      get() {
        return 132;
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
    renderCompactInlineLabelContent(label, '2.3', label.dataset.fullText);
    positionLabelOptimally(marker, label, overlay);

    expect(label.dataset.position).toMatch(/^(top|bottom)-(left|right)$/);
    expect(label.dataset.position).not.toMatch(/center/);
  });

  it('preserves the compact anchor when a label expands', async () => {
    const {
      expandInlineLabelReadOnly,
      positionLabelOptimally,
      renderCompactInlineLabelContent,
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

    const marker = document.createElement('div');
    marker.className = 'annotation-marker';
    marker.dataset.annotationPage = '0';
    marker.getBoundingClientRect = () => ({
      left: 18,
      top: 180,
      right: 40,
      bottom: 202,
      width: 22,
      height: 22,
    });

    const label = document.createElement('div');
    label.className = 'annotation-label';
    label.dataset.fullText = 'Expanded labels should keep the same anchor corner they had while compact.';
    label.style.position = 'absolute';
    label.style.maxWidth = '180px';
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'visible';
    Object.defineProperty(label, 'offsetWidth', {
      configurable: true,
      get() {
        return label.classList.contains('label-expanded') ? 216 : 96;
      },
    });
    Object.defineProperty(label, 'offsetHeight', {
      configurable: true,
      get() {
        return label.classList.contains('label-expanded') ? 72 : 24;
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
    renderCompactInlineLabelContent(label, '2.3', label.dataset.fullText);
    positionLabelOptimally(marker, label, overlay);

    const compactPosition = label.dataset.position;
    expect(compactPosition).toBe('bottom-right');

    expandInlineLabelReadOnly(label);
    vi.runAllTimers();

    expect(label.classList.contains('label-expanded')).toBe(true);
    expect(label.dataset.position).toBe(compactPosition);
    expect(label.dataset.anchorTransform).toContain('translate(24px');
  });

  it('keeps the dragged compact label on its existing side until the marker moves far enough', async () => {
    const {
      positionLabelOptimally,
      renderCompactInlineLabelContent,
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

    let markerLeft = 386;
    const markerTop = 180;
    const marker = document.createElement('div');
    marker.className = 'annotation-marker';
    marker.dataset.annotationPage = '0';
    marker.getBoundingClientRect = () => ({
      left: markerLeft,
      top: markerTop,
      right: markerLeft + 22,
      bottom: markerTop + 22,
      width: 22,
      height: 22,
    });

    const label = document.createElement('div');
    label.className = 'annotation-label';
    label.dataset.fullText = 'Dragged labels should not flip sides immediately.';
    label.style.position = 'absolute';
    label.style.maxWidth = '180px';
    label.style.whiteSpace = 'nowrap';
    label.style.overflow = 'visible';
    Object.defineProperty(label, 'offsetWidth', {
      configurable: true,
      get() {
        return 132;
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
    renderCompactInlineLabelContent(label, '2.3', label.dataset.fullText);
    positionLabelOptimally(marker, label, overlay);

    expect(label.dataset.position).toBe('bottom-left');

    markerLeft = 260;
    positionLabelOptimally(marker, label, overlay, undefined, {
      preferredPosition: label.dataset.compactPosition,
      stabilizeCompactPosition: true,
    });

    expect(label.dataset.position).toBe('bottom-left');

    markerLeft = 54;
    positionLabelOptimally(marker, label, overlay, undefined, {
      preferredPosition: label.dataset.compactPosition,
      stabilizeCompactPosition: true,
    });

    expect(label.dataset.position).toBe('bottom-right');
  });

  it('excludes drawing and textbox markup from display numbering', async () => {
    window.PdfPreviewModalCrud = {
      isMarkupType: (type) => type === 'drawing' || type === 'textbox',
    };
    const { buildDisplayOrderByPagePosition } = await loadPlacementHelpers();

    const lookup = buildDisplayOrderByPagePosition([
      { stable_id: 'ann-1', type: 'Text', rect: [10, 10, 40, 40], content: 'A' },
      { stable_id: 'draw-1', type: 'drawing', rect: [12, 12, 42, 42], content: '' },
      { stable_id: 'box-1', type: 'textbox', rect: [14, 14, 44, 44], content: 'Markup text' },
      { stable_id: 'ann-2', type: 'Text', rect: [50, 50, 80, 80], content: 'B' },
    ]);

    expect(lookup.get('ann-1')).toBe(1);
    expect(lookup.get('ann-2')).toBe(2);
    expect(lookup.has('draw-1')).toBe(false);
    expect(lookup.has('box-1')).toBe(false);
  });

  it('keeps bare numeric stable-only identifiers stable in the monolith fallback', async () => {
    const harness = await createUndoHarness();

    expect(harness.buildApiAnnotationIdentifier({ identifier: '123' })).toBe('id:123');
    expect(harness.buildApiAnnotationIdentifier({ requestId: '456' })).toBe('id:456');
    harness.handle.destroy();
  });

  it('forwards deleted highlight quads, anchor text, and identity when recreating it', async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ success: true });
    const harness = await createUndoHarness({
      createAnnotation,
      visibilityController: {},
      controllerUndoStack: [{
        type: 'delete',
        pageIdx: 0,
        annotation: cloneLossyDeleteHighlight(),
        undoTimestamp: 100,
      }],
    });
    window.__pdfGradedViewer = {
      pdf: {
        getPage: vi.fn().mockResolvedValue({ view: [0, 0, 612, DELETE_UNDO_PAGE_HEIGHT] }),
      },
    };

    harness.dispatchUndo();
    await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledOnce());

    expect(createAnnotation.mock.calls[0][2]).toEqual({
      content: LOSSY_DELETE_HIGHLIGHT.content,
      type: 'Highlight',
      rect: [84.96, 634.41, 527.04, 675.26],
      color: 'amber',
      page_index: 0,
      source: 'AI',
      quads: [
        [84.96, 663.31, 527.04, 675.26],
        [84.96, 648.86, 527.04, 660.81],
        [84.96, 634.41, 145.58, 646.37],
      ],
      anchor_text: LOSSY_DELETE_HIGHLIGHT.anchor_text,
      check_id: 'Q1-05',
      task_id: 'Q1',
      stable_id: 'Q1-05',
    });
    harness.handle.destroy();
  });

  it('still converts deleted highlight quads when the snapshot rect is malformed', async () => {
    // The conversion used to run inside a guard on the rect's shape, so a
    // missing or malformed rect left otherwise-valid quads in top-left space
    // and the highlight came back painted at the wrong end of the page.
    const createAnnotation = vi.fn().mockResolvedValue({ success: true });
    const harness = await createUndoHarness({
      createAnnotation,
      visibilityController: {},
      controllerUndoStack: [{
        type: 'delete',
        pageIdx: 0,
        annotation: { ...cloneLossyDeleteHighlight(), rect: null },
        undoTimestamp: 100,
      }],
    });
    window.__pdfGradedViewer = {
      pdf: {
        getPage: vi.fn().mockResolvedValue({ view: [0, 0, 612, DELETE_UNDO_PAGE_HEIGHT] }),
      },
    };

    harness.dispatchUndo();
    await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledOnce());

    expect(createAnnotation.mock.calls[0][2].quads).toEqual([
      [84.96, 663.31, 527.04, 675.26],
      [84.96, 648.86, 527.04, 660.81],
      [84.96, 634.41, 145.58, 646.37],
    ]);
    harness.handle.destroy();
  });

  it('keeps the recreate payload unchanged for a non-highlight Text annotation', async () => {
    const createAnnotation = vi.fn().mockResolvedValue({ success: true });
    const harness = await createUndoHarness({
      createAnnotation,
      visibilityController: {},
      controllerUndoStack: [{
        type: 'delete',
        pageIdx: 0,
        annotation: {
          ...cloneLossyDeleteHighlight(),
          id: 'text-1',
          stable_id: 'text-1',
          type: 'Text',
          rect: [180, 190, 202, 212],
          quads: undefined,
          anchor_text: undefined,
          content: 'Icon note',
          source: 'HUMAN',
        },
        undoTimestamp: 100,
      }],
    });
    window.__pdfGradedViewer = {
      pdf: {
        getPage: vi.fn().mockResolvedValue({ view: [0, 0, 612, DELETE_UNDO_PAGE_HEIGHT] }),
      },
    };

    harness.dispatchUndo();
    await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledOnce());

    expect(createAnnotation.mock.calls[0][2]).toEqual({
      content: 'Icon note',
      type: 'Text',
      rect: [180, 580, 202, 602],
      color: 'amber',
      page_index: 0,
      source: 'HUMAN',
    });
    expect(createAnnotation.mock.calls[0][2]).not.toHaveProperty('quads');
    harness.handle.destroy();
  });

  it('unobserves one marker without copying the controller visible-marker set', async () => {
    const unobserveAnnotationMarker = vi.fn();
    const getVisibleMarkers = vi.fn(() => new Set(
      Array.from({ length: 100 }, (_value, index) => `0:annotation-${index}`),
    ));
    const harness = await createUndoHarness({
      visibilityController: {
        unobserveAnnotationMarker,
        getVisibleMarkers,
      },
    });
    const marker = document.createElement('div');
    marker.dataset.annotationPage = '0';
    marker.dataset.annotationRequestId = 'annotation-50';
    getVisibleMarkers.mockClear();

    harness.unobserveAnnotationMarker(marker);

    expect(unobserveAnnotationMarker).toHaveBeenCalledOnce();
    expect(unobserveAnnotationMarker).toHaveBeenCalledWith(marker);
    expect(getVisibleMarkers).not.toHaveBeenCalled();
    harness.handle.destroy();
  });

  it('discards a dead move undo so an older operation can run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const updateAnnotation = vi.fn().mockResolvedValue({ success: true });
    const harness = await createUndoHarness({ updateAnnotation });
    harness.pushLocalUndo({
      type: 'edit',
      identifier: 'older-annotation',
      pageIdx: 0,
      oldContent: 'older content',
      undoTimestamp: 100,
    });
    harness.pushLocalUndo({
      type: 'move',
      identifier: 'deleted-annotation',
      requestId: 'deleted-annotation',
      xref: '77',
      oldPageIdx: 0,
      newPageIdx: 0,
      oldRect: [10, 20, 30, 40],
      undoTimestamp: 200,
    });

    harness.dispatchUndo();
    await Promise.resolve();

    expect(harness.getUndoStacks().local).toEqual([
      expect.objectContaining({ type: 'edit', identifier: 'older-annotation' }),
    ]);
    expect(document.querySelector('.alert-danger')?.textContent).toContain('Annotation no longer exists');

    harness.dispatchUndo();
    await Promise.resolve();

    expect(updateAnnotation).toHaveBeenCalledTimes(1);
    expect(updateAnnotation.mock.calls[0][2]).toBe('older-annotation');
    harness.handle.destroy();
  });

  it('ignores rapid reentry and releases the undo guard after a request error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectFirstRequest;
    const updateAnnotation = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectFirstRequest = reject;
      }))
      .mockResolvedValue({ success: true });
    const harness = await createUndoHarness({ updateAnnotation });
    harness.pushLocalUndo({
      type: 'edit',
      identifier: 'older-annotation',
      pageIdx: 0,
      oldContent: 'older content',
      undoTimestamp: 100,
    });
    harness.pushLocalUndo({
      type: 'edit',
      identifier: 'newer-annotation',
      pageIdx: 0,
      oldContent: 'newer content',
      undoTimestamp: 200,
    });

    harness.dispatchUndo();
    harness.dispatchUndo();

    expect(updateAnnotation).toHaveBeenCalledTimes(1);
    expect(updateAnnotation.mock.calls[0][2]).toBe('newer-annotation');

    rejectFirstRequest(new Error('request failed'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.dispatchUndo();
    await Promise.resolve();

    expect(updateAnnotation).toHaveBeenCalledTimes(2);
    expect(updateAnnotation.mock.calls[1][2]).toBe('newer-annotation');
    harness.handle.destroy();
  });

  it('undoes the local move first on timestamp ties and consumes its controller duplicate once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const timestamp = 500;
    const controllerOperation = {
      type: 'highlight-extend',
      identifier: 'highlight-1',
      requestId: 'highlight-1',
      pageIdx: 0,
      undoTimestamp: timestamp,
    };
    const controllerUndoStack = [controllerOperation];
    const performHighlightExtendUndo = vi.fn().mockResolvedValue({ success: true });
    const harness = await createUndoHarness({
      controllerUndoStack,
      performHighlightExtendUndo,
    });
    harness.pushLocalUndo({ ...controllerOperation });
    harness.pushLocalUndo({
      type: 'move',
      identifier: 'highlight-1',
      requestId: 'highlight-1',
      xref: '77',
      oldPageIdx: 0,
      newPageIdx: 0,
      oldRect: [10, 20, 30, 40],
      undoTimestamp: timestamp,
    });

    harness.dispatchUndo();
    await Promise.resolve();

    expect(performHighlightExtendUndo).not.toHaveBeenCalled();
    expect(harness.getUndoStacks()).toMatchObject({
      local: [expect.objectContaining({ type: 'highlight-extend' })],
      controller: [expect.objectContaining({ type: 'highlight-extend' })],
    });

    harness.dispatchUndo();
    await Promise.resolve();

    expect(performHighlightExtendUndo).toHaveBeenCalledTimes(1);
    expect(harness.getUndoStacks()).toEqual({ local: [], controller: [] });
    harness.handle.destroy();
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

  // Issue #540: redo (Ctrl+Y, Ctrl+Shift+Z, and the Cmd variants) for every operation the undo stack records.
  // Each test performs the original action, undoes it, and redoes it, then checks that the redo made the same
  // persistence call as the original action and left the annotation in its post-action state, ownership included.
  describe('redo (issue #540)', () => {
    // Every modal a test opens is destroyed afterwards, so a test that fails part-way cannot leave its keydown
    // handlers on the document to answer the next test's shortcuts.
    const opened = [];
    afterEach(() => {
      opened.splice(0).forEach((handle) => handle.destroy());
      delete window.PdfPreviewModalMarkupSelection;
      delete window.PdfPreviewModalHighlightAnchor;
    });

    async function splitHarness(options) {
      const h = await createSplitOwnershipHarness(options);
      opened.push(h.handle);
      return h;
    }

    async function undoHarness(options) {
      const h = await createUndoHarness(options);
      opened.push(h.handle);
      return h;
    }

    const errorToasts = () => [...document.querySelectorAll('.alert-danger')].map((toast) => toast.textContent.trim());

    // A fake annotation endpoint that keeps its state between calls and follows the AEMS server's ownership
    // rule: the PUT stores `new_source or metadata.get('source') or 'AI'`, so a request without a source keeps
    // the stored one, and only an explicit source moves ownership. A content or colour change never does.
    // echo: false answers success without the annotation, as the server does when it cannot read it back.
    function serveAnnotation(h, { echo = true } = {}) {
      let state = { ...h.annotation };
      h.updateAnnotation.mockImplementation(async (_assignment, _submission, _identifier, body) => {
        state = { ...state, ...body, page_index: body.page_index ?? state.page_index };
        return echo ? { success: true, annotation: { ...state } } : { success: true };
      });
    }

    const entries = (h) => Object.values(h.options.getAnnotationsData()).flat();
    // What an action leaves behind, ownership included. The rect is compared only where the action sets it:
    // a highlight PUT has the server recompute it.
    const stateOf = (entry) => ({
      source: entry.source,
      original_source: entry.original_source,
      grader_name: entry.grader_name,
      content: entry.content,
      color: entry.color,
      page_index: entry.page_index,
      quads: entry.quads,
      anchor_text: entry.anchor_text,
    });
    const historyOps = (h, type) => {
      const { local, controller } = h.getUndoStacks();
      return {
        local: local.filter((op) => op.type === type),
        controller: controller.filter((op) => op.type === type),
      };
    };

    async function saveSidebarEdit(h, text) {
      h.controller.beginEdit(0, 'owned-comment', 'ann-0-owned-comment');
      document.getElementById('edit-annotation-text-owned-comment').value = text;
      await h.controller.saveAnnotationEdit('owned-comment');
    }

    async function settle() {
      await vi.advanceTimersByTimeAsync(350);
    }

    // Ctrl+Z, then the given redo shortcut, each awaited until its request has been made.
    async function undoThenRedo(h, request, redoInit) {
      const before = request.mock.calls.length;
      h.dispatchUndo();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(before + 1));
      await settle();
      h.dispatchRedo(redoInit);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(before + 2));
      await settle();
    }

    // One action, then Ctrl+Z, then a redo shortcut, with the annotation read after each step. The action makes
    // exactly one update request, so the undo makes the second and the redo the third.
    async function throughHistory(h, action, redoInit) {
      await action();
      await settle();
      const afterDo = stateOf(entries(h)[0]);
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      const afterUndo = stateOf(entries(h)[0]);
      h.dispatchRedo(redoInit);
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      await settle();
      return { afterDo, afterUndo, afterRedo: stateOf(entries(h)[0]) };
    }

    it('redoes a sidebar edit of an AI annotation, which keeps it AI throughout', async () => {
      const h = await splitHarness();
      serveAnnotation(h);

      const { afterDo, afterUndo, afterRedo } = await throughHistory(h, () => saveSidebarEdit(h, 'Edited feedback'));

      expect(afterDo).toMatchObject({ content: 'Edited feedback', source: 'AI', original_source: 'AI' });
      expect(afterUndo).toMatchObject({ content: 'Teacher feedback', source: 'AI', original_source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      expect(h.updateAnnotation.mock.calls[1][3]).toEqual({ content: 'Teacher feedback' });
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.expectBucket('AI');
      // The edit is back on both undo stacks, so Ctrl+Z undoes it again with the same request as before.
      expect(historyOps(h, 'edit')).toEqual({ local: [expect.anything()], controller: [expect.anything()] });
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      expect(h.updateAnnotation.mock.calls[3]).toEqual(h.updateAnnotation.mock.calls[1]);
    });

    it('redoes a sidebar edit of a HUMAN annotation, which keeps it HUMAN throughout', async () => {
      const h = await splitHarness({ source: 'HUMAN' });
      serveAnnotation(h);

      const { afterDo, afterUndo, afterRedo } = await throughHistory(h, () => saveSidebarEdit(h, 'Edited feedback'));

      expect(afterDo).toMatchObject({ content: 'Edited feedback', source: 'HUMAN', original_source: 'AI' });
      expect(afterUndo).toMatchObject({ content: 'Teacher feedback', source: 'HUMAN', original_source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.expectBucket('HUMAN');
    });

    it('Ctrl+Shift+Z redoes an inline edit with the original request, keeping its ownership', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      const label = inlineLabelFor(h, h.annotation.content);

      const { afterDo, afterUndo, afterRedo } = await throughHistory(
        h,
        () => window.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, 'Edited inline'),
        { key: 'Z', ctrlKey: true, shiftKey: true },
      );

      expect(afterDo).toMatchObject({ content: 'Edited inline', source: 'AI', original_source: 'AI' });
      expect(afterUndo).toMatchObject({ content: 'Teacher feedback', source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.expectBucket('AI');
      expect(historyOps(h, 'edit').local).toHaveLength(1);
    });

    it('redoes a priority change with the original request, keeping its ownership', async () => {
      const h = await splitHarness();
      serveAnnotation(h);

      const { afterDo, afterUndo, afterRedo } = await throughHistory(
        h, () => h.options.helpers.updateAnnotationPriority(0, 'owned-comment', 'red'),
      );

      expect(afterDo).toMatchObject({ color: 'red', source: 'AI', original_source: 'AI' });
      expect(afterUndo.color).not.toBe('red');
      expect(afterUndo).toMatchObject({ source: 'AI', original_source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.expectBucket('AI');
      expect(historyOps(h, 'priority').local).toHaveLength(1);
    });

    // "Update succeeded but annotation couldn't be retrieved": the server stored the colour and, the request
    // naming no source, kept the annotation AI. The local copy must say so after the change, its undo and redo.
    it('keeps a priority change answered without its annotation AI through undo and redo', async () => {
      const h = await splitHarness();
      serveAnnotation(h, { echo: false });

      const { afterDo, afterUndo, afterRedo } = await throughHistory(
        h, () => h.options.helpers.updateAnnotationPriority(0, 'owned-comment', 'red'),
      );

      expect(afterDo).toMatchObject({ color: 'red', source: 'AI', original_source: 'AI' });
      expect(afterUndo.color).not.toBe('red');
      expect(afterUndo).toMatchObject({ source: 'AI', original_source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      h.expectBucket('AI');
    });

    it.each([
      ['a same-page ownership move', 0, true],
      ['a cross-page ownership move', 1, true],
      ['a same-page move', 0, false],
    ])('redoes %s with the original request, its ownership included', async (_name, targetPage, transfer) => {
      const startSource = transfer ? 'AI' : 'HUMAN';
      const h = await splitHarness({ source: startSource });
      serveAnnotation(h);
      const placed = () => ({ ...stateOf(entries(h)[0]), rect: entries(h)[0].rect });
      await window.PdfPreviewModal.__test.updateAnnotationPosition(0, targetPage, 'owned-comment', h.marker, transfer);
      await settle();
      const afterMove = placed();
      expect(afterMove).toMatchObject({ page_index: targetPage, source: 'HUMAN', original_source: 'AI' });

      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      expect(placed()).toMatchObject({ page_index: 0, source: startSource, original_source: 'AI' });
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      await settle();

      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      expect(placed()).toEqual(afterMove);
      h.expectBucket('HUMAN');
      expect(historyOps(h, 'move').local).toHaveLength(1);
      // Undo works again after the redo, with the same request as the first undo.
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      expect(h.updateAnnotation.mock.calls[3]).toEqual(h.updateAnnotation.mock.calls[1]);
    });

    it('redoes a highlight resize with the original request, moving ownership to HUMAN and back', async () => {
      const h = await splitHarness();
      serveAnnotation(h);

      const { afterDo, afterUndo, afterRedo } = await throughHistory(h, () => h.controller.persistHighlightExtend(
        h.marker, h.annotation, { pageIdx: 0, quadsPdf: [[50, 722, 220, 742]], anchorText: 'resized answer text' },
      ));

      expect(afterDo).toMatchObject({ anchor_text: 'resized answer text', source: 'HUMAN', original_source: 'AI' });
      expect(afterUndo).toMatchObject({ anchor_text: 'answer text', source: 'AI', original_source: 'AI' });
      expect(afterRedo).toEqual(afterDo);
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.expectBucket('HUMAN');
      expect(historyOps(h, 'highlight-extend')).toEqual({
        local: [expect.anything()],
        controller: [expect.anything()],
      });
    });

    // The tethered-highlight drag persists ownership with a source-only request and records no operation, so
    // undo and redo leave its transfer alone.
    it('leaves a source-only ownership transfer out of the undo and redo history', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      h.marker.dataset.annotationSource = 'HUMAN'; // the drag's optimistic flip
      await window.PdfPreviewModal.__test.persistAnchoredOwnershipTransfer(h.marker, 'owned-comment');
      expect(h.updateAnnotation.mock.calls[0][3]).toEqual({ source: 'HUMAN' });
      expect(stateOf(entries(h)[0])).toMatchObject({ source: 'HUMAN', original_source: 'AI' });

      h.dispatchUndo();
      await settle();
      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(1);
      expect(stateOf(entries(h)[0])).toMatchObject({ source: 'HUMAN', original_source: 'AI' });
      h.expectBucket('HUMAN');
    });

    // A highlight resized through the modal's own fallback: the controller has no highlight support. The fake
    // endpoint keeps its state, and a highlight PUT recreates the PDF annotation, so each answer has a new xref.
    async function fallbackHighlightResized() {
      const highlight = {
        stable_id: 'hl-1', xref: 70, page_index: 0, type: 'Highlight', content: 'Check the sign',
        quads: [[50, 50, 150, 70]], anchor_text: 'answer text', rect: [50, 50, 150, 70], source: 'AI',
      };
      let state = { ...highlight };
      const updateAnnotation = vi.fn(async (_assignment, _submission, _identifier, body) => {
        state = { ...state, ...body, xref: state.xref + 1 };
        return { success: true, annotation: { ...state } };
      });
      const anchor = { init: vi.fn(), select: vi.fn(), deselect: vi.fn() };
      window.PdfPreviewModalHighlightAnchor = anchor;
      const h = await undoHarness({
        updateAnnotation,
        performHighlightExtendUndo: null,
        visibilityController: {},
        annotations: { 0: [{ ...highlight }] },
      });
      document.getElementById('pdfGradedContainer').innerHTML = `
        <div class="pdf-page-wrapper" data-page-num="1"><div class="pdf-annotation-overlay">
          <div class="annotation-marker" data-annotation-anchored="true" data-annotation-page="0"
            data-annotation-xref="70" data-annotation-request-id="hl-1"></div>
        </div></div>`;
      h.clickMarker({ pageIdx: 0, identifier: 'hl-1' });
      const { onExtendCompleted } = anchor.init.mock.calls[0][0];
      const [marker, selected] = anchor.select.mock.calls[0];
      await onExtendCompleted(marker, selected, {
        pageIdx: 0, quadsPdf: [[50, 722, 220, 742]], anchorText: 'resized answer text',
      });
      const resized = { quads: [[50, 722, 220, 742]], anchor_text: 'resized answer text', source: 'HUMAN' };
      expect(h.handle.getAnnotations()[0][0]).toMatchObject(resized);
      return { h, updateAnnotation, resized };
    }

    // A sidebar delete, then (unless undo is false) its undo, which recreates the annotation with a new xref
    // (or none).
    async function deletedThenRestored({ withoutXref = false, undo = true } = {}) {
      let fixture;
      let nextXref = 43;
      const createAnnotation = vi.fn(async (_assignment, _submission, body) => ({
        success: true, annotation: { ...fixture, ...body, xref: withoutXref ? null : nextXref++ },
      }));
      const deleteAnnotation = vi.fn().mockResolvedValue({ success: true });
      const h = await splitHarness({ createAnnotation, deleteAnnotation });
      fixture = h.annotation;
      await h.controller.deleteAnnotation(0, 'owned-comment');
      expect(deleteAnnotation).toHaveBeenCalledTimes(1);
      expect(entries(h)).toEqual([]);
      await settle();
      if (!undo) return { h, createAnnotation, deleteAnnotation };

      h.dispatchUndo();
      await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => h.expectBucket('AI'));
      await settle();
      return { h, createAnnotation, deleteAnnotation };
    }

    // A pen stroke deleted with the Delete key, then (unless undo is false) its undo, which recreates it as
    // stroke-2.
    async function strokeDeletedThenRestored({ undo = true } = {}) {
      const selection = { deleteSelected: vi.fn(), deselect: vi.fn(), destroy: vi.fn(), init: vi.fn() };
      window.PdfPreviewModalMarkupSelection = selection;
      const createAnnotation = vi.fn(async (_assignment, _submission, body) => ({
        success: true, annotation: { ...body, stable_id: 'stroke-2', xref: 61 },
      }));
      const deleteAnnotation = vi.fn().mockResolvedValue({ success: true });
      const h = await undoHarness({
        createAnnotation,
        deleteAnnotation,
        visibilityController: {}, // the undo and the redo re-render the page overlay
        annotations: {
          0: [{ stable_id: 'stroke-1', xref: 60, page_index: 0, type: 'drawing', content: '', source: 'HUMAN' }],
        },
      });
      selection.deleteSelected.mockReturnValue({
        type: 'stroke',
        pageIdx: 0,
        entry: {
          annotationId: 'stroke-1',
          content: '',
          color: { name: 'red', rgb: [1, 0, 0] },
          points: [{ x: 10, y: 92 }, { x: 20, y: 102 }],
        },
      });
      selection.onDeleteRequested();
      await vi.waitFor(() => expect(h.getUndoStacks().local).toHaveLength(1));
      expect(h.handle.getAnnotations()).toEqual({});
      await settle();
      if (!undo) return { h, createAnnotation, deleteAnnotation };

      h.dispatchUndo();
      await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(h.handle.getAnnotations()[0]).toEqual([
        expect.objectContaining({ stable_id: 'stroke-2' }),
      ]));
      await settle();
      return { h, createAnnotation, deleteAnnotation };
    }

    it('redoes a highlight resize through the modal fallback when the controller has no highlight support', async () => {
      const { h, updateAnnotation, resized } = await fallbackHighlightResized();

      await undoThenRedo(h, updateAnnotation);

      expect(updateAnnotation.mock.calls[1][3]).toMatchObject({ anchor_text: 'answer text', source: 'AI' });
      expect(updateAnnotation.mock.calls[2]).toEqual(updateAnnotation.mock.calls[0]);
      expect(h.handle.getAnnotations()[0][0]).toMatchObject(resized);
      h.handle.destroy();
    });

    it('Ctrl+Y re-deletes an annotation whose deletion was undone, with the original request', async () => {
      const { h, createAnnotation, deleteAnnotation } = await deletedThenRestored();

      h.dispatchRedo();
      await vi.waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(2));

      expect(deleteAnnotation.mock.calls[1]).toEqual(deleteAnnotation.mock.calls[0]);
      await vi.waitFor(() => expect(entries(h)).toEqual([]));
      expect(historyOps(h, 'delete')).toEqual({ local: [expect.anything()], controller: [expect.anything()] });
      // Undo recreates it again, with the same request as the first undo and its AI ownership.
      h.dispatchUndo();
      await vi.waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(2));
      expect(createAnnotation.mock.calls[1]).toEqual(createAnnotation.mock.calls[0]);
      await vi.waitFor(() => h.expectBucket('AI'));
      h.handle.destroy();
    });

    it('Ctrl+Y re-deletes a pen stroke whose deletion was undone', async () => {
      const { h, deleteAnnotation } = await strokeDeletedThenRestored();

      h.dispatchRedo();
      await vi.waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(2));

      const [assignment, submission, , options] = deleteAnnotation.mock.calls[0];
      expect(deleteAnnotation.mock.calls[1]).toEqual([assignment, submission, 'stroke-2', options]);
      await vi.waitFor(() => expect(h.handle.getAnnotations()).toEqual({}));
      expect(h.getUndoStacks().local).toEqual([expect.objectContaining({ type: 'delete-markup' })]);
      h.handle.destroy();
    });

    it.each([
      ['Ctrl+Y', { key: 'y', ctrlKey: true }],
      ['Ctrl+Shift+Z', { key: 'Z', ctrlKey: true, shiftKey: true }],
      ['Ctrl+Shift+Z reported as a lower-case key', { key: 'z', ctrlKey: true, shiftKey: true }],
      ['Cmd+Y', { key: 'y', metaKey: true }],
      ['Cmd+Shift+Z', { key: 'Z', metaKey: true, shiftKey: true }],
    ])('%s redoes the last undone operation', async (_name, init) => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');

      await undoThenRedo(h, h.updateAnnotation, init);

      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.handle.destroy();
    });

    it.each(['textarea', 'input'])('leaves Ctrl+Y to the browser inside a %s', async (tag) => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle(); // the undo has landed, so its operation is on the redo stack
      const field = document.createElement(tag);
      document.body.appendChild(field);

      const event = h.dispatchRedo({ key: 'y', ctrlKey: true }, field);
      await settle();

      expect(event.defaultPrevented).toBe(false);
      expect(h.updateAnnotation).toHaveBeenCalledTimes(2);
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      h.handle.destroy();
    });

    it('treats Ctrl+Y with nothing to redo as a no-op', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      h.dispatchRedo();
      await settle();
      expect(h.updateAnnotation).not.toHaveBeenCalled();
      await saveSidebarEdit(h, 'Edited feedback');
      await undoThenRedo(h, h.updateAnnotation);
      const stacks = h.getUndoStacks();

      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(3);
      expect(h.getUndoStacks()).toEqual(stacks);
      expect(errorToasts()).toEqual([]);
      h.handle.destroy();
    });

    it.each([
      ['a sidebar edit, recorded by the controller', (h) => saveSidebarEdit(h, 'Another edit')],
      [
        'a marker move, recorded by the modal',
        (h) => window.PdfPreviewModal.__test.updateAnnotationPosition(0, 0, 'owned-comment', h.marker, false),
      ],
    ])('a new operation after an undo clears redo: %s', async (_name, newOperation) => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      await undoThenRedo(h, h.updateAnnotation); // redo is available after an undo
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      await settle();

      await newOperation(h);
      await settle();
      const callsAfterNewOperation = h.updateAnnotation.mock.calls.length;
      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(callsAfterNewOperation);
      h.handle.destroy();
    });

    it('clearing the undo history also clears redo', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      await undoThenRedo(h, h.updateAnnotation);
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      await settle(); // the undo has landed, so its operation is on the redo stack

      h.controller.clearUndoStack();
      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(4);
      h.handle.destroy();
    });

    it('switching to another document clears redo', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      await undoThenRedo(h, h.updateAnnotation);
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      await settle(); // the undo has landed, so its operation is on the redo stack

      h.handle.close();
      const next = window.PdfPreviewModal.createPdfPreviewModal({
        assignmentId: 'assignment-1', submissionId: 'submission-2', modeAdapter: h.adapter,
      });
      opened.push(next);
      await next.open();
      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(4);
      next.destroy();
    });

    // The modal's own undo stack outlived the document it was recorded on: after another submission opened,
    // Ctrl+Z replayed the previous submission's edit against the new submission's annotation of the same id.
    it('switching to another document does not undo the previous document\'s operations', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      await settle();

      h.handle.close();
      const next = window.PdfPreviewModal.createPdfPreviewModal({
        assignmentId: 'assignment-1', submissionId: 'submission-2', modeAdapter: h.adapter,
      });
      opened.push(next);
      await next.open();
      h.dispatchUndo();
      await settle();

      expect(h.updateAnnotation.mock.calls.map(([, submission]) => submission)).toEqual(['submission-1']);
      expect(h.getUndoStacks()).toEqual({ local: [], controller: [] });
    });

    it('ignores Ctrl+Y while an undo is still in flight', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'First edit');
      await saveSidebarEdit(h, 'Second edit');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      await settle();
      let finishUndo;
      h.updateAnnotation.mockImplementationOnce(() => new Promise((done) => { finishUndo = done; }));
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));

      h.dispatchRedo(); // the second edit is on the redo stack, but the first edit's undo has not landed
      await settle();
      expect(h.updateAnnotation).toHaveBeenCalledTimes(4);

      finishUndo({ success: true, annotation: { ...h.annotation } });
      await settle();
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(5));
      await settle();
      expect(h.updateAnnotation.mock.calls[4]).toEqual(h.updateAnnotation.mock.calls[0]);
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(6));
      expect(h.updateAnnotation.mock.calls[5]).toEqual(h.updateAnnotation.mock.calls[1]);
      h.handle.destroy();
    });

    it('keeps a failed redo queued so Ctrl+Y can retry it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      h.updateAnnotation.mockRejectedValueOnce(new Error('network down'));

      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(errorToasts()).toContain('Failed to redo edit'));
      expect(historyOps(h, 'edit')).toEqual({ local: [], controller: [] });

      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));
      expect(h.updateAnnotation.mock.calls[3]).toEqual(h.updateAnnotation.mock.calls[0]);
      await vi.waitFor(() => h.expectBucket('AI'));
      h.handle.destroy();
    });

    it('drops a redo whose annotation no longer exists', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = await splitHarness();
      serveAnnotation(h);
      await window.PdfPreviewModal.__test.updateAnnotationPosition(0, 0, 'owned-comment', h.marker, true);
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      const pageAnnotations = h.options.getAnnotationsData()[0];
      const removed = pageAnnotations.splice(0, pageAnnotations.length); // another reviewer deleted it

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain('Annotation no longer exists'));
      expect(h.updateAnnotation).toHaveBeenCalledTimes(2);

      // Dropped, not re-queued: with the annotation back, there is still nothing to redo.
      pageAnnotations.push(...removed);
      h.dispatchRedo();
      await settle();
      expect(h.updateAnnotation).toHaveBeenCalledTimes(2);
      h.handle.destroy();
    });

    it('keeps at most MAX_UNDO_STACK_SIZE (50) redo entries, dropping the earliest undone', async () => {
      const edit = (identifier, undoTimestamp) => ({
        type: 'edit', identifier, pageIdx: 0, oldContent: 'old', newContent: 'new', undoTimestamp,
      });
      // The controller and the modal cap their undo stacks separately, so together they can hold 100 entries.
      const controllerUndoStack = Array.from({ length: 50 }, (_value, i) => edit(`controller-${i}`, i + 1));
      const updateAnnotation = vi.fn().mockResolvedValue({ success: true });
      // An overlay renderer, because each undo and redo re-renders the page overlay.
      const h = await undoHarness({ controllerUndoStack, updateAnnotation, visibilityController: {} });
      for (let i = 0; i < 50; i += 1) {
        h.pushLocalUndo(edit(`local-${i}`, 1000 + i));
      }
      // Each step settles before the next key: a shortcut pressed while one is in flight is ignored.
      for (let undone = 1; undone <= 100; undone += 1) {
        h.dispatchUndo();
        await vi.waitFor(() => expect(updateAnnotation).toHaveBeenCalledTimes(undone));
        await settle();
      }

      for (let redone = 1; redone <= 50; redone += 1) {
        h.dispatchRedo();
        await vi.waitFor(() => expect(updateAnnotation).toHaveBeenCalledTimes(100 + redone));
        await settle();
      }
      h.dispatchRedo();
      await settle();

      expect(updateAnnotation).toHaveBeenCalledTimes(150);
      // The last 50 undone (the oldest edits) survive the cap and redo oldest first.
      expect(updateAnnotation.mock.calls[100][2]).toBe('controller-0');
      expect(updateAnnotation.mock.calls[149][2]).toBe('controller-49');
      h.handle.destroy();
    });

    // A request that can be retried later keeps its operation queued; one whose annotation is gone drops it.
    const networkDown = (request) => request.mockRejectedValueOnce(new Error('network down'));
    const notFound = (request) => request.mockRejectedValueOnce(
      Object.assign(new Error('Annotation not found'), { status: 404 }),
    );

    it.each([
      ['a network error keeps it queued', networkDown, 'Failed to redo move', true],
      ['an answer that the annotation is gone drops it', notFound, 'Annotation no longer exists', false],
    ])('a move redo that fails: %s', async (_name, fail, toast, queued) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const h = await splitHarness();
      serveAnnotation(h);
      await window.PdfPreviewModal.__test.updateAnnotationPosition(0, 0, 'owned-comment', h.marker, true);
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      fail(h.updateAnnotation);

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain(toast));
      await settle();
      expect(h.updateAnnotation).toHaveBeenCalledTimes(3);
      h.dispatchRedo();
      await settle();

      expect(h.updateAnnotation.mock.calls.slice(3)).toEqual(queued ? [h.updateAnnotation.mock.calls[0]] : []);
    });

    it.each([
      [
        'a refusal keeps it queued',
        (request) => request.mockResolvedValueOnce({ success: false, error: 'locked' }),
        'Failed to redo deletion',
        true,
      ],
      [
        'a refusal because the annotation is gone drops it',
        (request) => request.mockResolvedValueOnce({ success: false, status: 404, error: 'Annotation not found' }),
        'Annotation no longer exists',
        false,
      ],
      ['a network error keeps it queued', networkDown, 'Failed to redo deletion', true],
      ['an error that the annotation is gone drops it', notFound, 'Annotation no longer exists', false],
    ])('a delete redo that fails: %s', async (_name, fail, toast, queued) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      // The recreated annotation has no xref, so the redo finds it by its stable id alone.
      const { h, deleteAnnotation } = await deletedThenRestored({ withoutXref: true });
      fail(deleteAnnotation);

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain(toast));
      await settle();
      expect(deleteAnnotation).toHaveBeenCalledTimes(2);
      expect(entries(h)).toHaveLength(1);
      h.dispatchRedo();
      await settle();

      expect(deleteAnnotation.mock.calls.slice(2)).toEqual(queued ? [deleteAnnotation.mock.calls[0]] : []);
    });

    it('drops a delete redo whose recreated annotation is gone', async () => {
      const { h, deleteAnnotation } = await deletedThenRestored();
      const pageAnnotations = h.options.getAnnotationsData()[0];
      const removed = pageAnnotations.splice(0, pageAnnotations.length); // another reviewer deleted it

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain('Annotation no longer exists'));
      await settle();
      // Dropped, not re-queued: with the annotation back, there is still nothing to redo.
      pageAnnotations.push(...removed);
      h.dispatchRedo();
      await settle();

      expect(deleteAnnotation).toHaveBeenCalledTimes(1);
    });

    it('a pen-stroke delete redo that fails stays queued', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { h, deleteAnnotation } = await strokeDeletedThenRestored();
      networkDown(deleteAnnotation);

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain('Failed to redo deletion'));
      await settle();
      expect(h.handle.getAnnotations()[0]).toHaveLength(1);
      h.dispatchRedo();
      await vi.waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(3));

      await vi.waitFor(() => expect(h.handle.getAnnotations()).toEqual({}));
    });

    it.each([
      [
        'a refusal keeps it queued',
        ({ request }) => { request.mockResolvedValueOnce({ success: false, error: 'conflict' }); },
        'Failed to redo highlight change',
        true,
      ],
      ['a network error keeps it queued', ({ request }) => { networkDown(request); }, 'Failed to redo highlight change', true],
      [
        'a refusal because the highlight is gone drops it',
        ({ request }) => { request.mockResolvedValueOnce({ success: false, status: 404 }); },
        'Annotation no longer exists',
        false,
      ],
      ['an error that the highlight is gone drops it', ({ request }) => { notFound(request); }, 'Annotation no longer exists', false],
      [
        'a highlight deleted meanwhile drops it',
        ({ h }) => {
          const pageAnnotations = h.getAnnotationsData()[0];
          const removed = pageAnnotations.splice(0, pageAnnotations.length);
          return () => pageAnnotations.push(...removed);
        },
        'Annotation no longer exists',
        false,
      ],
    ])('a highlight redo through the modal fallback that fails: %s', async (_name, fail, toast, queued) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { h, updateAnnotation } = await fallbackHighlightResized();
      h.dispatchUndo();
      await vi.waitFor(() => expect(updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      const restore = fail({ h, request: updateAnnotation }) || (() => {});

      h.dispatchRedo();
      await vi.waitFor(() => expect(errorToasts()).toContain(toast));
      await settle();
      restore();
      const callsAfterFailure = updateAnnotation.mock.calls.length;
      h.dispatchRedo();
      await settle();

      expect(updateAnnotation.mock.calls.slice(callsAfterFailure)).toEqual(
        queued ? [updateAnnotation.mock.calls[0]] : [],
      );
    });

    it('ignores Ctrl+Z while a redo is still in flight', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'First edit');
      await saveSidebarEdit(h, 'Second edit');
      h.dispatchUndo(); // undoes the second edit
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      await settle();
      let finishRedo;
      h.updateAnnotation.mockImplementationOnce(() => new Promise((done) => { finishRedo = done; }));
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(4));

      h.dispatchUndo(); // the first edit is on the undo stack, but the redo has not landed
      await settle();
      expect(h.updateAnnotation).toHaveBeenCalledTimes(4);

      finishRedo({ success: true, annotation: { ...h.annotation, content: 'Second edit' } });
      await settle();
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(5));
      // The redone second edit is undone again, not the first.
      expect(h.updateAnnotation.mock.calls[4]).toEqual(h.updateAnnotation.mock.calls[2]);
    });

    it('redoes once when Ctrl+Y is pressed again while a redo is in flight', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'First edit');
      await saveSidebarEdit(h, 'Second edit');
      for (let undone = 1; undone <= 2; undone += 1) {
        h.dispatchUndo();
        await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2 + undone));
        await settle();
      }
      let finishRedo;
      h.updateAnnotation.mockImplementationOnce(() => new Promise((done) => { finishRedo = done; }));
      h.dispatchRedo(); // redoes the first edit
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(5));

      h.dispatchRedo(); // the second edit is still on the redo stack
      await settle();
      expect(h.updateAnnotation).toHaveBeenCalledTimes(5);

      finishRedo({ success: true, annotation: { ...h.annotation, content: 'First edit' } });
      await settle();
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(6));
      expect(h.updateAnnotation.mock.calls[4]).toEqual(h.updateAnnotation.mock.calls[0]);
      expect(h.updateAnnotation.mock.calls[5]).toEqual(h.updateAnnotation.mock.calls[1]);
    });

    it('does not record an operation that lands while a redo is in flight, as during an undo', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();
      let finishRedo;
      h.updateAnnotation.mockImplementationOnce(() => new Promise((done) => { finishRedo = done; }));
      h.dispatchRedo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));

      // A marker move lands while the redo request is still out.
      await window.PdfPreviewModal.__test.updateAnnotationPosition(0, 0, 'owned-comment', h.marker, false);
      finishRedo({ success: true, annotation: { ...h.annotation, content: 'Edited feedback' } });
      await settle();

      expect(h.updateAnnotation).toHaveBeenCalledTimes(4);
      expect(historyOps(h, 'move').local).toEqual([]);
      expect(historyOps(h, 'edit')).toEqual({ local: [expect.anything()], controller: [expect.anything()] });
    });

    it('reopening the same document keeps its redo history', async () => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();

      h.handle.close();
      await h.handle.open();
      h.dispatchRedo();

      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
      expect(h.updateAnnotation.mock.calls[2]).toEqual(h.updateAnnotation.mock.calls[0]);
    });

    it.each([
      ['Y without a modifier', { key: 'y' }],
      ['Ctrl+Shift+Y', { key: 'Y', ctrlKey: true, shiftKey: true }],
      ['Ctrl+X', { key: 'x', ctrlKey: true }],
      ['Ctrl with no key', { ctrlKey: true }],
    ])('%s does not redo', async (_name, init) => {
      const h = await splitHarness();
      serveAnnotation(h);
      await saveSidebarEdit(h, 'Edited feedback');
      h.dispatchUndo();
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(2));
      await settle();

      const event = h.dispatchRedo(init);
      await settle();

      expect(event.defaultPrevented).toBe(false);
      expect(h.updateAnnotation).toHaveBeenCalledTimes(2);
      h.dispatchRedo(); // Ctrl+Y still redoes it
      await vi.waitFor(() => expect(h.updateAnnotation).toHaveBeenCalledTimes(3));
    });

    // Review finding 3: a request the server refuses ({success: false}) is a failure. Nothing is applied locally,
    // both undo stacks keep their contents, and the step can be retried.
    const refuse = (request) => request.mockResolvedValueOnce({ success: false, error: 'locked' });

    // Each flow performs its action and names the requests its undo and its redo make.
    const REFUSABLE_FLOWS = {
      edit: {
        undoMessage: 'Failed to undo edit',
        redoMessage: 'Failed to redo edit',
        async act() {
          const h = await splitHarness();
          serveAnnotation(h);
          await saveSidebarEdit(h, 'Edited feedback');
          await settle();
          return { h, undoRequest: h.updateAnnotation, redoRequest: h.updateAnnotation };
        },
      },
      move: {
        undoMessage: 'Failed to undo move',
        redoMessage: 'Failed to redo move',
        async act() {
          const h = await splitHarness();
          serveAnnotation(h);
          await window.PdfPreviewModal.__test.updateAnnotationPosition(0, 0, 'owned-comment', h.marker, true);
          await settle();
          return { h, undoRequest: h.updateAnnotation, redoRequest: h.updateAnnotation };
        },
      },
      delete: {
        undoMessage: 'Failed to undo deletion',
        async act() {
          const { h, createAnnotation, deleteAnnotation } = await deletedThenRestored({ undo: false });
          return { h, undoRequest: createAnnotation, redoRequest: deleteAnnotation };
        },
      },
      'pen-stroke delete': {
        undoMessage: 'Failed to undo deletion',
        redoMessage: 'Failed to redo deletion',
        async act() {
          const { h, createAnnotation, deleteAnnotation } = await strokeDeletedThenRestored({ undo: false });
          return { h, undoRequest: createAnnotation, redoRequest: deleteAnnotation };
        },
      },
    };

    it.each(['edit', 'move', 'delete', 'pen-stroke delete'])(
      'a refused undo of a %s changes nothing and can be retried',
      async (name) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const flow = REFUSABLE_FLOWS[name];
        const { h, undoRequest, redoRequest } = await flow.act();
        const annotationsBefore = h.handle.getAnnotations();
        const stacksBefore = h.getUndoStacks();
        const undoCalls = undoRequest.mock.calls.length;
        const redoCalls = redoRequest.mock.calls.length;
        refuse(undoRequest);

        h.dispatchUndo();
        await vi.waitFor(() => expect(errorToasts()).toContain(flow.undoMessage));
        await settle();

        expect(undoRequest).toHaveBeenCalledTimes(undoCalls + 1);
        expect(h.handle.getAnnotations()).toEqual(annotationsBefore);
        expect(h.getUndoStacks()).toEqual(stacksBefore);
        // Nothing was undone, so nothing can be redone; Ctrl+Z sends the same undo again.
        h.dispatchRedo();
        await settle();
        expect(redoRequest).toHaveBeenCalledTimes(redoCalls + (redoRequest === undoRequest ? 1 : 0));
        h.dispatchUndo();
        await vi.waitFor(() => expect(undoRequest).toHaveBeenCalledTimes(undoCalls + 2));
        expect(undoRequest.mock.calls.at(-1)).toEqual(undoRequest.mock.calls.at(-2));
      },
    );

    it.each(['edit', 'move', 'pen-stroke delete'])(
      'a refused redo of a %s changes nothing and can be retried',
      async (name) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const flow = REFUSABLE_FLOWS[name];
        const { h, undoRequest, redoRequest } = await flow.act();
        const undoCalls = undoRequest.mock.calls.length;
        h.dispatchUndo();
        await vi.waitFor(() => expect(undoRequest).toHaveBeenCalledTimes(undoCalls + 1));
        await settle();
        const annotationsBefore = h.handle.getAnnotations();
        const stacksBefore = h.getUndoStacks();
        const redoCalls = redoRequest.mock.calls.length;
        refuse(redoRequest);

        h.dispatchRedo();
        await vi.waitFor(() => expect(errorToasts()).toContain(flow.redoMessage));
        await settle();

        expect(redoRequest).toHaveBeenCalledTimes(redoCalls + 1);
        // The server kept its state, so the page does too, and nothing went back on the undo stacks: Ctrl+Z
        // cannot replay the undo over an annotation that was never removed again.
        expect(h.handle.getAnnotations()).toEqual(annotationsBefore);
        expect(h.getUndoStacks()).toEqual(stacksBefore);
        h.dispatchRedo();
        await vi.waitFor(() => expect(redoRequest).toHaveBeenCalledTimes(redoCalls + 2));
        expect(redoRequest.mock.calls.at(-1)).toEqual(redoRequest.mock.calls.at(-2));
      },
    );
  });
});
