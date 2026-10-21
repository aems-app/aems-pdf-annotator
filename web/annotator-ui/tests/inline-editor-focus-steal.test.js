import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('inline editor focus with a focusable sidebar item', () => {
  let handle;
  let helpers;
  let label;
  let marker;
  let adapter;
  let markerDblClick;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key === 'AEMSPdfAnnotator') delete window[key];
    }
    delete window.__pdfOriginalViewer;
    delete window.__pdfGradedViewer;
    document.body.innerHTML = `
      <div id="pdfGradedCommentsList"></div>
      <div id="pdfGradedContainer">
        <div class="pdf-annotation-overlay">
          <div class="annotation-marker" data-page-idx="0" data-identifier="feedback-1"
               data-annotation-page="0" data-annotation-request-id="feedback-1">
            <div class="annotation-label"></div>
          </div>
        </div>
      </div>`;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });
    class FakeViewer {
      onAnnotationsPageChange() {}
      onPageRendered() {}
      onSliderSync() {}
      onResizeComplete() {}
    }
    window.PdfPreviewModalViewer = {
      PDFViewer: FakeViewer,
      resolvePdfjsLib: () => ({}),
    };
    window.PdfPreviewModalOverlayRenderer = {
      createOverlayRenderer: () => ({
        onMarkerClicked() {},
        onMarkerDblClicked(callback) { markerDblClick = callback; },
        onOverlayDblClicked() {},
        onOverlayReady() {},
        destroy() {},
      }),
    };
    await import('../src/pdf-preview-modal/utils.js');
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/sidebar-panel.js');
    await import('../src/pdf-preview-modal/modal-state.js');
    await import('../src/pdf-preview-modal/annotation-controller.js');
    const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
    window.PdfPreviewModalAnnotationController.createAnnotationController = (options) => {
      options.setAnnotationsData({ 0: [{
        id: 'feedback-1', stable_id: 'feedback-1', page_index: 0,
        type: 'Text', content: 'Existing feedback', color: 'amber', source: 'AI',
        rect: [50, 50, 150, 70],
      }] });
      const controller = factory(options);
      controller.renderList();
      return controller;
    };
    adapter = {
      updateAnnotation: vi.fn().mockResolvedValue({ success: true }),
      createAnnotation: vi.fn().mockResolvedValue({ success: true }),
      deleteAnnotation: vi.fn().mockResolvedValue({ success: true }),
    };
    // jsdom has no layout; give the real sidebar renderer a visible marker.
    document.getElementById('pdfGradedContainer').getBoundingClientRect = () => (
      { left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792 }
    );
    document.querySelector('.annotation-marker').getBoundingClientRect = () => (
      { left: 50, top: 50, right: 150, bottom: 70, width: 100, height: 20 }
    );
    await import('../src/pdf-preview-modal.js');
    handle = window.PdfPreviewModal.createPdfPreviewModal({
      assignmentId: 'assignment-1', submissionId: 'submission-1', modeAdapter: adapter,
    });
    helpers = window.PdfPreviewModal.__test;
    label = document.querySelector('.annotation-label');
    marker = label.closest('.annotation-marker');
    helpers.setupLabelTooltipEvents(label, 'Existing feedback');
  });

  afterEach(() => {
    helpers?.collapseInlineLabel(label);
    handle?.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function dispatchLabelEvent(type, detail) {
    label.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail }));
  }

  function realDoubleClick() {
    // Browser order: the second click opens the expanded label before dblclick.
    dispatchLabelEvent('click', 1);
    dispatchLabelEvent('click', 2);
    dispatchLabelEvent('dblclick', 2);
  }

  function sidebarItem() {
    const item = document.querySelector('#pdfGradedCommentsList .list-group-item');
    expect(item).not.toBeNull();
    expect(item.tabIndex).toBeGreaterThanOrEqual(0);
    return item;
  }

  async function expectEditorRetained() {
    const textarea = label.querySelector('textarea.inline-annotation-editor');
    expect(textarea).not.toBeNull();
    expect.soft(document.activeElement).toBe(textarea);
    const blur = vi.fn();
    textarea.addEventListener('blur', blur);
    await vi.advanceTimersByTimeAsync(160);

    expect(label.querySelector('textarea.inline-annotation-editor')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(label.classList.contains('label-editing')).toBe(true);
    expect(label.dataset.fullText).toBe('Existing feedback');
    expect(blur).not.toHaveBeenCalled();
    for (const request of Object.values(adapter)) expect(request).not.toHaveBeenCalled();
    expect(sidebarItem().classList.contains('item-focused')).toBe(true);
    expect(marker.classList.contains('annotation-marker-selected')).toBe(true);
  }

  it('retains the inline editor through click, click, dblclick and the blur deadline', async () => {
    realDoubleClick();
    await expectEditorRetained();
  });

  it('retains focus when dblclick enters editing directly from collapsed', async () => {
    expect(label.classList.contains('label-expanded')).toBe(false);
    dispatchLabelEvent('dblclick', 2);
    await expectEditorRetained();
  });

  it('retains focus when clicking a label already expanded read-only', async () => {
    dispatchLabelEvent('click', 1);
    expect(document.activeElement).toBe(sidebarItem());
    dispatchLabelEvent('click', 1);
    await expectEditorRetained();
  });

  it('keeps single-click read-only expansion and sidebar focus', async () => {
    dispatchLabelEvent('click', 1);
    expect(label.classList.contains('label-expanded')).toBe(true);
    expect(label.querySelector('.inline-annotation-text')).not.toBeNull();
    expect(label.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(sidebarItem());
    await vi.advanceTimersByTimeAsync(160);
    expect(document.activeElement).toBe(sidebarItem());
    expect(label.classList.contains('label-editing')).toBe(false);
  });

  it('keeps immediately typed text in order across the former caret deadline', async () => {
    helpers.setupLabelTooltipEvents(label, 'New comment...');
    realDoubleClick();
    const textarea = label.querySelector('textarea.inline-annotation-editor');
    expect(document.activeElement).toBe(textarea);
    // jsdom needs explicit text insertion. Do not refocus: that would mask the defect.
    function typeText(text) {
      expect(document.activeElement).toBe(textarea);
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: text,
      }));
    }
    typeText('C');
    await vi.advanceTimersByTimeAsync(50);
    typeText('aret probe text.');
    await vi.advanceTimersByTimeAsync(110);

    expect(textarea.value).toBe('Caret probe text.');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([17, 17]);
    expect(document.activeElement).toBe(textarea);
    expect(label.querySelector('textarea.inline-annotation-editor')).toBe(textarea);
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
  });

  it('retains inline focus through the overlay marker double-click controller path', async () => {
    markerDblClick({ pageIdx: 0, identifier: 'feedback-1', label });
    await expectEditorRetained();
  });
});
