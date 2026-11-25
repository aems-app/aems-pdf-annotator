(function (exports) {
    'use strict';

    // Shortcut, Unicode text, optional spoken label.
    // Keep the entries JSON-compatible so the Python paint and Unicode tests read the same map.
    const commentSymbolGroups = [
        ["Greek lowercase", [
            ["alpha", "α"], ["beta", "β"], ["gamma", "γ"],
            ["delta", "δ"], ["epsilon", "ε"], ["zeta", "ζ"],
            ["eta", "η"], ["theta", "θ"], ["iota", "ι"],
            ["kappa", "κ"], ["lambda", "λ"], ["mu", "μ"],
            ["nu", "ν"], ["xi", "ξ"], ["omicron", "ο"],
            ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"],
            ["tau", "τ"], ["upsilon", "υ"], ["phi", "ϕ"],
            ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"],
            ["varphi", "φ", "variant phi"], ["vartheta", "ϑ", "variant theta"]
        ]],
        ["Greek uppercase", [
            ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"],
            ["Lambda", "Λ"], ["Xi", "Ξ"], ["Pi", "Π"],
            ["Sigma", "Σ"], ["Phi", "Φ"],
            ["Psi", "Ψ"], ["Omega", "Ω"]
        ]],
        ["Math symbols", [
            ["pm", "±", "plus-minus"], ["times", "×", "multiplication"], ["cdot", "·", "middle dot"],
            ["div", "÷", "division"], ["deg", "°", "degree"], ["approx", "≈", "approximately equal"],
            ["ne", "≠", "not equal"], ["le", "≤", "less than or equal"], ["ge", "≥", "greater than or equal"],
            ["inf", "∞", "infinity"], ["sqrt", "√", "square root"], ["partial", "∂", "partial derivative"],
            ["nabla", "∇", "nabla"], ["sum", "∑", "summation"], ["int", "∫", "integral"],
            ["to", "→", "right arrow"], ["implies", "⇒", "implies"], ["propto", "∝", "proportional to"],
            ["prime", "′", "prime"], ["dprime", "″", "double prime"], ["sup2", "²", "superscript two"],
            ["sup3", "³", "superscript three"], ["inv", "⁻¹", "superscript minus one"], ["sub0", "₀", "subscript zero"],
            ["sub1", "₁", "subscript one"], ["sub2", "₂", "subscript two"], ["subx", "ₓ", "subscript x"]
        ]]
    ];
    const symbols = new Map(commentSymbolGroups.flatMap(([, entries]) => entries.map(
        ([name, glyph, label = name]) => [name, { glyph, label }],
    )));
    const pickerMsgid = 'Insert symbol';
    const toggleTitleMsgid = 'Insert symbol (Shift+Space to skip shortcut conversion)';
    const recentsMsgid = 'Recently used symbols';
    // Every msgid a picker can show; their translations decide whether a relabel has work to do.
    const labelMsgids = Object.freeze([pickerMsgid, toggleTitleMsgid, recentsMsgid,
        ...commentSymbolGroups.flatMap(([label, entries]) => [label, ...entries.map(
            ([name, , spoken = name]) => spoken,
        )])]);
    const catalogEvents = ['i18nReady', 'localeChanged'];
    const storageKey = 'aems.annotation.recentSymbols';
    const columns = 10;

    function shortcutAt(value, start, end) {
        if (start !== end) return null;
        const token = value.slice(0, start).match(/(?:^|[\s\p{Ps}<])(\\([a-z][a-z0-9]*))$/iu);
        if (!token || !symbols.has(token[2])) return null;
        return { start: start - token[1].length, name: token[2] };
    }

    function shortcutAtSelection(editor, value, selection) {
        const { start, end, range } = selection;
        const shortcut = shortcutAt(value, start, end);
        if (shortcut || !range?.collapsed) return shortcut;
        const node = range.endContainer;
        // Range.toString() omits line breaks represented by editable HTML.
        if (node.nodeType !== 3) return null;
        const block = node.parentElement;
        const startsLine = node.previousSibling?.nodeName === 'BR'
            || (block !== editor && node === block.firstChild && block.matches('div, p'));
        if (!startsLine) return null;
        const local = shortcutAt(node.data, range.endOffset, range.endOffset);
        return local && { ...local, start: end - range.endOffset + local.start };
    }

    function textOffset(editor, node, offset) {
        const prefix = editor.ownerDocument.createRange();
        prefix.selectNodeContents(editor);
        prefix.setEnd(node, offset);
        return prefix.toString().length;
    }

    function editableRange(editor, start, end) {
        const document = editor.ownerDocument;
        function locate(offset, preferNext = false) {
            const walker = document.createTreeWalker(editor, document.defaultView.NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (offset < node.length || (offset === node.length && !preferNext)) return [node, offset];
                offset -= node.length;
            }
            return [editor, editor.childNodes.length];
        }
        const range = document.createRange();
        range.setStart(...locate(start, start !== end));
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

    function replaceSelection(editor, value, selection, inputType = 'insertText', notifyChange = true) {
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
        if (notifyChange) editor.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
        return native;
    }

    function collapseCaret(editor, offset) {
        if (editor.tagName === 'TEXTAREA') {
            editor.setSelectionRange(offset, offset);
            return;
        }
        const selection = editor.ownerDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(editableRange(editor, offset, offset));
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
        toggle.setAttribute('aria-haspopup', 'dialog');
        toggle.setAttribute('aria-expanded', 'false');
        const panel = document.createElement('div');
        panel.className = 'comment-symbol-panel';
        panel.setAttribute('role', 'dialog');
        panel.hidden = true;
        // The top layer avoids clipping by the PDF viewport and scrolling sidebar.
        const view = document.defaultView;
        const topLayer = typeof panel.showPopover === 'function';
        if (topLayer) panel.setAttribute('popover', 'manual');
        root.append(toggle, panel);
        editor.after(root);

        let recent = [];
        let history;
        let nativeConversion;
        let suppressed;
        let positionListeners;
        let rows;
        let savedSelection;

        // The host catalog may load after attach, so labels are recomputed lazily.
        // A relabel with unchanged translations is skipped unless forced, which
        // opening the panel does because it rebuilds every cell.
        let appliedLabels;
        function relabel(force) {
            const translated = labelMsgids.map(msgid => translate(msgid)).join('\u0000');
            if (!force && translated === appliedLabels) return;
            appliedLabels = translated;
            const pickerLabel = translate(pickerMsgid);
            toggle.title = translate(toggleTitleMsgid);
            toggle.setAttribute('aria-label', pickerLabel);
            panel.setAttribute('aria-label', pickerLabel);
            panel.querySelectorAll('[data-msgid]').forEach(element => {
                const text = translate(element.dataset.msgid);
                element.setAttribute('aria-label', text);
                if (element.dataset.symbol) element.title = text + ' (\\' + element.dataset.symbol + ')';
            });
        }
        const refreshLabels = () => relabel(false);
        refreshLabels();
        toggle.addEventListener('focus', refreshLabels);
        toggle.addEventListener('pointerenter', refreshLabels);
        // The host announces its catalog on window, so a screen-reader user who
        // never touches the toggle still hears it translated. A picker that has
        // left the document drops these listeners on the next announcement.
        let wasConnected = root.isConnected;
        const catalogListeners = new view.AbortController();
        const onCatalog = () => {
            if (root.isConnected) {
                wasConnected = true;
                refreshLabels();
            } else if (wasConnected) {
                catalogListeners.abort();
            }
        };
        catalogEvents.forEach(type => view.addEventListener(type, onCatalog, { signal: catalogListeners.signal }));

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

        function positionPanel() {
            if (!root.isConnected) {
                close();
                return;
            }
            const anchor = toggle.getBoundingClientRect();
            const { width, height } = panel.getBoundingClientRect();
            const viewportWidth = document.documentElement.clientWidth;
            const viewportHeight = document.documentElement.clientHeight;
            const gap = 4;
            const below = anchor.bottom + gap;
            const above = anchor.top - height - gap;
            panel.style.left = Math.max(gap, Math.min(anchor.left, viewportWidth - width - gap)) + 'px';
            panel.style.top = Math.max(gap, below + height <= viewportHeight - gap ? below : above) + 'px';
        }

        function close() {
            if (panel.hidden) return;
            positionListeners.abort();
            if (topLayer) panel.hidePopover();
            panel.hidden = true;
            toggle.setAttribute('aria-expanded', 'false');
        }

        function insert(name, selection, trigger) {
            const { start, end } = selection;
            const glyph = symbols.get(name).glyph;
            const original = editorText(editor).slice(start, end);
            const delimiter = trigger === 'Tab' ? '\t' : ' ';
            const converted = glyph + (trigger === ' ' ? delimiter : '');
            let typed = original;
            let replaceThrough = end;
            // A Tab in a contenteditable never types a character (it moves focus),
            // and Chrome would render an inserted one as a styled span, so it
            // gets no delimiter at all.
            if (trigger !== undefined && !(trigger === 'Tab' && selection.caret)) {
                // Put the actual typed delimiter into the browser history before
                // replacing the complete token. Native Undo then restores both.
                replaceSelection(editor, delimiter, { start: end, end, range: selection.caret }, 'insertText', false);
                typed += delimiter;
                replaceThrough += delimiter.length;
            }
            const typedValue = editorText(editor);
            const native = replaceSelection(editor, converted, { ...selection, end: replaceThrough });
            const token = trigger === undefined ? undefined : original;
            if (native) {
                if (token !== undefined) nativeConversion = { start, end: replaceThrough, token, typedValue };
            } else {
                history = { start, typed, converted, token, value: editorText(editor), undone: false };
            }
            remember(name);
        }

        function addGroup(label, names) {
            const group = document.createElement('div');
            group.className = 'comment-symbol-group';
            group.setAttribute('role', 'group');
            group.dataset.msgid = label;
            for (let offset = 0; offset < names.length; offset += columns) {
                const row = document.createElement('div');
                row.className = 'comment-symbol-row';
                const buttons = names.slice(offset, offset + columns).map(name => {
                    const { glyph, label } = symbols.get(name);
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.tabIndex = -1;
                    if (/^(?:sub|sup)|^(?:inv|d?prime)$/.test(name)) {
                        const visual = document.createElement('span');
                        visual.className = 'comment-symbol-small-glyph';
                        visual.textContent = glyph;
                        cell.append(visual);
                    } else {
                        cell.textContent = glyph;
                    }
                    cell.dataset.msgid = label;
                    cell.dataset.symbol = name;
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
            if (recent.length) addGroup(recentsMsgid, recent);
            commentSymbolGroups.forEach(([label, entries]) => {
                addGroup(label, entries.map(([name]) => name));
            });
            relabel(true);
            panel.hidden = false;
            if (topLayer) panel.showPopover();
            positionListeners = new view.AbortController();
            positionPanel();
            const { signal } = positionListeners;
            view.addEventListener('resize', positionPanel, { signal });
            view.addEventListener('scroll', positionPanel, { signal, capture: true });
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
                Home: () => (event.ctrlKey ? buttons : rows[row])[0],
                End: () => (event.ctrlKey ? buttons : rows[row]).at(-1),
            };
            if (key === 'Enter') {
                event.preventDefault();
                target.click();
            } else if (Object.hasOwn(moves, key)) {
                event.preventDefault();
                moves[key]().focus({ preventScroll: true });
            }
        });

        editor.addEventListener('focus', () => { savedSelection = undefined; });
        editor.addEventListener('blur', () => { savedSelection = readSelection(editor); });
        editor.addEventListener('input', event => {
            history = undefined;
            const value = editorText(editor);
            if (suppressed && value.slice(suppressed.start, suppressed.end) !== suppressed.token) {
                suppressed = undefined;
            }
            if (event.inputType === 'historyUndo' && nativeConversion?.typedValue === value) {
                const { start, end, token } = nativeConversion;
                suppressed = { start, end: start + token.length, token };
                // Chrome selects the restored text; the next keystroke would erase it.
                collapseCaret(editor, end);
            }
        });
        editor.addEventListener('keydown', event => {
            if (event.isComposing || event.altKey) return;
            const modified = event.ctrlKey || event.metaKey;
            const value = editorText(editor);
            const key = event.key.toLowerCase();
            if (history && value === history.value && modified) {
                const undo = key === 'z' && !event.shiftKey && !history.undone;
                const redo = (key === 'y' || (key === 'z' && event.shiftKey)) && history.undone;
                if (undo || redo) {
                    event.preventDefault();
                    const entry = history;
                    const { start, typed, converted, token } = entry;
                    replaceSelection(editor, undo ? typed : converted, {
                        start, end: start + (undo ? converted : typed).length,
                    }, undo ? 'historyUndo' : 'historyRedo');
                    history = { ...entry, value: editorText(editor), undone: undo };
                    if (undo && token !== undefined) suppressed = { start, end: start + token.length, token };
                    return;
                }
            }
            if (event.shiftKey || modified || (event.key !== ' ' && event.key !== 'Tab')) return;
            const selection = readSelection(editor);
            const shortcut = selection && shortcutAtSelection(editor, value, selection);
            if (!shortcut || (suppressed?.start === shortcut.start && suppressed.end === selection.end)) return;
            event.preventDefault();
            insert(shortcut.name, { start: shortcut.start, end: selection.end, caret: selection.range }, event.key);
        });

        return root;
    }

    exports.attach = attach;
    exports.pickerFor = pickerFor;
    exports.hasOpenPicker = element => Boolean(pickerFor(element)?.querySelector('[aria-expanded="true"]'));
    exports.shortcutAt = shortcutAt;
})(window.PdfCommentSymbols = {});
