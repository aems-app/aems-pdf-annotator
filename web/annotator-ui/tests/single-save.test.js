import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('one save with a 300 ms PUT', () => {
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
  async function saved(id = ids[0]) {
    await vi.advanceTimersByTimeAsync(800);
    expect.soft(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect.soft(stored.get(id).content).toBe('Saved feedback');
    expect.soft(label(id).querySelector('textarea')).toBeNull();
    expect.soft(label(id).textContent).toContain('Saved feedback');
    expect.soft(sidebar(id)).toBeNull(); expect(toasts).not.toHaveBeenCalled();
  }
  it.each(ids.slice(0, 2))('Save from inline %s sends one PUT and closes', async id => { edit(id); click(button(id)); await saved(id); });
  it.each(['inline', 'summary', 'sidebar'])('Ctrl+Enter from %s saves once', async location => {
    const id = location === 'summary' ? ids[1] : ids[0]; let editor = edit(id);
    if (location === 'sidebar') { editor = sidebar(id); editor.focus(); await vi.advanceTimersByTimeAsync(160); } key(editor); await saved(id);
  });
  it.each(['inline', 'summary', 'sidebar'])('blur from %s to elsewhere saves once', async location => {
    const id = location === 'summary' ? ids[1] : ids[0]; edit(id);
    if (location === 'sidebar') { sidebar(id).focus(); await vi.advanceTimersByTimeAsync(160); }
    document.getElementById('elsewhere').focus(); await saved(id);
  });
  it('Ctrl+Enter on unchanged text closes both editors without a PUT', async () => {
    key(edit(ids[0], 'Original feedback-1'));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(label(ids[0]).querySelector('textarea')).toBeNull();
    expect(sidebar(ids[0])).toBeNull();
  });
  it.each(['inline', 'sidebar'])('Save then immediately open another comment preserves its %s draft and refreshes saved views', async location => {
    edit(); click(button(ids[0])); const inline = edit(ids[2], 'Second draft');
    const active = location === 'sidebar' ? sidebar(ids[2]) : inline;
    active.focus(); active.setSelectionRange(2, 5, 'backward');
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1); expect(stored.get(ids[0]).content).toBe('Saved feedback');
    expect(label(ids[0]).querySelector('textarea')).toBeNull();
    expect(label(ids[2]).querySelector('textarea')?.value).toBe('Second draft');
    expect(sidebar(ids[2])?.value).toBe('Second draft'); expect(toasts).not.toHaveBeenCalled();
    expect.soft(document.activeElement).toBe(active);
    expect.soft([active.selectionStart, active.selectionEnd, active.selectionDirection]).toEqual([2, 5, 'backward']);
    expect.soft(options.getAnnotationsData()[0].find(a => a.id === ids[0]).content).toBe('Saved feedback');
    expect.soft(label(ids[0]).textContent).toContain('Saved feedback');
    expect.soft(document.querySelector(`.list-group-item[data-annotation-identifier="${ids[0]}"]`)?.textContent).toContain('Saved feedback');
    label(ids[0]).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    expect(label(ids[0]).querySelector('textarea')?.value).toBe('Saved feedback');
  });
  it('two quick Save clicks send one PUT', async () => { edit(); const b = button(ids[0]); click(b); click(b); await saved(); });
  it.each(['.save-annotation-btn', '.cancel-edit-btn'])('focus on own %s does not blur-save', async selector => {
    edit(); button(ids[0], selector).focus(); await vi.advanceTimersByTimeAsync(150);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    click(button(ids[0], selector));
    if (selector === '.save-annotation-btn') await saved();
    else { await vi.advanceTimersByTimeAsync(500); expect(adapter.updateAnnotation).not.toHaveBeenCalled(); expect(adapter.deleteAnnotation).not.toHaveBeenCalled(); }
  });
  it.each(['button', 'keyboard', 'blur', 'sidebar'])('a real %s failure keeps text and allows retry', async path => {
    adapter.updateAnnotation.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 300)); throw new Error('Host refused save'); });
    const editor = edit();
    if (path === 'keyboard') key(editor);
    else if (path === 'blur') document.getElementById('elsewhere').focus();
    else { if (path === 'sidebar') { sidebar(ids[0]).focus(); await vi.advanceTimersByTimeAsync(160); } click(button(ids[0])); }
    await vi.advanceTimersByTimeAsync(800);
    expect.soft(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect.soft(label(ids[0]).querySelector('textarea')?.value).toBe('Saved feedback');
    expect.soft(sidebar(ids[0])?.value).toBe('Saved feedback');
    expect.soft(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Host refused save'));
    if (path === 'keyboard') key(label(ids[0]).querySelector('textarea')); else click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2); expect(stored.get(ids[0]).content).toBe('Saved feedback');
    expect(label(ids[0]).querySelector('textarea')).toBeNull();
  });
  it.each(['button', 'keyboard'])('an unsuccessful %s response retains the editor and retry text', async path => {
    adapter.updateAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { success: false, error: 'Host rejected content' };
    });
    const editor = edit();
    if (path === 'keyboard') key(editor); else click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(label(ids[0]).querySelector('textarea')?.value).toBe('Saved feedback');
    expect(sidebar(ids[0])?.value).toBe('Saved feedback');
    expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Host rejected content'));
    click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    expect(label(ids[0]).querySelector('textarea')).toBeNull();
  });
  function editSidebarOnly() {
    controller.beginEdit(0, ids[0]);
    helpers.collapseInlineLabel(label(ids[0]));
    options.setEditingAnnotationId('ann-0-' + ids[0]);
    label(ids[0]).closest('.annotation-marker').remove();
    const editor = sidebar(ids[0]);
    editor.focus();
    editor.value = 'Saved feedback';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return editor;
  }
  describe.each(['canvas', 'offline'])('newer pending text in %s', mode => {
    beforeEach(() => sessionStorage.setItem('aems_assignment_mode', mode === 'offline' ? 'offline' : 'server'));
    afterEach(() => sessionStorage.removeItem('aems_assignment_mode'));
    function start(location) {
      const editor = location === 'standalone sidebar' ? editSidebarOnly() : edit();
      return location === 'inline' ? editor : sidebar(ids[0]);
    }
    function expectDraft(editor, text) {
      expect(editor.isConnected).toBe(true);
      expect(editor.value).toBe(text);
      expect(sidebar(ids[0])?.value).toBe(text);
      expect(document.activeElement).toBe(editor);
      expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 5]);
    }
    it.each(['inline', 'sidebar', 'standalone sidebar'])('%s keeps unsaved typing and caret after the first acknowledgement', async location => {
      const editor = start(location);
      type(editor, 'First edit');
      click(button(ids[0]));
      type(editor, 'Latest edit');
      editor.setSelectionRange(2, 5);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
      expect(adapter.updateAnnotation.mock.calls[0][4]).toEqual({ offline: mode === 'offline' });
      expect(stored.get(ids[0]).content).toBe('First edit');
      expectDraft(editor, 'Latest edit');
      expect(options.getAnnotationsData()[0][0]._originalContent).toBe('First edit');
      key(editor);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(stored.get(ids[0]).content).toBe('Latest edit');
      expect(sidebar(ids[0])).toBeNull();
      expect(toasts).not.toHaveBeenCalled();
    });
    it.each(['inline', 'sidebar', 'standalone sidebar'])('%s coalesces repeated saves to the latest requested text', async location => {
      const editor = start(location);
      type(editor, 'First edit');
      key(editor);
      type(editor, 'Middle edit');
      key(editor);
      type(editor, 'Latest edit');
      click(button(ids[0]));
      key(editor);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(adapter.updateAnnotation.mock.calls.map(call => call[3].content)).toEqual(['First edit', 'Latest edit']);
      expect(editor.isConnected).toBe(true);
      expect(editor.value).toBe('Latest edit');
      await vi.advanceTimersByTimeAsync(500);
      expect(stored.get(ids[0]).content).toBe('Latest edit');
      expect(sidebar(ids[0])).toBeNull();
      expect(toasts).not.toHaveBeenCalled();
    });
    it.each(['inline', 'sidebar', 'standalone sidebar'])('%s keeps typing that was never requested while a trailing save settles', async location => {
      const editor = start(location);
      type(editor, 'First edit');
      key(editor);
      type(editor, 'Queued edit');
      key(editor);
      type(editor, 'Unsaved latest edit');
      editor.setSelectionRange(2, 5);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(stored.get(ids[0]).content).toBe('Queued edit');
      expectDraft(editor, 'Unsaved latest edit');
      expect(toasts).not.toHaveBeenCalled();
    });
    it.each(['inline', 'sidebar', 'standalone sidebar'])('%s saves a return to the original text after an in-flight edit', async location => {
      const editor = start(location);
      type(editor, 'First edit');
      key(editor);
      type(editor, 'Original feedback-1');
      key(editor);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(stored.get(ids[0]).content).toBe('Original feedback-1');
      expect(sidebar(ids[0])).toBeNull();
    });
    it('the shared request lane coalesces intermediate content and resolves joined callers with the latest acknowledgement', async () => {
      const request = options.helpers.saveAnnotationContentRequest;
      const results = Promise.all([
        request(ids[0], { content: 'First edit' }),
        request(ids[0], { content: 'Middle edit' }),
        request(ids[0], { content: 'Latest edit' }),
        request(ids[0], { content: 'Latest edit' }),
      ]);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect((await results).map(result => result.annotation.content)).toEqual(['First edit', 'Latest edit', 'Latest edit', 'Latest edit']);
      expect(stored.get(ids[0]).content).toBe('Latest edit');
    });
    it('returning to the in-flight text cancels an intermediate requested edit without another PUT', async () => {
      const request = options.helpers.saveAnnotationContentRequest;
      const results = Promise.all([
        request(ids[0], { content: 'First edit' }),
        request(ids[0], { content: 'Middle edit' }),
        request(ids[0], { content: 'First edit' }),
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
      expect((await results).every(result => result.annotation.content === 'First edit')).toBe(true);
      expect(stored.get(ids[0]).content).toBe('First edit');
    });
    it('content queued after the trailing PUT starts also coalesces to one latest request', async () => {
      const request = options.helpers.saveAnnotationContentRequest;
      const first = request(ids[0], { content: 'First edit' });
      const second = request(ids[0], { content: 'Second edit' });
      await vi.advanceTimersByTimeAsync(300);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      const third = request(ids[0], { content: 'Third edit' });
      const latest = request(ids[0], { content: 'Latest edit' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.updateAnnotation.mock.calls.map(call => call[3].content)).toEqual(['First edit', 'Second edit', 'Latest edit']);
      expect((await Promise.all([first, second, third, latest])).map(result => result.annotation.content)).toEqual(['First edit', 'Second edit', 'Latest edit', 'Latest edit']);
    });
    it('a standalone controller without the draft lookup helper also preserves newer text', async () => {
      delete options.helpers.annotationDraftContent;
      const editor = start('standalone sidebar');
      type(editor, 'First edit');
      click(button(ids[0]));
      type(editor, 'Latest edit');
      editor.setSelectionRange(2, 5);
      await vi.advanceTimersByTimeAsync(800);
      expectDraft(editor, 'Latest edit');
      expect(stored.get(ids[0]).content).toBe('First edit');
    });
    it.each(['inline', 'standalone sidebar'])('%s keeps text the host did not acknowledge', async location => {
      adapter.updateAnnotation.mockImplementationOnce(async (_a, _s, id) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        const annotation = { ...stored.get(id), content: '' };
        stored.set(id, annotation);
        return { success: true, annotation };
      });
      const editor = start(location);
      type(editor, 'Latest edit');
      key(editor);
      editor.setSelectionRange(2, 5);
      await vi.advanceTimersByTimeAsync(800);
      expectDraft(editor, 'Latest edit');
      expect(options.getAnnotationsData()[0][0]._originalContent).toBe('');
      key(editor);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(stored.get(ids[0]).content).toBe('Latest edit');
      expect(sidebar(ids[0])).toBeNull();
    });
    it.each(['inline', 'sidebar', 'standalone sidebar'])('%s retains the latest text when the trailing save fails and permits retry', async location => {
      const update = adapter.updateAnnotation.getMockImplementation();
      adapter.updateAnnotation.mockImplementationOnce(update).mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        throw new Error('Trailing save refused');
      });
      const editor = start(location);
      type(editor, 'First edit');
      key(editor);
      type(editor, 'Latest edit');
      key(editor);
      editor.setSelectionRange(2, 5);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(stored.get(ids[0]).content).toBe('First edit');
      expectDraft(editor, 'Latest edit');
      expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Trailing save refused'));
      expect(options.getAnnotationsData()[0][0]).toMatchObject({ content: 'First edit', _originalContent: 'First edit' });
      key(editor);
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(3);
      expect(stored.get(ids[0]).content).toBe('Latest edit');
      expect(sidebar(ids[0])).toBeNull();
    });
  });
  it.each(['button', 'keyboard', 'blur'])('standalone sidebar %s saves once and closes', async path => {
    const editor = editSidebarOnly();
    await vi.advanceTimersByTimeAsync(160);
    if (path === 'keyboard') key(editor);
    else if (path === 'blur') document.getElementById('elsewhere').focus();
    else click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(stored.get(ids[0]).content).toBe('Saved feedback');
    expect(sidebar(ids[0])).toBeNull();
    expect(toasts).not.toHaveBeenCalled();
  });
  it('standalone sidebar failure retains text and one retry works', async () => {
    adapter.updateAnnotation.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new Error('Host refused save');
    });
    editSidebarOnly();
    click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(sidebar(ids[0])?.value).toBe('Saved feedback');
    expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Host refused save'));
    click(button(ids[0]));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    expect(sidebar(ids[0])).toBeNull();
  });
  it('blur during a keyboard save cannot start another PUT', async () => {
    const editor = edit();
    key(editor);
    await vi.advanceTimersByTimeAsync(50);
    document.getElementById('elsewhere').focus();
    await saved();
  });
  it('Cancel of an empty new draft deletes once without a PUT', async () => {
    const annotation = options.getAnnotationsData()[0].find(a => a.id === ids[0]);
    annotation._isTemporary = true;
    annotation.content = annotation._originalContent = 'New comment...';
    helpers.setupLabelTooltipEvents(label(ids[0]), 'New comment...');
    edit(ids[0], '');
    click(button(ids[0], '.cancel-edit-btn'));
    await vi.advanceTimersByTimeAsync(800);
    expect(adapter.deleteAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(stored.has(ids[0])).toBe(false);
  });
  it('identical requests join while different annotations save independently', async () => {
    const request = options.helpers.updateAnnotationRequest;
    const results = Promise.allSettled([request(ids[0], { content: 'Same' }), request(ids[0], { content: 'Same' }), request(ids[2], { content: 'Other' })]);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(800);
    expect((await results).every(r => r.status === 'fulfilled')).toBe(true); expect(toasts).not.toHaveBeenCalled();
  });
  it('different pending editor content is serialized for the same annotation', async () => {
    const request = options.helpers.saveAnnotationContentRequest || options.helpers.updateAnnotationRequest;
    const results = Promise.allSettled([request(ids[0], { content: 'First' }), request(ids[0], { content: 'Second' })]);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(800);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2); expect(stored.get(ids[0]).content).toBe('Second');
    expect((await results).every(r => r.status === 'fulfilled')).toBe(true); expect(toasts).not.toHaveBeenCalled();
  });
  it('different concurrent mutations retain the conflict refresh and error toast', async () => {
    const request = options.helpers.updateAnnotationRequest;
    const results = Promise.allSettled([request(ids[0], { color: 'red' }), request(ids[0], { content: 'Other edit' })]);
    await vi.advanceTimersByTimeAsync(800);
    expect((await results).every(r => r.status === 'rejected')).toBe(true);
    expect(adapter.listAnnotations).toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Concurrent annotation changes refreshed'));
  });
  it('a genuine external version still reloads after a local save', async () => {
    await sync._checkVersion(); key(edit()); await saved(); await sync._checkVersion();
    version = 'external-v2'; stored.get(ids[0]).content = 'Other reviewer'; await sync._checkVersion(); await vi.advanceTimersByTimeAsync(500);
    expect(adapter.listAnnotations).toHaveBeenCalled();
    expect(options.getAnnotationsData()[0].find(a => a.id === ids[0]).content).toBe('Other reviewer');
    expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
  });

  // Per-annotation optimistic concurrency (AEMS review CSRF1108REV1, finding 2): every write
  // names the version of the comment it was based on, so a stale copy can never silently
  // replace another reviewer's newer text.
  describe('If-Match on every comment write', () => {
    const local = id => options.getAnnotationsData()[0].find(a => a.id === id);
    const conflict = (current) => Object.assign(new Error('Someone else changed this comment after you opened it.'), {
      status: 409, code: 'ANNOTATION_CONFLICT', current,
    });
    beforeEach(() => {
      ids.forEach((id, n) => { local(id).etag = `e${n}-1`; stored.get(id).etag = `e${n}-1`; });
      let next = 2;
      adapter.updateAnnotation.mockImplementation(async (_a, _s, id, body) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        const annotation = { ...stored.get(id), ...body, etag: `e-${id}-${next++}` }; stored.set(id, annotation);
        return { success: true, annotation: { ...annotation } };
      });
    });

    it('an editor save sends the etag of the comment it opened', async () => {
      key(edit()); await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
      expect(adapter.updateAnnotation.mock.calls[0][4]).toMatchObject({ ifMatch: 'e0-1' });
    });

    it('the next save uses the etag the previous save returned', async () => {
      key(edit()); await vi.advanceTimersByTimeAsync(800);
      const returned = stored.get(ids[0]).etag;
      key(edit(ids[0], 'Second text')); await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(adapter.updateAnnotation.mock.calls[1][4]).toMatchObject({ ifMatch: returned });
      expect(toasts).not.toHaveBeenCalled();
    });

    it('a write overlapping my own in-flight write to the comment names no stale etag', async () => {
      const request = options.helpers.updateAnnotationRequest;
      const results = Promise.allSettled([request(ids[0], { color: 'red' }), request(ids[0], { content: 'Other edit' })]);
      expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
      expect(adapter.updateAnnotation.mock.calls[0][4]).toMatchObject({ ifMatch: 'e0-1' });
      expect(adapter.updateAnnotation.mock.calls[1][4]).toEqual({ offline: false });
      await vi.advanceTimersByTimeAsync(800);
      // Reconciled exactly as before this change: refresh from the server, one notice.
      expect((await results).every(r => r.status === 'rejected')).toBe(true);
      expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Concurrent annotation changes refreshed'));
    });

    it('a conflict shows the other reviewer\'s text and keeps mine behind "Use my text"', async () => {
      const theirs = { ...stored.get(ids[0]), content: 'Theirs', etag: 'e-theirs' };
      stored.set(ids[0], theirs);
      adapter.updateAnnotation.mockImplementationOnce(async () => { throw conflict({ ...theirs }); });

      key(edit(ids[0], 'My stale text')); await vi.advanceTimersByTimeAsync(800);

      expect(local(ids[0]).content).toBe('Theirs');
      expect(label(ids[0]).textContent).toContain('Theirs');
      const toast = [...document.querySelectorAll('.alert')].find(el => el.textContent.includes('Someone else changed this comment'));
      expect(toast, 'a visible conflict notice').toBeTruthy();
      const useMine = [...toast.querySelectorAll('button')].find(b => b.textContent === 'Use my text');
      expect(useMine, 'my text must be recoverable').toBeTruthy();

      useMine.click(); await vi.advanceTimersByTimeAsync(800);
      const last = adapter.updateAnnotation.mock.calls.at(-1);
      expect(last[3]).toEqual({ content: 'My stale text' });
      expect(last[4]).toMatchObject({ ifMatch: 'e-theirs' });
      expect(stored.get(ids[0]).content).toBe('My stale text');
    });

    it('a delete sends the etag and a conflicting delete leaves the newer comment', async () => {
      const theirs = { ...stored.get(ids[0]), content: 'Kept by the other reviewer', etag: 'e-theirs' };
      adapter.deleteAnnotation.mockImplementationOnce(async () => { stored.set(ids[0], theirs); throw conflict({ ...theirs }); });
      const outcome = await options.helpers.deleteAnnotationRequest(ids[0]).then(() => 'ok', () => 'refused');
      await vi.advanceTimersByTimeAsync(800);
      expect(adapter.deleteAnnotation.mock.calls[0][3]).toMatchObject({ ifMatch: 'e0-1' });
      expect(outcome).toBe('refused');
      expect(local(ids[0])?.content).toBe('Kept by the other reviewer');
      expect(toasts).toHaveBeenCalledWith('error', expect.stringContaining('Someone else changed this comment'));
    });

    it('a comment without an etag (old server) sends no If-Match', async () => {
      delete local(ids[0]).etag;
      key(edit()); await vi.advanceTimersByTimeAsync(800);
      expect(adapter.updateAnnotation.mock.calls[0][4]).toEqual({ offline: false });
    });

    it('a notice with an action is shown inside the native fullscreen element', async () => {
      const host = document.getElementById('pdfGradedContainer');
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => host });
      try {
        adapter.updateAnnotation.mockImplementationOnce(async () => { throw conflict({ ...stored.get(ids[0]), content: 'Theirs', etag: 'e-x' }); });
        key(edit(ids[0], 'Mine')); await vi.advanceTimersByTimeAsync(800);
        const toast = [...document.querySelectorAll('.alert')].find(el => el.textContent.includes('Someone else changed'));
        expect(toast && host.contains(toast)).toBe(true);
      } finally {
        delete document.fullscreenElement;
      }
    });
  });
});
