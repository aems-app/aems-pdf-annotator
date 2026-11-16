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

  it('offers Select, Comment, Text, Pen, Highlight with separate N and T shortcuts', async () => {
    window.PdfPreviewModalUtils = { translateText: key => key === 'Comment' ? 'Kommentar' : key };
    const toolbar = await loadMarkupToolbarModule();
    toolbar.create(document.getElementById('host'));
    toolbar.show();
    expect([...document.querySelectorAll('.js-markup-tool')].map(button => button.dataset.tool))
      .toEqual(['select', 'comment', 'text', 'pen', 'highlighter']);
    expect(document.querySelector('[data-tool="comment"]').title).toBe('Kommentar (N)');
    expect(document.querySelector('[data-tool="comment"] svg')).not.toBeNull();
    expect(document.querySelector('[aria-haspopup], [data-slot-tool]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
    expect(toolbar.getActiveTool()).toBe('comment');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
    expect(toolbar.getActiveTool()).toBe('text');
    toolbar.destroy();
  });
});
