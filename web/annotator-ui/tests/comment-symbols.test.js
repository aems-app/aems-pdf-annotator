import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/pdf-preview-modal/comment-symbols.js';

const { attach, shortcutAt } = window.PdfCommentSymbols;
const press = (element, key, options = {}) => element.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, key, ...options,
}));
const setup = (storage, translate = key => key) => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    const picker = attach(textarea, translate, storage);
    return { textarea, picker, toggle: picker.firstElementChild, panel: picker.lastElementChild };
};

afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('shortcut lookup', () => {
    it.each([
        ['alpha', 'α'], ['Delta', 'Δ'], ['tau', 'τ'], ['sigma', 'σ'],
        ['pm', '±'], ['deg', '°'], ['approx', '≈'], ['le', '≤'], ['ge', '≥'],
        ['inf', '∞'], ['sqrt', '√'], ['times', '×'], ['varphi', 'ϕ'],
        ['vartheta', 'ϑ'], ['Omicron', 'Ο'], ['omega', 'ω'],
    ])('recognizes %s at the caret and inserts %s', (name, glyph) => {
        const { textarea } = setup();
        const command = 'x=\\' + name;
        textarea.value = command + ', trailing text';
        textarea.setSelectionRange(command.length, command.length);
        expect(shortcutAt(textarea.value, command.length, command.length)).toEqual({ start: 2, name });
        expect(press(textarea, 'Tab')).toBe(false);
        expect(textarea.value).toBe('x=' + glyph + ', trailing text');
        expect(textarea.selectionStart).toBe(3);
    });

    it.each(['\\unknown', 'alpha', '\\\\alpha'])('leaves %s alone', text => {
        expect(shortcutAt(text, text.length, text.length)).toBeNull();
    });

    it('ignores a selection, composition, modifiers, and unrelated keys', () => {
        const { textarea } = setup();
        textarea.value = '\\alpha';
        textarea.setSelectionRange(0, 6);
        expect(press(textarea, ' ')).toBe(true);
        textarea.setSelectionRange(6, 6);
        for (const options of [{ isComposing: true }, { altKey: true }, { shiftKey: true }, { ctrlKey: true }]) {
            expect(press(textarea, 'Tab', options)).toBe(true);
        }
        expect(press(textarea, 'Enter')).toBe(true);
        expect(textarea.value).toBe('\\alpha');
    });

    it('does not intercept native undo after the next input', () => {
        const { textarea } = setup();
        textarea.value = '\\alpha';
        press(textarea, 'Tab');
        textarea.value += 'x';
        textarea.dispatchEvent(new Event('input'));
        expect(press(textarea, 'z', { ctrlKey: true })).toBe(true);
        expect(textarea.value).toBe('αx');
    });

    it.each([true, false])('uses the native undo stack when insertion succeeds (native input event %s)', firesInput => {
        const { textarea } = setup();
        const input = vi.fn();
        textarea.addEventListener('input', input);
        const native = vi.fn((_name, _ui, text) => {
            expect(document.activeElement).toBe(textarea);
            textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
            if (firesInput) textarea.dispatchEvent(new InputEvent('input'));
            return true;
        });
        Object.defineProperty(document, 'execCommand', { configurable: true, value: native });
        try {
            textarea.value = '\\alpha';
            expect(press(textarea, 'Tab')).toBe(false);
            expect(native).toHaveBeenCalledWith('insertText', false, 'α');
            expect(input).toHaveBeenCalledOnce();
            expect(press(textarea, 'z', { ctrlKey: true })).toBe(true);
        } finally {
            delete document.execCommand;
        }
    });
});

describe('symbol popover', () => {
    it('renders the exact rows as text, translates names, and attaches only once', () => {
        const translate = key => 'sv-' + key;
        const { panel, picker, textarea, toggle } = setup(undefined, translate);
        expect(attach(textarea, translate)).toBe(picker);
        expect(toggle.getAttribute('aria-label')).toBe('sv-Insert symbol');
        toggle.click();
        const groups = [...panel.children];
        expect(groups.map(group => [...group.querySelectorAll('button')].map(button => button.textContent).join(' ')))
            .toEqual([
                'α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω ϕ ϑ',
                'Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω',
                '± × · ÷ ° ≈ ≠ ≤ ≥ ∞ √ ∂ ∇ ∑ ∫ → ⇒ ∝ ′ ″ ² ³ ⁻¹ ₀ ₁ ₂ ₓ ᵧ',
            ]);
        expect(panel.querySelector('[aria-label="sv-plus-minus"]').textContent).toBe('±');
        expect(panel.querySelector('[aria-label="sv-Delta"]').textContent).toBe('Δ');
        toggle.focus();
        expect(press(toggle, 'ArrowLeft')).toBe(true);
        toggle.click();
        expect(panel.hidden).toBe(true);
    });

    it('wraps with arrow keys and closes when focus leaves', () => {
        const { panel, textarea, toggle } = setup();
        toggle.click();
        const active = () => document.activeElement;
        expect(press(active(), 'ArrowLeft')).toBe(false);
        expect(active().textContent).toBe('ᵧ');
        expect(press(active(), 'ArrowUp')).toBe(false);
        expect(active().textContent).toBe('∝');
        expect(press(active(), 'ArrowDown')).toBe(false);
        expect(active().textContent).toBe('ᵧ');
        expect(press(active(), 'F8')).toBe(true);
        expect(press(active(), 'ArrowRight')).toBe(false);
        expect(active().textContent).toBe('α');
        textarea.focus();
        expect(panel.hidden).toBe(true);
        expect(press(toggle, 'Escape')).toBe(true);
    });

    it('keeps keyboard events inside the picker so review tool shortcuts cannot run', () => {
        const { toggle } = setup();
        const toolbarShortcut = vi.fn();
        document.addEventListener('keydown', toolbarShortcut);
        try {
            toggle.focus();
            expect(press(toggle, 'n')).toBe(true);
            toggle.click();
            expect(press(document.activeElement, 'Delete')).toBe(true);
            expect(toolbarShortcut).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener('keydown', toolbarShortcut);
        }
    });

    it('shares an eight-entry, most-recent-first row across editors', () => {
        const first = setup();
        for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'epsilon']) {
            first.textarea.value = '\\' + name;
            expect(press(first.textarea, 'Tab')).toBe(false);
        }
        const second = setup();
        second.toggle.click();
        const recents = second.panel.querySelector('[aria-label="Recently used symbols"]');
        expect([...recents.querySelectorAll('button')].map(cell => cell.textContent)).toEqual(['ε', 'ι', 'θ', 'η', 'ζ', 'δ', 'γ', 'β']);
    });

    it('names Greek capitals in the recent row even if omitted from the main palette', () => {
        const { textarea, panel, toggle } = setup(undefined, (key, params) =>
            params ? 'Stort ' + params.letter : key);
        textarea.value = '\\Omicron';
        press(textarea, 'Tab');
        toggle.click();
        expect(panel.querySelector('[aria-label="Stort omicron"]').textContent).toBe('Ο');
    });

    it.each(['malformed JSON', '{}', '["missing","alpha","alpha",42]'])('can insert with stored value %s', stored => {
        const storage = { getItem: () => stored, setItem: vi.fn() };
        const { panel, textarea, toggle } = setup(() => storage);
        toggle.click();
        panel.querySelector('[aria-label="alpha"]').click();
        expect(textarea.value).toBe('α');
        expect(storage.setItem).toHaveBeenCalledWith('aems.annotation.recentSymbols', '["alpha"]');
    });

    it('allows insertion and in-memory recents with storage access blocked', () => {
        const { panel, textarea, toggle } = setup(() => { throw new DOMException('Blocked', 'SecurityError'); });
        toggle.click();
        panel.querySelector('[aria-label="superscript minus one"]').click();
        expect(textarea.value).toBe('⁻¹');
        expect(textarea.selectionStart).toBe(2);
        toggle.click();
        expect(document.activeElement.textContent).toBe('⁻¹');
    });

    it('uses the top layer when anchor positioning is available', () => {
        vi.stubGlobal('CSS', { supports: () => true });
        let shown = false;
        const show = vi.fn(() => { shown = true; });
        const hide = vi.fn(() => { shown = false; });
        Object.defineProperties(HTMLElement.prototype, {
            showPopover: { configurable: true, value: show },
            hidePopover: { configurable: true, value: hide },
        });
        try {
            const { panel, toggle } = setup();
            vi.spyOn(panel, 'matches').mockImplementation(selector => selector === ':popover-open' && shown);
            expect(panel.popover).toBe('manual');
            toggle.click();
            expect(show).toHaveBeenCalledExactlyOnceWith({ source: toggle });
            press(document.activeElement, 'Escape');
            expect(hide).toHaveBeenCalledOnce();
            expect(panel.hidden).toBe(true);
        } finally {
            delete HTMLElement.prototype.showPopover;
            delete HTMLElement.prototype.hidePopover;
            vi.unstubAllGlobals();
        }
    });

    it('preserves the contenteditable caret at the beginning of a subsequent line', () => {
        const editor = document.createElement('div');
        editor.tabIndex = 0;
        editor.contentEditable = 'true';
        const line = document.createElement('div');
        line.textContent = 'second line';
        editor.append(document.createTextNode('first line'), line);
        document.body.append(editor);
        const picker = attach(editor);
        editor.focus();
        getSelection().collapse(line.firstChild, 0);
        picker.firstElementChild.focus();
        picker.firstElementChild.click();
        picker.querySelector('[aria-label="alpha"]').click();
        expect(editor.firstChild.textContent).toBe('first line');
        expect(line.textContent).toBe('αsecond line');
    });

    it('inserts in a blank contenteditable field when there is no current range', () => {
        const editor = document.createElement('div');
        editor.tabIndex = 0;
        editor.contentEditable = 'true';
        document.body.append(editor);
        const picker = attach(editor);
        getSelection().removeAllRanges();
        expect(press(editor, 'Tab')).toBe(true);
        picker.firstElementChild.click();
        picker.querySelector('[aria-label="alpha"]').click();
        expect(editor.textContent).toBe('α');
        expect(document.activeElement).toBe(editor);
    });
});
