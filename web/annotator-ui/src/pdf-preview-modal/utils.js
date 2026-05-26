/**
 * PDF Preview Modal - Utility Functions
 *
 * Pure utility functions extracted from pdf-preview-modal.js for better
 * modularity and testability.
 *
 * This module uses AEMS.utils when available for shared utilities,
 * with local fallbacks for standalone operation.
 *
 * @module pdf-preview-modal/utils
 */

// Namespace for PDF Preview Modal utilities
window.PdfPreviewModalUtils = window.PdfPreviewModalUtils || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // AEMS Integration Helpers
    // =========================================================================

    /**
     * Get a utility function from AEMS.utils or return fallback
     * @param {string} name - Function name
     * @param {Function} fallback - Fallback implementation
     * @returns {Function}
     */
    function getAEMSUtil(name, fallback) {
        if (window.AEMS && window.AEMS.utils && typeof window.AEMS.utils[name] === 'function') {
            return window.AEMS.utils[name];
        }
        return fallback;
    }

    // =========================================================================
    // Debug Logging
    // =========================================================================

    /**
     * Debug flag - set to true to enable console logging
     * @type {boolean}
     */
    exports.PDF_DEBUG = false;

    /**
     * Debug logging function - no-op in production
     * Enable by setting PDF_DEBUG = true
     * @function
     */
    exports.debugLog = exports.PDF_DEBUG
        ? function (...args) { console.log('[PDF-PREVIEW]', ...args); }
        : function () { };

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * Placeholder strings for annotation content
     * Used to detect empty/new annotations
     * @type {string[]}
     */
    exports.PLACEHOLDER_STRINGS = ['', 'New comment...', 'New comment'];

    // =========================================================================
    // CSRF Handling
    // =========================================================================

    /**
     * Add CSRF token to request headers
     * Uses AEMS.utils.getCsrfToken when available
     *
     * @param {Object} [headers={}] - Existing headers object
     * @returns {Object} Headers with X-CSRFToken added
     */
    exports.withCsrf = function withCsrf(headers) {
        headers = headers || {};
        var getCsrfToken = getAEMSUtil('getCsrfToken', function () {
            var el = document.querySelector('meta[name="csrf-token"]');
            return el ? el.getAttribute('content') : null;
        });
        var token = getCsrfToken();
        if (token) {
            var result = {};
            for (var key in headers) {
                if (Object.prototype.hasOwnProperty.call(headers, key)) {
                    result[key] = headers[key];
                }
            }
            result['X-CSRFToken'] = token;
            return result;
        }
        return headers;
    };

    /**
     * Decide whether annotation requests should use offline API routes.
     *
     * The offline wizard page hosts both true offline review and local-agent
     * review. Local review must still talk to the paired desktop agent even
     * though window.__WIZARD_MODE remains "offline" at the page level.
     *
     * @param {string|null|undefined} assignmentMode - Effective preview mode
     * @returns {boolean} True when annotation requests should use offline routes
     */
    exports.shouldUseOfflineAnnotationRoutes = function shouldUseOfflineAnnotationRoutes(assignmentMode) {
        if (assignmentMode === 'local') {
            return false;
        }
        if (assignmentMode === 'offline') {
            return true;
        }
        return window.__WIZARD_MODE === 'offline';
    };

    // =========================================================================
    // String Escaping
    // =========================================================================

    /**
     * Escape a string for use in CSS attribute selectors
     * Uses CSS.escape if available, falls back to regex escaping
     *
     * @param {*} value - Value to escape (will be converted to string)
     * @returns {string} CSS-safe escaped string
     */
    exports.escapeCssAttribute = function escapeCssAttribute(value) {
        var text = String(value);
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            return CSS.escape(text);
        }
        // Fallback: escape quotes and backslashes
        return text.replace(/(["\\])/g, '\\$1');
    };

    /**
     * Escape HTML to prevent XSS attacks
     * Uses AEMS.utils.escapeHtml when available
     *
     * @param {*} text - Text to escape (null/undefined returns empty string)
     * @returns {string} HTML-safe escaped text
     */
    exports.escapeHtml = getAEMSUtil('escapeHtml', function escapeHtml(text) {
        if (text == null) return '';
        var div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;  
    });

    // =========================================================================
    // Textarea Auto-Resize
    // =========================================================================

    /**
     * Setup auto-resize behavior for a textarea element
     * Makes the textarea grow/shrink based on content, with min/max constraints
     *
     * Features:
     * - Resizes on input events
     * - Min height: 60px, Max height: 300px
     * - Bidirectional sync for sidebar textareas (syncs to inline PDF editor)
     * - Prevents duplicate setup via _autoResizeSetup flag
     *
     * @param {HTMLTextAreaElement} textarea - The textarea element
     * @param {Function} [escapeCssAttributeFn] - CSS escape function for selector building
     *
     * @example
     * setupTextareaAutoResize(document.getElementById('myTextarea'));
     */
    exports.setupTextareaAutoResize = function setupTextareaAutoResize(textarea, escapeCssAttributeFn) {
        if (!textarea || textarea._autoResizeSetup) return;
        textarea._autoResizeSetup = true;

        // Use provided escape function or fall back to module's version
        const escapeCss = escapeCssAttributeFn || exports.escapeCssAttribute;

        const resize = () => {
            // Reset height to auto to get the correct scrollHeight
            textarea.style.height = 'auto';
            // Set height to scrollHeight (content height) with constraints
            const newHeight = Math.min(Math.max(textarea.scrollHeight, 60), 300);
            textarea.style.height = newHeight + 'px';
        };

        // Resize on input
        textarea.addEventListener('input', resize);

        // SYNC: If this is a sidebar textarea (edit-annotation-text-*), sync to PDF inline editor
        if (textarea.id && textarea.id.startsWith('edit-annotation-text-')) {
            const identifier = textarea.id.replace('edit-annotation-text-', '');
            textarea.addEventListener('input', () => {
                // Find the corresponding inline editor on the PDF
                const escapedId = escapeCss(identifier);
                const markerSelector = [
                    `.annotation-marker[data-identifier="${escapedId}"]`,
                    `.annotation-marker[data-annotation-request-id="${escapedId}"]`,
                    `.annotation-marker[data-annotation-identifier="${escapedId}"]`,
                    `.annotation-marker[data-annotation-xref="${escapedId}"]`
                ].join(', ');

                const marker = document.querySelector(markerSelector);
                if (marker) {
                    const label = marker.querySelector('.annotation-label');
                    if (label && label.classList.contains('label-editing')) {
                        const inlineTextarea = label.querySelector('.inline-annotation-editor');
                        if (inlineTextarea && inlineTextarea !== document.activeElement) {
                            inlineTextarea.value = textarea.value;
                            // NOTE: Do NOT update label.dataset.fullText here - it should only be
                            // updated after successful save, so we can detect changes properly
                        }
                    }
                }
            });
        }

        // Initial resize
        setTimeout(resize, 0);
    };

    // =========================================================================
    // Module Detection
    // =========================================================================

    /**
     * Check if a value is a placeholder (empty or placeholder text)
     *
     * @param {string} content - Content to check
     * @returns {boolean} True if content is a placeholder
     */
    exports.isPlaceholderContent = function isPlaceholderContent(content) {
        const trimmed = (content || '').trim();
        return exports.PLACEHOLDER_STRINGS.includes(trimmed);
    };

})(window.PdfPreviewModalUtils);

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.utils = window.PdfPreviewModalUtils;

// Also expose individual functions globally for backwards compatibility
// These can be removed once the main file is fully migrated
/* exported escapeHtml, escapeCssAttribute, withCsrf, setupTextareaAutoResize */
