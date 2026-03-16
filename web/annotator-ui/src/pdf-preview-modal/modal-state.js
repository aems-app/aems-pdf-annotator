/**
 * PDF Preview Modal - State Container
 *
 * Pure data backbone for the decomposed modal. Holds typed state slices
 * owned by individual controllers. No DOM refs, no heavy objects, no timers.
 *
 * @module pdf-preview-modal/modal-state
 */
window.PdfPreviewModalStateCore = window.PdfPreviewModalStateCore || {};

(function (exports) {
    'use strict';

    /**
     * Derive final capabilities from mode + adapter + optional overrides.
     *
     * @param {Object|null} modeAdapter - ModeAdapter instance
     * @param {string} mode - 'server' | 'local' | 'offline'
     * @param {Object} [overrides={}] - Caller-supplied capability overrides
     * @returns {Object} Final capabilities
     */
    function deriveCapabilities(modeAdapter, mode, overrides) {
        var base = {
            annotationCrud: mode === 'local'
                ? (modeAdapter && typeof modeAdapter.supportsAnnotationCrud === 'function'
                    ? modeAdapter.supportsAnnotationCrud()
                    : false)
                : true,
            comparisonMode: mode !== 'offline',
            markupTools: true,
            search: true,
        };
        return Object.assign({}, base, overrides || {});
    }

    /**
     * Derive how annotated PDFs should be resolved for this preview session.
     *
     * @param {string} mode - 'server' | 'local' | 'offline'
     * @param {string|undefined|null} explicitPolicy - Optional caller override
     * @returns {string} One of local_required | server_allowed | offline_only
     */
    function deriveAnnotatedPdfPolicy(mode, explicitPolicy) {
        if (explicitPolicy === 'local_required' ||
            explicitPolicy === 'server_allowed' ||
            explicitPolicy === 'offline_only') {
            return explicitPolicy;
        }
        if (mode === 'local') {
            return 'local_required';
        }
        if (mode === 'offline') {
            return 'offline_only';
        }
        return 'server_allowed';
    }

    /**
     * Create a new modal state container from caller options.
     *
     * @param {Object} options - The createPdfPreviewModal options
     * @returns {Object} State container with typed slices
     */
    function createModalState(options) {
        var frozenOptions = Object.freeze({
            assignmentId: options.assignmentId,
            submissionId: options.submissionId,
            studentName: options.studentName || '',
            courseId: options.courseId || null,
            canvasUserName: options.canvasUserName || null,
            modeAdapter: options.modeAdapter || null,
            mode: options.mode || 'server',
            capabilities: deriveCapabilities(
                options.modeAdapter,
                options.mode || 'server',
                options.capabilityOverrides
            ),
            annotatedPdfPolicy: deriveAnnotatedPdfPolicy(
                options.mode || 'server',
                options.annotatedPdfPolicy
            ),
            callbacks: Object.freeze({
                onAnnotationsChanged: options.callbacks?.onAnnotationsChanged || null,
                onClose: options.callbacks?.onClose || null,
            }),
            initialState: Object.freeze(options.initialState || {}),
        });

        return {
            options: frozenOptions,
            document: {
                currentPage: 0,
                pageCount: 0,
                originalPdfLoaded: false,
                gradedPdfLoaded: false,
            },
            annotations: {
                annotationsData: {},
                selectedId: null,
                editingId: null,
                dirtyFlags: {},
                undoStack: [],
            },
            ui: {
                visible: false,
                fullscreen: false,
                splitPanelActive: false,
                activeToolbar: null,
                sidebarOpen: true,
                activeTab: 'graded',
            },
            sync: {
                versionToken: null,
                lastCheckedAt: null,
                polling: false,
            },
        };
    }

    exports.deriveCapabilities = deriveCapabilities;
    exports.deriveAnnotatedPdfPolicy = deriveAnnotatedPdfPolicy;
    exports.createModalState = createModalState;

})(window.PdfPreviewModalStateCore);
