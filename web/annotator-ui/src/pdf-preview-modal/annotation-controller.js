/**
 * PDF Preview Modal - Annotation Controller
 *
 * Owns annotation CRUD flows, inline editing, selection, undo/redo, sidebar
 * panel coordination, and version-sync polling.  Created by the composition
 * root; communicates with other controllers exclusively through callbacks
 * (never imports overlay-renderer, document-controller, or modal-shell).
 *
 * Absorbs the former annotation-crud.js helpers (constants, body builders,
 * validation, undo builders, markup type helpers).
 *
 * @module pdf-preview-modal/annotation-controller
 */
window.PdfPreviewModalAnnotationController = window.PdfPreviewModalAnnotationController || {};

// Backward-compat: keep PdfPreviewModalCrud namespace alive so that the
// overlay-renderer, index.js, and the monolith can still reference it.
window.PdfPreviewModalCrud = window.PdfPreviewModalCrud || {};

(function (exports, crudExports) {
    'use strict';

    // =========================================================================
    // Module Imports
    // =========================================================================
    var UtilsModule = window.PdfPreviewModalUtils || {};
    var _PDF_DEBUG = UtilsModule.PDF_DEBUG || false;
    var debugLog = UtilsModule.debugLog || function () {};
    var PLACEHOLDER_STRINGS = UtilsModule.PLACEHOLDER_STRINGS || ['', 'New comment...', 'New comment'];
    var SidebarPanelModule = window.PdfPreviewModalSidebarPanel || {};

    // =========================================================================
    // Constants  (formerly in annotation-crud.js)
    // =========================================================================

    /** Valid priority values */
    var VALID_PRIORITIES = ['red', 'amber', 'green'];

    /** Placeholder content strings */
    // (re-use UtilsModule.PLACEHOLDER_STRINGS if available, keep own copy for backward compat)

    // =========================================================================
    // CRUD Helper Functions  (formerly annotation-crud.js)
    // =========================================================================

    // --- API URL Builders ---

    function buildAnnotationUrl(submissionId, annotationId, assignmentId) {
        if (window.__WIZARD_MODE === 'offline') {
            return '/offline/api/assessments/' + encodeURIComponent(assignmentId || '') +
                '/submissions/' + encodeURIComponent(submissionId) +
                '/annotations/' + encodeURIComponent(annotationId);
        }
        var url = '/api/canvas/submissions/' + submissionId + '/annotations/' + encodeURIComponent(annotationId);
        if (assignmentId) {
            url += '?assignment_id=' + assignmentId;
        }
        return url;
    }

    function buildAnnotationsListUrl(submissionId, assignmentId) {
        if (window.__WIZARD_MODE === 'offline') {
            return '/offline/api/assessments/' + encodeURIComponent(assignmentId || '') +
                '/submissions/' + encodeURIComponent(submissionId) + '/annotations';
        }
        var url = '/api/canvas/submissions/' + submissionId + '/annotations';
        if (assignmentId) {
            url += '?assignment_id=' + assignmentId;
        }
        return url;
    }

    // --- Request Body Builders ---

    function buildContentUpdateBody(content) {
        return JSON.stringify({ content: content });
    }

    function buildPriorityUpdateBody(priority) {
        return JSON.stringify({ color: priority });
    }

    function buildPositionUpdateBody(rect, newPageIndex) {
        var body = { rect: rect };
        if (newPageIndex !== undefined) {
            body.page_index = newPageIndex;
        }
        return JSON.stringify(body);
    }

    function buildCreateAnnotationBody(params) {
        return JSON.stringify({
            rect: params.rect,
            page_index: params.pageIndex,
            content: params.content || '',
            type: params.type || 'Highlight',
            color: params.priority || 'amber'
        });
    }

    // --- Validation Helpers ---

    function isValidPriority(priority) {
        return VALID_PRIORITIES.indexOf((priority || '').toLowerCase()) !== -1;
    }

    function isPlaceholderContent(content) {
        var trimmed = (content || '').trim();
        return PLACEHOLDER_STRINGS.indexOf(trimmed) !== -1;
    }

    function shouldDeleteInsteadOfSave(newContent, hasEditedFlags) {
        var trimmed = (newContent || '').trim();
        var isEmpty = isPlaceholderContent(trimmed);
        return isEmpty && !hasEditedFlags;
    }

    // --- Undo Operation Builders ---

    function buildDeleteUndoOperation(pageIdx, annotation) {
        return {
            type: 'delete',
            pageIdx: pageIdx,
            annotation: {
                content: annotation.content,
                type: annotation.type,
                rect: annotation.rect,
                color: annotation.color,
                priority: annotation.priority,
                xref: annotation.xref,
                id: annotation.id,
                stable_id: annotation.stable_id
            }
        };
    }

    function buildCreateUndoOperation(pageIdx, identifier) {
        return {
            type: 'create',
            pageIdx: pageIdx,
            identifier: identifier
        };
    }

    function buildUpdateUndoOperation(pageIdx, identifier, originalData) {
        return {
            type: 'update',
            pageIdx: pageIdx,
            identifier: identifier,
            originalData: originalData
        };
    }

    // --- Button State Helpers ---

    function setButtonLoading(button, loading, loadingText) {
        if (!button) return;

        button.disabled = loading;

        var spinner = button.querySelector('.spinner-border');
        var btnText = button.querySelector('.btn-text');
        var icon = button.querySelector('i');

        if (loading) {
            if (spinner) spinner.classList.remove('d-none');
            if (icon) icon.style.display = 'none';
            if (btnText && loadingText) btnText.textContent = loadingText;
        } else {
            if (spinner) spinner.classList.add('d-none');
            if (icon) icon.style.display = '';
            if (btnText) btnText.textContent = btnText.dataset.originalText || 'Save';
        }
    }

    function storeButtonOriginalText(button) {
        if (!button) return;
        var btnText = button.querySelector('.btn-text');
        if (btnText && !btnText.dataset.originalText) {
            btnText.dataset.originalText = btnText.textContent;
        }
    }

    // --- Response Helpers ---

    function parseAnnotationResponse(responseData) {
        if (responseData && responseData.success && responseData.annotation) {
            return {
                success: true,
                annotation: responseData.annotation,
                error: null
            };
        }
        return {
            success: false,
            annotation: null,
            error: (responseData && responseData.error) || 'Unknown error'
        };
    }

    function hasBeenEdited(annotation) {
        if (!annotation) return false;
        return annotation._hasBeenEdited === true || annotation._priorityChanged === true;
    }

    function isTemporary(annotation) {
        return annotation && annotation._isTemporary === true;
    }

    function enhanceAfterSave(annotation) {
        var enhanced = Object.assign({}, annotation);
        delete enhanced._isTemporary;
        enhanced._originalContent = enhanced.content || '';
        return enhanced;
    }

    function extractStableAnnotationId(annotation, helpers) {
        if (!annotation) {
            return null;
        }
        if (helpers && typeof helpers.extractAnnotationStableName === 'function') {
            return helpers.extractAnnotationStableName(annotation);
        }
        var candidates = [
            annotation.stable_id,
            annotation.stableId,
            annotation.id && annotation.xref != null && String(annotation.xref) === String(annotation.id) ? null : annotation.id,
            annotation.name,
            annotation.title,
        ];
        for (var i = 0; i < candidates.length; i++) {
            var candidate = helpers && helpers.normalizeAnnotationIdentifierValue
                ? helpers.normalizeAnnotationIdentifierValue(candidates[i])
                : (candidates[i] == null ? null : String(candidates[i]).trim() || null);
            if (candidate && candidate !== '0') {
                return candidate;
            }
        }
        return null;
    }

    // --- Markup Type Helpers ---

    function isMarkupType(type) {
        return type === 'drawing' || type === 'textbox';
    }

    function buildDrawingCreateBody(params) {
        return JSON.stringify({
            page_index: params.pageIndex,
            content: '',
            type: 'drawing',
            drawing_style: params.drawingStyle,
            points: params.points,
            stroke_width: params.strokeWidth,
            stroke_opacity: params.opacity,
            stroke_color_rgb: params.colorRgb,
            color: 'amber'
        });
    }

    function buildTextboxCreateBody(params) {
        return JSON.stringify({
            page_index: params.pageIndex,
            content: params.content,
            type: 'textbox',
            rect: params.rect,
            stroke_color_rgb: params.colorRgb,
            color: 'amber'
        });
    }

    function buildPointsUpdateBody(points) {
        return JSON.stringify({ points: points });
    }

    // =========================================================================
    // Populate backward-compat PdfPreviewModalCrud namespace
    // =========================================================================

    crudExports.VALID_PRIORITIES = VALID_PRIORITIES;
    crudExports.PLACEHOLDER_STRINGS = PLACEHOLDER_STRINGS;
    crudExports.buildAnnotationUrl = buildAnnotationUrl;
    crudExports.buildAnnotationsListUrl = buildAnnotationsListUrl;
    crudExports.buildContentUpdateBody = buildContentUpdateBody;
    crudExports.buildPriorityUpdateBody = buildPriorityUpdateBody;
    crudExports.buildPositionUpdateBody = buildPositionUpdateBody;
    crudExports.buildCreateAnnotationBody = buildCreateAnnotationBody;
    crudExports.isValidPriority = isValidPriority;
    crudExports.isPlaceholderContent = isPlaceholderContent;
    crudExports.shouldDeleteInsteadOfSave = shouldDeleteInsteadOfSave;
    crudExports.buildDeleteUndoOperation = buildDeleteUndoOperation;
    crudExports.buildCreateUndoOperation = buildCreateUndoOperation;
    crudExports.buildUpdateUndoOperation = buildUpdateUndoOperation;
    crudExports.setButtonLoading = setButtonLoading;
    crudExports.storeButtonOriginalText = storeButtonOriginalText;
    crudExports.parseAnnotationResponse = parseAnnotationResponse;
    crudExports.hasBeenEdited = hasBeenEdited;
    crudExports.isTemporary = isTemporary;
    crudExports.enhanceAfterSave = enhanceAfterSave;
    crudExports.isMarkupType = isMarkupType;
    crudExports.buildDrawingCreateBody = buildDrawingCreateBody;
    crudExports.buildTextboxCreateBody = buildTextboxCreateBody;
    crudExports.buildPointsUpdateBody = buildPointsUpdateBody;

    // Version marker (was 1.1.0 in annotation-crud.js, bump for absorption)
    crudExports._version = '2.0.0';

    // =========================================================================
    // Annotation Controller Factory
    // =========================================================================

    /**
     * Create an annotation controller.
     *
     * The controller wraps annotation CRUD, inline editing, selection, undo/redo,
     * sidebar coordination, and version-sync polling.  It does NOT import other
     * controllers; cross-module communication happens through the event callbacks
     * registered by the composition root.
     *
     * @param {Object} options
     * @param {Object}   options.annotationsState         - state.annotations slice
     * @param {Object}   [options.modeAdapter]            - ModeAdapter instance
     * @param {string}   [options.mode]                   - 'server' | 'local' | 'offline'
     * @param {*}        [options.assignmentId]           - assignment ID
     * @param {*}        [options.submissionId]            - submission ID
     * @param {*}        [options.courseId]                - course ID
     * @param {string}   [options.canvasUserName]         - current user name
     * @param {Object}   [options.capabilities]           - feature flags
     * @param {Object}   [options.callbacks]              - external callbacks
     * @param {Function} options.getAnnotationsData       - () => annotationsData
     * @param {Function} options.setAnnotationsData       - (data) => void
     * @param {Function} options.getCurrentSubmissionId   - () => submissionId
     * @param {Function} options.getCurrentAssignmentId   - () => assignmentId
     * @param {Function} options.getEditingAnnotationId   - () => editingAnnotationId
     * @param {Function} options.setEditingAnnotationId   - (id) => void
     * @param {Function} options.getSelectedAnnotation    - () => { pageIdx, identifier }
     * @param {Function} options.setSelectedAnnotation    - (sel) => void
     * @param {Function} options.getSplitPanelActive      - () => boolean
     * @param {Function} options.getPreviewFullscreenActive - () => boolean
     * @param {Object}   options.helpers                  - bag of helper functions
     * @returns {Object} Annotation controller handle
     */
    function createAnnotationController(options) {
        options = options || {};

        // -----------------------------------------------------------------
        // Destructure options
        // -----------------------------------------------------------------
        var _annotationsState = options.annotationsState || {};
        var _modeAdapter = options.modeAdapter || null;
        var _capabilities = options.capabilities || {};
        var _externalCallbacks = options.callbacks || {};
        var _canvasUserName = options.canvasUserName || null;

        // Data accessors into monolith closure
        var _getAnnotationsData = options.getAnnotationsData || function () { return {}; };
        var _setAnnotationsData = options.setAnnotationsData || function () {};
        var _getCurrentSubmissionId = options.getCurrentSubmissionId || function () { return null; };
        var _getCurrentAssignmentId = options.getCurrentAssignmentId || function () { return null; };
        var _getEditingAnnotationId = options.getEditingAnnotationId || function () { return null; };
        var _setEditingAnnotationId = options.setEditingAnnotationId || function () {};
        var _getSelectedAnnotation = options.getSelectedAnnotation || function () { return { pageIdx: null, identifier: null }; };
        var _setSelectedAnnotation = options.setSelectedAnnotation || function () {};
        var _getSplitPanelActive = options.getSplitPanelActive || function () { return false; };
        var _getPreviewFullscreenActive = options.getPreviewFullscreenActive || function () { return false; };

        // Helper references from monolith
        var _h = options.helpers || {};

        // -----------------------------------------------------------------
        // Internal state (owned by this controller)
        // -----------------------------------------------------------------
        var _undoStack = Array.isArray(_annotationsState.undoStack) ? _annotationsState.undoStack.slice() : [];
        var _isUndoing = false;
        var _inlineEditingLabel = null;
        var _savingAnnotationId = null;
        var _updatingPriorityId = null;
        var _isDraggingAnnotation = false;
        var _currentAnnotationsPage = 0;

        function _syncAnnotationsState(patch) {
            if (!_annotationsState || !patch) {
                return;
            }
            Object.keys(patch).forEach(function (key) {
                _annotationsState[key] = patch[key];
            });
        }

        _syncAnnotationsState({
            undoStack: _undoStack.slice(),
            selectedId: _annotationsState.selectedId || null,
            editingId: _annotationsState.editingId || null,
            dirtyFlags: _annotationsState.dirtyFlags || {},
        });

        // Polling state
        var _pollInterval = null;
        var _currentVersion = null;
        var _skipNextPoll = false;
        var POLL_INTERVAL_MS = 5000;
        var MAX_UNDO_STACK_SIZE = 50;

        // Visibility tracking
        var _visibleMarkers = new Set();
        var _annotationObserver = null;
        var _observerInitialized = false;
        var _pendingListFrame = null;
        var _annotationVisibilityScrollHandler = null;
        var _scheduleUpdateTimer = null;

        // -----------------------------------------------------------------
        // Event system
        // -----------------------------------------------------------------
        var _callbacks = {
            onAnnotationsChanged: [],
            onAnnotationsLoaded: [],
            onSelectionChanged: [],
            onEditingChanged: [],
            onAnnotationCreated: [],
            onAnnotationDeleted: [],
            onAnnotationUpdated: [],
            onRenderListNeeded: [],
            onRenderOverlaysNeeded: [],
            onScheduleUpdate: [],
        };
        var _destroyed = false;

        function _emit(name, data) {
            var list = _callbacks[name] || [];
            for (var i = 0; i < list.length; i++) {
                try {
                    list[i](data);
                } catch (err) {
                    debugLog('[ANNOTATION-CTRL] Error in ' + name + ' callback:', err);
                }
            }
        }

        function _on(name, fn) {
            if (!_callbacks[name]) _callbacks[name] = [];
            _callbacks[name].push(fn);
        }

        // -----------------------------------------------------------------
        // Undo
        // -----------------------------------------------------------------

        function pushUndoOperation(operation) {
            if (_isUndoing) return;
            if (operation && !operation.undoTimestamp) {
                operation.undoTimestamp = Date.now();
            }
            _undoStack.push(operation);
            if (_undoStack.length > MAX_UNDO_STACK_SIZE) {
                _undoStack.shift();
            }
            _syncAnnotationsState({ undoStack: _undoStack.slice() });
            if (typeof _h.pushUndoOperation === 'function') {
                _h.pushUndoOperation(operation);
            }
        }

        function getUndoStack() {
            return _undoStack;
        }

        function peekUndoOperation() {
            if (_undoStack.length === 0) {
                return null;
            }
            return _undoStack[_undoStack.length - 1] || null;
        }

        function popUndoOperation() {
            if (_undoStack.length === 0) {
                return null;
            }
            var operation = _undoStack.pop() || null;
            _syncAnnotationsState({ undoStack: _undoStack.slice() });
            return operation;
        }

        function clearUndoStack() {
            _undoStack = [];
            _syncAnnotationsState({ undoStack: [] });
        }

        function _cloneRect(rect) {
            return Array.isArray(rect) ? rect.slice() : rect;
        }

        function _cloneQuads(quads) {
            if (!Array.isArray(quads)) {
                return quads;
            }
            return quads.map(function (quad) {
                return Array.isArray(quad) ? quad.slice() : quad;
            });
        }

        function _normalizeIdentifier(value) {
            if (_h.normalizeAnnotationIdentifierValue) {
                return _h.normalizeAnnotationIdentifierValue(value);
            }
            return value == null ? null : String(value).trim() || null;
        }

        function _resolveIdentifier(annotation) {
            if (!annotation) {
                return null;
            }
            if (_h.resolveAnnotationIdentifierValue) {
                return _h.resolveAnnotationIdentifierValue(annotation);
            }
            return extractStableAnnotationId(annotation, _h)
                || (annotation && annotation.requestIdentifier)
                || (annotation && annotation.xref != null ? String(annotation.xref) : null);
        }

        function _namespaceXrefIdentifier(value, xref) {
            var normalized = _normalizeIdentifier(value);
            var normalizedXref = _normalizeIdentifier(xref);
            if (!normalized ||
                normalized.indexOf('|') !== -1 ||
                normalized.indexOf('xref:') === 0 ||
                normalized.indexOf('id:') === 0) {
                return normalized;
            }
            return normalizedXref && normalized === normalizedXref
                ? 'xref:' + normalized
                : normalized;
        }

        function _findAnnotationIndexByOperation(pageIdx, operation) {
            var identifiers = [
                operation && operation.identifier,
                operation && operation.requestId,
                operation && operation.xref,
            ];
            if (_h.findAnnotationIndex) {
                for (var helperIdx = 0; helperIdx < identifiers.length; helperIdx++) {
                    if (identifiers[helperIdx] == null) continue;
                    var found = _h.findAnnotationIndex(pageIdx, identifiers[helperIdx]);
                    if (found >= 0) {
                        return found;
                    }
                }
            }

            var annotationsData = _getAnnotationsData();
            var pageAnnotations = annotationsData && annotationsData[pageIdx]
                ? annotationsData[pageIdx]
                : [];
            var normalizedIdentifiers = identifiers
                .map(_normalizeIdentifier)
                .filter(function (identifier) { return !!identifier; });
            return pageAnnotations.findIndex(function (annotation) {
                var annotationIdentifiers = [
                    _resolveIdentifier(annotation),
                    annotation && annotation.requestIdentifier,
                    annotation && annotation.stable_id,
                    annotation && annotation.id,
                    annotation && annotation.xref,
                ].map(_normalizeIdentifier);
                return annotationIdentifiers.some(function (identifier) {
                    return identifier && normalizedIdentifiers.indexOf(identifier) !== -1;
                });
            });
        }

        function _extractStableIdentifier(annotation, operation) {
            var currentXref = _normalizeIdentifier(annotation && annotation.xref);
            var storedXref = _normalizeIdentifier(operation && operation.xref);
            var candidates = [
                { value: annotation && annotation.stable_id, explicit: true },
                { value: annotation && annotation.stableId, explicit: true },
                { value: annotation && annotation.requestIdentifier, explicit: false },
                { value: annotation && annotation.id, explicit: false },
                { value: operation && operation.requestId, explicit: false },
                { value: operation && operation.identifier, explicit: false },
            ];

            for (var candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++) {
                var candidate = candidates[candidateIdx];
                var normalized = _normalizeIdentifier(candidate.value);
                if (!normalized) continue;

                var parts = normalized.split('|');
                for (var partIdx = 0; partIdx < parts.length; partIdx++) {
                    var token = parts[partIdx].trim();
                    if (!token || token.indexOf('xref:') === 0) continue;
                    if (token.indexOf('id:') === 0) {
                        token = token.slice(3).trim();
                    }
                    if (!token) continue;
                    if (!candidate.explicit && (token === currentXref || token === storedXref)) {
                        continue;
                    }
                    if (_h.isAnnotationType && _h.isAnnotationType(token)) {
                        continue;
                    }
                    return token;
                }
            }
            return null;
        }

        function _resolveCurrentUndoTarget(pageIdx, operation) {
            var annotationsData = _getAnnotationsData();
            var pageAnnotations = annotationsData && annotationsData[pageIdx]
                ? annotationsData[pageIdx]
                : [];
            var operationStableIdentifier = _extractStableIdentifier(null, operation);
            var annotationIdx = _findAnnotationIndexByOperation(
                pageIdx,
                operationStableIdentifier
                    ? {
                        identifier: operationStableIdentifier,
                        requestId: operationStableIdentifier,
                        xref: operation && operation.xref,
                    }
                    : operation
            );
            if (annotationIdx < 0 || !pageAnnotations[annotationIdx]) {
                return null;
            }

            var annotation = pageAnnotations[annotationIdx];
            var stableIdentifier = _extractStableIdentifier(annotation, operation);
            var currentXref = _normalizeIdentifier(annotation.xref);
            var namespacedStableIdentifier = stableIdentifier && /^\d+$/.test(stableIdentifier)
                ? 'id:' + stableIdentifier
                : stableIdentifier;
            var apiIdentifier = stableIdentifier
                ? _h.buildApiAnnotationIdentifier({ identifier: namespacedStableIdentifier })
                : _h.buildApiAnnotationIdentifier({ xref: currentXref });
            if (!apiIdentifier) {
                return null;
            }
            return {
                annotation: annotation,
                annotationIdx: annotationIdx,
                apiIdentifier: apiIdentifier,
            };
        }

        function _isMissingAnnotationFailure(value) {
            if (!value) return false;
            var status = value.status
                || value.statusCode
                || (value.response && value.response.status)
                || (value.data && value.data.status);
            if (Number(status) === 404) {
                return true;
            }
            var message = value.error
                || value.message
                || value.detail
                || (value.data && (value.data.error || value.data.detail))
                || '';
            return /annotation (?:was )?not found|annotation no longer exists/i.test(String(message));
        }

        function _dropMissingHighlightUndo() {
            var message = _h.translatePdfPreviewText
                ? _h.translatePdfPreviewText('Annotation no longer exists')
                : 'Annotation no longer exists';
            if (_h.showToast) {
                _h.showToast('error', message);
            }
            return {
                success: false,
                missing: true,
                error: message,
            };
        }

        function _replaceAnnotationFromResponse(pageIdx, operation, annotation, fallbackState) {
            var annotationsData = _getAnnotationsData();
            if (!annotationsData[pageIdx]) {
                annotationsData[pageIdx] = [];
            }
            var annotationIdx = _findAnnotationIndexByOperation(pageIdx, operation);
            var currentAnnotation = annotationIdx >= 0 ? annotationsData[pageIdx][annotationIdx] : {};
            var updatedAnnotation;

            if (annotation) {
                updatedAnnotation = _h.enhanceAnnotationEntry
                    ? _h.enhanceAnnotationEntry(annotation)
                    : Object.assign({}, currentAnnotation, annotation);
            } else {
                updatedAnnotation = Object.assign({}, currentAnnotation, fallbackState || {});
            }

            if (annotationIdx >= 0) {
                annotationsData[pageIdx][annotationIdx] = updatedAnnotation;
            } else {
                annotationsData[pageIdx].push(updatedAnnotation);
            }
            _setAnnotationsData(annotationsData);
            return updatedAnnotation;
        }

        function _updateHighlightMarkerSource(operation, annotation, source) {
            var markers = document.querySelectorAll('.annotation-marker');
            var identifiers = [
                operation && operation.identifier,
                operation && operation.requestId,
            ].map(_normalizeIdentifier);
            for (var markerIdx = 0; markerIdx < markers.length; markerIdx++) {
                var marker = markers[markerIdx];
                var markerIdentifiers = [
                    marker.dataset.annotationRequestId,
                    marker.dataset.annotationIdentifier,
                    marker.dataset.annotationXref,
                ].map(_normalizeIdentifier);
                var isMatch = markerIdentifiers.some(function (identifier) {
                    return identifier && identifiers.indexOf(identifier) !== -1;
                });
                if (!isMatch) continue;

                marker.classList.toggle('source-ai', source === 'AI');
                marker.classList.toggle('source-human', source !== 'AI');
                marker.dataset.annotationSource = source;
                if (annotation && annotation.xref != null) {
                    marker.dataset.annotationXref = String(annotation.xref);
                }
                break;
            }
        }

        async function _convertTopLeftRectToPdf(rect, pageIdx) {
            var converted = _cloneRect(rect);
            if (!Array.isArray(converted) || converted.length !== 4) {
                return converted;
            }
            var viewer = _h.getViewer ? _h.getViewer() : window.__pdfGradedViewer;
            if (!viewer || !viewer.pdf) {
                return converted;
            }
            try {
                var page = await viewer.pdf.getPage(pageIdx + 1);
                var pageHeight = page.view[3] - page.view[1];
                return [
                    converted[0],
                    pageHeight - converted[3],
                    converted[2],
                    pageHeight - converted[1],
                ];
            } catch (_error) {
                return converted;
            }
        }

        async function _convertTopLeftQuadsToPdf(quads, pageIdx) {
            if (!Array.isArray(quads)) {
                return quads;
            }
            var converted = [];
            for (var quadIdx = 0; quadIdx < quads.length; quadIdx++) {
                converted.push(await _convertTopLeftRectToPdf(quads[quadIdx], pageIdx));
            }
            return converted;
        }

        async function persistHighlightExtend(marker, annotation, payload) {
            payload = payload || {};
            if (!_h.buildApiAnnotationIdentifier || !_h.updateAnnotationRequest) {
                throw new Error('Annotation update helpers are unavailable.');
            }

            var pageIdx = Number(payload.pageIdx);
            var stableIdentifier = _resolveIdentifier(annotation);
            var markerXref = marker && marker.dataset ? marker.dataset.annotationXref : null;
            var markerRequestId = marker && marker.dataset
                ? (marker.dataset.annotationRequestId || marker.dataset.annotationIdentifier)
                : null;
            var explicitStableIdentifier = _extractStableIdentifier(annotation, null);
            var requestIdentifier = explicitStableIdentifier
                || _namespaceXrefIdentifier(stableIdentifier, markerXref);
            var requestRequestId = (
                explicitStableIdentifier &&
                _normalizeIdentifier(markerRequestId) === _normalizeIdentifier(explicitStableIdentifier)
            )
                ? explicitStableIdentifier
                : _namespaceXrefIdentifier(markerRequestId, markerXref);
            var apiIdentifier = _h.buildApiAnnotationIdentifier({
                identifier: requestIdentifier,
                xref: markerXref,
                requestId: requestRequestId,
            });
            if (!apiIdentifier) {
                return { success: false, error: 'Unable to resolve annotation identifier.' };
            }

            // Snapshot before awaiting persistence. Highlight replacement can
            // mutate both geometry and ownership, and the source object may be
            // refreshed while the request is in flight.
            var oldQuads = _cloneQuads(annotation && annotation.quads);
            var oldAnchorText = annotation ? annotation.anchor_text : undefined;
            var oldRect = _cloneRect(annotation && annotation.rect);
            var oldSource = _h.resolveAnnotationSource
                ? _h.resolveAnnotationSource(annotation)
                : ((annotation && annotation.source) || 'HUMAN');

            var data = await _h.updateAnnotationRequest(apiIdentifier, {
                quads: payload.quadsPdf,
                anchor_text: payload.anchorText,
                source: 'HUMAN',
            });
            if (!data || !data.success) {
                return data || { success: false };
            }

            var responseAnnotation = data.annotation || null;
            var undoXref = responseAnnotation && responseAnnotation.xref != null
                ? String(responseAnnotation.xref)
                : markerXref;
            var responseStableIdentifier = _extractStableIdentifier(responseAnnotation, null);
            var undoIdentifier = responseStableIdentifier
                || explicitStableIdentifier
                || _namespaceXrefIdentifier(
                    _resolveIdentifier(responseAnnotation) || stableIdentifier || markerRequestId,
                    undoXref
                );
            var rawUndoRequestId = (responseAnnotation && (
                responseAnnotation.stable_id
                || responseAnnotation.requestIdentifier
                || responseAnnotation.id
            )) || markerRequestId;
            var undoRequestId = responseStableIdentifier
                || explicitStableIdentifier
                || _namespaceXrefIdentifier(
                    _namespaceXrefIdentifier(rawUndoRequestId, undoXref),
                    markerXref
                );
            var newQuads = responseAnnotation && Array.isArray(responseAnnotation.quads)
                ? _cloneQuads(responseAnnotation.quads)
                : _cloneQuads(payload.quadsPdf);
            var newAnchorText = responseAnnotation && responseAnnotation.anchor_text !== undefined
                ? responseAnnotation.anchor_text
                : payload.anchorText;
            var newRect = responseAnnotation && responseAnnotation.rect
                ? _cloneRect(responseAnnotation.rect)
                : oldRect;

            pushUndoOperation({
                type: 'highlight-extend',
                identifier: undoIdentifier,
                xref: undoXref,
                requestId: undoRequestId,
                pageIdx: pageIdx,
                oldQuads: oldQuads,
                newQuads: newQuads,
                oldAnchorText: oldAnchorText,
                newAnchorText: newAnchorText,
                oldRect: oldRect,
                newRect: newRect,
                oldSource: oldSource,
                newSource: 'HUMAN',
                isOwnershipTransfer: oldSource === 'AI',
            });

            var operation = peekUndoOperation();
            _updateHighlightMarkerSource(operation, responseAnnotation, 'HUMAN');
            if (responseAnnotation && Array.isArray(responseAnnotation.quads)) {
                _replaceAnnotationFromResponse(pageIdx, operation, responseAnnotation, {
                    quads: newQuads,
                    anchor_text: newAnchorText,
                    rect: newRect,
                    source: 'HUMAN',
                });
                markLocalChange();
                _renderAfterMutation({ forceRender: true });
            }
            return data;
        }

        async function performHighlightExtendUndo(operation) {
            if (!operation || operation.type !== 'highlight-extend') {
                throw new Error('Invalid highlight extend undo operation.');
            }
            if (!_h.buildApiAnnotationIdentifier || !_h.updateAnnotationRequest) {
                throw new Error('Annotation update helpers are unavailable.');
            }

            // A highlight PUT deletes and recreates the PDF annotation. Resolve
            // against live state now: operation.xref may already be obsolete
            // after a newer extend, undo, move, or delete-undo.
            var currentTarget = _resolveCurrentUndoTarget(operation.pageIdx, operation);
            if (!currentTarget) {
                return _dropMissingHighlightUndo();
            }

            var oldQuadsPdf = await _convertTopLeftQuadsToPdf(
                operation.oldQuads,
                operation.pageIdx
            );
            var oldRectPdf = await _convertTopLeftRectToPdf(
                operation.oldRect,
                operation.pageIdx
            );
            var updateData = {
                quads: oldQuadsPdf,
                anchor_text: operation.oldAnchorText,
                rect: oldRectPdf,
            };
            if (operation.oldSource) {
                updateData.source = operation.oldSource;
            }

            var data;
            try {
                data = await _h.updateAnnotationRequest(currentTarget.apiIdentifier, updateData);
            } catch (error) {
                if (_isMissingAnnotationFailure(error)) {
                    return _dropMissingHighlightUndo();
                }
                throw error;
            }
            if (!data || !data.success) {
                if (_isMissingAnnotationFailure(data)) {
                    return _dropMissingHighlightUndo();
                }
                throw new Error((data && data.error) || 'Highlight extend undo failed.');
            }

            var fallbackState = {
                quads: _cloneQuads(operation.oldQuads),
                anchor_text: operation.oldAnchorText,
                rect: _cloneRect(operation.oldRect),
                source: operation.oldSource,
            };
            var updatedAnnotation = _replaceAnnotationFromResponse(
                operation.pageIdx,
                operation,
                data.annotation || null,
                fallbackState
            );
            _updateHighlightMarkerSource(
                operation,
                updatedAnnotation,
                operation.oldSource || 'HUMAN'
            );
            markLocalChange();
            _renderAfterMutation({ forceRender: true });

            if (operation.isOwnershipTransfer && _h.showToast) {
                var message = _h.translatePdfPreviewText
                    ? _h.translatePdfPreviewText('Ownership reverted to AI')
                    : 'Ownership reverted to AI';
                _h.showToast('success', message);
            }
            return data;
        }

        // -----------------------------------------------------------------
        // Polling
        // -----------------------------------------------------------------

        function markLocalChange() {
            _skipNextPoll = true;
        }

        function startPolling() {
            if (_pollInterval) return; // Already polling
            _pollInterval = setInterval(_checkVersion, POLL_INTERVAL_MS);
        }

        function stopPolling() {
            if (_pollInterval) {
                clearInterval(_pollInterval);
                _pollInterval = null;
            }
            _currentVersion = null;
            _skipNextPoll = false;
        }

        function _checkVersion() {
            // Delegate to monolith's checkAnnotationsVersion for now.
            // The monolith function is still the canonical implementation.
            // This is a transitional placeholder.
        }

        // -----------------------------------------------------------------
        // Visibility tracking (IntersectionObserver)
        // -----------------------------------------------------------------

        function getVisibleMarkers() {
            return _visibleMarkers;
        }

        function isObserverInitialized() {
            return _observerInitialized;
        }

        function addVisibleMarker(key) {
            _visibleMarkers.add(key);
        }

        function removeVisibleMarker(key) {
            _visibleMarkers.delete(key);
        }

        function clearVisibleMarkers() {
            _visibleMarkers.clear();
        }

        function _getGradedContainer() {
            return document.getElementById('pdfGradedContainer');
        }

        function _getCommentsListElement() {
            return document.getElementById('pdfGradedCommentsList');
        }

        function _parseDatasetPageIndex(value) {
            if (value === null || value === undefined || value === '') {
                return null;
            }
            var parsed = parseInt(value, 10);
            return Number.isNaN(parsed) ? null : parsed;
        }

        function _scheduleListRender() {
            if (_pendingListFrame !== null) {
                return;
            }
            _pendingListFrame = requestAnimationFrame(function () {
                _pendingListFrame = null;
                handle.renderSidebar();
            });
        }

        function _buildVisibilityKey(pageIdx, params) {
            if (_h.buildAnnotationVisibilityKey) {
                return _h.buildAnnotationVisibilityKey(pageIdx, params);
            }
            var annotation = params && params.annotation;
            var marker = params && params.marker;
            var identifier = params && params.identifier;
            var xref = params && params.xref;
            var markerXref = marker && marker.dataset ? marker.dataset.annotationXref : '';
            var stableId = annotation && (
                annotation.requestIdentifier ||
                annotation.id ||
                annotation.identifier ||
                annotation.stable_id
            );
            var finalXref = xref || markerXref || (annotation && annotation.xref) || '';
            var finalIdentifier = identifier || stableId || finalXref;
            if (!finalIdentifier) {
                return null;
            }
            return String(pageIdx) + ':' + String(finalIdentifier);
        }

        function _isMarkerVisibleInContainer(marker, containerRect) {
            if (!marker || !containerRect) {
                return false;
            }

            var rect = marker.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return false;
            }

            var intersectionWidth = Math.min(rect.right, containerRect.right) - Math.max(rect.left, containerRect.left);
            var intersectionHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
            if (intersectionWidth <= 0 || intersectionHeight <= 0) {
                return false;
            }

            var visibleArea = intersectionWidth * intersectionHeight;
            var totalArea = rect.width * rect.height;
            return totalArea > 0 && (visibleArea / totalArea) >= 0.1;
        }

        function syncVisibleMarkersFromDom() {
            var container = _getGradedContainer();
            if (!container) {
                return false;
            }

            var containerRect = container.getBoundingClientRect();
            if (containerRect.width <= 0 || containerRect.height <= 0) {
                return false;
            }

            var nextVisibleMarkers = new Set();
            container.querySelectorAll('.annotation-marker[data-annotation-page]').forEach(function (marker) {
                var pageIdx = parseInt(marker.dataset.annotationPage || '-1', 10);
                var markerKey = _buildVisibilityKey(pageIdx, { marker: marker });
                if (!markerKey) {
                    return;
                }
                if (_isMarkerVisibleInContainer(marker, containerRect)) {
                    nextVisibleMarkers.add(markerKey);
                }
            });

            var hasChanges = nextVisibleMarkers.size !== _visibleMarkers.size;
            if (!hasChanges) {
                nextVisibleMarkers.forEach(function (markerKey) {
                    if (!_visibleMarkers.has(markerKey)) {
                        hasChanges = true;
                    }
                });
            }

            if (hasChanges) {
                _visibleMarkers.clear();
                nextVisibleMarkers.forEach(function (markerKey) {
                    _visibleMarkers.add(markerKey);
                });
            }

            _observerInitialized = true;
            return hasChanges;
        }

        function observeAnnotationMarker(marker) {
            if (_annotationObserver && marker) {
                _annotationObserver.observe(marker);
            }
        }

        function unobserveAnnotationMarker(marker) {
            if (_annotationObserver && marker) {
                _annotationObserver.unobserve(marker);
                var pageIdx = parseInt(marker.dataset.annotationPage || '-1', 10);
                var markerKey = _buildVisibilityKey(pageIdx, { marker: marker });
                if (markerKey) {
                    _visibleMarkers.delete(markerKey);
                }
            }
        }

        function initializeAnnotationObserver() {
            var container = _getGradedContainer();
            if (!container) {
                return;
            }

            if (_annotationObserver) {
                _annotationObserver.disconnect();
            }

            _observerInitialized = false;
            _visibleMarkers.clear();

            if (_annotationVisibilityScrollHandler) {
                container.removeEventListener('scroll', _annotationVisibilityScrollHandler);
            }

            _annotationVisibilityScrollHandler = function () {
                if (syncVisibleMarkersFromDom()) {
                    _scheduleListRender();
                    if (_getSplitPanelActive() && _h.renderAIAnnotationsList) {
                        _h.renderAIAnnotationsList();
                    }
                }
            };
            container.addEventListener('scroll', _annotationVisibilityScrollHandler, { passive: true });

            _annotationObserver = new IntersectionObserver(function (entries) {
                var hasChanges = false;

                entries.forEach(function (entry) {
                    var marker = entry.target;
                    var pageIdx = parseInt(marker.dataset.annotationPage || '-1', 10);
                    var markerKey = _buildVisibilityKey(pageIdx, { marker: marker });
                    if (!markerKey) {
                        return;
                    }

                    if (entry.isIntersecting) {
                        if (!_visibleMarkers.has(markerKey)) {
                            _visibleMarkers.add(markerKey);
                            hasChanges = true;
                        }
                    } else if (_visibleMarkers.has(markerKey)) {
                        _visibleMarkers.delete(markerKey);
                        hasChanges = true;
                    }
                });

                if (hasChanges) {
                    _scheduleListRender();
                }

                if (!_observerInitialized) {
                    _observerInitialized = true;
                    _scheduleListRender();
                }
            }, {
                root: container,
                rootMargin: '0px',
                threshold: 0.1,
            });

            setTimeout(function () {
                if (!_observerInitialized) {
                    syncVisibleMarkersFromDom();
                    _scheduleListRender();
                }
            }, 500);

            requestAnimationFrame(function () {
                syncVisibleMarkersFromDom();
                _scheduleListRender();
                if (_getSplitPanelActive() && _h.renderAIAnnotationsList) {
                    _h.renderAIAnnotationsList();
                }
            });
        }

        // -----------------------------------------------------------------
        // Selection
        // -----------------------------------------------------------------

        function highlightSelection(pageIdx, identifierValue) {
            _setSelectedAnnotation({ pageIdx: pageIdx, identifier: identifierValue });
            _syncAnnotationsState({ selectedId: identifierValue || null });
            var stableId = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(identifierValue)
                : identifierValue;
            if (stableId === null || Number.isNaN(pageIdx)) {
                return;
            }

            document.querySelectorAll('.annotation-marker').forEach(function (marker) {
                var markerId = _h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(
                        marker.dataset.annotationRequestId ||
                        marker.dataset.annotationIdentifier ||
                        marker.dataset.annotationXref
                    )
                    : (
                        marker.dataset.annotationRequestId ||
                        marker.dataset.annotationIdentifier ||
                        marker.dataset.annotationXref
                    );
                var markerPage = parseInt(marker.dataset.annotationPage || '-1', 10);
                var isMatch = markerId === stableId && markerPage === pageIdx;
                if (isMatch) {
                    marker.style.outline = '3px solid #0d6efd';
                    marker.style.outlineOffset = '2px';
                    marker.classList.add('annotation-marker-selected');
                } else {
                    marker.style.outline = '';
                    marker.style.outlineOffset = '';
                    marker.classList.remove('annotation-marker-selected');
                }
            });

            var listEl = _getCommentsListElement();
            if (listEl && _h.escapeCssAttribute) {
                var escapedId = _h.escapeCssAttribute(stableId);
                var selector = [
                    '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-request-id="' + escapedId + '"]',
                    '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-identifier="' + escapedId + '"]',
                    '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-xref="' + escapedId + '"]'
                ].join(', ');
                var target = listEl.querySelector(selector);

                listEl.querySelectorAll('.list-group-item').forEach(function (listItem) {
                    listItem.classList.remove('item-focused', 'active');
                });

                if (target) {
                    target.classList.add('item-focused', 'active');
                    if (typeof target.focus === 'function') {
                        target.focus({ preventScroll: true });
                    }
                }
            }
            _emit('onSelectionChanged', { pageIdx: pageIdx, identifier: identifierValue });
        }

        // -----------------------------------------------------------------
        // Editing state
        // -----------------------------------------------------------------

        function getSavingAnnotationId() {
            return _savingAnnotationId;
        }

        function setSavingAnnotationId(id) {
            _savingAnnotationId = id;
        }

        function getUpdatingPriorityId() {
            return _updatingPriorityId;
        }

        function setUpdatingPriorityId(id) {
            _updatingPriorityId = id;
        }

        function getIsDragging() {
            return _isDraggingAnnotation;
        }

        function setIsDragging(val) {
            _isDraggingAnnotation = !!val;
        }

        function getInlineEditingLabel() {
            return _inlineEditingLabel;
        }

        function setInlineEditingLabel(label) {
            _inlineEditingLabel = label;
        }

        function getCurrentAnnotationsPage() {
            return _currentAnnotationsPage;
        }

        function setCurrentAnnotationsPage(page) {
            _currentAnnotationsPage = page;
        }

        function _focusElementWithoutScroll(element) {
            if (!element || typeof element.focus !== 'function') {
                return;
            }
            try {
                element.focus({ preventScroll: true });
            } catch (_error) {
                element.focus();
            }
        }

        function _findMarkerForIdentifiers(pageIdx, identifiers) {
            if (!_h.escapeCssAttribute || !Array.isArray(identifiers) || identifiers.length === 0) {
                return null;
            }
            var selectorParts = [];
            identifiers.forEach(function (rawIdentifier) {
                var normalized = _h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(rawIdentifier)
                    : rawIdentifier;
                if (!normalized) {
                    return;
                }
                var escaped = _h.escapeCssAttribute(normalized);
                selectorParts.push(
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-request-id="' + escaped + '"]',
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-identifier="' + escaped + '"]',
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-xref="' + escaped + '"]',
                    '.annotation-marker[data-page-idx="' + pageIdx + '"][data-identifier="' + escaped + '"]'
                );
            });
            if (selectorParts.length === 0) {
                return null;
            }
            return document.querySelector(selectorParts.join(', '));
        }

        function _applyAnnotationIdentityToMarker(marker, pageIdx, annotation) {
            if (!marker || !annotation) {
                return null;
            }
            var requestIdentifier = _h.resolveAnnotationIdentifierValue
                ? _h.resolveAnnotationIdentifierValue(annotation)
                : (
                    annotation.requestIdentifier ||
                    annotation.stable_id ||
                    annotation.id ||
                    annotation.xref
                );
            var stableIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(
                    annotation.stable_id || annotation.id || requestIdentifier
                )
                : (annotation.stable_id || annotation.id || requestIdentifier);
            var xrefIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(
                    typeof annotation.xref === 'number' ? String(annotation.xref) : annotation.xref
                )
                : annotation.xref;

            marker.dataset.annotationPage = String(pageIdx);
            marker.dataset.pageIdx = String(pageIdx);
            marker.dataset.annotationSource = annotation.source || marker.dataset.annotationSource || 'HUMAN';
            marker.dataset.annotationXref = xrefIdentifier || '';
            marker.dataset.annotationStableId = stableIdentifier || '';
            marker.dataset.annotationRequestId = requestIdentifier || '';
            marker.dataset.annotationIdentifier = requestIdentifier || stableIdentifier || xrefIdentifier || '';
            marker.dataset.identifier = requestIdentifier || stableIdentifier || xrefIdentifier || '';
            return marker.querySelector('.annotation-label');
        }

        function _renderAfterMutation(options) {
            options = options || {};
            _syncAnnotationsState({
                annotationsData: _getAnnotationsData(),
                editingId: _getEditingAnnotationId(),
                selectedId: (_getSelectedAnnotation() || {}).identifier || null,
                undoStack: _undoStack.slice(),
            });
            renderSidebar();
            if (_h.refreshMarkupFromAnnotations) {
                _h.refreshMarkupFromAnnotations();
            }
            _emit('onAnnotationsChanged', {
                annotationsData: _getAnnotationsData(),
                forceRender: options.forceRender === true,
                renderOverlays: options.renderOverlays !== false,
            });
        }

        function _scheduleAnnotationUpdate() {
            clearTimeout(_scheduleUpdateTimer);
            _scheduleUpdateTimer = setTimeout(function () {
                _scheduleUpdateTimer = null;
                _renderAfterMutation();
            }, 50);
        }

        function _setEditingId(nextEditingId) {
            _setEditingAnnotationId(nextEditingId);
            _syncAnnotationsState({ editingId: nextEditingId || null });
        }

        function _renderEmptySidebar(listEl) {
            var emptyMessage = _getSplitPanelActive()
                ? (_h.translatePdfPreviewText ? _h.translatePdfPreviewText('No human annotations visible') : 'No human annotations visible')
                : (SidebarPanelModule.EMPTY_STATE_MESSAGE || 'No comments visible in viewport');
            var emptyHtml = '<div class="text-muted small text-center p-3">' + emptyMessage + '</div>';
            if (listEl.innerHTML !== emptyHtml) {
                listEl.innerHTML = emptyHtml;
            }
        }

        function _renderSidebarHtml(allAnnotations) {
            var lastPageIdx = null;
            var escapeHtml = _h.escapeHtml || function (value) { return String(value || ''); };
            // Attribute-context escaper: unlike escapeHtml() it also neutralises
            // " and ', so identifier values are safe inside double-quoted data-*
            // attributes (prevents attribute-injection DOM XSS).
            var escapeHtmlAttribute = _h.escapeHtmlAttribute || UtilsModule.escapeHtmlAttribute || function (value) {
                return String(value == null ? '' : value)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            };
            var translate = _h.translatePdfPreviewText || function (value) { return value; };
            var formatGraderDisplayName = _h.formatGraderDisplayName || function (value) { return value || ''; };

            return allAnnotations.map(function (ann) {
                var pageIdx = Number(ann.pageIdx);
                if (!Number.isFinite(pageIdx)) {
                    pageIdx = 0;
                }
                pageIdx = Math.trunc(pageIdx);
                var xrefValue = (_h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(
                        typeof ann.xref === 'number' ? String(ann.xref) : ann.xref
                    )
                    : ann.xref) || '';
                var stableId = extractStableAnnotationId(ann, _h) || '';
                var identifier = stableId || (_h.resolveAnnotationIdentifierValue ? _h.resolveAnnotationIdentifierValue(ann) : stableId);
                var resolvedIds = _h.resolveAnnotationIdParts
                    ? _h.resolveAnnotationIdParts({
                        xref: xrefValue,
                        requestId: ann.requestIdentifier,
                        identifier: identifier,
                    })
                    : { xref: xrefValue, stableId: identifier };
                var requestId = ann.requestIdentifier || '';
                if (!requestId || requestId === stableId || requestId === xrefValue) {
                    if (stableId) {
                        requestId = /^\d+$/.test(stableId) ? 'id:' + stableId : stableId;
                    } else {
                        requestId = resolvedIds.xref || '';
                    }
                }
                var rawRequestId = requestId || ('idx-' + ann.indexOnPage);
                var rawDomId = 'ann-' + pageIdx + '-' + rawRequestId;
                // XSS hardening: attribute-escape every identifier value before it
                // is interpolated into the data-* attributes of the markup below.
                var displayIdentifier = escapeHtmlAttribute(rawRequestId);
                var domId = escapeHtmlAttribute(rawDomId);
                requestId = escapeHtmlAttribute(requestId);
                xrefValue = escapeHtmlAttribute(xrefValue);
                stableId = escapeHtmlAttribute(stableId);
                var isEditing = _getEditingAnnotationId() === rawDomId;
                var priority = _h.deriveAnnotationPriority ? _h.deriveAnnotationPriority(ann) : 'amber';
                var colorClass = priority === 'red' ? 'danger' : priority === 'green' ? 'success' : 'warning';
                var content = ann.content || '';
                var contentIsPlaceholder = content === '' ||
                    content === 'New comment...' ||
                    content === 'New comment';
                var editContent = contentIsPlaceholder ? '' : escapeHtml(content);
                var displayContent = escapeHtml(content) || 'No comment text';
                var rawGraderName = ann.grader_name || ann.author_name || '';
                var graderName = formatGraderDisplayName(rawGraderName);
                var source = _h.resolveAnnotationSource ? _h.resolveAnnotationSource(ann) : 'HUMAN';
                var isAI = source === 'AI';
                var sourceClass = isAI ? 'source-ai' : 'source-human';
                var displayIndexOnPage = Number(ann.displayIndexOnPage || 1);
                var commentId = (pageIdx + 1) + '.' + displayIndexOnPage;
                var sourceBadgeHtml = isAI
                    ? '<span class="source-badge source-ai" title="AI-generated"><i class="bi bi-robot"></i></span>'
                    : '<span class="source-badge source-human" title="Human"><i class="bi bi-person-fill"></i></span>';
                var isVerdict = !!ann.is_verdict;
                var verdictHtml = isVerdict
                    ? '<i class="bi bi-patch-check-fill verdict-indicator" title="Verdict comment" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '" data-annotation-page="' + pageIdx + '"></i>'
                    : '<i class="bi bi-patch-check verdict-indicator verdict-inactive" title="Mark as verdict" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '" data-annotation-page="' + pageIdx + '"></i>';
                var verdictClass = isVerdict ? ' is-verdict' : '';
                var separator = '';
                if (lastPageIdx !== null && pageIdx !== lastPageIdx) {
                    separator = '<div class="page-separator"><small class="text-muted d-block text-center page-separator-label">' +
                        translate('Page %(page)s', { page: pageIdx + 1 }) +
                        '</small></div>';
                }
                lastPageIdx = pageIdx;

                return '' +
                    separator +
                    '<div class="list-group-item ' + sourceClass + verdictClass + '" tabindex="0" data-annotation-id="' + domId + '" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '" data-annotation-stable-id="' + stableId + '" data-annotation-page="' + pageIdx + '" data-annotation-source="' + escapeHtmlAttribute(source) + '">' +
                        '<div class="annotation-list-card">' +
                            '<div class="annotation-meta-row">' +
                                '<span class="badge bg-' + colorClass + '">' + commentId + '</span>' +
                                sourceBadgeHtml +
                                verdictHtml +
                                (graderName ? '<small class="text-muted grader-name-badge" title="' + escapeHtmlAttribute(rawGraderName) + '">' + escapeHtml(graderName) + '</small>' : '') +
                                '<div class="priority-dots d-flex gap-1" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '" data-annotation-page="' + pageIdx + '">' +
                                    '<span class="priority-dot priority-red ' + (priority === 'red' ? 'active' : '') + '" data-priority="red" title="High priority"></span>' +
                                    '<span class="priority-dot priority-amber ' + (priority === 'amber' ? 'active' : '') + '" data-priority="amber" title="Medium priority"></span>' +
                                    '<span class="priority-dot priority-green ' + (priority === 'green' ? 'active' : '') + '" data-priority="green" title="Low priority"></span>' +
                                '</div>' +
                            '</div>' +
                            '<div class="annotation-content ' + (isEditing ? 'editing' : '') + '" data-annotation-id="' + domId + '" data-annotation-identifier="' + displayIdentifier + '">' +
                                (isEditing
                                    ? '<textarea class="form-control form-control-sm mb-2 auto-resize-textarea" id="edit-annotation-text-' + displayIdentifier + '" rows="2" placeholder="Type your comment...">' + editContent + '</textarea>' +
                                        '<div class="annotation-edit-actions d-flex flex-wrap gap-2">' +
                                            '<button class="btn btn-primary btn-sm save-annotation-btn" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '">' +
                                                '<span class="spinner-border spinner-border-sm d-none" role="status"></span>' +
                                                '<span class="btn-text">Save</span>' +
                                            '</button>' +
                                            '<button class="btn btn-secondary btn-sm cancel-edit-btn" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + xrefValue + '" data-annotation-page="' + pageIdx + '">Cancel</button>' +
                                        '</div>'
                                    : displayContent) +
                            '</div>' +
                            (!isEditing
                                ? '<div class="annotation-action-row d-flex flex-wrap gap-2 justify-content-end">' +
                                    '<button class="btn btn-outline-primary btn-sm edit-annotation" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-page="' + pageIdx + '" data-annotation-id="' + domId + '" title="Edit comment">' +
                                        '<i class="bi bi-pencil"></i>' +
                                    '</button>' +
                                    (
                                        ann.can_revert_to_ai
                                        && _h.hostAdvertisesCapability
                                        && _h.hostAdvertisesCapability('revertToAi')
                                            ? '<button class="btn btn-outline-warning btn-sm revert-annotation-to-ai" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + escapeHtmlAttribute(ann.xref || '') + '" data-annotation-page="' + pageIdx + '" data-annotation-id="' + domId + '" data-annotation-stable-id="' + (stableId || '') + '" title="Revert to AI">' +
                                                '<span class="spinner-border spinner-border-sm d-none" role="status"></span>' +
                                                '<i class="bi bi-arrow-counterclockwise"></i>' +
                                            '</button>'
                                            : ''
                                    ) +
                                    '<button class="btn btn-outline-danger btn-sm delete-annotation" data-annotation-identifier="' + displayIdentifier + '" data-annotation-request-id="' + requestId + '" data-annotation-xref="' + escapeHtmlAttribute(ann.xref || '') + '" data-annotation-page="' + pageIdx + '" data-annotation-id="' + domId + '" title="Delete comment">' +
                                        '<span class="spinner-border spinner-border-sm d-none" role="status"></span>' +
                                        '<i class="bi bi-trash"></i>' +
                                    '</button>' +
                                '</div>'
                                : '') +
                        '</div>' +
                    '</div>';
            }).join('');
        }

        async function cancelAnnotationEdit(pageIdx, identifier) {
            if (identifier) {
                if (pageIdx === null || Number.isNaN(pageIdx)) {
                    if (_h.showToast) {
                        _h.showToast('error', 'Unable to cancel edit: missing page context.');
                    }
                    return Promise.resolve();
                }
                var annotation = _h.findAnnotationEntry ? _h.findAnnotationEntry(pageIdx, identifier) : null;
                var originalContent = (annotation && (annotation._originalContent !== undefined
                    ? annotation._originalContent
                    : annotation.content)) || '';
                originalContent = String(originalContent || '').trim();
                var textarea = document.getElementById('edit-annotation-text-' + identifier);
                var isTemporary = annotation && annotation._isTemporary === true;
                var originalIsPlaceholder = PLACEHOLDER_STRINGS.indexOf(originalContent) !== -1;
                var hasOnlyPriorityChange = annotation && annotation._priorityChanged === true && !annotation._hasBeenEdited;

                if (isTemporary || (originalIsPlaceholder && !hasOnlyPriorityChange)) {
                    if (textarea && textarea._escapeHandler) {
                        textarea.removeEventListener('keydown', textarea._escapeHandler, true);
                    }
                    if (textarea && textarea._blurHandler) {
                        textarea.removeEventListener('blur', textarea._blurHandler);
                    }
                    if (_h.deleteAnnotationSilently) {
                        await _h.deleteAnnotationSilently(pageIdx, (annotation && annotation.requestIdentifier) || identifier);
                    }
                    _setEditingAnnotationId(null);
                    _syncAnnotationsState({ editingId: null });
                    if (_h.collapseInlineLabel) {
                        var inlineLabel = document.querySelector('.annotation-label.label-editing');
                        if (inlineLabel) {
                            _h.collapseInlineLabel(inlineLabel);
                        }
                    }
                    _emit('onScheduleUpdate', {});
                    return Promise.resolve();
                }

                if (annotation && annotation._originalContent !== undefined) {
                    annotation.content = annotation._originalContent;
                }
            }

            _setEditingAnnotationId(null);
            _syncAnnotationsState({ editingId: null });
            if (_h.collapseInlineLabel) {
                var openInlineLabel = document.querySelector('.annotation-label.label-editing');
                if (openInlineLabel) {
                    _h.collapseInlineLabel(openInlineLabel);
                }
            }
            renderSidebar();
            _emit('onRenderOverlaysNeeded', { forceRender: true });
            return Promise.resolve();
        }

        function _attachSidebarEventHandlers(listEl) {
            if (!listEl || listEl.dataset.annotationControllerBound === 'true') {
                return;
            }
            listEl.dataset.annotationControllerBound = 'true';

            function consumeActionEvent(event) {
                if (!event) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                }
            }

            listEl.addEventListener('click', function (event) {
                var editBtn = event.target.closest('.edit-annotation');
                if (editBtn) {
                    consumeActionEvent(event);
                    var editIdentifier = editBtn.dataset.annotationRequestId || editBtn.dataset.annotationIdentifier || editBtn.dataset.annotationXref;
                    if (!editIdentifier) {
                        if (_h.showToast) {
                            _h.showToast('error', 'Unable to locate this annotation for editing.');
                        }
                        return;
                    }
                    handle.beginEdit(parseInt(editBtn.dataset.annotationPage || '-1', 10), editIdentifier, editBtn.dataset.annotationId);
                    return;
                }

                var deleteBtn = event.target.closest('.delete-annotation');
                if (deleteBtn) {
                    consumeActionEvent(event);
                    var deleteIdentifier = deleteBtn.dataset.annotationRequestId || deleteBtn.dataset.annotationIdentifier || deleteBtn.dataset.annotationXref;
                    if (!deleteIdentifier) {
                        if (_h.showToast) {
                            _h.showToast('error', 'Unable to determine which annotation to delete.');
                        }
                        return;
                    }
                    handle.deleteAnnotation(parseInt(deleteBtn.dataset.annotationPage || '-1', 10), deleteIdentifier, deleteBtn);
                    return;
                }

                var revertBtn = event.target.closest('.revert-annotation-to-ai');
                if (revertBtn) {
                    consumeActionEvent(event);
                    var revertIdentifier = revertBtn.dataset.annotationStableId
                        || revertBtn.dataset.annotationRequestId
                        || revertBtn.dataset.annotationIdentifier
                        || revertBtn.dataset.annotationXref;
                    if (!revertIdentifier) {
                        if (_h.showToast) {
                            _h.showToast('error', 'Unable to determine which annotation to revert.');
                        }
                        return;
                    }
                    handle.revertAnnotationToAi(parseInt(revertBtn.dataset.annotationPage || '-1', 10), revertIdentifier, revertBtn);
                    return;
                }

                var saveBtn = event.target.closest('.save-annotation-btn');
                if (saveBtn) {
                    consumeActionEvent(event);
                    var saveIdentifier = saveBtn.dataset.annotationIdentifier || saveBtn.dataset.annotationXref;
                    if (!saveIdentifier) {
                        if (_h.showToast) {
                            _h.showToast('error', 'Annotation missing.');
                        }
                        return;
                    }
                    handle.saveAnnotationEdit(saveIdentifier, saveBtn);
                    return;
                }

                var verdictIcon = event.target.closest('.verdict-indicator');
                if (verdictIcon) {
                    consumeActionEvent(event);
                    var verdictId = verdictIcon.dataset.annotationRequestId || verdictIcon.dataset.annotationIdentifier || verdictIcon.dataset.annotationXref;
                    var verdictPage = parseInt(verdictIcon.dataset.annotationPage || '-1', 10);
                    if (verdictId && !Number.isNaN(verdictPage) && _h.toggleAnnotationVerdict) {
                        _h.toggleAnnotationVerdict(verdictPage, verdictId, verdictIcon);
                    }
                    return;
                }

                if (event.target.closest('button') || event.target.tagName === 'TEXTAREA') {
                    return;
                }

                var listItem = event.target.closest('.list-group-item');
                if (!listItem) {
                    return;
                }
                var itemIdentifier = listItem.dataset.annotationRequestId || listItem.dataset.annotationIdentifier || listItem.dataset.annotationXref;
                var itemPage = parseInt(listItem.dataset.annotationPage || '-1', 10);
                if (itemIdentifier && !Number.isNaN(itemPage) && _h.scrollToAnnotationMarker) {
                    _h.scrollToAnnotationMarker(itemPage, itemIdentifier);
                }
            });

            listEl.addEventListener('mousedown', function (event) {
                var dot = event.target.closest('.priority-dot');
                if (!dot) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                var dotsContainer = dot.closest('.priority-dots');
                if (!dotsContainer) {
                    return;
                }
                var priorityIdentifier = dotsContainer.dataset.annotationRequestId ||
                    dotsContainer.dataset.annotationIdentifier ||
                    dotsContainer.dataset.annotationXref;
                var priorityPage = parseInt(dotsContainer.dataset.annotationPage || '-1', 10);
                if (!priorityIdentifier || Number.isNaN(priorityPage)) {
                    if (_h.showToast) {
                        _h.showToast('error', 'Unable to locate this annotation. Refresh the comments list and try again.');
                    }
                    return;
                }
                _currentAnnotationsPage = priorityPage;
                if (_h.updateAnnotationPriority) {
                    _h.updateAnnotationPriority(priorityPage, priorityIdentifier, dot.dataset.priority);
                }
            });

            listEl.addEventListener('keydown', function (event) {
                var item = event.target.closest('.list-group-item');
                if (!item) {
                    return;
                }
                var key = (event.key || '').toLowerCase();
                var isDeleteKey =
                    key === 'delete' ||
                    key === 'del' ||
                    key === 'backspace' ||
                    event.code === 'Delete' ||
                    event.code === 'NumpadDelete' ||
                    event.keyCode === 46;
                if (!isDeleteKey) {
                    return;
                }

                var itemDomId = item.dataset.annotationId;
                var isEditingOther = _getEditingAnnotationId() && _getEditingAnnotationId() !== itemDomId;
                var activeTag = (document.activeElement && document.activeElement.tagName) || '';
                var isInField = activeTag === 'TEXTAREA' || activeTag === 'INPUT' || event.target.tagName === 'TEXTAREA';
                var isFieldInThisItem = isInField && item.contains(document.activeElement);
                var textarea = item.querySelector('textarea');
                var hasText = textarea && textarea.value && textarea.value.trim() !== '';
                var allowDeleteFromTextarea = isFieldInThisItem && !hasText;
                if (isEditingOther || (isInField && !allowDeleteFromTextarea)) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                var deleteIdentifier = item.dataset.annotationRequestId || item.dataset.annotationIdentifier || item.dataset.annotationXref;
                var deletePage = parseInt(item.dataset.annotationPage || '-1', 10);
                var deleteButton = item.querySelector('.delete-annotation');
                if (deleteButton) {
                    deleteButton.dataset.confirmed = 'true';
                }
                if (_h.deleteAnnotation) {
                    _h.deleteAnnotation(deletePage, deleteIdentifier, deleteButton);
                }
            });

            listEl.addEventListener('dblclick', function (event) {
                var item = event.target.closest('.list-group-item');
                if (!item || event.target.closest('button') || event.target.tagName === 'TEXTAREA') {
                    return;
                }
                var editIdentifier = item.dataset.annotationRequestId || item.dataset.annotationIdentifier || item.dataset.annotationXref;
                var editPage = parseInt(item.dataset.annotationPage || '-1', 10);
                if (!editIdentifier) {
                    if (_h.showToast) {
                        _h.showToast('error', 'Unable to locate this annotation for editing.');
                    }
                    return;
                }
                handle.beginEdit(editPage, editIdentifier, item.dataset.annotationId);
            });
        }

        function renderSidebar() {
            syncVisibleMarkersFromDom();
            if (_getSplitPanelActive() && _h.renderAIAnnotationsList) {
                _h.renderAIAnnotationsList();
            }

            var listEl = _getCommentsListElement();
            if (!listEl) {
                return;
            }

            var annotationsData = _getAnnotationsData() || {};
            var allAnnotations = [];
            Object.keys(annotationsData).forEach(function (pageIdxStr) {
                var pageIdx = parseInt(pageIdxStr, 10);
                var pageAnnotations = annotationsData[pageIdxStr] || [];
                var displayOrderLookup = _h.buildDisplayOrderByPagePosition
                    ? _h.buildDisplayOrderByPagePosition(pageAnnotations)
                    : {};

                pageAnnotations.forEach(function (ann, idx) {
                    if (isMarkupType(ann.type)) {
                        return;
                    }

                    if (_getSplitPanelActive()) {
                        var source = _h.resolveAnnotationSource ? _h.resolveAnnotationSource(ann) : 'HUMAN';
                        if (source === 'AI') {
                            return;
                        }
                    }

                    var markerKey = _buildVisibilityKey(pageIdx, { annotation: ann });
                    var isVisible = !!markerKey && _visibleMarkers.has(markerKey);
                    var shouldDisplay = SidebarPanelModule.shouldDisplayAnnotation
                        ? SidebarPanelModule.shouldDisplayAnnotation(ann, isVisible)
                        : (isVisible && !isPlaceholderContent(ann.content || ''));
                    if (!shouldDisplay) {
                        return;
                    }

                    var displayIndexOnPage = _h.resolveDisplayOrderFromLookup
                        ? _h.resolveDisplayOrderFromLookup(ann, displayOrderLookup)
                        : (idx + 1);
                    allAnnotations.push(Object.assign({}, ann, {
                        pageIdx: pageIdx,
                        displayIndexOnPage: displayIndexOnPage || (idx + 1),
                        indexOnPage: idx,
                        sourceIndex: idx,
                    }));
                });
            });

            allAnnotations.sort(function (a, b) {
                if (a.pageIdx !== b.pageIdx) {
                    return a.pageIdx - b.pageIdx;
                }
                var displayA = Number(a.displayIndexOnPage || 0);
                var displayB = Number(b.displayIndexOnPage || 0);
                if (displayA !== displayB) {
                    return displayA - displayB;
                }
                if (_h.compareAnnotationsByDocumentPosition) {
                    return _h.compareAnnotationsByDocumentPosition(a, b);
                }
                return 0;
            });

            if (allAnnotations.length === 0) {
                _renderEmptySidebar(listEl);
                return;
            }

            var newHtml = _renderSidebarHtml(allAnnotations);
            if (listEl.innerHTML !== newHtml) {
                listEl.innerHTML = newHtml;
            }

            _attachSidebarEventHandlers(listEl);

            listEl.querySelectorAll('.auto-resize-textarea').forEach(function (sidebarTextarea) {
                if (!sidebarTextarea.id) {
                    return;
                }
                if (sidebarTextarea.dataset.listenersBound) {
                    return;
                }
                sidebarTextarea.dataset.listenersBound = 'true';
                sidebarTextarea.addEventListener('input', function () {
                    var inlineLabel = document.querySelector('.annotation-label.label-editing');
                    if (!inlineLabel) {
                        return;
                    }
                    var inlineTextarea = inlineLabel.querySelector('.inline-annotation-editor');
                    if (inlineTextarea && inlineTextarea !== document.activeElement) {
                        inlineTextarea.value = sidebarTextarea.value;
                    }
                });
            });

            listEl.querySelectorAll('.cancel-edit-btn').forEach(function (btn) {
                if (btn.dataset.listenersBound) {
                    return;
                }
                btn.dataset.listenersBound = 'true';
                btn.addEventListener('click', async function () {
                    var identifier = btn.dataset.annotationIdentifier || btn.dataset.annotationXref || null;
                    var pageIdx = _parseDatasetPageIndex(btn.dataset.annotationPage);
                    await cancelAnnotationEdit(pageIdx, identifier);
                });
            });

            listEl.querySelectorAll('.list-group-item').forEach(function (item) {
                if (item.dataset.listenersBound) {
                    return;
                }
                item.dataset.listenersBound = 'true';
                item.addEventListener('mousedown', function (event) {
                    var clickedElement = event.target;
                    if (clickedElement.closest('button') ||
                        clickedElement.tagName === 'TEXTAREA' ||
                        clickedElement.closest('.verdict-indicator')) {
                        return;
                    }
                    event.preventDefault();
                    item.focus();
                    var stableId = _h.normalizeAnnotationIdentifierValue
                        ? _h.normalizeAnnotationIdentifierValue(
                            item.dataset.annotationRequestId ||
                            item.dataset.annotationIdentifier ||
                            item.dataset.annotationXref
                        )
                        : (item.dataset.annotationRequestId || item.dataset.annotationIdentifier || item.dataset.annotationXref);
                    var pageIdx = parseInt(item.dataset.annotationPage || '-1', 10);
                    if (stableId !== null && !Number.isNaN(pageIdx)) {
                        highlightSelection(pageIdx, stableId);
                    }
                });

                item.addEventListener('focus', function () {
                    item.classList.add('item-focused', 'active');
                });
                item.addEventListener('blur', function () {
                    item.classList.remove('item-focused', 'active');
                });
            });

            var selected = _getSelectedAnnotation();
            if (selected.identifier && selected.pageIdx !== null && _h.escapeCssAttribute) {
                requestAnimationFrame(function () {
                    var stableId = selected.identifier;
                    var pageIdx = selected.pageIdx;
                    var escapedId = _h.escapeCssAttribute(stableId);
                    var selector = [
                        '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-request-id="' + escapedId + '"]',
                        '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-identifier="' + escapedId + '"]',
                        '.list-group-item[data-annotation-page="' + pageIdx + '"][data-annotation-xref="' + escapedId + '"]'
                    ].join(', ');
                    var target = listEl.querySelector(selector);
                    if (target) {
                        target.classList.add('item-focused', 'active');
                    }
                });
            }
        }

        async function loadAnnotations(submissionId, assignmentId) {
            if (_destroyed) {
                return Promise.resolve();
            }

            var sub = submissionId || _getCurrentSubmissionId();
            var asgn = assignmentId || _getCurrentAssignmentId();
            var listEl = _getCommentsListElement();
            var escapeHtml = _h.escapeHtml || function (value) { return String(value || ''); };
            var translate = _h.translatePdfPreviewText || function (value) { return value; };

            if (listEl) {
                listEl.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm" role="status"></div> <span class="ms-2">' +
                    escapeHtml(translate('Loading annotations...')) +
                    '</span></div>';
            }

            try {
                var data = _h.listAnnotationsRequest
                    ? await _h.listAnnotationsRequest(sub, asgn)
                    : { success: false, annotations: {} };

                if (data && data.success) {
                    var normalizedData = _h.normalizeAnnotationsPayload
                        ? _h.normalizeAnnotationsPayload(data.annotations)
                        : (data.annotations || {});
                    _setAnnotationsData(normalizedData);
                    _syncAnnotationsState({ annotationsData: normalizedData });

                    if (_h.cleanupPlaceholderAnnotations) {
                        await _h.cleanupPlaceholderAnnotations();
                    }

                    if (listEl) {
                        listEl.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm" role="status"></div> <span class="ms-2">' +
                            escapeHtml(translate('Detecting visible annotations...')) +
                            '</span></div>';
                    }

                    initializeAnnotationObserver();
                    _emit('onRenderOverlaysNeeded', { forceRender: false });
                    if (_h.refreshMarkupFromAnnotations) {
                        _h.refreshMarkupFromAnnotations();
                    }
                    _emit('onAnnotationsLoaded', {
                        submissionId: sub,
                        assignmentId: asgn,
                        annotationsData: normalizedData,
                    });
                    return data;
                }

                if (listEl) {
                    listEl.innerHTML = '<div class="text-muted small text-center p-3">No annotations found</div>';
                }
                return data;
            } catch (error) {
                console.error('Error loading annotations:', error);
                if (listEl) {
                    listEl.innerHTML = '<div class="text-danger small text-center p-3">Error loading annotations</div>';
                }
                throw error;
            }
        }

        function beginEdit(pageIdx, identifier, domId) {
            var ann = _h.findAnnotationEntry ? _h.findAnnotationEntry(pageIdx, identifier) : null;
            if (ann && ann._originalContent === undefined) {
                ann._originalContent = ann.content || '';
            }
            var nextEditingId = domId || ('ann-' + pageIdx + '-' + identifier);
            _setEditingAnnotationId(nextEditingId);
            _syncAnnotationsState({ editingId: nextEditingId });
            renderSidebar();

            if (_h.escapeCssAttribute) {
                var stableId = _h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(identifier)
                    : identifier;
                var escapedId = _h.escapeCssAttribute(stableId);
                var markerSelector = [
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-request-id="' + escapedId + '"]',
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-identifier="' + escapedId + '"]',
                    '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-xref="' + escapedId + '"]',
                    '.annotation-marker[data-page-idx="' + pageIdx + '"][data-identifier="' + escapedId + '"]'
                ].join(', ');
                var marker = document.querySelector(markerSelector);
                if (marker) {
                    var label = marker.querySelector('.annotation-label');
                    if (label) {
                        document.querySelectorAll('.annotation-label.label-expanded').forEach(function (otherLabel) {
                            if (otherLabel !== label && _h.collapseInlineLabel) {
                                _h.collapseInlineLabel(otherLabel);
                            }
                        });
                        if (_h.expandInlineLabelEdit) {
                            _h.expandInlineLabelEdit(label);
                        }
                    }
                    highlightSelection(pageIdx, identifier);
                }
            }

            setTimeout(function () {
                var stableId = _h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(identifier)
                    : identifier;
                var textarea = document.getElementById('edit-annotation-text-' + stableId);
                if (textarea) {
                    if (_h.setupTextareaAutoResize) {
                        _h.setupTextareaAutoResize(textarea);
                    }
                    _focusElementWithoutScroll(textarea);
                }
            }, 50);
        }

        async function createTemporaryAnnotation(rect, pageIdx, options) {
            if (!_getCurrentSubmissionId()) {
                if (_h.showToast) {
                    _h.showToast('error', 'Select a submission first.');
                }
                return Promise.resolve();
            }

            var viewer = window.__pdfGradedViewer;
            if (!viewer || !viewer.pdf) {
                if (_h.showToast) {
                    _h.showToast('error', 'Load the graded PDF before adding comments.');
                }
                return Promise.resolve();
            }

            var targetPage = (typeof pageIdx === 'number' && !Number.isNaN(pageIdx))
                ? pageIdx
                : Math.max(0, (viewer.currentPage || 1) - 1);
            var apiRect = options && Array.isArray(options.apiRect) ? options.apiRect : rect;
            var tempXref = '_tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
            var tempStableId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var optimisticAnnotation = _h.enhanceAnnotationEntry
                ? _h.enhanceAnnotationEntry({
                    type: 'Text',
                    rect: Array.isArray(rect) ? rect.map(function (value) { return Number(value); }) : rect,
                    color: { stroke: [1, 0.75, 0] },
                    content: 'New comment...',
                    id: tempStableId,
                    stable_id: tempStableId,
                    xref: tempXref,
                    page_index: targetPage,
                    source: 'HUMAN',
                    is_verdict: false,
                })
                : {
                    type: 'Text',
                    rect: rect,
                    color: { stroke: [1, 0.75, 0] },
                    content: 'New comment...',
                    id: tempStableId,
                    stable_id: tempStableId,
                    xref: tempXref,
                    page_index: targetPage,
                    source: 'HUMAN',
                    is_verdict: false,
                };

            optimisticAnnotation._isTemporary = true;
            optimisticAnnotation._isOptimistic = true;
            optimisticAnnotation._createdAtSession = true;
            optimisticAnnotation._tempXref = tempXref;
            if (optimisticAnnotation._originalContent === undefined) {
                optimisticAnnotation._originalContent = optimisticAnnotation.content || '';
            }

            var annotationsData = _getAnnotationsData();
            if (!annotationsData[targetPage]) {
                annotationsData[targetPage] = [];
            }
            annotationsData[targetPage].push(optimisticAnnotation);
            _setAnnotationsData(annotationsData);
            setCurrentAnnotationsPage(targetPage);

            var optimisticMarkerKey = _buildVisibilityKey(targetPage, {
                xref: tempXref,
                identifier: tempStableId,
            });
            if (optimisticMarkerKey) {
                _visibleMarkers.add(optimisticMarkerKey);
            }

            markLocalChange();
            var identifier = _h.resolveAnnotationIdentifierValue
                ? _h.resolveAnnotationIdentifierValue(optimisticAnnotation)
                : tempStableId;
            optimisticAnnotation._tempIdentifier = identifier;
            _setEditingId('ann-' + targetPage + '-' + identifier);
            _renderAfterMutation();

            setTimeout(function () {
                if (_getEditingAnnotationId() === null || !_h.escapeCssAttribute) {
                    return;
                }

                var escapedId = _h.escapeCssAttribute(identifier);
                var escapedXref = _h.escapeCssAttribute(tempXref);
                var currentIdentifier = _h.resolveAnnotationIdentifierValue
                    ? _h.resolveAnnotationIdentifierValue(optimisticAnnotation)
                    : identifier;
                var escapedCurrentId = (currentIdentifier && currentIdentifier !== identifier)
                    ? _h.escapeCssAttribute(currentIdentifier)
                    : null;
                var markerSelectorParts = [
                    '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-request-id="' + escapedId + '"]',
                    '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-identifier="' + escapedId + '"]',
                    '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-xref="' + escapedId + '"]',
                    '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-xref="' + escapedXref + '"]',
                    '.annotation-marker[data-page-idx="' + targetPage + '"][data-identifier="' + escapedId + '"]',
                ];
                if (escapedCurrentId) {
                    markerSelectorParts.push(
                        '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-request-id="' + escapedCurrentId + '"]',
                        '.annotation-marker[data-annotation-page="' + targetPage + '"][data-annotation-identifier="' + escapedCurrentId + '"]'
                    );
                }
                var marker = document.querySelector(markerSelectorParts.join(', '));
                if (!marker) {
                    return;
                }
                var label = marker.querySelector('.annotation-label');
                if (!label || label.classList.contains('label-editing')) {
                    return;
                }
                document.querySelectorAll('.annotation-label.label-expanded').forEach(function (otherLabel) {
                    if (otherLabel !== label && _h.collapseInlineLabel) {
                        _h.collapseInlineLabel(otherLabel);
                    }
                });
                if (_h.expandInlineLabelEdit) {
                    _h.expandInlineLabelEdit(label);
                }
            }, 50);

            setTimeout(function () {
                var requestIdentifier = optimisticAnnotation.requestIdentifier || identifier;
                var textarea = document.getElementById('edit-annotation-text-' + identifier)
                    || document.getElementById('edit-annotation-text-' + requestIdentifier)
                    || document.querySelector('.auto-resize-textarea[id^="edit-annotation-text-"]');
                if (!textarea) {
                    return;
                }
                if (_h.setupTextareaAutoResize) {
                    _h.setupTextareaAutoResize(textarea);
                }

                var escapeHandler = async function (e) {
                    try {
                        if (e.key !== 'Escape') {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();

                        textarea.removeEventListener('keydown', escapeHandler, true);
                        if (textarea._blurHandler) {
                            textarea.removeEventListener('blur', textarea._blurHandler);
                        }

                        var currentContent = textarea.value.trim();
                        var originalContent = (optimisticAnnotation.content || '').trim();
                        var isPlaceholder = currentContent === '' ||
                            currentContent === 'New comment...' ||
                            currentContent === 'New comment';
                        var neverEdited = originalContent === 'New comment...' ||
                            originalContent === 'New comment' ||
                            originalContent === '';
                        var contentWasEdited = currentContent !== originalContent;
                        var hasEditedFlags = optimisticAnnotation._hasBeenEdited === true || optimisticAnnotation._priorityChanged === true;

                        if (optimisticAnnotation._isTemporary && !hasEditedFlags && !contentWasEdited && (neverEdited || isPlaceholder)) {
                            var requestId = optimisticAnnotation.requestIdentifier || identifier;
                            await deleteAnnotationSilently(targetPage, requestId);
                            _setEditingId(null);
                            _scheduleAnnotationUpdate();
                        } else if (contentWasEdited && currentContent) {
                            textarea.value = currentContent;
                            await saveAnnotationEdit(identifier);
                        } else {
                            _setEditingId(null);
                            _scheduleAnnotationUpdate();
                        }
                    } catch (err) {
                        console.error('[ANNOTATION-CTRL] Escape handler error:', err);
                        _setEditingId(null);
                        _scheduleAnnotationUpdate();
                    }
                };

                var blurHandler = function (e) {
                    var currentEditingId = 'ann-' + targetPage + '-' + identifier;
                    var relatedTarget = e.relatedTarget;
                    var isPriorityDotClick = relatedTarget && (
                        relatedTarget.classList.contains('priority-dot') ||
                        relatedTarget.closest('.priority-dots') !== null ||
                        relatedTarget.closest('.priority-dot') !== null
                    );
                    var isSaveButtonClick = relatedTarget && (
                        relatedTarget.classList.contains('save-annotation-btn') ||
                        relatedTarget.closest('.save-annotation-btn') !== null
                    );
                    var isAnnotationMarkerClick = relatedTarget && (
                        relatedTarget.classList.contains('annotation-marker') ||
                        relatedTarget.classList.contains('annotation-label') ||
                        relatedTarget.classList.contains('inline-annotation-editor') ||
                        relatedTarget.closest('.annotation-marker') !== null
                    );

                    if (isPriorityDotClick || isSaveButtonClick || isAnnotationMarkerClick ||
                        document.querySelector('.annotation-label.label-editing') !== null) {
                        return;
                    }

                    setTimeout(async function () {
                        try {
                            // Ignore blur events caused by rerender/removal of the
                            // old temporary textarea after the create POST returns.
                            // The replacement editor will be rebound separately.
                            if (!textarea.isConnected) {
                                return;
                            }

                            if (_savingAnnotationId === currentEditingId ||
                                _updatingPriorityId === currentEditingId ||
                                _isDraggingAnnotation ||
                                document.querySelector('.annotation-label.label-editing') !== null) {
                                return;
                            }

                            if (_getEditingAnnotationId() === currentEditingId) {
                                var currentAnnotation = _h.findAnnotationEntry
                                    ? _h.findAnnotationEntry(targetPage, identifier)
                                    : null;
                                var currentContent = textarea.value.trim();
                                var latestOriginalContent = (currentAnnotation && currentAnnotation.content) || optimisticAnnotation.content || '';
                                latestOriginalContent = latestOriginalContent.trim();
                                var isPlaceholderNow = currentContent === '' ||
                                    currentContent === 'New comment...' ||
                                    currentContent === 'New comment';
                                var contentWasEditedNow = currentContent !== latestOriginalContent;
                                var neverEditedNow = !contentWasEditedNow && (
                                    latestOriginalContent === 'New comment...' ||
                                    latestOriginalContent === 'New comment' ||
                                    latestOriginalContent === ''
                                );
                                var isTemporary = currentAnnotation && currentAnnotation._isTemporary !== undefined
                                    ? currentAnnotation._isTemporary
                                    : optimisticAnnotation._isTemporary;
                                var hasEditedFlagsNow = currentAnnotation?._hasBeenEdited === true || currentAnnotation?._priorityChanged === true;

                                if (isTemporary && !hasEditedFlagsNow && !contentWasEditedNow && (neverEditedNow || isPlaceholderNow)) {
                                    var latestRequestId = (currentAnnotation && currentAnnotation.requestIdentifier) ||
                                        optimisticAnnotation.requestIdentifier ||
                                        identifier;
                                    await deleteAnnotationSilently(targetPage, latestRequestId);
                                    _setEditingId(null);
                                    _scheduleAnnotationUpdate();
                                }
                            }
                        } catch (err) {
                            console.error('[ANNOTATION-CTRL] Blur handler error:', err);
                            _setEditingId(null);
                            _scheduleAnnotationUpdate();
                        }
                    }, 100);
                };

                textarea.addEventListener('keydown', escapeHandler, true);
                textarea._escapeHandler = escapeHandler;
                textarea.addEventListener('blur', blurHandler);
                textarea._blurHandler = blurHandler;
            }, 100);

            var abortController = new AbortController();
            optimisticAnnotation._abortController = abortController;
            optimisticAnnotation._createPromise = (async function () {
                try {
                    if (!_h.createAnnotationRequest) {
                        throw new Error('Annotation create request helper is unavailable.');
                    }

                    var data = await _h.createAnnotationRequest({
                        content: 'New comment...',
                        page_index: targetPage,
                        color: 'amber',
                        kind: 'text',
                        rect: apiRect,
                        canvas_user_name: _canvasUserName || null,
                    });

                    if (abortController.signal.aborted) {
                        return;
                    }
                    if (!data.success || !data.annotation || !data.annotation.xref) {
                        throw new Error((data && data.error) || 'Failed to add annotation');
                    }

                    var localPageAnns = _getAnnotationsData()[targetPage] || [];
                    var optimisticIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(targetPage, tempXref) : -1;
                    if (optimisticIdx < 0) {
                        return;
                    }

                    var previousIdentifier = _h.resolveAnnotationIdentifierValue
                        ? _h.resolveAnnotationIdentifierValue(optimisticAnnotation)
                        : null;
                    var draftContent = null;
                    var inlineDraftTextarea = document.querySelector('.annotation-label.label-editing .inline-annotation-editor');
                    if (inlineDraftTextarea) {
                        draftContent = inlineDraftTextarea.value;
                    }
                    if (draftContent === null || draftContent === undefined) {
                        var sidebarDraftTextarea = document.querySelector('.auto-resize-textarea[id^="edit-annotation-text-"]');
                        if (sidebarDraftTextarea) {
                            draftContent = sidebarDraftTextarea.value;
                        }
                    }
                    var updatedAnnotation = _h.enhanceAnnotationEntry
                        ? _h.enhanceAnnotationEntry(data.annotation)
                        : data.annotation;
                    var existingMarker = _findMarkerForIdentifiers(targetPage, [
                        tempStableId,
                        tempXref,
                        previousIdentifier,
                    ]);
                    Object.assign(optimisticAnnotation, updatedAnnotation);
                    if (draftContent !== null && draftContent !== undefined) {
                        optimisticAnnotation.content = draftContent;
                    }
                    optimisticAnnotation._isTemporary = true;
                    optimisticAnnotation._createdAtSession = true;
                    optimisticAnnotation._isOptimistic = false;
                    optimisticAnnotation._tempXref = tempXref;
                    optimisticAnnotation._tempIdentifier = previousIdentifier;
                    if (optimisticAnnotation._originalContent === undefined) {
                        optimisticAnnotation._originalContent = optimisticAnnotation.content || '';
                    }
                    localPageAnns[optimisticIdx] = optimisticAnnotation;

                    var tempMarkerKey = _buildVisibilityKey(targetPage, {
                        xref: tempXref,
                        identifier: tempStableId,
                    });
                    if (tempMarkerKey) {
                        _visibleMarkers.delete(tempMarkerKey);
                    }
                    var persistedMarkerKey = _buildVisibilityKey(targetPage, {
                        annotation: optimisticAnnotation,
                    });
                    if (persistedMarkerKey) {
                        _visibleMarkers.add(persistedMarkerKey);
                    }

                    var newIdentifier = _h.resolveAnnotationIdentifierValue
                        ? _h.resolveAnnotationIdentifierValue(optimisticAnnotation)
                        : previousIdentifier;
                    if (previousIdentifier && newIdentifier && previousIdentifier !== newIdentifier) {
                        var oldEditingId = 'ann-' + targetPage + '-' + previousIdentifier;
                        if (_getEditingAnnotationId() === oldEditingId) {
                            _setEditingId('ann-' + targetPage + '-' + newIdentifier);
                        }
                    }

                    delete optimisticAnnotation._abortController;
                    delete optimisticAnnotation._createPromise;
                    var restoreIdentifier = newIdentifier || previousIdentifier || identifier;
                    var existingLabel = _applyAnnotationIdentityToMarker(existingMarker, targetPage, optimisticAnnotation);
                    var keepInlineEditor = !!(
                        existingLabel &&
                        existingLabel.classList.contains('label-editing') &&
                        _h.expandInlineLabelEdit
                    );

                    if (keepInlineEditor) {
                        var preservedOriginalFullText = existingLabel.dataset.originalFullText
                            || existingLabel.dataset.fullText
                            || 'New comment...';
                        existingLabel.dataset.fullText = preservedOriginalFullText;
                        _h.expandInlineLabelEdit(existingLabel);
                        if (existingLabel.dataset.originalFullText !== preservedOriginalFullText) {
                            existingLabel.dataset.originalFullText = preservedOriginalFullText;
                        }
                        _renderAfterMutation({ renderOverlays: false });
                        if (draftContent !== null && draftContent !== undefined) {
                            setTimeout(function () {
                                var restoredSidebarTextarea = document.getElementById('edit-annotation-text-' + restoreIdentifier)
                                    || document.querySelector('.auto-resize-textarea[id^="edit-annotation-text-"]');
                                if (restoredSidebarTextarea) {
                                    restoredSidebarTextarea.value = draftContent;
                                    if (_h.setupTextareaAutoResize) {
                                        _h.setupTextareaAutoResize(restoredSidebarTextarea);
                                    }
                                }
                                var restoredInlineTextarea = existingLabel.querySelector('.inline-annotation-editor')
                                    || document.querySelector('.annotation-label.label-editing .inline-annotation-editor');
                                if (restoredInlineTextarea) {
                                    restoredInlineTextarea.value = draftContent;
                                    _focusElementWithoutScroll(restoredInlineTextarea);
                                }
                            }, 50);
                        }
                    } else {
                        _renderAfterMutation();
                        setTimeout(function () {
                            if (!restoreIdentifier) {
                                return;
                            }
                            beginEdit(
                                targetPage,
                                restoreIdentifier,
                                'ann-' + targetPage + '-' + restoreIdentifier
                            );
                            if (draftContent === null || draftContent === undefined) {
                                return;
                            }
                            setTimeout(function () {
                                var restoredSidebarTextarea = document.getElementById('edit-annotation-text-' + restoreIdentifier)
                                    || document.querySelector('.auto-resize-textarea[id^="edit-annotation-text-"]');
                                if (restoredSidebarTextarea) {
                                    restoredSidebarTextarea.value = draftContent;
                                    if (_h.setupTextareaAutoResize) {
                                        _h.setupTextareaAutoResize(restoredSidebarTextarea);
                                    }
                                }
                                var restoredInlineTextarea = document.querySelector('.annotation-label.label-editing .inline-annotation-editor');
                                if (restoredInlineTextarea) {
                                    restoredInlineTextarea.value = draftContent;
                                }
                            }, 50);
                        }, 0);
                    }
                } catch (error) {
                    if (error && error.name === 'AbortError') {
                        return;
                    }
                    var removalIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(targetPage, tempXref) : -1;
                    if (removalIdx >= 0 && _getAnnotationsData()[targetPage]) {
                        _getAnnotationsData()[targetPage].splice(removalIdx, 1);
                    }
                    var failedMarkerKey = _buildVisibilityKey(targetPage, {
                        xref: tempXref,
                        identifier: tempStableId,
                    });
                    if (failedMarkerKey) {
                        _visibleMarkers.delete(failedMarkerKey);
                    }
                    if (_getEditingAnnotationId() === 'ann-' + targetPage + '-' + identifier) {
                        _setEditingId(null);
                    }
                    _renderAfterMutation();
                    if (_h.showToast) {
                        _h.showToast('error', error.message || 'Failed to create annotation.');
                    }
                } finally {
                    delete optimisticAnnotation._abortController;
                    delete optimisticAnnotation._createPromise;
                }
            })();

            return optimisticAnnotation._createPromise;
        }

        async function saveAnnotationEdit(identifier, sourceButton) {
            var stableIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(identifier)
                : identifier;
            if (!stableIdentifier) {
                if (_h.showToast) {
                    _h.showToast('error', 'Unable to determine which annotation to update. Refresh the comments and try again.');
                }
                return Promise.resolve();
            }

            var currentEditingId = _getEditingAnnotationId();
            if (_savingAnnotationId === currentEditingId) {
                return Promise.resolve();
            }

            var textarea = document.getElementById('edit-annotation-text-' + stableIdentifier);
            if (!textarea) {
                return Promise.resolve();
            }

            var newContent = textarea.value.trim();
            var escapedId = _h.escapeCssAttribute ? _h.escapeCssAttribute(stableIdentifier) : stableIdentifier;
            var saveBtn = sourceButton || document.querySelector(
                '.save-annotation-btn[data-annotation-identifier="' + escapedId + '"], .save-annotation-btn[data-annotation-xref="' + escapedId + '"]'
            );
            if (!saveBtn || saveBtn.disabled) {
                return Promise.resolve();
            }

            var requestIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(
                    (sourceButton && sourceButton.dataset ? (
                        sourceButton.dataset.annotationRequestId ||
                        sourceButton.dataset.annotationIdentifier ||
                        sourceButton.dataset.annotationXref
                    ) : null) ||
                    (saveBtn && saveBtn.dataset ? (
                        saveBtn.dataset.annotationRequestId ||
                        saveBtn.dataset.annotationIdentifier ||
                        saveBtn.dataset.annotationXref
                    ) : null) ||
                    stableIdentifier
                )
                : stableIdentifier;
            var listItem = saveBtn.closest('.list-group-item');
            var pageIdx = _parseDatasetPageIndex(listItem && listItem.dataset.annotationPage);
            if (pageIdx === null) {
                if (_h.showToast) {
                    _h.showToast('error', 'Unable to save annotation: missing page context.');
                }
                return Promise.resolve();
            }
            var originalAnn = _h.findAnnotationEntry
                ? _h.findAnnotationEntry(pageIdx, requestIdentifier || stableIdentifier)
                : null;
            if (originalAnn && originalAnn._createPromise) {
                try {
                    await originalAnn._createPromise;
                } catch (error) {
                    console.error('[ANNOTATION-CTRL] Initial create failed before save:', error);
                    if (_h.showToast) {
                        _h.showToast('error', 'Please wait for comment creation to finish, then try again.');
                    }
                    return Promise.resolve();
                }
                originalAnn = _h.findAnnotationEntry
                    ? _h.findAnnotationEntry(pageIdx, requestIdentifier || stableIdentifier) || originalAnn
                    : originalAnn;
            }

            var originalContent = ((originalAnn && originalAnn.content) || '').trim();
            var originalSource = _h.resolveAnnotationSource ? _h.resolveAnnotationSource(originalAnn || {}) : 'HUMAN';
            var hasEditedFlags = originalAnn?._hasBeenEdited === true || originalAnn?._priorityChanged === true;
            var existingXref = originalAnn && originalAnn.xref ? String(originalAnn.xref) : null;

            if ((newContent === '' || isPlaceholderContent(newContent)) && !hasEditedFlags) {
                if (textarea._escapeHandler) {
                    textarea.removeEventListener('keydown', textarea._escapeHandler, true);
                }
                await deleteAnnotationSilently(pageIdx, requestIdentifier || stableIdentifier);
                _setEditingId(null);
                _renderAfterMutation();
                return Promise.resolve();
            }

            saveBtn.disabled = true;
            var spinner = saveBtn.querySelector('.spinner-border');
            var btnText = saveBtn.querySelector('.btn-text');
            if (spinner) {
                spinner.classList.remove('d-none');
            }
            if (btnText) {
                btnText.textContent = 'Saving...';
            }
            _savingAnnotationId = currentEditingId;

            try {
                if (textarea._escapeHandler) {
                    textarea.removeEventListener('keydown', textarea._escapeHandler, true);
                }
                if (!_h.buildApiAnnotationIdentifier || !_h.updateAnnotationRequest) {
                    throw new Error('Annotation update helpers are unavailable.');
                }

                var apiIdentifier = _h.buildApiAnnotationIdentifier({
                    identifier: stableIdentifier,
                    xref: existingXref,
                    requestId: requestIdentifier,
                });
                var data = await _h.updateAnnotationRequest(apiIdentifier, { content: newContent });
                if (!data.success || !data.annotation) {
                    throw new Error((data && data.error) || 'Update failed');
                }

                var responsePageIdx = data.annotation.page_index;
                var annotations = _getAnnotationsData();
                if (annotations[responsePageIdx]) {
                    var annIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(responsePageIdx, requestIdentifier || stableIdentifier) : -1;
                    if (annIdx >= 0) {
                        var updatedAnn = _h.enhanceAnnotationEntry ? _h.enhanceAnnotationEntry(data.annotation) : data.annotation;
                        delete updatedAnn._isTemporary;
                        updatedAnn._originalContent = updatedAnn.content || '';
                        annotations[responsePageIdx][annIdx] = updatedAnn;

                        var newSource = _h.resolveAnnotationSource ? _h.resolveAnnotationSource(updatedAnn) : 'HUMAN';
                        pushUndoOperation({
                            type: 'edit',
                            identifier: stableIdentifier,
                            xref: existingXref,
                            requestId: requestIdentifier,
                            pageIdx: pageIdx,
                            oldContent: originalContent,
                            newContent: newContent,
                            oldSource: originalSource,
                            newSource: newSource,
                            isOwnershipTransfer: originalSource === 'AI' && newSource === 'HUMAN',
                        });
                    }
                }

                _setEditingId(null);
                _savingAnnotationId = null;
                markLocalChange();
                _renderAfterMutation();
                if (originalSource === 'AI' && data.annotation && data.annotation.source === 'HUMAN' && _h.showToast) {
                    _h.showToast('info', (_h.translatePdfPreviewText ? _h.translatePdfPreviewText('Annotation ownership transferred to you') : 'Annotation ownership transferred to you'));
                }
            } catch (error) {
                _savingAnnotationId = null;
                console.error('[ANNOTATION-CTRL] Error saving annotation:', error);
                var currentAnnotations = _getAnnotationsData();
                if (originalAnn && currentAnnotations[pageIdx]) {
                    var originalIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(pageIdx, requestIdentifier || stableIdentifier) : -1;
                    if (originalIdx >= 0) {
                        currentAnnotations[pageIdx][originalIdx].content = originalContent;
                    }
                }
                renderSidebar();
                if (_h.showToast) {
                    _h.showToast('error', error.message || 'Failed to save annotation. Please try again.');
                }
            } finally {
                saveBtn.disabled = false;
                if (spinner) {
                    spinner.classList.add('d-none');
                }
                if (btnText) {
                    btnText.textContent = 'Save';
                }
            }
            return Promise.resolve();
        }

        async function _revertAnnotationToAi(pageIdx, identifier, sourceButton) {
            // Hosted Canvas server-mode only — gated by host capability
            // advertised through `_h.hostAdvertisesCapability('revertToAi')`.
            // Posts to the revert-to-ai endpoint, reloads annotations so
            // marker layer + sidebar lists update in place (no modal reopen).
            if (!identifier) {
                if (_h.showToast) _h.showToast('error', 'Unable to revert annotation: missing identifier.');
                return;
            }
            if (!_h.hostAdvertisesCapability || !_h.hostAdvertisesCapability('revertToAi')) {
                if (_h.showToast) _h.showToast('error', 'Revert to AI is not supported on this surface.');
                return;
            }
            if (typeof _h.revertAnnotationToAiRequest !== 'function') {
                if (_h.showToast) _h.showToast('error', 'Revert to AI request helper is unavailable.');
                return;
            }
            var spinner = sourceButton ? sourceButton.querySelector('.spinner-border') : null;
            var iconEl = sourceButton ? sourceButton.querySelector('i') : null;
            if (sourceButton) sourceButton.disabled = true;
            if (spinner) spinner.classList.remove('d-none');
            if (iconEl) iconEl.classList.add('d-none');
            try {
                var stable = sourceButton && sourceButton.dataset
                    ? (sourceButton.dataset.annotationStableId || null)
                    : null;
                if ((!stable || stable === identifier) && _h.resolveAnnotationIdParts) {
                    var resolvedStable = _h.resolveAnnotationIdParts({
                        requestId: stable || identifier,
                        identifier: stable || identifier,
                    });
                    stable = resolvedStable && resolvedStable.stableId
                        ? resolvedStable.stableId
                        : stable;
                }
                stable = _h.normalizeAnnotationIdentifierValue
                    ? _h.normalizeAnnotationIdentifierValue(stable || identifier)
                    : (stable || identifier);
                var data = await _h.revertAnnotationToAiRequest(stable || identifier);
                if (!data || data.success !== true) {
                    throw new Error((data && (data.error || data.detail)) || 'Revert failed');
                }
                if (_h.showToast) _h.showToast('success', 'Annotation reverted to AI.');
                if (typeof _h.loadAnnotations === 'function') {
                    try { await _h.loadAnnotations(); } catch (e) { /* non-fatal */ }
                }
            } catch (err) {
                if (_h.showToast) _h.showToast('error', err && err.message ? err.message : 'Revert failed.');
            } finally {
                if (sourceButton) sourceButton.disabled = false;
                if (spinner) spinner.classList.add('d-none');
                if (iconEl) iconEl.classList.remove('d-none');
            }
        }

        async function deleteAnnotation(pageIdx, identifier, sourceButton) {
            var stableIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(identifier)
                : identifier;

            if (sourceButton && !sourceButton.dataset.confirmed) {
                var actionRow = sourceButton.closest('.annotation-action-row, .btn-group');
                var currentListItem = null;
                var currentActionRow = null;
                if (!actionRow && stableIdentifier) {
                    var commentsList = _getCommentsListElement();
                    if (commentsList) {
                        var escapedIdentifier = _h.escapeCssAttribute
                            ? _h.escapeCssAttribute(stableIdentifier)
                            : stableIdentifier;
                        var pageSelector = !Number.isNaN(pageIdx) && pageIdx >= 0
                            ? '[data-annotation-page="' + pageIdx + '"]'
                            : '';
                        currentListItem = commentsList.querySelector(
                            '.list-group-item' + pageSelector + '[data-annotation-request-id="' + escapedIdentifier + '"], ' +
                            '.list-group-item' + pageSelector + '[data-annotation-identifier="' + escapedIdentifier + '"], ' +
                            '.list-group-item' + pageSelector + '[data-annotation-xref="' + escapedIdentifier + '"], ' +
                            '.list-group-item' + pageSelector + '[data-annotation-stable-id="' + escapedIdentifier + '"]'
                        );
                        currentActionRow = currentListItem
                            ? currentListItem.querySelector('.annotation-action-row, .btn-group')
                            : null;
                        if (currentActionRow && currentActionRow.querySelector('.confirm-delete-yes')) {
                            return Promise.resolve();
                        }
                        if (currentActionRow && sourceButton && !sourceButton.isConnected) {
                            var currentDeleteButton = currentActionRow.querySelector('.delete-annotation');
                            if (currentDeleteButton) {
                                sourceButton = currentDeleteButton;
                                actionRow = currentActionRow;
                            }
                        }
                    }
                }
                if (!actionRow && sourceButton && !sourceButton.isConnected) {
                    return Promise.resolve();
                }
                if (actionRow) {
                    var originalHtml = actionRow.innerHTML;
                    actionRow.innerHTML = '' +
                        '<button class="btn btn-danger btn-sm confirm-delete-yes text-xs-dynamic">Delete?</button>' +
                        '<button class="btn btn-outline-secondary btn-sm confirm-delete-cancel text-xs-dynamic">Cancel</button>';
                    var yesBtn = actionRow.querySelector('.confirm-delete-yes');
                    var cancelBtn = actionRow.querySelector('.confirm-delete-cancel');

                    yesBtn.addEventListener('click', async function () {
                        sourceButton.dataset.confirmed = 'true';
                        await deleteAnnotation(pageIdx, identifier, sourceButton);
                    });
                    cancelBtn.addEventListener('click', function () {
                        actionRow.innerHTML = originalHtml;
                        renderSidebar();
                    });
                    return Promise.resolve();
                }
            }
            if (!stableIdentifier) {
                if (_h.showToast) {
                    _h.showToast('error', 'Unable to determine which annotation to delete. Refresh the comments and try again.');
                }
                return Promise.resolve();
            }

            var escapedId = _h.escapeCssAttribute ? _h.escapeCssAttribute(stableIdentifier) : stableIdentifier;
            var deleteBtn = sourceButton || document.querySelector(
                '.delete-annotation[data-annotation-identifier="' + escapedId + '"], .delete-annotation[data-annotation-xref="' + escapedId + '"]'
            );
            if (deleteBtn && deleteBtn.disabled) {
                return Promise.resolve();
            }

            var requestIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(
                    (sourceButton && sourceButton.dataset ? (
                        sourceButton.dataset.annotationXref ||
                        sourceButton.dataset.annotationRequestId ||
                        sourceButton.dataset.annotationIdentifier
                    ) : null) ||
                    (deleteBtn && deleteBtn.dataset ? (
                        deleteBtn.dataset.annotationXref ||
                        deleteBtn.dataset.annotationRequestId ||
                        deleteBtn.dataset.annotationIdentifier
                    ) : null) ||
                    stableIdentifier
                )
                : stableIdentifier;
            var originalAnn = _h.findAnnotationEntry ? _h.findAnnotationEntry(pageIdx, requestIdentifier || stableIdentifier) : null;
            if (!originalAnn) {
                if (_h.showToast) {
                    _h.showToast('error', 'Annotation not found');
                }
                return Promise.resolve();
            }

            var existingXref = originalAnn.xref ? String(originalAnn.xref) : null;
            if (deleteBtn) {
                deleteBtn.disabled = true;
                var deleteSpinner = deleteBtn.querySelector('.spinner-border');
                var deleteIcon = deleteBtn.querySelector('i');
                if (deleteSpinner) {
                    deleteSpinner.classList.remove('d-none');
                }
                if (deleteIcon) {
                    deleteIcon.style.display = 'none';
                }
            }

            try {
                if (!_h.buildApiAnnotationIdentifier || !_h.deleteAnnotationRequest) {
                    throw new Error('Annotation delete helpers are unavailable.');
                }
                var apiIdentifier = _h.buildApiAnnotationIdentifier({
                    identifier: stableIdentifier,
                    xref: existingXref,
                    requestId: requestIdentifier,
                });
                var data = await _h.deleteAnnotationRequest(apiIdentifier);
                if (!data.success) {
                    throw new Error((data && data.error) || 'Delete failed');
                }

                pushUndoOperation({
                    type: 'delete',
                    pageIdx: pageIdx,
                    annotation: {
                        content: originalAnn.content,
                        type: originalAnn.type,
                        rect: _cloneRect(originalAnn && originalAnn.rect),
                        color: originalAnn.color,
                        priority: _h.deriveAnnotationPriority ? _h.deriveAnnotationPriority(originalAnn) : originalAnn.priority,
                        xref: originalAnn.xref,
                        id: originalAnn.id,
                        quads: _cloneQuads(originalAnn && originalAnn.quads),
                        anchor_text: originalAnn ? originalAnn.anchor_text : undefined,
                        check_id: originalAnn.check_id,
                        task_id: originalAnn.task_id,
                        stable_id: _extractStableIdentifier(originalAnn, null),
                        source: _h.resolveAnnotationSource ? _h.resolveAnnotationSource(originalAnn) : originalAnn.source,
                    },
                });

                var annotationsData = _getAnnotationsData();
                if (annotationsData[pageIdx]) {
                    var removalIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(pageIdx, requestIdentifier || stableIdentifier) : -1;
                    if (removalIdx >= 0) {
                        annotationsData[pageIdx].splice(removalIdx, 1);
                    }
                }
                _setEditingId(null);
                markLocalChange();
                _renderAfterMutation();
            } catch (error) {
                console.error('[ANNOTATION-CTRL] Error deleting annotation:', error);
                var annotations = _getAnnotationsData();
                if (originalAnn && annotations[pageIdx]) {
                    var existingIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(pageIdx, requestIdentifier || stableIdentifier) : -1;
                    if (existingIdx < 0) {
                        annotations[pageIdx].push(originalAnn);
                        annotations[pageIdx].sort(function (a, b) {
                            var aVal = _h.resolveAnnotationIdentifierValue ? (_h.resolveAnnotationIdentifierValue(a) || '') : '';
                            var bVal = _h.resolveAnnotationIdentifierValue ? (_h.resolveAnnotationIdentifierValue(b) || '') : '';
                            return String(aVal).localeCompare(String(bVal));
                        });
                    }
                }
                _renderAfterMutation();
                if (_h.showToast) {
                    _h.showToast('error', error.message || 'Failed to delete annotation. Please try again.');
                }
            } finally {
                if (deleteBtn) {
                    deleteBtn.disabled = false;
                    var spinner = deleteBtn.querySelector('.spinner-border');
                    if (spinner) {
                        spinner.classList.add('d-none');
                    }
                    var icon = deleteBtn.querySelector('i');
                    if (icon) {
                        icon.style.display = '';
                    }
                    delete deleteBtn.dataset.confirmed;
                }
            }
            return Promise.resolve();
        }

        async function deleteAnnotationSilently(pageIdx, identifier) {
            var stableIdentifier = _h.normalizeAnnotationIdentifierValue
                ? _h.normalizeAnnotationIdentifierValue(identifier)
                : identifier;
            if (!stableIdentifier) {
                return Promise.resolve();
            }

            var annotationEntry = _h.findAnnotationEntry ? _h.findAnnotationEntry(pageIdx, stableIdentifier) : null;
            if (annotationEntry && annotationEntry._isOptimistic && annotationEntry._createPromise) {
                try {
                    if (annotationEntry._abortController) {
                        annotationEntry._abortController.abort();
                    }
                } catch (_abortError) {
                    debugLog('[ANNOTATION-CTRL] Abort controller error:', _abortError);
                }

                var optimisticAnnotations = _getAnnotationsData();
                if (optimisticAnnotations[pageIdx]) {
                    var localIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(pageIdx, stableIdentifier) : -1;
                    if (localIdx >= 0) {
                        optimisticAnnotations[pageIdx].splice(localIdx, 1);
                    }
                }

                [
                    _buildVisibilityKey(pageIdx, { annotation: annotationEntry }),
                    _buildVisibilityKey(pageIdx, { xref: annotationEntry.xref }),
                    _buildVisibilityKey(pageIdx, { xref: annotationEntry._tempXref, identifier: annotationEntry._tempIdentifier }),
                ].filter(Boolean).forEach(function (markerKey) {
                    _visibleMarkers.delete(markerKey);
                });

                _renderAfterMutation();
                return Promise.resolve();
            }

            if (annotationEntry && annotationEntry._createPromise) {
                try {
                    await annotationEntry._createPromise;
                } catch (error) {
                    debugLog('[ANNOTATION-CTRL] Pending create failed before silent delete:', error);
                }
            }

            var annotationsData = _getAnnotationsData();
            var annotationXref = null;
            if (annotationsData[pageIdx]) {
                var ann = annotationsData[pageIdx].find(function (candidate) {
                    var annId = _h.resolveAnnotationIdentifierValue ? _h.resolveAnnotationIdentifierValue(candidate) : null;
                    return annId === stableIdentifier ||
                        String(candidate._tempXref || '') === stableIdentifier ||
                        String(candidate._tempIdentifier || '') === stableIdentifier;
                });
                if (ann) {
                    annotationXref = ann.xref;
                }
            }

            try {
                if (!_h.buildApiAnnotationIdentifier || !_h.deleteAnnotationRequest) {
                    throw new Error('Annotation delete helpers are unavailable.');
                }
                var apiIdentifier = _h.buildApiAnnotationIdentifier({
                    identifier: stableIdentifier,
                    xref: annotationXref ? String(annotationXref) : null,
                    requestId: null,
                });
                if (!apiIdentifier) {
                    return Promise.resolve();
                }

                var data = await _h.deleteAnnotationRequest(apiIdentifier);
                if (data.success) {
                    if (annotationsData[pageIdx]) {
                        var removalIdx = _h.findAnnotationIndex ? _h.findAnnotationIndex(pageIdx, stableIdentifier) : -1;
                        if (removalIdx >= 0) {
                            annotationsData[pageIdx].splice(removalIdx, 1);
                        }
                    }
                    if (annotationXref) {
                        var markerKey = _buildVisibilityKey(pageIdx, {
                            xref: annotationXref,
                            identifier: stableIdentifier,
                        });
                        if (markerKey) {
                            _visibleMarkers.delete(markerKey);
                        }

                        var markerSelector = '[data-annotation-xref="' + annotationXref + '"][data-annotation-page="' + pageIdx + '"]';
                        var marker = document.querySelector(markerSelector);
                        if (marker) {
                            unobserveAnnotationMarker(marker);
                        }
                    }
                    markLocalChange();
                    _renderAfterMutation();
                }
            } catch (error) {
                console.error('[ANNOTATION-CTRL] Error deleting temporary annotation:', error);
            }
            return Promise.resolve();
        }

        // -----------------------------------------------------------------
        // Public API
        // -----------------------------------------------------------------
        var handle = {
            // --- CRUD helpers (from absorbed annotation-crud.js) ---
            VALID_PRIORITIES: VALID_PRIORITIES,
            PLACEHOLDER_STRINGS: PLACEHOLDER_STRINGS,
            isMarkupType: isMarkupType,
            isValidPriority: isValidPriority,
            isPlaceholderContent: isPlaceholderContent,
            shouldDeleteInsteadOfSave: shouldDeleteInsteadOfSave,
            buildAnnotationUrl: buildAnnotationUrl,
            buildAnnotationsListUrl: buildAnnotationsListUrl,
            buildContentUpdateBody: buildContentUpdateBody,
            buildPriorityUpdateBody: buildPriorityUpdateBody,
            buildPositionUpdateBody: buildPositionUpdateBody,
            buildCreateAnnotationBody: buildCreateAnnotationBody,
            buildDrawingCreateBody: buildDrawingCreateBody,
            buildTextboxCreateBody: buildTextboxCreateBody,
            buildPointsUpdateBody: buildPointsUpdateBody,
            buildDeleteUndoOperation: buildDeleteUndoOperation,
            buildCreateUndoOperation: buildCreateUndoOperation,
            buildUpdateUndoOperation: buildUpdateUndoOperation,
            setButtonLoading: setButtonLoading,
            storeButtonOriginalText: storeButtonOriginalText,
            parseAnnotationResponse: parseAnnotationResponse,
            hasBeenEdited: hasBeenEdited,
            isTemporary: isTemporary,
            enhanceAfterSave: enhanceAfterSave,

            // --- Undo ---
            pushUndoOperation: pushUndoOperation,
            getUndoStack: getUndoStack,
            peekUndoOperation: peekUndoOperation,
            popUndoOperation: popUndoOperation,
            clearUndoStack: clearUndoStack,
            persistHighlightExtend: persistHighlightExtend,
            performHighlightExtendUndo: performHighlightExtendUndo,

            // --- Polling ---
            markLocalChange: markLocalChange,
            startPolling: startPolling,
            stopPolling: stopPolling,

            // --- Visibility ---
            getVisibleMarkers: getVisibleMarkers,
            isObserverInitialized: isObserverInitialized,
            addVisibleMarker: addVisibleMarker,
            removeVisibleMarker: removeVisibleMarker,
            clearVisibleMarkers: clearVisibleMarkers,
            syncVisibleMarkersFromDom: syncVisibleMarkersFromDom,
            initializeAnnotationObserver: initializeAnnotationObserver,
            observeAnnotationMarker: observeAnnotationMarker,
            unobserveAnnotationMarker: unobserveAnnotationMarker,

            // --- Selection ---
            highlightSelection: highlightSelection,
            selectAnnotation: function (id, pageIdx) {
                if (_destroyed) return;
                highlightSelection(pageIdx, id);
            },

            // --- High-level delegation methods ---
            loadAnnotations: loadAnnotations,
            reload: function () {
                if (_destroyed) return Promise.resolve();
                return handle.loadAnnotations();
            },
            renderSidebar: renderSidebar,
            renderList: function () {
                if (_destroyed) return;
                renderSidebar();
            },
            renderAIList: function () {
                if (_destroyed) return;
                if (_h.renderAIAnnotationsList) {
                    _h.renderAIAnnotationsList();
                }
            },
            beginEdit: beginEdit,
            cancelAnnotationEdit: function (pageIdx, identifier) {
                if (_destroyed) return Promise.resolve();
                return cancelAnnotationEdit(pageIdx, identifier);
            },
            createTemporaryAnnotation: createTemporaryAnnotation,
            saveAnnotationEdit: saveAnnotationEdit,
            deleteAnnotation: deleteAnnotation,
            deleteAnnotationSilently: deleteAnnotationSilently,
            revertAnnotationToAi: function (pageIdx, identifier, sourceButton) {
                if (_destroyed) return Promise.resolve();
                return _revertAnnotationToAi(pageIdx, identifier, sourceButton);
            },

            // --- State accessors ---
            getSavingAnnotationId: getSavingAnnotationId,
            setSavingAnnotationId: setSavingAnnotationId,
            getUpdatingPriorityId: getUpdatingPriorityId,
            setUpdatingPriorityId: setUpdatingPriorityId,
            getIsDragging: getIsDragging,
            setIsDragging: setIsDragging,
            getInlineEditingLabel: getInlineEditingLabel,
            setInlineEditingLabel: setInlineEditingLabel,
            getCurrentAnnotationsPage: getCurrentAnnotationsPage,
            setCurrentAnnotationsPage: setCurrentAnnotationsPage,

            // --- Events ---
            onAnnotationsChanged: function (fn) { _on('onAnnotationsChanged', fn); },
            onAnnotationsLoaded: function (fn) { _on('onAnnotationsLoaded', fn); },
            onSelectionChanged: function (fn) { _on('onSelectionChanged', fn); },
            onEditingChanged: function (fn) { _on('onEditingChanged', fn); },
            onAnnotationCreated: function (fn) { _on('onAnnotationCreated', fn); },
            onAnnotationDeleted: function (fn) { _on('onAnnotationDeleted', fn); },
            onAnnotationUpdated: function (fn) { _on('onAnnotationUpdated', fn); },
            onRenderListNeeded: function (fn) { _on('onRenderListNeeded', fn); },
            onRenderOverlaysNeeded: function (fn) { _on('onRenderOverlaysNeeded', fn); },
            onScheduleUpdate: function (fn) { _on('onScheduleUpdate', fn); },

            // --- Emit (for monolith to call into) ---
            emitAnnotationsChanged: function (data) { _emit('onAnnotationsChanged', data); },
            emitAnnotationsLoaded: function (data) {
                _syncAnnotationsState({ annotationsData: _getAnnotationsData() });
                _emit('onAnnotationsLoaded', data);
            },
            emitSelectionChanged: function (data) { _emit('onSelectionChanged', data); },
            emitEditingChanged: function (data) { _emit('onEditingChanged', data); },
            emitAnnotationCreated: function (data) { _emit('onAnnotationCreated', data); },
            emitAnnotationDeleted: function (data) { _emit('onAnnotationDeleted', data); },
            emitAnnotationUpdated: function (data) { _emit('onAnnotationUpdated', data); },
            emitRenderListNeeded: function () { _emit('onRenderListNeeded', {}); },
            emitRenderOverlaysNeeded: function (data) { _emit('onRenderOverlaysNeeded', data); },
            emitScheduleUpdate: function () { _emit('onScheduleUpdate', {}); },

            // --- Destroy ---
            destroy: function () {
                if (_destroyed) return;
                _destroyed = true;

                // Stop polling
                stopPolling();

                // Clear undo stack
                _undoStack = [];
                _isUndoing = false;
                _syncAnnotationsState({
                    undoStack: [],
                    selectedId: null,
                    editingId: null,
                    annotationsData: {},
                });

                // Clear inline editing
                _inlineEditingLabel = null;
                _savingAnnotationId = null;
                _updatingPriorityId = null;
                _isDraggingAnnotation = false;

                // Disconnect observer
                if (_annotationObserver) {
                    _annotationObserver.disconnect();
                    _annotationObserver = null;
                }
                var gradedContainer = _getGradedContainer();
                if (gradedContainer && _annotationVisibilityScrollHandler) {
                    gradedContainer.removeEventListener('scroll', _annotationVisibilityScrollHandler);
                }
                _annotationVisibilityScrollHandler = null;
                _visibleMarkers.clear();
                _observerInitialized = false;

                // Cancel pending frame
                if (_pendingListFrame !== null) {
                    cancelAnimationFrame(_pendingListFrame);
                    _pendingListFrame = null;
                }

                // Clear callbacks
                Object.keys(_callbacks).forEach(function (key) {
                    _callbacks[key] = [];
                });
            },
        };

        return handle;
    }

    // =========================================================================
    // Export
    // =========================================================================

    exports.createAnnotationController = createAnnotationController;

    // Also expose CRUD helpers directly on the controller namespace for
    // consumers that want the helpers without creating a controller instance.
    exports.VALID_PRIORITIES = VALID_PRIORITIES;
    exports.PLACEHOLDER_STRINGS = PLACEHOLDER_STRINGS;
    exports.isMarkupType = isMarkupType;
    exports.isValidPriority = isValidPriority;
    exports.isPlaceholderContent = isPlaceholderContent;
    exports.buildAnnotationUrl = buildAnnotationUrl;
    exports.buildAnnotationsListUrl = buildAnnotationsListUrl;
    exports.buildContentUpdateBody = buildContentUpdateBody;
    exports.buildPriorityUpdateBody = buildPriorityUpdateBody;
    exports.buildPositionUpdateBody = buildPositionUpdateBody;
    exports.buildCreateAnnotationBody = buildCreateAnnotationBody;
    exports.buildDrawingCreateBody = buildDrawingCreateBody;
    exports.buildTextboxCreateBody = buildTextboxCreateBody;
    exports.buildPointsUpdateBody = buildPointsUpdateBody;
    exports.hasBeenEdited = hasBeenEdited;
    exports.isTemporary = isTemporary;

})(window.PdfPreviewModalAnnotationController, window.PdfPreviewModalCrud);

// AEMS namespace integration
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.crud = window.PdfPreviewModalCrud;
window.AEMS.pdfPreview.annotationController = window.PdfPreviewModalAnnotationController;
