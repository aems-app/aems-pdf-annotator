import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/markup-toolbar.js';

const loadMarkupToolbarModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalMarkupToolbar;
};

describe('markup-toolbar saved position handling', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalMarkupToolbar;
    delete window.PdfPreviewModalDrawingCanvas;
    localStorage.clear();
    document.body.innerHTML = '<div id="host"></div>';
  });

  it('ignores non-finite saved positions from localStorage', async () => {
    localStorage.setItem('aems-markup-toolbar-position', '{"left":1e309,"top":20}');

    const module = await loadMarkupToolbarModule();
    module.create(document.getElementById('host'));

    const toolbar = document.querySelector('.markup-toolbar');
    expect(toolbar.style.left).toBe('');
    expect(toolbar.style.top).toBe('');
  });
});
