/** Synthetic native PDF annotation truth, captured using PDF.js 3.11.174 and MuPDF. */
import { beforeAll, expect, it } from 'vitest';
import fixtures from './fixtures/luca-rotation-truth.json';

beforeAll(async () => { await import('../src/pdf-preview-modal/rendering.js'); });

it.each(fixtures)('projects native PDF annotation $id at zoom $scale', fixture => {
    const { transform: m } = fixture;
    const viewport = {
        ...fixture,
        convertToViewportPoint(x, y) { return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]]; },
        convertToViewportRectangle(rect) {
            return [...this.convertToViewportPoint(rect[0],rect[1]), ...this.convertToViewportPoint(rect[2],rect[3])];
        },
    };
    const actual = window.PdfPreviewModalRendering.convertTopLeftRectToViewport(fixture.stored_rect, viewport);
    const normalized = [Math.min(actual[0],actual[2]),Math.min(actual[1],actual[3]),
        Math.max(actual[0],actual[2]),Math.max(actual[1],actual[3])];
    normalized.forEach((value,index) => expect(value).toBeCloseTo(fixture.expected[index],5));
});
