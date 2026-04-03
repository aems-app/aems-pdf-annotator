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

  it('prefixes numeric stable IDs in sidebar request identifiers', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      helpers: {
        listAnnotationsRequest: vi.fn().mockResolvedValue({
          success: true,
          annotations: {
            0: [{
              pageIdx: 0,
              id: '123',
              stable_id: '123',
              xref: 77,
              content: 'Numeric stable id',
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();

    const item = document.querySelector('.list-group-item');
    expect(item?.dataset.annotationRequestId).toBe('id:123');
  });

  it('uses the rendered button page when canceling a temporary edit', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const deleteAnnotationSilently = vi.fn().mockResolvedValue(undefined);
    const findAnnotationEntry = vi.fn((pageIdx, identifier) => {
      if (pageIdx === 5 && identifier === 'ann-5') {
        return {
          pageIdx: 5,
          requestIdentifier: 'ann-5',
          content: '',
          _originalContent: '',
          _isTemporary: true,
        };
      }
      return null;
    });
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      getEditingAnnotationId: () => 'ann-5-ann-5',
      setEditingAnnotationId: vi.fn(),
      helpers: {
        listAnnotationsRequest: vi.fn().mockResolvedValue({
          success: true,
          annotations: {
            5: [{
              pageIdx: 5,
              id: 'ann-5',
              stable_id: 'ann-5',
              requestIdentifier: 'ann-5',
              content: '',
              _originalContent: '',
              _isTemporary: true,
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
        findAnnotationEntry,
        deleteAnnotationSilently,
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();
    document.querySelector('.cancel-edit-btn')?.click();
    await Promise.resolve();

    expect(findAnnotationEntry).toHaveBeenCalledWith(5, 'ann-5');
    expect(deleteAnnotationSilently).toHaveBeenCalledWith(5, 'ann-5');
  });

  it('keeps a new annotation editor alive when a detached pre-save textarea blurs after rerender', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <div id="pdfGradedContainer"></div>
        <div id="pdfGradedCommentsList"></div>
      `;
      window.__pdfGradedViewer = { pdf: {}, currentPage: 1 };
      window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;

      const mod = await loadAnnotationControllerModule();
      const annotationsState = {};
      let currentAnnotationsData = {};
      let editingAnnotationId = null;
      let resolveCreateRequest;
      const deleteAnnotationSilently = vi.fn().mockResolvedValue(undefined);

      const resolveIdentifier = (annotation) =>
        annotation?.stable_id || annotation?.id || (annotation?.xref != null ? String(annotation.xref) : null);

      const enhanceAnnotationEntry = (annotation) => ({
        ...annotation,
        requestIdentifier: annotation?.requestIdentifier || annotation?.stable_id || annotation?.id || (annotation?.xref != null ? String(annotation.xref) : null),
      });

      const findAnnotationIndex = (pageIdx, identifier) => {
        const pageAnnotations = currentAnnotationsData[pageIdx] || [];
        return pageAnnotations.findIndex((annotation) => (
          String(annotation.requestIdentifier || '') === String(identifier)
          || String(annotation.stable_id || '') === String(identifier)
          || String(annotation.id || '') === String(identifier)
          || String(annotation.xref || '') === String(identifier)
        ));
      };

      const findAnnotationEntry = (pageIdx, identifier) => {
        const index = findAnnotationIndex(pageIdx, identifier);
        return index >= 0 ? currentAnnotationsData[pageIdx][index] : null;
      };

      const controller = mod.createAnnotationController({
        annotationsState,
        getAnnotationsData: () => currentAnnotationsData,
        setAnnotationsData: (data) => { currentAnnotationsData = data; },
        getCurrentSubmissionId: () => 1001,
        getCurrentAssignmentId: () => 501,
        getEditingAnnotationId: () => editingAnnotationId,
        setEditingAnnotationId: (value) => { editingAnnotationId = value; },
        helpers: {
          enhanceAnnotationEntry,
          resolveAnnotationIdentifierValue: resolveIdentifier,
          buildAnnotationVisibilityKey: (pageIdx, params) => {
            const annotation = params?.annotation;
            const key = params?.identifier
              || annotation?.requestIdentifier
              || annotation?.stable_id
              || annotation?.id
              || params?.xref
              || annotation?.xref;
            return key ? `${pageIdx}:${key}` : null;
          },
          findAnnotationIndex,
          findAnnotationEntry,
          createAnnotationRequest: vi.fn().mockImplementation(() => new Promise((resolve) => {
            resolveCreateRequest = resolve;
          })),
          deleteAnnotationSilently,
          escapeCssAttribute: (value) => value,
          normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
          setupTextareaAutoResize: vi.fn(),
          refreshMarkupFromAnnotations: vi.fn(),
        },
      });

      const createPromise = controller.createTemporaryAnnotation([10, 20, 30, 40], 0);
      await vi.advanceTimersByTimeAsync(120);

      const optimisticTextarea = document.querySelector('.auto-resize-textarea');
      expect(optimisticTextarea).not.toBeNull();
      expect(optimisticTextarea.isConnected).toBe(true);

      resolveCreateRequest({
        success: true,
        annotation: {
          id: 'xref:87|id:145218ef-3812-4912-b76c-24ec1bfbd255',
          stable_id: '145218ef-3812-4912-b76c-24ec1bfbd255',
          xref: 87,
          page_index: 0,
          type: 'Text',
          rect: [10, 20, 30, 40],
          content: 'New comment...',
          source: 'HUMAN',
          color: 'amber',
        },
      });

      await createPromise;
      await vi.runAllTimersAsync();

      expect(optimisticTextarea.isConnected).toBe(false);
      expect(document.getElementById('edit-annotation-text-145218ef-3812-4912-b76c-24ec1bfbd255')).not.toBeNull();

      optimisticTextarea.dispatchEvent(new window.FocusEvent('blur', { relatedTarget: null }));
      await vi.advanceTimersByTimeAsync(150);

      expect(deleteAnnotationSilently).not.toHaveBeenCalled();
      expect(document.getElementById('edit-annotation-text-145218ef-3812-4912-b76c-24ec1bfbd255')).not.toBeNull();
    } finally {
      vi.useRealTimers();
      delete window.__pdfGradedViewer;
    }
  });
});
