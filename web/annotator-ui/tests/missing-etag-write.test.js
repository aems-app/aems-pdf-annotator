import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MASTER 574: a comment the host delivered without an etag used to be written with no If-Match,
// which the hosted server refuses with 428 ANNOTATION_PRECONDITION_REQUIRED.
describe('write of a comment that carries no etag', () => {
  let handle, helpers, options, adapter, toasts, stored, sync, version, controller;
  const ids = ['feedback-1', 'Q1_SUMMARY', 'feedback-2'];
  const label = id => document.querySelector(`[data-identifier="${id}"] .annotation-label`);
  const sidebar = id => document.getElementById(`edit-annotation-text-${id}`);
  const button = (id, selector = '.save-annotation-btn') => sidebar(id).closest('.list-group-item').querySelector(selector);
  beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf') || key === 'AEMSPdfAnnotator') delete window[key];
    }
    document.body.innerHTML = `<button id="elsewhere">Elsewhere</button><div id="pdfGradedCommentsList"></div><div id="pdfGradedContainer"><div class="pdf-annotation-overlay">${ids.map(id => `<div class="annotation-marker" data-page-idx="0" data-identifier="${id}" data-annotation-page="0" data-annotation-check-id="${id}" data-annotation-request-id="${id}"><div class="annotation-label"></div></div>`).join('')}</div></div>`;
    window.CSS = { escape: value => String(value) };
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', cb => { cb(); return 1; });
    window.PdfPreviewModalViewer = {
      PDFViewer: class { onAnnotationsPageChange() {} onPageRendered() {} onSliderSync() {} onResizeComplete() {} },
      resolvePdfjsLib: () => ({}),
    };
    window.PdfPreviewModalOverlayRenderer = { createOverlayRenderer: () => ({ onMarkerClicked() {}, onMarkerDblClicked() {}, onOverlayDblClicked() {}, onOverlayReady() {}, renderPage() {}, renderAnnotations() {}, destroy() {} }) };
    stored = new Map(ids.map(id => [id, { id, stable_id: id, check_id: id, page_index: 0, type: 'Text', content: `Original ${id}`, color: 'amber', source: 'HUMAN', rect: [50, 50, 150, 70] }]));
    version = 'v1';
    adapter = {
      updateAnnotation: vi.fn(async (_a, _s, id, body) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        const annotation = { ...stored.get(id), ...body }; stored.set(id, annotation);
        return { success: true, annotation: { ...annotation } };
      }),
      listAnnotations: vi.fn(async () => ({ success: true, annotations: { 0: [...stored.values()].map(a => ({ ...a })) } })),
      getAnnotationsVersion: vi.fn(async () => ({ success: true, version })),
      deleteAnnotation: vi.fn(async (_a, _s, id) => { stored.delete(id); return { success: true }; }),
    };
    await import('../src/pdf-preview-modal/utils.js');
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/sidebar-panel.js');
    await import('../src/pdf-preview-modal/modal-state.js');
    await import('../src/pdf-preview-modal/version-sync.js');
    await import('../src/pdf-preview-modal/annotation-controller.js');
    const sf = window.PdfPreviewModalVersionSync.createVersionSync;
    vi.spyOn(window.PdfPreviewModalVersionSync, 'createVersionSync').mockImplementation((...args) => (sync = sf(...args)));
    const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
    vi.spyOn(window.PdfPreviewModalAnnotationController, 'createAnnotationController').mockImplementation(o => {
      options = o; o.setAnnotationsData({ 0: [...stored.values()].map(a => ({ ...a })) });
      controller = factory(o); controller.renderList(); return controller;
    });
    const bounds = () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792 });
    document.getElementById('pdfGradedContainer').getBoundingClientRect = bounds;
    document.querySelectorAll('.annotation-marker').forEach(m => { m.getBoundingClientRect = bounds; });
    await import('../src/pdf-preview-modal.js');
    handle = window.PdfPreviewModal.createPdfPreviewModal({ assignmentId: 'a', submissionId: 's', modeAdapter: adapter });
    helpers = window.PdfPreviewModal.__test;
    toasts = vi.fn();
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, 'appendChild').mockImplementation(element => {
      if (element.matches('.alert')) toasts(element.classList.contains('alert-danger') ? 'error' : 'info', element.textContent.trim());
      return append(element);
    });
    ids.forEach(id => helpers.setupLabelTooltipEvents(label(id), stored.get(id).content));
  });
  afterEach(() => {
    document.querySelectorAll('.label-expanded').forEach(l => helpers.collapseInlineLabel(l));
    handle?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '';
  });
  function edit(id = ids[0], text = 'Saved feedback') {
    label(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    const editor = label(id).querySelector('textarea'); expect(editor).not.toBeNull();
    type(editor, text);
    return editor;
  }
  function type(editor, text) {
    editor.focus();
    editor.select();
    for (const character of text) {
      editor.setRangeText(character, editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }));
    }
  }
  // jsdom click() omits the browser's mousedown -> focus/blur -> mouseup order.
  function click(target) {
    if (target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))) target.focus();
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); target.click();
  }
  function key(editor) { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); }

  const saveWithText = async (text) => { edit(ids[0], text); click(button(ids[0])); await vi.advanceTimersByTimeAsync(800); };
  it('adopts the host copy etag when it still has the text this page saw', async () => {
    stored.get(ids[0]).etag = 'server-v1';
    await saveWithText('New text');
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation.mock.calls[0][4]).toEqual({ offline: false, ifMatch: 'server-v1' });
  });
  it('refuses with a clear message, and writes nothing, when the host copy has newer text', async () => {
    Object.assign(stored.get(ids[0]), { etag: 'server-v2', content: 'Colleague edit' });
    await saveWithText('New text');
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('could not be saved safely'));
    expect(stored.get(ids[0]).content).toBe('Colleague edit');
  });
  it('refuses with a clear message when the host copy cannot be fetched', async () => {
    adapter.listAnnotations.mockRejectedValueOnce(new Error('offline'));
    await saveWithText('New text');
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('could not be saved safely'));
  });
  it("leaves a comment the host no longer lists to the write's own refusal", async () => {
    stored.delete(ids[0]);
    adapter.updateAnnotation.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    await saveWithText('New text');
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation.mock.calls[0][4]).toEqual({ offline: false });
  });
  it('keeps the tag-less protocol of a host that issues no tags, looking the copy up once', async () => {
    await saveWithText('First');
    await saveWithText('Second');
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    for (const call of adapter.updateAnnotation.mock.calls) expect(call[4]).toEqual({ offline: false });
    expect(toasts).not.toHaveBeenCalled();
    expect(adapter.listAnnotations.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('a write that already has an etag does not look the comment up', async () => {
        options.getAnnotationsData()[0][0].etag = 'e1';
    const before = adapter.listAnnotations.mock.calls.length;
    await saveWithText('New text');
    expect(adapter.updateAnnotation.mock.calls[0][4]).toMatchObject({ ifMatch: 'e1' });
    expect(adapter.listAnnotations.mock.calls.length).toBe(before);
  });
});
