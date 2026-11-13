/** L1d CSS component oracle: real layout is required to observe line clamping. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css = readFileSync(new URL('../../src/annotator-ui.css', import.meta.url), 'utf8');
const sentence = 'Complete synthetic feedback with the final explanation and its supporting detail.';
const long = Array.from({ length: 14 }, (_, i) => `Q1 sentence ${i}: ${sentence}`).join(' ') + ' L1D_Q1_TAIL_MARK';
const short = `Q2: ${sentence} L1D_Q2_TAIL_MARK`;

for (const [mode, marker] of [['preview-fullscreen', 'L1D_Q1_TAIL_MARK'], ['', 'L1D_Q1_TAIL_MARK'],
    ['preview-fullscreen', 'L1D_Q2_TAIL_MARK']]) {
    test(`feedback tail is visible without hover (${mode || 'normal'}, ${marker})`, async ({ page }) => {
        await page.setContent(`<div id="pdfPreviewModal" class="modal ${mode}" style="display:block">
            <div style="width:330px"><div class="annotation-content">${long}</div>
            <div class="annotation-content">${short}</div></div></div>`);
        await page.addStyleTag({ content: css });
        await page.mouse.move(1100, 850);
        const measured = await page.evaluate(marker => {
            const card = [...document.querySelectorAll('.annotation-content')].find(node => node.textContent.includes(marker));
            const text = [...card.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes(marker));
            const range = document.createRange();
            const offset = text.textContent.indexOf(marker);
            range.setStart(text, offset);
            range.setEnd(text, offset + marker.length);
            const tail = range.getBoundingClientRect();
            const bounds = card.getBoundingClientRect();
            return { stylesheetApplied: ['text', 'pointer'].includes(getComputedStyle(card).cursor),
                visible: tail.top >= bounds.top - 0.5 && tail.bottom <= bounds.bottom + 0.5,
                clientHeight: card.clientHeight, scrollHeight: card.scrollHeight };
        }, marker);
        expect(measured.stylesheetApplied, 'CSS must be applied or the oracle is vacuous').toBe(true);
        expect(measured.visible, JSON.stringify(measured)).toBe(true);
    });
}
