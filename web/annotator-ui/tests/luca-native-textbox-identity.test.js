import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeWireCases } from './fixtures/native-wire-contract.fixture.js';
import glyphFixtures from './fixtures/luca-textbox-glyph-truth.json';

const load = (name) => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../src', name);
  return import(pathToFileURL(path).href);
};

describe('Luca F1 scoped native identity through actual textbox callbacks', () => {
  let descriptors;
  let w;
  let d;
  let boxes;
  let selection;
  let wrapper;
  let adapter;
  let helpers;
  let tool;
  let controller;
  let annotations;
  let modal;
  let hostHelpers;
  const annotation = {
    stable_id: 'native-duplicate', has_explicit_stable_id: false, xref: 12, page_index: 0, type: 'textbox',
    etag: 'fixture-own-text',
    content: 'Check units', rect: [80, 100, 180, 128], color: 'amber',
  };

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal') || key.startsWith('__pdf')) delete window[key];
    }
    w = window;
    d = document;
    descriptors = new Map(['contentEditable','isContentEditable','setPointerCapture','releasePointerCapture',
      'offsetWidth','clientWidth','offsetHeight','clientHeight','offsetLeft','offsetTop','getBoundingClientRect']
      .map(key => [key,Object.getOwnPropertyDescriptor(HTMLElement.prototype,key)]));
    d.body.innerHTML = `
      <div id="pdfPreviewModal"><button class="js-toggle-markup">Markup</button>
        <div id="pdfGradedCommentsList"></div>
        <div id="pdfGradedContainer"><div class="pdf-page-wrapper" data-page-num="1">
          <canvas width="600" height="800"></canvas><div class="pdf-annotation-overlay"></div>
        </div></div>
      </div>`;
    w.bootstrap = { Modal: { getInstance: () => null } };
    // jsdom lacks the browser's contentEditable reflection and pointer capture.
    Object.defineProperty(w.HTMLElement.prototype, 'contentEditable', {
      get() { return this.getAttribute('contenteditable') || 'inherit'; },
      set(value) { this.setAttribute('contenteditable', value); },
      configurable: true,
    });
    Object.defineProperty(w.HTMLElement.prototype, 'isContentEditable', {
      get() { return this.getAttribute('contenteditable') === 'true'; }, configurable: true,
    });
    w.HTMLElement.prototype.setPointerCapture = () => {};
    w.HTMLElement.prototype.releasePointerCapture = () => {};
    const width = (el) => parseFloat(el.style.width) || (el.classList.contains('markup-textbox-measure') ? 100 : 600);
    const height = (el) => parseFloat(el.style.height) || (el.classList.contains('markup-textbox-measure') ? 28 : 800);
    for (const prop of ['offsetWidth', 'clientWidth']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return Math.round(width(this)); }, configurable: true });
    for (const prop of ['offsetHeight', 'clientHeight']) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return Math.round(height(this)); }, configurable: true });
    for (const [prop, style] of [['offsetLeft', 'left'], ['offsetTop', 'top']]) Object.defineProperty(w.HTMLElement.prototype, prop, { get() { return Math.round(parseFloat(this.style[style]) || 0); }, configurable: true });
    w.HTMLElement.prototype.getBoundingClientRect = function () {
      const left = parseFloat(this.style.left) || 0;
      const top = parseFloat(this.style.top) || 0;
      const angle=/rotate\(([-\d.]+)deg\)/.exec(this.style.transform);
      if (angle) {
        const radians=Number(angle[1])*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
        const points=[[0,0],[width(this),0],[width(this),height(this)],[0,height(this)]]
          .map(([x,y])=>[left+c*x-s*y,top+s*x+c*y]);
        const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
        const x=Math.min(...xs),y=Math.min(...ys),right=Math.max(...xs),bottom=Math.max(...ys);
        return {left:x,top:y,x,y,right,bottom,width:right-x,height:bottom-y};
      }
      return { left, top, x:left,y:top,width: width(this), height: height(this), right: left + width(this), bottom: top + height(this) };
    };
    w.PdfPreviewModalViewer = { resolvePdfjsLib: () => null };
    tool = 'select';
    // Raster drawing is unrelated; keep actual textbox, selection, modal and CRUD paths.
    w.PdfPreviewModalDrawingCanvas = {
      getActiveTool: () => tool, getActiveColor: () => ({ rgb: [0, 0, 0] }),
      setMarkupMode() {}, loadStrokesFromAnnotations() {}, ensureCanvasForPage() {}, redrawPage() {},
      hitTestStroke: () => null, isDrawingActive: () => false,
    };
    for (const name of ['utils', 'annotation-helpers', 'rendering', 'modal-state', 'annotation-controller', 'textbox', 'markup-selection']) {
      await load(`pdf-preview-modal/${name}.js`);
    }
    await load('pdf-preview-modal.js');
    const factory = w.PdfPreviewModalAnnotationController.createAnnotationController;
    w.PdfPreviewModalAnnotationController.createAnnotationController = (options) => {
      hostHelpers = options.helpers;
      annotations = options.getAnnotationsData;
      options.setAnnotationsData({ 0: [{ ...annotation }], 1: [{ ...annotation, xref: 42, page_index: 1, content: 'Second page synthetic text' }] });
      controller = factory(options);
      return controller;
    };
    adapter = {
      updateAnnotation: vi.fn(async (_assignment, _submission, _id, body) => ({ success: true, annotation: { ...annotation, ...body, xref: 84 } })),
      createAnnotation: vi.fn(async (_a,_s,body) => ({ success: true, annotation: { ...annotation, ...body, xref: 91 } })),
      deleteAnnotation: vi.fn(async () => ({ success: true })),
    };
    modal = w.PdfPreviewModal.createPdfPreviewModal({ assignmentId: 'a', submissionId: 's', modeAdapter: adapter });
    const viewport = {
      width: 600, height: 800, scale: 1,
      convertToPdfPoint: (x, y) => [x, y], convertToViewportPoint: (x, y) => [x, y],
      convertToViewportRectangle: (rect) => rect,
    };
    w.__pdfGradedViewer = { getViewportForPage: () => viewport };
    const firstWrapper = d.querySelector('.pdf-page-wrapper');
    const secondWrapper = firstWrapper.cloneNode(true);
    secondWrapper.dataset.pageNum = '2';
    firstWrapper.parentElement.append(secondWrapper);
    boxes = w.PdfPreviewModalTextbox;
    selection = w.PdfPreviewModalMarkupSelection;
    helpers = w.PdfPreviewModal.__test;
    wrapper = d.querySelector('.pdf-page-wrapper');
    helpers.refreshMarkupFromAnnotations();
    d.querySelector('.js-toggle-markup').click();
    expect(boxes.getPageTextboxes(0)).toHaveLength(1);
  });

  afterEach(() => {
    modal?.destroy();
    for (const [key,descriptor] of descriptors || []) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype,key,descriptor);
      else delete HTMLElement.prototype[key];
    }
    vi.restoreAllMocks();
  });


  const settle = () => new Promise(resolve => w.setTimeout(resolve, 80));

  function loadGeometry(fixture,nativeRotation=0,scale=1,rect=fixture.nativeRect) {
    delete annotations()[1];
    const target={...annotation,stable_id:'geometry-fixture',has_explicit_stable_id:true,
      rotation:nativeRotation,rect:[...rect]};
    annotations()[0]=[target];
    const canvas=wrapper.querySelector('canvas');
    [canvas.width,canvas.height]=fixture.page;
    canvas.style.width=`${fixture.page[0]*scale}px`;canvas.style.height=`${fixture.page[1]*scale}px`;
    const m=fixture.transform,det=m[0]*m[3]-m[1]*m[2];
    const point=(x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
    const viewport={scale:1,rotation:fixture.rotation,viewBox:fixture.viewBox,
      width:fixture.page[0],height:fixture.page[1],convertToViewportPoint:point,
      convertToViewportRectangle:([x0,y0,x1,y1])=>[...point(x0,y0),...point(x1,y1)],
      convertToPdfPoint:(x,y)=>[(m[3]*(x-m[4])-m[2]*(y-m[5]))/det,
        (-m[1]*(x-m[4])+m[0]*(y-m[5]))/det]};
    w.__pdfGradedViewer={getViewportForPage:()=>viewport};
    adapter.updateAnnotation.mockImplementation(async(_a,_s,_wire,body)=>({success:true,
      annotation:{...target,content:body.content??target.content,xref:84}}));
    helpers.refreshMarkupFromAnnotations();
    return boxes.getPageTextboxes(0)[0];
  }

  const geometryCases=glyphFixtures.flatMap(fixture=>[...new Set([0,fixture.rotation])]
    .map(nativeRotation=>({fixture,nativeRotation})));
  it.each(['rgb(0, 0, 255)',[0,0,255],{name:'blue',rgb:[0,0,255]}].map(color=>({color})))(
    'existing blue textbox content-only callback omits native style and geometry $color',async({color})=> {
      annotations()[0][0].stroke_color_rgb=[0,0,255];annotations()[0][0].color='blue';
      helpers.refreshMarkupFromAnnotations();
      const entry=boxes.getPageTextboxes(0)[0];entry.color=color;
      boxes.editTextbox(entry);entry.contentElement.textContent='Blue native content edited FULL_TAIL';
      entry.contentElement.dispatchEvent(new w.Event('input'));entry.contentElement.dispatchEvent(new w.Event('blur'));
      await settle();
      expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
      expect(adapter.updateAnnotation.mock.calls[0][3]).toEqual({content:'Blue native content edited FULL_TAIL'});
    },
  );

  const fitScales=[
    {sourceCss:0.5,targetCss:1.5,sourceRender:1,targetRender:2},
    {sourceCss:1.5,targetCss:0.5,sourceRender:2,targetRender:1},
    {sourceCss:0.8,targetCss:1.2,sourceRender:1.5,targetRender:2},
    {sourceCss:1,targetCss:1,sourceRender:1,targetRender:2},
    {sourceCss:0.5,targetCss:1.5,sourceRender:1,targetRender:2,pointerDrop:true},
    {sourceCss:1.5,targetCss:0.5,sourceRender:2,targetRender:1,pointerDrop:true},
  ];
  it.each(['rgb(0, 0, 255)',[0,0,255],{name:'blue',rgb:[0,0,255]}].map(color=>({color})))(
    'new textbox callback retains selected blue palette color $color',async({color})=> {
      const entry=boxes.getPageTextboxes(0)[0];entry.annotationId=null;entry.color=color;
      entry.content='New blue synthetic FULL_TAIL';boxes.onTextboxCommitted(entry);await settle();
      expect(adapter.createAnnotation).toHaveBeenCalledOnce();
      expect(adapter.createAnnotation.mock.calls[0][2].stroke_color_rgb).toEqual([0,0,255]);
    },
  );
  it.each(glyphFixtures.flatMap(fixture=>fitScales.map(scales=>({fixture,...scales}))))(
    'actual cross-page move keeps PDF size at rotation $fixture.rotation CSS $sourceCss/$targetCss render $sourceRender/$targetRender pointer $pointerDrop',
    async({fixture,sourceCss,targetCss,sourceRender,targetRender,pointerDrop})=> {
      delete annotations()[1];
      const target={...annotation,rect:[40,65,190,115],rotation:0};annotations()[0]=[target];
      const hosts=[...d.querySelectorAll('.pdf-page-wrapper')];
      const viewport=(render)=> {
        const m=fixture.transform.map(value=>value*render),det=m[0]*m[3]-m[1]*m[2];
        const point=(x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
        return {rotation:fixture.rotation,scale:render,viewBox:fixture.viewBox,
          width:fixture.page[0]*render,height:fixture.page[1]*render,
          convertToViewportPoint:point,convertToViewportRectangle:([x0,y0,x1,y1])=>[...point(x0,y0),...point(x1,y1)],
          convertToPdfPoint:(x,y)=>[(m[3]*(x-m[4])-m[2]*(y-m[5]))/det,(-m[1]*(x-m[4])+m[0]*(y-m[5]))/det]};
      };
      const viewports=[viewport(sourceRender),viewport(targetRender)];
      for(let index=0;index<2;index++) {
        const css=index===0?sourceCss:targetCss,render=index===0?sourceRender:targetRender;
        const canvas=hosts[index].querySelector('canvas');
        canvas.width=fixture.page[0]*render;canvas.height=fixture.page[1]*render;
        canvas.style.width=`${fixture.page[0]*css}px`;canvas.style.height=`${fixture.page[1]*css}px`;
        hosts[index].style.width=canvas.style.width;hosts[index].style.height=canvas.style.height;
      }
      w.__pdfGradedViewer={getViewportForPage:page=>viewports[page-1]};
      helpers.refreshMarkupFromAnnotations();
      const entry=boxes.getPageTextboxes(0)[0];
      const beforeAngle=entry.element.style.transform;
      adapter.updateAnnotation.mockImplementation(async(_a,_s,_wire,body)=>({success:true,annotation:{...target,...body,xref:84}}));
      if(pointerDrop) {
        for(const host of hosts) {
          let layer=host.querySelector('.textbox-layer');
          if(!layer){layer=d.createElement('div');layer.className='textbox-layer';host.append(layer);}
          layer.style.width=host.style.width;layer.style.height=host.style.height;
        }
        const originalRect=HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){
          const rect=originalRect.call(this),offset=this.closest('.pdf-page-wrapper')?.dataset.pageNum==='2'?1000:0;
          return {...rect,left:rect.left+offset,right:rect.right+offset,x:rect.left+offset};
        });
        let moved;
        const callback=selection.onMoveCompleted;
        selection.onMoveCompleted=async item=>{moved=item.entry.element.getBoundingClientRect();return callback(item);};
        const before=entry.element.getBoundingClientRect();
        const event=(type,x,y)=>{const result=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(result,'pointerId',{value:1});return result;};
        const down=event('pointerdown',before.left+before.width/2,before.top+before.height/2);
        Object.defineProperty(down,'target',{value:entry.element});selection.startDrag('textbox',entry,0,hosts[0],down);
        const overlay=d.querySelector('.markup-selection-overlay, .markup-selection');
        const bounds=hosts[1].getBoundingClientRect();
        overlay.dispatchEvent(event('pointermove',bounds.right-1,bounds.bottom-1));
        overlay.dispatchEvent(event('pointerup',bounds.right-1,bounds.bottom-1));
        await settle();
        // Browser canvas offsetWidth is integer-valued; retain the existing
        // component-oracle one-pixel containment tolerance at fractional zoom.
        expect.soft(moved.left).toBeGreaterThanOrEqual(bounds.left-1);
        expect.soft(moved.top).toBeGreaterThanOrEqual(bounds.top-1);
        expect.soft(moved.right).toBeLessThanOrEqual(bounds.right+1);
        expect.soft(moved.bottom).toBeLessThanOrEqual(bounds.bottom+1);
      } else {
        boxes.moveTextboxToPage(entry,1,hosts[1],25,35);
        await selection.onMoveCompleted({type:'textbox',pageIdx:1,sourcePageIdx:0,entry});
      }
      expect(entry.element.style.transform).toBe(beforeAngle);
      expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
      const rect=adapter.updateAnnotation.mock.calls[0][3].rect;
      expect.soft(rect[2]-rect[0]).toBeCloseTo(150,0);
      expect.soft(rect[3]-rect[1]).toBeCloseTo(50,0);
    },
  );

  it.each(geometryCases)('content-only actual save retains PDF rect at page $fixture.rotation/native $nativeRotation',async({fixture,nativeRotation})=> {
    const entry=loadGeometry(fixture,nativeRotation);
    boxes.editTextbox(entry);
    entry.contentElement.textContent='Content-only edit FULL_TAIL';
    entry.contentElement.dispatchEvent(new w.Event('input'));
    entry.contentElement.dispatchEvent(new w.Event('blur'));
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    const body=adapter.updateAnnotation.mock.calls[0][3];
    expect(body).not.toHaveProperty('rect');expect(body).not.toHaveProperty('stroke_color_rgb');
    expect(body).not.toHaveProperty('color');
    expect(annotations()[0][0].rect).toEqual([40,65,260,115]);
  });

  it.each([0.5,1,1.5])('fractional content-only save retains exact declared native geometry at scale %s',async scale=> {
    const entry=loadGeometry(glyphFixtures[0],0,scale,[40.5,65.25,260.75,115.5]);
    boxes.editTextbox(entry);
    entry.contentElement.textContent='Fractional geometry unchanged FULL_TAIL';
    entry.contentElement.dispatchEvent(new w.Event('input'));
    entry.contentElement.dispatchEvent(new w.Event('blur'));
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    const body=adapter.updateAnnotation.mock.calls[0][3];
    expect(body).not.toHaveProperty('rect');expect(body).not.toHaveProperty('stroke_color_rgb');
    expect(body).not.toHaveProperty('color');
    expect(annotations()[0][0].rect).toEqual([40.5,65.25,260.75,115.5]);
  });

  it('legacy public textbox entries without declared CSS geometry use their browser offsets',()=> {
    const element=d.createElement('div');element.className='markup-textbox';wrapper.append(element);
    Object.defineProperties(element,{offsetLeft:{value:11},offsetTop:{value:22},
      offsetWidth:{value:123},offsetHeight:{value:45}});
    element.getBoundingClientRect=()=>({left:11,top:22,right:134,bottom:67,width:123,height:45});
    expect(boxes.getTextboxCanvasRect({element},wrapper)).toEqual([11,22,134,67]);
  });

  it.each(geometryCases)('cross-page DOM move preserves visual placement at page $fixture.rotation/native $nativeRotation',({fixture,nativeRotation})=> {
    const entry=loadGeometry(fixture,nativeRotation);
    const before=entry.element.getBoundingClientRect();
    const target=d.querySelectorAll('.pdf-page-wrapper')[1],canvas=target.querySelector('canvas');
    [canvas.width,canvas.height]=fixture.page;
    canvas.style.width=`${fixture.page[0]}px`;canvas.style.height=`${fixture.page[1]}px`;
    boxes.moveTextboxToPage(entry,1,target,30,60);
    const after=entry.element.getBoundingClientRect();
    expect(after.left).toBeCloseTo(30,5);expect(after.top).toBeCloseTo(60,5);
    expect(after.width).toBeCloseTo(before.width,5);expect(after.height).toBeCloseTo(before.height,5);
    expect(after.right).toBeLessThanOrEqual(fixture.page[0]);
    expect(after.bottom).toBeLessThanOrEqual(fixture.page[1]);
    expect(boxes.getPageTextboxes(1)).toContain(entry);
  });

  it.each([0,90,270])('actual selection pointer drop clamps the visual textbox footprint at page %s',rotation=> {
    const fixture=glyphFixtures.find(item=>item.rotation===rotation),entry=loadGeometry(fixture);
    const hosts=[...d.querySelectorAll('.pdf-page-wrapper')];
    for(const host of hosts) {
      host.style.width=`${fixture.page[0]}px`;host.style.height=`${fixture.page[1]}px`;
      const canvas=host.querySelector('canvas');[canvas.width,canvas.height]=fixture.page;
      canvas.style.width=host.style.width;canvas.style.height=host.style.height;
      let layer=host.querySelector('.textbox-layer');
      if(!layer){layer=d.createElement('div');layer.className='textbox-layer';host.append(layer);}
      layer.style.width=host.style.width;layer.style.height=host.style.height;
    }
    const originalRect=HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){
      const rect=originalRect.call(this),host=this.closest('.pdf-page-wrapper');
      const offset=host?.dataset.pageNum==='2'?1000:0;
      return {...rect,left:rect.left+offset,right:rect.right+offset,x:rect.left+offset};
    });
    const before=entry.element.getBoundingClientRect();
    const event=(type,x,y)=> {
      const value=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
      Object.defineProperty(value,'pointerId',{value:1});return value;
    };
    selection.onMoveCompleted=vi.fn();
    const down=event('pointerdown',before.left+before.width/2,before.top+before.height/2);
    Object.defineProperty(down,'target',{value:entry.element});
    selection.startDrag('textbox',entry,0,hosts[0],down);
    const overlay=d.querySelector('.markup-selection-overlay, .markup-selection');
    expect(overlay).not.toBeNull();
    const x=1000+fixture.page[0]-1,y=fixture.page[1]-1;
    overlay.dispatchEvent(event('pointermove',x,y));overlay.dispatchEvent(event('pointerup',x,y));
    expect(selection.onMoveCompleted).toHaveBeenCalledOnce();
    expect(entry.pageIdx).toBe(1);
    const after=entry.element.getBoundingClientRect();
    expect(after.left).toBeGreaterThanOrEqual(1000);expect(after.top).toBeGreaterThanOrEqual(0);
    expect(after.right).toBeLessThanOrEqual(1000+fixture.page[0]+0.01);
    expect(after.bottom).toBeLessThanOrEqual(fixture.page[1]+0.01);
    expect(after.width).toBeCloseTo(before.width,5);expect(after.height).toBeCloseTo(before.height,5);
  });

  it.each([0,90,180,270])('actual same-page pointer drag preserves the visual delta at page %s', async rotation=> {
    const fixture=glyphFixtures.find(item=>item.rotation===rotation),entry=loadGeometry(fixture);
    wrapper.style.width=`${fixture.page[0]}px`;wrapper.style.height=`${fixture.page[1]}px`;
    const layer=entry.element.parentElement;
    layer.style.width=wrapper.style.width;layer.style.height=wrapper.style.height;
    const before=entry.element.getBoundingClientRect();
    const event=(type,x,y)=> {
      const value=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
      Object.defineProperty(value,'pointerId',{value:1});return value;
    };
    const x=before.left+before.width/2,y=before.top+before.height/2;
    const down=event('pointerdown',x,y);Object.defineProperty(down,'target',{value:entry.element});
    selection.startDrag('textbox',entry,0,wrapper,down);
    const overlay=d.querySelector('.markup-selection-overlay, .markup-selection');
    overlay.dispatchEvent(event('pointermove',x+10,y));overlay.dispatchEvent(event('pointerup',x+10,y));
    await settle();
    const after=entry.element.getBoundingClientRect();
    expect.soft(after.left).toBeCloseTo(before.left+10,5);
    expect.soft(after.top).toBeCloseTo(before.top,5);
    expect.soft(after.width).toBeCloseTo(before.width,5);
    expect.soft(after.height).toBeCloseTo(before.height,5);
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    const viewport=w.__pdfGradedViewer.getViewportForPage(1);
    const a=viewport.convertToPdfPoint(before.left+10,before.top);
    const b=viewport.convertToPdfPoint(before.right+10,before.bottom);
    const expected=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
    adapter.updateAnnotation.mock.calls[0][3].rect.forEach((value,index)=>expect.soft(value).toBeCloseTo(expected[index],5));
  });

  async function restartWithoutHelperModule() {
    const viewer=w.__pdfGradedViewer;
    modal.destroy();
    delete w.PdfPreviewModalAnnotationHelpers;
    vi.resetModules();
    await load('pdf-preview-modal.js');
    modal=w.PdfPreviewModal.createPdfPreviewModal({assignmentId:'a',submissionId:'s',modeAdapter:adapter});
    w.__pdfGradedViewer=viewer;
    helpers=w.PdfPreviewModal.__test;
  }

  it.each(nativeWireCases)('standalone host applies the same native/legacy wire contract %j', async(input,expected)=> {
    await restartWithoutHelperModule();
    expect(w.PdfPreviewModalAnnotationHelpers).toBeUndefined();
    const original={...input};
    expect(hostHelpers.buildApiAnnotationIdentifier(input)).toBe(expected);
    expect(input).toEqual(original);
  });

  it.each([
    [{ stable_id:'id:foo',has_explicit_stable_id:false },'xref:12|id:id:foo'],
    [{ stable_id:'xref:123',has_explicit_stable_id:false },'xref:12|id:xref:123'],
    [{ stable_id:'native/path',has_explicit_stable_id:false },'xref:12'],
    [{ stable_id:'123',has_explicit_stable_id:false },'xref:12|id:123'],
    [{ stable_id:'explicit-current',has_explicit_stable_id:true },'explicit-current'],
    [{ stable_id:'legacy-current',has_explicit_stable_id:undefined },'legacy-current'],
    [{ stable_id:null,stableId:'camel-native',id:'camel-native',has_explicit_stable_id:false },'xref:12|id:camel-native'],
    [{ stable_id:null,id:'xref:12|id:wire-native',has_explicit_stable_id:false },'xref:12|id:wire-native'],
    [{ stable_id:null,id:'wire-legacy',has_explicit_stable_id:undefined },'wire-legacy'],
  ])('standalone host without the helper module saves the intended native/legacy target %j', async (identity,expected) => {
    await restartWithoutHelperModule();
    delete annotations()[1];
    const target={...annotation,...identity,content:'Standalone target'};
    annotations()[0]=[target];
    adapter.updateAnnotation.mockImplementation(async(_a,_s,wire,body)=> {
      if (wire!==expected) throw new Error('Standalone host selected an unintended target');
      return {success:true,annotation:{...target,...body,xref:84}};
    });
    helpers.refreshMarkupFromAnnotations();
    const entry=boxes.getPageTextboxes(0)[0];
    expect(entry.content).toBe('Standalone target');
    entry.content='Standalone target saved in full';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe(expected);
    expect(annotations()[0]).toHaveLength(1);
    expect(annotations()[0][0].content).toBe(entry.content);
  });

  it('loader preserves different wire identities for matching native IDs on different pages', () => {
    expect(boxes.getPageTextboxes(0)[0].annotationId).toBe('xref:12|id:native-duplicate');
    expect(boxes.getPageTextboxes(1)[0].annotationId).toBe('xref:42|id:native-duplicate');
  });

  it.each([
    [{stable_id:'id:foo',has_explicit_stable_id:false},'xref:12|id:id:foo'],
    [{stable_id:null,stableId:'camel-move',id:'camel-move',has_explicit_stable_id:false},'xref:12|id:camel-move'],
  ])('actual selection move preserves typed native metadata %j',async(identity,expected)=> {
    delete annotations()[1];
    const target={...annotation,...identity};
    annotations()[0]=[target];
    helpers.refreshMarkupFromAnnotations();
    adapter.updateAnnotation.mockImplementation(async(_a,_s,wire,body)=> {
      if(wire!==expected) throw new Error('Move selected an unintended native target');
      return {success:true,annotation:{...target,...body,xref:84}};
    });
    const entry=boxes.getPageTextboxes(0)[0];
    boxes.moveTextbox(entry,12,8);
    await selection.onMoveCompleted({type:'textbox',pageIdx:0,entry});
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe(expected);
    expect(annotations()[0]).toHaveLength(1);
    expect(annotations()[0][0].xref).toBe(84);
    expect(entry.annotationId).toBe(expected.replace('xref:12','xref:84'));
  });

  it.each([
    [{stable_id:'new-stroke',has_explicit_stable_id:true},'new-stroke'],
    [{stable_id:null,stableId:'native-stroke',id:'native-stroke',has_explicit_stable_id:false},'xref:91|id:native-stroke'],
  ])('actual stroke creation retains returned typed identity %j',async(identity,expected)=> {
    adapter.createAnnotation.mockImplementation(async(_a,_s,body)=>({success:true,
      annotation:{...body,...identity,type:'drawing',xref:91}}));
    const stroke={pageIdx:0,points:[{x:12,y:24},{x:40,y:60}],style:'pen',strokeWidth:2,
      opacity:1,color:{rgb:[0,0,1]}};
    w.PdfPreviewModalDrawingCanvas.onStrokeComplete(0,stroke);
    await settle();
    expect(adapter.createAnnotation).toHaveBeenCalledOnce();
    expect(stroke.annotationId).toBe(expected);
    expect(annotations()[0].filter(item=>item.xref===91)).toHaveLength(1);
    expect(helpers.getUndoStacks().local.at(-1).annotationId).toBe(expected);
  });

  it('saving the second same-page native duplicate preserves the first annotation', async () => {
    delete annotations()[1];
    annotations()[0].push({ ...annotation, xref: 42, content: 'Second same-page text' });
    helpers.refreshMarkupFromAnnotations();
    const target = boxes.getPageTextboxes(0).find(entry => entry.annotationId === 'xref:42|id:native-duplicate');
    expect(target).toBeDefined();
    target.content = 'Only second native annotation edited';
    boxes.onTextboxCommitted(target);
    await settle();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(entry => entry.xref === 12)).toMatchObject({ content: 'Check units' });
    expect(annotations()[0].find(entry => entry.xref === 84)).toMatchObject({ content: target.content });
  });

  it('editing explicit shared-id never upgrades its bare wire to the colliding native xref',async()=> {
    const native={...annotation,stable_id:'shared-id',xref:12,content:'Native collision unchanged'};
    const explicit={...annotation,stable_id:'shared-id',xref:99,has_explicit_stable_id:true,
      content:'Explicit collision target'};
    delete annotations()[1];
    annotations()[0]=[native,explicit];
    adapter.updateAnnotation.mockImplementation(async(_a,_s,_wire,body)=>({success:true,
      annotation:{...explicit,...body,xref:100}}));
    helpers.refreshMarkupFromAnnotations();
    const entry=boxes.getPageTextboxes(0).find(item=>item.content==='Explicit collision target');
    expect(entry).toBeDefined();
    entry.content='Only explicit collision edited';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('shared-id');
    expect(annotations()[0].find(item=>item.xref===12)).toMatchObject(native);
  });

  it('editing explicit shared-id on another page never selects the earlier native collision',async()=> {
    const native={...annotation,stable_id:'shared-id',xref:12,content:'Earlier native unchanged'};
    const explicit={...annotation,stable_id:'shared-id',xref:99,page_index:1,has_explicit_stable_id:true,
      content:'Later-page explicit target'};
    annotations()[0]=[native];annotations()[1]=[explicit];
    adapter.updateAnnotation.mockImplementation(async(_a,_s,_wire,body)=>({success:true,
      annotation:{...explicit,...body,xref:100}}));
    helpers.refreshMarkupFromAnnotations();
    const entry=boxes.getPageTextboxes(1)[0];
    expect(entry.content).toBe('Later-page explicit target');
    entry.content='Only later-page explicit edited';
    boxes.onTextboxCommitted(entry);await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('shared-id');
    expect(annotations()[0][0]).toMatchObject(native);
  });

  it('deleting explicit shared-id preserves the colliding native row during local cleanup',async()=> {
    const native={...annotation,stable_id:'shared-id',xref:12,content:'Native collision unchanged'};
    const explicit={...annotation,stable_id:'shared-id',xref:99,has_explicit_stable_id:true,
      content:'Explicit collision target'};
    delete annotations()[1];
    annotations()[0]=[explicit,native];
    helpers.refreshMarkupFromAnnotations();
    const entry=boxes.getPageTextboxes(0).find(item=>item.content==='Explicit collision target');
    expect(entry).toBeDefined();
    boxes.onTextboxDeleted(entry);
    await settle();
    expect(adapter.deleteAnnotation).toHaveBeenCalledOnce();
    expect(adapter.deleteAnnotation.mock.calls[0][2]).toBe('shared-id');
    const remaining=annotations()[0]||[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject(native);
  });

  it.each([
    ['id:foo', 'foo', 99],
    ['xref:123', 'unrelated-explicit', 123],
  ])('actual callback retains literal native ID %s and preserves the unrelated explicit annotation', async (nativeId, otherId, otherXref) => {
    const native = { ...annotation, stable_id: nativeId, content: 'Native prefix target' };
    const other = { ...annotation, stable_id: otherId, xref: otherXref,
      has_explicit_stable_id: true, content: 'Unrelated explicit text' };
    delete annotations()[1];
    annotations()[0] = [other, native];
    adapter.updateAnnotation.mockImplementation(async (_a, _s, _wire, body) => ({
      success: true, annotation: { ...native, ...body, xref: 84 },
    }));
    helpers.refreshMarkupFromAnnotations();
    const entry = boxes.getPageTextboxes(0).find(item => item.content === 'Native prefix target');
    expect(entry).toBeDefined();
    expect(native.stable_id).toBe(nativeId);
    entry.content = 'Only native prefix target edited';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe(`xref:12|id:${nativeId}`);
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(item => item.xref === otherXref)).toMatchObject({
      stable_id: otherId, content: 'Unrelated explicit text', has_explicit_stable_id: true,
    });
    expect(annotations()[0].find(item => item.xref === 84)).toMatchObject({
      stable_id: nativeId, content: entry.content,
    });
  });

  it('real modal highlight extend and undo preserve native id:foo beside explicit foo', async () => {
    const native = { ...annotation, stable_id: 'id:foo', type: 'Highlight', source: 'AI',
      content: 'Native highlight', quads: [[10,20,50,30]], rect: [10,20,50,30], anchor_text: 'initial phrase' };
    const other = { ...native, stable_id: 'foo', xref: 99, has_explicit_stable_id: true,
      content: 'Unrelated explicit highlight' };
    delete annotations()[1];
    annotations()[0] = [other, native];
    let nextXref = 84;
    adapter.updateAnnotation.mockImplementation(async (_a, _s, wire, body) => {
      const expectedXref = nextXref === 84 ? 12 : nextXref - 1;
      if (wire !== `xref:${expectedXref}|id:id:foo`) throw new Error('Unexpected native highlight target');
      return { success: true, annotation: { ...native, ...body, xref: nextXref++ } };
    });
    const marker = d.createElement('div');
    marker.className = 'annotation-marker source-ai';
    marker.dataset.annotationPage = '0'; marker.dataset.annotationXref = '12';
    marker.dataset.annotationRequestId = 'xref:12|id:id:foo';
    d.body.append(marker);
    await controller.persistHighlightExtend(marker, native, { pageIdx: 0,
      quadsPdf: [[10,20,90,30]], anchorText: 'extended phrase' });
    expect.soft(annotations()[0]).toHaveLength(2);
    expect.soft(annotations()[0].find(item => item.xref === 99)).toMatchObject(other);
    await controller.performHighlightExtendUndo(controller.popUndoOperation());
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation.mock.calls[1][2]).toBe('xref:84|id:id:foo');
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(item => item.xref === 99)).toMatchObject(other);
  });

  it('explicit typed xref:123 metadata survives actual highlight edit and undo beside native xref123',async()=> {
    const explicit={...annotation,stable_id:'xref:123',xref:99,has_explicit_stable_id:true,
      type:'Highlight',source:'AI',content:'Explicit typed target',rect:[10,20,50,30],
      quads:[[10,20,50,30]],anchor_text:'initial phrase'};
    const native={...explicit,stable_id:'unrelated-native',xref:123,has_explicit_stable_id:false,
      content:'Native xref123 unchanged'};
    delete annotations()[1];annotations()[0]=[native,explicit];
    let nextXref=100;
    adapter.updateAnnotation.mockImplementation(async(_a,_s,wire,body)=> {
      if(wire!=='id:xref:123') throw new Error('Typed metadata was confused with a native xref');
      return {success:true,annotation:{...explicit,...body,xref:nextXref++}};
    });
    const marker=d.createElement('div');marker.className='annotation-marker source-ai';
    marker.dataset.annotationPage='0';marker.dataset.annotationXref='99';marker.dataset.annotationRequestId='id:xref:123';
    d.body.append(marker);
    await controller.persistHighlightExtend(marker,explicit,{pageIdx:0,quadsPdf:[[10,20,90,30]],anchorText:'extended phrase'});
    await controller.performHighlightExtendUndo(controller.popUndoOperation());
    expect(adapter.updateAnnotation).toHaveBeenCalledTimes(2);
    expect(adapter.updateAnnotation.mock.calls.map(call=>call[2])).toEqual(['id:xref:123','id:xref:123']);
    expect(annotations()[0]).toHaveLength(2);
    expect(annotations()[0].find(item=>item.xref===123)).toMatchObject(native);
  });

  it.each(['helper', 'fallback'])('actual %s save targets the second native annotation, with xref retained', async mode => {
    if (mode === 'fallback') delete w.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier;
    const entry = boxes.getPageTextboxes(1)[0];
    entry.content = 'Second annotation edited';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation).toHaveBeenCalled();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(adapter.updateAnnotation.mock.calls[0][3]).toEqual({content:'Second annotation edited'});
  });

  it.each(['helper', 'fallback'])('actual %s callback preserves a composite carried by entry.id alone', async mode => {
    if (mode === 'fallback') delete w.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier;
    annotations()[1][0] = { ...annotation, stable_id: null, id: 'xref:42|id:native-duplicate',
      xref: null, page_index: 1 };
    helpers.refreshMarkupFromAnnotations();
    const entry = boxes.getPageTextboxes(1)[0];
    expect(entry.annotationId).toBe('xref:42|id:native-duplicate');
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
  });

  it('returned recreated xref becomes the entry identity and its next delete target', async () => {
    const entry = boxes.getPageTextboxes(1)[0];
    entry.content = 'Updated synthetic content';
    boxes.onTextboxCommitted(entry);
    await settle();
    boxes.onTextboxDeleted(entry);
    await settle();
    expect(adapter.deleteAnnotation.mock.calls[0][2]).toBe('xref:84|id:native-duplicate');
    expect(entry.annotationId).toBe('xref:84|id:native-duplicate');
  });

  it('new textbox creation carries returned xref into its entry and undo operation', async () => {
    const entry = boxes.getPageTextboxes(0)[0];
    entry.annotationId = null;
    entry.content = 'New synthetic textbox';
    boxes.onTextboxCommitted(entry);
    await settle();
    expect(adapter.createAnnotation).toHaveBeenCalled();
    expect(entry.annotationId).toBe('xref:91|id:native-duplicate');
    expect(helpers.getUndoStacks().local.at(-1).annotationId).toBe('xref:91|id:native-duplicate');
  });

  it('a page move retains source scoped identity in the actual write request', async () => {
    const entry = boxes.getPageTextboxes(1)[0];
    boxes.moveTextboxToPage(entry, 0, d.querySelector('.pdf-page-wrapper'), 33, 44);
    await selection.onMoveCompleted({type:'textbox',pageIdx:0,sourcePageIdx:1,entry});
    expect(adapter.updateAnnotation.mock.calls[0][2]).toBe('xref:42|id:native-duplicate');
    expect(adapter.updateAnnotation.mock.calls[0][3].page_index).toBe(0);
  });

  it('cross-page native move records the recreated scoped target beside an explicit same-ID sibling', async () => {
    const native={...annotation,stable_id:'shared-move',xref:42,page_index:1};
    const explicit={...native,xref:99,page_index:0,has_explicit_stable_id:true,content:'Explicit sibling unchanged'};
    annotations()[0]=[explicit];annotations()[1]=[native];
    helpers.refreshMarkupFromAnnotations();
    adapter.updateAnnotation.mockImplementation(async(_a,_s,wire,body)=> {
      if(wire!=='xref:42|id:shared-move') throw new Error('Moved the explicit sibling');
      return {success:true,annotation:{...native,...body,xref:84}};
    });
    const entry=boxes.getPageTextboxes(1)[0];
    boxes.moveTextboxToPage(entry,0,wrapper,33,44);
    await selection.onMoveCompleted({type:'textbox',pageIdx:0,sourcePageIdx:1,entry});
    expect(adapter.updateAnnotation).toHaveBeenCalledOnce();
    expect(annotations()[0].find(item=>item.xref===99)).toEqual(explicit);
    const operation=helpers.getUndoStacks().local.at(-1);
    expect(operation).toMatchObject({type:'move',oldPageIdx:1,newPageIdx:0,xref:'84',
      identifier:'xref:84|id:shared-move',requestId:'xref:84|id:shared-move'});
  });
});
