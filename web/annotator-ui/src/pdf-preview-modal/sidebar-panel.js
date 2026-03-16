/**
 * PDF Preview Modal - Sidebar Panel Helpers
 *
 * Pure helper functions for the annotation sidebar panel.
 * The main renderAnnotationsList() logic remains in pdf-preview-modal.js
 * due to tight state coupling (will be migrated in future phases).
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 6).
 *
 * @module pdf-preview-modal/sidebar-panel
 */

// Namespace for PDF Preview Modal sidebar panel helpers
window.PdfPreviewModalSidebarPanel = window.PdfPreviewModalSidebarPanel || {};

(function (exports) {
    'use strict';

    function translateSidebarText(key, params) {
        var translator = window.i18n && typeof window.i18n.t === 'function'
            ? window.i18n.t.bind(window.i18n)
            : null;
        if (translator) {
            return translator(key, params || {});
        }

        var text = key;
        Object.entries(params || {}).forEach(function ([name, value]) {
            text = text.replace(new RegExp('%\\(' + name + '\\)s', 'g'), String(value));
        });
        return text;
    }

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Placeholder strings that indicate empty/new annotations
     * @type {string[]}
     */
    exports.PLACEHOLDER_STRINGS = ['', 'New comment...', 'New comment'];

    /**
     * Empty state message for no visible annotations
     * @type {string}
     */
    exports.EMPTY_STATE_MESSAGE = translateSidebarText('No comments visible in viewport');

    /**
     * Default text for annotations without content
     * @type {string}
     */
    exports.DEFAULT_DISPLAY_TEXT = translateSidebarText('No comment text');

    // =========================================================================
    // Name Helpers
    // =========================================================================

    /**
     * Name display modes for grader/author badges.
     * @type {{FULL: string, REDUCED: string}}
     */
    exports.NAME_DISPLAY_MODE = {
        FULL: 'full',
        REDUCED: 'reduced'
    };

    /**
     * Strip role suffix from a display name.
     *
     * @param {string} fullName - Full name, optionally with role in parentheses
     * @returns {string} Name without trailing role suffix
     */
    function stripRoleSuffix(fullName) {
        var raw = String(fullName || '').trim();
        if (!raw) {
            return '';
        }
        var roleMatch = raw.match(/^(.+?)\s*(\([^)]+\))$/);
        return roleMatch ? roleMatch[1].trim() : raw;
    }

    /**
     * Build dotted initial(s) for one token.
     * Handles hyphenated tokens such as "Eva-Karin" -> "E-K.".
     *
     * @param {string} token - Name token
     * @returns {string} Initials for the token
     */
    function toTokenInitials(token) {
        if (!token) {
            return '';
        }
        var segmentInitials = token
            .split('-')
            .filter(function (segment) { return segment; })
            .map(function (segment) {
                return segment.charAt(0).toUpperCase();
            })
            .join('-');
        return segmentInitials ? segmentInitials + '.' : '';
    }

    /**
     * Format a display name for the grader badge.
     * Role labels in parentheses are intentionally removed.
     *
     * Modes:
     * - full: "Anna Maria Lindstrom" -> "Anna Maria L."
     * - reduced: "Anna Maria Lindstrom" -> "A.M.L."
     *
     * @example
     * formatDisplayName("Artem Kulachenko (Instructor)", "full") // "Artem K."
     * formatDisplayName("Artem Kulachenko (Instructor)", "reduced") // "A.K."
     * formatDisplayName("Eva-Karin Lindstrom", "reduced") // "E-K.L."
     *
     * @param {string} fullName - Full name, optionally with role in parentheses
     * @param {string} [mode] - Display mode ("full" or "reduced")
     * @returns {string} Formatted name
     */
    exports.formatDisplayName = function formatDisplayName(fullName, mode) {
        var nameOnly = stripRoleSuffix(fullName);
        if (!nameOnly) {
            return '';
        }

        var nameParts = nameOnly.split(/\s+/).filter(function (part) { return part; });
        if (nameParts.length < 2) {
            return nameOnly;
        }

        if (mode === exports.NAME_DISPLAY_MODE.REDUCED) {
            return nameParts.map(toTokenInitials).join('');
        }

        var givenNames = nameParts.slice(0, -1).join(' ');
        var surnameInitial = toTokenInitials(nameParts[nameParts.length - 1]);
        return (givenNames + ' ' + surnameInitial).trim();
    };

    /**
     * Backward-compatible alias for the previous behavior.
     *
     * @param {string} fullName - Full name
     * @returns {string} Formatted name in full mode
     */
    exports.abbreviateName = function abbreviateName(fullName) {
        return exports.formatDisplayName(fullName, exports.NAME_DISPLAY_MODE.FULL);
    };

    // =========================================================================
    // Comment ID Helpers
    // =========================================================================

    /**
     * Generate a display comment ID from page index and annotation index
     * Format: "#PageNum.Index" (1-based)
     *
     * @example
     * generateCommentId(0, 0) // "#1.1"
     * generateCommentId(2, 4) // "#3.5"
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {number} indexOnPage - Zero-based index on page
     * @returns {string} Comment ID string
     */
    exports.generateCommentId = function generateCommentId(pageIdx, indexOnPage) {
        return '#' + (pageIdx + 1) + '.' + (indexOnPage + 1);
    };

    /**
     * Generate a DOM ID for an annotation element
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {string} identifier - Annotation identifier
     * @returns {string} DOM ID string
     */
    exports.generateAnnotationDomId = function generateAnnotationDomId(pageIdx, identifier) {
        return 'ann-' + pageIdx + '-' + (identifier || 'unknown');
    };

    // =========================================================================
    // Priority Helpers
    // =========================================================================

    /**
     * Get Bootstrap color class for a priority level
     *
     * @param {string} priority - Priority level (red, amber, green)
     * @returns {string} Bootstrap color class (danger, warning, success)
     */
    exports.getPriorityColorClass = function getPriorityColorClass(priority) {
        switch (priority) {
            case 'red':
                return 'danger';
            case 'green':
                return 'success';
            case 'amber':
            default:
                return 'warning';
        }
    };

    // =========================================================================
    // Content Helpers
    // =========================================================================

    /**
     * Check if content is a placeholder value
     *
     * @param {string} content - Content to check
     * @returns {boolean} True if content is empty or placeholder text
     */
    exports.isPlaceholderContent = function isPlaceholderContent(content) {
        var trimmed = (content || '').trim();
        return exports.PLACEHOLDER_STRINGS.indexOf(trimmed) !== -1;
    };

    /**
     * Get content for editing (empty string for placeholders)
     *
     * @param {string} content - Raw content
     * @returns {string} Content suitable for editing
     */
    exports.getEditContent = function getEditContent(content) {
        return exports.isPlaceholderContent(content) ? '' : (content || '');
    };

    /**
     * Get content for display (fallback text for empty)
     *
     * @param {string} content - Raw content
     * @returns {string} Content suitable for display
     */
    exports.getDisplayContent = function getDisplayContent(content) {
        return content || exports.DEFAULT_DISPLAY_TEXT;
    };

    // =========================================================================
    // Annotation Filtering & Sorting
    // =========================================================================

    /**
     * Check if an annotation should be displayed in the sidebar
     *
     * @param {Object} annotation - Annotation object
     * @param {boolean} isVisible - Whether the annotation marker is visible
     * @returns {boolean} True if should be displayed
     */
    exports.shouldDisplayAnnotation = function shouldDisplayAnnotation(annotation, isVisible) {
        if (!isVisible) {
            return false;
        }

        var content = (annotation.content || '').trim();
        var isPlaceholder = exports.isPlaceholderContent(content);

        // Allow temporary annotations even if placeholder (user is actively creating them)
        // Also allow annotations that have been edited (e.g., priority changed) even if placeholder
        var hasBeenEdited = annotation._hasBeenEdited === true || annotation._priorityChanged === true;

        return !isPlaceholder || annotation._isTemporary || hasBeenEdited;
    };

    /**
     * Sort annotations by page index, then by index on page
     *
     * @param {Object} a - First annotation with pageIdx and indexOnPage
     * @param {Object} b - Second annotation with pageIdx and indexOnPage
     * @returns {number} Sort comparison result
     */
    exports.sortAnnotations = function sortAnnotations(a, b) {
        if (a.pageIdx !== b.pageIdx) {
            return a.pageIdx - b.pageIdx;
        }
        return a.indexOnPage - b.indexOnPage;
    };

    /**
     * Collect and filter annotations for display from annotations data
     *
     * @param {Object} annotationsData - Page index to annotations array map
     * @param {Set|Map} visibleMarkers - Set of visible marker keys ("pageIdx:xref")
     * @returns {Array} Sorted array of annotations with pageIdx and indexOnPage added
     */
    exports.collectVisibleAnnotations = function collectVisibleAnnotations(annotationsData, visibleMarkers) {
        var allAnnotations = [];

        for (var pageIdxStr in annotationsData) {
            if (!Object.prototype.hasOwnProperty.call(annotationsData, pageIdxStr)) {
                continue;
            }

            var pageIdx = parseInt(pageIdxStr, 10);
            var pageAnns = annotationsData[pageIdxStr] || [];

            for (var idx = 0; idx < pageAnns.length; idx++) {
                var ann = pageAnns[idx];
                var xref = ann.xref;
                var markerKey = pageIdx + ':' + xref;

                var isVisible = visibleMarkers && (
                    typeof visibleMarkers.has === 'function'
                        ? visibleMarkers.has(markerKey)
                        : markerKey in visibleMarkers
                );

                if (exports.shouldDisplayAnnotation(ann, isVisible)) {
                    // Create new object with added properties
                    var annotationWithMeta = Object.assign({}, ann, {
                        pageIdx: pageIdx,
                        indexOnPage: idx
                    });
                    allAnnotations.push(annotationWithMeta);
                }
            }
        }

        // Sort by page first, then by index on page
        allAnnotations.sort(exports.sortAnnotations);

        return allAnnotations;
    };

    // =========================================================================
    // Page Separator Helpers
    // =========================================================================

    /**
     * Check if a page separator should be shown before this annotation
     *
     * @param {number|null} lastPageIdx - Previous annotation's page index
     * @param {number} currentPageIdx - Current annotation's page index
     * @returns {boolean} True if separator should be shown
     */
    exports.needsPageSeparator = function needsPageSeparator(lastPageIdx, currentPageIdx) {
        return lastPageIdx !== null && currentPageIdx !== lastPageIdx;
    };

    /**
     * Generate page separator HTML
     *
     * @param {number} pageIdx - Zero-based page index
     * @returns {string} HTML string for page separator
     */
    exports.generatePageSeparatorHtml = function generatePageSeparatorHtml(pageIdx) {
        return '<div class="page-separator">' +
            '<small class="text-muted d-block text-center page-separator-label">' + translateSidebarText('Page %(page)s', { page: pageIdx + 1 }) + '</small>' +
            '</div>';
    };

    // =========================================================================
    // Identifier Extraction Helpers
    // =========================================================================

    /**
     * Extract the best identifier from a button's data attributes
     *
     * @param {HTMLElement} button - Button element with data attributes
     * @returns {string|null} Best available identifier or null
     */
    exports.extractIdentifierFromButton = function extractIdentifierFromButton(button) {
        if (!button || !button.dataset) {
            return null;
        }
        return button.dataset.annotationRequestId ||
               button.dataset.annotationIdentifier ||
               button.dataset.annotationXref ||
               null;
    };

    /**
     * Get page index from a button's data attributes
     *
     * @param {HTMLElement} button - Button element with data attributes
     * @returns {number} Page index (defaults to 0)
     */
    exports.getPageIndexFromButton = function getPageIndexFromButton(button) {
        if (!button || !button.dataset) {
            return 0;
        }
        return parseInt(button.dataset.annotationPage || '0', 10);
    };

})(window.PdfPreviewModalSidebarPanel);

// Version marker
window.PdfPreviewModalSidebarPanel._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.sidebarPanel = window.PdfPreviewModalSidebarPanel;
