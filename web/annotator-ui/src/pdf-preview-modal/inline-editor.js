/**
 * PDF Preview Modal - Inline Editor Helpers
 *
 * Pure helper functions for inline label editing operations.
 * The main expand/collapse/save logic remains in pdf-preview-modal.js
 * due to tight state coupling (will be migrated in future phases).
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 5).
 *
 * @module pdf-preview-modal/inline-editor
 */

// Namespace for PDF Preview Modal inline editor helpers
window.PdfPreviewModalInlineEditor = window.PdfPreviewModalInlineEditor || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Default max width for expanded labels (pixels)
     * @type {number}
     */
    exports.EXPANDED_MAX_WIDTH = 400;

    /**
     * Default min width for edit mode (pixels)
     * @type {number}
     */
    exports.EDIT_MIN_WIDTH = 300;

    /**
     * Default min height for textarea (pixels)
     * @type {number}
     */
    exports.TEXTAREA_MIN_HEIGHT = 60;

    /**
     * Default max height for textarea (pixels)
     * @type {number}
     */
    exports.TEXTAREA_MAX_HEIGHT = 200;

    /**
     * Character threshold for wider label display
     * @type {number}
     */
    exports.LONG_LINE_THRESHOLD = 30;

    /**
     * Max characters before truncation in collapsed view
     * @type {number}
     */
    exports.MAX_DISPLAY_CHARS = 18;

    /**
     * Z-index for expanded labels
     * @type {number}
     */
    exports.EXPANDED_Z_INDEX = 1000;

    // =========================================================================
    // Priority Color Helpers
    // =========================================================================

    /**
     * Get RGB values for a priority level
     *
     * @param {string} priority - Priority level (red, amber, green)
     * @returns {{r: number, g: number, b: number}} RGB values
     */
    exports.getPriorityRgb = function getPriorityRgb(priority) {
        switch (priority) {
            case 'red':
                return { r: 255, g: 0, b: 0 };
            case 'green':
                return { r: 0, g: 200, b: 0 };
            case 'amber':
            default:
                return { r: 255, g: 165, b: 0 };
        }
    };

    /**
     * Get background color style for a priority
     *
     * @param {string} priority - Priority level
     * @param {number} [opacity=0.25] - Background opacity
     * @returns {string} CSS rgba color string
     */
    exports.getPriorityBackgroundColor = function getPriorityBackgroundColor(priority, opacity) {
        if (opacity === undefined) opacity = 0.25;
        const { r, g, b } = exports.getPriorityRgb(priority);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    };

    /**
     * Get border color style for a priority
     *
     * @param {string} priority - Priority level
     * @param {number} [opacity=1] - Border opacity
     * @returns {string} CSS rgba color string
     */
    exports.getPriorityBorderColor = function getPriorityBorderColor(priority, opacity) {
        if (opacity === undefined) opacity = 1;
        const { r, g, b } = exports.getPriorityRgb(priority);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    };

    // =========================================================================
    // Text Helpers
    // =========================================================================

    /**
     * Truncate text for display in collapsed label
     *
     * @param {string} text - Full text content
     * @param {number} [maxChars] - Maximum characters (default: MAX_DISPLAY_CHARS)
     * @returns {string} Truncated text with ellipsis if needed
     */
    exports.truncateForDisplay = function truncateForDisplay(text, maxChars) {
        if (maxChars === undefined) maxChars = exports.MAX_DISPLAY_CHARS;
        if (!text) return '';
        const trimmed = text.trim();
        if (trimmed.length <= maxChars) return trimmed;
        return trimmed.substring(0, maxChars) + '…';
    };

    /**
     * Check if content needs wider label for readability
     *
     * @param {string} text - Text content
     * @param {number} [threshold] - Line length threshold (default: LONG_LINE_THRESHOLD)
     * @returns {boolean} True if any line exceeds threshold
     */
    exports.needsWiderLabel = function needsWiderLabel(text, threshold) {
        if (threshold === undefined) threshold = exports.LONG_LINE_THRESHOLD;
        if (!text) return false;
        const lines = text.split('\n');
        return lines.some(function (line) { return line.length >= threshold; });
    };

    /**
     * Check if content is a placeholder value
     *
     * @param {string} content - Content to check
     * @returns {boolean} True if content is empty or placeholder text
     */
    exports.isPlaceholderContent = function isPlaceholderContent(content) {
        const trimmed = (content || '').trim();
        return trimmed === '' ||
               trimmed === 'New comment...' ||
               trimmed === 'New comment';
    };

    // =========================================================================
    // Label State Helpers
    // =========================================================================

    /**
     * Check if label is in expanded state
     *
     * @param {HTMLElement} label - Label element
     * @returns {boolean} True if expanded
     */
    exports.isLabelExpanded = function isLabelExpanded(label) {
        return label && label.classList.contains('label-expanded');
    };

    /**
     * Check if label is in editing state
     *
     * @param {HTMLElement} label - Label element
     * @returns {boolean} True if editing
     */
    exports.isLabelEditing = function isLabelEditing(label) {
        return label && label.classList.contains('label-editing');
    };

    /**
     * Store original label state for restoration
     *
     * @param {HTMLElement} label - Label element
     */
    exports.storeOriginalState = function storeOriginalState(label) {
        if (!label) return;
        label.dataset.originalText = label.textContent;
        label.dataset.originalMaxWidth = label.style.maxWidth;
        label.dataset.originalWhitespace = label.style.whiteSpace;
        label.dataset.originalOverflow = label.style.overflow;
    };

    /**
     * Get stored original state from label
     *
     * @param {HTMLElement} label - Label element
     * @returns {{text: string, maxWidth: string, whiteSpace: string, overflow: string}}
     */
    exports.getOriginalState = function getOriginalState(label) {
        if (!label) {
            return {
                text: 'Click to edit',
                maxWidth: '180px',
                whiteSpace: 'nowrap',
                overflow: 'visible'
            };
        }
        return {
            text: label.dataset.originalText || 'Click to edit',
            maxWidth: label.dataset.originalMaxWidth || '180px',
            whiteSpace: label.dataset.originalWhitespace || 'nowrap',
            overflow: label.dataset.originalOverflow || 'visible'
        };
    };

    /**
     * Apply expanded read-only styles to label
     *
     * @param {HTMLElement} label - Label element
     * @param {string} fullText - Full text content
     */
    exports.applyExpandedReadOnlyStyles = function applyExpandedReadOnlyStyles(label, fullText) {
        if (!label) return;

        label.style.maxWidth = exports.EXPANDED_MAX_WIDTH + 'px';
        label.style.minWidth = exports.needsWiderLabel(fullText) ? '200px' : '';
        label.style.width = 'fit-content';
        label.style.whiteSpace = 'pre-wrap';
        label.style.overflow = 'visible';
        label.style.zIndex = String(exports.EXPANDED_Z_INDEX);

        label.classList.add('label-expanded');
        label.classList.remove('label-editing');
    };

    /**
     * Apply edit mode styles to label
     *
     * @param {HTMLElement} label - Label element
     */
    exports.applyEditStyles = function applyEditStyles(label) {
        if (!label) return;

        label.style.maxWidth = exports.EXPANDED_MAX_WIDTH + 'px';
        label.style.minWidth = exports.EDIT_MIN_WIDTH + 'px';
        label.style.width = exports.EDIT_MIN_WIDTH + 'px';
        label.style.whiteSpace = 'pre-wrap';
        label.style.overflow = 'visible';
        label.style.zIndex = String(exports.EXPANDED_Z_INDEX);

        label.classList.add('label-expanded');
        label.classList.add('label-editing');
    };

    /**
     * Restore collapsed styles to label
     *
     * @param {HTMLElement} label - Label element
     */
    exports.restoreCollapsedStyles = function restoreCollapsedStyles(label) {
        if (!label) return;

        const original = exports.getOriginalState(label);

        label.style.maxWidth = original.maxWidth;
        label.style.minWidth = '';
        label.style.width = '';
        label.style.whiteSpace = original.whiteSpace;
        label.style.overflow = original.overflow;
        label.style.zIndex = '';

        label.classList.remove('label-expanded');
        label.classList.remove('label-editing');
    };

    // =========================================================================
    // Textarea Helpers
    // =========================================================================

    /**
     * Create textarea CSS style string
     *
     * @returns {string} CSS style string for textarea
     */
    exports.getTextareaStyles = function getTextareaStyles() {
        return [
            'width: 100%',
            'min-height: ' + exports.TEXTAREA_MIN_HEIGHT + 'px',
            'max-height: ' + exports.TEXTAREA_MAX_HEIGHT + 'px',
            'border: none',
            'outline: none',
            'background: transparent',
            'color: inherit',
            'font-size: 12px',
            'font-family: inherit',
            'resize: vertical',
            'padding: 0',
            'margin: 0'
        ].join('; ');
    };

    /**
     * Create auto-resize handler for textarea
     *
     * @param {HTMLTextAreaElement} textarea - Textarea element
     * @param {number} [maxHeight] - Maximum height (default: TEXTAREA_MAX_HEIGHT)
     * @returns {Function} Resize handler function
     */
    exports.createAutoResizeHandler = function createAutoResizeHandler(textarea, maxHeight) {
        if (maxHeight === undefined) maxHeight = exports.TEXTAREA_MAX_HEIGHT;
        return function () {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(maxHeight, textarea.scrollHeight) + 'px';
        };
    };

    // =========================================================================
    // Marker Helpers
    // =========================================================================

    /**
     * Get identifier from annotation marker element
     *
     * @param {HTMLElement} marker - Annotation marker element
     * @returns {string|null} Identifier or null
     */
    exports.getMarkerIdentifier = function getMarkerIdentifier(marker) {
        if (!marker) return null;
        return marker.dataset.identifier ||
               marker.dataset.annotationRequestId ||
               marker.dataset.annotationIdentifier ||
               marker.dataset.annotationXref ||
               null;
    };

    /**
     * Get page index from annotation marker element
     *
     * @param {HTMLElement} marker - Annotation marker element
     * @returns {number} Page index (0-based)
     */
    exports.getMarkerPageIndex = function getMarkerPageIndex(marker) {
        if (!marker) return 0;
        return parseInt(marker.dataset.annotationPage || marker.dataset.pageIdx || '0', 10);
    };

    /**
     * Update marker and label colors for a priority
     *
     * @param {HTMLElement} marker - Annotation marker element
     * @param {HTMLElement} label - Label element
     * @param {string} priority - Priority level
     */
    exports.updateMarkerColors = function updateMarkerColors(marker, label, priority) {
        if (marker) {
            marker.style.backgroundColor = exports.getPriorityBackgroundColor(priority);
        }
        if (label) {
            label.style.borderLeft = '4px solid ' + exports.getPriorityBorderColor(priority);
        }
    };

})(window.PdfPreviewModalInlineEditor);

// Version marker
window.PdfPreviewModalInlineEditor._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.inlineEditor = window.PdfPreviewModalInlineEditor;
