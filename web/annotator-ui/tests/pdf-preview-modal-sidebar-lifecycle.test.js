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

  async function reopen(cycles = 2) {
    for (let i = 0; i < cycles; i++) {
      const previous = await createModal();
      previous.modal.destroy();
    }
    const current = await createModal();
    expect(document.getElementById('pdfGradedCommentsList')).toBe(list);
    return current;
  }

  it.each([0, 1, 2])('Restore reaches the current controller and host exactly once after %i reopen cycles', async (cycles) => {
    const current = await reopen(cycles);
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

  it.each(actions.flatMap((action) => [0, 2].map((cycles) => [...action, cycles])))('%s dispatches only to the current controller (%s, %s, %s, %i reopens)', async (name, selector, type, method, cycles) => {
    const current = await reopen(cycles);
    if (name === 'save text') {
      current.controller.beginEdit(0, 'Q1-04', list.querySelector('.list-group-item').dataset.annotationId);
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

  it.each(['save text', 'delete', 'priority', 'verdict/level'].flatMap((name) => [0, 2].map((cycles) => [name, cycles])))('%s calls the host once after %i reopens', async (name, cycles) => {
    const current = await reopen(cycles);
    let expectedBody;
    if (name === 'save text') {
      list.querySelector('.edit-annotation').click();
      expect(current.modal._state.annotations.editingId).toBeTruthy();
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

  it('Cancel and textarea synchronization still work after reopening', async () => {
    const current = await reopen();
    current.controller.beginEdit(0, 'Q1-04', list.querySelector('.list-group-item').dataset.annotationId);
    const inlineLabel = document.createElement('div');
    inlineLabel.className = 'annotation-label label-editing';
    inlineLabel.innerHTML = '<textarea class="inline-annotation-editor"></textarea>';
    document.body.appendChild(inlineLabel);
    const textarea = list.querySelector('textarea');
    textarea.value = 'Edited teacher feedback';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inlineLabel.querySelector('textarea').value).toBe('Edited teacher feedback');
    list.querySelector('.cancel-edit-btn').click();
    await Promise.resolve();
    expect(current.modal._state.annotations.editingId).toBeNull();
    expect(list.querySelector('.edit-annotation')).not.toBeNull();
  });

  it('destroy removes only its own listeners and clears the persistent binding flag', async () => {
    const addListener = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const removeListener = vi.spyOn(EventTarget.prototype, 'removeEventListener');
    const current = await createModal();
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

  it.each(['click', 'mousedown', 'keydown', 'dblclick'])('an already queued %s listener warns and lets the event propagate after destroy', async (type) => {
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
