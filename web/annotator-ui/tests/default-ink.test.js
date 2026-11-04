import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="tools"></div>';
  await import('../src/pdf-preview-modal/drawing-canvas.js');
  await import('../src/pdf-preview-modal/markup-toolbar.js');
});
afterEach(() => {
  window.PdfPreviewModalMarkupToolbar.destroy();
  window.PdfPreviewModalDrawingCanvas.destroy();
});

// Defect 42: orange editor defaults become low-contrast amber in Canvas.
it('starts teacher drawing ink in red', () => {
  expect(window.PdfPreviewModalDrawingCanvas.getActiveColor().name).toBe('red');
  expect(window.PdfPreviewModalDrawingCanvas.getActiveColor().rgb).toEqual([238, 6, 18]);
});

it('accepts colour selection before mounting and resets the next toolbar to red', () => {
  const toolbar = window.PdfPreviewModalMarkupToolbar;
  toolbar.setActiveColor('green');
  expect(toolbar.getActiveColor()).toBe('green');
  toolbar.create(document.getElementById('tools'));
  toolbar.setActiveTool('pen');
  expect(toolbar.getActiveColor()).toBe('red');
});

it('uses red pen/text defaults and an independent yellow highlighter', () => {
  const toolbar = window.PdfPreviewModalMarkupToolbar;
  toolbar.create(document.getElementById('tools'));
  toolbar.setActiveTool('pen');
  expect(toolbar.getActiveColor()).toBe('red');
  toolbar.setActiveTool('text');
  expect(toolbar.getActiveColor()).toBe('red');
  toolbar.setActiveTool('highlighter');
  expect(toolbar.getActiveColor()).toBe('yellow');
  toolbar.setActiveTool('pen');
  expect(toolbar.getActiveColor()).toBe('red');
});

it('remembers explicitly chosen ink independently from the highlighter', () => {
  const toolbar = window.PdfPreviewModalMarkupToolbar;
  toolbar.create(document.getElementById('tools'));
  toolbar.setActiveTool('pen');
  toolbar.setActiveColor('green');
  toolbar.setActiveTool('select');
  toolbar.setActiveTool('highlighter');
  expect(toolbar.getActiveColor()).toBe('yellow');
  toolbar.setActiveTool('text');
  expect(toolbar.getActiveColor()).toBe('green');
});
