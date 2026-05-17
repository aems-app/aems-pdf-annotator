/**
 * PDF Preview Modal - Text Box Module
 *
 * Manages DOM-based contenteditable text box elements positioned on PDF pages.
 * Supports creation, editing, hit testing, loading from annotations, and cleanup.
 *
 * @module pdf-preview-modal/textbox
 */

// Namespace for PDF Preview Modal textbox helpers
window.PdfPreviewModalTextbox = window.PdfPreviewModalTextbox || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    exports.DEFAULT_WIDTH = 56;
    exports.DEFAULT_HEIGHT = 28;
    exports.DEFAULT_FONT_SIZE = 13;
    exports.MIN_WIDTH = 28;
    exports.MIN_HEIGHT = 28;
    exports.MAX_WIDTH_RATIO = 0.38;
    exports.MAX_WIDTH_PX = 220;
    exports.MIN_MAX_WIDTH = 120;

    // =========================================================================
    // State
    // =========================================================================

    /** @type {Map<number, Array<Object>>} pageIdx -> [{element, annotationId, pageIdx, content, color}] */
    var pageTextboxes = new Map();

    /** @type {HTMLElement|null} Hidden measurement node reused for autosize calculations */
    var measureElement = null;

    // =========================================================================
    // Callbacks
    // =========================================================================

    /** @type {Function|null} Called when a textbox is committed with content */
    exports.onTextboxCommitted = null;

    /** @type {Function|null} Called when a textbox is deleted */
    exports.onTextboxDeleted = null;

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /**
     * Get or create the textbox layer for a page wrapper.
     *
     * @param {HTMLElement} pageWrapper - The page wrapper element
     * @returns {HTMLElement} The textbox layer div
     */
    function getOrCreateTextboxLayer(pageWrapper) {
        var layer = pageWrapper.querySelector('.textbox-layer');
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'textbox-layer';
            pageWrapper.appendChild(layer);
        }
        return layer;
    }

    /**
     * Get the canvas scale factor for a page wrapper.
     *
     * @param {HTMLElement} pageWrapper - The page wrapper element
     * @returns {{scaleX: number, scaleY: number}}
     */
    function getCanvasScale(pageWrapper) {
        var canvas = pageWrapper.querySelector('canvas');
        if (!canvas) {
            return { scaleX: 1, scaleY: 1 };
        }
        var displayWidth = canvas.offsetWidth || canvas.width;
        var displayHeight = canvas.offsetHeight || canvas.height;
        return {
            scaleX: displayWidth / canvas.width,
            scaleY: displayHeight / canvas.height
        };
    }

    /**
     * Resolve the page wrapper for a textbox entry.
     *
     * @param {Object} entry
     * @returns {HTMLElement|null}
     */
    function getPageWrapperForEntry(entry) {
        if (!entry || !entry.element) return null;
        return entry.element.closest('.pdf-page-wrapper');
    }

    /**
     * Compute the maximum textbox width for a page.
     * Short grading notes should hug the text, but still wrap gracefully.
     *
     * @param {HTMLElement|null} pageWrapper
     * @returns {number}
     */
    function getTextboxWidthLimit(pageWrapper) {
        var canvas = pageWrapper ? pageWrapper.querySelector('canvas') : null;
        var pageWidth = canvas ? (canvas.offsetWidth || canvas.width || 0) : 0;
        if (!pageWidth) {
            return exports.MAX_WIDTH_PX;
        }
        return Math.max(
            exports.MIN_MAX_WIDTH,
            Math.min(exports.MAX_WIDTH_PX, Math.round(pageWidth * exports.MAX_WIDTH_RATIO))
        );
    }

    /**
     * Place cursor at the end of a contenteditable element.
     *
     * @param {HTMLElement} element - The contenteditable element
     */
    function placeCursorAtEnd(element) {
        var range = document.createRange();
        var sel = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function resolveColorData(color) {
        if (color && Array.isArray(color.rgb)) {
            return {
                css: 'rgb(' + color.rgb.join(',') + ')',
                value: { name: color.name || '', rgb: color.rgb.slice() }
            };
        }
        if (typeof color === 'string' && color) {
            return {
                css: color,
                value: color
            };
        }
        return {
            css: '#000',
            value: { name: 'black', rgb: [0, 0, 0] }
        };
    }

    /**
     * Best-effort element removal for textbox refresh/blur races.
     *
     * Refresh can overlap with blur cleanup for contenteditable nodes, so
     * missing-parent detach errors should be treated as no-ops.
     *
     * @param {HTMLElement|null|undefined} element
     */
    function safeRemoveElement(element) {
        if (!element) return;
        try {
            if (element.parentNode && element.parentNode.contains(element)) {
                element.parentNode.removeChild(element);
            }
        } catch (_) {
            // Ignore detach races during textbox refresh.
        }
    }

    /**
     * Create or retrieve the hidden measurement node used for autosize.
     *
     * @returns {HTMLElement}
     */
    function getMeasureElement() {
        if (measureElement && document.body.contains(measureElement)) {
            return measureElement;
        }

        measureElement = document.createElement('div');
        measureElement.className = 'markup-textbox markup-textbox-measure';
        document.body.appendChild(measureElement);
        return measureElement;
    }

    /**
     * Create the editable content element used inside a textbox wrapper.
     *
     * @param {string} text
     * @returns {HTMLDivElement}
     */
    function createTextboxContent(text) {
        var content = document.createElement('div');
        content.className = 'markup-textbox-content';
        content.contentEditable = 'false';
        content.textContent = text || '';
        return content;
    }

    /**
     * Resolve the editable content element for a textbox entry or wrapper.
     *
     * @param {Object|HTMLElement|null|undefined} source
     * @returns {HTMLElement|null}
     */
    function getTextboxContentElement(source) {
        if (!source) return null;
        if (source.contentElement instanceof HTMLElement) {
            return source.contentElement;
        }
        if (source instanceof HTMLElement) {
            return source.querySelector('.markup-textbox-content');
        }
        if (source.element instanceof HTMLElement) {
            return source.element.querySelector('.markup-textbox-content');
        }
        return null;
    }

    /**
     * Measure the ideal textbox size for the current content.
     *
     * @param {Object} entry
     * @param {HTMLElement|null} pageWrapper
     * @param {string} [text]
     * @returns {{width: number, height: number, maxWidth: number}}
     */
    function measureTextbox(entry, pageWrapper, text) {
        var measureEl = getMeasureElement();
        var contentEl = getTextboxContentElement(entry);
        var value = typeof text === 'string' ? text : (contentEl ? contentEl.textContent : '');
        var maxWidth = getTextboxWidthLimit(pageWrapper);

        measureEl.style.fontSize = (entry && entry.element && entry.element.style.fontSize)
            ? entry.element.style.fontSize
            : exports.DEFAULT_FONT_SIZE + 'px';
        measureEl.style.maxWidth = maxWidth + 'px';
        measureEl.style.width = 'fit-content';
        measureEl.style.height = 'auto';
        measureEl.textContent = value && value.length ? value : '\u200b';

        var rect = measureEl.getBoundingClientRect();
        return {
            width: Math.max(exports.MIN_WIDTH, Math.min(maxWidth, Math.ceil(rect.width))),
            height: Math.max(exports.MIN_HEIGHT, Math.ceil(rect.height)),
            maxWidth: maxWidth
        };
    }

    /**
     * Resize a textbox so the box hugs the text while respecting a width cap.
     *
     * @param {Object} entry
     * @param {HTMLElement|null} [pageWrapper]
     * @param {string} [text]
     */
    function syncTextboxSize(entry, pageWrapper, text) {
        if (!entry || !entry.element) return;
        var wrapper = pageWrapper || getPageWrapperForEntry(entry);
        var size = measureTextbox(entry, wrapper, text);
        entry.element.style.width = size.width + 'px';
        entry.element.style.height = size.height + 'px';
        entry.element.style.minHeight = size.height + 'px';
        entry.element.style.maxWidth = size.maxWidth + 'px';
    }

    function removeEntryFromPageMap(pageIdx, entry) {
        var entries = pageTextboxes.get(pageIdx);
        if (!entries) return;
        var idx = entries.indexOf(entry);
        if (idx !== -1) {
            entries.splice(idx, 1);
        }
        if (entries.length === 0) {
            pageTextboxes.delete(pageIdx);
        }
    }

    function addEntryToPageMap(pageIdx, entry) {
        if (!pageTextboxes.has(pageIdx)) {
            pageTextboxes.set(pageIdx, []);
        }
        if (pageTextboxes.get(pageIdx).indexOf(entry) === -1) {
            pageTextboxes.get(pageIdx).push(entry);
        }
    }

    /**
     * Toggle editing mode for a textbox entry.
     *
     * @param {Object} entry
     * @param {boolean} editing
     */
    function setTextboxEditing(entry, editing) {
        if (!entry || !entry.element) return;
        var contentEl = getTextboxContentElement(entry);
        entry.element.classList.toggle('editing', !!editing);
        if (contentEl) {
            contentEl.contentEditable = editing ? 'true' : 'false';
        }
    }

    /**
     * Commit the current textbox content or delete the textbox if empty.
     *
     * @param {number} pageIdx
     * @param {Object} entry
     */
    function commitTextbox(pageIdx, entry) {
        if (!entry || !entry.element) return;
        var contentEl = getTextboxContentElement(entry);
        var text = contentEl ? contentEl.textContent.trim() : '';

        setTextboxEditing(entry, false);

        if (!text) {
            exports.removeTextbox(pageIdx, entry);
            if (typeof exports.onTextboxDeleted === 'function') {
                exports.onTextboxDeleted(entry);
            }
            return;
        }

        entry.content = text;
        if (contentEl) {
            contentEl.textContent = text;
        }
        syncTextboxSize(entry, null, text);
        if (typeof exports.onTextboxCommitted === 'function') {
            exports.onTextboxCommitted(entry);
        }
    }

    /**
     * Bind edit/commit keyboard behavior to a textbox content element.
     *
     * @param {Object} entry
     */
    function bindTextboxEditing(entry) {
        var contentEl = getTextboxContentElement(entry);
        if (!contentEl) return;

        contentEl.addEventListener('input', function () {
            entry.content = contentEl.textContent || '';
            syncTextboxSize(entry);
        });

        contentEl.addEventListener('blur', function () {
            commitTextbox(entry.pageIdx, entry);
        });

        contentEl.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                contentEl.blur();
            }
        });
    }

    // =========================================================================
    // Text Box Lifecycle
    // =========================================================================

    /**
     * Create a new text box on a page.
     *
     * @param {number} pageIdx - 0-based page index
     * @param {HTMLElement} pageWrapper - The page wrapper element
     * @param {number} canvasX - X position in canvas pixel coordinates
     * @param {number} canvasY - Y position in canvas pixel coordinates
     * @param {string} color - CSS color for the text box border/text
     * @returns {Object} The text box entry {element, annotationId, pageIdx, content, color}
     */
    exports.createTextbox = function createTextbox(pageIdx, pageWrapper, canvasX, canvasY, color) {
        var scale = getCanvasScale(pageWrapper);
        var resolvedColor = resolveColorData(color);

        // Convert canvas coords to CSS position
        var cssLeft = canvasX * scale.scaleX;
        var cssTop = canvasY * scale.scaleY;

        // Create the textbox element
        var textbox = document.createElement('div');
        textbox.className = 'markup-textbox editing';
        textbox.style.position = 'absolute';
        textbox.style.left = cssLeft + 'px';
        textbox.style.top = cssTop + 'px';
        textbox.style.width = exports.DEFAULT_WIDTH + 'px';
        textbox.style.height = exports.DEFAULT_HEIGHT + 'px';
        textbox.style.minHeight = exports.DEFAULT_HEIGHT + 'px';
        textbox.style.fontSize = exports.DEFAULT_FONT_SIZE + 'px';
        textbox.style.color = resolvedColor.css;
        textbox.style.borderColor = resolvedColor.css;
        textbox.style.pointerEvents = 'auto';

        var contentEl = createTextboxContent('');
        textbox.appendChild(contentEl);

        // Create resize handle
        var resizeHandle = document.createElement('div');
        resizeHandle.className = 'markup-textbox-resize';
        textbox.appendChild(resizeHandle);

        // Get or create the textbox layer and append
        var layer = getOrCreateTextboxLayer(pageWrapper);
        layer.appendChild(textbox);

        // Create the entry object
        var entry = {
            element: textbox,
            contentElement: contentEl,
            annotationId: null,
            pageIdx: pageIdx,
            content: '',
            color: resolvedColor.value
        };

        // Store in pageTextboxes map
        addEntryToPageMap(pageIdx, entry);
        bindTextboxEditing(entry);
        syncTextboxSize(entry, pageWrapper, '');
        setTextboxEditing(entry, true);

        // Focus immediately for editing
        contentEl.focus();

        return entry;
    };

    /**
     * Enter edit mode on an existing text box.
     *
     * @param {Object} entry - The text box entry
     */
    exports.editTextbox = function editTextbox(entry) {
        if (!entry || !entry.element) return;
        var contentEl = getTextboxContentElement(entry);
        setTextboxEditing(entry, true);
        syncTextboxSize(entry);
        if (contentEl) {
            contentEl.focus();
            placeCursorAtEnd(contentEl);
        }
    };

    /**
     * Remove a text box from the page.
     *
     * @param {number} pageIdx - 0-based page index
     * @param {Object} entry - The text box entry to remove
     */
    exports.removeTextbox = function removeTextbox(pageIdx, entry) {
        if (!entry || !entry.element) return;

        // Remove DOM element
        safeRemoveElement(entry.element);

        removeEntryFromPageMap(pageIdx, entry);
    };

    // =========================================================================
    // Hit Testing
    // =========================================================================

    /**
     * Test if a click hits any text box on a given page.
     * Tests in reverse order so topmost (last-added) textbox wins.
     *
     * @param {number} pageIdx - 0-based page index
     * @param {number} clientX - Client X coordinate
     * @param {number} clientY - Client Y coordinate
     * @returns {Object|null} The hit entry, or null
     */
    exports.hitTestTextbox = function hitTestTextbox(pageIdx, clientX, clientY) {
        var entries = pageTextboxes.get(pageIdx);
        if (!entries || entries.length === 0) return null;

        // Reverse order: topmost first
        for (var i = entries.length - 1; i >= 0; i--) {
            var entry = entries[i];
            if (!entry.element) continue;
            var rect = entry.element.getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom) {
                return entry;
            }
        }
        return null;
    };

    // =========================================================================
    // Position
    // =========================================================================

    /**
     * Get the text box position as canvas pixel coordinates.
     *
     * @param {Object} entry - The text box entry
     * @param {HTMLElement} pageWrapper - The page wrapper element
     * @returns {number[]} [x0, y0, x1, y1] in canvas pixel coordinates
     */
    exports.getTextboxCanvasRect = function getTextboxCanvasRect(entry, pageWrapper) {
        if (!entry || !entry.element) return [0, 0, 0, 0];

        var el = entry.element;
        // Defense against stale entries: refreshMarkupFromAnnotations()
        // recreates textbox entries after every CRUD round-trip. Callers
        // (MarkupSelection.onMoveCompleted, drag-drop, etc.) may hold the
        // old entry whose element is detached from the DOM. A detached
        // element's offset* properties all return 0, producing a degenerate
        // [0, 0, 0, 0] canvas rect which then propagates to a degenerate
        // PDF rect that the agent rejects with "rect requires x0 < x1".
        // Recover by looking up the live entry on the same page by id.
        if (!el.isConnected && entry.annotationId != null) {
            var freshEntries = exports.getPageTextboxes(entry.pageIdx) || [];
            for (var i = 0; i < freshEntries.length; i++) {
                var candidate = freshEntries[i];
                if (candidate && candidate.element && candidate.annotationId === entry.annotationId) {
                    el = candidate.element;
                    break;
                }
            }
        }

        var scale = getCanvasScale(pageWrapper);
        var cssLeft = el.offsetLeft;
        var cssTop = el.offsetTop;
        var cssWidth = el.offsetWidth;
        var cssHeight = el.offsetHeight;

        var x0 = cssLeft / scale.scaleX;
        var y0 = cssTop / scale.scaleY;
        var x1 = (cssLeft + cssWidth) / scale.scaleX;
        var y1 = (cssTop + cssHeight) / scale.scaleY;

        return [x0, y0, x1, y1];
    };

    /**
     * Move a text box by a pixel delta.
     *
     * @param {Object} entry - The text box entry
     * @param {number} dx - Delta X in pixels
     * @param {number} dy - Delta Y in pixels
     */
    exports.moveTextbox = function moveTextbox(entry, dx, dy) {
        if (!entry || !entry.element) return;
        var el = entry.element;
        var currentLeft = parseFloat(el.style.left) || el.offsetLeft;
        var currentTop = parseFloat(el.style.top) || el.offsetTop;
        el.style.left = (currentLeft + dx) + 'px';
        el.style.top = (currentTop + dy) + 'px';
    };

    /**
     * Move a textbox to another page wrapper and update internal page tracking.
     *
     * @param {Object} entry
     * @param {number} targetPageIdx
     * @param {HTMLElement} targetPageWrapper
     * @param {number} cssLeft
     * @param {number} cssTop
     */
    exports.moveTextboxToPage = function moveTextboxToPage(entry, targetPageIdx, targetPageWrapper, cssLeft, cssTop) {
        if (!entry || !entry.element || !targetPageWrapper) return;

        removeEntryFromPageMap(entry.pageIdx, entry);

        var targetLayer = getOrCreateTextboxLayer(targetPageWrapper);
        targetLayer.appendChild(entry.element);
        entry.element.style.left = cssLeft + 'px';
        entry.element.style.top = cssTop + 'px';
        entry.pageIdx = targetPageIdx;

        addEntryToPageMap(targetPageIdx, entry);
        syncTextboxSize(entry, targetPageWrapper);
    };

    // =========================================================================
    // Loading
    // =========================================================================

    /**
     * Load text boxes from saved annotation data.
     * Clears all existing text boxes first.
     *
     * @param {Array<Object>} annotationsData - Array of annotation objects
     * @param {Array<HTMLElement>} pageWrappers - Array of page wrapper elements (indexed by pageIdx)
     */
    exports.loadTextboxesFromAnnotations = function loadTextboxesFromAnnotations(annotationsData, pageWrappers) {
        // Clear existing textboxes
        exports.destroy();

        if (!annotationsData || !pageWrappers) return;

        for (var i = 0; i < annotationsData.length; i++) {
            var ann = annotationsData[i];
            if (ann.type !== 'textbox') continue;

            var pageIdx = ann.pageIdx;
            if (pageIdx < 0 || pageIdx >= pageWrappers.length) continue;

            var pageWrapper = pageWrappers[pageIdx];
            if (!pageWrapper) continue;

            var scale = getCanvasScale(pageWrapper);

            // Create textbox element (not in editing mode)
            var textbox = document.createElement('div');
            textbox.className = 'markup-textbox';
            var resolvedColor = resolveColorData(ann.color);
            textbox.style.position = 'absolute';
            textbox.style.left = (ann.x * scale.scaleX) + 'px';
            textbox.style.top = (ann.y * scale.scaleY) + 'px';
            textbox.style.width = exports.DEFAULT_WIDTH + 'px';
            textbox.style.height = exports.DEFAULT_HEIGHT + 'px';
            textbox.style.minHeight = exports.DEFAULT_HEIGHT + 'px';
            textbox.style.fontSize = exports.DEFAULT_FONT_SIZE + 'px';
            textbox.style.color = resolvedColor.css;
            textbox.style.borderColor = resolvedColor.css;
            textbox.style.pointerEvents = 'auto';

            var contentEl = createTextboxContent(ann.content || '');
            textbox.appendChild(contentEl);

            // Add resize handle
            var resizeHandle = document.createElement('div');
            resizeHandle.className = 'markup-textbox-resize';
            textbox.appendChild(resizeHandle);

            var layer = getOrCreateTextboxLayer(pageWrapper);
            layer.appendChild(textbox);

            var entry = {
                element: textbox,
                contentElement: contentEl,
                annotationId: ann.annotationId || ann.stable_id || ann.id || null,
                pageIdx: pageIdx,
                content: ann.content || '',
                color: resolvedColor.value
            };

            addEntryToPageMap(pageIdx, entry);
            bindTextboxEditing(entry);
            syncTextboxSize(entry, pageWrapper, ann.content || '');
        }
    };

    // =========================================================================
    // Accessors
    // =========================================================================

    /**
     * Get all text box entries for a page.
     *
     * @param {number} pageIdx - 0-based page index
     * @returns {Array<Object>} Array of text box entries
     */
    exports.getPageTextboxes = function getPageTextboxes(pageIdx) {
        return pageTextboxes.get(pageIdx) || [];
    };

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Remove all text box elements and clear state.
     */
    exports.destroy = function destroy() {
        pageTextboxes.forEach(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                if (entry.element) {
                    safeRemoveElement(entry.element);
                }
            }
        });
        pageTextboxes.clear();
        safeRemoveElement(measureElement);
        measureElement = null;
    };

})(window.PdfPreviewModalTextbox);

// Version marker
window.PdfPreviewModalTextbox._version = '1.0.0';

// Also expose via AEMS namespace
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.textbox = window.PdfPreviewModalTextbox;
