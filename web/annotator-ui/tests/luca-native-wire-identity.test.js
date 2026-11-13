import { beforeAll, expect, it } from 'vitest';

beforeAll(async () => { await import('../src/pdf-preview-modal/annotation-helpers.js'); });

it.each([
    [{ identifier: 'same-native-id', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:same-native-id'],
    [{ identifier: 'same-native-id', xref: 42, has_explicit_stable_id: false }, 'xref:42|id:same-native-id'],
    [{ identifier: 'xref:12|id:same-native-id' }, 'xref:12|id:same-native-id'],
    [{ identifier: 'xref:12|id:same-native-id', xref: 84 }, 'xref:84|id:same-native-id'],
    [{ identifier: '123', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:123'],
    [{ requestId: 'xref:42|id:same-native-id' }, 'xref:42|id:same-native-id'],
    [{ identifier: 'native|xref:999', xref: 12, has_explicit_stable_id: false }, 'xref:12'],
    [{ identifier: 'native\nunsafe', xref: 12, has_explicit_stable_id: false }, 'xref:12'],
    [{ identifier: 'native/path', xref: 12, has_explicit_stable_id: false }, 'xref:12'],
    [{ identifier: 'native path', xref: 12, has_explicit_stable_id: false }, 'xref:12'],
    [{ identifier: 'native#path', xref: 12, has_explicit_stable_id: false }, 'xref:12'],
    [{ identifier: 'native/path', has_explicit_stable_id: false }, null],
    [{ identifier: 'xref:12|id:native/path' }, 'xref:12'],
    [{ identifier: 'native/path', xref: 12, has_explicit_stable_id: true }, 'native/path'],
    [{ identifier: 'native/path', xref: 12 }, 'native/path'],
    [{ identifier: 'id:foo', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:id:foo'],
    [{ identifier: 'xref:123', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:xref:123'],
    [{ identifier: 'xref:12|id:id:foo' }, 'xref:12|id:id:foo'],
    [{ identifier: 'xref:12|id:xref:123' }, 'xref:12|id:xref:123'],
    [{ identifier: 'Note', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:Note'],
    [{ identifier: 'Text', xref: 12, has_explicit_stable_id: false }, 'xref:12|id:Text'],
    [{ identifier: 'explicit-stable-id' }, 'explicit-stable-id'],
    [{ identifier: '123' }, 'id:123'],
    [{ xref: 12 }, 'xref:12'],
])('keeps annotation scope for %j', (input, expected) => {
    const original={...input};
    expect(window.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier(input)).toBe(expected);
    expect(input).toEqual(original);
});
