/** Actual selection drag must clamp a rotated textbox by its visual page footprint. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const css=readFileSync(new URL('../../src/annotator-ui.css',import.meta.url),'utf8');
const textbox=readFileSync(new URL('../../src/pdf-preview-modal/textbox.js',import.meta.url),'utf8');
const selection=readFileSync(new URL('../../src/pdf-preview-modal/markup-selection.js',import.meta.url),'utf8');

for (const rotation of [0,90,180,270]) {
    test(`same-page pointer drag preserves a ten-pixel visual delta at ${rotation} degrees`,async({page},testInfo)=> {
        await page.setContent('<div id="pdfGradedContainer"></div>');
        await page.addStyleTag({content:css});
        await page.addScriptTag({content:textbox});
        await page.addScriptTag({content:selection});
        await page.evaluate(rotation=> {
            const host=document.createElement('div');host.className='pdf-page-wrapper';host.dataset.pageNum='1';
            host.style.position='relative';host.style.width='300px';host.style.height='400px';
            const canvas=document.createElement('canvas');canvas.width=300;canvas.height=400;host.append(canvas);
            document.getElementById('pdfGradedContainer').append(host);
            const quarterTurn=rotation===90||rotation===270;
            PdfPreviewModalTextbox.loadTextboxesFromAnnotations([{type:'textbox',pageIdx:0,annotationId:'same-page-native',
                content:'FULL_TAIL',x:quarterTurn?220:60,y:40,width:quarterTurn?60:220,height:quarterTurn?220:50,
                displayRotation:rotation}],[host]);
            const entry=PdfPreviewModalTextbox.getPageTextboxes(0)[0];
            PdfPreviewModalMarkupSelection.init();
            PdfPreviewModalMarkupSelection.onMoveCompleted=item=>{window.dragCompletion={pageIdx:item.pageIdx};};
            entry.element.addEventListener('pointerdown',event=> {
                event.preventDefault();event.stopImmediatePropagation();
                PdfPreviewModalMarkupSelection.startDrag('textbox',entry,0,host,event);
            },true);
            window.dragFixture={entry,hosts:[host]};
        },rotation);
        const start=await page.locator('.markup-textbox').boundingBox();
        await page.mouse.move(start.x+start.width/2,start.y+start.height/2);
        await page.mouse.down();await page.mouse.move(start.x+start.width/2+10,start.y+start.height/2,{steps:3});await page.mouse.up();
        const result=await page.evaluate(()=> {
            const entry=dragFixture.entry,box=entry.element.getBoundingClientRect(),host=dragFixture.hosts[0].getBoundingClientRect();
            const range=document.createRange();range.selectNodeContents(entry.contentElement);const glyphs=range.getBoundingClientRect();
            return {pageIdx:dragCompletion?.pageIdx,text:entry.contentElement.textContent,
                box:{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom},
                host:{left:host.left,top:host.top,right:host.right,bottom:host.bottom},
                glyphs:{left:glyphs.left,top:glyphs.top,right:glyphs.right,bottom:glyphs.bottom}};
        });
        writeFileSync(testInfo.outputPath('samepage-metrics.json'),JSON.stringify({start,result},null,2));
        await page.screenshot({path:testInfo.outputPath('samepage-drag.png')});
        expect.soft(result.pageIdx).toBe(0);expect.soft(result.text).toBe('FULL_TAIL');
        expect.soft(result.box.x).toBeCloseTo(start.x+10,1);expect.soft(result.box.y).toBeCloseTo(start.y,1);
        expect.soft(result.box.width).toBeCloseTo(start.width,1);expect.soft(result.box.height).toBeCloseTo(start.height,1);
        expect.soft(result.box.right).toBeLessThanOrEqual(result.host.right+1);
        expect.soft(result.box.bottom).toBeLessThanOrEqual(result.host.bottom+1);
        expect.soft(result.glyphs.left).toBeGreaterThanOrEqual(result.box.x-1);
        expect.soft(result.glyphs.top).toBeGreaterThanOrEqual(result.box.y-1);
        expect.soft(result.glyphs.right).toBeLessThanOrEqual(result.box.right+1);
        expect.soft(result.glyphs.bottom).toBeLessThanOrEqual(result.box.bottom+1);
    });
}

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
