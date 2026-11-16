import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let selection;
let wrapper;
let entry;

function pointer(target, type, x = 20, y = 20) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  target.dispatchEvent(event);
}

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="pdfGradedContainer"><div class="pdf-page-wrapper" data-page-num="1"><canvas width="600" height="800"></canvas><div class="markup-textbox"></div></div></div><button id="outside">Elsewhere</button>';
  vi.stubGlobal('PdfPreviewModalMarkupSelection', {});
  vi.stubGlobal('PdfPreviewModalTextbox', { moveTextbox: vi.fn(), editTextbox: vi.fn() });
  vi.stubGlobal('PdfPreviewModalDrawingCanvas', {
    getStrokeBounds: () => ({ minX: 10, minY: 10, maxX: 100, maxY: 100 }),
    moveStroke: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800 });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  await import('../src/pdf-preview-modal/markup-selection.js');
  selection = window.PdfPreviewModalMarkupSelection;
  selection.init();
  wrapper = document.querySelector('.pdf-page-wrapper');
  entry = { annotationId: 'selected-annotation', element: document.querySelector('.markup-textbox'), points: [{ x: 10, y: 10 }, { x: 100, y: 100 }] };
});

afterEach(() => {
  selection.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete HTMLElement.prototype.setPointerCapture;
  delete HTMLElement.prototype.releasePointerCapture;
});

it.each([false, true])('FIX6: refresh during pointer capture preserves drag and saves final position (moved=%s)', moved => {
  const completed = vi.fn();
  selection.onMoveCompleted = completed;
  selection.startDrag('textbox', entry, 0, wrapper, { button: 0, target: entry.element,
    clientX: 20, clientY: 20, pointerId: 7, preventDefault() {}, stopPropagation() {} });
  const overlay = document.querySelector('.markup-selection-overlay');
  if (moved) pointer(overlay, 'pointermove', 40, 40);
  const live = { ...entry, element: document.createElement('div') };
  wrapper.append(live.element);
  selection.refreshSelected(live, wrapper);
  expect.soft(overlay.isConnected, 'refresh must retain the captured overlay').toBe(true);
  pointer(overlay, 'pointermove', 80, 80);
  pointer(overlay, 'pointerup', 80, 80);
  expect.soft(completed).toHaveBeenCalledTimes(1);
  expect.soft(window.PdfPreviewModalTextbox.moveTextbox).toHaveBeenLastCalledWith(entry, moved ? 40 : 60, moved ? 40 : 60);
  expect(selection.getSelected()?.entry).toBe(live);
});

it.each(['textbox', 'stroke'].flatMap(type => [false, true].map(moved => ({ type, moved }))))(
  '293d: $type selection and delete X survive pointer release (moved=$moved)', ({ type, moved }) => {
    const target = entry.element;
    target.addEventListener('pointerdown', e => selection.startDrag(type, entry, 0, wrapper, e));
    pointer(target, 'pointerdown');
    const overlay = document.querySelector('.markup-selection-overlay');
    expect(selection.getSelected().entry).toBe(entry);
    if (moved) pointer(overlay, 'pointermove', 30, 30);
    pointer(overlay, 'pointerup', moved ? 30 : 20, moved ? 30 : 20);
    expect(selection.getSelected()?.entry === entry, 'release keeps selection').toBe(true);
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.isConnected).toBe(true);
    if (type === 'textbox') expect(entry.element.classList.contains('selected')).toBe(true);
    const deleted = vi.fn(() => {
      const item = selection.deleteSelected();
      item.entry.element.remove();
    });
    selection.onDeleteRequested = deleted;
    const button = overlay.querySelector('.markup-selection-delete');
    pointer(button, 'pointerdown');
    pointer(button, 'pointerup');
    button.click();
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(entry.element.isConnected).toBe(false);
    expect(selection.hasSelection()).toBe(false);
    expect(overlay.isConnected).toBe(false);
  },
);

it('outside pointer presses clear selection; destroy removes that listener', () => {
  selection.select('textbox', entry, 0, wrapper);
  pointer(document.getElementById('outside'), 'pointerdown');
  expect(selection.hasSelection()).toBe(false);
  selection.destroy();
  selection.select('textbox', entry, 0, wrapper);
  pointer(document.getElementById('outside'), 'pointerdown');
  expect(selection.hasSelection()).toBe(true);
});

it('pressing the selected textbox itself keeps selection', () => {
  selection.select('textbox', entry, 0, wrapper);
  pointer(entry.element, 'pointerdown');
  expect(selection.getSelected().entry).toBe(entry);
});

it('an item without drawable bounds can still be deselected outside', () => {
  window.PdfPreviewModalDrawingCanvas.getStrokeBounds = () => null;
  selection.select('stroke', entry, 0, wrapper);
  pointer(document.getElementById('outside'), 'pointerdown');
  expect(selection.hasSelection()).toBe(false);
});

it.each(['Escape', 'Delete', 'Backspace'])('retained selection responds to %s', key => {
  selection.select('textbox', entry, 0, wrapper);
  const deleted = vi.fn(() => selection.deleteSelected());
  selection.onDeleteRequested = deleted;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  expect(selection.hasSelection()).toBe(false);
  expect(deleted).toHaveBeenCalledTimes(key === 'Escape' ? 0 : 1);
});
