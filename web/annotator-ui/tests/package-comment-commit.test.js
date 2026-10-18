import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Use exactly the package's source order, without writing a generated dist bundle.
const orderedSources = readFileSync(join(root, 'rollup.config.js'), 'utf8')
  .match(/const orderedSources = \[([\s\S]*?)\];/)[1]
  .match(/'[^']+'/g).map((quoted) => quoted.slice(1, -1));
const source = orderedSources.map((file) => readFileSync(join(root, 'src', file), 'utf8')).join('\n\n');
const opened = [];
afterEach(() => opened.splice(0).forEach((dom) => dom.window.close()));
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPackage() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="pdfPreviewModal"><div id="pdfPreviewStudent"></div>
    <div id="pdfOriginalPane"></div><div id="pdfGradedPane"></div>
    <button id="pdfOriginalTab"></button><button id="pdfGradedTab"></button>
    <div id="pdfGradedCommentsList"></div><div id="pdfGradedAICommentsList"></div>
    <div id="pdfOriginalContainer"></div><div id="pdfGradedContainer"></div></div>
  </body>`, { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  opened.push(dom);
  const w = dom.window;
  const instances = new WeakMap();
  w.bootstrap = { Modal: class {
    constructor(el) { this.el = el; instances.set(el, this); }
    show() { this.el.classList.add('show'); this.el.dispatchEvent(new w.Event('shown.bs.modal')); }
    hide() { this.el.classList.remove('show'); this.el.dispatchEvent(new w.Event('hidden.bs.modal')); }
    static getInstance(el) { return instances.get(el); }
  } };
  w.URL.createObjectURL = () => 'blob:test-pdf';
  w.URL.revokeObjectURL = () => {};
  w.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`) };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, save() {}, restore() {}, setTransform() {} });
  w.eval(source);
  const viewport = {
    width: 612, height: 792, scale: 1, viewBox: [0, 0, 612, 792],
    convertToPdfPoint: (x, y) => [x, 792 - y],
    convertToViewportPoint: (x, y) => [x, 792 - y],
    convertToViewportRectangle: ([x0, y0, x1, y1]) => [x0, 792 - y0, x1, 792 - y1],
  };
  // Only PDF decoding/rendering and the host transport are replaced. All modal,
  // overlay, editor, CRUD, and keyboard/history controllers are the real package.
  w.PdfPreviewModalViewer.resolvePdfjsLib = () => ({});
  w.PdfPreviewModalViewer.PDFViewer = class {
    constructor() {
      this.pdf = { numPages: 1, getPage: async () => ({ view: viewport.viewBox }) };
      this.currentPage = 1;
      this.isGradedViewer = true;
      this.renderedPages = new Set([1]);
    }
    onAnnotationsPageChange() {}
    onPageRendered(fn) { this.pageRendered = fn; }
    onResizeComplete() {}
    onSliderSync() {}
    beforeDocumentReplace() {}
    getViewportForPage() { return viewport; }
    async loadPDF() {
      const container = w.document.getElementById('pdfGradedContainer');
      container.innerHTML = `<div class="pdf-page-wrapper" data-page-num="1">
        <canvas class="pdf-page-canvas"></canvas><div class="pdf-annotation-overlay"></div></div>`;
      const bounds = () => ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792 });
      container.getBoundingClientRect = bounds;
      container.querySelector('canvas').getBoundingClientRect = bounds;
      container.querySelector('.pdf-annotation-overlay').getBoundingClientRect = bounds;
      this.pageRendered?.(1);
    }
  };
  const stored = new Map();
  const writes = [];
  let finishCreate;
  let nextId = 0;
  const hostApi = {
    supportsAnnotationCrud: () => true,
    fetchAnnotatedPdf: vi.fn(async () => new w.Blob(['PDF'])),
    getAnnotationsVersion: vi.fn(async () => ({ version: 'test' })),
    listAnnotations: vi.fn(async () => ({ success: true, annotations: { 0: [...stored.values()] } })),
    createAnnotation: vi.fn(async (_a, _s, body) => {
      writes.push(['POST', body]);
      if (nextId === 0) await new Promise((resolve) => { finishCreate = resolve; });
      const id = `created-${++nextId}`;
      const annotation = { ...body, type: 'Text', stable_id: id, id, xref: nextId + 40, source: 'HUMAN' };
      // The server persists PDF coordinates and lists top-left coordinates.
      annotation.rect = [body.rect[0], 792 - body.rect[3], body.rect[2], 792 - body.rect[1]];
      stored.set(id, annotation);
      return { success: true, annotation: { ...annotation } };
    }),
    updateAnnotation: vi.fn(async (_a, _s, id, body) => {
      writes.push(['PUT', id, body]);
      const current = stored.get(id);
      if (!current) throw Object.assign(new Error('Annotation not found'), { status: 404 });
      const annotation = { ...current, ...body };
      stored.set(id, annotation);
      return { success: true, annotation: { ...annotation } };
    }),
    deleteAnnotation: vi.fn(async (_a, _s, id) => {
      writes.push(['DELETE', id]);
      await settle(20);
      stored.delete(id);
      return { success: true };
    }),
  };
  const modal = w.AEMSPdfAnnotator.createAnnotatorModal({
    context: { assignmentId: 10, submissionId: 1, mode: 'local', annotatedPdfPolicy: 'local_required' },
    hostApi,
  });
  await modal.open();
  await vi.waitFor(() => expect(w.document.querySelector('.pdf-annotation-overlay')?._dblclickHandler).toBeTypeOf('function'));
  await vi.waitFor(() => expect(hostApi.listAnnotations).toHaveBeenCalled());
  await settle(100);
  const overlay = w.document.querySelector('.pdf-annotation-overlay');
  overlay.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
  await vi.waitFor(() => expect(w.document.querySelector('.inline-annotation-editor')).not.toBeNull());
  const originalEditor = w.document.querySelector('.inline-annotation-editor');
  // Ensure the optimistic editor was opened before the POST response, as on a
  // live server. The response replaces its textarea and rebinds its identity.
  finishCreate();
  await vi.waitFor(() => expect(w.document.querySelector('.annotation-marker')?.dataset.annotationRequestId).toBe('created-1'));
  await settle(130);
  const editor = w.document.querySelector('.inline-annotation-editor');
  expect(editor).not.toBe(originalEditor);
  async function key(key, { ctrlKey = true, shiftKey = false, target = w.document } = {}) {
    target.dispatchEvent(new w.KeyboardEvent('keydown', { key, ctrlKey, shiftKey, bubbles: true, cancelable: true }));
    await settle(150);
  }
  function fill(text) {
    editor.focus();
    editor.value = text;
    editor.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  return { w, modal, hostApi, stored, writes, editor, originalEditor, key, fill };
}

describe('page double-click and first comment commit through the package entry', () => {
  it.each(['Enter', 'Escape'])('keeps the current draft on %s when POST replaced the optimistic editor', async (key) => {
    const h = await openPackage();
    h.fill('Keep this comment');
    await h.key(key, { ctrlKey: key === 'Enter', target: h.editor });
    expect(h.writes.map(([method]) => method)).toEqual(['POST', 'PUT']);
    expect(h.stored.get('created-1')?.content).toBe('Keep this comment');
  });

  it('discards an empty new comment only once after POST replaced its editor', async () => {
    const h = await openPackage();
    await h.key('Enter', { target: h.editor });
    expect(h.writes.map(([method]) => method)).toEqual(['POST', 'DELETE']);
    expect(h.stored.size).toBe(0);
    expect(h.w.PdfPreviewModal.__test.getUndoStacks()).toEqual({ local: [], controller: [] });
  });

  it('records creation then edit, and undoes/redoes both with the recreated identity', async () => {
    const h = await openPackage();
    expect(h.w.PdfPreviewModal.__test.getUndoStacks().controller.map((op) => op.type)).toEqual(['create-comment']);
    h.fill('First committed text');
    await h.key('Enter', { target: h.editor });
    expect(h.w.PdfPreviewModal.__test.getUndoStacks().local.map((op) => op.type)).toEqual(['create-comment', 'edit']);
    await h.key('z'); // Undo first edit, restoring the POST's content.
    expect(h.writes.at(-1)).toEqual(['PUT', 'created-1', { content: 'New comment...' }]);
    await h.key('z'); // Undo creation.
    expect(h.writes.at(-1)).toEqual(['DELETE', 'created-1']);
    expect(h.stored.size).toBe(0);
    await h.key('y'); // Recreate under a new server id.
    expect(h.writes.at(-1)[0]).toBe('POST');
    expect(h.stored.has('created-2')).toBe(true);
    await h.key('Z', { shiftKey: true }); // Redo first edit against that new id.
    expect(h.writes.at(-1)).toEqual(['PUT', 'created-2', { content: 'First committed text' }]);
    await h.key('z');
    await h.key('z');
    expect(h.writes.at(-1)).toEqual(['DELETE', 'created-2']);
  });
});
