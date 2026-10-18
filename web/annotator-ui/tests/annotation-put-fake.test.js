import { describe, expect, it } from 'vitest';
import { applyAnnotationPut } from './fixtures/annotation-put.fixture.js';

const annotation = {
  content: 'Original', color: 'amber', rect: [10, 20, 30, 40], page_index: 0,
  points: [[10, 20], [30, 40]], source: 'AI',
};
describe('AEMS annotation PUT ownership contract used by the fakes', () => {
  it.each([
    { content: 'Edited' }, { color: 'red' }, { rect: [20, 20, 40, 40] },
    { page_index: 1 }, { points: [[10, 20], [30, 41]] },
    { quads: [[10, 20, 30, 40]] }, { anchor_text: 'Answer' },
  ])('transfers changed AI annotation with %j', (body) => {
    expect(applyAnnotationPut(annotation, body)).toMatchObject({ ...body, source: 'HUMAN', original_source: 'AI' });
    expect(applyAnnotationPut(annotation, { ...body, source: 'AI' }).source).toBe('AI');
    expect(applyAnnotationPut({ ...annotation, source: 'HUMAN' }, body).source).toBe('HUMAN');
  });
  it.each([
    {}, { content: ' Original ' }, { color: 'AMBER' }, { rect: [10, 20, 30, 40] },
    { page_index: 0 }, { points: [[10.0001, 20], [30, 40]] },
  ])('preserves AI on a no-op %j', (body) => {
    expect(applyAnnotationPut(annotation, body).source).toBe('AI');
  });
  it('reproduces the live content edit, undo and redo ownership sequence', () => {
    const edited = applyAnnotationPut(annotation, { content: 'Edited' });
    const undone = applyAnnotationPut(edited, { content: 'Original', source: 'AI' });
    const redone = applyAnnotationPut(undone, { content: 'Edited' });
    expect([edited.source, undone.source, redone.source]).toEqual(['HUMAN', 'AI', 'HUMAN']);
    expect(redone.original_source).toBe('AI');
  });
});
