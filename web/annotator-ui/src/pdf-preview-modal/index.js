/**
 * PDF Preview Modal - Module Index
 *
 * This is the entry point for the modularized PDF Preview Modal.
 * It loads all sub-modules and exports a unified API.
 *
 * Usage:
 * Include this file after utils.js and annotation-helpers.js in HTML:
 * ```html
 * <script src="/static/js/core/utils.js"></script>
 * <script src="/static/js/wizard/pdf-preview-modal/utils.js"></script>
 * <script src="/static/js/wizard/pdf-preview-modal/annotation-helpers.js"></script>
 * <script src="/static/js/wizard/pdf-preview-modal/index.js"></script>
 * <script src="/static/js/wizard/pdf-preview-modal.js"></script>
 * ```
 *
 * Or load the main file directly (it has fallback implementations).
 *
 * @module pdf-preview-modal
 */

(function () {
    'use strict';

    // Create unified namespace
    window.PdfPreviewModal = window.PdfPreviewModal || {};

    // Import from sub-modules (if loaded)
    var utils = window.PdfPreviewModalUtils || {};
    var helpers = window.PdfPreviewModalAnnotationHelpers || {};
    var state = window.PdfPreviewModalState || {};
    var stateCore = window.PdfPreviewModalStateCore || {};
    var inlineEditor = window.PdfPreviewModalInlineEditor || {};
    var sidebarPanel = window.PdfPreviewModalSidebarPanel || {};
    var rendering = window.PdfPreviewModalRendering || {};
    var crud = window.PdfPreviewModalCrud || {};
    var dragDrop = window.PdfPreviewModalDragDrop || {};
    var search = window.PdfPreviewModalSearch || {};
    var comparison = window.PdfPreviewModalComparison || {};
    var viewer = window.PdfPreviewModalViewer || {};
    var shell = window.PdfPreviewModalShell || {};
    var documentController = window.PdfPreviewModalDocumentController || {};
    var annotationController = window.PdfPreviewModalAnnotationController || {};
    var overlayRenderer = window.PdfPreviewModalOverlayRenderer || {};
    var versionSync = window.PdfPreviewModalVersionSync || {};

    // Re-export utilities
    window.PdfPreviewModal.utils = utils;
    window.PdfPreviewModal.helpers = helpers;
    window.PdfPreviewModal.state = state;
    window.PdfPreviewModal.stateCore = stateCore;
    window.PdfPreviewModal.inlineEditor = inlineEditor;
    window.PdfPreviewModal.sidebarPanel = sidebarPanel;
    window.PdfPreviewModal.rendering = rendering;
    window.PdfPreviewModal.crud = crud;
    window.PdfPreviewModal.dragDrop = dragDrop;
    window.PdfPreviewModal.search = search;
    window.PdfPreviewModal.comparison = comparison;
    window.PdfPreviewModal.viewer = viewer;
    window.PdfPreviewModal.shell = shell;
    window.PdfPreviewModal.documentController = documentController;
    window.PdfPreviewModal.annotationController = annotationController;
    window.PdfPreviewModal.overlayRenderer = overlayRenderer;
    window.PdfPreviewModal.versionSync = versionSync;

    // Convenience exports for commonly used functions
    window.PdfPreviewModal.escapeHtml = utils.escapeHtml;
    window.PdfPreviewModal.escapeCssAttribute = utils.escapeCssAttribute;
    window.PdfPreviewModal.withCsrf = utils.withCsrf;
    window.PdfPreviewModal.setupTextareaAutoResize = utils.setupTextareaAutoResize;
    window.PdfPreviewModal.PLACEHOLDER_STRINGS = utils.PLACEHOLDER_STRINGS;

    window.PdfPreviewModal.normalizeAnnotationIdentifierValue = helpers.normalizeAnnotationIdentifierValue;
    window.PdfPreviewModal.parseCompositeIdentifier = helpers.parseCompositeIdentifier;
    window.PdfPreviewModal.buildApiAnnotationIdentifier = helpers.buildApiAnnotationIdentifier;
    window.PdfPreviewModal.resolveAnnotationIdentifierValue = helpers.resolveAnnotationIdentifierValue;
    window.PdfPreviewModal.deriveAnnotationPriority = helpers.deriveAnnotationPriority;

    // State function exports
    window.PdfPreviewModal.findAnnotationIndex = state.findAnnotationIndex;
    window.PdfPreviewModal.findAnnotationEntry = state.findAnnotationEntry;
    window.PdfPreviewModal.findAnnotationAcrossPages = state.findAnnotationAcrossPages;
    window.PdfPreviewModal.getPageAnnotations = state.getPageAnnotations;

    // Module loaded flag
    window.PdfPreviewModal._modulesLoaded = true;

    // =========================================================================
    // AEMS Namespace Integration
    // =========================================================================

    // Expose via AEMS.pdfPreview namespace (new unified pattern)
    window.AEMS = window.AEMS || {};
    window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};

    // Map all modules to AEMS.pdfPreview
    window.AEMS.pdfPreview.utils = utils;
    window.AEMS.pdfPreview.helpers = helpers;
    window.AEMS.pdfPreview.state = state;
    window.AEMS.pdfPreview.stateCore = stateCore;
    window.AEMS.pdfPreview.inlineEditor = inlineEditor;
    window.AEMS.pdfPreview.sidebarPanel = sidebarPanel;
    window.AEMS.pdfPreview.rendering = rendering;
    window.AEMS.pdfPreview.crud = crud;
    window.AEMS.pdfPreview.dragDrop = dragDrop;
    window.AEMS.pdfPreview.search = search;
    window.AEMS.pdfPreview.comparison = comparison;
    window.AEMS.pdfPreview.viewer = viewer;
    window.AEMS.pdfPreview.shell = shell;
    window.AEMS.pdfPreview.documentController = documentController;
    window.AEMS.pdfPreview.annotationController = annotationController;
    window.AEMS.pdfPreview.overlayRenderer = overlayRenderer;
    window.AEMS.pdfPreview.versionSync = versionSync;

    // Expose the unified PdfPreviewModal object too
    window.AEMS.pdfPreview.modal = window.PdfPreviewModal;

    // Log module load in debug mode
    if (utils.PDF_DEBUG) {
        console.log('[PDF-PREVIEW] Modules loaded:', {
            utils: Object.keys(utils).length + ' functions',
            helpers: Object.keys(helpers).length + ' functions',
            state: Object.keys(state).length + ' functions',
            stateCore: Object.keys(stateCore).length + ' functions',
            inlineEditor: Object.keys(inlineEditor).length + ' functions',
            sidebarPanel: Object.keys(sidebarPanel).length + ' functions',
            rendering: Object.keys(rendering).length + ' functions',
            crud: Object.keys(crud).length + ' functions',
            dragDrop: Object.keys(dragDrop).length + ' functions',
            search: Object.keys(search).length + ' functions',
            comparison: Object.keys(comparison).length + ' functions',
            viewer: Object.keys(viewer).length + ' functions',
            shell: Object.keys(shell).length + ' functions',
            documentController: Object.keys(documentController).length + ' functions',
            annotationController: Object.keys(annotationController).length + ' functions',
            overlayRenderer: Object.keys(overlayRenderer).length + ' functions',
            versionSync: Object.keys(versionSync).length + ' functions'
        });
    }

})();
