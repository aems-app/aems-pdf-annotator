/**
 * PDF Preview Modal - Markup Selection
 *
 * Handles selecting, moving, and deleting drawing strokes and text boxes
 * in the PDF preview modal. Provides a selection overlay with drag-to-move
 * and delete button functionality.
 *
 * @module pdf-preview-modal/markup-selection
 */

// Namespace for PDF Preview Modal markup selection
window.PdfPreviewModalMarkupSelection = window.PdfPreviewModalMarkupSelection || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // State
    // =========================================================================

    /** @type {null|{type: 'stroke'|'textbox', entry: Object, pageIdx: number}} */
    var selectedItem = null;

    /** @type {HTMLElement|null} */
    var selectionOverlay = null;

    /** @type {boolean} */
    var isDragging = false;

    /** @type {{x: number, y: number}|null} */
    var dragStart = null;

    /** @type {HTMLElement|null} */
    var dragPageWrapper = null;

    /** @type {Array<{pageIdx: number, rect: DOMRect}>} */
    var cachedPageRects = [];

    /** @type {number|null} */
    var dragSourcePageIdx = null;

    /** @type {number|null} */
    var dragTargetPageIdx = null;

    /** @type {HTMLElement|null} */
    var highlightedWrapper = null;

    /** @type {string} */
    var dragSourceWrapperOriginalOverflow = '';

    /** @type {string} */
    var dragSourceWrapperOriginalZIndex = '';

    // =========================================================================
    // Callbacks
    // =========================================================================

    /** @type {Function|null} Called when delete is requested for the selected item */
    exports.onDeleteRequested = null;

    /** @type {Function|null} Called when a move operation completes */
    exports.onMoveCompleted = null;

    // =========================================================================
    // Keyboard Handler (bound reference for cleanup)
    // =========================================================================

    var boundKeydownHandler = null;

    // =========================================================================
    // Initialization
    // =========================================================================

    /**
     * Initialize keyboard listeners for selection management.
     * Call once when the modal opens.
     */
    exports.init = function init() {
        if (boundKeydownHandler) return;
        boundKeydownHandler = handleKeydown;
        document.addEventListener('keydown', boundKeydownHandler);
    };

    // =========================================================================
    // Selection
    // =========================================================================

    /**
     * Select a markup item (stroke or textbox).
     *
     * @param {'stroke'|'textbox'} type - The type of markup item
     * @param {Object} entry - The data entry for the item
     * @param {number} pageIdx - The 0-based page index
     * @param {HTMLElement} pageWrapper - The page wrapper DOM element
     */
    exports.select = function select(type, entry, pageIdx, pageWrapper) {
        // Deselect any current selection first
        exports.deselect();

        selectedItem = { type: type, entry: entry, pageIdx: pageIdx };
        dragPageWrapper = pageWrapper;

        // For textbox: add .selected class to the element
        if (type === 'textbox' && entry.element) {
            entry.element.classList.add('selected');
        }

        // Create and position the selection overlay
        createSelectionOverlay(type, entry, pageWrapper);
    };

    /**
     * Deselect the current selection.
     */
    exports.deselect = function deselect() {
        if (!selectedItem) return;

        // Remove .selected from textbox element
        if (selectedItem.type === 'textbox' && selectedItem.entry && selectedItem.entry.element) {
            selectedItem.entry.element.classList.remove('selected');
        }

        // Remove selection overlay
        if (selectionOverlay && selectionOverlay.parentNode) {
            selectionOverlay.parentNode.removeChild(selectionOverlay);
        }

        selectedItem = null;
        selectionOverlay = null;
        isDragging = false;
        dragStart = null;
        cachedPageRects = [];
        dragSourcePageIdx = null;
        dragTargetPageIdx = null;
        clearHighlightedWrapper();
        resetDragWrapperStyles();
        dragPageWrapper = null;
    };

    /**
     * Get the currently selected item.
     *
     * @returns {null|{type: string, entry: Object, pageIdx: number}}
     */
    exports.getSelected = function getSelected() {
        return selectedItem;
    };

    /**
     * Check if there is a current selection.
     *
     * @returns {boolean}
     */
    exports.hasSelection = function hasSelection() {
        return selectedItem !== null;
    };

    /**
     * Delete the currently selected item.
     * Returns the selected item data and deselects.
     * The caller is responsible for actual deletion from data structures.
     *
     * @returns {null|{type: string, entry: Object, pageIdx: number}}
     */
    exports.deleteSelected = function deleteSelected() {
        if (!selectedItem) return null;

        var item = {
            type: selectedItem.type,
            entry: selectedItem.entry,
            pageIdx: selectedItem.pageIdx
        };

        exports.deselect();
        return item;
    };

    // =========================================================================
    // Selection Overlay
    // =========================================================================

    /**
     * Create the selection overlay positioned over the selected item.
     *
     * @param {'stroke'|'textbox'} type - Item type
     * @param {Object} entry - The data entry
     * @param {HTMLElement} pageWrapper - The page wrapper element
     */
    function createSelectionOverlay(type, entry, pageWrapper) {
        var bounds = getItemBounds(type, entry, pageWrapper);
        if (!bounds) return;

        // Find or create the textbox layer
        var layer = getOrCreateTextboxLayer(pageWrapper);

        // Create overlay element
        var overlay = document.createElement('div');
        overlay.className = 'markup-selection-overlay';
        overlay.style.left = bounds.left + 'px';
        overlay.style.top = bounds.top + 'px';
        overlay.style.width = bounds.width + 'px';
        overlay.style.height = bounds.height + 'px';

        // Create delete button
        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'markup-selection-delete';
        deleteBtn.type = 'button';
        deleteBtn.title = 'Delete';
        deleteBtn.textContent = '\u00d7';

        deleteBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            if (typeof exports.onDeleteRequested === 'function') {
                exports.onDeleteRequested();
            }
        });

        overlay.appendChild(deleteBtn);
        layer.appendChild(overlay);

        selectionOverlay = overlay;

        // Attach drag handlers to overlay
        attachDragHandlers(overlay);
    }

    /**
     * Get bounds for a markup item in page-relative coordinates.
     *
     * @param {'stroke'|'textbox'} type - Item type
     * @param {Object} entry - Data entry
     * @param {HTMLElement} pageWrapper - Page wrapper element
     * @returns {{left: number, top: number, width: number, height: number}|null}
     */
    function getItemBounds(type, entry, pageWrapper) {
        var padding = 4;

        if (type === 'textbox' && entry.element) {
            var el = entry.element;
            return {
                left: el.offsetLeft - padding,
                top: el.offsetTop - padding,
                width: el.offsetWidth + padding * 2,
                height: el.offsetHeight + padding * 2
            };
        }

        if (type === 'stroke') {
            var DrawingCanvas = window.PdfPreviewModalDrawingCanvas;
            if (DrawingCanvas && typeof DrawingCanvas.getStrokeBounds === 'function') {
                var strokeBounds = DrawingCanvas.getStrokeBounds(entry);
                if (strokeBounds) {
                    // strokeBounds is {minX, minY, maxX, maxY} in canvas coordinates
                    // Convert to CSS position within the page wrapper
                    var pdfCanvas = pageWrapper.querySelector('canvas');
                    var csX = pdfCanvas ? (pdfCanvas.offsetWidth / pdfCanvas.width) : 1;
                    var csY = pdfCanvas ? (pdfCanvas.offsetHeight / pdfCanvas.height) : 1;
                    return {
                        left: strokeBounds.minX * csX - padding,
                        top: strokeBounds.minY * csY - padding,
                        width: (strokeBounds.maxX - strokeBounds.minX) * csX + padding * 2,
                        height: (strokeBounds.maxY - strokeBounds.minY) * csY + padding * 2
                    };
                }
            }
            return null;
        }

        return null;
    }

    /**
     * Find or create the textbox layer within a page wrapper.
     *
     * @param {HTMLElement} pageWrapper - The page wrapper element
     * @returns {HTMLElement} The textbox layer element
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

    function clampValue(value, min, max) {
        return Math.max(min, Math.min(value, max));
    }

    function clearHighlightedWrapper() {
        if (highlightedWrapper) {
            highlightedWrapper.style.outline = '';
            highlightedWrapper.style.outlineOffset = '';
            highlightedWrapper = null;
        }
    }

    function resetDragWrapperStyles() {
        if (!dragPageWrapper) return;
        dragPageWrapper.style.overflow = dragSourceWrapperOriginalOverflow;
        dragPageWrapper.style.zIndex = dragSourceWrapperOriginalZIndex;
        dragSourceWrapperOriginalOverflow = '';
        dragSourceWrapperOriginalZIndex = '';
    }

    // =========================================================================
    // Move Handling
    // =========================================================================

    /**
     * Attach drag handlers to the selection overlay for moving items.
     *
     * @param {HTMLElement} overlay - The selection overlay element
     */
    function attachDragHandlers(overlay) {
        overlay.addEventListener('pointerdown', onOverlayPointerDown);
    }

    /**
     * Handle pointer down on the overlay to start a drag.
     *
     * @param {PointerEvent} e
     */
    function onOverlayPointerDown(e) {
        // Don't start drag if clicking the delete button
        if (e.target.classList.contains('markup-selection-delete')) return;

        e.preventDefault();
        e.stopPropagation();

        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        dragSourcePageIdx = selectedItem ? selectedItem.pageIdx : null;
        dragTargetPageIdx = dragSourcePageIdx;
        cachedPageRects = [];

        if (selectedItem && selectedItem.type === 'textbox') {
            var wrappers = document.querySelectorAll('#pdfGradedContainer .pdf-page-wrapper');
            for (var i = 0; i < wrappers.length; i++) {
                cachedPageRects.push({
                    pageIdx: i,
                    rect: wrappers[i].getBoundingClientRect()
                });
            }
        }

        if (dragPageWrapper) {
            dragSourceWrapperOriginalOverflow = dragPageWrapper.style.overflow;
            dragSourceWrapperOriginalZIndex = dragPageWrapper.style.zIndex;
            dragPageWrapper.style.overflow = 'visible';
            dragPageWrapper.style.zIndex = '1000';
        }

        // Capture pointer for move/up events
        selectionOverlay.setPointerCapture(e.pointerId);
        selectionOverlay.addEventListener('pointermove', onOverlayPointerMove);
        selectionOverlay.addEventListener('pointerup', onOverlayPointerUp);

        selectionOverlay.classList.add('moving');
    }

    /**
     * Handle pointer move during drag to reposition the item.
     *
     * @param {PointerEvent} e
     */
    function onOverlayPointerMove(e) {
        if (!isDragging || !dragStart || !selectedItem || !selectionOverlay) return;

        var dx = e.clientX - dragStart.x;
        var dy = e.clientY - dragStart.y;

        // Update drag start for incremental movement
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;

        var currentLeft = parseFloat(selectionOverlay.style.left) || 0;
        var currentTop = parseFloat(selectionOverlay.style.top) || 0;
        var newLeft = currentLeft + dx;
        var newTop = currentTop + dy;

        if (selectedItem.type === 'textbox' && dragSourcePageIdx !== null && cachedPageRects.length > 0) {
            var newTargetPageIdx = dragSourcePageIdx;
            for (var i = 0; i < cachedPageRects.length; i++) {
                var cached = cachedPageRects[i];
                if (e.clientX >= cached.rect.left && e.clientX <= cached.rect.right &&
                    e.clientY >= cached.rect.top && e.clientY <= cached.rect.bottom) {
                    newTargetPageIdx = cached.pageIdx;
                    break;
                }
            }

            if (newTargetPageIdx !== dragTargetPageIdx) {
                clearHighlightedWrapper();
                dragTargetPageIdx = newTargetPageIdx;

                if (dragTargetPageIdx !== dragSourcePageIdx) {
                    var targetWrapper = (document.getElementById('pdfGradedContainer') || document).querySelector('.pdf-page-wrapper[data-page-num="' + (dragTargetPageIdx + 1) + '"]');
                    if (targetWrapper) {
                        targetWrapper.style.outline = '3px solid #0d6efd';
                        targetWrapper.style.outlineOffset = '-3px';
                        highlightedWrapper = targetWrapper;
                    }
                }
            }
        }

        if (dragTargetPageIdx === dragSourcePageIdx) {
            var parentLayer = selectionOverlay.parentElement;
            if (parentLayer) {
                newLeft = clampValue(newLeft, 0, Math.max(0, parentLayer.offsetWidth - selectionOverlay.offsetWidth));
                newTop = clampValue(newTop, 0, Math.max(0, parentLayer.offsetHeight - selectionOverlay.offsetHeight));
            }
        }

        var appliedDx = newLeft - currentLeft;
        var appliedDy = newTop - currentTop;
        selectionOverlay.style.left = newLeft + 'px';
        selectionOverlay.style.top = newTop + 'px';

        // Move the underlying item
        if (selectedItem.type === 'textbox') {
            var Textbox = window.PdfPreviewModalTextbox;
            if (Textbox && typeof Textbox.moveTextbox === 'function') {
                Textbox.moveTextbox(selectedItem.entry, appliedDx, appliedDy);
            }
        } else if (selectedItem.type === 'stroke') {
            var DrawingCanvas = window.PdfPreviewModalDrawingCanvas;
            if (DrawingCanvas && typeof DrawingCanvas.moveStroke === 'function') {
                var pdfCanvas = dragPageWrapper ? dragPageWrapper.querySelector('canvas') : null;
                var scaleX = pdfCanvas && pdfCanvas.offsetWidth ? (pdfCanvas.width / pdfCanvas.offsetWidth) : 1;
                var scaleY = pdfCanvas && pdfCanvas.offsetHeight ? (pdfCanvas.height / pdfCanvas.offsetHeight) : 1;
                DrawingCanvas.moveStroke(selectedItem.entry, appliedDx * scaleX, appliedDy * scaleY);
            }
        }
    }

    /**
     * Handle pointer up to end the drag operation.
     *
     * @param {PointerEvent} e
     */
    function onOverlayPointerUp(e) {
        if (!selectionOverlay) return;

        selectionOverlay.releasePointerCapture(e.pointerId);
        selectionOverlay.removeEventListener('pointermove', onOverlayPointerMove);
        selectionOverlay.removeEventListener('pointerup', onOverlayPointerUp);

        if (isDragging && typeof exports.onMoveCompleted === 'function' && selectedItem) {
            var sourcePageIdx = dragSourcePageIdx !== null ? dragSourcePageIdx : selectedItem.pageIdx;

            if (selectedItem.type === 'textbox' &&
                dragTargetPageIdx !== null &&
                dragTargetPageIdx !== sourcePageIdx) {
                var targetWrapper = (document.getElementById('pdfGradedContainer') || document).querySelector('.pdf-page-wrapper[data-page-num="' + (dragTargetPageIdx + 1) + '"]');
                var Textbox = window.PdfPreviewModalTextbox;

                if (targetWrapper && Textbox && typeof Textbox.moveTextboxToPage === 'function') {
                    var targetLayer = getOrCreateTextboxLayer(targetWrapper);
                    var textboxRect = selectedItem.entry.element.getBoundingClientRect();
                    var overlayRect = selectionOverlay.getBoundingClientRect();
                    var targetLayerRect = targetLayer.getBoundingClientRect();

                    var newTextboxLeft = clampValue(
                        textboxRect.left - targetLayerRect.left,
                        0,
                        Math.max(0, targetLayer.offsetWidth - selectedItem.entry.element.offsetWidth)
                    );
                    var newTextboxTop = clampValue(
                        textboxRect.top - targetLayerRect.top,
                        0,
                        Math.max(0, targetLayer.offsetHeight - selectedItem.entry.element.offsetHeight)
                    );
                    var newOverlayLeft = clampValue(
                        overlayRect.left - targetLayerRect.left,
                        0,
                        Math.max(0, targetLayer.offsetWidth - selectionOverlay.offsetWidth)
                    );
                    var newOverlayTop = clampValue(
                        overlayRect.top - targetLayerRect.top,
                        0,
                        Math.max(0, targetLayer.offsetHeight - selectionOverlay.offsetHeight)
                    );

                    Textbox.moveTextboxToPage(
                        selectedItem.entry,
                        dragTargetPageIdx,
                        targetWrapper,
                        newTextboxLeft,
                        newTextboxTop
                    );

                    targetLayer.appendChild(selectionOverlay);
                    selectionOverlay.style.left = newOverlayLeft + 'px';
                    selectionOverlay.style.top = newOverlayTop + 'px';
                    selectedItem.pageIdx = dragTargetPageIdx;
                    dragPageWrapper = targetWrapper;
                }
            }

            selectedItem.sourcePageIdx = sourcePageIdx;
            selectedItem.targetPageIdx = selectedItem.pageIdx;
            exports.onMoveCompleted(selectedItem);
        }

        isDragging = false;
        dragStart = null;
        cachedPageRects = [];
        dragSourcePageIdx = null;
        dragTargetPageIdx = null;
        clearHighlightedWrapper();
        resetDragWrapperStyles();

        if (selectionOverlay) {
            selectionOverlay.classList.remove('moving');
        }
    }

    // =========================================================================
    // Keyboard Handling
    // =========================================================================

    /**
     * Handle keydown events for selection shortcuts.
     *
     * @param {KeyboardEvent} e
     */
    function handleKeydown(e) {
        // Don't intercept when typing in inputs
        var tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.target.isContentEditable) return;

        if (!selectedItem) return;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            if (typeof exports.onDeleteRequested === 'function') {
                exports.onDeleteRequested();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            exports.deselect();
        }
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Destroy the selection module: deselect and remove all listeners.
     */
    exports.destroy = function destroy() {
        exports.deselect();

        if (boundKeydownHandler) {
            document.removeEventListener('keydown', boundKeydownHandler);
            boundKeydownHandler = null;
        }

        // Preserve integration callbacks across modal sessions. Destroy should
        // clear transient selection state and listeners, not erase the delete
        // and move hooks owned by the modal integration layer.
    };

})(window.PdfPreviewModalMarkupSelection);

// Version marker
window.PdfPreviewModalMarkupSelection._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.markupSelection = window.PdfPreviewModalMarkupSelection;
