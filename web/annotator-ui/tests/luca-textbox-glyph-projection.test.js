/** Independent native PDF glyph vectors and visual rectangles, without a browser layout substitute. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import fixtures from './fixtures/luca-textbox-glyph-truth.json';

const sourceRoot=join(dirname(fileURLToPath(import.meta.url)),'../src');
const read = name => {
    const path=join(sourceRoot,name),contents=readFileSync(path,'utf8');
    return name.endsWith('.js') ? `${contents}\n//# sourceURL=${pathToFileURL(path).href}` : contents;
};
const opened = [];
const text = 'AB complete synthetic explanation FULL_TAIL';
afterEach(() => {
    opened.splice(0).forEach(dom => dom.window.close());
    window.PdfPreviewModalTextbox?.destroy();
    document.head.querySelectorAll('[data-glyph-style]').forEach(style=>style.remove());
});

async function harness(fixture, scale = 1, modal = false, nativeRotation = 0) {
    const markup='<div id="pdfPreviewModal"><div id="pdfGradedCommentsList"></div>'
        + '<div id="pdfGradedContainer"><div class="pdf-page-wrapper"><canvas></canvas></div></div></div>';
    const dom=modal ? new JSDOM(markup,{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}) : null;
    if (dom) opened.push(dom);
    const w=dom ? dom.window : window, d=w.document;
    if (!modal) {
        vi.resetModules();
        d.body.innerHTML=markup;
        delete w.PdfPreviewModalTextbox;
    }
    const style=d.createElement('style'); style.dataset.glyphStyle='';
    style.textContent=read('annotator-ui.css'); d.head.append(style);
    const wrapper=d.querySelector('.pdf-page-wrapper'), canvas=wrapper.querySelector('canvas');
    [canvas.width,canvas.height]=fixture.page;
    Object.defineProperties(canvas, {
        offsetWidth:{value:Math.round(canvas.width*scale)}, offsetHeight:{value:Math.round(canvas.height*scale)},
    });
    const annotation={ type:'textbox',page_index:0,stable_id:'native-glyph-fixture',xref:12,
        rect:fixture.nativeRect,content:text,color:'blue',rotation:nativeRotation };
    if (modal) {
        w.bootstrap={Modal:{getInstance:()=>null}};
        w.PdfPreviewModalViewer={resolvePdfjsLib:()=>null};
        w.PdfPreviewModalDrawingCanvas={getActiveTool:()=> 'select',getActiveColor:()=>({rgb:[0,0,0]}),
            setMarkupMode(){},loadStrokesFromAnnotations(){},ensureCanvasForPage(){},redrawPage(){},
            hitTestStroke:()=>null,isDrawingActive:()=>false};
        for (const name of ['utils','annotation-helpers','rendering','modal-state','annotation-controller','textbox','markup-selection']) {
            w.eval(read(`pdf-preview-modal/${name}.js`));
        }
        w.eval(read('pdf-preview-modal.js'));
        const factory=w.PdfPreviewModalAnnotationController.createAnnotationController;
        w.PdfPreviewModalAnnotationController.createAnnotationController=options=> {
            options.setAnnotationsData({0:[annotation]}); return factory(options);
        };
        w.PdfPreviewModal.createPdfPreviewModal({assignmentId:'fixture-a',submissionId:'fixture-s',modeAdapter:{}});
        const matrix=fixture.transform;
        const viewport={scale:1,rotation:fixture.rotation,viewBox:fixture.viewBox,width:fixture.page[0],height:fixture.page[1],
            convertToViewportPoint:(x,y)=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]],
            convertToViewportRectangle(rect) {
                return [...this.convertToViewportPoint(rect[0],rect[1]),...this.convertToViewportPoint(rect[2],rect[3])];
            }};
        w.__pdfGradedViewer={getViewportForPage:()=>viewport};
    } else await import('../src/pdf-preview-modal/textbox.js');
    return {w,wrapper,boxes:w.PdfPreviewModalTextbox};
}

// Interpret computed CSS using the standard affine transform, independently of loader placement logic.
function geometry(w, element) {
    const style=w.getComputedStyle(element), transform=style.transform;
    let matrix=[1,0,0,1,0,0];
    if (transform && transform!=='none') {
        if (transform.startsWith('matrix(')) matrix=transform.slice(7,-1).split(',').map(Number);
        else {
            const angle=/^rotate\(([-\d.]+)deg\)$/.exec(transform);
            if (!angle) throw new Error(`Unsupported computed CSS transform: ${transform}`);
            const radians=Number(angle[1])*Math.PI/180;
            matrix=[Math.cos(radians),Math.sin(radians),-Math.sin(radians),Math.cos(radians),0,0];
        }
    }
    const width=parseFloat(style.width),height=parseFloat(style.height);
    const origin=(style.transformOrigin||'0 0').split(/\s+/).map(parseFloat);
    const [ox,oy]=origin, left=parseFloat(style.left),top=parseFloat(style.top);
    const points=[[0,0],[width,0],[width,height],[0,height]].map(([x,y])=>[
        left+ox+matrix[0]*(x-ox)+matrix[2]*(y-oy)+matrix[4],
        top+oy+matrix[1]*(x-ox)+matrix[3]*(y-oy)+matrix[5],
    ]);
    return {bounds:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),
        Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))],
    direction:[matrix[0],matrix[1]],style};
}

function assertNativeGeometry(w, entry, fixture, scale, direction=fixture.direction) {
    const actual=geometry(w,entry.element);
    actual.bounds.forEach((value,index)=>expect(Math.abs(value-fixture.visualRect[index]*scale)).toBeLessThanOrEqual(1));
    actual.direction.forEach((value,index)=>expect(value).toBeCloseTo(direction[index],5));
    expect(entry.contentElement.textContent).toContain('FULL_TAIL');
    expect(actual.style.position).toBe('absolute');
    expect(actual.style.boxSizing).toBe('border-box');
    expect(parseFloat(actual.style.fontSize)).toBeGreaterThan(0);
}

for (const fixture of fixtures) for (const scale of [0.5,1,1.5]) {
    it(`preserves native glyph geometry through edit/input/commit at ${fixture.rotation} degrees, scale ${scale}`,async()=> {
        const {w,wrapper,boxes}=await harness(fixture,scale);
        const [x,y,right,bottom]=fixture.visualRect;
        boxes.loadTextboxesFromAnnotations([{type:'textbox',pageIdx:0,annotationId:'native-glyph-fixture',
            content:text,color:'#0000ff',x,y,width:right-x,height:bottom-y,displayRotation:fixture.rotation}],[wrapper]);
        const entry=boxes.getPageTextboxes(0)[0];
        assertNativeGeometry(w,entry,fixture,scale);
        const color=w.getComputedStyle(entry.element).color;
        boxes.editTextbox(entry);
        entry.contentElement.dispatchEvent(new w.Event('input'));
        entry.contentElement.dispatchEvent(new w.Event('blur'));
        assertNativeGeometry(w,entry,fixture,scale);
        expect(w.getComputedStyle(entry.element).color).toBe(color);
        expect(entry.contentElement.textContent).toBe(text);
    });
}

for (const fixture of fixtures) for (const nativeRotation of [0,fixture.rotation]) {
    it(`real modal forwards page ${fixture.rotation}/native ${nativeRotation} glyph direction`,async()=> {
        const {w,boxes}=await harness(fixture,1,true,nativeRotation);
        const loader=vi.spyOn(boxes,'loadTextboxesFromAnnotations');
        w.PdfPreviewModal.__test.refreshMarkupFromAnnotations();
        expect(loader).toHaveBeenCalled();
        const descriptor=loader.mock.calls.at(-1)[0][0];
        expect(descriptor.displayRotation).toBe(nativeRotation===0 ? fixture.rotation : 0);
        const entry=boxes.getPageTextboxes(0)[0];
        assertNativeGeometry(w,entry,fixture,1,nativeRotation===0 ? fixture.direction : [1,0]);
        expect(descriptor.content).toBe(text);
    });
}
