(function (exports) {
    'use strict';

    const greek = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
    const lower = [...'αβγδεζηθικλμνξοπρστυφχψω'].map((glyph, index) => [greek[index], glyph]);
    const visibleCapitals = 'ΓΔΘΛΞΠΣΦΨΩ';
    const capitals = [...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'].map((glyph, index) => {
        const name = greek[index];
        const hidden = !visibleCapitals.includes(glyph);
        return [name[0].toUpperCase() + name.slice(1), glyph, hidden ? name : undefined, hidden];
    });
    // The shortcut name, Unicode text, optional spoken label and palette visibility.
    const groups = [
        ['Greek lowercase', [...lower, ['varphi', 'ϕ', 'variant phi'], ['vartheta', 'ϑ', 'variant theta']]],
        ['Greek uppercase', capitals],
        ['Math symbols', [
            ['pm', '±', 'plus-minus'], ['times', '×', 'multiplication'], ['cdot', '·', 'middle dot'],
            ['div', '÷', 'division'], ['deg', '°', 'degree'], ['approx', '≈', 'approximately equal'],
            ['ne', '≠', 'not equal'], ['le', '≤', 'less than or equal'], ['ge', '≥', 'greater than or equal'],
            ['inf', '∞', 'infinity'], ['sqrt', '√', 'square root'], ['partial', '∂', 'partial derivative'],
            ['nabla', '∇', 'nabla'], ['sum', '∑', 'summation'], ['int', '∫', 'integral'],
            ['to', '→', 'right arrow'], ['implies', '⇒', 'implies'], ['propto', '∝', 'proportional to'],
            ['prime', '′', 'prime'], ['dprime', '″', 'double prime'], ['sup2', '²', 'superscript two'],
            ['sup3', '³', 'superscript three'], ['inv', '⁻¹', 'superscript minus one'],
            ['sub0', '₀', 'subscript zero'], ['sub1', '₁', 'subscript one'], ['sub2', '₂', 'subscript two'],
            ['subx', 'ₓ', 'subscript x'], ['suby', 'ᵧ', 'subscript y'],
        ]],
    ];
    const symbols = new Map(groups.flatMap(([, entries]) => entries.map(
        ([name, glyph, label = name, hidden = false]) => [name, { glyph, label, hidden }],
    )));
    const storageKey = 'aems.annotation.recentSymbols';
    const columns = 10;

    function shortcutAt(value, start, end) {
        if (start !== end) return null;
        const token = value.slice(0, start).match(/(?<!\\)\\([a-z][a-z0-9]*)$/i);
        if (!token || !symbols.has(token[1])) return null;
        return { start: token.index, name: token[1] };
    }

    function textOffset(editor, node, offset) {
        const prefix = editor.ownerDocument.createRange();
        prefix.selectNodeContents(editor);
        prefix.setEnd(node, offset);
        return prefix.toString().length;
    }

    function editableRange(editor, start, end) {
        const document = editor.ownerDocument;
        function locate(offset) {
            const walker = document.createTreeWalker(editor, document.defaultView.NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (offset <= node.length) return [node, offset];
                offset -= node.length;
            }
            return [editor, editor.childNodes.length];
        }
        const range = document.createRange();
        range.setStart(...locate(start));
        range.setEnd(...locate(end));
        return range;
    }

    function readSelection(editor) {
        if (editor.tagName === 'TEXTAREA') return { start: editor.selectionStart, end: editor.selectionEnd };
        const selection = editor.ownerDocument.getSelection();
        if (selection.rangeCount) {
            const range = selection.getRangeAt(0);
            if (editor.contains(range.commonAncestorContainer)) {
                return {
                    start: textOffset(editor, range.startContainer, range.startOffset),
                    end: textOffset(editor, range.endContainer, range.endOffset),
                    range: range.cloneRange(),
                };
            }
        }
        return null;
    }

    function editorText(editor) {
        return editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent;
    }

    function replaceSelection(editor, value, selection, inputType = 'insertText') {
        const document = editor.ownerDocument;
        const { start, end } = selection;
        editor.focus({ preventScroll: true });
        let range;
        if (editor.tagName === 'TEXTAREA') {
            editor.setSelectionRange(start, end);
        } else {
            range = selection.range || editableRange(editor, start, end);
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
        }
        let inputFired = false;
        const observeInput = () => { inputFired = true; };
        editor.addEventListener('input', observeInput, { once: true });
        // Native insertion preserves the browser's text undo/redo history.
        const native = inputType === 'insertText' && document.execCommand?.('insertText', false, value);
        editor.removeEventListener('input', observeInput);
        if (!native) {
            if (range) {
                range.deleteContents();
                const node = document.createTextNode(value);
                range.insertNode(node);
                document.getSelection().collapse(node, node.length);
            } else {
                editor.setRangeText(value, start, end, 'end');
            }
        }
        if (!inputFired) {
            editor.dispatchEvent(new document.defaultView.InputEvent('input', {
                bubbles: true, data: value, inputType,
            }));
        }
        editor.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
        return native;
    }

    function pickerFor(element) {
        return element?.closest?.('.comment-symbol-picker');
    }

    function attach(editor, translate = window.PdfPreviewModalUtils?.translateText || ((key, params) =>
        key.replace(/%\(([^)]+)\)s/g, (_, name) => params[name])),
        getStorage = () => editor.ownerDocument.defaultView.localStorage) {
        const document = editor.ownerDocument;
        const existing = editor.nextElementSibling;
        if (existing?.classList.contains('comment-symbol-picker')) return existing;

        const root = document.createElement('div');
        root.className = 'comment-symbol-picker';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'comment-symbol-toggle';
        toggle.textContent = 'Ω';
        toggle.title = translate('Insert symbol');
        toggle.setAttribute('aria-label', toggle.title);
        toggle.setAttribute('aria-expanded', 'false');
        const panel = document.createElement('div');
        panel.className = 'comment-symbol-panel';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', toggle.title);
        panel.hidden = true;
        // The top layer avoids clipping by the PDF viewport and scrolling sidebar.
        const anchored = panel.showPopover && document.defaultView.CSS?.supports('position-area: block-end span-inline-end');
        if (anchored) panel.popover = 'manual';
        root.append(toggle, panel);
        editor.after(root);

        let recent = [];
        let undo;
        let rows;
        let savedSelection;

        function loadRecents() {
            try {
                const saved = JSON.parse(getStorage().getItem(storageKey));
                if (Array.isArray(saved)) recent = [...new Set(saved)].filter(name => symbols.has(name)).slice(0, 8);
            } catch {
                // A blocked or corrupt store leaves the in-memory row usable.
            }
        }

        function remember(name) {
            loadRecents();
            recent = [name, ...recent.filter(item => item !== name)].slice(0, 8);
            try {
                getStorage().setItem(storageKey, JSON.stringify(recent));
            } catch {
                // The picker remains usable without persistence.
            }
        }

        function close() {
            if (anchored && panel.matches(':popover-open')) panel.hidePopover();
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }

        function insert(name, selection, suffix = '') {
            const { start, end } = selection;
            const original = editorText(editor).slice(start, end);
            const text = symbols.get(name).glyph + suffix;
            const native = replaceSelection(editor, text, selection);
            if (!native) undo = { start, end: start + text.length, original, value: editorText(editor) };
            remember(name);
        }

        function addGroup(label, names) {
            const group = document.createElement('div');
            group.className = 'comment-symbol-group';
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', translate(label));
            for (let offset = 0; offset < names.length; offset += columns) {
                const row = document.createElement('div');
                row.className = 'comment-symbol-row';
                const buttons = names.slice(offset, offset + columns).map(name => {
                    const { glyph, label, hidden } = symbols.get(name);
                    const spoken = hidden
                        ? translate('Uppercase %(letter)s', { letter: translate(label) })
                        : translate(label);
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.tabIndex = -1;
                    cell.textContent = glyph;
                    cell.setAttribute('aria-label', spoken);
                    cell.title = spoken + ' (\\' + name + ')';
                    cell.addEventListener('click', () => {
                        const end = editorText(editor).length;
                        const selection = savedSelection || readSelection(editor) || { start: end, end };
                        close();
                        insert(name, selection);
                    });
                    return cell;
                });
                row.append(...buttons);
                rows.push(buttons);
                group.append(row);
            }
            panel.append(group);
        }

        toggle.addEventListener('click', () => {
            if (!panel.hidden) {
                close();
                return;
            }
            loadRecents();
            rows = [];
            panel.replaceChildren();
            if (recent.length) addGroup('Recently used symbols', recent);
            groups.forEach(([label, entries]) => {
                addGroup(label, entries.map(([name]) => name).filter(name => !symbols.get(name).hidden));
            });
            panel.hidden = false;
            if (anchored) panel.showPopover({ source: toggle });
            toggle.setAttribute('aria-expanded', 'true');
            rows[0][0].focus({ preventScroll: true });
        });

        for (const type of ['pointerdown', 'mousedown', 'click']) {
            root.addEventListener(type, event => event.stopPropagation());
        }
        root.addEventListener('focusout', event => {
            if (!root.contains(event.relatedTarget)) close();
        });
        root.addEventListener('keydown', event => {
            // Typing on palette controls must not activate the PDF markup toolbar.
            event.stopPropagation();
            if (panel.hidden) return;
            const { key, target } = event;
            if (key === 'Escape') {
                event.preventDefault();
                close();
                toggle.focus({ preventScroll: true });
                return;
            }
            const row = rows.findIndex(cells => cells.includes(target));
            if (row < 0) return;
            const column = rows[row].indexOf(target);
            const buttons = rows.flat();
            const index = buttons.indexOf(target);
            const vertical = delta => {
                const next = rows[(row + delta + rows.length) % rows.length];
                return next[Math.min(column, next.length - 1)];
            };
            const moves = {
                ArrowLeft: () => buttons[(index - 1 + buttons.length) % buttons.length],
                ArrowRight: () => buttons[(index + 1) % buttons.length],
                ArrowUp: () => vertical(-1),
                ArrowDown: () => vertical(1),
                Enter: () => target,
            };
            if (!Object.hasOwn(moves, key)) return;
            event.preventDefault();
            if (key === 'Enter') target.click();
            else moves[key]().focus({ preventScroll: true });
        });

        editor.addEventListener('focus', () => { savedSelection = undefined; });
        editor.addEventListener('blur', () => { savedSelection = readSelection(editor); });
        editor.addEventListener('input', () => { undo = undefined; });
        editor.addEventListener('keydown', event => {
            if (event.isComposing || event.altKey || event.shiftKey) return;
            const modified = event.ctrlKey || event.metaKey;
            const value = editorText(editor);
            if (undo && value === undo.value && modified && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                replaceSelection(editor, undo.original, undo, 'historyUndo');
                return;
            }
            if (modified || (event.key !== ' ' && event.key !== 'Tab')) return;
            const selection = readSelection(editor);
            const shortcut = selection && shortcutAt(value, selection.start, selection.end);
            if (!shortcut) return;
            event.preventDefault();
            insert(shortcut.name, { start: shortcut.start, end: selection.end }, event.key === ' ' ? ' ' : '');
        });

        return root;
    }

    exports.attach = attach;
    exports.pickerFor = pickerFor;
    exports.hasOpenPicker = element => Boolean(pickerFor(element)?.querySelector('[aria-expanded="true"]'));
    exports.shortcutAt = shortcutAt;
})(window.PdfCommentSymbols = {});
