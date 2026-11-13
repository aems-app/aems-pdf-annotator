import { beforeAll, expect, it } from 'vitest';

beforeAll(async () => { await import('../src/pdf-preview-modal/annotation-helpers.js'); });

it.each([
    [{ identifier: 'same-native-id', xref: 12 }, 'xref:12|id:same-native-id'],
    [{ identifier: 'same-native-id', xref: 42 }, 'xref:42|id:same-native-id'],
    [{ identifier: 'xref:12|id:same-native-id' }, 'xref:12|id:same-native-id'],
    [{ identifier: 'xref:12|id:same-native-id', xref: 84 }, 'xref:84|id:same-native-id'],
    [{ identifier: '123', xref: 12 }, 'xref:12|id:123'],
    [{ requestId: 'xref:42|id:same-native-id' }, 'xref:42|id:same-native-id'],
    [{ identifier: 'native|xref:999', xref: 12 }, 'xref:12'],
    [{ identifier: 'native\nunsafe', xref: 12 }, 'xref:12'],
    [{ identifier: 'explicit-stable-id' }, 'explicit-stable-id'],
    [{ identifier: '123' }, 'id:123'],
    [{ xref: 12 }, 'xref:12'],
])('keeps annotation scope for %j', (input, expected) => {
    expect(window.PdfPreviewModalAnnotationHelpers.buildApiAnnotationIdentifier(input)).toBe(expected);
});
