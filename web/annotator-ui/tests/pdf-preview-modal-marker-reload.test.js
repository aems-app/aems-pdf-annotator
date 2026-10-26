import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ai = {
  id: 'Q1-move', stable_id: 'Q1-move', xref: 1046, page_index: 0,
  type: 'Text', content: 'Original feedback', source: 'AI', original_source: 'AI',
  can_revert_to_ai: false, color: 'amber', icon: 'help', rect: [100, 195, 116, 211],
};
const markerSelector = '.annotation-marker[data-annotation-stable-id="Q1-move"]';

describe('real modal marker reload after Restore', () => {
  let modals;
  let instances;
  let adapter;
  let hostAnnotation;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    modals = [];
    instances = [];
    hostAnnotation = structuredClone(ai);
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf') || key === 'PDFViewer') delete window[key];
    }
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div><div id="pdfPreviewStudent"></div>
      <div id="pdfOriginalPane"></div><div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button><button id="pdfGradedTab"></button>
      <div id="pdfGradedCommentsList"></div><div id="pdfGradedAICommentsList"></div>
      <div id="pdfGradedContainer"></div><div id="pdfOriginalContainer"></div>`;
    window.bootstrap = { Modal: class { show() {} static getInstance() { return null; } } };
    window.PdfPreviewModalViewer = {
      resolvePdfjsLib: () => ({}),
      PDFViewer: class {
        onAnnotationsPageChange() {} onPageRendered() {} onSliderSync() {} onResizeComplete() {}
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
    await import('../src/pdf-preview-modal/annotation-controller.js');
    const factory = window.PdfPreviewModalAnnotationController.createAnnotationController;
    vi.spyOn(window.PdfPreviewModalAnnotationController, 'createAnnotationController').mockImplementation((options) => {
      const controller = factory(options);
      instances.push({ controller, options });
      return controller;
    });
    adapter = {
      supportsRevertToAi: () => true,
      listAnnotations: vi.fn(async () => ({ success: true, annotations: { [hostAnnotation.page_index]: [structuredClone(hostAnnotation)] } })),
      updateAnnotation: vi.fn(async (_assignment, _submission, _id, body) => {
        hostAnnotation = { ...hostAnnotation, ...body, source: 'HUMAN', can_revert_to_ai: true };
        return { success: true, annotation: structuredClone(hostAnnotation) };
      }),
      revertAnnotationToAi: vi.fn(async () => {
        hostAnnotation = structuredClone(ai);
        return { success: true, annotation: structuredClone(hostAnnotation) };
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
        isGradedViewer: true, renderedPages: new Set([1, 2]), currentPage: 1, zoom: 1,
        getViewportForPage: () => ({ width: 600, height: 800, scale: 1, convertToPdfPoint: (x, y) => [x, y] }),
        pdf: { numPages: 2, getPage: vi.fn(async () => ({ view: [0, 0, 600, 800] })) },
      };
      await instances.at(-1).controller.loadAnnotations();
      await vi.advanceTimersByTimeAsync(600);
      expect(document.querySelector(markerSelector)?.dataset.annotationSource).toBe('AI');
      if (i < cycles) {
        releasePages();
        modal.destroy();
      }
    }
    return instances.at(-1);
  }

  async function move() {
    const marker = document.querySelector(markerSelector);
    marker.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 195, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 295, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(hostAnnotation.rect).toEqual([200, 295, 222, 317]);
    expect(document.querySelector(markerSelector)).toBe(marker);
    expect(marker.dataset.annotationSource).toBe('HUMAN');
    expect(marker.style.left).toBe('200px');
    expect(marker.style.top).toBe('295px');
    expect(document.querySelector('#pdfGradedCommentsList .source-human')).not.toBeNull();
    expect(document.querySelector('.revert-annotation-to-ai')).not.toBeNull();
  }

  function expectRestored() {
    const marker = document.querySelector(markerSelector);
    expect.soft(marker?.dataset.annotationSource, 'Restore must repaint the moved HUMAN marker from the AI reload').toBe('AI');
    expect.soft(marker?.classList.contains('source-ai')).toBe(true);
    expect.soft(marker?.classList.contains('source-human')).toBe(false);
    expect.soft(marker?.style.left, 'original rect x').toBe('100px');
    expect.soft(marker?.style.top, 'original rect y').toBe('195px');
    expect.soft(marker?.dataset.annotationPage).toBe('0');
    expect.soft(marker?.closest('.pdf-page-wrapper').dataset.pageNum).toBe('1');
    expect.soft(marker?.dataset.annotationIcon).toBe('help');
    expect.soft(marker?.querySelector('.annotation-marker-icon')?.classList.contains('bi-question-circle-fill')).toBe(true);
    expect.soft(marker?.querySelector('.annotation-marker-icon')?.style.color).toBe('rgb(245, 158, 11)');
    const list = document.getElementById('pdfGradedCommentsList');
    expect.soft(list.querySelector('.list-group-item.source-ai'), 'sidebar card must show AI').not.toBeNull();
    expect.soft(list.querySelector('.source-human')).toBeNull();
    expect.soft(list.querySelector('.revert-annotation-to-ai'), 'can_revert_to_ai=false removes Restore').toBeNull();
  }

  it.each([0, 2])('Restore repaints a HUMAN-moved marker and card after %i reopens', async (cycles) => {
    const { options } = await open(cycles);
    await move();
    const reloads = adapter.listAnnotations.mock.calls.length;
    document.querySelector('.revert-annotation-to-ai').click();
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.revertAnnotationToAi).toHaveBeenCalledExactlyOnceWith('assignment-1', 'submission-1', 'Q1-move');
    expect(adapter.listAnnotations.mock.calls.length).toBe(reloads + 1);
    expect(options.getAnnotationsData()[0][0]).toMatchObject(ai);
    expectRestored();
  });

  it('a general reload also repaints a moved marker whose cached model returns to AI', async () => {
    const { controller } = await open(0);
    await move();
    hostAnnotation = structuredClone(ai);
    await controller.loadAnnotations();
    await vi.advanceTimersByTimeAsync(600);
    expect(adapter.revertAnnotationToAi).not.toHaveBeenCalled();
    expectRestored();
  });

  it.each([
    ['rect', { rect: [230, 330, 246, 346] }],
    ['icon', { icon: 'check' }],
    ['colour', { color: 'red' }],
    ['page', { page_index: 1 }],
  ])('a reload applies changed %s to existing markers', async (_name, change) => {
    const { controller } = await open(0);
    hostAnnotation = { ...ai, ...change };
    await controller.loadAnnotations();
    await vi.advanceTimersByTimeAsync(600);
    const markers = document.querySelectorAll(markerSelector);
    expect(markers).toHaveLength(1);
    const marker = markers[0];
    expect.soft(marker.style.left).toBe(`${hostAnnotation.rect[0]}px`);
    expect.soft(marker.style.top).toBe(`${hostAnnotation.rect[1]}px`);
    expect.soft(marker.dataset.annotationPage).toBe(String(hostAnnotation.page_index));
    expect.soft(marker.closest('.pdf-page-wrapper').dataset.pageNum).toBe(String(hostAnnotation.page_index + 1));
    expect.soft(marker.dataset.annotationIcon).toBe(hostAnnotation.icon);
    expect.soft(marker.querySelector('.annotation-marker-icon')?.classList.contains(hostAnnotation.icon === 'check' ? 'bi-check-circle-fill' : 'bi-question-circle-fill')).toBe(true);
    expect.soft(marker.querySelector('.annotation-marker-icon')?.style.color).toBe(hostAnnotation.color === 'red' ? 'rgb(239, 68, 68)' : 'rgb(245, 158, 11)');
  });
});
