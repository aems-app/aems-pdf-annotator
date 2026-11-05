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
        await new Promise(resolve => setTimeout(resolve, 300));
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
    delete window.i18n;
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

  async function startTypingDraft(interval = 20, location = 'inline') {
    await open(0);
    document.querySelector('.pdf-annotation-overlay').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    await vi.advanceTimersByTimeAsync(60);
    // jsdom's observer is a layout stub; run the real sidebar visibility pass.
    if (location === 'sidebar') instances.at(-1).controller.renderList();
    const editor = document.querySelector(location === 'sidebar' ? '.auto-resize-textarea' : '.inline-annotation-editor');
    expect(editor).not.toBeNull();
    if (location === 'sidebar') editor.focus();
    for (const character of 'kommentar') {
      const active = document.activeElement;
      expect(active).toBeInstanceOf(HTMLTextAreaElement);
      active.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
      active.setRangeText(character, active.selectionStart, active.selectionEnd, 'end');
      active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }));
      active.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
      await vi.advanceTimersByTimeAsync(interval);
    }
    return editor;
  }

  it.each([
    ['inline', 20], ['inline', 30], ['sidebar', 20], ['sidebar', 30],
  ])('keeps each typed character, focus and caret through POST identity remapping (%s, %i ms keys)', async (location, interval) => {
    const editor = await startTypingDraft(interval, location);
    await vi.advanceTimersByTimeAsync(400);
    const live = document.querySelector(location === 'sidebar' ? '.auto-resize-textarea' : '.inline-annotation-editor');
    expect.soft(live).toBe(editor);
    expect.soft(live?.value).toBe('kommentar');
    expect.soft(document.activeElement).toBe(editor);
    expect.soft([live?.selectionStart, live?.selectionEnd]).toEqual([9, 9]);
    expect.soft(document.querySelector('.auto-resize-textarea')?.value).toBe('kommentar');
    document.querySelector('.save-annotation-btn').click();
    await vi.advanceTimersByTimeAsync(700);
    expect(stored.get('created-1')?.content).toBe('kommentar');
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('created-1');
  });

  it('preserves a backward selection moved before the POST resolves', async () => {
    const editor = await startTypingDraft();
    editor.setSelectionRange(2, 7, 'backward');
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector('.inline-annotation-editor')).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([2, 7, 'backward']);
  });

  it.each(['throw', 'unsuccessful'])('a %s POST failure keeps the typed draft focused with an error', async failure => {
    adapter.createAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (failure === 'throw') throw new Error('Create refused');
      return { success: false, error: 'Create refused' };
    });
    const editor = await startTypingDraft();
    await vi.advanceTimersByTimeAsync(400);
    expect.soft(document.querySelector('.inline-annotation-editor')).toBe(editor);
    expect.soft(editor.isConnected).toBe(true);
    expect.soft(editor.value).toBe('kommentar');
    expect.soft(document.activeElement).toBe(editor);
    expect.soft([editor.selectionStart, editor.selectionEnd]).toEqual([9, 9]);
    expect.soft(instances.at(-1).options.getAnnotationsData()[0]?.[0]?.content).toBe('kommentar');
    expect(document.querySelector('.alert-danger')?.textContent).toContain('Create refused');
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
  });

  it.each(['inline', 'sidebar'])('300 ms rejected POST preserves all characters typed in %s', async location => {
    adapter.createAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new TypeError('Failed to fetch');
    });
    const editor = await startTypingDraft(30, location);
    await vi.advanceTimersByTimeAsync(400);
    expect(editor.value).toBe('kommentar');
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([9, 9]);
  });

  function commitDraft(path, editor) {
    if (path === 'keyboard') editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    else {
      instances.at(-1).controller.renderList(); // jsdom has no visibility observer callback
      const button = document.querySelector('.save-annotation-btn');
      if (button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))) button.focus();
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      button.click();
    }
  }

  it.each(['button', 'keyboard', 'double click', 'sidebar'])('%s retries failed creation once, saves through the content lane and closes', async path => {
    adapter.createAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new TypeError('Failed to fetch');
    });
    const editor = await startTypingDraft(30, path === 'sidebar' ? 'sidebar' : 'inline');
    await vi.advanceTimersByTimeAsync(400);
    commitDraft(path, editor);
    if (path === 'double click') commitDraft(path, editor);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('created-1');
    expect(stored.get('created-1')?.content).toBe('kommentar');
    expect(document.querySelector('.inline-annotation-editor')).toBeNull();
    expect(document.querySelector('.auto-resize-textarea')).toBeNull();
  });

  it.each(['sv', 'en'])('a second failure retains the draft and uses the %s host translation', async language => {
    const message = language === 'sv' ? 'Kunde inte skapa kommentaren.' : 'Failed to create annotation.';
    window.i18n = { t: vi.fn(key => key === 'Failed to create annotation.' ? message : key) };
    adapter.createAnnotation.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new TypeError('Failed to fetch');
    });
    const editor = await startTypingDraft();
    await vi.advanceTimersByTimeAsync(400);
    document.querySelectorAll('.alert-danger').forEach(el => el.remove());
    commitDraft('button', editor);
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(document.querySelector('.inline-annotation-editor')).toBe(editor);
    expect(editor.value).toBe('kommentar');
    expect(document.querySelector('.auto-resize-textarea')?.value).toBe('kommentar');
    expect(document.querySelector('.alert-danger')?.textContent).toContain(message);
    expect(window.i18n.t).toHaveBeenCalledWith('Failed to create annotation.', {});
  });

  it('Ctrl+Enter during the original POST waits for its server identity', async () => {
    const editor = await startTypingDraft();
    commitDraft('keyboard', editor);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(stored.get('created-1')?.content).toBe('kommentar');
    expect(document.querySelector('.inline-annotation-editor')).toBeNull();
  });

  it.each(['throw', 'unsuccessful'])('overlapping retries share one POST and a %s refusal can be retried again', async failure => {
    adapter.createAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new TypeError('Failed to fetch');
    });
    await startTypingDraft();
    await vi.advanceTimersByTimeAsync(400);
    adapter.createAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (failure === 'throw') throw new TypeError('Failed to fetch');
      return { success: false, error: 'Create refused' };
    });
    const draft = instances.at(-1).options.getAnnotationsData()[0][0];
    const first = draft._retryCreate();
    const second = draft._retryCreate();
    expect(first).toBe(second);
    const rejected = expect(first).rejects.toThrow('Failed to create annotation.');
    await vi.advanceTimersByTimeAsync(400);
    await rejected;
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(2);
    commitDraft('keyboard', document.querySelector('.inline-annotation-editor'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(3);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(stored.get('created-1')?.content).toBe('kommentar');
    expect(document.querySelector('.inline-annotation-editor')).toBeNull();
  });

  async function deleteCreated() {
    instances.at(-1).controller.renderList();
    const button = document.querySelector('.delete-annotation') || document.createElement('button');
    button.dataset.confirmed = 'true';
    await instances.at(-1).controller.deleteAnnotation(0, 'created-1', button);
    await vi.advanceTimersByTimeAsync(60);
    expect(stored.has('created-1')).toBe(false);
  }

  it.each(['inline', 'sidebar'])('delete closes the open %s editor and its keyboard/blur saves', async location => {
    const inline = await create();
    instances.at(-1).controller.renderList();
    const editor = location === 'inline' ? inline : document.querySelector('.auto-resize-textarea');
    editor.focus();
    editor.value = 'Do not save a deleted comment';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await deleteCreated();
    expect.soft(document.querySelector('.inline-annotation-editor')).toBeNull();
    expect.soft(document.querySelector('.auto-resize-textarea')).toBeNull();
    editor.dispatchEvent(new FocusEvent('blur'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
  });

  it('delete cancels a queued content save and ignores a PUT response already in flight', async () => {
    await create();
    let finishPut;
    adapter.updateAnnotation.mockImplementationOnce((_a, _s, _id, body) => new Promise(resolve => {
      finishPut = () => resolve({ success: true, annotation: { ...hostAnnotation, ...body } });
    }));
    const { helpers } = instances.at(-1).options;
    const first = helpers.saveAnnotationContentRequest('created-1', { content: 'First' }).catch(error => error);
    const queued = helpers.saveAnnotationContentRequest('created-1', { content: 'Queued' }).catch(error => error);
    await deleteCreated();
    finishPut();
    await first;
    await vi.advanceTimersByTimeAsync(600);
    await queued;
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(instances.at(-1).options.getAnnotationsData()[0]).toEqual([]);
  });

  it('delete prevents an in-flight editor save from adding history or restoring its marker', async () => {
    const editor = await create();
    editor.value = 'Saving while deleted';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    let finishPut;
    adapter.updateAnnotation.mockImplementationOnce((_a, _s, _id, body) => new Promise(resolve => {
      finishPut = () => resolve({ success: true, annotation: { ...hostAnnotation, ...body } });
    }));
    commitDraft('keyboard', editor);
    await vi.advanceTimersByTimeAsync(0);
    await deleteCreated();
    finishPut();
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector('.inline-annotation-editor')).toBeNull();
    expect(instances.at(-1).controller.getUndoStack().map(op => op.type)).not.toContain('edit');
  });

  it('delete cancels a blur save already scheduled before the DELETE resolves', async () => {
    const editor = await create();
    editor.value = 'Pending blur text';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.blur();
    await deleteCreated();
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
  });

  it('delete then undo explicitly re-creates; earlier history follows the new identity', async () => {
    await save(await create());
    await deleteCreated();
    adapter.createAnnotation.mockImplementationOnce(async (_a, _s, body) => {
      const annotation = { ...hostAnnotation, ...body, id: 'restored-2', stable_id: 'restored-2', xref: 2047 };
      stored.set(annotation.id, annotation);
      return { success: true, annotation };
    });
    adapter.updateAnnotation.mockClear();
    document.activeElement?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(stored.get('restored-2')?.content).toBe('Check the units');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(700);
    expect(adapter.updateAnnotation.mock.calls.every(call => call[2] === 'restored-2')).toBe(true);
    expect(adapter.deleteAnnotation).toHaveBeenCalledTimes(1);
  });

  it('a captured create-retry cannot create or save after the retried identity was deleted', async () => {
    adapter.createAnnotation.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await startTypingDraft();
    await vi.advanceTimersByTimeAsync(400);
    const draft = instances.at(-1).options.getAnnotationsData()[0][0];
    const retry = draft._retryCreate;
    const creating = retry();
    await vi.advanceTimersByTimeAsync(500);
    await creating;
    await deleteCreated();
    const lateRetry = retry().catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await lateRetry;
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
  });

  const missingMessage = 'This comment was deleted. Your text is kept. You can re-create it as a new comment.';
  const recoveryTranslations = {
    [missingMessage]: 'Kommentaren har tagits bort. Din text finns kvar. Du kan återskapa den som en ny kommentar.',
    'Re-create comment': 'Återskapa kommentar',
  };

  it.each([
    ['inline', 'en', 'throw'], ['inline', 'sv', 'throw'],
    ['sidebar', 'en', 'throw'], ['sidebar', 'sv', 'throw'],
    ['inline', 'en', 'response'], ['inline', 'sv', 'response'],
    ['sidebar', 'en', 'response'], ['sidebar', 'sv', 'response'],
  ])('a missing %s save (%s, %s) keeps text, notifies once and explicitly re-creates', async (location, language, failure) => {
    window.i18n = { t: vi.fn(key => language === 'sv' ? recoveryTranslations[key] || key : key) };
    const inline = await create();
    instances.at(-1).controller.renderList();
    const editor = location === 'inline' ? inline : document.querySelector('.auto-resize-textarea');
    editor.focus();
    editor.value = 'Keep <my> feedback';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    stored.delete('created-1'); // Server-side disappearance, not a local DELETE.
    adapter.updateAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (failure === 'throw') throw Object.assign(new Error('Annotation not found'), { status: 404 });
      return { success: false, status: 404, error: 'Annotation not found' };
    });
    commitDraft(location === 'inline' ? 'keyboard' : 'button', editor);
    await vi.advanceTimersByTimeAsync(700);
    expect.soft(editor.isConnected).toBe(true);
    expect.soft(editor.value).toBe('Keep <my> feedback');
    const message = language === 'sv' ? recoveryTranslations[missingMessage] : missingMessage;
    expect.soft(document.querySelector('.alert-danger')?.textContent).toContain(message);
    for (let i = 0; i < 3; i++) {
      editor.value = 'Keep <my> updated feedback';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      commitDraft(location === 'inline' ? 'keyboard' : 'button', editor);
      editor.blur();
      await vi.advanceTimersByTimeAsync(700);
    }
    expect.soft(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect.soft(document.querySelectorAll('.alert-danger')).toHaveLength(1);
    const recovery = document.querySelector('.recreate-annotation-btn');
    expect(recovery?.textContent).toBe(language === 'sv' ? recoveryTranslations['Re-create comment'] : 'Re-create comment');
    adapter.createAnnotation.mockImplementationOnce(async (_a, _s, body) => {
      await new Promise(resolve => setTimeout(resolve, 300));
      const annotation = { ...hostAnnotation, ...body, id: 'recreated-2', stable_id: 'recreated-2', xref: 2047 };
      stored.set(annotation.id, annotation);
      return { success: true, annotation };
    });
    recovery.click();
    recovery.click();
    await vi.advanceTimersByTimeAsync(900);
    expect(adapter.createAnnotation).toHaveBeenCalledTimes(2);
    expect(stored.get('recreated-2')?.content).toBe('Keep <my> updated feedback');
    expect(stored.has('created-1')).toBe(false);
    expect(instances.at(-1).options.getAnnotationsData()[0].map(a => a.id)).toEqual(['recreated-2']);
    expect(document.querySelector('.recreate-annotation-btn')).toBeNull();
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
  });

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
