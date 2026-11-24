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

// --- Round-2 (astra review M2): the rest of the teacher-only orange styling ---------------
// The comment-list badge, the split-panel teacher column and the ownership flash were still
// orange, so the comment UI still showed two styles. Their CLASSES stay (provenance logic and
// the badge text read them); only the colours must match the AI ones.

const ORANGE = [
    /#e65100/i, /#c2410c/i, /#ea580c/i, /#fb923c/i, /#fdba74/i, /#fed7aa/i, /#ffedd5/i,
    /#fff7ed/i, /#fffbf5/i,
    /rgba?\(\s*230,\s*81,\s*0/i, /rgba?\(\s*194,\s*65,\s*12/i, /rgba?\(\s*251,\s*146,\s*60/i,
];
const TEACHER_SELECTOR = /source-human|comments-panel-human|ownership-transferred/;

function teacherRules() {
    const out = [];
    const walk = (rules) => {
        for (const rule of rules) {
            if (rule.cssRules && !rule.selectorText) walk(rule.cssRules);
            if (rule.selectorText && TEACHER_SELECTOR.test(rule.selectorText)) out.push(rule.cssText);
            if (rule.name === 'ownership-flash') out.push(rule.cssText);
        }
    };
    walk(stylesheet.sheet.cssRules);
    return out;
}

it('the teacher-only selectors are really parsed (the orange scan below is not vacuous)', () => {
    const rules = teacherRules();
    expect(rules.some((r) => r.includes('.source-badge.source-human'))).toBe(true);
    expect(rules.some((r) => r.includes('split-panel-mode .comments-panel-human'))).toBe(true);
    expect(rules.some((r) => r.includes('ownership-flash'))).toBe(true);
});

it('no teacher-only rule (badge, split column, ownership flash, dark mode) is orange', () => {
    const offenders = teacherRules().filter((r) => ORANGE.some((re) => re.test(r)));
    expect(offenders).toEqual([]);
});

function styleOf(el, props) {
    return Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));
}

it('the teacher source badge looks exactly like the AI one', () => {
    const props = ['color', 'backgroundImage', 'borderTopColor', 'boxShadow'];
    const make = (cls) => {
        const badge = document.createElement('span');
        badge.className = `source-badge ${cls}`;
        document.body.append(badge);
        return badge;
    };
    const ai = styleOf(make('source-ai'), props);
    const human = styleOf(make('source-human'), props);
    expect(ai.color).not.toBe('');
    expect(human).toEqual(ai);
});

it('the split-panel teacher column is framed and filled like the AI column', () => {
    const modal = document.createElement('div');
    modal.id = 'pdfPreviewModal';
    modal.className = 'split-panel-mode';
    const ai = document.createElement('div');
    ai.className = 'comments-panel-ai';
    const human = document.createElement('div');
    human.className = 'comments-panel-human';
    modal.append(ai, human);
    document.body.append(modal);
    const a = getComputedStyle(ai);
    const h = getComputedStyle(human);
    expect(a.borderRightColor).not.toBe('');
    expect(h.borderLeftColor).toBe(a.borderRightColor);
    expect(h.borderLeftWidth).toBe(a.borderRightWidth);
    expect(h.backgroundColor).toBe(a.backgroundColor);
});
