/** Exercise the production undo dispatcher against independently measured PDF rectangles. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../src/pdf-preview-modal.js'),'utf8');
const start=source.indexOf('    async function applyMoveOperation(');
const end=source.indexOf('\n    async function ',start+10);
if(start<0||end<0) throw new Error('Production move undo dispatcher was not found');
const body=source.slice(start,end);

// Raw PDF /Rect truth from a native 595x842 page. These are PDF coordinates,
// not a second implementation of PDF.js projection or the server converter.
const truths=[
    {view:[0,0,595,842],native:[40,65,260,115],pdf:[40,727,260,777]},
    {view:[17,31,566,819],native:[40,65,260,115],pdf:[57,704,277,754]},
];

const converters=[
    {name:'modal',file:'../src/pdf-preview-modal.js',token:'    async function convertHighlightTopLeftRectToPdf(',next:'\n    async function ',clone:'cloneHighlightRect'},
    {name:'controller',file:'../src/pdf-preview-modal/annotation-controller.js',token:'        async function _convertTopLeftRectToPdf(',next:'\n        async function ',clone:'_cloneRect'},
];
for(const converter of converters) {
    const text=readFileSync(join(dirname(fileURLToPath(import.meta.url)),converter.file),'utf8');
    const first=text.indexOf(converter.token),last=text.indexOf(converter.next,first+10);
    if(first<0||last<0) throw new Error(`Production ${converter.name} converter not found`);
    const functionName=converter.token.match(/function (\w+)/)[1];
    it.each(truths.flatMap(truth=>[0,90,180,270].map(rotation=>({...truth,rotation}))))(
        `production ${converter.name} highlight converter respects PDF crop origin $view/$rotation`,async truth=> {
            const viewer={pdf:{getPage:vi.fn(async()=>({view:truth.view,rotate:truth.rotation}))}};
            const convert=new Function('window','_h',converter.clone,
                `${text.slice(first,last)};return ${functionName};`)(
                    {__pdfGradedViewer:viewer},{getViewer:()=>viewer},value=>structuredClone(value));
            expect(await convert(truth.native,0)).toEqual(truth.pdf);
        },
    );
}

it.each(truths.flatMap(truth=>[0,90,180,270].map(rotation=>({...truth,rotation}))))(
    'production undo sends native PDF truth for view $view rotation $rotation',async truth=> {
        const viewer={pdf:{getPage:vi.fn(async()=>({view:truth.view,rotate:truth.rotation}))}};
        const operation={type:'move',identifier:'fixture-id',requestId:'fixture-id',xref:'42',
            oldPageIdx:0,newPageIdx:0,oldRect:[...truth.native]};
        const helperStart=source.indexOf('    async function convertHighlightTopLeftRectToPdf(');
        const helperEnd=source.indexOf('\n    async function ',helperStart+10);
        if(helperStart<0||helperEnd<0) throw new Error('Production rectangle converter not found');
        const convert=new Function('window','cloneHighlightRect',
            `${source.slice(helperStart,helperEnd)};return convertHighlightTopLeftRectToPdf;`)(
                {__pdfGradedViewer:viewer},value=>structuredClone(value));
        const apply=new Function('window','resolveCurrentUndoTarget','cloneHistoryBody',
            'cloneHighlightQuads','HISTORY_STALE','HISTORY_DROPPED','convertHighlightTopLeftRectToPdf',
            `${body};return applyMoveOperation;`)(
                {__pdfGradedViewer:viewer},()=>({apiIdentifier:'fixture-id'}),
                value=>structuredClone(value),value=>structuredClone(value),'stale','dropped',convert);
        // End after the real request dispatch: UI reconciliation is covered by
        // actual modal lifecycle tests and does not determine its PDF geometry.
        const update=vi.fn(async()=>({success:true}));
        await apply(operation,false,{update,isCurrent:()=>false});
        expect(update).toHaveBeenCalledOnce();
        expect(update.mock.calls[0][0]).toBe('fixture-id');
        expect(update.mock.calls[0][1]).toEqual({page_index:0,rect:truth.pdf});
    },
);
