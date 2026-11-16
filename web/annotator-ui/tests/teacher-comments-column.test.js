/** 140e: use the real controller and empty-content policy for both panel modes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(async () => {
  vi.resetModules();
  for (const key of ['PdfPreviewModalAnnotationController', 'PdfPreviewModalSidebarPanel', 'PdfPreviewModalUtils']) {
    delete window[key];
  }
  await import('../src/pdf-preview-modal/utils.js');
  await import('../src/pdf-preview-modal/sidebar-panel.js');
  await import('../src/pdf-preview-modal/annotation-controller.js');
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', callback => { callback(); return 1; });
  document.body.innerHTML = '<div id="pdfGradedContainer"><div id="box"></div>'
    + '<div class="annotation-marker" data-annotation-page="0" data-annotation-xref="42"></div>'
    + '<div id="outside"></div></div><div id="pdfGradedCommentsList"></div>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const top = this.id === 'outside' ? 900 : 0;
    return { left: 0, right: 600, top, bottom: top + 800, width: 600, height: 800 };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('retains only teacher pins after an authoritative reload (split=%s)', async split => {
  let data = {};
  const controller = window.PdfPreviewModalAnnotationController.createAnnotationController({
    getAnnotationsData: () => data, setAnnotationsData: value => { data = value; },
    getSplitPanelActive: () => split,
    helpers: {
      listAnnotationsRequest: async () => ({ success: true, annotations: { 0: [
        { stable_id: 'box', type: 'textbox', content: 'Teacher box', source: 'HUMAN', author_name: 'Teacher Example' },
        { xref: 42, type: 'Text', content: 'Teacher note', source: 'HUMAN' },
        { stable_id: 'outside', type: 'textbox', content: 'Offscreen', source: 'HUMAN' },
        { stable_id: 'ink', type: 'drawing', content: '', source: 'HUMAN' },
        { stable_id: 'empty-box', type: 'textbox', content: '', source: 'HUMAN' },
      ] } }),
      resolveAnnotationSource: ann => ann.source,
      getPageTextboxes: () => [
        { annotationId: 'box', element: document.getElementById('box') },
        { annotationId: 'empty-box', element: document.getElementById('box') },
        { annotationId: 'outside', element: document.getElementById('outside') },
        { annotationId: null, element: document.getElementById('box') },
      ],
    },
  });
  await controller.reload();
  controller.renderList();
  const rows = [...document.querySelectorAll('.list-group-item')];
  expect(rows.map(row => row.querySelector('.annotation-content').textContent)).toEqual(['Teacher note']);
  expect(rows.every(row => row.dataset.annotationSource === 'HUMAN')).toBe(true);
  expect(rows.every(row => row.querySelector('.source-human .bi-person-fill'))).toBe(true);
  controller.destroy();
});

it.each([false, true])('keeps a newly drawn teacher textbox out of both column modes (split=%s)', async split => {
  let data = { 0: [{ xref: 42, type: 'Text', content: 'Teacher note', source: 'HUMAN' }] };
  let boxes = [];
  const controller = window.PdfPreviewModalAnnotationController.createAnnotationController({
    getAnnotationsData: () => data, setAnnotationsData: value => { data = value; },
    getSplitPanelActive: () => split,
    helpers: {
      resolveAnnotationSource: ann => ann.source,
      getPageTextboxes: () => boxes,
    },
  });
  controller.renderList();
  const contents = () => [...document.querySelectorAll('.list-group-item .annotation-content')]
    .map(cell => cell.textContent);
  expect(contents()).toEqual(['Teacher note']);
  data = { 0: [...data[0], { stable_id: 'box', type: 'textbox', content: 'Added box', source: 'HUMAN' }] };
  boxes = [{ annotationId: 'box', element: document.getElementById('box') }];
  controller.renderList();
  expect(contents()).toEqual(['Teacher note']);
  controller.destroy();
});

it.each([
  [{ type: 'textbox', source: 'HUMAN', content: 'Box' }, false],
  [{ kind: 'textbox', source: 'HUMAN', content: 'Box' }, false],
  [{ type: 'drawing', source: 'HUMAN', drawing_style: 'pen', content: 'Ink' }, false],
  [{ type: 'Ink', source: 'HUMAN', content: 'Ink' }, false],
  [{ type: 'drawing', source: 'HUMAN', drawing_style: 'highlighter', content: '', _hasBeenEdited: true }, false],
  [{ type: 'Highlight', source: 'AI', content: 'AI anchored comment', quads: [[1, 2, 3, 4]] }, true],
  [{ type: 'Highlight', source: 'HUMAN', content: 'Edited AI comment', quads: [[1, 2, 3, 4]] }, true],
  [{ type: 'Text', source: 'AI', content: 'AI pin' }, true],
  [{ kind: 'text', source: 'HUMAN', content: 'Teacher pin' }, true],
  [{ source: 'AI', content: 'Legacy comment without a type' }, true],
])('filters stored row %j without changing its content', (row, expected) => {
  const original = structuredClone(row);
  expect(window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation(row, true)).toBe(expected);
  expect(row).toEqual(original);
});
