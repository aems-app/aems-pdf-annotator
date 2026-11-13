/** Short saved text must not disappear because native layout metrics round fractions. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(async () => {
    vi.resetModules();
    document.body.replaceChildren();
    delete window.PdfPreviewModalTextbox;
    await import('../src/pdf-preview-modal/textbox.js');
});

afterEach(() => {
    window.PdfPreviewModalTextbox?.destroy();
    delete window.PdfPreviewModalTextbox;
    vi.restoreAllMocks();
});

function fixture(width, scale, resized = false) {
    const host = document.createElement('div');
    host.className = 'pdf-page-wrapper';
    const canvas = document.createElement('canvas');
    canvas.width = 671;
    canvas.height = 950;
    Object.defineProperties(canvas, {
        offsetWidth: { value: Math.round(canvas.width * scale) },
        offsetHeight: { value: Math.round(canvas.height * scale) },
    });
    host.append(canvas);
    document.body.append(host);
    const api = window.PdfPreviewModalTextbox;
    api.loadTextboxesFromAnnotations([{ type: 'textbox', pageIdx: 0, annotationId: 'fractional',
        content: 'A TAIL', x: 10 / scale, y: 20 / scale,
        width: (resized ? 160 : width) / scale, height: (resized ? 80 : 40) / scale }], [host]);
    const entry = api.getPageTextboxes(0)[0];
    const box = entry.element;
    const content = entry.contentElement;
    if (resized) {
        box.style.width = `${width}px`;
        box.style.height = '40px';
    }
    const number = value => parseFloat(value) || 0;
    const font = () => number(box.style.fontSize) || 13;
    const widthInside = () => number(box.style.width) - 2;
    const heightInside = () => number(box.style.height) - 2;
    const padding = (first, second) => {
        const computed = getComputedStyle(box);
        return number(computed[first]) + number(computed[second]);
    };
    // DOM client/scroll measurements are integers, even when CSS padding is fractional.
    const contentWidth = () => Math.round(widthInside() - padding('paddingLeft', 'paddingRight'));
    const textWidth = () => Math.round(content.textContent.length * font() * 0.6);
    const textHeight = () => Math.ceil(font() * 1.3);
    Object.defineProperties(box, {
        clientWidth: { configurable: true, get: () => Math.round(widthInside()) },
        clientHeight: { configurable: true, get: () => Math.round(heightInside()) },
    });
    Object.defineProperties(content, {
        clientWidth: { configurable: true, get: contentWidth },
        scrollWidth: { configurable: true, get: () => Math.max(contentWidth(), textWidth()) },
        clientHeight: { configurable: true, get: textHeight },
        scrollHeight: { configurable: true, get: textHeight },
    });
    return entry;
}

it.each([1, 0.5, 1.5])('retains readable short text with fractional padding at scale%s', scale => {
    const entry = fixture(67, scale);
    entry.contentElement.dispatchEvent(new Event('input'));
    expect(parseFloat(entry.element.style.fontSize), 'short text fits; fractional integer rounding must not shrink it')
        .toBeCloseTo(13, 1);
    expect(entry.contentElement.textContent).toBe('A TAIL');
    expect(entry.contentElement.scrollWidth).toBeLessThanOrEqual(entry.contentElement.clientWidth);
});

it.each([1, 0.5, 1.5])('nearby width remains a readable control at scale%s', scale => {
    const entry = fixture(68, scale);
    entry.contentElement.dispatchEvent(new Event('input'));
    expect(parseFloat(entry.element.style.fontSize)).toBeCloseTo(13, 1);
    expect(entry.contentElement.textContent).toBe('A TAIL');
});

it.each([67, 68])('keeps short text readable after explicit resize to%s px', width => {
    const entry = fixture(width, 1, true);
    entry.contentElement.dispatchEvent(new Event('input'));
    expect(parseFloat(entry.element.style.width)).toBe(width);
    expect(parseFloat(entry.element.style.fontSize)).toBeCloseTo(13, 1);
    expect(entry.contentElement.textContent).toBe('A TAIL');
});
