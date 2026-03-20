/**
 * PDF Preview Modal - Rendering Helpers
 *
 * Pure helper functions for annotation rendering and positioning.
 * The main rendering logic remains in pdf-preview-modal.js
 * due to tight DOM/state coupling.
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 7).
 *
 * @module pdf-preview-modal/rendering
 */

// Namespace for PDF Preview Modal rendering helpers
window.PdfPreviewModalRendering = window.PdfPreviewModalRendering || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Default gap between marker and label (pixels)
     * @type {number}
     */
    exports.LABEL_GAP = 2;

    /**
     * Default estimated label width (pixels)
     * @type {number}
     */
    exports.DEFAULT_LABEL_WIDTH = 120;

    /**
     * Default estimated label height (pixels)
     * @type {number}
     */
    exports.DEFAULT_LABEL_HEIGHT = 24;

    /**
     * Minimum marker dimension (pixels)
     * @type {number}
     */
    exports.MIN_MARKER_SIZE = 16;

    /**
     * Icon size for text annotations (pixels)
     * @type {number}
     */
    exports.TEXT_ICON_SIZE = 22;

    /**
     * Max characters before truncation in label
     * @type {number}
     */
    exports.MAX_LABEL_CHARS = 18;

    /**
     * Label position options
     * @type {string[]}
     */
    exports.POSITION_NAMES = ['bottom-right', 'top-right', 'bottom-left', 'top-left'];

    // =========================================================================
    // Geometry Helpers
    // =========================================================================

    /**
     * Calculate overlap area between two rectangles
     *
     * @param {{left: number, top: number, right: number, bottom: number}} rect1
     * @param {{left: number, top: number, right: number, bottom: number}} rect2
     * @returns {number} Overlap area in square pixels
     */
    exports.getOverlapArea = function getOverlapArea(rect1, rect2) {
        var xOverlap = Math.max(0, Math.min(rect1.right, rect2.right) - Math.max(rect1.left, rect2.left));
        var yOverlap = Math.max(0, Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top));
        return xOverlap * yOverlap;
    };

    /**
     * Check if a rectangle is within container bounds
     *
     * @param {number} left - Left position
     * @param {number} top - Top position
     * @param {number} width - Rectangle width
     * @param {number} height - Rectangle height
     * @param {number} containerWidth - Container width
     * @param {number} containerHeight - Container height
     * @returns {boolean} True if within bounds
     */
    exports.isWithinBounds = function isWithinBounds(left, top, width, height, containerWidth, containerHeight) {
        return left >= 0 && top >= 0 &&
               left + width <= containerWidth &&
               top + height <= containerHeight;
    };

    /**
     * Calculate total overlap for a label position against other elements
     *
     * @param {number} left - Label left position
     * @param {number} top - Label top position
     * @param {number} width - Label width
     * @param {number} height - Label height
     * @param {Array<{left: number, top: number, right: number, bottom: number, isLabel?: boolean}>} otherRects
     * @returns {number} Total weighted overlap
     */
    exports.getTotalOverlap = function getTotalOverlap(left, top, width, height, otherRects) {
        var labelRect = { left: left, top: top, right: left + width, bottom: top + height };
        var totalOverlap = 0;
        for (var i = 0; i < otherRects.length; i++) {
            var rect = otherRects[i];
            var overlap = exports.getOverlapArea(labelRect, rect);
            // Weight label overlaps more heavily than marker overlaps
            totalOverlap += rect.isLabel ? overlap * 2 : overlap;
        }
        return totalOverlap;
    };

    // =========================================================================
    // Position Calculation
    // =========================================================================

    /**
     * Calculate all possible label positions relative to a marker
     *
     * @param {number} markerRight - Marker right edge
     * @param {number} markerLeft - Marker left edge
     * @param {number} markerTop - Marker top edge
     * @param {number} markerBottom - Marker bottom edge
     * @param {number} labelWidth - Label width
     * @param {number} labelHeight - Label height
     * @param {number} [gap] - Gap between marker and label
     * @returns {Array<{name: string, left: number, top: number, css: Object}>}
     */
    exports.calculateLabelPositions = function calculateLabelPositions(
        markerRight, markerLeft, markerTop, markerBottom,
        labelWidth, labelHeight, gap
    ) {
        if (gap === undefined) gap = exports.LABEL_GAP;

        return [
            {
                name: 'bottom-right',
                left: markerRight + gap,
                top: markerBottom + gap,
                css: {
                    top: '100%', left: '100%', bottom: 'auto', right: 'auto',
                    transform: 'translate(' + gap + 'px, ' + gap + 'px)'
                }
            },
            {
                name: 'top-right',
                left: markerRight + gap,
                top: markerTop - labelHeight - gap,
                css: {
                    bottom: '100%', left: '100%', top: 'auto', right: 'auto',
                    transform: 'translate(' + gap + 'px, -' + gap + 'px)'
                }
            },
            {
                name: 'bottom-left',
                left: markerLeft - labelWidth - gap,
                top: markerBottom + gap,
                css: {
                    top: '100%', right: '100%', bottom: 'auto', left: 'auto',
                    transform: 'translate(-' + gap + 'px, ' + gap + 'px)'
                }
            },
            {
                name: 'top-left',
                left: markerLeft - labelWidth - gap,
                top: markerTop - labelHeight - gap,
                css: {
                    bottom: '100%', right: '100%', top: 'auto', left: 'auto',
                    transform: 'translate(-' + gap + 'px, -' + gap + 'px)'
                }
            }
        ];
    };

    /**
     * Score a label position based on various factors
     *
     * @param {{name: string, left: number, top: number}} position
     * @param {number} labelWidth
     * @param {number} labelHeight
     * @param {number} containerWidth
     * @param {number} containerHeight
     * @param {Array} otherRects - Other elements to avoid
     * @param {{hasMarkerBelow: boolean, hasMarkerAbove: boolean}} context
     * @returns {number} Position score (higher is better)
     */
    exports.scorePosition = function scorePosition(
        position, labelWidth, labelHeight,
        containerWidth, containerHeight,
        otherRects, context
    ) {
        var score = 0;

        // Check if within bounds (heavy penalty if not)
        var inBounds = exports.isWithinBounds(
            position.left, position.top,
            labelWidth, labelHeight,
            containerWidth, containerHeight
        );
        if (!inBounds) {
            score -= 10000;
        }

        // Calculate overlap penalty
        var overlap = exports.getTotalOverlap(
            position.left, position.top,
            labelWidth, labelHeight,
            otherRects
        );
        score -= overlap * 10; // Penalize overlap heavily

        // Position preference based on context
        if (position.name.indexOf('top') === 0 && context.hasMarkerBelow) {
            score += 50; // Bonus for top when there's stuff below
        }
        if (position.name.indexOf('bottom') === 0 && context.hasMarkerAbove && !context.hasMarkerBelow) {
            score += 50; // Bonus for bottom when there's stuff above but not below
        }

        // Small preference for right side (closer to comments panel)
        if (position.name.indexOf('right') !== -1) {
            score += 10;
        }

        return score;
    };

    /**
     * Find the best label position from available options
     *
     * @param {Array<{name: string, left: number, top: number, css: Object}>} positions
     * @param {number} labelWidth
     * @param {number} labelHeight
     * @param {number} containerWidth
     * @param {number} containerHeight
     * @param {Array} otherRects
     * @param {{hasMarkerBelow: boolean, hasMarkerAbove: boolean}} context
     * @returns {{name: string, left: number, top: number, css: Object}} Best position
     */
    exports.findBestPosition = function findBestPosition(
        positions, labelWidth, labelHeight,
        containerWidth, containerHeight,
        otherRects, context
    ) {
        var bestPosition = positions[0];
        var bestScore = -Infinity;

        for (var i = 0; i < positions.length; i++) {
            var pos = positions[i];
            var score = exports.scorePosition(
                pos, labelWidth, labelHeight,
                containerWidth, containerHeight,
                otherRects, context
            );

            if (score > bestScore) {
                bestScore = score;
                bestPosition = pos;
            }
        }

        return bestPosition;
    };

    // =========================================================================
    // Coordinate Conversion
    // =========================================================================

    /**
     * Convert PDF rectangle to viewport coordinates
     * Fallback for when viewport.convertToViewportRectangle is unavailable
     *
     * @param {number[]} rect - PDF rectangle [x0, y0, x1, y1]
     * @param {number} viewportWidth - Viewport width
     * @param {number} viewportHeight - Viewport height
     * @param {number} [pdfWidth=612] - PDF page width (default: letter)
     * @param {number} [pdfHeight=792] - PDF page height (default: letter)
     * @returns {number[]} Viewport rectangle [x0, y0, x1, y1]
     */
    exports.convertRectToViewport = function convertRectToViewport(
        rect, viewportWidth, viewportHeight, pdfWidth, pdfHeight
    ) {
        if (pdfWidth === undefined) pdfWidth = 612;
        if (pdfHeight === undefined) pdfHeight = 792;

        return [
            (rect[0] / pdfWidth) * viewportWidth,
            viewportHeight - (rect[1] / pdfHeight) * viewportHeight,
            (rect[2] / pdfWidth) * viewportWidth,
            viewportHeight - (rect[3] / pdfHeight) * viewportHeight
        ];
    };

    /**
     * Normalize viewport rectangle to get min/max coordinates
     *
     * @param {number[]} viewportRect - Viewport rectangle
     * @returns {{minX: number, maxX: number, minY: number, maxY: number}}
     */
    exports.normalizeRect = function normalizeRect(viewportRect) {
        return {
            minX: Math.min(viewportRect[0], viewportRect[2]),
            maxX: Math.max(viewportRect[0], viewportRect[2]),
            minY: Math.min(viewportRect[1], viewportRect[3]),
            maxY: Math.max(viewportRect[1], viewportRect[3])
        };
    };

    /**
     * Convert a top-left-origin annotation rectangle to viewport coordinates.
     *
     * The browser annotator stores annotation rects in page-space coordinates
     * with y increasing downward (matching PyMuPDF page.rect conventions), not
     * PDF.js bottom-left coordinates.
     *
     * @param {number[]} rect - Annotation rectangle [x0, y0, x1, y1]
     * @param {{width:number,height:number,scale?:number}} viewport - PDF.js viewport-like object
     * @returns {number[]} Viewport rectangle [x0, y0, x1, y1]
     */
    exports.convertTopLeftRectToViewport = function convertTopLeftRectToViewport(rect, viewport) {
        var scale = Number(viewport && viewport.scale);
        if (!Number.isFinite(scale) || scale <= 0) {
            scale = 1;
        }

        return [
            Number(rect[0]) * scale,
            Number(rect[1]) * scale,
            Number(rect[2]) * scale,
            Number(rect[3]) * scale
        ];
    };

    /**
     * Calculate marker dimensions from normalized rect
     *
     * @param {{minX: number, maxX: number, minY: number, maxY: number}} normalizedRect
     * @param {number} scaleX - X scale factor
     * @param {number} scaleY - Y scale factor
     * @param {number} [minSize] - Minimum dimension size
     * @returns {{x: number, y: number, width: number, height: number}}
     */
    exports.calculateMarkerDimensions = function calculateMarkerDimensions(
        normalizedRect, scaleX, scaleY, minSize
    ) {
        if (minSize === undefined) minSize = exports.MIN_MARKER_SIZE;

        return {
            x: normalizedRect.minX * scaleX,
            y: normalizedRect.minY * scaleY,
            width: Math.max((normalizedRect.maxX - normalizedRect.minX) * scaleX, minSize),
            height: Math.max((normalizedRect.maxY - normalizedRect.minY) * scaleY, minSize)
        };
    };

    // =========================================================================
    // Label Text Helpers
    // =========================================================================

    /**
     * Truncate label text for display
     *
     * @param {string} text - Full text
     * @param {number} [maxChars] - Maximum characters
     * @returns {string} Truncated text
     */
    exports.truncateLabelText = function truncateLabelText(text, maxChars) {
        if (maxChars === undefined) maxChars = exports.MAX_LABEL_CHARS;
        var content = text || 'Click to edit';
        if (content.length <= maxChars) return content;
        return content.substring(0, maxChars) + '…';
    };

    // =========================================================================
    // Marker Style Helpers
    // =========================================================================

    /**
     * Get marker background style for priority
     *
     * @param {string} priority - Priority level (red, amber, green)
     * @param {number} [opacity=0.25] - Background opacity
     * @returns {string} CSS background color
     */
    exports.getMarkerBackground = function getMarkerBackground(priority, opacity) {
        if (opacity === undefined) opacity = 0.25;
        var colors = {
            red: { r: 255, g: 0, b: 0 },
            amber: { r: 255, g: 165, b: 0 },
            green: { r: 0, g: 200, b: 0 }
        };
        var c = colors[priority] || colors.amber;
        return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + opacity + ')';
    };

    /**
     * Get border style for annotation type
     *
     * @param {string} annotationType - Type (underline, squiggly, strikeout, etc.)
     * @param {string} priority - Priority level
     * @returns {Object} CSS style properties
     */
    exports.getAnnotationTypeBorderStyle = function getAnnotationTypeBorderStyle(annotationType, priority) {
        var colors = {
            red: { r: 255, g: 0, b: 0 },
            amber: { r: 255, g: 165, b: 0 },
            green: { r: 0, g: 200, b: 0 }
        };
        var c = colors[priority] || colors.amber;
        var borderColor = 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', 0.7)';

        var style = {};
        var type = (annotationType || '').toLowerCase();

        if (type === 'underline') {
            style.borderTop = 'none';
            style.borderLeft = 'none';
            style.borderRight = 'none';
            style.borderBottomWidth = '2px';
            style.borderBottomColor = borderColor;
        } else if (type === 'squiggly') {
            style.borderTop = 'none';
            style.borderLeft = 'none';
            style.borderRight = 'none';
            style.borderBottom = '2px wavy ' + borderColor;
        } else if (type === 'strikeout') {
            style.textDecoration = 'line-through';
            style.textDecorationColor = borderColor;
            style.textDecorationThickness = '2px';
        }

        return style;
    };

    /**
     * Get label border color for priority
     *
     * @param {string} priority - Priority level
     * @returns {string} CSS color string
     */
    exports.getLabelBorderColor = function getLabelBorderColor(priority) {
        var colors = {
            red: 'rgba(255, 0, 0, 1)',
            amber: 'rgba(255, 165, 0, 1)',
            green: 'rgba(0, 200, 0, 1)'
        };
        return colors[priority] || colors.amber;
    };

    // =========================================================================
    // Visibility Helpers
    // =========================================================================

    /**
     * Check if an annotation should be rendered (not a stuck placeholder)
     *
     * @param {Object} annotation - Annotation object
     * @returns {boolean} True if should render
     */
    exports.shouldRenderAnnotation = function shouldRenderAnnotation(annotation) {
        var content = (annotation.content || '').trim();
        var isPlaceholder = content === '' ||
                            content === 'New comment...' ||
                            content === 'New comment';

        // Allow temporary or edited annotations even if placeholder
        var hasBeenEdited = annotation._hasBeenEdited === true || annotation._priorityChanged === true;

        return !isPlaceholder || annotation._isTemporary || hasBeenEdited;
    };

    /**
     * Check if annotation rect is valid for rendering
     *
     * @param {*} rect - Annotation rect property
     * @returns {boolean} True if valid
     */
    exports.isValidRect = function isValidRect(rect) {
        return Array.isArray(rect) && rect.length === 4;
    };

})(window.PdfPreviewModalRendering);

// Version marker
window.PdfPreviewModalRendering._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.rendering = window.PdfPreviewModalRendering;
