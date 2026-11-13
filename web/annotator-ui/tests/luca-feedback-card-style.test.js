/** L1d: comments must remain readable without requiring pointer hover. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const css = readFileSync(resolve('src/annotator-ui.css'), 'utf8');
let stylesheet;
afterEach(() => {
    stylesheet?.remove();
    document.body.replaceChildren();
});

it.each([
    ['preview-fullscreen', false], ['preview-fullscreen', true], ['', false], ['preview-fullscreen', false, 'editing'],
])('does not clamp feedback (%s, dark=%s, %s)', (mode, dark, editing = '') => {
    stylesheet = document.createElement('style');
    stylesheet.textContent = css;
    document.head.append(stylesheet);
    const modal = document.createElement('div');
    modal.id = 'pdfPreviewModal';
    modal.className = `modal ${mode}`;
    if (dark) modal.dataset.theme = 'dark';
    const card = document.createElement('div');
    card.className = `annotation-content ${editing}`;
    card.textContent = 'Q1 full feedback. Q2 full feedback. Q3 full feedback. L1D_Q3_TAIL_MARK';
    modal.append(card);
    document.body.append(modal);
    const computed = getComputedStyle(card);
    if (editing) expect(computed.maxHeight, 'edit-mode stylesheet must be applied').toBe('none');
    else expect(['text', 'pointer'], 'read-mode stylesheet must be applied').toContain(computed.cursor);
    expect(['', 'none', 'unset', 'initial'], 'a fixed line clamp hides feedback until hover')
        .toContain(computed.webkitLineClamp);
    expect(computed.overflow).not.toBe('hidden');
});
