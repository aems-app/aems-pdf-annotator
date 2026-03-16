import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUNDLE_PATH = '../dist/annotator-ui.js';

describe('annotator-ui bundle export surface', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.AEMSPdfAnnotator;
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalUtils;
    delete window.PdfPreviewModalStateCore;
    delete window.PdfPreviewModalViewer;
    delete window.PDFViewer;
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div>
      <div id="pdfOriginalPane"></div>
      <div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button>
      <button id="pdfGradedTab"></button>
      <button id="pdfPreviewFullscreenToggle"></button>
      <button id="pdfPreviewSplitPanelToggle"></button>
      <button class="js-toggle-markup"></button>
      <div id="pdfGradedCommentsList"></div>
      <div id="pdfGradedAICommentsList"></div>
      <div id="pdfModelACommentsList"></div>
      <div id="pdfModelBCommentsList"></div>
      <div id="pdfGradedContainer"></div>
      <div id="pdfOriginalContainer"></div>
    `;
    window.bootstrap = {
      Modal: {
        getInstance: () => null,
      },
    };
  });

  it('exposes the portable AEMSPdfAnnotator API', async () => {
    await import(new URL(BUNDLE_PATH, import.meta.url));

    expect(window.AEMSPdfAnnotator).toBeDefined();
    expect(typeof window.AEMSPdfAnnotator.createAnnotatorModal).toBe('function');
    expect(typeof window.AEMSPdfAnnotator.ensureModalPdfViewers).toBe('function');
    expect(typeof window.PdfPreviewModal.createPdfPreviewModal).toBe('function');
  });

  it('maps hostApi to the underlying modal modeAdapter contract', async () => {
    await import(new URL(BUNDLE_PATH, import.meta.url));

    const hostApi = { supportsAnnotationCrud: () => true };
    const modal = window.AEMSPdfAnnotator.createAnnotatorModal({
      context: {
        assignmentId: 11,
        submissionId: 22,
        studentName: 'Alice',
        mode: 'local',
        annotatedPdfPolicy: 'local_required',
      },
      hostApi,
    });

    expect(modal._state.options.assignmentId).toBe(11);
    expect(modal._state.options.submissionId).toBe(22);
    expect(modal._state.options.studentName).toBe('Alice');
    expect(modal._state.options.mode).toBe('local');
    expect(modal._state.options.modeAdapter).toBe(hostApi);
    expect(modal._state.options.annotatedPdfPolicy).toBe('local_required');
  });
});
