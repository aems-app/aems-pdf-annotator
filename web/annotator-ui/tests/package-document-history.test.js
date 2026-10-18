import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAnnotationPut } from './fixtures/annotation-put.fixture.js';

const bundle = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dist/annotator-ui.js'), 'utf8');
const opened = [];
afterEach(() => opened.splice(0).forEach((dom) => dom.window.close()));
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

async function hostHarness() {
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
    show() {
      this.el.dispatchEvent(new w.Event('show.bs.modal'));
      this.el.classList.add('show');
      this.el.dispatchEvent(new w.Event('shown.bs.modal'));
    }
    hide() {
      this.el.dispatchEvent(new w.Event('hide.bs.modal'));
      this.el.classList.remove('show');
      this.el.dispatchEvent(new w.Event('hidden.bs.modal'));
    }
    static getInstance(el) { return instances.get(el); }
  } };
  w.URL.createObjectURL = (blob) => `blob:submission-${blob.submissionId}`;
  w.URL.revokeObjectURL = () => {};
  // PDF rendering is the only package component replaced; keep the real shell,
  // state, document and annotation controllers, and the public factory/open path.
  w.eval(bundle);
  w.PdfPreviewModalViewer.resolvePdfjsLib = () => ({});
  w.PdfPreviewModalViewer.PDFViewer = class {
    onAnnotationsPageChange() {}
    onPageRendered() {}
    onResizeComplete() {}
    onSliderSync() {}
    beforeDocumentReplace() {}
    getViewportForPage() { return null; }
    async loadPDF(url) { this.displayedSubmissionId = Number(url.split('-').at(-1)); }
  };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const stored = new Map([1, 2].map((id) => [id, {
    stable_id: 'same-comment', xref: 42, page_index: 0, type: 'Text',
    content: `Submission ${id}`, color: 'amber', source: 'AI', rect: [50, 50, 150, 70],
  }]));
  const adapters = [];
  async function open(id, { ready = true } = {}) {
    w.PdfPreviewModalViewer.resolvePdfjsLib = () => ready ? {} : null;
    // Exactly the options shape used by AEMS createPdfPreviewModal. Each open
    // receives a fresh host adapter and creates a fresh package modal.
    const hostApi = {
      fetchAnnotatedPdf: vi.fn(async (_assignment, submission) => Object.assign(new w.Blob(['PDF']), { submissionId: submission })),
      getAnnotationsVersion: vi.fn(async () => ({ version: 'test-version' })),
      listAnnotations: vi.fn(async (_assignment, submission) => ({
        success: true, annotations: { 0: [{ ...stored.get(submission) }] },
      })),
      updateAnnotation: vi.fn(async (_assignment, submission, _annotation, body) => {
        stored.set(submission, applyAnnotationPut(stored.get(submission), body));
        return { success: true, annotation: { ...stored.get(submission) } };
      }),
    };
    adapters.push(hostApi);
    const modal = w.AEMSPdfAnnotator.createAnnotatorModal({
      context: { assignmentId: 10, submissionId: id, courseId: 20,
        studentName: `Student ${id}`, mode: 'server', annotatedPdfPolicy: 'server_allowed' },
      hostApi, capabilityOverrides: null, callbacks: {}, initialState: null, canvasUserName: null,
    });
    await modal.open();
    if (ready) {
      await vi.waitFor(() => expect(modal.getAnnotations()[0]?.[0]?.content).toBe(stored.get(id).content));
      expect(w.__pdfGradedViewer.displayedSubmissionId).toBe(id);
    }
    return modal;
  }
  async function edit(text) {
    const marker = w.document.createElement('div');
    marker.className = 'annotation-marker';
    Object.assign(marker.dataset, { annotationPage: '0', annotationRequestId: 'same-comment', annotationXref: '42' });
    const label = w.document.createElement('div');
    label.className = 'annotation-label label-expanded label-editing';
    marker.appendChild(label);
    w.document.getElementById('pdfGradedContainer').appendChild(marker);
    await w.PdfPreviewModal.__test.saveAndCollapseInlineLabel(label, text);
  }
  async function key(key) {
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
  }
  return { w, open, edit, key, adapters, stored };
}

describe('document history through the AEMS package entry', () => {
  it.each(['directly', 'after Escape'])('discards undo and redo when opening another modal %s', async (path) => {
    const h = await hostHarness();
    const first = await h.open(1);
    await h.edit('Edited submission 1');
    expect(h.adapters[0].updateAnnotation).toHaveBeenCalledTimes(1);
    expect(h.w.PdfPreviewModal.__test.getUndoStacks().local).toHaveLength(1);
    if (path === 'after Escape') {
      h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      first.close(); // Bootstrap's Escape handling completes the hide.
    }
    const second = await h.open(2);
    await h.key('z');
    await h.key('y');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([1, 0]);
    expect(second.getAnnotations()[0][0].content).toBe('Submission 2');
    expect(h.w.PdfPreviewModal.__test.getUndoStacks()).toEqual({ local: [], controller: [] });
  });

  it.each(['undo', 'redo'])('retires the previous %s history before waiting for PDF.js', async (history) => {
    const h = await hostHarness();
    await h.open(1);
    await h.edit('Edited submission 1');
    if (history === 'redo') await h.key('z');
    const before = h.adapters[0].updateAnnotation.mock.calls.length;
    const second = await h.open(2, { ready: false });
    await h.key('z');
    await h.key('y');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([before, 0]);
    expect(h.w.PdfPreviewModal.__test.getUndoStacks()).toEqual({ local: [], controller: [] });
    // Complete the same open once PDF.js arrives, then verify the new document.
    h.w.PdfPreviewModalViewer.resolvePdfjsLib = () => ({});
    h.w.dispatchEvent(new h.w.Event('pdfjsready'));
    await second.refresh();
    expect(second.getAnnotations()[0][0].content).toBe('Submission 2');
    await h.key('z');
    await h.key('y');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([before, 0]);
  });

  it('ignores an edit response from the previous modal while PDF.js is pending', async () => {
    const h = await hostHarness();
    await h.open(1);
    let finish;
    h.adapters[0].updateAnnotation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const edit = h.edit('Late submission 1');
    await h.open(2, { ready: false });
    finish({ success: true, annotation: { ...h.stored.get(1), content: 'Late submission 1', source: 'HUMAN' } });
    await edit;
    expect(h.w.PdfPreviewModal.__test.getUndoStacks()).toEqual({ local: [], controller: [] });
    await h.key('z');
    await h.key('y');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([1, 0]);
  });

  it('does not let a superseded PDF.js retry reopen the previous document', async () => {
    const h = await hostHarness();
    await h.open(1, { ready: false });
    const second = await h.open(2);
    h.w.dispatchEvent(new h.w.Event('pdfjsready'));
    await settle();
    expect(h.w.AEMSPdfAnnotator.getCurrentAnnotations().submissionId).toBe(2);
    await h.edit('Edited submission 2');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([0, 1]);
    expect(second.getAnnotations()[0][0].content).toBe('Edited submission 2');
  });

  it('a superseded modal handle cannot reopen or destroy the current document', async () => {
    const h = await hostHarness();
    const first = await h.open(1);
    await h.open(2);
    await expect(first.open()).rejects.toThrow('superseded');
    await expect(first.refresh()).rejects.toThrow('superseded');
    first.destroy();
    await h.edit('Edited submission 2');
    expect(h.adapters.map((adapter) => adapter.updateAnnotation.mock.calls.length)).toEqual([0, 1]);
  });
});
