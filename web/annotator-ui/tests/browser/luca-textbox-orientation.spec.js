/** Native FreeText rotate=0 follows page rotation; the DOM must preserve its glyph direction. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css = readFileSync(new URL('../../src/annotator-ui.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../src/pdf-preview-modal/textbox.js', import.meta.url), 'utf8');
// Independent MuPDF native rect (40,65,260,115), projected into the rotated page.
const fixtures = [
    { rotation: 0, rect: [40,65,260,115], page: [595,842], direction: [1,0] },
    { rotation: 90, rect: [727,40,777,260], page: [842,595], direction: [0,1] },
    { rotation: 180, rect: [335,727,555,777], page: [595,842], direction: [-1,0] },
    { rotation: 270, rect: [65,335,115,555], page: [842,595], direction: [0,-1] },
];

for (const fixture of fixtures) for (const scale of [0.5,1,1.5]) {
    test(`legacy native glyphs at ${fixture.rotation} degrees and scale ${scale}`, async ({ page }, testInfo) => {
        await page.setContent('<div class="pdf-page-wrapper" id="component-page"></div>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: script });
        const result = await page.evaluate(({ fixture, scale }) => {
            const host = document.getElementById('component-page');
            host.style.position = 'relative';
            host.style.width = `${fixture.page[0]*scale}px`;
            host.style.height = `${fixture.page[1]*scale}px`;
            const canvas = document.createElement('canvas');
            [canvas.width,canvas.height] = fixture.page;
            canvas.style.width = `${fixture.page[0]*scale}px`;
            canvas.style.height = `${fixture.page[1]*scale}px`;
            host.append(canvas);
            const [x,y,right,bottom] = fixture.rect;
            const text = 'AB_FULL_TAIL';
            PdfPreviewModalTextbox.loadTextboxesFromAnnotations([{ type:'textbox', pageIdx:0,
                annotationId:'native-oriented', content:text, x,y,width:right-x,height:bottom-y,
                displayRotation:fixture.rotation }], [host]);
            const entry = PdfPreviewModalTextbox.getPageTextboxes(0)[0];
            const bounds = entry.element.getBoundingClientRect();
            const pageBounds = canvas.getBoundingClientRect();
            const node = [...entry.contentElement.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
            const range = document.createRange();
            function character(index) {
                range.setStart(node,index); range.setEnd(node,index+1);
                const rect = range.getBoundingClientRect();
                return [rect.x+rect.width/2,rect.y+rect.height/2];
            }
            const a=character(0),b=character(1),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
            range.setStart(node,text.indexOf('FULL_TAIL')); range.setEnd(node,text.length);
            const tail=range.getBoundingClientRect();
            return { stylesheetApplied:getComputedStyle(entry.element).boxSizing==='border-box',
                direction:[(b[0]-a[0])/length,(b[1]-a[1])/length],
                actual:[bounds.left-pageBounds.left,bounds.top-pageBounds.top,bounds.right-pageBounds.left,bounds.bottom-pageBounds.top],
                expected:fixture.rect.map(value=>value*scale), text:entry.contentElement.textContent,
                tailVisible:tail.left>=bounds.left-0.5 && tail.right<=bounds.right+0.5
                    && tail.top>=bounds.top-0.5 && tail.bottom<=bounds.bottom+0.5,
                withinPage:bounds.left>=pageBounds.left-0.5 && bounds.right<=pageBounds.right+0.5
                    && bounds.top>=pageBounds.top-0.5 && bounds.bottom<=pageBounds.bottom+0.5 };
        }, { fixture, scale });
        await testInfo.attach('native-dom-direction', { body:JSON.stringify(result),contentType:'application/json' });
        await page.screenshot({ path:testInfo.outputPath('glyph-direction.png') });
        expect.soft(result.stylesheetApplied).toBe(true);
        expect.soft(result.text).toBe('AB_FULL_TAIL');
        result.actual.forEach((value,index)=>expect.soft(Math.abs(value-result.expected[index])).toBeLessThanOrEqual(1));
        expect.soft(result.tailVisible).toBe(true);
        expect.soft(result.withinPage).toBe(true);
        result.direction.forEach((value,index)=>expect.soft(value).toBeCloseTo(fixture.direction[index],1));
    });
}
