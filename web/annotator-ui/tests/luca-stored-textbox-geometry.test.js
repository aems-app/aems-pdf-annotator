/** L1d: a saved textbox must use its projected geometry in the DOM preview. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const content = Array.from({ length: 22 }, (_, i) => `Q${1 + (i % 3)} sentence ${i}: Complete synthetic feedback.`)
    .join(' ') + ' L1D_Q1_TAIL_MARK.';

beforeEach(async () => {
    vi.resetModules();
    document.body.replaceChildren();
    delete window.PdfPreviewModalTextbox;
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
        if (this.classList?.contains('markup-textbox-measure')) {
            return { x: 0, y: 0, top: 0, left: 0, right: 2400, bottom: 1132, width: 2400, height: 1132 };
        }
        return real.call(this);
    });
    await import('../src/pdf-preview-modal/textbox.js');
});

afterEach(() => {
    window.PdfPreviewModalTextbox?.clearAllTextboxes?.();
    delete window.PdfPreviewModalTextbox;
    vi.restoreAllMocks();
});

it.each([1, 0.5, 1.5])('retains stored rectangle at canvas display scale %s', scale => {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    const canvas = document.createElement('canvas');
    canvas.width = 671;
    canvas.height = 950;
    Object.defineProperties(canvas, {
        offsetWidth: { value: canvas.width * scale },
        offsetHeight: { value: canvas.height * scale },
    });
    wrapper.append(canvas);
    document.body.append(wrapper);
    const saved = { x: 27, y: 441, width: 617, height: 482 };
    window.PdfPreviewModalTextbox.loadTextboxesFromAnnotations([
        { type: 'textbox', pageIdx: 0, annotationId: 'feedback-box', content, color: '#000', ...saved },
    ], [wrapper]);
    const box = wrapper.querySelector('.markup-textbox');
    expect(box).not.toBeNull();
    const drawn = { x: parseFloat(box.style.left), y: parseFloat(box.style.top),
        width: parseFloat(box.style.width), height: parseFloat(box.style.height) };
    expect(box.textContent).toContain('L1D_Q1_TAIL_MARK');
    for (const key of Object.keys(saved)) {
        expect(drawn[key], `saved ${key} must survive initial load`).toBeCloseTo(saved[key] * scale, 1);
    }
});

it.each([
    {}, { width: 0, height: 0 }, { width: -1, height: 20 }, { width: NaN, height: 30 },
])('retains autosizing for legacy textbox without a usable saved size (%j)', size => {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    const canvas = document.createElement('canvas');
    canvas.width = 671;
    canvas.height = 950;
    wrapper.append(canvas);
    document.body.append(wrapper);
    window.PdfPreviewModalTextbox.loadTextboxesFromAnnotations([
        { type: 'textbox', pageIdx: 0, annotationId: 'legacy-box', content, x: 27, y: 50, ...size },
    ], [wrapper]);
    const box = wrapper.querySelector('.markup-textbox');
    const width = parseFloat(box.style.width);
    const height = parseFloat(box.style.height);
    expect(Number.isFinite(width) && width > 0 && width <= 220).toBe(true);
    expect(Number.isFinite(height) && height > 0).toBe(true);
    expect(box.textContent).toContain('L1D_Q1_TAIL_MARK');
});
