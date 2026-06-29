import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/comparison-mode.js';

const loadComparisonModeModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalComparison;
};

describe('comparison mode identifier escaping', () => {
  let originalScrollIntoView;

  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalComparison;
    delete window.__comparisonXss;
    delete window.__comparisonPageXss;
    window.PdfPreviewModalUtils = {
      debugLog: () => {},
    };
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div>
      <div id="pdfModelACommentsList"></div>
      <div id="pdfModelBCommentsList"></div>
      <div class="pdf-page-wrapper" data-page="1">
        <div class="pdf-annotation-overlay"></div>
      </div>
    `;
    document.querySelector('.pdf-annotation-overlay').getBoundingClientRect = () => ({
      width: 600,
      height: 800,
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
    });
    originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.restoreAllMocks();
  });

  it('renders and selects quote-bearing feedback ids without attribute or selector injection', async () => {
    const comparison = await loadComparisonModeModule();
    const payload = 'fb" onmouseover="window.__comparisonXss=1" data-z="';
    const pagePayload = '1" onmouseover="window.__comparisonPageXss=1"';

    comparison.comparisonModeActive = true;
    comparison.currentPage = 1;
    comparison.totalPages = 1;
    comparison.comparisonData = {
      annotationsA: [{
        id: payload,
        page: pagePayload,
        comment: 'Feedback item',
        quote: 'student quote',
        bbox: [0.1, 0.1, 0.2, 0.2],
      }],
      annotationsB: [],
      overlaps: [],
    };

    comparison.renderComparisonAnnotations();

    const item = document.querySelector('#pdfModelACommentsList .list-group-item');
    const marker = document.querySelector('.annotation-marker');
    expect(item).not.toBeNull();
    expect(marker).not.toBeNull();
    expect(document.querySelector('[onmouseover]')).toBeNull();
    expect(item.hasAttribute('data-z')).toBe(false);
    expect(item.dataset.feedbackId).toBe(payload);
    expect(item.dataset.page).toBe('1');
    expect(marker.dataset.feedbackId).toBe(payload);

    marker.click();
    expect(item.classList.contains('active')).toBe(true);

    item.click();
    expect(marker.classList.contains('highlighted')).toBe(true);
    marker.dispatchEvent(new window.Event('mouseover'));
    expect(window.__comparisonXss).toBeUndefined();
  });
});
