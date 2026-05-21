/**
 * PDF Preview Modal - Markup Toolbar
 *
 * Floating, draggable toolbar for drawing/text markup tools.
 * Appears when the user activates "Markup" mode in the PDF preview modal.
 *
 * @module pdf-preview-modal/markup-toolbar
 */

window.PdfPreviewModalMarkupToolbar = window.PdfPreviewModalMarkupToolbar || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    var TOOLS = [
        { id: 'select', label: 'Select', icon: '\u2196', shortcut: 'V' },
        { id: 'text', label: 'Text', icon: 'T', shortcut: 'T' },
        { id: 'pen', label: 'Pen', icon: '\u270E', shortcut: 'P' },
        {
            id: 'highlighter',
            label: 'Highlight',
            shortcut: 'H',
            iconHtml: '' +
                '<svg class="markup-toolbar-icon-svg markup-toolbar-icon-highlighter" viewBox="0 0 24 24" aria-hidden="true">' +
                    '<path class="toolbar-icon-solid" d="M15.6 4.8l3.6 3.6-7.6 7.6H8v-3.6z"></path>' +
                    '<path class="toolbar-icon-solid toolbar-icon-muted" d="M6.2 18.1h11.6v2H6.2z"></path>' +
                '</svg>'
        }
    ];

    var FALLBACK_COLORS = [
        { name: 'orange', value: '#f59e0b' },
        { name: 'red', value: '#ef4444' },
        { name: 'green', value: '#22c55e' },
        { name: 'black', value: '#1e1e1e' },
        { name: 'white', value: '#ffffff' }
    ];

    var STORAGE_KEY = 'aems-markup-toolbar-position';

    // =========================================================================
    // State
    // =========================================================================

    /** @type {HTMLElement|null} */
    var toolbarEl = null;

    /** @type {string} */
    var activeTool = 'select';

    /** @type {string} */
    var activeColor = '';

    // Drag state
    var dragState = {
        active: false,
        startX: 0,
        startY: 0,
        initialLeft: 0,
        initialTop: 0
    };

    // Bound listeners (for cleanup)
    var boundKeydown = null;
    var boundPointerMove = null;
    var boundPointerUp = null;

    // =========================================================================
    // Callbacks
    // =========================================================================

    /** @type {Function|null} */
    exports.onToolChange = null;

    /** @type {Function|null} */
    exports.onColorChange = null;

    // =========================================================================
    // Helpers
    // =========================================================================

    /**
     * Resolve preset colors from the drawing canvas module or use fallbacks.
     * @returns {Array<{name: string, value: string}>}
     */
    function getColors() {
        if (window.PdfPreviewModalDrawingCanvas &&
            typeof window.PdfPreviewModalDrawingCanvas.getPresetColors === 'function') {
            return window.PdfPreviewModalDrawingCanvas.getPresetColors();
        }
        return FALLBACK_COLORS;
    }

    /**
     * Check if an element is an interactive input that should swallow keys.
     * @param {HTMLElement} el
     * @returns {boolean}
     */
    function isEditableTarget(el) {
        if (!el) return false;
        var tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    /**
     * Try to restore saved position from localStorage.
     * @returns {{left: number, top: number}|null}
     */
    function loadSavedPosition() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var pos = JSON.parse(raw);
            if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
                return pos;
            }
        } catch (_) {
            // ignore
        }
        return null;
    }

    /**
     * Persist current toolbar position to localStorage.
     */
    function savePosition() {
        if (!toolbarEl) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                left: toolbarEl.offsetLeft,
                top: toolbarEl.offsetTop
            }));
        } catch (_) {
            // ignore
        }
    }

    /**
     * Clamp toolbar position so it stays within the viewport.
     * @param {number} left
     * @param {number} top
     * @returns {{left: number, top: number}}
     */
    function clampToViewport(left, top) {
        if (!toolbarEl) return { left: left, top: top };
        var w = toolbarEl.offsetWidth || 200;
        var h = toolbarEl.offsetHeight || 60;
        var maxLeft = window.innerWidth - w;
        var maxTop = window.innerHeight - h;
        return {
            left: Math.max(0, Math.min(left, maxLeft)),
            top: Math.max(0, Math.min(top, maxTop))
        };
    }

    function getColorCssValue(color) {
        if (!color) return '';
        if (color.value) return color.value;
        if (Array.isArray(color.rgb) && color.rgb.length === 3) {
            return 'rgb(' + color.rgb.join(',') + ')';
        }
        return '';
    }

    // =========================================================================
    // DOM Construction
    // =========================================================================

    /**
     * Build the toolbar DOM inside the given container.
     * @param {HTMLElement} containerEl
     */
    exports.create = function create(containerEl) {
        if (toolbarEl) return; // already created

        var colors = getColors();

        // Outer wrapper
        toolbarEl = document.createElement('div');
        toolbarEl.className = 'markup-toolbar';
        toolbarEl.style.display = 'none';

        // --- Tools row ---
        var toolsRow = document.createElement('div');
        toolsRow.className = 'markup-toolbar-tools';

        TOOLS.forEach(function (tool) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'markup-toolbar-btn js-markup-tool';
            btn.setAttribute('data-tool', tool.id);
            btn.setAttribute('title', tool.label + ' (' + tool.shortcut + ')');
            if (tool.iconHtml) {
                btn.innerHTML = tool.iconHtml;
            } else {
                btn.textContent = tool.icon;
            }
            toolsRow.appendChild(btn);
        });

        toolbarEl.appendChild(toolsRow);

        // --- Separator ---
        var sep = document.createElement('div');
        sep.className = 'markup-toolbar-separator js-markup-color-separator';
        toolbarEl.appendChild(sep);

        // --- Colors row ---
        var colorsRow = document.createElement('div');
        colorsRow.className = 'markup-toolbar-colors js-markup-colors-row';

        colors.forEach(function (color) {
            var swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'markup-toolbar-color js-markup-color';
            swatch.setAttribute('data-color-name', color.name);
            swatch.style.backgroundColor = getColorCssValue(color);
            swatch.setAttribute('title', color.name);
            colorsRow.appendChild(swatch);
        });

        toolbarEl.appendChild(colorsRow);

        // Append to container
        containerEl.appendChild(toolbarEl);

        // --- Restore saved position ---
        var saved = loadSavedPosition();
        if (saved) {
            var clamped = clampToViewport(saved.left, saved.top);
            toolbarEl.style.left = clamped.left + 'px';
            toolbarEl.style.top = clamped.top + 'px';
        }

        // --- Set defaults ---
        exports.setActiveTool('select');
        if (colors.length > 0) {
            exports.setActiveColor(colors[0].name);
        }

        // --- Wire up click handlers ---
        toolbarEl.addEventListener('click', function (e) {
            var target = /** @type {HTMLElement} */ (e.target);

            // Tool button click
            var toolBtn = target.closest('.js-markup-tool');
            if (toolBtn) {
                var toolId = toolBtn.getAttribute('data-tool');
                if (toolId) exports.setActiveTool(toolId);
                return;
            }

            // Color swatch click
            var colorBtn = target.closest('.js-markup-color');
            if (colorBtn) {
                var colorName = colorBtn.getAttribute('data-color-name');
                if (colorName) exports.setActiveColor(colorName);
                return;
            }
        });

        // --- Wire up draggable ---
        toolbarEl.addEventListener('pointerdown', onPointerDown);

        // --- Wire up keyboard shortcuts ---
        boundKeydown = onKeydown;
        document.addEventListener('keydown', boundKeydown);
    };

    // =========================================================================
    // Visibility
    // =========================================================================

    /**
     * Show the markup toolbar.
     */
    exports.show = function show() {
        if (toolbarEl) toolbarEl.style.display = '';
    };

    /**
     * Hide the markup toolbar.
     */
    exports.hide = function hide() {
        if (toolbarEl) toolbarEl.style.display = 'none';
    };

    /**
     * Check whether the toolbar is currently visible.
     * @returns {boolean}
     */
    exports.isVisible = function isVisible() {
        if (!toolbarEl) return false;
        return toolbarEl.style.display !== 'none';
    };

    // =========================================================================
    // Active Tool / Color
    // =========================================================================

    /**
     * Set the active tool and update button states.
     * @param {string} toolId
     */
    exports.setActiveTool = function setActiveTool(toolId) {
        activeTool = toolId;
        if (!toolbarEl) return;

        var buttons = toolbarEl.querySelectorAll('.js-markup-tool');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (btn.getAttribute('data-tool') === toolId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }

        // Hide colors + separator when select tool is active (no drawing)
        var showColors = toolId !== 'select';
        var colorsRow = toolbarEl.querySelector('.js-markup-colors-row');
        var colorSep = toolbarEl.querySelector('.js-markup-color-separator');
        if (colorsRow) colorsRow.style.display = showColors ? '' : 'none';
        if (colorSep) colorSep.style.display = showColors ? '' : 'none';

        if (typeof exports.onToolChange === 'function') {
            exports.onToolChange(toolId);
        }
    };

    /**
     * Set the active color swatch.
     * @param {string} colorName
     */
    exports.setActiveColor = function setActiveColor(colorName) {
        activeColor = colorName;
        if (!toolbarEl) return;

        var swatches = toolbarEl.querySelectorAll('.js-markup-color');
        for (var i = 0; i < swatches.length; i++) {
            var swatch = swatches[i];
            if (swatch.getAttribute('data-color-name') === colorName) {
                swatch.classList.add('active');
            } else {
                swatch.classList.remove('active');
            }
        }

        if (typeof exports.onColorChange === 'function') {
            exports.onColorChange(colorName);
        }
    };

    /**
     * Get the current active tool id.
     * @returns {string}
     */
    exports.getActiveTool = function getActiveTool() {
        return activeTool;
    };

    /**
     * Get the current active color name.
     * @returns {string}
     */
    exports.getActiveColor = function getActiveColor() {
        return activeColor;
    };

    // =========================================================================
    // Draggable Behavior
    // =========================================================================

    /**
     * @param {PointerEvent} e
     */
    function onPointerDown(e) {
        // Only drag from the toolbar background, not from buttons
        var target = /** @type {HTMLElement} */ (e.target);
        if (target.closest('.js-markup-tool') || target.closest('.js-markup-color')) {
            return;
        }
        if (e.button !== 0) return;

        e.preventDefault();

        dragState.active = true;
        dragState.startX = e.clientX;
        dragState.startY = e.clientY;
        dragState.initialLeft = toolbarEl.offsetLeft;
        dragState.initialTop = toolbarEl.offsetTop;

        toolbarEl.classList.add('dragging');
        toolbarEl.setPointerCapture(e.pointerId);

        boundPointerMove = onPointerMove;
        boundPointerUp = onPointerUp;
        document.addEventListener('pointermove', boundPointerMove);
        document.addEventListener('pointerup', boundPointerUp);
    }

    /**
     * @param {PointerEvent} e
     */
    function onPointerMove(e) {
        if (!dragState.active || !toolbarEl) return;

        var dx = e.clientX - dragState.startX;
        var dy = e.clientY - dragState.startY;
        var newLeft = dragState.initialLeft + dx;
        var newTop = dragState.initialTop + dy;

        var clamped = clampToViewport(newLeft, newTop);
        toolbarEl.style.left = clamped.left + 'px';
        toolbarEl.style.top = clamped.top + 'px';
    }

    /**
     * @param {PointerEvent} e
     */
    function onPointerUp(e) {
        if (!dragState.active) return;

        dragState.active = false;
        if (toolbarEl) {
            toolbarEl.classList.remove('dragging');
            try { toolbarEl.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        }

        document.removeEventListener('pointermove', boundPointerMove);
        document.removeEventListener('pointerup', boundPointerUp);
        boundPointerMove = null;
        boundPointerUp = null;

        savePosition();
    }

    // =========================================================================
    // Keyboard Shortcuts
    // =========================================================================

    /**
     * @param {KeyboardEvent} e
     */
    function onKeydown(e) {
        if (!exports.isVisible()) return;
        if (isEditableTarget(/** @type {HTMLElement} */ (e.target))) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        var key = e.key.toUpperCase();

        // Tool shortcuts
        for (var i = 0; i < TOOLS.length; i++) {
            if (TOOLS[i].shortcut === key) {
                e.preventDefault();
                exports.setActiveTool(TOOLS[i].id);
                return;
            }
        }

        // Color shortcuts: 1-6
        var colors = getColors();
        var num = parseInt(e.key, 10);
        if (num >= 1 && num <= colors.length) {
            e.preventDefault();
            exports.setActiveColor(colors[num - 1].name);
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Remove toolbar element and all listeners.
     */
    exports.destroy = function destroy() {
        if (boundKeydown) {
            document.removeEventListener('keydown', boundKeydown);
            boundKeydown = null;
        }
        if (boundPointerMove) {
            document.removeEventListener('pointermove', boundPointerMove);
            boundPointerMove = null;
        }
        if (boundPointerUp) {
            document.removeEventListener('pointerup', boundPointerUp);
            boundPointerUp = null;
        }

        if (toolbarEl) {
            toolbarEl.remove();
            toolbarEl = null;
        }

        activeTool = 'select';
        activeColor = '';
        exports.onToolChange = null;
        exports.onColorChange = null;
    };

})(window.PdfPreviewModalMarkupToolbar);

// Version marker
window.PdfPreviewModalMarkupToolbar._version = '1.0.0';

// Also expose via AEMS namespace
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.markupToolbar = window.PdfPreviewModalMarkupToolbar;
