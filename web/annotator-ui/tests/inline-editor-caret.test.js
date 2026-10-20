import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom does not perform the browser's default text insertion for key events.
// Insert at the live selection, then dispatch the input event a real key produces.
function typeText(textarea, text) {
  textarea.focus();
  textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.dispatchEvent(new InputEvent('input', {
    bubbles: true, inputType: 'insertText', data: text,
  }));
}

describe('inline editor opening caret', () => {
  let helpers;
  let label;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    delete window.PdfPreviewModal;
    document.body.innerHTML = `
      <button id="elsewhere">Another control</button>
      <div class="pdf-annotation-overlay">
        <div class="annotation-marker"><div class="annotation-label"></div></div>
      </div>`;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback();
      return 1;
    });
    await import('../src/pdf-preview-modal.js');
    helpers = window.PdfPreviewModal.__test;
    label = document.querySelector('.annotation-label');
  });

  afterEach(() => {
    helpers.collapseInlineLabel(label);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function openEditor(content = 'New comment...') {
    helpers.setupLabelTooltipEvents(label, content);
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const textarea = label.querySelector('textarea.inline-annotation-editor');
    expect(textarea).not.toBeNull();
    return textarea;
  }

  it('keeps typing across the 50 ms opening deadline in the intended order', () => {
    const textarea = openEditor();
    vi.advanceTimersByTime(10);
    typeText(textarea, 'C');
    vi.advanceTimersByTime(40);
    typeText(textarea, 'aret probe text.');

    expect(textarea.value).toBe('Caret probe text.');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([17, 17]);
  });

  it.each([[3, 3, 'none'], [2, 8, 'backward']])(
    'preserves selection %i..%i (%s) moved before the deadline without a text change',
    (start, end, direction) => {
      const textarea = openEditor('Existing feedback');
      textarea.focus();
      vi.advanceTimersByTime(10);
      textarea.setSelectionRange(start, end, direction);
      vi.advanceTimersByTime(40);

      expect(textarea.value).toBe('Existing feedback');
      expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection])
        .toEqual([start, end, direction]);
    },
  );

  it('opens idle editors with focus and the caret at the start', () => {
    const textarea = openEditor('Existing feedback');
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 0]);
    vi.advanceTimersByTime(50);

    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('Existing feedback');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 0]);
  });

  it('leaves both the retired editor and its replacement alone after close and reopen', () => {
    const retired = openEditor('Existing feedback');
    vi.advanceTimersByTime(20);
    helpers.collapseInlineLabel(label);
    const textarea = openEditor('Existing feedback');
    textarea.focus();
    textarea.setSelectionRange(2, 7, 'backward');
    const retiredFocus = vi.spyOn(retired, 'focus');
    const retiredSelection = vi.spyOn(retired, 'setSelectionRange');
    const retiredLayout = vi.fn(() => 100);
    Object.defineProperty(retired, 'scrollHeight', { get: retiredLayout });

    vi.advanceTimersByTime(30); // Only the retired editor's deadline.
    expect(retired.isConnected).toBe(false);
    expect(retiredFocus).not.toHaveBeenCalled();
    expect(retiredSelection).not.toHaveBeenCalled();
    expect(retiredLayout).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);

    vi.advanceTimersByTime(20); // The replacement's deadline also preserves selection.
    expect(textarea.value).toBe('Existing feedback');
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection])
      .toEqual([2, 7, 'backward']);
  });

  it('does not touch an editor detached with its overlay before the deadline', () => {
    const textarea = openEditor('Existing feedback');
    label.closest('.pdf-annotation-overlay').remove();
    const focus = vi.spyOn(textarea, 'focus');
    const selection = vi.spyOn(textarea, 'setSelectionRange');
    const layout = vi.fn(() => 100);
    Object.defineProperty(textarea, 'scrollHeight', { get: layout });
    vi.advanceTimersByTime(50);

    expect(focus).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
  });

  it('keeps deliberate focus on another control before the deadline', () => {
    const textarea = openEditor('Existing feedback');
    textarea.focus();
    vi.advanceTimersByTime(10);
    const elsewhere = document.getElementById('elsewhere');
    elsewhere.focus();
    vi.advanceTimersByTime(40);

    expect(document.activeElement).toBe(elsewhere);
  });

  it('retains the deferred auto-resize, input resize cap, and priority strip', () => {
    const textarea = openEditor('Existing feedback');
    let scrollHeight = 144;
    Object.defineProperty(textarea, 'scrollHeight', { get: () => scrollHeight });
    vi.advanceTimersByTime(49);
    expect(textarea.style.height).toBe('');
    vi.advanceTimersByTime(1);
    expect(textarea.style.height).toBe('144px');
    expect(label.querySelectorAll('.inline-priority-strip .strip-section')).toHaveLength(3);

    scrollHeight = 260;
    typeText(textarea, 'More feedback');
    expect(textarea.style.height).toBe('200px');
    expect(label.classList.contains('label-editing')).toBe(true);
  });
});
