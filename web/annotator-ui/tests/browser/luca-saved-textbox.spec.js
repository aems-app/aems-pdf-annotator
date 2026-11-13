/** L1d actual-layout oracle: saved text and its final marker stay inside the PDF page box. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css = readFileSync(new URL('../../src/annotator-ui.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../src/pdf-preview-modal/textbox.js', import.meta.url), 'utf8');
const feedback = Array.from({ length: 22 }, (_, i) => `Q${i % 3 + 1} sentence ${i}: Complete synthetic explanation and supporting detail.`)
    .join(' ') + ' L1D_FINAL_TAIL_MARK';

for (const scale of [1, 0.5, 1.5]) {
    test(`stored feedback is complete inside its saved rectangle at scale ${scale}`, async ({ page }) => {
        await page.setContent('<div class="pdf-page-wrapper" id="component-page"></div>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(({ scale, feedback }) => {
            const host = document.getElementById('component-page');
            host.style.position = 'relative';
            host.style.width = `${671 * scale}px`;
            host.style.height = `${950 * scale}px`;
            const canvas = document.createElement('canvas');
            canvas.width = 671;
            canvas.height = 950;
            canvas.style.width = `${671 * scale}px`;
            canvas.style.height = `${950 * scale}px`;
            host.append(canvas);
            const saved = { x: 27, y: 441, width: 617, height: 482 };
            window.PdfPreviewModalTextbox.loadTextboxesFromAnnotations([
                { type: 'textbox', pageIdx: 0, annotationId: 'saved-feedback', content: feedback, ...saved },
            ], [host]);
            const entry = window.PdfPreviewModalTextbox.getPageTextboxes(0)[0];
            const box = entry.element;
            const content = entry.contentElement;
            const text = [...content.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
            const offset = text.textContent.indexOf('L1D_FINAL_TAIL_MARK');
            const range = document.createRange();
            range.setStart(text, offset);
            range.setEnd(text, offset + 'L1D_FINAL_TAIL_MARK'.length);
            const tail = range.getBoundingClientRect();
            const bounds = box.getBoundingClientRect();
            const pageBounds = canvas.getBoundingClientRect();
            const style = getComputedStyle(box);
            return {
                stylesheetApplied: style.boxSizing === 'border-box' && style.position === 'absolute',
                width: bounds.width, height: bounds.height,
                expectedWidth: saved.width * scale, expectedHeight: saved.height * scale,
                tailVisible: tail.left >= bounds.left - 0.5 && tail.right <= bounds.right + 0.5
                    && tail.top >= bounds.top - 0.5 && tail.bottom <= bounds.bottom + 0.5,
                withinPage: bounds.left >= pageBounds.left - 0.5 && bounds.right <= pageBounds.right + 0.5
                    && bounds.top >= pageBounds.top - 0.5 && bounds.bottom <= pageBounds.bottom + 0.5,
                fontSize: parseFloat(style.fontSize), textUnchanged: content.textContent === feedback,
            };
        }, { scale, feedback });
        expect(result.stylesheetApplied, 'the real stylesheet must apply').toBe(true);
        expect(result.textUnchanged).toBe(true);
        expect(result.width).toBeCloseTo(result.expectedWidth, 1);
        expect(result.height).toBeCloseTo(result.expectedHeight, 1);
        expect(result.withinPage).toBe(true);
        expect(result.tailVisible, JSON.stringify(result)).toBe(true);
        expect(result.fontSize).toBeGreaterThan(0);
    });
}
