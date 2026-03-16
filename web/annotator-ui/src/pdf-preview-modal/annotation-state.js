/**
 * PDF Preview Modal - Annotation State Management
 *
 * Pure functions for annotation state queries and lookups.
 * These functions accept state as parameters for testability.
 *
 * This module is part of the PDF Preview Modal refactoring sprint (Phase 3).
 *
 * @module pdf-preview-modal/annotation-state
 */

// Namespace for PDF Preview Modal state functions
window.PdfPreviewModalState = window.PdfPreviewModalState || {};

(function (exports) {
    'use strict';

    // Get annotation helpers (for identifier resolution)
    const helpers = window.PdfPreviewModalAnnotationHelpers || {};

    // =========================================================================
    // State Shape Documentation
    // =========================================================================

    /**
     * @typedef {Object} AnnotationEntry
     * @property {number|string} [xref] - PDF cross-reference number
     * @property {string} [id] - Internal ID
     * @property {string} [stable_id] - Stable identifier (UUID)
     * @property {string} [stableId] - Alias for stable_id
     * @property {string} [requestIdentifier] - Request identifier for API calls
     * @property {string} [name] - Optional name
     * @property {string} [title] - Optional title
     * @property {string} [content] - Annotation text content
     * @property {number} [page_index] - Zero-based page index
     * @property {Object} [color] - Color object with stroke array
     * @property {string} [priority] - red/amber/green priority
     * @property {Object} [rect] - Bounding rectangle
     * @property {boolean} [is_verdict] - Whether this annotation carries a final grading verdict
     */

    /**
     * @typedef {Object.<number, AnnotationEntry[]>} AnnotationsData
     * Page index to array of annotations mapping
     */

    /**
     * @typedef {Object} AnnotationStateSnapshot
     * @property {AnnotationsData} annotationsData - All annotations by page
     * @property {string|null} currentSubmissionId - Current submission being viewed
     * @property {string|null} currentAssignmentId - Current assignment ID
     * @property {number} currentAnnotationsPage - Current page for pagination
     * @property {string|null} editingAnnotationId - Currently editing annotation DOM ID
     * @property {string|null} updatingPriorityId - Annotation having priority updated
     */

    // =========================================================================
    // State Query Functions
    // =========================================================================

    /**
     * Get annotations for a specific page
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @param {number} pageIdx - Zero-based page index
     * @returns {AnnotationEntry[]} Array of annotations (empty if none)
     */
    exports.getPageAnnotations = function getPageAnnotations(annotationsData, pageIdx) {
        if (!annotationsData || typeof pageIdx !== 'number') {
            return [];
        }
        return annotationsData[pageIdx] || [];
    };

    /**
     * Get total annotation count across all pages
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @returns {number} Total count of annotations
     */
    exports.getTotalAnnotationCount = function getTotalAnnotationCount(annotationsData) {
        if (!annotationsData) {
            return 0;
        }
        return Object.values(annotationsData).reduce(
            (total, pageAnns) => total + (Array.isArray(pageAnns) ? pageAnns.length : 0),
            0
        );
    };

    /**
     * Get all page indices that have annotations
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @returns {number[]} Sorted array of page indices
     */
    exports.getAnnotatedPageIndices = function getAnnotatedPageIndices(annotationsData) {
        if (!annotationsData) {
            return [];
        }
        return Object.keys(annotationsData)
            .map(Number)
            .filter(pageIdx => {
                const anns = annotationsData[pageIdx];
                return Array.isArray(anns) && anns.length > 0;
            })
            .sort((a, b) => a - b);
    };

    // =========================================================================
    // Annotation Lookup Functions
    // =========================================================================

    /**
     * Find the index of an annotation in a page's annotation array
     * Matches by UUID first, then xref, then various ID fields
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @param {number} pageIdx - Zero-based page index
     * @param {*} identifier - Identifier to search for
     * @returns {number} Index in array, or -1 if not found
     */
    exports.findAnnotationIndex = function findAnnotationIndex(annotationsData, pageIdx, identifier) {
        // Use helper for normalization if available
        const normalize = helpers.normalizeAnnotationIdentifierValue ||
            function (v) { return v == null ? null : String(v).trim() || null; };
        const parseComposite = helpers.parseCompositeIdentifier ||
            function () { return { xref: null, stableId: null }; };

        const normalized = normalize(identifier);
        if (normalized === null) {
            return -1;
        }

        const pageEntries = exports.getPageAnnotations(annotationsData, pageIdx);

        // Parse the search identifier to get both xref and UUID
        const searchParts = parseComposite(normalized);
        const searchXref = searchParts.xref;
        const searchUuid = searchParts.stableId;

        return pageEntries.findIndex(function (ann) {
            // Parse annotation identifiers
            const annParts = parseComposite(ann.stable_id || ann.id || ann.requestIdentifier);
            const annXref = annParts.xref || ann.xref;
            const annUuid = annParts.stableId;

            // CRITICAL: Match by UUID first (most reliable)
            if (searchUuid && annUuid && searchUuid === annUuid) {
                return true;
            }

            // Match by xref
            if (searchXref && annXref && String(searchXref) === String(annXref)) {
                return true;
            }

            // Fallback: raw string comparisons
            if (ann.stable_id && String(ann.stable_id) === normalized) {
                return true;
            }
            if (ann.id && String(ann.id) === normalized) {
                return true;
            }
            if (ann.xref && String(ann.xref) === normalized) {
                return true;
            }
            if (ann.requestIdentifier && String(ann.requestIdentifier) === normalized) {
                return true;
            }

            return false;
        });
    };

    /**
     * Find an annotation entry by identifier
     * Matches by xref, requestIdentifier, or resolved identifier value
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @param {number} pageIdx - Zero-based page index
     * @param {*} identifier - Identifier to search for
     * @returns {AnnotationEntry|undefined} Found annotation or undefined
     */
    exports.findAnnotationEntry = function findAnnotationEntry(annotationsData, pageIdx, identifier) {
        // Use helpers for normalization if available
        const normalize = helpers.normalizeAnnotationIdentifierValue ||
            function (v) { return v == null ? null : String(v).trim() || null; };
        const resolveId = helpers.resolveAnnotationIdentifierValue ||
            function () { return null; };

        const normalized = normalize(identifier);
        if (normalized === null) {
            return undefined;
        }

        const pageEntries = exports.getPageAnnotations(annotationsData, pageIdx);

        return pageEntries.find(function (ann) {
            // Check xref (as string) - CRITICAL FIX for cross-page moves
            if (ann.xref && String(ann.xref) === normalized) {
                return true;
            }
            // Check requestIdentifier
            if (ann.requestIdentifier && normalize(ann.requestIdentifier) === normalized) {
                return true;
            }
            // Check resolved identifier
            if (resolveId(ann) === normalized) {
                return true;
            }
            return false;
        });
    };

    /**
     * Find an annotation across all pages
     * Returns both the annotation and its page index
     *
     * @param {AnnotationsData} annotationsData - Annotations data object
     * @param {*} identifier - Identifier to search for
     * @returns {{annotation: AnnotationEntry, pageIdx: number}|null} Found result or null
     */
    exports.findAnnotationAcrossPages = function findAnnotationAcrossPages(annotationsData, identifier) {
        if (!annotationsData) {
            return null;
        }

        const pageIndices = exports.getAnnotatedPageIndices(annotationsData);

        for (let i = 0; i < pageIndices.length; i++) {
            const pageIdx = pageIndices[i];
            const entry = exports.findAnnotationEntry(annotationsData, pageIdx, identifier);
            if (entry) {
                return { annotation: entry, pageIdx: pageIdx };
            }
        }

        return null;
    };

    // =========================================================================
    // State Mutation Helpers (Pure - return new state)
    // =========================================================================

    /**
     * Add an annotation to a page (returns new state)
     *
     * @param {AnnotationsData} annotationsData - Current annotations data
     * @param {number} pageIdx - Target page index
     * @param {AnnotationEntry} annotation - Annotation to add
     * @returns {AnnotationsData} New annotations data with annotation added
     */
    exports.addAnnotation = function addAnnotation(annotationsData, pageIdx, annotation) {
        const newData = Object.assign({}, annotationsData);
        if (!newData[pageIdx]) {
            newData[pageIdx] = [];
        } else {
            newData[pageIdx] = newData[pageIdx].slice(); // Clone array
        }
        newData[pageIdx].push(annotation);
        return newData;
    };

    /**
     * Update an annotation at a specific index (returns new state)
     *
     * @param {AnnotationsData} annotationsData - Current annotations data
     * @param {number} pageIdx - Page index
     * @param {number} annIdx - Annotation index within page
     * @param {Object} updates - Properties to update
     * @returns {AnnotationsData} New annotations data with annotation updated
     */
    exports.updateAnnotationAt = function updateAnnotationAt(annotationsData, pageIdx, annIdx, updates) {
        if (!annotationsData[pageIdx] || annIdx < 0 || annIdx >= annotationsData[pageIdx].length) {
            return annotationsData;
        }
        const newData = Object.assign({}, annotationsData);
        newData[pageIdx] = newData[pageIdx].slice(); // Clone array
        newData[pageIdx][annIdx] = Object.assign({}, newData[pageIdx][annIdx], updates);
        return newData;
    };

    /**
     * Remove an annotation at a specific index (returns new state)
     *
     * @param {AnnotationsData} annotationsData - Current annotations data
     * @param {number} pageIdx - Page index
     * @param {number} annIdx - Annotation index within page
     * @returns {AnnotationsData} New annotations data with annotation removed
     */
    exports.removeAnnotationAt = function removeAnnotationAt(annotationsData, pageIdx, annIdx) {
        if (!annotationsData[pageIdx] || annIdx < 0 || annIdx >= annotationsData[pageIdx].length) {
            return annotationsData;
        }
        const newData = Object.assign({}, annotationsData);
        newData[pageIdx] = newData[pageIdx].slice(); // Clone array
        newData[pageIdx].splice(annIdx, 1);
        return newData;
    };

    /**
     * Create an empty annotations data object
     *
     * @returns {AnnotationsData} Empty annotations data
     */
    exports.createEmptyAnnotationsData = function createEmptyAnnotationsData() {
        return {};
    };

    /**
     * Create initial state snapshot
     *
     * @returns {AnnotationStateSnapshot} Initial state
     */
    exports.createInitialState = function createInitialState() {
        return {
            annotationsData: {},
            currentSubmissionId: null,
            currentAssignmentId: null,
            currentAnnotationsPage: 0,
            editingAnnotationId: null,
            updatingPriorityId: null
        };
    };

})(window.PdfPreviewModalState);

// Export for testing
window.PdfPreviewModalState._version = '1.0.0';

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.state = window.PdfPreviewModalState;
