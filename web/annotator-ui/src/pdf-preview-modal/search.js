/**
 * PDF Preview Modal - Search Helpers
 *
 * Pure helper functions for PDF text search operations.
 * The main search logic remains in pdf-preview-modal.js due to state/DOM coupling.
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 9).
 *
 * @module pdf-preview-modal/search
 */

// Namespace for PDF Preview Modal search helpers
window.PdfPreviewModalSearch = window.PdfPreviewModalSearch || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Default font for text measurement (matches PDF.js rendering)
     * @type {string}
     */
    exports.MEASURE_FONT = '100px "Times New Roman", serif';

    /**
     * Delay before highlighting after scroll (ms)
     * @type {number}
     */
    exports.HIGHLIGHT_DELAY = 150;

    /**
     * Delay for re-highlighting after resize (ms)
     * @type {number}
     */
    exports.RESIZE_HIGHLIGHT_DELAY = 100;

    // =========================================================================
    // State Helpers
    // =========================================================================

    /**
     * Create initial search state object
     *
     * @returns {{term: string, matches: Array, currentIndex: number, pageTextCache: Map, searching: boolean}}
     */
    exports.createSearchState = function createSearchState() {
        return {
            term: '',
            matches: [],
            currentIndex: -1,
            pageTextCache: new Map(),
            searching: false
        };
    };

    /**
     * Reset search state to initial values
     *
     * @param {Object} state - Search state object
     * @returns {Object} Reset state
     */
    exports.resetSearchState = function resetSearchState(state) {
        state.term = '';
        state.matches = [];
        state.currentIndex = -1;
        state.pageTextCache.clear();
        state.searching = false;
        return state;
    };

    // =========================================================================
    // Term Helpers
    // =========================================================================

    /**
     * Normalize search term for matching
     *
     * @param {string} term - Raw search term
     * @returns {string} Normalized term (lowercase, trimmed)
     */
    exports.normalizeSearchTerm = function normalizeSearchTerm(term) {
        return (term || '').trim().toLowerCase();
    };

    /**
     * Check if search term is valid (non-empty after normalization)
     *
     * @param {string} term - Raw search term
     * @returns {boolean} True if valid
     */
    exports.isValidSearchTerm = function isValidSearchTerm(term) {
        return exports.normalizeSearchTerm(term).length > 0;
    };

    // =========================================================================
    // Navigation Helpers
    // =========================================================================

    /**
     * Calculate next match index with wraparound
     *
     * @param {number} currentIndex - Current match index
     * @param {number} totalMatches - Total number of matches
     * @returns {number} Next index
     */
    exports.calculateNextMatchIndex = function calculateNextMatchIndex(currentIndex, totalMatches) {
        if (totalMatches <= 0) return -1;
        return (currentIndex + 1) % totalMatches;
    };

    /**
     * Calculate previous match index with wraparound
     *
     * @param {number} currentIndex - Current match index
     * @param {number} totalMatches - Total number of matches
     * @returns {number} Previous index
     */
    exports.calculatePrevMatchIndex = function calculatePrevMatchIndex(currentIndex, totalMatches) {
        if (totalMatches <= 0) return -1;
        return (currentIndex - 1 + totalMatches) % totalMatches;
    };

    /**
     * Check if there are any matches
     *
     * @param {Array} matches - Array of match objects
     * @returns {boolean} True if has matches
     */
    exports.hasMatches = function hasMatches(matches) {
        return Array.isArray(matches) && matches.length > 0;
    };

    // =========================================================================
    // Match Object Helpers
    // =========================================================================

    /**
     * Create a match object
     *
     * @param {number} page - Page number (1-based)
     * @param {number} offset - Character offset in page text
     * @param {string} preview - Text preview around match
     * @returns {{page: number, offset: number, preview: string}}
     */
    exports.createMatchObject = function createMatchObject(page, offset, preview) {
        return {
            page: page,
            offset: offset,
            preview: preview || ''
        };
    };

    /**
     * Get match at index (with bounds checking)
     *
     * @param {Array} matches - Array of match objects
     * @param {number} index - Match index
     * @returns {Object|null} Match object or null
     */
    exports.getMatchAtIndex = function getMatchAtIndex(matches, index) {
        if (!Array.isArray(matches) || index < 0 || index >= matches.length) {
            return null;
        }
        return matches[index];
    };

    // =========================================================================
    // Status Message Helpers
    // =========================================================================

    /**
     * Format match status message
     *
     * @param {number} currentIndex - Current match index (0-based)
     * @param {number} totalMatches - Total number of matches
     * @param {number} page - Current page number
     * @returns {string} Formatted status message
     */
    exports.formatMatchStatus = function formatMatchStatus(currentIndex, totalMatches, page) {
        if (totalMatches <= 0 || currentIndex < 0) {
            return '';
        }
        return 'Match ' + (currentIndex + 1) + '/' + totalMatches + ' on page ' + page;
    };

    /**
     * Get status message for search state
     *
     * @param {string} type - Status type ('no_matches', 'enter_term', 'searching', 'load_pdf')
     * @returns {string} Status message
     */
    exports.getStatusMessage = function getStatusMessage(type) {
        var messages = {
            'no_matches': 'No matches',
            'enter_term': 'Enter a search term',
            'searching': 'Searching…',
            'load_pdf': 'Load graded PDF first'
        };
        return messages[type] || '';
    };

    // =========================================================================
    // Text Extraction Helpers
    // =========================================================================

    /**
     * Normalize page text for searching
     * Joins text items with spaces and normalizes to lowercase
     *
     * @param {Array<{str: string}>} textItems - Text items from PDF.js
     * @returns {string} Normalized text
     */
    exports.normalizePageText = function normalizePageText(textItems) {
        if (!Array.isArray(textItems)) return '';
        return textItems.map(function (item) {
            return item.str || '';
        }).join(' ').toLowerCase();
    };

    /**
     * Find all occurrences of term in text
     *
     * @param {string} text - Text to search in (should be normalized)
     * @param {string} term - Term to find (should be normalized)
     * @returns {number[]} Array of offset positions
     */
    exports.findTermOccurrences = function findTermOccurrences(text, term) {
        var occurrences = [];
        if (!text || !term) return occurrences;

        var offset = text.indexOf(term);
        while (offset !== -1) {
            occurrences.push(offset);
            offset = text.indexOf(term, offset + term.length);
        }
        return occurrences;
    };

    /**
     * Extract preview text around a match
     *
     * @param {string} text - Full text
     * @param {number} offset - Match offset
     * @param {number} termLength - Length of search term
     * @param {number} [contextChars=20] - Characters of context on each side
     * @returns {string} Preview text
     */
    exports.extractMatchPreview = function extractMatchPreview(text, offset, termLength, contextChars) {
        if (contextChars === undefined) contextChars = 20;
        if (!text || offset < 0) return '';

        var start = Math.max(0, offset - contextChars);
        var end = Math.min(text.length, offset + termLength + contextChars);

        var prefix = start > 0 ? '...' : '';
        var suffix = end < text.length ? '...' : '';

        return prefix + text.substring(start, end) + suffix;
    };

    // =========================================================================
    // Highlight Geometry Helpers
    // =========================================================================

    /**
     * Calculate text width ratio for partial highlighting
     *
     * @param {CanvasRenderingContext2D} ctx - Measuring context
     * @param {string} fullText - Full text item
     * @param {number} localStart - Start position in text
     * @param {number} localEnd - End position in text
     * @returns {{startRatio: number, widthRatio: number}}
     */
    exports.calculateTextRatios = function calculateTextRatios(ctx, fullText, localStart, localEnd) {
        if (!ctx || !fullText) {
            return { startRatio: 0, widthRatio: 1 };
        }

        var fullWidth = ctx.measureText(fullText).width || 1;
        var prefixWidth = ctx.measureText(fullText.substring(0, localStart)).width;
        var matchWidth = ctx.measureText(fullText.substring(localStart, localEnd)).width;

        return {
            startRatio: prefixWidth / fullWidth,
            widthRatio: matchWidth / fullWidth
        };
    };

    /**
     * Calculate PDF coordinates for highlight rectangle
     *
     * @param {Object} transform - PDF.js text item transform
     * @param {number} itemWidth - Text item width
     * @param {number} startRatio - Start position ratio
     * @param {number} widthRatio - Width ratio
     * @returns {{x: number, y: number, w: number, h: number}}
     */
    exports.calculatePdfHighlightRect = function calculatePdfHighlightRect(transform, itemWidth, startRatio, widthRatio) {
        var tx = transform || [1, 0, 0, 1, 0, 0];
        var itemHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[0]);

        return {
            x: tx[4] + (itemWidth * startRatio),
            y: tx[5],
            w: itemWidth * widthRatio,
            h: itemHeight
        };
    };

    /**
     * Convert viewport rectangle to screen coordinates with padding
     *
     * @param {number} rawX - Raw X coordinate
     * @param {number} rawY - Raw Y coordinate
     * @param {number} rawW - Raw width
     * @param {number} rawH - Raw height
     * @param {number} scaleX - X scale factor
     * @param {number} scaleY - Y scale factor
     * @returns {{left: number, top: number, width: number, height: number}}
     */
    exports.calculateHighlightScreenRect = function calculateHighlightScreenRect(
        rawX, rawY, rawW, rawH, scaleX, scaleY
    ) {
        var finalX = rawX * scaleX;
        var finalY = rawY * scaleY;
        var finalW = rawW * scaleX;
        var finalH = rawH * scaleY;

        // Generous padding and optical centering
        var padY = finalH * 0.2;
        var padX = 4 * scaleX;
        var verticalNudge = finalH * 0.1; // shift down to cover descenders

        return {
            left: finalX - padX,
            top: finalY - padY + verticalNudge,
            width: finalW + (padX * 2),
            height: finalH + (padY * 2)
        };
    };

    /**
     * Check if text item overlaps with target range
     *
     * @param {number} itemStart - Item start index
     * @param {number} itemEnd - Item end index
     * @param {number} targetStart - Target start index
     * @param {number} targetEnd - Target end index
     * @returns {boolean} True if overlaps
     */
    exports.textItemOverlapsTarget = function textItemOverlapsTarget(itemStart, itemEnd, targetStart, targetEnd) {
        return itemEnd > targetStart && itemStart < targetEnd;
    };

    /**
     * Calculate local start/end positions for highlighting within a text item
     *
     * @param {number} itemStart - Item start index in full text
     * @param {number} itemLength - Length of text item
     * @param {number} targetStart - Target highlight start
     * @param {number} targetEnd - Target highlight end
     * @returns {{localStart: number, localEnd: number}}
     */
    exports.calculateLocalHighlightRange = function calculateLocalHighlightRange(
        itemStart, itemLength, targetStart, targetEnd
    ) {
        return {
            localStart: Math.max(0, targetStart - itemStart),
            localEnd: Math.min(itemLength, targetEnd - itemStart)
        };
    };

})(window.PdfPreviewModalSearch);

// Version marker
window.PdfPreviewModalSearch._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.search = window.PdfPreviewModalSearch;
