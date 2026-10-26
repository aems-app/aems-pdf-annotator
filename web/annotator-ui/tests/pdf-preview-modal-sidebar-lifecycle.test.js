import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const annotation = {
  id: 'Q1-04', stable_id: 'Q1-04', xref: 1046, page_index: 0,
  type: 'Highlight', content: 'Teacher feedback', source: 'HUMAN',
  original_source: 'AI', can_revert_to_ai: true, color: 'amber',
  rect: [10, 20, 100, 40], quads: [[10, 20, 100, 40]],
};

describe('real modal sidebar controller lifecycle', () => {
  let instances;
  let modals;
  let adapter;
  let list;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf') || key === 'PDFViewer') {
        delete window[key];
      }
    }
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div><div id="pdfPreviewStudent"></div>
      <div id="pdfOriginalPane"></div><div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button><button id="pdfGradedTab"></button>
      <div id="pdfGradedCommentsList"></div><div id="pdfGradedAICommentsList"></div>
      <div id="pdfGradedContainer"></div><div id="pdfOriginalContainer"></div>`;
    list = document.getElementById('pdfGradedCommentsList');
    window.bootstrap = { Modal: class {
      show() {}
      static getInstance() { return null; }
    } };
    window.PdfPreviewModalViewer = {
      resolvePdfjsLib: () => ({}),
      PDFViewer: class {
        onAnnotationsPageChange() {}
        onPageRendered() {}
        onSliderSync() {}
        onResizeComplete() {}
      },
    };
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await import('../src/pdf-preview-modal/utils.js');
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/sidebar-panel.js');
    await import('../src/pdf-preview-modal/modal-state.js');
    // Visibility is orthogonal to dispatch; render a real card without a PDF canvas.
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    await import('../src/pdf-preview-modal/annotation-controller.js');
    const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
    instances = [];
    modals = [];
    vi.spyOn(window.PdfPreviewModalAnnotationController, 'createAnnotationController')
      .mockImplementation((options) => {
        const controller = factory(options);
        const helpers = options.helpers;
        for (const method of ['revertAnnotationToAiRequest', 'toggleAnnotationVerdict',
          'updateAnnotationPriority', 'scrollToAnnotationMarker']) {
          vi.spyOn(helpers, method);
        }
        // Optional keyboard-delete callback supported by the sidebar controller.
        helpers.deleteAnnotation = vi.fn();
        instances.push({ controller, options, helpers });
        return controller;
      });
    adapter = {
      supportsRevertToAi: () => true,
      revertAnnotationToAi: vi.fn().mockResolvedValue({ success: true }),
      updateAnnotation: vi.fn(async (_assignment, _submission, _id, body) => ({
        success: true, annotation: { ...annotation, ...body },
      })),
      deleteAnnotation: vi.fn().mockResolvedValue({ success: true }),
      listAnnotations: vi.fn().mockResolvedValue({ success: true, annotations: { 0: [annotation] } }),
    };
    await import('../src/pdf-preview-modal.js');
  });

  afterEach(() => {
    modals.forEach((modal) => modal.destroy());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function createModal() {
    const modal = window.PdfPreviewModal.createPdfPreviewModal({
      assignmentId: 'assignment-1', submissionId: 'submission-1', modeAdapter: adapter,
    });
    modals.push(modal);
    await modal.open();
    const instance = instances.at(-1);
    instance.options.setAnnotationsData({ 0: [{ ...annotation }] });
    instance.controller.renderSidebar();
    expect(list.querySelector('.list-group-item')).not.toBeNull();
    return { modal, ...instance };
  }

  function replaceSidebar(current, cycles = 50) {
    for (let i = 0; i < cycles; i++) {
      const previousRow = list.querySelector('.list-group-item');
      current.options.setAnnotationsData({ 0: [{ ...annotation, content: `Reload ${i}` }] });
      current.controller.renderSidebar();
      expect(previousRow.isConnected, `replacement ${i + 1} must detach the old row`).toBe(false);
    }
  }

  async function reopen(cycles = 2, replacements = 0) {
    for (let i = 0; i < cycles; i++) {
      const previous = await createModal();
      previous.modal.destroy();
    }
    const current = await createModal();
    replaceSidebar(current, replacements);
    expect(document.getElementById('pdfGradedCommentsList')).toBe(list);
    return current;
  }

  it.each([[0, 0], [1, 0], [2, 0], [2, 50]])('Restore reaches the current controller and host exactly once after %i reopens and %i replacements', async (cycles, replacements) => {
    const current = await reopen(cycles, replacements);
    const handler = vi.spyOn(current.controller, 'revertAnnotationToAi');
    const button = list.querySelector('.revert-annotation-to-ai');
    expect(button).not.toBeNull();
    button.click();
    await Promise.resolve();
    expect(handler, 'Restore must dispatch to the current live controller').toHaveBeenCalledExactlyOnceWith(0, 'Q1-04', button);
    expect(current.helpers.revertAnnotationToAiRequest).toHaveBeenCalledExactlyOnceWith('Q1-04');
    expect(adapter.revertAnnotationToAi).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'Q1-04');
  });

  const actions = [
    ['edit', '.edit-annotation', 'click', 'beginEdit'],
    ['save text', '.save-annotation-btn', 'click', 'saveAnnotationEdit'],
    ['delete', '.delete-annotation', 'click', 'deleteAnnotation'],
    ['verdict/level', '.verdict-indicator', 'click', 'toggleAnnotationVerdict'],
    ['priority', '.priority-dot[data-priority="red"]', 'mousedown', 'updateAnnotationPriority'],
    ['navigation', '.annotation-content', 'click', 'scrollToAnnotationMarker'],
    ['keyboard delete', '.list-group-item', 'keydown', 'deleteAnnotation'],
    ['double-click edit', '.annotation-content', 'dblclick', 'beginEdit'],
  ];

  it.each(actions.flatMap((action) => [[0, 0], [2, 0], [2, 50]].map((scenario) => [...action, ...scenario])))('%s dispatches only to the current controller (%s, %s, %s, %i reopens, %i replacements)', async (name, selector, type, method, cycles, replacements) => {
    const current = await reopen(cycles, replacements);
    if (name === 'save text') {
      current.controller.beginEdit(0, 'Q1-04', list.querySelector('.list-group-item').dataset.annotationId);
      replaceSidebar(current, replacements);
    }
    const owner = ['verdict/level', 'priority', 'navigation', 'keyboard delete'].includes(name)
      ? current.helpers : current.controller;
    const handler = vi.spyOn(owner, method).mockImplementation(() => Promise.resolve());
    const staleHandlers = instances.slice(0, -1).map((instance) => (
      vi.spyOn(owner === current.helpers ? instance.helpers : instance.controller, method)
        .mockImplementation(() => Promise.resolve())
    ));
    const target = list.querySelector(selector);
    expect(target, `rendered ${name} target`).not.toBeNull();
    const event = type === 'keydown'
      ? new KeyboardEvent(type, { key: 'Delete', bubbles: true, cancelable: true })
      : new MouseEvent(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(handler, `${name} must reach the current live controller`).toHaveBeenCalledOnce();
    const domId = target.closest('.list-group-item').dataset.annotationId;
    const args = {
      edit: [0, 'Q1-04', domId],
      'save text': ['Q1-04', target],
      delete: [0, 'Q1-04', target],
      'verdict/level': [0, 'Q1-04', target],
      priority: [0, 'Q1-04', 'red'],
      navigation: [0, 'Q1-04'],
      'keyboard delete': [0, 'Q1-04', target.querySelector('.delete-annotation')],
      'double-click edit': [0, 'Q1-04', domId],
    }[name];
    expect(handler).toHaveBeenCalledWith(...args);
    staleHandlers.forEach((stale) => expect(stale, `${name} must not reach a destroyed controller`).not.toHaveBeenCalled());
  });

  it.each([0, 2])('card selection updates only the live controller after %i reopens', async (cycles) => {
    const current = await reopen(cycles);
    list.querySelector('.annotation-content').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(current.modal._state.annotations.selectedId).toBe('Q1-04');
    for (const modal of modals.slice(0, -1)) expect(modal._state.annotations.selectedId).toBeNull();
  });

  it.each(['save text', 'delete', 'priority', 'verdict/level'].flatMap((name) => [[0, 0], [2, 0], [2, 50]].map((scenario) => [name, ...scenario])))('%s calls the host once after %i reopens and %i replacements', async (name, cycles, replacements) => {
    const current = await reopen(cycles, replacements);
    let expectedBody;
    if (name === 'save text') {
      list.querySelector('.edit-annotation').click();
      expect(current.modal._state.annotations.editingId).toBeTruthy();
      replaceSidebar(current, replacements);
      list.querySelector('textarea').value = 'Updated teacher feedback';
      list.querySelector('.save-annotation-btn').click();
      expectedBody = { content: 'Updated teacher feedback' };
    } else if (name === 'delete') {
      list.querySelector('.delete-annotation').click();
      expect(adapter.deleteAnnotation).not.toHaveBeenCalled();
      expect(list.querySelector('.confirm-delete-yes')).not.toBeNull();
      list.querySelector('.confirm-delete-yes').click();
    } else if (name === 'priority') {
      list.querySelector('.priority-dot[data-priority="red"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      expectedBody = { color: 'red' };
    } else {
      list.querySelector('.verdict-indicator').click();
      expectedBody = { is_verdict: true, source: 'HUMAN' };
    }
    // Finish the real async controller/helper flow before checking host effects.
    await Promise.resolve();
    await Promise.resolve();
    const hostMethod = name === 'delete' ? adapter.deleteAnnotation : adapter.updateAnnotation;
    expect(hostMethod).toHaveBeenCalledOnce();
    expect(hostMethod.mock.calls[0].slice(0, 2)).toEqual(['assignment-1', 'submission-1']);
    if (expectedBody) expect(hostMethod.mock.calls[0][3]).toEqual(expectedBody);
  });

  it('Cancel and textarea synchronization still work after reopening and 50 editing replacements', async () => {
    const current = await reopen();
    current.controller.beginEdit(0, 'Q1-04', list.querySelector('.list-group-item').dataset.annotationId);
    replaceSidebar(current);
    const inlineLabel = document.createElement('div');
    inlineLabel.className = 'annotation-label label-editing';
    inlineLabel.innerHTML = '<textarea class="inline-annotation-editor"></textarea>';
    document.body.appendChild(inlineLabel);
    const textarea = list.querySelector('textarea');
    const selection = current.modal._state.annotations.selectedId;
    const row = textarea.closest('.list-group-item');
    textarea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(current.modal._state.annotations.selectedId).toBe(selection);
    textarea.focus();
    row.classList.remove('item-focused', 'active');
    textarea.value = 'Edited teacher feedback';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inlineLabel.querySelector('textarea').value).toBe('Edited teacher feedback');
    expect(row.classList.contains('item-focused')).toBe(false);
    const inlineTextarea = inlineLabel.querySelector('textarea');
    inlineTextarea.focus();
    textarea.value = 'Sidebar must not overwrite the focused inline editor';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inlineTextarea.value).toBe('Edited teacher feedback');
    list.querySelector('.cancel-edit-btn').click();
    await Promise.resolve();
    expect(current.modal._state.annotations.editingId).toBeNull();
    expect(list.querySelector('.edit-annotation')).not.toBeNull();
  });

  it('selection, focus and blur still work after 50 replacements without selecting controls', async () => {
    const current = await reopen(2, 50);
    const row = list.querySelector('.list-group-item');
    for (const selector of ['.edit-annotation i', '.verdict-indicator']) {
      row.querySelector(selector).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      expect(current.modal._state.annotations.selectedId).toBeNull();
      expect(document.activeElement).not.toBe(row);
    }
    row.querySelector('.annotation-content').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(current.modal._state.annotations.selectedId).toBe('Q1-04');
    expect(document.activeElement).toBe(row);
    expect(row.classList.contains('item-focused')).toBe(true);
    expect(row.classList.contains('active')).toBe(true);
    row.blur();
    expect(row.classList.contains('item-focused')).toBe(false);
    expect(row.classList.contains('active')).toBe(false);
    row.focus();
    expect(row.classList.contains('item-focused')).toBe(true);
    expect(row.classList.contains('active')).toBe(true);
  });

  it.each(['rows', 'editing', 'empty'])('keeps owned sidebar listeners bounded across 50 replacements (%s)', async (mode) => {
    const activeBindings = [];
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const capture = (options) => typeof options === 'boolean' ? options : !!options?.capture;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (type, listener, options) {
      if (this === list || list.contains(this)) {
        activeBindings.push({ element: this, type, listener, capture: capture(options) });
      }
      return originalAdd.call(this, type, listener, options);
    });
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (type, listener, options) {
      const index = activeBindings.findIndex((binding) => binding.element === this
        && binding.type === type && binding.listener === listener && binding.capture === capture(options));
      if (index !== -1) activeBindings.splice(index, 1);
      return originalRemove.call(this, type, listener, options);
    });
    const current = await createModal();
    if (mode === 'editing') {
      // Render editing controls without beginEdit's separate auto-resize/keyboard setup.
      current.options.setEditingAnnotationId(list.querySelector('.list-group-item').dataset.annotationId);
      current.controller.renderSidebar();
      expect(list.querySelector('textarea')).not.toBeNull();
      expect(list.querySelector('.cancel-edit-btn')).not.toBeNull();
    }
    const initialCount = activeBindings.length;
    expect(initialCount).toBeGreaterThan(0);
    replaceSidebar(current);
    if (mode === 'empty') {
      current.options.setAnnotationsData({});
      current.controller.renderSidebar();
      expect(list.querySelector('.list-group-item')).toBeNull();
    }
    expect(activeBindings.length, 'listener ownership must stay constant as rows are replaced').toBeLessThanOrEqual(initialCount);
    expect(activeBindings.filter(({ element }) => !element.isConnected), 'no detached child may retain an owned sidebar listener').toEqual([]);
    expect(activeBindings.every(({ element }) => element === list), 'owned listeners belong only to the persistent list').toBe(true);
    expect(new Set(activeBindings.map(({ type }) => type)).size, 'each event type is delegated once').toBe(activeBindings.length);
    current.modal.destroy();
    expect(activeBindings, 'destroy must release every owned listener').toEqual([]);
  });

  it('destroy removes only its own listeners after 50 replacements and clears the persistent binding flag', async () => {
    const addListener = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const removeListener = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const current = await createModal();
    replaceSidebar(current);
    const bindings = addListener.mock.calls.flatMap(([type, listener], index) => {
      const element = addListener.mock.contexts[index];
      return element === list || list.contains(element) ? [{ element, type, listener }] : [];
    });
    const hostListener = vi.fn();
    list.addEventListener('click', hostListener);
    current.modal.destroy();
    for (const { element, type, listener } of bindings) {
      const removed = removeListener.mock.calls.some((args, index) => (
        removeListener.mock.contexts[index] === element && args[0] === type && args[1] === listener
      ));
      expect(removed, `owned ${type} listener must be detached`).toBe(true);
    }
    expect(list.dataset.annotationControllerBound).toBeUndefined();
    list.querySelector('.revert-annotation-to-ai').click();
    expect(hostListener).toHaveBeenCalledOnce();
    expect(adapter.revertAnnotationToAi).not.toHaveBeenCalled();
  });

  it.each(['click', 'mousedown', 'keydown', 'dblclick', 'input', 'focusin', 'focusout'])('an already queued %s listener warns and lets the event propagate after destroy', async (type) => {
    const addListener = vi.spyOn(list, 'addEventListener');
    const current = await createModal();
    const listener = addListener.mock.calls.find(([eventType]) => eventType === type)?.[1];
    expect(listener).toBeTypeOf('function');
    current.modal.destroy();
    for (const method of ['toggleAnnotationVerdict', 'updateAnnotationPriority', 'scrollToAnnotationMarker']) {
      current.helpers[method].mockImplementation(() => {});
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const event = {
      target: type === 'mousedown' ? list.querySelector('.priority-dot') : list.querySelector('.revert-annotation-to-ai'),
      key: 'Delete', preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    listener.call(list, event);
    expect(warn, 'a destroyed controller must diagnose a late sidebar action').toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(adapter.revertAnnotationToAi).not.toHaveBeenCalled();
  });

  it('a direct Restore call on a destroyed handle warns without a host request', async () => {
    const current = await createModal();
    current.modal.destroy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await current.controller.revertAnnotationToAi(0, 'Q1-04');
    expect(warn).toHaveBeenCalledOnce();
    expect(adapter.revertAnnotationToAi).not.toHaveBeenCalled();
  });
});
