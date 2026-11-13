import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = (name) => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../src', name);
  return `${readFileSync(path, 'utf8')}\n//# sourceURL=${pathToFileURL(path).href}`;
};

describe('Luca F1 scoped native identity through actual textbox callbacks', () => {
  let dom;
  let w;
  let d;
  let boxes;
  let selection;
  let wrapper;
  let adapter;
  let helpers;
  let tool;
  let controller;
  let annotations;
  let modal;
  const annotation = {
    stable_id: 'native-duplicate', has_explicit_stable_id: false, xref: 12, page_index: 0, type: 'textbox',
    etag: 'fixture-own-text',
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
    w.bootstrap = { Modal: { getInstance: () => null } };
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
      annotations = options.getAnnotationsData;
      options.setAnnotationsData({ 0: [{ ...annotation }], 1: [{ ...annotation, xref: 42, page_index: 1, content: 'Second page synthetic text' }] });
      controller = factory(options);
      return controller;
    };
    adapter = {
      updateAnnotation: vi.fn(async (_assignment, _submission, _id, body) => ({ success: true, annotation: { ...annotation, ...body, xref: 84 } })),
      createAnnotation: vi.fn(async (_a,_s,body) => ({ success: true, annotation: { ...annotation, ...body, xref: 91 } })),
      deleteAnnotation: vi.fn(async () => ({ success: true })),
    };
    modal = w.PdfPreviewModal.createPdfPreviewModal({ assignmentId: 'a', submissionId: 's', modeAdapter: adapter });
    const viewport = {
      width: 600, height: 800, scale: 1,
      convertToPdfPoint: (x, y) => [x, y], convertToViewportPoint: (x, y) => [x, y],
      convertToViewportRectangle: (rect) => rect,
    };
    w.__pdfGradedViewer = { getViewportForPage: () => viewport };
    const firstWrapper = d.querySelector('.pdf-page-wrapper');
    const secondWrapper = firstWrapper.cloneNode(true);
    secondWrapper.dataset.pageNum = '2';
    firstWrapper.parentElement.append(secondWrapper);
    boxes = w.PdfPreviewModalTextbox;
    selection = w.PdfPreviewModalMarkupSelection;
    helpers = w.PdfPreviewModal.__test;
    wrapper = d.querySelector('.pdf-page-wrapper');
    helpers.refreshMarkupFromAnnotations();
    d.querySelector('.js-toggle-markup').click();
    expect(boxes.getPageTextboxes(0)).toHaveLength(1);
  });

  afterEach(() => { dom?.window.close(); });


  const settle = () => new Promise(resolve => w.setTimeout(resolve, 80));

  it('loader preserves different wire identities for matching native IDs on different pages', () => {
    expect(boxes.getPageTextboxes(0)[0].annotationId).toBe('xref:12|id:native-duplicate');
    expect(boxes.getPageTextboxes(1)[0].annotationId).toBe('xref:42|id:native-duplicate');
  });

  it('saving the second same-page native duplicate preserves the first annotation', async () => {
    delete annotations()[1];
    annotations()[0].push({ ...annotation, xref: 42, content: 'Second same-page text' });
    helpers.refreshMarkupFromAnnotations();
    const target = boxes.getPageTextboxes(0).find(entry => entry.annotationId === 'xref:42|id:native-duplicate');
    expect(target).toBeDefined();
    target.content = 'Only second native annotation edited';
    boxes.onTextboxCommitted(target);
    await settle();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(entry => entry.xref === 12)).toMatchObject({ content: 'Check units' });
    expect(annotations()[0].find(entry => entry.xref === 84)).toMatchObject({ content: target.content });
  });

  it.each([
    ['id:foo', 'foo', 99],
    ['xref:123', 'unrelated-explicit', 123],
  ])('actual callback retains literal native ID %s and preserves the unrelated explicit annotation', async (nativeId, otherId, otherXref) => {
    const native = { ...annotation, stable_id: nativeId, content: 'Native prefix target' };
    const other = { ...annotation, stable_id: otherId, xref: otherXref,
      has_explicit_stable_id: true, content: 'Unrelated explicit text' };
    delete annotations()[1];
    annotations()[0] = [other, native];
    adapter.updateAnnotation.mockImplementation(async (_a, _s, _wire, body) => ({
      success: true, annotation: { ...native, ...body, xref: 84 },
    }));
    helpers.refreshMarkupFromAnnotations();
    const entry = boxes.getPageTextboxes(0).find(item => item.content === 'Native prefix target');
    expect(entry).toBeDefined();
    expect(native.stable_id).toBe(nativeId);
    entry.content = 'Only native prefix target edited';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe(`xref:12|id:${nativeId}`);
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(item => item.xref === otherXref)).toMatchObject({
      stable_id: otherId, content: 'Unrelated explicit text', has_explicit_stable_id: true,
    });
    expect(annotations()[0].find(item => item.xref === 84)).toMatchObject({
      stable_id: nativeId, content: entry.content,
    });
  });

  it('real modal highlight extend and undo preserve native id:foo beside explicit foo', async () => {
    const native = { ...annotation, stable_id: 'id:foo', type: 'Highlight', source: 'AI',
      content: 'Native highlight', quads: [[10,20,50,30]], rect: [10,20,50,30], anchor_text: 'initial phrase' };
    const other = { ...native, stable_id: 'foo', xref: 99, has_explicit_stable_id: true,
      content: 'Unrelated explicit highlight' };
    delete annotations()[1];
    annotations()[0] = [other, native];
    let nextXref = 84;
    adapter.updateAnnotation.mockImplementation(async (_a, _s, wire, body) => {
      const expectedXref = nextXref === 84 ? 12 : nextXref - 1;
      if (wire !== `xref:${expectedXref}|id:id:foo`) throw new Error('Unexpected native highlight target');
      return { success: true, annotation: { ...native, ...body, xref: nextXref++ } };
    });
    const marker = d.createElement('div');
    marker.className = 'annotation-marker source-ai';
    marker.dataset.annotationPage = '0'; marker.dataset.annotationXref = '12';
    marker.dataset.annotationRequestId = 'xref:12|id:id:foo';
    d.body.append(marker);
    await controller.persistHighlightExtend(marker, native, { pageIdx: 0,
      quadsPdf: [[10,20,90,30]], anchorText: 'extended phrase' });
    expect.soft(annotations()[0]).toHaveLength(2);
    expect.soft(annotations()[0].find(item => item.xref === 99)).toMatchObject(other);
    await controller.performHighlightExtendUndo(controller.popUndoOperation());
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation.mock.calls[1][2]).toBe('xref:84|id:id:foo');
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(item => item.xref === 99)).toMatchObject(other);
  });

  it.each(['helper', 'fallback'])('actual %s save targets the second native annotation, with xref retained', async mode => {
    if (mode === 'fallback') delete w.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier;
    const entry = boxes.getPageTextboxes(1)[0];
    entry.content = 'Second annotation edited';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalled();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(adapter.updateAnnotation.mock.calls[0][3].page_index).toBe(1);
  });

  it.each(['helper', 'fallback'])('actual %s callback preserves a composite carried by entry.id alone', async mode => {
    if (mode === 'fallback') delete w.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier;
    annotations()[1][0] = { ...annotation, stable_id: null, id: 'xref:42|id:native-duplicate',
      xref: null, page_index: 1 };
    helpers.refreshMarkupFromAnnotations();
    const entry = boxes.getPageTextboxes(1)[0];
    expect(entry.annotationId).toBe('xref:42|id:native-duplicate');
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
  });

  it('returned recreated xref becomes the entry identity and its next delete target', async () => {
    const entry = boxes.getPageTextboxes(1)[0];
    entry.content = 'Updated synthetic content';
    boxes.onTextboxCommitted(entry);
    await settle();
    boxes.onTextboxDeleted(entry);
    await settle();
    expect(adapter.deleteAnnotation.mock.calls[0][2]).toBe('xref:84|id:native-duplicate');
    expect(entry.annotationId).toBe('xref:84|id:native-duplicate');
  });

  it('new textbox creation carries returned xref into its entry and undo operation', async () => {
    const entry = boxes.getPageTextboxes(0)[0];
    entry.annotationId = null;
    entry.content = 'New synthetic textbox';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.createAnnotation).toHaveBeenCalled();
    expect(entry.annotationId).toBe('xref:91|id:native-duplicate');
    expect(helpers.getUndoStacks().local.at(-1).annotationId).toBe('xref:91|id:native-duplicate');
  });

  it('a page move retains source scoped identity in the actual write request', async () => {
    const entry = boxes.getPageTextboxes(1)[0];
    boxes.moveTextboxToPage(entry, 0, d.querySelector('.pdf-page-wrapper'), 33, 44);
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(adapter.updateAnnotation.mock.calls[0][3].page_index).toBe(0);
  });
});
