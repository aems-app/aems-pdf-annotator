/** L1d: stored geometry is a contract through edit, save, move and resize. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const feedback = Array.from({ length: 18 }, (_, i) => `Q${i % 3 + 1}: Complete synthetic explanation ${i}.`)
    .join(' ') + ' L1D_FINAL_TAIL';
let textbox;

beforeEach(async () => {
    vi.resetModules();
    document.body.replaceChildren();
    delete window.PdfPreviewModalTextbox;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        if (this.classList?.contains('markup-textbox-measure')) {
            return { x: 0, y: 0, top: 0, left: 0, right: 1800, bottom: 900, width: 1800, height: 900 };
        }
        return original.call(this);
    });
    await import('../src/pdf-preview-modal/textbox.js');
    textbox = window.PdfPreviewModalTextbox;
});

afterEach(() => {
    textbox?.destroy();
    delete window.PdfPreviewModalTextbox;
    vi.restoreAllMocks();
});

function wrapper() {
    const host = document.createElement('div');
    host.className = 'pdf-page-wrapper';
    const canvas = document.createElement('canvas');
    canvas.width = 671;
    canvas.height = 950;
    host.append(canvas);
    document.body.append(host);
    return host;
}

function loaded(width = 617, height = 482, text = feedback) {
    const host = wrapper();
    textbox.loadTextboxesFromAnnotations([
        { type: 'textbox', annotationId: 'stored-feedback', pageIdx: 0, x: 27, y: 45, width, height, content: text },
    ], [host]);
    const entry = textbox.getPageTextboxes(0)[0];
    // Isolate the subsequent lifecycle path even while initial-load geometry is still broken.
    entry.element.style.width = `${width}px`;
    entry.element.style.height = `${height}px`;
    entry.element.style.minHeight = '0px';
    entry.element.style.maxWidth = 'none';
    return { entry, host };
}

function dimensions(element) {
    return { width: parseFloat(element.style.width), height: parseFloat(element.style.height) };
}

it.each(['edit', 'input', 'commit', 'page move', 'resize then input'])(
    'does not remeasure a stored box into a narrow column during %s', operation => {
        const { entry } = loaded();
        const committed = vi.fn();
        textbox.onTextboxCommitted = committed;
        const expected = operation === 'resize then input' ? { width: 480, height: 330 } : { width: 617, height: 482 };
        if (operation === 'edit') textbox.editTextbox(entry);
        if (operation === 'input') entry.contentElement.dispatchEvent(new Event('input'));
        if (operation === 'commit') entry.contentElement.dispatchEvent(new Event('blur'));
        if (operation === 'page move') textbox.moveTextboxToPage(entry, 1, wrapper(), 30, 60);
        if (operation === 'resize then input') {
            entry.element.style.width = '480px';
            entry.element.style.height = '330px';
            entry.contentElement.dispatchEvent(new Event('input'));
        }
        expect(dimensions(entry.element), 'saved or explicitly resized geometry must survive').toEqual(expected);
        expect(entry.contentElement.textContent).toBe(feedback);
        expect(entry.annotationId).toBe('stored-feedback');
        if (operation === 'commit') {
            expect(committed).toHaveBeenCalledWith(entry);
            expect(entry.content).toBe(feedback);
        }
        if (operation === 'page move') expect(textbox.getPageTextboxes(1)).toContain(entry);
    });

it('moves on the same page without resizing or losing content', () => {
    const { entry } = loaded();
    textbox.moveTextbox(entry, 12, 8);
    expect(dimensions(entry.element)).toEqual({ width: 617, height: 482 });
    expect(parseFloat(entry.element.style.left)).toBe(39);
    expect(parseFloat(entry.element.style.top)).toBe(53);
    expect(entry.contentElement.textContent).toBe(feedback);
});

function installLayoutMetrics(entry) {
    const box = entry.element;
    const content = entry.contentElement;
    const number = value => parseFloat(value) || 0;
    const padding = axis => {
        const style = getComputedStyle(box);
        return axis === 'x' ? number(style.paddingLeft) + number(style.paddingRight)
            : number(style.paddingTop) + number(style.paddingBottom);
    };
    const font = () => number(box.style.fontSize) || 13;
    const availableWidth = () => Math.max(0.01, number(box.style.width) - padding('x'));
    const actualHeight = () => {
        const lines = Math.max(1, Math.ceil(content.textContent.length * 0.6 * font() / availableWidth()));
        return lines * font() * 1.3;
    };
    const actualWidth = () => Math.max(availableWidth(), font() * 0.6);
    Object.defineProperties(box, {
        clientWidth: { configurable: true, get: () => number(box.style.width) },
        clientHeight: { configurable: true, get: () => number(box.style.height) },
        scrollWidth: { configurable: true, get: () => actualWidth() + padding('x') },
        scrollHeight: { configurable: true, get: () => actualHeight() + padding('y') },
    });
    Object.defineProperties(content, {
        clientWidth: { configurable: true, get: availableWidth },
        clientHeight: { configurable: true, get: () => Math.max(0.01, number(box.style.height) - padding('y')) },
        scrollWidth: { configurable: true, get: actualWidth },
        scrollHeight: { configurable: true, get: actualHeight },
    });
}

it.each([
    [160, 70, feedback], [8, 24, 'Wide character W'], [160, 70, 'Short.'],
])('fits observable text overflow inside preserved %sx%s geometry', (width, height, text) => {
    const { entry } = loaded(width, height, text);
    installLayoutMetrics(entry);
    entry.contentElement.dispatchEvent(new Event('input'));
    expect(dimensions(entry.element)).toEqual({ width, height });
    const size = parseFloat(entry.element.style.fontSize);
    expect(Number.isFinite(size) && size > 0 && size <= 13).toBe(true);
    expect(entry.element.scrollHeight).toBeLessThanOrEqual(entry.element.clientHeight + 1);
    expect(entry.element.scrollWidth).toBeLessThanOrEqual(entry.element.clientWidth + 1);
    expect(entry.contentElement.textContent).toBe(text);
    if (text === 'Short.') expect(size).toBeCloseTo(13, 1);
    else expect(size).toBeLessThan(13);
});
