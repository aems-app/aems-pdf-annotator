/**
 * PDF Preview Modal - Annotation Helper Functions
 *
 * Pure functions for annotation identifier resolution and priority handling.
 * Extracted from pdf-preview-modal.js for better modularity and testability.
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 2).
 *
 * @module pdf-preview-modal/annotation-helpers
 */

// Namespace for PDF Preview Modal annotation helpers
window.PdfPreviewModalAnnotationHelpers = window.PdfPreviewModalAnnotationHelpers || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /**
     * PDF annotation type names that are NOT valid identifiers
     * These are Canvas/PDF built-in type names
     * @type {string[]}
     */
    const ANNOTATION_TYPES = [
        'Text', 'Note', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut',
        'FreeText', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine',
        'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound'
    ];

    /**
     * Valid priority values
     * @type {string[]}
     */
    const PRIORITY_VALUES = ['red', 'amber', 'green'];

    // =========================================================================
    // Identifier Normalization
    // =========================================================================

    /**
     * Normalize an annotation identifier value
     * Trims whitespace and returns null for empty values
     *
     * @param {*} value - Value to normalize
     * @returns {string|null} Normalized string or null
     */
    exports.normalizeAnnotationIdentifierValue = function normalizeAnnotationIdentifierValue(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const normalized = String(value).trim();
        return normalized ? normalized : null;
    };

    /**
     * Check if a value is a PDF annotation type name (not a valid identifier)
     *
     * @param {*} value - Value to check
     * @returns {boolean} True if value is an annotation type name
     */
    exports.isAnnotationType = function isAnnotationType(value) {
        return ANNOTATION_TYPES.includes(String(value));
    };

    // =========================================================================
    // Composite Identifier Parsing
    // =========================================================================

    /**
     * Parse a composite identifier string into xref and stableId components
     * Handles formats like "xref:123", "id:uuid", "xref:123|id:uuid", "123"
     *
     * @param {*} raw - Raw identifier value
     * @returns {{xref: string|null, stableId: string|null}} Parsed components
     *
     * @example
     * parseCompositeIdentifier('xref:42|id:abc-123')
     * // => { xref: '42', stableId: 'abc-123' }
     */
    exports.parseCompositeIdentifier = function parseCompositeIdentifier(raw) {
        const value = exports.normalizeAnnotationIdentifierValue(raw);
        if (!value) {
            return { xref: null, stableId: null };
        }

        let xref = null;
        let stableId = null;

        const parts = value.split('|');
        parts.forEach((part) => {
            const token = part.trim();
            if (!token) return;

            if (token.startsWith('xref:')) {
                const v = token.slice(5).trim();
                if (v) xref = v;
                return;
            }
            if (token.startsWith('id:')) {
                const v = token.slice(3).trim();
                if (v) stableId = v;
                return;
            }
            // Numeric tokens are treated as xref if not already set
            if (/^\d+$/.test(token)) {
                if (xref === null) {
                    xref = token;
                }
                return;
            }
            // Non-numeric tokens are treated as stableId
            if (!stableId) {
                stableId = token;
            }
        });

        return { xref, stableId };
    };

    /**
     * Resolve annotation ID parts from multiple sources
     * Combines xref, requestId, and identifier fields to find best values
     *
     * @param {{xref?: *, requestId?: *, identifier?: *}} params - Input parameters
     * @returns {{xref: string|null, stableId: string|null}} Resolved values
     */
    exports.resolveAnnotationIdParts = function resolveAnnotationIdParts({ xref, requestId, identifier }) {
        const parsedRequest = exports.parseCompositeIdentifier(requestId);
        const parsedIdentifier = exports.parseCompositeIdentifier(identifier);

        const resolvedXref = exports.normalizeAnnotationIdentifierValue(xref)
            || parsedRequest.xref
            || parsedIdentifier.xref;

        const resolvedStable = exports.normalizeAnnotationIdentifierValue(requestId)
            || parsedRequest.stableId
            || parsedIdentifier.stableId
            || exports.normalizeAnnotationIdentifierValue(identifier);

        return { xref: resolvedXref, stableId: resolvedStable };
    };

    /**
     * Build an API-ready annotation identifier from multiple sources
     * Returns the best identifier format for API calls
     *
     * @param {{identifier?: *, xref?: *, requestId?: *}} params - Input parameters
     * @returns {string|null} API-ready identifier or null
     *
     * @example
     * buildApiAnnotationIdentifier({ xref: 42 }) // => 'xref:42'
     * buildApiAnnotationIdentifier({ identifier: 'my-id' }) // => 'my-id'
     */
    exports.buildApiAnnotationIdentifier = function buildApiAnnotationIdentifier({ identifier, xref, requestId }) {
        const normXref = exports.normalizeAnnotationIdentifierValue(xref);
        const normRequest = exports.normalizeAnnotationIdentifierValue(requestId);
        const normIdentifier = exports.normalizeAnnotationIdentifierValue(identifier);

        // Filter out annotation type names from requestId
        const validRequestId = normRequest && !exports.isAnnotationType(normRequest) ? normRequest : null;

        // Parse composites defensively
        const { xref: parsedXref, stableId: parsedStable } = exports.resolveAnnotationIdParts({
            xref: normXref,
            requestId: validRequestId,
            identifier: normIdentifier,
        });

        const effectiveXref = parsedXref || null;
        const effectiveStable = parsedStable || null;

        // Prefer exact xref when available
        if (effectiveXref) {
            return `xref:${effectiveXref}`;
        }

        if (effectiveStable) {
            // Prefix numeric IDs with id: to avoid confusion with xref
            if (/^\d+$/.test(effectiveStable)) {
                return `id:${effectiveStable}`;
            }
            return effectiveStable;
        }

        if (!normIdentifier) {
            return null;
        }

        return normIdentifier;
    };

    // =========================================================================
    // Annotation Entry Processing
    // =========================================================================

    /**
     * Extract a stable name/ID from an annotation entry
     * Checks multiple fields and returns the first valid one
     *
     * @param {Object} entry - Annotation entry object
     * @returns {string|null} Stable identifier or null
     */
    exports.extractAnnotationStableName = function extractAnnotationStableName(entry) {
        if (!entry) {
            return null;
        }
        const candidates = [
            entry.stable_id,
            entry.stableId,
            // Don't use id if it equals xref (it's just a copy)
            entry.id && entry.xref != null && String(entry.xref) === String(entry.id) ? null : entry.id,
            entry.name,
            entry.title,
        ];
        for (const candidate of candidates) {
            const normalized = exports.normalizeAnnotationIdentifierValue(candidate);
            if (
                normalized &&
                normalized !== '0' &&
                !exports.isAnnotationType(normalized)
            ) {
                return normalized;
            }
        }
        return null;
    };

    /**
     * Resolve the best identifier value from an annotation entry
     * Prefers stable IDs, falls back to xref, then other ID fields
     *
     * @param {Object} entry - Annotation entry object
     * @returns {string|null} Best identifier or null
     */
    exports.resolveAnnotationIdentifierValue = function resolveAnnotationIdentifierValue(entry) {
        if (!entry) {
            return null;
        }

        // Prefer stable IDs (most reliable for user-created annotations)
        const stableId = exports.extractAnnotationStableName(entry);
        // Allow fitz-* stable IDs for consistency with backend
        if (stableId && !exports.isAnnotationType(stableId)) {
            return stableId;
        }

        // Fall back to xref
        if (typeof entry.xref === 'number' && !Number.isNaN(entry.xref) && entry.xref > 0) {
            return String(entry.xref);
        }
        const normalizedXref = exports.normalizeAnnotationIdentifierValue(entry.xref);
        if (normalizedXref && normalizedXref !== '0') {
            return normalizedXref;
        }

        // Last resort: any valid ID field
        const candidateFields = [
            entry.identifier,
            entry.id,
            entry.name,
            entry.title,
        ];
        for (const candidate of candidateFields) {
            const normalized = exports.normalizeAnnotationIdentifierValue(candidate);
            if (
                normalized &&
                normalized !== '0' &&
                !exports.isAnnotationType(normalized)
            ) {
                return normalized;
            }
        }
        return null;
    };

    /**
     * Build a request identifier for an annotation entry
     * Returns the best identifier for API requests, excluding internal IDs
     *
     * @param {Object} entry - Annotation entry object
     * @returns {string|null} Request identifier or null
     */
    exports.buildAnnotationRequestIdentifier = function buildAnnotationRequestIdentifier(entry) {
        if (!entry) {
            return null;
        }

        // Prefer stable ID (but not fitz-* internal IDs)
        const stableId = exports.extractAnnotationStableName(entry);
        if (
            stableId &&
            !stableId.startsWith('fitz-') &&
            stableId !== '0' &&
            !exports.isAnnotationType(stableId)
        ) {
            return stableId;
        }

        // Fall back to xref
        const xref = typeof entry.xref === 'number' ? entry.xref : null;
        if (xref && xref > 0) {
            return String(xref);
        }

        // Last resort: identifier field
        const identifier = entry.identifier || entry.id;
        if (
            identifier &&
            !String(identifier).startsWith('fitz-') &&
            identifier !== '0' &&
            !exports.isAnnotationType(String(identifier))
        ) {
            return String(identifier);
        }

        return null;
    };

    // =========================================================================
    // Priority Helpers
    // =========================================================================

    /**
     * Normalize a priority value to one of: red, amber, green
     *
     * @param {*} value - Priority value to normalize
     * @returns {string|null} Normalized priority or null if invalid
     */
    exports.normalizePriorityValue = function normalizePriorityValue(value) {
        if (value === null || value === undefined) return null;
        const normalized = String(value).toLowerCase().trim();
        return PRIORITY_VALUES.includes(normalized) ? normalized : null;
    };

    /**
     * Derive priority from a color object
     * Analyzes RGB stroke values to determine red/amber/green
     *
     * @param {*} color - Color string or object with stroke array
     * @returns {string|null} Priority value or null
     */
    exports.derivePriorityFromColor = function derivePriorityFromColor(color) {
        if (!color) return null;
        if (typeof color === 'string') return exports.normalizePriorityValue(color);
        if (color.stroke && Array.isArray(color.stroke)) {
            const [r = 0, g = 0, b = 0] = color.stroke;
            // Color matching with tolerance for rounding/conversion errors
            // Red: high red, low green/blue
            if (r > 0.75 && g < 0.35 && b < 0.35) return 'red';
            // Green: low red, high green, low blue
            if (g > 0.45 && r < 0.45 && b < 0.45) return 'green';
            // Amber/Orange: high red, medium-high green, low blue
            if (r > 0.75 && g > 0.35 && b < 0.25) return 'amber';
        }
        return null;
    };

    /**
     * Derive the priority of an annotation entry
     * Checks priority field, then color, defaults to amber
     *
     * @param {Object} entry - Annotation entry object
     * @returns {string} Priority value (defaults to 'amber')
     */
    exports.deriveAnnotationPriority = function deriveAnnotationPriority(entry) {
        const priority = exports.normalizePriorityValue(entry?.priority)
            || exports.derivePriorityFromColor(entry?.color)
            || 'amber';
        return priority;
    };

    // =========================================================================
    // Annotation Source Resolution
    // =========================================================================

    /**
     * Resolve annotation source (AI or HUMAN)
     * Returns 'AI' or 'HUMAN' based on annotation data
     * For backward compatibility, defaults to 'AI' for annotations without explicit source
     *
     * @param {Object} ann - Annotation object
     * @returns {string} 'AI' or 'HUMAN'
     */
    exports.resolveAnnotationSource = function resolveAnnotationSource(ann) {
        if (ann.source === 'AI' || ann.source === 'HUMAN') {
            return ann.source;
        }
        // Fallback: use is_system_generated field for backward compatibility
        return ann.is_system_generated !== false ? 'AI' : 'HUMAN';
    };

})(window.PdfPreviewModalAnnotationHelpers);

// Export constants for testing
window.PdfPreviewModalAnnotationHelpers.PRIORITY_VALUES = ['red', 'amber', 'green'];

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.helpers = window.PdfPreviewModalAnnotationHelpers;
