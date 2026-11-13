/** Actual selection drag must clamp a rotated textbox by its visual page footprint. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css=readFileSync(new URL('../../src/annotator-ui.css',import.meta.url),'utf8');
const textbox=readFileSync(new URL('../../src/pdf-preview-modal/textbox.js',import.meta.url),'utf8');
const selection=readFileSync(new URL('../../src/pdf-preview-modal/markup-selection.js',import.meta.url),'utf8');

for (const rotation of [0,90,270]) {
    test(`cross-page pointer drag remains inside the target page at ${rotation} degrees`,async({page},testInfo)=> {
        await page.setViewportSize({width:1900,height:1000});
        await page.setContent('<div id="pdfGradedContainer"></div>');
        await page.addStyleTag({content:css});
        await page.addScriptTag({content:textbox});
        await page.addScriptTag({content:selection});
        await page.evaluate(rotation=> {
            const container=document.getElementById('pdfGradedContainer');
            container.style.display='flex';container.style.gap='40px';
            const width=rotation?842:595,height=rotation?595:842;
            for (let index=0;index<2;index++) {
                const host=document.createElement('div');host.className='pdf-page-wrapper';host.dataset.pageNum=String(index+1);
                host.style.position='relative';host.style.width=`${width}px`;host.style.height=`${height}px`;host.style.flex='none';
                const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;host.append(canvas);container.append(host);
            }
            const hosts=[...container.children];
            const rectangle=rotation===90?[727,40,777,260]:rotation===270?[65,335,115,555]:[40,65,260,115];
            const [x,y,right,bottom]=rectangle;
            PdfPreviewModalTextbox.loadTextboxesFromAnnotations([{type:'textbox',pageIdx:0,annotationId:'drag-native',
                content:'FULL_TAIL',x,y,width:right-x,height:bottom-y,displayRotation:rotation}],hosts);
            const entry=PdfPreviewModalTextbox.getPageTextboxes(0)[0];
            PdfPreviewModalMarkupSelection.init();
            PdfPreviewModalMarkupSelection.onMoveCompleted=item=>{window.dragCompletion={pageIdx:item.pageIdx};};
            entry.element.addEventListener('pointerdown',event=> {
                event.preventDefault();event.stopImmediatePropagation();
                PdfPreviewModalMarkupSelection.startDrag('textbox',entry,0,hosts[0],event);
            },true);
            window.dragFixture={entry,hosts};
        },rotation);
        const start=await page.locator('.markup-textbox').boundingBox();
        const target=await page.locator('.pdf-page-wrapper').nth(1).boundingBox();
        await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
        await page.mouse.down();
        await page.mouse.move(target.x+target.width-1,target.y+target.height-1,{steps:8});
        await page.mouse.up();
        const result=await page.evaluate(()=> {
            const box=dragFixture.entry.element.getBoundingClientRect(),target=dragFixture.hosts[1].getBoundingClientRect();
            return {pageIdx:dragCompletion?.pageIdx,box:{left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.width,height:box.height},
                target:{left:target.left,top:target.top,right:target.right,bottom:target.bottom},
                text:dragFixture.entry.contentElement.textContent};
        });
        await testInfo.attach('boundary-metrics',{body:JSON.stringify(result),contentType:'application/json'});
        writeFileSync(testInfo.outputPath('boundary-metrics.json'),JSON.stringify(result,null,2));
        await page.screenshot({path:testInfo.outputPath('drag-boundary.png')});
        expect.soft(result.pageIdx).toBe(1);expect.soft(result.text).toBe('FULL_TAIL');
        expect.soft(result.box.left).toBeGreaterThanOrEqual(result.target.left-1);
        expect.soft(result.box.top).toBeGreaterThanOrEqual(result.target.top-1);
        expect.soft(result.box.right).toBeLessThanOrEqual(result.target.right+1);
        expect.soft(result.box.bottom).toBeLessThanOrEqual(result.target.bottom+1);
        expect.soft(result.box.width).toBeCloseTo(start.width,1);
        expect.soft(result.box.height).toBeCloseTo(start.height,1);
    });
}
