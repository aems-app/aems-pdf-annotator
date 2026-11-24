/**
 * AEMS MASTER 547(a): ONE comment style on the PDF (Luca, the instructor).
 *
 * Defect class: visual provenance split. Teacher-created markup comments drew an orange
 * border/halo while AI comments drew a blue one, so the PDF showed two comment styles. The
 * provenance CLASS (source-ai / source-human) stays: ownership logic and the comment list's
 * badge read it. Only the styling must be identical for both values.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

const css = readFileSync(resolve('src/annotator-ui.css'), 'utf8');
const BORDER_PROPS = ['borderLeftColor', 'borderLeftWidth', 'borderLeftStyle'];
let stylesheet;

beforeEach(() => {
    stylesheet = document.createElement('style');
    stylesheet.textContent = css;
    document.head.append(stylesheet);
});
afterEach(() => {
    stylesheet.remove();
    document.body.replaceChildren();
});

function build(source) {
    const modal = document.createElement('div');
    modal.id = 'pdfPreviewModal';
    const marker = document.createElement('div');
    marker.className = `annotation-marker ${source}`;
    const label = document.createElement('span');
    label.className = 'annotation-label';
    marker.append(label);
    const row = document.createElement('div');
    row.className = `list-group-item ${source}`;
    modal.append(marker, row);
    document.body.append(modal);
    return { marker, label, row };
}

function snapshot(source) {
    const { marker, label, row } = build(source);
    const pick = (el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));
    return {
        marker: pick(marker, ['boxShadow']),
        label: pick(label, BORDER_PROPS),
        row: pick(row, BORDER_PROPS),
    };
}

it('the stylesheet really styles an AI marker (the comparison below is not vacuous)', () => {
    const ai = snapshot('source-ai');
    expect(ai.marker.boxShadow).not.toBe('');
    expect(ai.label.borderLeftWidth).not.toBe('');
    expect(ai.row.borderLeftWidth).not.toBe('');
});

it('a teacher-created (source-human) comment is styled exactly like an AI comment', () => {
    document.body.replaceChildren();
    const ai = snapshot('source-ai');
    document.body.replaceChildren();
    const human = snapshot('source-human');
    expect(human).toEqual(ai);
});

it('no comment marker or list row draws the orange teacher border', () => {
    const { marker, label, row } = build('source-human');
    const blob = [
        getComputedStyle(marker).boxShadow,
        ...BORDER_PROPS.map((p) => getComputedStyle(label)[p]),
        ...BORDER_PROPS.map((p) => getComputedStyle(row)[p]),
    ].join(' ');
    expect(blob).not.toMatch(/#e65100|rgb\(230,\s*81,\s*0\)|rgba\(230,\s*81,\s*0/i);
});

it('the provenance class is still applied by the renderers (ownership logic reads it)', () => {
    const overlay = readFileSync(resolve('src/pdf-preview-modal/overlay-renderer.js'), 'utf8');
    expect(overlay).toContain("'source-human'");
});
