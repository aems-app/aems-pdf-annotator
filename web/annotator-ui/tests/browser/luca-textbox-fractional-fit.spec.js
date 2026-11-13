/** Native integer client/scroll dimensions must not shrink fitting short text to zero. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css = readFileSync(new URL('../../src/annotator-ui.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../src/pdf-preview-modal/textbox.js', import.meta.url), 'utf8');
const cases = [
    ...[1, 0.5, 1.5].map(scale => ({ width: 67, scale, resized: false })),
    ...[1, 0.5, 1.5].map(scale => ({ width: 68, scale, resized: false })),
    ...[67, 68].map(width => ({ width, scale: 1, resized: true })),
];

for (const sample of cases) {
    test(`short text stays readable width${sample.width}, scale${sample.scale}, resize${sample.resized}`, async ({ page }, info) => {
        await page.setContent('<div class="pdf-page-wrapper" id="fractional-page"></div>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(({ width, scale, resized }) => {
            const host = document.getElementById('fractional-page');
            host.style.position = 'relative';
            host.style.width = `${671 * scale}px`;
            host.style.height = `${950 * scale}px`;
            const canvas = document.createElement('canvas');
            canvas.width = 671;
            canvas.height = 950;
            canvas.style.width = `${671 * scale}px`;
            canvas.style.height = `${950 * scale}px`;
            host.append(canvas);
            const api = window.PdfPreviewModalTextbox;
            api.loadTextboxesFromAnnotations([{ type: 'textbox', pageIdx: 0,
                annotationId: 'fractional-short', content: 'A TAIL', x: 10 / scale, y: 20 / scale,
                width: (resized ? 160 : width) / scale, height: (resized ? 80 : 40) / scale }], [host]);
            const entry = api.getPageTextboxes(0)[0];
            if (resized) {
                entry.element.style.width = `${width}px`;
                entry.element.style.height = '40px';
                entry.contentElement.dispatchEvent(new Event('input'));
            }
            const box = entry.element;
            const content = entry.contentElement;
            const text = content.firstChild;
            const range = document.createRange();
            range.setStart(text, text.textContent.indexOf('TAIL'));
            range.setEnd(text, text.textContent.length);
            const tail = range.getBoundingClientRect();
            const bounds = box.getBoundingClientRect();
            const pageBounds = canvas.getBoundingClientRect();
            const style = getComputedStyle(box);
            return {
                fontSize: parseFloat(style.fontSize), width: bounds.width, height: bounds.height,
                boxClientWidth: box.clientWidth, contentClientWidth: content.clientWidth,
                contentScrollWidth: content.scrollWidth, paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight, textUnchanged: content.textContent === 'A TAIL',
                stylesheetApplied: style.boxSizing === 'border-box' && style.position === 'absolute',
                tailVisible: tail.left >= bounds.left - 0.5 && tail.right <= bounds.right + 0.5
                    && tail.top >= bounds.top - 0.5 && tail.bottom <= bounds.bottom + 0.5,
                withinPage: bounds.left >= pageBounds.left - 0.5 && bounds.right <= pageBounds.right + 0.5
                    && bounds.top >= pageBounds.top - 0.5 && bounds.bottom <= pageBounds.bottom + 0.5,
            };
        }, sample);
        await page.screenshot({ path: info.outputPath('fractional-textbox.png') });
        expect(result.stylesheetApplied).toBe(true);
        expect(result.textUnchanged).toBe(true);
        expect(Math.abs(result.width - sample.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(result.height - 40)).toBeLessThanOrEqual(1);
        expect(result.fontSize, JSON.stringify(result)).toBeCloseTo(13, 1);
        expect(result.tailVisible, JSON.stringify(result)).toBe(true);
        expect(result.withinPage).toBe(true);
    });
}
