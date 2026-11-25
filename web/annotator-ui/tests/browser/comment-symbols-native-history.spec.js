/**
 * Browser-tier oracle for the `\name` shortcut in comment editors.
 *
 * jsdom has no execCommand and no native undo stack, so the caret after a
 * native Ctrl+Z and the delimiter Chrome inserts for Tab are only observable
 * in a real browser.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const script = readFileSync(new URL('../../src/pdf-preview-modal/comment-symbols.js', import.meta.url), 'utf8');
const BACKSLASH = String.fromCharCode(92);

async function mount(page) {
    await page.setContent('<textarea id="t"></textarea><div id="ce" contenteditable="true"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
        for (const id of ['t', 'ce']) window.PdfCommentSymbols.attach(document.getElementById(id));
    });
}

// Chrome stores a trailing typed space in a contenteditable as U+00A0.
const plain = text => text.replaceAll('\u00a0', ' ');
const typeShortcut = (page, text) => page.keyboard.type(text.replaceAll('~', BACKSLASH));

test('Ctrl+Z after a textarea conversion leaves a collapsed caret after the token', async ({ page }) => {
    await mount(page);
    await page.click('#t');
    await typeShortcut(page, '~beta');
    await page.keyboard.press('Space');
    expect(await page.$eval('#t', e => e.value)).toBe('β ');
    await page.keyboard.press('Control+z');
    const state = await page.$eval('#t', e => [e.value, e.selectionStart, e.selectionEnd]);
    expect(state).toEqual([`${BACKSLASH}beta `, 6, 6]);
    await page.keyboard.type('x');
    expect(await page.$eval('#t', e => e.value)).toBe(`${BACKSLASH}beta x`);
});

test('Ctrl+Z after a contenteditable conversion leaves a collapsed caret after the token', async ({ page }) => {
    await mount(page);
    await page.click('#ce');
    await typeShortcut(page, '~beta');
    await page.keyboard.press('Space');
    expect(plain(await page.$eval('#ce', e => e.textContent))).toBe('β ');
    await page.keyboard.press('Control+z');
    const state = await page.evaluate(() => {
        const selection = document.getSelection();
        const range = selection.getRangeAt(0);
        const prefix = document.createRange();
        prefix.selectNodeContents(document.getElementById('ce'));
        prefix.setEnd(range.endContainer, range.endOffset);
        return [document.getElementById('ce').textContent.replaceAll('\u00a0', ' '), selection.isCollapsed, prefix.toString().length];
    });
    expect(state).toEqual([`${BACKSLASH}beta `, true, 6]);
    await page.keyboard.type('x');
    expect(plain(await page.$eval('#ce', e => e.textContent))).toBe(`${BACKSLASH}beta x`);
});

for (const id of ['t', 'ce']) {
    test(`Tab after a shortcut drops the delimiter (${id})`, async ({ page }) => {
        await mount(page);
        await page.click(`#${id}`);
        await typeShortcut(page, 'a ~omega');
        await page.keyboard.press('Tab');
        const text = await page.$eval(`#${id}`, e => (e.tagName === 'TEXTAREA' ? e.value : e.textContent));
        expect(JSON.stringify(plain(text))).toBe(JSON.stringify('a ω'));
    });
}
