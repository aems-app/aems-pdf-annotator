import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src', name), 'utf8');

describe('own markup editing with real pointer and click sequences', () => {
  let dom;
  let w;
  let d;
  let boxes;
  let selection;
  let wrapper;
  let adapter;
  let helpers;
  let tool;
  const annotation = {
    stable_id: 'own-text', page_index: 0, type: 'textbox',
    content: 'Check units', rect: [80, 100, 180, 128], color: 'amber',
  };

  beforeEach(() => {
    dom = new JSDOM(`<!doctype html><body>
      <div id="pdfPreviewModal"><button class="js-toggle-markup">Markup</button>
        <div id="pdfGradedCommentsList"></div>
        <div id="pdfGradedContainer"><div class="pdf-page-wrapper" data-page-num="1">
          <canvas width="600" height="800"></canvas><div class="pdf-annotation-overlay"></div>
        </div></div>
      </div>`, { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
    w = dom.window;
    d = w.document;
    // jsdom lacks the browser's contentEditable reflection and pointer capture.
    Object.defineProperty(w.HTMLElement.prototype, 'contentEditable', {
      get() { return this.getAttribute('contenteditable') || 'inherit'; },
      set(value) { this.setAttribute('contenteditable', value); },
      configurable: true,
    });
    Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', {
      get() { return this.getAttribute('contenteditable') === 'true'; }, configurable: true,
    });
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    const width = (el) => parseFloat(el.style.width) || (el.classList.contains('markup-textbox-measure') ? 100 : 600);
    const height = (el) => parseFloat(el.style.height) || (el.classList.contains('markup-textbox-measure') ? 28 : 800);
    for (const prop of ['offsetWidth', 'clientWidth']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return width(this); }, configurable: true });
    for (const prop of ['offsetHeight', 'clientHeight']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return height(this); }, configurable: true });
    for (const [prop, style] of [['offsetLeft', 'left'], ['offsetTop', 'top']]) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return parseFloat(this.style[style]) || 0; }, configurable: true });
    w.HTMLElement.prototype.getBoundingClientRect = function () {
      const left = parseFloat(this.style.left) || 0;
      const top = parseFloat(this.style.top) || 0;
      return { left, top, width: width(this), height: height(this), right: left + width(this), bottom: top + height(this) };
    };
    w.PdfPreviewModalViewer = { resolvePdfjsLib: () => null };
    tool = 'select';
    // Raster drawing is unrelated; keep actual textbox, selection, modal and CRUD paths.
    w.PdfPreviewModalDrawingCanvas = {
      getActiveTool: () => tool, getActiveColor: () => ({ rgb: [0, 0, 0] }),
      setMarkupMode() {}, loadStrokesFromAnnotations() {}, ensureCanvasForPage() {}, redrawPage() {},
      hitTestStroke: () => null, isDrawingActive: () => false,
    };
    for (const name of ['utils', 'annotation-helpers', 'rendering', 'modal-state', 'annotation-controller', 'textbox', 'markup-selection']) {
      w.eval(source(`pdf-preview-modal/${name}.js`));
    }
    w.eval(source('pdf-preview-modal.js'));
    const factory = w.PdfPreviewModalAnnotationController.createAnnotationController;
    w.PdfPreviewModalAnnotationController.createAnnotationController = (options) => {
      options.setAnnotationsData({ 0: [{ ...annotation }] });
      return factory(options);
    };
    adapter = {
      updateAnnotation: vi.fn(async (_assignment, _submission, _id, body) => ({ success: true, annotation: { ...annotation, ...body } })),
      createAnnotation: vi.fn(async () => ({ success: true })),
      deleteAnnotation: vi.fn(async () => ({ success: true })),
    };
    w.PdfPreviewModal.createPdfPreviewModal({ assignmentId: 'a', submissionId: 's', modeAdapter: adapter });
    const viewport = {
      width: 600, height: 800, scale: 1,
      convertToPdfPoint: (x, y) => [x, y], convertToViewportPoint: (x, y) => [x, y],
      convertToViewportRectangle: (rect) => rect,
    };
    w.__pdfGradedViewer = { getViewportForPage: () => viewport };
    boxes = w.PdfPreviewModalTextbox;
    selection = w.PdfPreviewModalMarkupSelection;
    helpers = w.PdfPreviewModal.__test;
    wrapper = d.querySelector('.pdf-page-wrapper');
    helpers.refreshMarkupFromAnnotations();
    d.querySelector('.js-toggle-markup').click();
    expect(boxes.getPageTextboxes(0)).toHaveLength(1);
  });

  afterEach(() => { dom?.window.close(); });

  function pointer(target, type, x = 90, y = 110) {
    const event = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  }

  function click(target, x = 90, y = 110, detail = 1) {
    pointer(target, 'pointerdown', x, y);
    pointer(target, 'pointerup', x, y);
    target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, detail }));
  }

  const settle = () => new Promise((resolve) => w.setTimeout(resolve, 80));

  it('a stationary second click edits the selected box without a move save or lost focus', async () => {
    const entry = boxes.getPageTextboxes(0)[0];
    click(entry.element);
    const overlay = d.querySelector('.markup-selection-overlay');
    expect(overlay).not.toBeNull();
    click(overlay);
    entry.contentElement.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    expect.soft(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect.soft(d.activeElement).toBe(entry.contentElement);
    const range = d.createRange();
    range.setStart(entry.contentElement.firstChild, 3);
    range.collapse(true);
    w.getSelection().removeAllRanges();
    w.getSelection().addRange(range);
    await settle();
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(boxes.getPageTextboxes(0)[0].element === entry.element, 'the active textbox must survive refresh').toBe(true);
    expect(d.activeElement).toBe(entry.contentElement);
    expect(w.getSelection().anchorOffset).toBe(3);
  });

  it.each([0, 1, 3])('pointer jitter of %i pixels neither moves nor saves the box', async (distance) => {
    const entry = boxes.getPageTextboxes(0)[0];
    selection.select('textbox', entry, 0, wrapper);
    const overlay = d.querySelector('.markup-selection-overlay');
    const initial = entry.element.style.left;
    pointer(overlay, 'pointerdown');
    for (let dx = 1; dx <= distance; dx++) pointer(overlay, 'pointermove', 90 + dx);
    pointer(overlay, 'pointerup', 90 + distance);
    await settle();
    expect(adapter.updateAnnotation).not.toHaveBeenCalled();
    expect(entry.element.style.left).toBe(initial);
  });

  it('a drag crossing the threshold with incremental movement saves its full displacement once', async () => {
    const entry = boxes.getPageTextboxes(0)[0];
    selection.select('textbox', entry, 0, wrapper);
    const overlay = d.querySelector('.markup-selection-overlay');
    pointer(overlay, 'pointerdown');
    for (let dx = 1; dx <= 8; dx++) pointer(overlay, 'pointermove', 90 + dx);
    pointer(overlay, 'pointerup', 98);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    expect(adapter.updateAnnotation.mock.calls[0][3].rect[0]).toBe(88);
  });

  it('clicking the selected box after a saved drag edits its live replacement', async () => {
    const entry = boxes.getPageTextboxes(0)[0];
    selection.select('textbox', entry, 0, wrapper);
    let overlay = d.querySelector('.markup-selection-overlay');
    pointer(overlay, 'pointerdown');
    pointer(overlay, 'pointermove', 110);
    pointer(overlay, 'pointerup', 110);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
    const liveEntry = boxes.getPageTextboxes(0)[0];
    expect(liveEntry.element.isConnected).toBe(true);
    overlay = d.querySelector('.markup-selection-overlay');
    click(overlay, 110);
    await settle();
    expect(d.activeElement === liveEntry.contentElement, 'click after drag must focus the connected textbox').toBe(true);
    expect(liveEntry.element.classList.contains('editing')).toBe(true);
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(1);
  });

  it('an annotation refresh preserves the edited textbox, focus, draft and caret', () => {
    const entry = boxes.getPageTextboxes(0)[0];
    boxes.editTextbox(entry);
    entry.contentElement.textContent = 'Draft text';
    entry.contentElement.dispatchEvent(new w.InputEvent('input', { bubbles: true }));
    const range = d.createRange();
    range.setStart(entry.contentElement.firstChild, 2);
    range.setEnd(entry.contentElement.firstChild, 5);
    w.getSelection().removeAllRanges();
    w.getSelection().addRange(range);
    helpers.refreshMarkupFromAnnotations();
    expect(boxes.getPageTextboxes(0)[0].element === entry.element, 'refresh must preserve the editing DOM node').toBe(true);
    expect(d.activeElement).toBe(entry.contentElement);
    expect(entry.contentElement.textContent).toBe('Draft text');
    expect([w.getSelection().anchorOffset, w.getSelection().focusOffset]).toEqual([2, 5]);
    expect(d.querySelectorAll('.textbox-layer .markup-textbox')).toHaveLength(1);
  });

  it('Text tool click on an existing box edits it instead of creating an overlapping box', async () => {
    tool = 'text';
    const entry = boxes.getPageTextboxes(0)[0];
    click(entry.element);
    await settle();
    expect(boxes.getPageTextboxes(0).length, 'Text tool must not add another box over an existing one').toBe(1);
    expect(d.activeElement).toBe(entry.contentElement);
    expect(entry.element.classList.contains('editing')).toBe(true);
    expect(adapter.createAnnotation).not.toHaveBeenCalled();
  });

  it.each(['select', 'text'])('clicking inside a %s-tool editor preserves its caret and does not create markup', (activeTool) => {
    tool = activeTool;
    const entry = boxes.getPageTextboxes(0)[0];
    selection.select('textbox', entry, 0, wrapper);
    boxes.editTextbox(entry);
    const range = d.createRange();
    range.setStart(entry.contentElement.firstChild, 2);
    range.collapse(true);
    w.getSelection().removeAllRanges();
    w.getSelection().addRange(range);
    click(entry.contentElement);
    expect(boxes.getPageTextboxes(0).length, 'click inside editor must not create another box').toBe(1);
    expect(d.activeElement).toBe(entry.contentElement);
    expect(w.getSelection().anchorOffset).toBe(2);
  });

  it('Text tool still creates a focused box when clicking an empty page area', () => {
    tool = 'text';
    click(wrapper.querySelector('canvas'), 300, 350);
    expect(boxes.getPageTextboxes(0).length).toBe(2);
    const created = boxes.getPageTextboxes(0)[1];
    expect(d.activeElement).toBe(created.contentElement);
    expect(created.element.classList.contains('editing')).toBe(true);
    expect(created.annotationId).toBeNull();
  });

  it('refresh removes obsolete nonediting boxes while retaining the active editor', () => {
    boxes.loadTextboxesFromAnnotations([
      { ...annotation, pageIdx: 0, annotationId: 'own-text', x: 80, y: 100 },
      { ...annotation, pageIdx: 0, annotationId: 'obsolete', x: 200, y: 200 },
    ], [wrapper]);
    const [editing, obsolete] = boxes.getPageTextboxes(0);
    boxes.editTextbox(editing);
    helpers.refreshMarkupFromAnnotations();
    expect(boxes.getPageTextboxes(0).length).toBe(1);
    expect(boxes.getPageTextboxes(0)[0].element === editing.element, 'refresh preserves active editor while repainting other boxes').toBe(true);
    expect(obsolete.element.isConnected).toBe(false);
    expect(d.activeElement).toBe(editing.contentElement);
  });

  it('destroy still removes editing boxes and their page entries', () => {
    const entry = boxes.getPageTextboxes(0)[0];
    boxes.editTextbox(entry);
    boxes.destroy();
    expect(boxes.getPageTextboxes(0).length).toBe(0);
    expect(entry.element.isConnected).toBe(false);
    expect(d.activeElement === entry.contentElement).toBe(false);
  });

  it('a comment editor raises its parent marker above later markers and restores it on collapse', () => {
    const overlay = d.querySelector('.pdf-annotation-overlay');
    overlay.innerHTML = '<div class="annotation-marker" style="z-index:10"><div class="annotation-label"></div></div><div class="annotation-marker" style="z-index:10"></div>';
    const label = overlay.querySelector('.annotation-label');
    const marker = label.parentElement;
    const laterMarker = marker.nextElementSibling;
    helpers.setupLabelTooltipEvents(label, 'Existing feedback');
    label.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
    label.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 2 }));
    label.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    const editor = label.querySelector('textarea.inline-annotation-editor');
    expect(d.activeElement).toBe(editor);
    expect(Number(marker.style.zIndex)).toBeGreaterThan(Number(laterMarker.style.zIndex));
    click(editor);
    expect(d.activeElement).toBe(editor);
    helpers.collapseInlineLabel(label);
    expect(marker.style.zIndex).toBe('10');
  });
});
