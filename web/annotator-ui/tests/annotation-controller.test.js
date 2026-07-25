import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/annotation-controller.js';

const HELPERS_MODULE_PATH = '../src/pdf-preview-modal/annotation-helpers.js';

const UTILS_MODULE_PATH = '../src/pdf-preview-modal/utils.js';

const loadAnnotationControllerModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalAnnotationController;
};

const loadAnnotationHelpersModule = async () => {
  await import(new URL(HELPERS_MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalAnnotationHelpers;
};

const loadUtilsModule = async () => {
  await import(new URL(UTILS_MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalUtils;
};

describe('annotation-controller state ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalAnnotationController;
    delete window.PdfPreviewModalAnnotationHelpers;
    delete window.PdfPreviewModalCrud;
    delete window.PdfPreviewModalSidebarPanel;
    delete window.__pdfGradedViewer;
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

    expect(controller.getUndoStack()).toHaveLength(1);
    expect(controller.getUndoStack()[0]).toMatchObject({ type: 'create', identifier: 'ann-1' });
    expect(annotationsState.undoStack).toHaveLength(1);
    expect(annotationsState.undoStack[0]).toMatchObject({ type: 'create', identifier: 'ann-1' });
  });

  it('supports peeking and popping controller-owned undo operations', async () => {
    const mod = await loadAnnotationControllerModule();
    const annotationsState = { undoStack: [] };
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => ({}),
    });

    controller.pushUndoOperation({ type: 'delete', identifier: 'ann-7' });

    expect(controller.peekUndoOperation()).toMatchObject({ type: 'delete', identifier: 'ann-7' });
    const popped = controller.popUndoOperation();
    expect(popped).toMatchObject({ type: 'delete', identifier: 'ann-7' });
    expect(controller.getUndoStack()).toEqual([]);
    expect(annotationsState.undoStack).toEqual([]);
  });

  it('captures a full undo operation after completing a highlight extend', async () => {
    document.body.innerHTML = `
      <div
        class="annotation-marker source-ai"
        data-annotation-xref="42"
        data-annotation-request-id="highlight-1"
        data-annotation-source="AI"
      ></div>
    `;
    const mod = await loadAnnotationControllerModule();
    const oldQuads = [
      [10, 20, 50, 30],
      [10, 34, 80, 44],
    ];
    const newQuadsPdf = [
      [10, 770, 90, 780],
      [10, 756, 110, 766],
    ];
    const oldRect = [10, 20, 80, 44];
    const newRect = [10, 20, 110, 44];
    const annotation = {
      stable_id: 'highlight-1',
      requestIdentifier: 'highlight-1',
      xref: 42,
      page_index: 0,
      type: 'Highlight',
      quads: oldQuads,
      anchor_text: 'previous anchored phrase',
      rect: oldRect,
      source: 'AI',
      original_source: 'AI',
    };
    let currentAnnotationsData = { 0: [annotation] };
    const updateAnnotationRequest = vi.fn().mockResolvedValue({
      success: true,
      annotation: {
        ...annotation,
        quads: [
          [10, 20, 90, 30],
          [10, 34, 110, 44],
        ],
        anchor_text: 'extended anchored phrase',
        rect: newRect,
        source: 'HUMAN',
        original_source: 'AI',
        can_revert_to_ai: true,
      },
    });
    const controller = mod.createAnnotationController({
      annotationsState: { undoStack: [] },
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: ({ identifier }) => identifier,
        resolveAnnotationIdentifierValue: (ann) => ann.stable_id,
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        resolveAnnotationSource: (ann) => ann.source,
        updateAnnotationRequest,
      },
    });
    const marker = document.querySelector('.annotation-marker');

    await controller.persistHighlightExtend(marker, annotation, {
      quadsPdf: newQuadsPdf,
      anchorText: 'extended anchored phrase',
      pageIdx: 0,
    });

    expect(updateAnnotationRequest).toHaveBeenCalledWith('highlight-1', {
      quads: newQuadsPdf,
      anchor_text: 'extended anchored phrase',
      source: 'HUMAN',
    });
    expect(controller.peekUndoOperation()).toMatchObject({
      type: 'highlight-extend',
      identifier: 'highlight-1',
      xref: '42',
      requestId: 'highlight-1',
      pageIdx: 0,
      oldQuads,
      oldAnchorText: 'previous anchored phrase',
      oldRect,
      oldSource: 'AI',
      newQuads: [
        [10, 20, 90, 30],
        [10, 34, 110, 44],
      ],
      newAnchorText: 'extended anchored phrase',
      newRect,
      newSource: 'HUMAN',
      isOwnershipTransfer: true,
    });
    expect(currentAnnotationsData[0][0]).toMatchObject({
      quads: [
        [10, 20, 90, 30],
        [10, 34, 110, 44],
      ],
      anchor_text: 'extended anchored phrase',
      rect: newRect,
      source: 'HUMAN',
      original_source: 'AI',
    });
  });

  it('namespaces xref-only highlight identities when capturing extend undo', async () => {
    document.body.innerHTML = `
      <div
        class="annotation-marker source-human"
        data-annotation-xref="77"
        data-annotation-request-id="77"
        data-annotation-source="HUMAN"
      ></div>
    `;
    const mod = await loadAnnotationControllerModule();
    const helpers = await loadAnnotationHelpersModule();
    const annotation = {
      xref: 77,
      page_index: 0,
      type: 'Highlight',
      quads: [[10, 20, 50, 30]],
      anchor_text: 'legacy phrase',
      rect: [10, 20, 50, 30],
      source: 'HUMAN',
    };
    let currentAnnotationsData = { 0: [annotation] };
    const updateAnnotationRequest = vi.fn().mockResolvedValue({
      success: true,
      annotation: {
        ...annotation,
        xref: 78,
        quads: [[10, 20, 80, 30]],
        anchor_text: 'extended legacy phrase',
        rect: [10, 20, 80, 30],
      },
    });
    const controller = mod.createAnnotationController({
      annotationsState: { undoStack: [] },
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: helpers.buildApiAnnotationIdentifier,
        normalizeAnnotationIdentifierValue: helpers.normalizeAnnotationIdentifierValue,
        resolveAnnotationIdentifierValue: helpers.resolveAnnotationIdentifierValue,
        resolveAnnotationSource: helpers.resolveAnnotationSource,
        updateAnnotationRequest,
      },
    });

    await controller.persistHighlightExtend(
      document.querySelector('.annotation-marker'),
      annotation,
      {
        quadsPdf: [[10, 20, 80, 30]],
        anchorText: 'extended legacy phrase',
        pageIdx: 0,
      },
    );

    expect(updateAnnotationRequest).toHaveBeenCalledWith('xref:77', {
      quads: [[10, 20, 80, 30]],
      anchor_text: 'extended legacy phrase',
      source: 'HUMAN',
    });
    expect(controller.peekUndoOperation()).toMatchObject({
      identifier: 'xref:78',
      xref: '78',
      requestId: 'xref:77',
    });
  });

  it('restores highlight quads, anchor, rect, and AI ownership during extend undo', async () => {
    document.body.innerHTML = `
      <div
        class="annotation-marker source-human"
        data-annotation-xref="43"
        data-annotation-request-id="highlight-1"
        data-annotation-source="HUMAN"
      ></div>
    `;
    window.__pdfGradedViewer = {
      pdf: {
        getPage: vi.fn().mockResolvedValue({ view: [0, 0, 600, 800] }),
      },
    };
    const mod = await loadAnnotationControllerModule();
    const oldQuads = [
      [10, 20, 50, 30],
      [10, 34, 80, 44],
    ];
    const oldRect = [10, 20, 80, 44];
    let currentAnnotationsData = {
      0: [{
        stable_id: 'highlight-1',
        requestIdentifier: 'highlight-1',
        xref: 43,
        page_index: 0,
        type: 'Highlight',
        quads: [
          [10, 20, 90, 30],
          [10, 34, 110, 44],
        ],
        anchor_text: 'extended anchored phrase',
        rect: [10, 20, 110, 44],
        source: 'HUMAN',
        original_source: 'AI',
        can_revert_to_ai: true,
      }],
    };
    const restoredAnnotation = {
      ...currentAnnotationsData[0][0],
      quads: oldQuads,
      anchor_text: 'previous anchored phrase',
      rect: oldRect,
      source: 'AI',
      original_source: 'AI',
      can_revert_to_ai: false,
      xref: 44,
    };
    const updateAnnotationRequest = vi.fn().mockResolvedValue({
      success: true,
      annotation: restoredAnnotation,
    });
    const showToast = vi.fn();
    const controller = mod.createAnnotationController({
      annotationsState: { undoStack: [] },
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: ({ identifier }) => identifier,
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        resolveAnnotationIdentifierValue: (ann) => ann.stable_id,
        updateAnnotationRequest,
        showToast,
        translatePdfPreviewText: (text) => text,
      },
    });
    const operation = {
      type: 'highlight-extend',
      identifier: 'highlight-1',
      xref: '43',
      requestId: 'highlight-1',
      pageIdx: 0,
      oldQuads,
      oldAnchorText: 'previous anchored phrase',
      oldRect,
      oldSource: 'AI',
      newQuads: currentAnnotationsData[0][0].quads,
      newAnchorText: 'extended anchored phrase',
      newRect: currentAnnotationsData[0][0].rect,
      newSource: 'HUMAN',
      isOwnershipTransfer: true,
    };

    await controller.performHighlightExtendUndo(operation);

    expect(updateAnnotationRequest).toHaveBeenCalledWith('highlight-1', {
      quads: [
        [10, 770, 50, 780],
        [10, 756, 80, 766],
      ],
      anchor_text: 'previous anchored phrase',
      rect: [10, 756, 80, 780],
      source: 'AI',
    });
    expect(currentAnnotationsData[0][0]).toEqual(restoredAnnotation);
    expect(currentAnnotationsData[0][0]).toMatchObject({
      quads: oldQuads,
      anchor_text: 'previous anchored phrase',
      rect: oldRect,
      source: 'AI',
      original_source: 'AI',
      can_revert_to_ai: false,
    });
    expect(showToast).toHaveBeenCalledWith('success', 'Ownership reverted to AI');
  });

  it('undoes an xref-only legacy highlight while it still exists in current state', async () => {
    const mod = await loadAnnotationControllerModule();
    const helpers = await loadAnnotationHelpersModule();
    const oldQuads = [[10, 20, 50, 30]];
    const oldRect = [10, 20, 50, 30];
    let currentAnnotationsData = {
      0: [{
        xref: 77,
        page_index: 0,
        type: 'Highlight',
        quads: [[10, 20, 80, 30]],
        anchor_text: 'extended legacy phrase',
        rect: [10, 20, 80, 30],
        source: 'HUMAN',
      }],
    };
    const restoredAnnotation = {
      ...currentAnnotationsData[0][0],
      xref: 78,
      quads: oldQuads,
      anchor_text: 'legacy phrase',
      rect: oldRect,
    };
    const updateAnnotationRequest = vi.fn().mockResolvedValue({
      success: true,
      annotation: restoredAnnotation,
    });
    const showToast = vi.fn();
    const controller = mod.createAnnotationController({
      annotationsState: { undoStack: [] },
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: helpers.buildApiAnnotationIdentifier,
        normalizeAnnotationIdentifierValue: helpers.normalizeAnnotationIdentifierValue,
        resolveAnnotationIdentifierValue: helpers.resolveAnnotationIdentifierValue,
        updateAnnotationRequest,
        showToast,
        translatePdfPreviewText: (text) => text,
      },
    });

    const result = await controller.performHighlightExtendUndo({
      type: 'highlight-extend',
      identifier: '77',
      xref: '77',
      requestId: '77',
      pageIdx: 0,
      oldQuads,
      oldAnchorText: 'legacy phrase',
      oldRect,
      oldSource: 'HUMAN',
      newQuads: currentAnnotationsData[0][0].quads,
      newAnchorText: 'extended legacy phrase',
      newRect: currentAnnotationsData[0][0].rect,
      newSource: 'HUMAN',
      isOwnershipTransfer: false,
    });

    expect(result).toMatchObject({ success: true });
    expect(updateAnnotationRequest).toHaveBeenCalledWith('xref:77', {
      quads: oldQuads,
      anchor_text: 'legacy phrase',
      rect: oldRect,
      source: 'HUMAN',
    });
    expect(currentAnnotationsData[0][0]).toEqual(restoredAnnotation);
    expect(showToast).not.toHaveBeenCalledWith('error', 'Annotation no longer exists');
  });

  it('undoes consecutive highlight extends through the refreshed live identity', async () => {
    document.body.innerHTML = `
      <div
        class="annotation-marker source-ai"
        data-annotation-xref="42"
        data-annotation-request-id="highlight-1"
        data-annotation-source="AI"
      ></div>
    `;
    const mod = await loadAnnotationControllerModule();
    const helpers = await loadAnnotationHelpersModule();
    const initialQuads = [[10, 20, 50, 30]];
    const firstExtendQuads = [[10, 20, 70, 30]];
    const secondExtendQuads = [[10, 20, 90, 30]];
    let serverAnnotation = {
      stable_id: 'highlight-1',
      requestIdentifier: 'highlight-1',
      xref: 42,
      page_index: 0,
      type: 'Highlight',
      quads: initialQuads,
      anchor_text: 'initial phrase',
      rect: [10, 20, 50, 30],
      source: 'AI',
      original_source: 'AI',
    };
    let currentAnnotationsData = { 0: [{ ...serverAnnotation }] };
    const requestIdentifiers = [];
    const updateAnnotationRequest = vi.fn(async (apiIdentifier, body) => {
      requestIdentifiers.push(apiIdentifier);
      const liveStableIdentifier = /^\d+$/.test(serverAnnotation.stable_id)
        ? `id:${serverAnnotation.stable_id}`
        : serverAnnotation.stable_id;
      if (
        apiIdentifier !== liveStableIdentifier
        && apiIdentifier !== `xref:${serverAnnotation.xref}`
      ) {
        return {
          success: false,
          status: 404,
          error: `Annotation not found: ${apiIdentifier}`,
        };
      }

      const nextQuads = body.quads || serverAnnotation.quads;
      serverAnnotation = {
        ...serverAnnotation,
        ...body,
        quads: nextQuads,
        rect: body.rect || [
          nextQuads[0][0],
          nextQuads[0][1],
          nextQuads[nextQuads.length - 1][2],
          nextQuads[nextQuads.length - 1][3],
        ],
        xref: serverAnnotation.xref + 1,
      };
      return {
        success: true,
        annotation: { ...serverAnnotation },
      };
    });
    const controller = mod.createAnnotationController({
      annotationsState: { undoStack: [] },
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: helpers.buildApiAnnotationIdentifier,
        normalizeAnnotationIdentifierValue: helpers.normalizeAnnotationIdentifierValue,
        resolveAnnotationIdentifierValue: helpers.resolveAnnotationIdentifierValue,
        resolveAnnotationSource: helpers.resolveAnnotationSource,
        updateAnnotationRequest,
      },
    });
    const marker = document.querySelector('.annotation-marker');

    await controller.persistHighlightExtend(marker, currentAnnotationsData[0][0], {
      quadsPdf: firstExtendQuads,
      anchorText: 'first extended phrase',
      pageIdx: 0,
    });
    await controller.persistHighlightExtend(marker, currentAnnotationsData[0][0], {
      quadsPdf: secondExtendQuads,
      anchorText: 'second extended phrase',
      pageIdx: 0,
    });

    serverAnnotation = {
      ...serverAnnotation,
      stable_id: '9001',
      requestIdentifier: 'highlight-1',
    };
    currentAnnotationsData = { 0: [{ ...serverAnnotation }] };

    await controller.performHighlightExtendUndo(controller.popUndoOperation());
    await controller.performHighlightExtendUndo(controller.popUndoOperation());

    expect(requestIdentifiers).toEqual([
      'highlight-1',
      'highlight-1',
      'id:9001',
      'id:9001',
    ]);
    expect(serverAnnotation).toMatchObject({
      stable_id: '9001',
      requestIdentifier: 'highlight-1',
      xref: 46,
      quads: initialQuads,
      anchor_text: 'initial phrase',
      rect: [10, 20, 50, 30],
      source: 'AI',
    });
    expect(currentAnnotationsData[0][0]).toMatchObject(serverAnnotation);
    expect(marker.dataset.annotationXref).toBe('46');
    expect(controller.getUndoStack()).toEqual([]);
  });

  it('drops a highlight extend undo and shows an error toast when the target was deleted', async () => {
    const mod = await loadAnnotationControllerModule();
    const helpers = await loadAnnotationHelpersModule();
    const annotationsState = { undoStack: [] };
    let currentAnnotationsData = {
      0: [{
        stable_id: 'highlight-1',
        requestIdentifier: 'highlight-1',
        xref: 43,
        page_index: 0,
        type: 'Highlight',
        quads: [[10, 20, 70, 30]],
        anchor_text: 'extended phrase',
        rect: [10, 20, 70, 30],
        source: 'HUMAN',
      }],
    };
    const missingError = Object.assign(new Error('Annotation not found'), { status: 404 });
    const updateAnnotationRequest = vi.fn().mockRejectedValue(missingError);
    const showToast = vi.fn();
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      helpers: {
        buildApiAnnotationIdentifier: helpers.buildApiAnnotationIdentifier,
        normalizeAnnotationIdentifierValue: helpers.normalizeAnnotationIdentifierValue,
        resolveAnnotationIdentifierValue: helpers.resolveAnnotationIdentifierValue,
        updateAnnotationRequest,
        showToast,
        translatePdfPreviewText: (text) => text,
      },
    });
    controller.pushUndoOperation({
      type: 'highlight-extend',
      identifier: 'highlight-1',
      xref: '43',
      requestId: 'highlight-1',
      pageIdx: 0,
      oldQuads: [[10, 20, 50, 30]],
      oldAnchorText: 'initial phrase',
      oldRect: [10, 20, 50, 30],
      oldSource: 'AI',
      newQuads: currentAnnotationsData[0][0].quads,
      newAnchorText: 'extended phrase',
      newRect: currentAnnotationsData[0][0].rect,
      newSource: 'HUMAN',
      isOwnershipTransfer: true,
    });

    const result = await controller.performHighlightExtendUndo(controller.popUndoOperation());

    expect(result).toMatchObject({ success: false, missing: true });
    expect(showToast).toHaveBeenCalledWith('error', 'Annotation no longer exists');
    expect(controller.getUndoStack()).toEqual([]);
    expect(annotationsState.undoStack).toEqual([]);
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

  it('attribute-escapes annotation identifiers so a quote in an id cannot inject a handler (XSS)', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    // Load the real utils so the canonical escapeHtmlAttribute is exercised.
    const utils = await loadUtilsModule();
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    delete window.__annXss;
    const mod = await loadAnnotationControllerModule();
    const payload = 'x" onmouseover="window.__annXss=1" data-z="';
    let currentAnnotationsData = {};
    const controller = mod.createAnnotationController({
      annotationsState: {},
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      helpers: {
        escapeHtml: utils.escapeHtml,
        escapeHtmlAttribute: utils.escapeHtmlAttribute,
        resolveAnnotationSource: () => 'AI',
        listAnnotationsRequest: vi.fn().mockResolvedValue({
          success: true,
          annotations: {
            0: [{
              pageIdx: 0,
              id: payload,
              stable_id: payload,
              requestIdentifier: payload,
              xref: payload,
              grader_name: payload,
              content: 'hello',
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();

    const listEl = document.getElementById('pdfGradedCommentsList');
    const item = listEl.querySelector('.list-group-item');
    expect(item).not.toBeNull();
    // Attribute injection neutralised: no event handler / extra attribute leaked.
    expect(listEl.querySelector('[onmouseover]')).toBeNull();
    expect(item.getAttribute('onmouseover')).toBeNull();
    expect(item.hasAttribute('data-z')).toBe(false);
    // Identifiers still round-trip losslessly for downstream CRUD/selector lookups.
    expect(item.dataset.annotationRequestId).toBe(payload);
    expect(item.dataset.annotationStableId).toBe(payload);
    // Firing the event the payload tried to register must not execute anything.
    item.dispatchEvent(new window.Event('mouseover'));
    expect(window.__annXss).toBeUndefined();
  });

  it('keeps sidebar edit mode working for quote-bearing annotation identifiers', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    const utils = await loadUtilsModule();
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const payload = 'needs"quotes';
    const rawDomId = `ann-0-${payload}`;
    let currentAnnotationsData = {};
    const controller = mod.createAnnotationController({
      annotationsState: {},
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      getEditingAnnotationId: () => rawDomId,
      helpers: {
        escapeHtml: utils.escapeHtml,
        escapeHtmlAttribute: utils.escapeHtmlAttribute,
        listAnnotationsRequest: vi.fn().mockResolvedValue({
          success: true,
          annotations: {
            0: [{
              pageIdx: 0,
              id: payload,
              stable_id: payload,
              requestIdentifier: payload,
              content: 'editable text',
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();

    const content = document.querySelector('.annotation-content');
    const textarea = document.getElementById(`edit-annotation-text-${payload}`);
    const saveButton = document.querySelector('.save-annotation-btn');
    expect(content?.classList.contains('editing')).toBe(true);
    expect(textarea).not.toBeNull();
    expect(saveButton?.dataset.annotationIdentifier).toBe(payload);
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

  it('does not fall back to the current page when cancel loses page context', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const deleteAnnotationSilently = vi.fn().mockResolvedValue(undefined);
    const findAnnotationEntry = vi.fn(() => null);
    let editingId = 'ann-5-ann-5';
    const controller = mod.createAnnotationController({
      annotationsState,
      getAnnotationsData: () => currentAnnotationsData,
      setAnnotationsData: (data) => { currentAnnotationsData = data; },
      getCurrentSubmissionId: () => 1001,
      getCurrentAssignmentId: () => 501,
      getEditingAnnotationId: () => editingId,
      setEditingAnnotationId: (value) => { editingId = value; },
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
    controller.setCurrentAnnotationsPage(7);
    const cancelButton = document.querySelector('.cancel-edit-btn');
    cancelButton.removeAttribute('data-annotation-page');
    cancelButton.click();
    await Promise.resolve();

    expect(findAnnotationEntry).not.toHaveBeenCalledWith(7, 'ann-5');
    expect(deleteAnnotationSilently).not.toHaveBeenCalled();
  });

  it('reverts human annotations using the stable server id from the sidebar button', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const revertAnnotationToAiRequest = vi.fn().mockResolvedValue({ success: true });
    const loadAnnotations = vi.fn().mockResolvedValue(undefined);
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
            4: [{
              pageIdx: 4,
              id: 'xref:1046|id:Q1-04',
              stable_id: 'Q1-04',
              requestIdentifier: 'xref:1046|id:Q1-04',
              xref: 1046,
              content: 'Human edit',
              source: 'HUMAN',
              can_revert_to_ai: true,
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        resolveAnnotationSource: (annotation) => annotation.source || 'HUMAN',
        hostAdvertisesCapability: (name) => name === 'revertToAi',
        revertAnnotationToAiRequest,
        loadAnnotations,
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();
    document.querySelector('.revert-annotation-to-ai')?.click();
    await Promise.resolve();

    expect(revertAnnotationToAiRequest).toHaveBeenCalledWith('Q1-04');
    expect(loadAnnotations).toHaveBeenCalled();
  });

  it('requires inline confirmation before deleting a sidebar annotation', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const deleteAnnotationRequest = vi.fn().mockResolvedValue({ success: true });
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
              id: 'ann-delete',
              stable_id: 'ann-delete',
              requestIdentifier: 'ann-delete',
              xref: 88,
              content: 'Delete me',
              source: 'HUMAN',
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        buildApiAnnotationIdentifier: ({ identifier, xref, requestId }) => identifier || requestId || xref || null,
        deleteAnnotationRequest,
        findAnnotationEntry: (pageIdx, identifier) => {
          const pageAnnotations = currentAnnotationsData[pageIdx] || [];
          return pageAnnotations.find((annotation) => (
            String(annotation.requestIdentifier || '') === String(identifier)
            || String(annotation.stable_id || '') === String(identifier)
            || String(annotation.id || '') === String(identifier)
            || String(annotation.xref || '') === String(identifier)
          )) || null;
        },
        showToast: vi.fn(),
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();
    document.querySelector('.delete-annotation')?.click();
    await Promise.resolve();

    expect(deleteAnnotationRequest).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-delete-yes')).not.toBeNull();
    expect(document.querySelector('.confirm-delete-cancel')).not.toBeNull();
  });

  it('does not let a stale detached delete button bypass the inline confirmation state', async () => {
    document.body.innerHTML = `
      <div id="pdfGradedContainer"></div>
      <div id="pdfGradedCommentsList"></div>
    `;
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    const mod = await loadAnnotationControllerModule();
    const annotationsState = {};
    let currentAnnotationsData = {};
    const deleteAnnotationRequest = vi.fn().mockResolvedValue({ success: true });
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
              id: 'ann-delete-duplicate',
              stable_id: 'ann-delete-duplicate',
              requestIdentifier: 'ann-delete-duplicate',
              xref: 1098,
              content: 'Delete me later',
              source: 'HUMAN',
            }],
          },
        }),
        normalizeAnnotationsPayload: (data) => data,
        refreshMarkupFromAnnotations: vi.fn(),
        normalizeAnnotationIdentifierValue: (value) => value == null ? null : String(value),
        buildApiAnnotationIdentifier: ({ identifier, xref, requestId }) => identifier || requestId || xref || null,
        deleteAnnotationRequest,
        findAnnotationEntry: (pageIdx, identifier) => {
          const pageAnnotations = currentAnnotationsData[pageIdx] || [];
          return pageAnnotations.find((annotation) => (
            String(annotation.requestIdentifier || '') === String(identifier)
            || String(annotation.stable_id || '') === String(identifier)
            || String(annotation.id || '') === String(identifier)
            || String(annotation.xref || '') === String(identifier)
          )) || null;
        },
        showToast: vi.fn(),
      },
    });

    await controller.loadAnnotations();
    controller.renderSidebar();

    const staleDeleteButton = document.querySelector('.delete-annotation');
    staleDeleteButton?.click();
    await Promise.resolve();

    expect(deleteAnnotationRequest).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-delete-yes')).not.toBeNull();

    staleDeleteButton?.remove();
    await controller.deleteAnnotation(0, 'ann-delete-duplicate', staleDeleteButton);

    expect(deleteAnnotationRequest).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-delete-yes')).not.toBeNull();
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
