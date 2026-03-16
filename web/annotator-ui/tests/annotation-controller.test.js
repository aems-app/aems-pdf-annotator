import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/annotation-controller.js';

const loadAnnotationControllerModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalAnnotationController;
};

describe('annotation-controller state ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalAnnotationController;
    delete window.PdfPreviewModalCrud;
    delete window.PdfPreviewModalSidebarPanel;
    window.PdfPreviewModalUtils = {
      debugLog: () => {},
      PLACEHOLDER_STRINGS: ['', 'New comment...', 'New comment'],
    };
    window.PdfPreviewModalSidebarPanel = {
      EMPTY_STATE_MESSAGE: 'No comments visible in viewport',
      shouldDisplayAnnotation: (_ann, isVisible) => !!isVisible,
    };
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it('keeps the undo stack in the annotations state slice', async () => {
    const mod = await loadAnnotationControllerModule();
    const annotationsState = { undoStack: [] };
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => ({}),
    });

    controller.pushUndoOperation({ type: 'create', identifier: 'ann-1' });

    expect(controller.getUndoStack()).toEqual([{ type: 'create', identifier: 'ann-1' }]);
    expect(annotationsState.undoStack).toEqual([{ type: 'create', identifier: 'ann-1' }]);
  });

  it('selectAnnotation syncs selectedId and emits selection changes', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedCommentsList">
        <div class="list-group-item" data-annotation-page="3" data-annotation-request-id="ann-42"></div>
      </div>
      <div class="annotation-marker" data-annotation-page="3" data-annotation-request-id="ann-42"></div>
    `;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    const setSelectedAnnotation = vi.fn();
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => ({}),
      setSelectedAnnotation,
      helpers: {
        escapeCssAttribute: (value) => value,
        normalizeAnnotationIdentifierValue: (value) => value || null,
      },
    });
    const onSelectionChanged = vi.fn();
    controller.onSelectionChanged(onSelectionChanged);

    controller.selectAnnotation('ann-42', 3);

    expect(setSelectedAnnotation).toHaveBeenCalledWith({ pageIdx: 3, identifier: 'ann-42' });
    expect(annotationsState.selectedId).toBe('ann-42');
    expect(document.querySelector('.annotation-marker').classList.contains('annotation-marker-selected')).toBe(true);
    expect(document.querySelector('.list-group-item').classList.contains('active')).toBe(true);
    expect(onSelectionChanged).toHaveBeenCalledWith({ pageIdx: 3, identifier: 'ann-42' });
  });

  it('loadAnnotations fetches, normalizes, and syncs annotationsData into the state slice', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer">
        <div class="annotation-marker" data-annotation-page="0" data-annotation-request-id="ann-1"></div>
      </div>
      <div id="pdfGradedCommentsList"></div>
    `;
    document.getElementById('pdfGradedContainer').getBoundingClientRect = () => ({
      width: 600,
      height: 800,
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
    });
    document.querySelector('.annotation-marker').getBoundingClientRect = () => ({
      width: 20,
      height: 20,
      left: 10,
      top: 10,
      right: 30,
      bottom: 30,
    });
    const fakeObserver = {
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    };
    vi.stubGlobal('IntersectionObserver', class {
      observe = fakeObserver.observe;
      disconnect = fakeObserver.disconnect;
      unobserve = fakeObserver.unobserve;
    });

    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    const annotationsData = { 0: [{ id: 'ann-1', requestIdentifier: 'ann-1', content: 'Loaded annotation' }] };
    let currentAnnotationsData = {};
    const listAnnotationsRequest = vi.fn().mockResolvedValue({ success: true, annotations: annotationsData });
    const refreshMarkupFromAnnotations = vi.fn();
    const onAnnotationsLoaded = vi.fn();
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      helpers: {
        listAnnotationsRequest,
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations,
        buildAnnotationVisibilityKey: (pageIdx, params) => {
          const marker = params?.marker;
          const annotation = params?.annotation;
          return `${pageIdx}:${marker?.dataset?.annotationRequestId || annotation?.requestIdentifier}`;
        },
      },
    });
    controller.onAnnotationsLoaded(onAnnotationsLoaded);

    await controller.loadAnnotations();

    expect(listAnnotationsRequest).toHaveBeenCalledWith(1001, 501);
    expect(annotationsState.annotationsData).toEqual(annotationsData);
    expect(refreshMarkupFromAnnotations).toHaveBeenCalled();
    expect(onAnnotationsLoaded).toHaveBeenCalled();
    expect(controller.getVisibleMarkers().has('0:ann-1')).toBe(true);
    expect(document.getElementById('pdfGradedCommentsList').textContent).toContain('Loaded annotation');
  });

  it('destroy clears controller-owned state from the annotations slice', async () => {
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {
      undoStack: [{ type: 'delete' }],
      selectedId: 'ann-1',
      editingId: 'ann-1',
      annotationsData: { 0: [{ id: 'ann-1' }] },
    };
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => annotationsState.annotationsData,
    });

    controller.destroy();

    expect(annotationsState.undoStack).toEqual([]);
    expect(annotationsState.selectedId).toBe(null);
    expect(annotationsState.annotationsData).toEqual({});
  });
});
