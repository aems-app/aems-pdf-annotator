import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = {
  id: 'Q1-move', stable_id: 'Q1-move', xref: 1046, page_index: 0,
  type: 'Text', content: 'Original feedback', source: 'AI', original_source: 'AI',
  can_revert_to_ai: false, color: 'amber', icon: 'help', rect: [100, 195, 116, 211],
};
const markerSelector = '.annotation-marker[data-annotation-stable-id="Q1-move"]';

describe('new comment survives production polling and relayout', () => {
  let modals;
  let instances;
  let adapter;
  let hostAnnotation;
  let stored;
  let version;
  let sync;
  let renderer;
  let syncState;
  let pageChanged;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    modals = [];
    instances = [];
    stored = new Map();
    version = 1;
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf') || key === 'PDFViewer') delete window[key];
    }
    document.body.innerHTML = `
      <div id="pdfPreviewModal"><button id="pdfPreviewFullscreenToggle"></button><button data-bs-dismiss="modal"></button></div><div id="pdfPreviewStudent"></div>
      <div id="pdfOriginalPane"></div><div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button><button id="pdfGradedTab"></button>
      <div id="pdfGradedCommentsList"></div><div id="pdfGradedAICommentsList"></div>
      <div id="pdfGradedContainer"></div><div id="pdfOriginalContainer"></div>`;
    window.CSS = { escape: value => String(value) };
    window.bootstrap = { Modal: class { show() {} static getInstance() { return null; } } };
    window.PdfPreviewModalViewer = {
      resolvePdfjsLib: () => ({}),
      PDFViewer: class {
        onAnnotationsPageChange(cb) { pageChanged = cb; } onPageRendered() {} onSliderSync() {} onResizeComplete() {}
      },
    };
    // Supply layout/visibility only; controllers, rendering, drag and host bridges are real.
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const width = (el) => el.classList.contains('annotation-marker') ? parseFloat(el.style.width) : 600;
    const height = (el) => el.classList.contains('annotation-marker') ? parseFloat(el.style.height) : 800;
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function () { return parseFloat(this.style.left) || 0; });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function () { return parseFloat(this.style.top) || 0; });
    for (const property of ['clientWidth', 'offsetWidth']) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function () { return width(this); });
    }
    for (const property of ['clientHeight', 'offsetHeight']) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function () { return height(this); });
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const page = this.closest('.pdf-page-wrapper');
      const left = parseFloat(this.style.left) || 0;
      const top = (parseFloat(this.style.top) || 0) + (page ? (Number(page.dataset.pageNum) - 1) * 850 : 0);
      return { left, top, width: width(this), height: height(this), right: left + width(this), bottom: top + height(this) };
    });
    await import('../src/pdf-preview-modal/utils.js');
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/sidebar-panel.js');
    await import('../src/pdf-preview-modal/modal-state.js');
    await import('../src/pdf-preview-modal/rendering.js');
    await import('../src/pdf-preview-modal/overlay-renderer.js');
    const renderFactory = window.PdfPreviewModalOverlayRenderer.createOverlayRenderer;
    vi.spyOn(window.PdfPreviewModalOverlayRenderer, 'createOverlayRenderer').mockImplementation(options => (renderer = renderFactory(options)));
    await import('../src/pdf-preview-modal/version-sync.js');
    const syncFactory = window.PdfPreviewModalVersionSync.createVersionSync;
    vi.spyOn(window.PdfPreviewModalVersionSync, 'createVersionSync').mockImplementation((state, options) => { syncState = state; return (sync = syncFactory(state, options)); });
    await import('../src/pdf-preview-modal/annotation-controller.js');
    const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
    vi.spyOn(window.PdfPreviewModalAnnotationController, 'createAnnotationController').mockImplementation((options) => {
      const controller = factory(options);
      instances.push({ controller, options });
      return controller;
    });
    adapter = {
      getAnnotationsVersion: vi.fn(async () => ({ success: true, version: String(version) })),
      listAnnotations: vi.fn(async () => ({ success: true, annotations: { 0: [...stored.values()].map(a => ({ ...a })) } })),
      createAnnotation: vi.fn(async (_a, _s, body) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        hostAnnotation = { ...ai, ...body, id: 'created-1', stable_id: 'created-1', content: 'New comment...', page_index: 0 };
        stored.set(hostAnnotation.id, hostAnnotation);
        version++;
        return { success: true, annotation: { ...hostAnnotation } };
      }),
      updateAnnotation: vi.fn(async (_a, _s, id, body) => {
        if (!stored.has(id)) throw new Error('PUT 404: annotation deleted');
        hostAnnotation = { ...stored.get(id), ...body };
        stored.set(id, hostAnnotation);
        version++;
        return { success: true, annotation: { ...hostAnnotation } };
      }),
      deleteAnnotation: vi.fn(async (_a, _s, id) => {
        stored.delete(id);
        version++;
        return { success: true };
      }),
    };
    await import('../src/pdf-preview-modal.js');
  });

  afterEach(() => {
    // Model the viewer releasing its page DOM before modal teardown.
    releasePages();
    modals.forEach((modal) => modal.destroy());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function releasePages() {
    document.querySelectorAll('.pdf-annotation-overlay').forEach((overlay) => overlay.replaceChildren());
    document.getElementById('pdfGradedContainer').replaceChildren();
  }

  async function open(cycles) {
    for (let i = 0; i <= cycles; i++) {
      const modal = window.PdfPreviewModal.createPdfPreviewModal({
        assignmentId: 'assignment-1', submissionId: 'submission-1', modeAdapter: adapter,
      });
      modals.push(modal);
      await modal.open();
      document.getElementById('pdfGradedContainer').innerHTML = [1, 2].map((page) => `
        <div class="pdf-page-wrapper" data-page-num="${page}">
          <canvas class="pdf-page-canvas"></canvas><div class="pdf-annotation-overlay"></div>
        </div>`).join('');
      window.__pdfGradedViewer = {
        relayoutPagesForContainer: async () => {},
        isGradedViewer: true, renderedPages: new Set([1, 2]), currentPage: 1, zoom: 1,
        getViewportForPage: () => ({ width: 600, height: 800, scale: 1, convertToPdfPoint: (x, y) => [x, y] }),
        pdf: { numPages: 2, getPage: vi.fn(async () => ({ view: [0, 0, 600, 800] })) },
      };
      await instances.at(-1).controller.loadAnnotations();
      await vi.advanceTimersByTimeAsync(600);

      if (i < cycles) {
        releasePages();
        modal.destroy();
      }
    }
    return instances.at(-1);
  }

  async function create() {
    await open(0);
    await sync._checkVersion(); // production poll knows the pre-POST version
    document.querySelector('.pdf-annotation-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    await vi.advanceTimersByTimeAsync(700);
    expect(adapter.createAnnotation).toHaveBeenCalledOnce();
    const editor = document.querySelector('.inline-annotation-editor');
    expect(editor).not.toBeNull();
    return editor;
  }

  async function save(editor) {
    editor.focus();
    editor.value = 'Check the units';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.updateAnnotation).toHaveBeenCalledWith('assignment-1', 'submission-1', 'created-1', expect.objectContaining({ content: 'Check the units' }), { offline: false });
    expect(stored.get('created-1')?.content).toBe('Check the units');
  }

  it('own POST followed by the 10 s version poll never reloads/deletes the new comment', async () => {
    const editor = await create();
    const reloads = adapter.listAnnotations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect.soft(adapter.deleteAnnotation).not.toHaveBeenCalled();
    expect.soft(adapter.listAnnotations).toHaveBeenCalledTimes(reloads);
    expect.soft(document.querySelector('.inline-annotation-editor')).toBe(editor);
    await save(editor);
    await vi.advanceTimersByTimeAsync(21000);
    expect(syncState.versionToken).toBe(String(version));
    expect(adapter.listAnnotations).toHaveBeenCalledTimes(reloads);
  });

  it('defers a genuine external change beyond the drawing timeout and applies it after save', async () => {
    const editor = await create();
    const reloads = adapter.listAnnotations.mock.calls.length;
    stored.set('external', { ...ai, id: 'external', stable_id: 'external', xref: 99, content: 'Other reviewer' });
    version++;
    await vi.advanceTimersByTimeAsync(25000);
    expect.soft(adapter.listAnnotations).toHaveBeenCalledTimes(reloads);
    expect.soft(adapter.deleteAnnotation).not.toHaveBeenCalled();
    expect.soft(document.querySelector('.inline-annotation-editor')).toBe(editor);
    await save(editor);
    await vi.advanceTimersByTimeAsync(300);
    expect(adapter.listAnnotations.mock.calls.length).toBeGreaterThan(reloads);
    expect(instances.at(-1).options.getAnnotationsData()[0].map(a => a.content)).toEqual(expect.arrayContaining(['Other reviewer', 'Check the units']));
  });

  it.each(['scroll', 'resize', 'fullscreen'])('%s geometry changes preserve the same focused editor and draft', async (event) => {
    const editor = await create();
    editor.focus();
    editor.value = 'Draft';
    editor.setSelectionRange(2, 2);
    document.querySelector('.pdf-page-canvas').style.left = '27px';
    document.querySelector('.pdf-page-canvas').style.top = '51px';
    if (event === 'scroll') document.getElementById('pdfGradedContainer').dispatchEvent(new Event('scroll'));
    else if (event === 'resize') window.dispatchEvent(new Event('resize'));
    else document.dispatchEvent(new Event('fullscreenchange'));
    renderer.renderAnnotations(true); // the real renderer called by viewer layout callbacks
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector('.inline-annotation-editor')).toBe(editor);
    expect(editor.value).toBe('Draft');
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
  });

  it('own explicit cancellation deletes once and adopts its version without a list reload', async () => {
    await create();
    const reloads = adapter.listAnnotations.mock.calls.length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.advanceTimersByTimeAsync(21000);
    expect(adapter.deleteAnnotation).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'created-1', { offline: false });
    expect(stored.has('created-1')).toBe(false);
    expect(syncState.versionToken).toBe(String(version));
    expect(adapter.listAnnotations).toHaveBeenCalledTimes(reloads);
  });

  it.each(['cancel', 'escape', 'priority then escape', 'another comment', 'close icon', 'modal hide', 'booklet', 'page'])(
    'explicit %s discards an empty new draft exactly once', async (action) => {
      await create();
      // Overlap close gestures with a slow DELETE, as blur/hide can follow Cancel.
      adapter.deleteAnnotation.mockImplementation(async (_a, _s, id) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        stored.delete(id);
        return { success: true };
      });
      if (action === 'cancel') {
        document.querySelector('.cancel-edit-btn').click();
        document.querySelector('.cancel-edit-btn')?.click();
      } else if (action === 'escape' || action === 'priority then escape') {
        if (action === 'priority then escape') {
          document.querySelector('.inline-priority-strip .priority-red').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else if (action === 'another comment') {
        instances.at(-1).controller.beginEdit(0, 'other');
      } else if (action === 'close icon') {
        document.querySelector('[data-bs-dismiss="modal"]').click();
      } else if (action === 'modal hide') {
        document.getElementById('pdfPreviewModal').dispatchEvent(new Event('hide.bs.modal'));
      } else if (action === 'booklet') {
        releasePages();
        modals.at(-1).destroy();
      } else {
        pageChanged(1);
      }
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.deleteAnnotation).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'created-1', { offline: false });
      expect(stored.has('created-1')).toBe(false);
    },
  );

  it.each(['missing API', 'rejected API'])('fallback fullscreen round trip recomputes marker geometry (%s)', async (mode) => {
    await open(0);
    stored.set(ai.id, { ...ai });
    await instances.at(-1).controller.loadAnnotations();
    const modal = document.getElementById('pdfPreviewModal');
    if (mode === 'rejected API') modal.requestFullscreen = vi.fn(async () => { throw new Error('denied'); });
    const canvas = document.querySelector('.pdf-page-canvas');
    window.__pdfGradedViewer.relayoutPagesForContainer = vi.fn(async () => {
      canvas.style.top = modal.classList.contains('preview-fullscreen') ? '90px' : '0px';
    });
    const top = () => parseFloat(document.querySelector(markerSelector).style.top);
    const initial = top();
    document.getElementById('pdfPreviewFullscreenToggle').click();
    await vi.advanceTimersByTimeAsync(600);
    expect(modal.classList.contains('preview-fullscreen')).toBe(true);
    expect(top()).toBe(initial + 90);
    document.getElementById('pdfPreviewFullscreenToggle').click();
    await vi.advanceTimersByTimeAsync(600);
    expect(modal.classList.contains('preview-fullscreen')).toBe(false);
    expect(top()).toBe(initial);
  });

  it('a direct booklet switch deletes a still-creating empty draft in the original document', async () => {
    await open(0);
    document.querySelector('.pdf-annotation-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector('.inline-annotation-editor')).not.toBeNull();
    releasePages();
    modals.at(-1).destroy();
    modals.push(window.PdfPreviewModal.createPdfPreviewModal({
      assignmentId: 'assignment-2', submissionId: 'submission-2', modeAdapter: adapter,
    }));
    await vi.advanceTimersByTimeAsync(900);
    expect(adapter.deleteAnnotation).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'created-1', { offline: false });
    expect(stored.has('created-1')).toBe(false);
  });

  it('clicking another marker discards only the empty new draft', async () => {
    stored.set(ai.id, { ...ai });
    await create();
    document.querySelector(markerSelector).click();
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.deleteAnnotation).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'created-1', { offline: false });
    expect(stored.get(ai.id).content).toBe(ai.content);
  });

  it('Cancel keeps an existing saved comment', async () => {
    await save(await create());
    instances.at(-1).controller.beginEdit(0, 'created-1');
    await vi.advanceTimersByTimeAsync(200);
    document.querySelector('.cancel-edit-btn').click();
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
    expect(stored.get('created-1').content).toBe('Check the units');
  });

  it('navigation retains a new draft with meaningful text', async () => {
    const editor = await create();
    editor.value = 'Draft feedback';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    pageChanged(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
  });

  it('closing during a failed create never sends DELETE for a client-only identity', async () => {
    await open(0);
    adapter.createAnnotation.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { success: false, error: 'Create failed' };
    });
    document.querySelector('.pdf-annotation-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    await vi.advanceTimersByTimeAsync(100);
    releasePages();
    modals.at(-1).destroy();
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
  });

  it('defers a reload response already in flight when an existing comment is opened', async () => {
    const editor = await create();
    await save(editor);
    const { controller, options } = instances.at(-1);
    let finishList;
    adapter.listAnnotations.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
    const reload = controller.loadAnnotations();
    await vi.advanceTimersByTimeAsync(0);
    controller.beginEdit(0, 'created-1');
    await vi.advanceTimersByTimeAsync(200);
    const live = document.querySelector('.inline-annotation-editor');
    live.focus();
    live.value = 'Unsaved existing comment';
    live.setSelectionRange(5, 5);
    finishList({ success: true, annotations: { 0: [{ ...hostAnnotation, content: 'Stale snapshot' }] } });
    await reload;
    renderer.renderAnnotations(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(document.querySelector('.inline-annotation-editor')).toBe(live);
    expect(live.value).toBe('Unsaved existing comment');
    expect(live.selectionStart).toBe(5);
    expect(options.getAnnotationsData()[0][0].content).toBe('Check the units');
    await save(live);
    expect(options.getAnnotationsData()[0][0].content).toBe('Check the units');
  });

  it('keeps an existing sidebar editor, focus and caret across rendering and external polling', async () => {
    await save(await create());
    const { controller, options } = instances.at(-1);
    controller.beginEdit(0, 'created-1');
    await vi.advanceTimersByTimeAsync(200);
    const editor = document.querySelector('#pdfGradedCommentsList textarea');
    editor.focus();
    editor.value = 'Sidebar draft';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.setSelectionRange(4, 4);
    const reloads = adapter.listAnnotations.mock.calls.length;
    stored.set('external', { ...ai, id: 'external', stable_id: 'external', xref: 99, content: 'Other reviewer' });
    version++;
    controller.renderSidebar();
    renderer.renderAnnotations(true);
    await vi.advanceTimersByTimeAsync(25000);
    expect(document.querySelector('#pdfGradedCommentsList textarea')).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(4);
    expect(editor.value).toBe('Sidebar draft');
    expect(adapter.listAnnotations).toHaveBeenCalledTimes(reloads);
    document.querySelector('.save-annotation-btn').click();
    await vi.advanceTimersByTimeAsync(600);
    expect(stored.get('created-1').content).toBe('Sidebar draft');
    expect(options.getAnnotationsData()[0].map(a => a.content)).toEqual(expect.arrayContaining(['Other reviewer', 'Sidebar draft']));
  });

  it('a focus loss with no explicit close never deletes an empty new comment', async () => {
    const editor = await create();
    editor.focus();
    editor.blur();
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
    expect(document.querySelector('.inline-annotation-editor')).toBe(editor);
  });

  it('a list reload never garbage-collects another reviewer new empty comment', async () => {
    await open(0);
    stored.set('external', { ...ai, id: 'external', stable_id: 'external', content: 'New comment...' });
    await instances.at(-1).controller.loadAnnotations();
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
    expect(stored.has('external')).toBe(true);
  });
});
