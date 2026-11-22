/**
 * Defect class (AEMS MASTER 539a): a brand-new comment whose text the teacher never touched
 * ("New comment...") must never be kept as a real comment, because the server copy can reach
 * students. Recolouring the draft (priority strip) sets _priorityChanged/_hasBeenEdited, and the
 * Escape and Save paths treated those flags as "the teacher edited the text" and kept the draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/annotation-controller.js';

async function setup({ recolour }) {
  document.body.innerHTML = '<div id="pdfGradedContainer"></div><div id="pdfGradedCommentsList"></div>';
  window.__pdfGradedViewer = { pdf: {}, currentPage: 1 };
  window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
  await import(new URL(MODULE_PATH, import.meta.url));
  let data = {};
  let editingId = null;
  const normalize = (value) => (value == null ? null : String(value));
  const findIndex = (page, id) => (data[page] || []).findIndex((ann) =>
    [ann.stable_id, ann.id, ann.xref].some((value) => String(value) === String(id)));
  let controller;
  const helpers = {
    getHistoryEpoch: () => 1,
    isCurrentHistoryEpoch: (value) => value === 1,
    normalizeAnnotationIdentifierValue: normalize,
    resolveAnnotationIdentifierValue: (ann) => ann.stable_id || ann.id,
    enhanceAnnotationEntry: (ann) => ({ ...ann, requestIdentifier: ann.stable_id }),
    buildApiAnnotationIdentifier: ({ identifier }) => identifier,
    findAnnotationIndex: findIndex,
    findAnnotationEntry: (page, id) => data[page]?.[findIndex(page, id)],
    escapeCssAttribute: (value) => value,
    createAnnotationRequest: vi.fn(async () => ({ success: true, annotation: {
      ...data[0][0], xref: 77, content: 'New comment...', source: 'HUMAN',
    } })),
    updateAnnotationRequest: vi.fn(async (_id, body) => ({ success: true, annotation: {
      ...data[0][0], ...body, xref: 77, source: 'HUMAN',
    } })),
    deleteAnnotationRequest: vi.fn(async () => ({ success: true })),
    deleteAnnotationSilently: (...args) => controller.deleteAnnotationSilently(...args),
  };
  controller = window.PdfPreviewModalAnnotationController.createAnnotationController({
    annotationsState: {},
    getAnnotationsData: () => data,
    setAnnotationsData: (value) => { data = value; },
    getCurrentSubmissionId: () => 'A',
    getEditingAnnotationId: () => editingId,
    setEditingAnnotationId: (value) => { editingId = value; },
    helpers,
  });
  await controller.createTemporaryAnnotation([10, 20, 30, 40], 0);
  await vi.advanceTimersByTimeAsync(120);
  const textarea = document.querySelector('textarea');
  expect(textarea).not.toBeNull();
  if (recolour) {
    // Exactly what the priority strip does to the entry (pdf-preview-modal.js, mousedown handler).
    Object.assign(data[0][0], { color: 'red', _priorityChanged: true, _hasBeenEdited: true });
  }
  return { controller, helpers, textarea, identifier: data[0][0].stable_id };
}

describe('untouched placeholder comment is never persisted', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf')) delete window[key];
    }
    window.PdfPreviewModalUtils = {
      debugLog: () => {},
      PLACEHOLDER_STRINGS: ['', 'New comment...', 'New comment'],
    };
    window.PdfPreviewModalSidebarPanel = {
      EMPTY_STATE_MESSAGE: 'No comments visible in viewport',
      shouldDisplayAnnotation: (_ann, isVisible) => !!isVisible,
    };
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  });

  it.each(['Escape', 'Save'])('recoloured draft with untouched text is discarded on %s', async (action) => {
    const { controller, helpers, textarea, identifier } = await setup({ recolour: true });
    if (action === 'Escape') {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      textarea.value = '';
      await controller.saveAnnotationEdit(identifier);
    }
    await vi.advanceTimersByTimeAsync(350);
    expect(helpers.deleteAnnotationRequest).toHaveBeenCalledOnce();
    expect(helpers.updateAnnotationRequest).not.toHaveBeenCalled();
  });

  it('recoloured draft with real typed text is still saved, not discarded', async () => {
    const { controller, helpers, textarea, identifier } = await setup({ recolour: true });
    textarea.value = 'Check the units';
    await controller.saveAnnotationEdit(identifier);
    await vi.advanceTimersByTimeAsync(350);
    expect(helpers.deleteAnnotationRequest).not.toHaveBeenCalled();
    expect(helpers.updateAnnotationRequest).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ content: 'Check the units' }));
  });
});
