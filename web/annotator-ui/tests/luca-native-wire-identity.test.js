import { beforeAll, expect, it } from 'vitest';
import { nativeWireCases } from './fixtures/native-wire-contract.fixture.js';

beforeAll(async () => { await import('../src/pdf-preview-modal/annotation-helpers.js'); });

it.each(nativeWireCases)('keeps annotation scope for %j', (input, expected) => {
    const original={...input};
    expect(window.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier(input)).toBe(expected);
    expect(input).toEqual(original);
});

it.each([
    [{stable_id:'native-row',xref:12,has_explicit_stable_id:false},'xref:12|id:native-row'],
    [{stableId:'camel-native',xref:12,has_explicit_stable_id:false},'xref:12|id:camel-native'],
    [{id:'xref:12|id:wire-only',xref:12,has_explicit_stable_id:false},'xref:12|id:wire-only'],
    [{identifier:'fallback-native',xref:12,has_explicit_stable_id:false},'xref:12|id:fallback-native'],
    [{stable_id:'explicit-row',xref:12,has_explicit_stable_id:true},'explicit-row'],
])('public annotation-entry producer retains native/legacy identity %j',(entry,expected)=> {
    const original={...entry};
    expect(window.PdfPreviewModalAnnotationHelpers.buildAnnotationRequestIdentifier(entry)).toBe(expected);
    expect(entry).toEqual(original);
});
