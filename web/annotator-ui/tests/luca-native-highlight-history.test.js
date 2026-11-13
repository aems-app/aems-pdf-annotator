/** A native ID resembling wire syntax must survive an actual highlight edit and undo. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyAnnotationPut } from './fixtures/annotation-put.fixture.js';
let activeController;
afterEach(()=>activeController?.destroy());

beforeEach(async()=> {
    vi.resetModules();
    document.body.replaceChildren();
    delete window.PdfPreviewModalAnnotationController;
    delete window.PdfPreviewModalAnnotationHelpers;
    window.PdfPreviewModalUtils={debugLog:()=>{},PLACEHOLDER_STRINGS:[]};
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/annotation-controller.js');
});

it.each(['stable_id','stableId'])('undo targets native id:foo through typed %s and preserves explicit foo',async field=> {
    const helpers=window.PdfPreviewModalAnnotationHelpers;
    const native={stable_id:'id:foo',has_explicit_stable_id:false,xref:42,page_index:0,type:'Highlight',
        content:'Native highlight',source:'AI',original_source:'AI',rect:[10,20,50,30],
        quads:[[10,20,50,30]],anchor_text:'initial synthetic phrase'};
    if(field==='stableId'){native.stableId=native.stable_id;delete native.stable_id;}
    const other={...native,stable_id:'foo',stableId:undefined,has_explicit_stable_id:true,xref:99,content:'Unrelated explicit highlight'};
    let stored={...native}, data={0:[{...other},{...native}]};
    const requests=[];
    const update=vi.fn(async(wire,body)=> {
        requests.push(wire);
        if (wire!==`xref:${stored.xref}|id:id:foo`) return {success:false,status:404,error:'Wrong native target'};
        stored={...applyAnnotationPut(stored,body),xref:stored.xref+1};
        return {success:true,annotation:{...stored}};
    });
    const controller=window.PdfPreviewModalAnnotationController.createAnnotationController({
        annotationsState:{undoStack:[]},getAnnotationsData:()=>data,setAnnotationsData:value=>{data=value;},
        helpers:{buildApiAnnotationIdentifier:helpers.buildApiAnnotationIdentifier,
            normalizeAnnotationIdentifierValue:helpers.normalizeAnnotationIdentifierValue,
            resolveAnnotationIdentifierValue:helpers.resolveAnnotationIdentifierValue,
            resolveAnnotationSource:helpers.resolveAnnotationSource,updateAnnotationRequest:update},
    });
    activeController=controller;
    const marker=document.createElement('div');
    marker.className='annotation-marker source-ai';
    marker.dataset.annotationXref='42';marker.dataset.annotationPage='0';
    marker.dataset.annotationRequestId='xref:42|id:id:foo';marker.dataset.annotationSource='AI';
    document.body.append(marker);
    await controller.persistHighlightExtend(marker,native,{pageIdx:0,quadsPdf:[[10,20,90,30]],anchorText:'extended phrase'});
    expect(requests).toEqual(['xref:42|id:id:foo']);
    expect.soft(data[0].find(entry=>entry.xref===99), 'initial extend must preserve explicit foo').toMatchObject(other);
    const operation=controller.popUndoOperation();
    expect(operation).toBeDefined();
    await controller.performHighlightExtendUndo(operation);
    expect(requests).toEqual(['xref:42|id:id:foo','xref:43|id:id:foo']);
    expect(stored.quads).toEqual(native.quads);
    expect(data[0].find(entry=>entry.xref===99)).toMatchObject(other);
    expect(stored[field]).toBe('id:foo');
});
