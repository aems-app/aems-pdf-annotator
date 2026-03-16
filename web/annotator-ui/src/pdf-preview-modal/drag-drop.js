/**
 * PDF Preview Modal - Drag & Drop Helpers
 *
 * Pure helper functions for annotation drag and drop operations.
 * The main drag logic remains in pdf-preview-modal.js due to state/DOM coupling.
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 8).
 *
 * @module pdf-preview-modal/drag-drop
 */

// Namespace for PDF Preview Modal drag-drop helpers
window.PdfPreviewModalDragDrop = window.PdfPreviewModalDragDrop || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Minimum movement in pixels to consider as a drag
     * @type {number}
     */
    exports.DRAG_THRESHOLD = 1;

    /**
     * Outline style for target page highlight
     * @type {string}
     */
    exports.TARGET_HIGHLIGHT_STYLE = '3px solid #0d6efd';

    /**
     * Outline offset for target page highlight
     * @type {string}
     */
    exports.TARGET_HIGHLIGHT_OFFSET = '-3px';

    // =========================================================================
    // Movement Helpers
    // =========================================================================

    /**
     * Calculate movement delta from start position
     *
     * @param {number} currentX - Current X position
     * @param {number} currentY - Current Y position
     * @param {number} startX - Start X position
     * @param {number} startY - Start Y position
     * @returns {{dx: number, dy: number}}
     */
    exports.calculateDelta = function calculateDelta(currentX, currentY, startX, startY) {
        return {
            dx: currentX - startX,
            dy: currentY - startY
        };
    };

    /**
     * Check if movement exceeds drag threshold
     *
     * @param {number} dx - X delta
     * @param {number} dy - Y delta
     * @param {number} [threshold] - Movement threshold
     * @returns {boolean} True if exceeds threshold
     */
    exports.exceedsDragThreshold = function exceedsDragThreshold(dx, dy, threshold) {
        if (threshold === undefined) threshold = exports.DRAG_THRESHOLD;
        return Math.abs(dx) >= threshold || Math.abs(dy) >= threshold;
    };

    /**
     * Calculate new position from initial position and delta
     *
     * @param {number} initialLeft - Initial left position
     * @param {number} initialTop - Initial top position
     * @param {number} dx - X delta
     * @param {number} dy - Y delta
     * @returns {{left: number, top: number}}
     */
    exports.calculateNewPosition = function calculateNewPosition(initialLeft, initialTop, dx, dy) {
        return {
            left: initialLeft + dx,
            top: initialTop + dy
        };
    };

    // =========================================================================
    // Clamping Helpers
    // =========================================================================

    /**
     * Clamp position to keep element within container
     *
     * @param {number} left - Left position
     * @param {number} top - Top position
     * @param {number} elementWidth - Element width
     * @param {number} elementHeight - Element height
     * @param {number} containerWidth - Container width
     * @param {number} containerHeight - Container height
     * @returns {{left: number, top: number}}
     */
    exports.clampToContainer = function clampToContainer(
        left, top,
        elementWidth, elementHeight,
        containerWidth, containerHeight
    ) {
        return {
            left: Math.max(0, Math.min(left, containerWidth - elementWidth)),
            top: Math.max(0, Math.min(top, containerHeight - elementHeight))
        };
    };

    /**
     * Check if position is within container bounds
     *
     * @param {number} left - Left position
     * @param {number} top - Top position
     * @param {number} width - Element width
     * @param {number} height - Element height
     * @param {number} containerWidth - Container width
     * @param {number} containerHeight - Container height
     * @returns {boolean} True if fully within bounds
     */
    exports.isWithinContainer = function isWithinContainer(
        left, top, width, height,
        containerWidth, containerHeight
    ) {
        return left >= 0 && top >= 0 &&
               left + width <= containerWidth &&
               top + height <= containerHeight;
    };

    // =========================================================================
    // Cross-Page Detection
    // =========================================================================

    /**
     * Check if a point is within a rectangle
     *
     * @param {number} x - Point X coordinate
     * @param {number} y - Point Y coordinate
     * @param {{left: number, top: number, right: number, bottom: number}} rect - Rectangle
     * @returns {boolean} True if point is within rectangle
     */
    exports.isPointInRect = function isPointInRect(x, y, rect) {
        return x >= rect.left && x <= rect.right &&
               y >= rect.top && y <= rect.bottom;
    };

    /**
     * Find which page a mouse position is over
     *
     * @param {number} mouseX - Mouse X coordinate
     * @param {number} mouseY - Mouse Y coordinate
     * @param {Array<{pageNum: number, rect: {left: number, top: number, right: number, bottom: number}}>} pageRects
     * @returns {number|null} Page number (1-based) or null if not over any page
     */
    exports.findPageAtPosition = function findPageAtPosition(mouseX, mouseY, pageRects) {
        for (var i = 0; i < pageRects.length; i++) {
            var page = pageRects[i];
            if (exports.isPointInRect(mouseX, mouseY, page.rect)) {
                return page.pageNum;
            }
        }
        return null;
    };

    /**
     * Convert page number to 0-based index
     *
     * @param {number} pageNum - 1-based page number
     * @returns {number} 0-based page index
     */
    exports.pageNumToIndex = function pageNumToIndex(pageNum) {
        return pageNum - 1;
    };

    /**
     * Convert 0-based index to page number
     *
     * @param {number} pageIdx - 0-based page index
     * @returns {number} 1-based page number
     */
    exports.indexToPageNum = function indexToPageNum(pageIdx) {
        return pageIdx + 1;
    };

    // =========================================================================
    // Highlight Helpers
    // =========================================================================

    /**
     * Apply highlight style to a page wrapper
     *
     * @param {HTMLElement} wrapper - Page wrapper element
     */
    exports.applyHighlight = function applyHighlight(wrapper) {
        if (!wrapper) return;
        wrapper.style.outline = exports.TARGET_HIGHLIGHT_STYLE;
        wrapper.style.outlineOffset = exports.TARGET_HIGHLIGHT_OFFSET;
    };

    /**
     * Remove highlight style from a page wrapper
     *
     * @param {HTMLElement} wrapper - Page wrapper element
     */
    exports.removeHighlight = function removeHighlight(wrapper) {
        if (!wrapper) return;
        wrapper.style.outline = '';
        wrapper.style.outlineOffset = '';
    };

    // =========================================================================
    // Cursor Helpers
    // =========================================================================

    /**
     * Set cursor for dragging state
     *
     * @param {HTMLElement} element - Element to set cursor on
     * @param {boolean} isDragging - Whether currently dragging
     */
    exports.setDragCursor = function setDragCursor(element, isDragging) {
        if (!element) return;
        element.style.cursor = isDragging ? 'grabbing' : 'move';
    };

    /**
     * Set cursor to indicate drag is not allowed
     *
     * @param {HTMLElement} element - Element to set cursor on
     */
    exports.setNotAllowedCursor = function setNotAllowedCursor(element) {
        if (!element) return;
        element.style.cursor = 'not-allowed';
    };

    // =========================================================================
    // Position Helpers
    // =========================================================================

    /**
     * Apply position to element
     *
     * @param {HTMLElement} element - Element to position
     * @param {number} left - Left position in pixels
     * @param {number} top - Top position in pixels
     */
    exports.applyPosition = function applyPosition(element, left, top) {
        if (!element) return;
        element.style.left = left + 'px';
        element.style.top = top + 'px';
    };

    /**
     * Get element's offset position (relative to parent)
     *
     * @param {HTMLElement} element - Element
     * @returns {{left: number, top: number}}
     */
    exports.getOffsetPosition = function getOffsetPosition(element) {
        if (!element) return { left: 0, top: 0 };
        return {
            left: element.offsetLeft,
            top: element.offsetTop
        };
    };

    /**
     * Get element's dimensions
     *
     * @param {HTMLElement} element - Element
     * @param {number} [defaultWidth=50] - Default width if not available
     * @param {number} [defaultHeight=30] - Default height if not available
     * @returns {{width: number, height: number}}
     */
    exports.getElementDimensions = function getElementDimensions(element, defaultWidth, defaultHeight) {
        if (defaultWidth === undefined) defaultWidth = 50;
        if (defaultHeight === undefined) defaultHeight = 30;
        if (!element) return { width: defaultWidth, height: defaultHeight };
        return {
            width: element.offsetWidth || defaultWidth,
            height: element.offsetHeight || defaultHeight
        };
    };

    // =========================================================================
    // Rect Conversion Helpers
    // =========================================================================

    /**
     * Convert screen position to PDF coordinates
     *
     * @param {number} screenLeft - Screen left position
     * @param {number} screenTop - Screen top position
     * @param {number} markerWidth - Marker width
     * @param {number} markerHeight - Marker height
     * @param {number} scaleX - X scale factor
     * @param {number} scaleY - Y scale factor
     * @param {Object} viewport - PDF viewport
     * @returns {number[]} PDF rect [x0, y0, x1, y1]
     */
    exports.screenToPdfRect = function screenToPdfRect(
        screenLeft, screenTop,
        markerWidth, markerHeight,
        scaleX, scaleY,
        viewport
    ) {
        // Convert screen coordinates to viewport coordinates
        var viewX0 = screenLeft / scaleX;
        var viewY0 = screenTop / scaleY;
        var viewX1 = viewX0 + (markerWidth / scaleX);
        var viewY1 = viewY0 + (markerHeight / scaleY);

        // Convert viewport coordinates to PDF coordinates
        // Note: PDF coordinates have origin at bottom-left
        if (viewport && typeof viewport.convertToPdfPoint === 'function') {
            var pdfPoint0 = viewport.convertToPdfPoint(viewX0, viewY0);
            var pdfPoint1 = viewport.convertToPdfPoint(viewX1, viewY1);
            return [pdfPoint0[0], pdfPoint0[1], pdfPoint1[0], pdfPoint1[1]];
        }

        // Fallback: simple conversion
        var pdfWidth = 612; // Default letter width
        var pdfHeight = 792; // Default letter height
        var viewWidth = viewport ? viewport.width : pdfWidth;
        var viewHeight = viewport ? viewport.height : pdfHeight;

        return [
            (viewX0 / viewWidth) * pdfWidth,
            pdfHeight - (viewY0 / viewHeight) * pdfHeight,
            (viewX1 / viewWidth) * pdfWidth,
            pdfHeight - (viewY1 / viewHeight) * pdfHeight
        ];
    };

    // =========================================================================
    // Drag State Helpers
    // =========================================================================

    /**
     * Create initial drag state object
     *
     * @param {number} startX - Starting X position
     * @param {number} startY - Starting Y position
     * @param {number} initialLeft - Initial element left position
     * @param {number} initialTop - Initial element top position
     * @param {number} sourcePageIdx - Source page index
     * @returns {Object} Drag state
     */
    exports.createDragState = function createDragState(startX, startY, initialLeft, initialTop, sourcePageIdx) {
        return {
            isDragging: true,
            hasMoved: false,
            startX: startX,
            startY: startY,
            initialLeft: initialLeft,
            initialTop: initialTop,
            sourcePageIdx: sourcePageIdx,
            targetPageIdx: sourcePageIdx,
            highlightedWrapper: null
        };
    };

    /**
     * Check if drag target should be blocked
     * (e.g., clicking on textarea or editing label)
     *
     * @param {HTMLElement} target - Event target
     * @param {HTMLElement} label - Label element
     * @returns {boolean} True if drag should be blocked
     */
    exports.shouldBlockDrag = function shouldBlockDrag(target, label) {
        // Block if label is in editing mode
        if (label && label.classList.contains('label-editing')) {
            return true;
        }
        // Block if clicking on textarea
        if (target.classList.contains('inline-annotation-editor') ||
            target.tagName === 'TEXTAREA') {
            return true;
        }
        return false;
    };

})(window.PdfPreviewModalDragDrop);

// Version marker
window.PdfPreviewModalDragDrop._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.dragDrop = window.PdfPreviewModalDragDrop;
