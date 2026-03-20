/**
 * PDF Preview Modal - Overlay Renderer
 *
 * Stateless page-overlay rendering: places annotation markers and labels onto
 * PDF pages.  Receives annotation data through accessor callbacks and emits
 * events for user interactions (click, dblclick on markers / empty overlay
 * space) so the composition root can wire them without coupling.
 *
 * @module pdf-preview-modal/overlay-renderer
 */
window.PdfPreviewModalOverlayRenderer = window.PdfPreviewModalOverlayRenderer || {};

(function (exports) {
    'use strict';

    var UtilsModule = window.PdfPreviewModalUtils || {};
    var debugLog = UtilsModule.debugLog || function () {};

    // Read rendering constants from the shared module (avoid magic numbers)
    var RenderingModule = window.PdfPreviewModalRendering || {};
    var TEXT_ICON_SIZE = RenderingModule.TEXT_ICON_SIZE || 22;
    var MIN_MARKER_SIZE = RenderingModule.MIN_MARKER_SIZE || 16;
    var convertTopLeftRectToViewport = RenderingModule.convertTopLeftRectToViewport || function (rect) { return rect; };

    /**
     * Create an overlay renderer.
     *
     * @param {Object} options
     * @param {Function} options.getAnnotationsData   - () => annotationsData object
     * @param {Function} options.getSelectedAnnotation - () => { pageIdx, identifier }
     * @param {Object}   options.helpers               - bag of helper functions (see below)
     * @param {Object}   [options.capabilities]        - feature flags
     * @returns {Object} Overlay renderer handle
     */
    function createOverlayRenderer(options) {
        options = options || {};

        var _helpers = options.helpers || {};
        var _capabilities = options.capabilities || {};
        var _getAnnotationsData = options.getAnnotationsData || function () { return {}; };
        var _getSelectedAnnotation = options.getSelectedAnnotation || function () { return { pageIdx: null, identifier: null }; };

        // Destructure helpers for convenience
        var normalizeAnnotationIdentifierValue = _helpers.normalizeAnnotationIdentifierValue || function (v) { return v; };
        var resolveAnnotationIdParts = _helpers.resolveAnnotationIdParts || function (p) { return p; };
        var resolveAnnotationIdentifierValue = _helpers.resolveAnnotationIdentifierValue || function (_e) { return ''; };
        var deriveAnnotationPriority = _helpers.deriveAnnotationPriority || function () { return 'green'; };
        var resolveAnnotationSource = _helpers.resolveAnnotationSource || function () { return 'AI'; };
        var isPlaceholderAnnotation = _helpers.isPlaceholderAnnotation || function () { return false; };
        var isMarkupType = _helpers.isMarkupType || function () { return false; };
        var renderCompactInlineLabelContent = _helpers.renderCompactInlineLabelContent || function () {};
        var positionLabelOptimally = _helpers.positionLabelOptimally || function () {};
        var repositionAllLabels = _helpers.repositionAllLabels || function () {};
        var setupLabelTooltipEvents = _helpers.setupLabelTooltipEvents || function () {};
        var buildDisplayOrderByPagePosition = _helpers.buildDisplayOrderByPagePosition || function () { return {}; };
        var resolveDisplayOrderFromLookup = _helpers.resolveDisplayOrderFromLookup || function () { return 1; };
        var observeAnnotationMarker = _helpers.observeAnnotationMarker || function () {};
        var makeAnnotationDraggable = _helpers.makeAnnotationDraggable || function () {};
        var DrawingCanvas = _helpers.DrawingCanvas || null;

        // -----------------------------------------------------------------
        // Event system
        // -----------------------------------------------------------------
        var _callbacks = {
            onMarkerClicked: [],
            onMarkerDblClicked: [],
            onOverlayDblClicked: [],
            onOverlayReady: [],
        };
        var _destroyed = false;
        var _trackedOverlays = [];

        function _emit(name, data) {
            var list = _callbacks[name] || [];
            for (var i = 0; i < list.length; i++) {
                list[i](data);
            }
        }

        // -----------------------------------------------------------------
        // Core: render annotations for a single page
        // -----------------------------------------------------------------

        /**
         * Render annotation overlays for a specific page number (1-based).
         *
         * @param {number} pageNum - 1-based page number
         * @param {boolean} [forceRender=false] - Skip cache and re-render
         */
        function renderAnnotationsForPage(pageNum, forceRender) {
            if (_destroyed) return;
            forceRender = forceRender || false;

            // Validate pageNum
            if (!pageNum || isNaN(pageNum) || pageNum < 1) {
                debugLog('[OVERLAY] Invalid pageNum:', pageNum);
                return;
            }

            var viewer = window.__pdfGradedViewer;
            if (!viewer) return;

            var container = document.getElementById('pdfGradedContainer');
            var wrapper = container ? container.querySelector('.pdf-page-wrapper[data-page-num="' + pageNum + '"]') : null;
            if (!wrapper) return;

            var canvas = wrapper.querySelector('.pdf-page-canvas');
            var overlay = wrapper.querySelector('.pdf-annotation-overlay');
            if (!canvas || !overlay) return;

            var viewport = viewer.getViewportForPage(pageNum);
            if (!viewport) return;

            // pageNum is 1-based, annotationsData is 0-based
            var pageIdx = pageNum - 1;
            var annotationsData = _getAnnotationsData();
            var pageAnnotations = annotationsData[pageIdx] || [];
            var displayOrderByPagePosition = buildDisplayOrderByPagePosition(pageAnnotations);

            // Optimization: check if markers already match (skip unnecessary re-creation)
            if (!forceRender) {
                var existingMarkers = overlay.querySelectorAll('.annotation-marker');
                var existingXrefs = Array.from(existingMarkers).map(function (m) { return m.dataset.annotationXref; }).sort();
                var expectedXrefs = pageAnnotations.map(function (ann) { return String(ann.xref); }).sort();

                if (existingMarkers.length === pageAnnotations.length &&
                    JSON.stringify(existingXrefs) === JSON.stringify(expectedXrefs)) {
                    // Only skip if the double-click handler is also set up
                    if (overlay._dblclickHandler) {
                        return;
                    }
                    // Otherwise fall through to set up handler even though markers match
                }
            }

            // Clear existing annotations in this overlay
            overlay.innerHTML = '';

            var canvasRect = canvas.getBoundingClientRect();
            var canvasWidth = canvas.clientWidth || canvasRect.width;
            var canvasHeight = canvas.clientHeight || canvasRect.height;

            if (!canvasWidth || !canvasHeight) {
                overlay.style.pointerEvents = 'auto';
                return;
            }

            overlay.style.pointerEvents = 'none';

            var scaleX = canvasWidth / viewport.width;
            var scaleY = canvasHeight / viewport.height;

            overlay.style.pointerEvents = 'auto';

            pageAnnotations.forEach(function (ann) {
                // Skip drawing and textbox annotations from marker rendering
                if (isMarkupType(ann.type)) {
                    return;
                }

                // Filter out stuck placeholder comments
                var isPlaceholder = isPlaceholderAnnotation(ann);
                var hasBeenEdited = ann._hasBeenEdited === true || ann._priorityChanged === true;
                if (isPlaceholder && !ann._isTemporary && !hasBeenEdited) {
                    return;
                }

                var rect = ann.rect;
                if (!Array.isArray(rect) || rect.length !== 4) return;

                var viewportRect = convertTopLeftRectToViewport(rect, viewport);

                var minX = Math.min(viewportRect[0], viewportRect[2]);
                var maxX = Math.max(viewportRect[0], viewportRect[2]);
                var minY = Math.min(viewportRect[1], viewportRect[3]);
                var maxY = Math.max(viewportRect[1], viewportRect[3]);

                // Page-relative coordinates
                var containerX0 = minX * scaleX;
                var containerY0 = minY * scaleY;
                var markerWidth = Math.max((maxX - minX) * scaleX, MIN_MARKER_SIZE);
                var markerHeight = Math.max((maxY - minY) * scaleY, MIN_MARKER_SIZE);

                var xrefString = normalizeAnnotationIdentifierValue(
                    typeof ann.xref === 'number' ? String(ann.xref) : ann.xref
                ) || '';
                var stableId = normalizeAnnotationIdentifierValue(
                    ann.id || ann.identifier || ann.stable_id || ann.name || ann.title
                ) || '';

                // Prefer stable ID for API and list lookups; fall back to xref
                var resolvedIds = resolveAnnotationIdParts({
                    xref: xrefString,
                    requestId: ann.requestIdentifier,
                    identifier: stableId || resolveAnnotationIdentifierValue(ann),
                });
                var requestId = resolvedIds.stableId || resolvedIds.xref || '';
                var displayIdentifier = requestId || ('marker-' + pageIdx + '-' + (xrefString || 'unknown'));
                var displayIndexOnPage = resolveDisplayOrderFromLookup(ann, displayOrderByPagePosition) || 1;
                var annotationNumber = (pageIdx + 1) + '.' + displayIndexOnPage;

                var annotationType = (ann.type || '').toLowerCase();

                if (annotationType === 'text') {
                    markerWidth = TEXT_ICON_SIZE;
                    markerHeight = TEXT_ICON_SIZE;
                }

                var marker = document.createElement('div');
                marker.className = 'annotation-marker';

                // Add source class for AI/Human styling
                var source = resolveAnnotationSource(ann);
                var sourceClass = source === 'AI' ? 'source-ai' : 'source-human';
                marker.classList.add(sourceClass);
                marker.dataset.annotationSource = source;

                // Use 0-based pageIdx for consistency with API
                marker.dataset.annotationPage = pageIdx;
                marker.dataset.annotationXref = ann.xref || '';
                marker.dataset.annotationRequestId = requestId;
                marker.dataset.annotationStableId = stableId;
                marker.dataset.annotationIdentifier = displayIdentifier;
                marker.dataset.annotationType = annotationType;
                marker.dataset.annotationNumber = annotationNumber;

                if (!ann.xref) {
                    console.error('[CREATE-MARKER] CRITICAL: ann.xref is null/undefined!');
                    console.error('[CREATE-MARKER] Full annotation object:', ann);
                }

                // Position using page-relative coordinates
                marker.style.position = 'absolute';
                marker.style.left = containerX0 + 'px';
                marker.style.top = containerY0 + 'px';
                marker.style.width = markerWidth + 'px';
                marker.style.height = markerHeight + 'px';
                marker.style.pointerEvents = 'auto';
                marker.style.cursor = 'pointer';
                marker.style.zIndex = '10';

                // Determine priority from annotation data
                var priority = deriveAnnotationPriority(ann);

                // Convert priority to RGB (0-255)
                var r, g, b;
                if (priority === 'red') {
                    r = 255; g = 0; b = 0;
                } else if (priority === 'amber') {
                    r = 255; g = 165; b = 0;
                } else {
                    r = 0; g = 200; b = 0;
                }

                // Subtle highlight
                marker.style.border = 'none';
                marker.style.backgroundColor = 'rgba(' + r + ', ' + g + ', ' + b + ', 0.25)';
                marker.style.backgroundImage = 'none';
                marker.style.boxShadow = 'none';
                marker.style.borderRadius = '2px';
                marker.style.cursor = 'move';

                // Line-style cues for non-text annotations
                if (annotationType === 'underline') {
                    marker.style.borderTop = 'none';
                    marker.style.borderLeft = 'none';
                    marker.style.borderRight = 'none';
                    marker.style.borderBottomWidth = '2px';
                    marker.style.borderBottomColor = 'rgba(' + r + ', ' + g + ', ' + b + ', 0.7)';
                } else if (annotationType === 'squiggly') {
                    marker.style.borderTop = 'none';
                    marker.style.borderLeft = 'none';
                    marker.style.borderRight = 'none';
                    marker.style.borderBottom = '2px wavy rgba(' + r + ', ' + g + ', ' + b + ', 0.7)';
                } else if (annotationType === 'strikeout') {
                    marker.style.textDecoration = 'line-through';
                    marker.style.textDecorationColor = 'rgba(' + r + ', ' + g + ', ' + b + ', 0.7)';
                    marker.style.textDecorationThickness = '2px';
                }

                // Label with comment preview
                var label = document.createElement('div');
                label.className = 'annotation-label';
                var labelColor = 'white';
                var leftBarColor = 'rgba(' + r + ', ' + g + ', ' + b + ', 1)';
                var numberColor = 'rgba(' + r + ', ' + g + ', ' + b + ', 0.62)';
                var labelBg = 'rgba(40, 40, 40, 0.64)';
                label.dataset.labelBg = labelBg;

                label.style.cssText =
                    'position: absolute;' +
                    'top: 100%;' +
                    'left: 100%;' +
                    'background: ' + labelBg + ';' +
                    'color: ' + labelColor + ';' +
                    'padding: 3px 8px 3px 10px;' +
                    'border-radius: 3px;' +
                    'font-size: 12px;' +
                    'font-weight: 600;' +
                    'white-space: nowrap;' +
                    'pointer-events: auto;' +
                    'margin-top: 0;' +
                    'max-width: 180px;' +
                    'overflow: visible;' +
                    'text-overflow: ellipsis;' +
                    'box-shadow: 0 2px 8px rgba(0,0,0,0.35);' +
                    'border: 1px solid rgba(255,255,255,0.12);' +
                    'display: block;' +
                    'cursor: pointer;' +
                    'transition: background 0.2s ease, transform 0.1s ease;' +
                    'border-left: 4px solid ' + leftBarColor + ';' +
                    '--annotation-number-color: ' + numberColor + ';' +
                    'transform: translate(2px, 2px);';

                // Hover effects
                label.addEventListener('mouseenter', function () {
                    label.style.background = 'rgba(40, 40, 40, 0.8)';
                    var baseTransform = label.dataset.baseTransform || 'translate(2px, 2px)';
                    label.style.transform = baseTransform + ' scale(1.05)';
                });
                label.addEventListener('mouseleave', function () {
                    label.style.background = label.dataset.labelBg || labelBg;
                    label.style.transform = label.dataset.baseTransform || 'translate(2px, 2px)';
                });

                var commentText = ann.content || 'Click to edit';
                renderCompactInlineLabelContent(label, annotationNumber, commentText);

                // Store data attributes on marker for tooltip access
                marker.dataset.pageIdx = pageIdx;
                marker.dataset.identifier = requestId || displayIdentifier;

                marker.appendChild(label);

                // Smart positioning
                setTimeout(function () { positionLabelOptimally(marker, label, overlay); }, 0);

                // Setup tooltip
                setupLabelTooltipEvents(label, commentText);

                // Marker click -> emit event (instead of calling highlightAnnotationSelection)
                marker.addEventListener('click', (function (pIdx, ident) {
                    return function () {
                        _emit('onMarkerClicked', { pageIdx: pIdx, identifier: ident });
                    };
                })(pageIdx, requestId || displayIdentifier));

                // Marker dblclick -> emit event (instead of inline editing calls)
                marker.addEventListener('dblclick', (function (pIdx, ident, domLabel) {
                    return function (e) {
                        // Prevent double-handling if click was on the label
                        if (e.target.classList.contains('annotation-label') || e.target.closest('.annotation-label')) {
                            return;
                        }
                        _emit('onMarkerDblClicked', {
                            pageIdx: pIdx,
                            identifier: ident,
                            label: domLabel,
                        });
                    };
                })(pageIdx, displayIdentifier, label));

                makeAnnotationDraggable(marker, requestId || displayIdentifier);
                overlay.appendChild(marker);

                // Observe marker for visibility changes
                observeAnnotationMarker(marker);
            });

            // Second pass: reposition all labels to avoid overlaps
            setTimeout(function () {
                repositionAllLabels(overlay);
                setTimeout(function () { repositionAllLabels(overlay); }, 50);
            }, 10);

            // Add double-click handler for creating new annotations on empty space
            _setupOverlayDoubleClickHandler(overlay, viewport, scaleX, scaleY, pageIdx);

            // Ensure drawing canvas overlay exists for markup tools
            if (DrawingCanvas) {
                DrawingCanvas.ensureCanvasForPage(pageIdx, wrapper);
            }

            // Re-apply highlight to selected annotation marker after re-render
            var sel = _getSelectedAnnotation();
            if (sel.identifier && sel.pageIdx === pageIdx) {
                requestAnimationFrame(function () {
                    var selStableId = sel.identifier;
                    overlay.querySelectorAll('.annotation-marker').forEach(function (m) {
                        var markerId = normalizeAnnotationIdentifierValue(
                            m.dataset.annotationRequestId ||
                            m.dataset.annotationIdentifier ||
                            m.dataset.annotationXref
                        );
                        var markerPage = parseInt(m.dataset.annotationPage);
                        if (markerId === selStableId && markerPage === pageIdx) {
                            m.style.outline = '3px solid #0d6efd';
                            m.style.outlineOffset = '2px';
                            m.classList.add('annotation-marker-selected');
                        }
                    });
                });
            }

            // Emit overlay-ready event
            _emit('onOverlayReady', { pageIdx: pageIdx });
        }

        // -----------------------------------------------------------------
        // Overlay double-click handler (creates annotations on empty space)
        // -----------------------------------------------------------------

        function _setupOverlayDoubleClickHandler(overlay, viewport, scaleX, scaleY, pageIdx) {
            // Gate behind annotationCrud capability
            if (_capabilities.annotationCrud === false) return;

            // Remove existing handler if any
            if (overlay._dblclickHandler) {
                overlay.removeEventListener('dblclick', overlay._dblclickHandler);
            }

            var handler = function (e) {
                // Check if click was on a marker (not empty space)
                if (e.target.classList.contains('annotation-marker') ||
                    e.target.closest('.annotation-marker')) {
                    return;
                }

                // Get click position relative to overlay
                var overlayRect = overlay.getBoundingClientRect();
                var clickX = e.clientX - overlayRect.left;
                var clickY = e.clientY - overlayRect.top;

                // Convert to viewport coordinates
                var viewportX = clickX / scaleX;
                var viewportY = clickY / scaleY;

                var pdfViewer = window.__pdfGradedViewer;
                if (!pdfViewer || !pdfViewer.pdf) {
                    return;
                }

                var pdfPoint;
                try {
                    pdfPoint = viewport.convertToPdfPoint(viewportX, viewportY);
                } catch (_convErr) {
                    debugLog('convertToPdfPoint not available, using manual conversion');
                    try {
                        var pageNum = pageIdx + 1;
                        // We need to get the page synchronously for fallback
                        // but getPage is async — use a Promise-based approach
                        pdfViewer.pdf.getPage(pageNum).then(function (page) {
                            var pageRect = page.view || [0, 0, 612, 792];
                            var fallbackPoint = [
                                (viewportX / viewport.width) * (pageRect[2] - pageRect[0]),
                                (pageRect[3] - pageRect[1]) - (viewportY / viewport.height) * (pageRect[3] - pageRect[1])
                            ];
                            _emitOverlayDblClick(fallbackPoint, viewport, scaleX, scaleY, pageIdx);
                        }).catch(function (error) {
                            console.error('[OVERLAY] Error getting page for double-click', error);
                        });
                        return; // Async path — event will be emitted from callback
                    } catch (error) {
                        console.error('[OVERLAY] Error getting page for double-click', error);
                        return;
                    }
                }

                _emitOverlayDblClick(pdfPoint, viewport, scaleX, scaleY, pageIdx);
            };

            overlay.addEventListener('dblclick', handler);
            overlay._dblclickHandler = handler;

            // Track for cleanup in destroy()
            if (_trackedOverlays.indexOf(overlay) === -1) {
                _trackedOverlays.push(overlay);
            }
        }

        function _emitOverlayDblClick(pdfPoint, viewport, scaleX, scaleY, pageIdx) {
            // Create annotation rect centered at click point
            var pdfIconWidth = TEXT_ICON_SIZE / scaleX / viewport.scale;
            var pdfIconHeight = TEXT_ICON_SIZE / scaleY / viewport.scale;

            var newRect = [
                pdfPoint[0] - pdfIconWidth / 2,
                pdfPoint[1] - pdfIconHeight / 2,
                pdfPoint[0] + pdfIconWidth / 2,
                pdfPoint[1] + pdfIconHeight / 2
            ];

            _emit('onOverlayDblClicked', { rect: newRect, pageIdx: pageIdx });
        }

        // -----------------------------------------------------------------
        // renderAllAnnotations — iterate over all rendered pages
        // -----------------------------------------------------------------

        function renderAllAnnotations(forceRender) {
            if (_destroyed) return;
            forceRender = forceRender || false;

            var viewer = window.__pdfGradedViewer;
            if (!viewer || !viewer.isGradedViewer) {
                debugLog('[OVERLAY] renderAllAnnotations called on non-graded viewer');
                return;
            }

            viewer.renderedPages.forEach(function (pageNum) {
                renderAnnotationsForPage(pageNum, forceRender);
            });
        }

        // -----------------------------------------------------------------
        // scrollToAnnotationMarker
        // -----------------------------------------------------------------

        function scrollToAnnotationMarker(pageIdx, identifier) {
            if (_destroyed) return;

            var marker = document.querySelector(
                '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-identifier="' + identifier + '"]'
            ) || document.querySelector(
                '.annotation-marker[data-annotation-page="' + pageIdx + '"][data-annotation-xref="' + identifier + '"]'
            );

            if (marker) {
                marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
                marker.classList.add('ownership-transferred');
                setTimeout(function () { marker.classList.remove('ownership-transferred'); }, 1000);
            } else {
                var gc = document.getElementById('pdfGradedContainer');
                var pageWrapper = gc ? gc.querySelector('.pdf-page-wrapper[data-page-num="' + (pageIdx + 1) + '"]') : null;
                if (pageWrapper) {
                    pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        }

        // -----------------------------------------------------------------
        // Public API
        // -----------------------------------------------------------------

        return {
            // Event subscriptions
            onMarkerClicked: function (cb) { _callbacks.onMarkerClicked.push(cb); },
            onMarkerDblClicked: function (cb) { _callbacks.onMarkerDblClicked.push(cb); },
            onOverlayDblClicked: function (cb) { _callbacks.onOverlayDblClicked.push(cb); },
            onOverlayReady: function (cb) { _callbacks.onOverlayReady.push(cb); },

            // Rendering
            renderPage: function (pageNum, forceRender) { renderAnnotationsForPage(pageNum, forceRender); },
            renderAnnotations: function (forceRender) { renderAllAnnotations(forceRender); },

            // Navigation
            scrollToMarker: function (pageIdx, identifier) { scrollToAnnotationMarker(pageIdx, identifier); },

            // Placeholders for future extraction
            renderSplitPanel: function () { /* placeholder */ },
            renderSearchHighlights: function () { /* placeholder */ },

            // Lifecycle
            destroy: function () {
                _destroyed = true;

                // Remove dblclick handlers and clear overlay DOM
                for (var i = 0; i < _trackedOverlays.length; i++) {
                    var ov = _trackedOverlays[i];
                    if (ov._dblclickHandler) {
                        ov.removeEventListener('dblclick', ov._dblclickHandler);
                        delete ov._dblclickHandler;
                    }
                    ov.innerHTML = '';
                }
                _trackedOverlays = [];

                _callbacks.onMarkerClicked = [];
                _callbacks.onMarkerDblClicked = [];
                _callbacks.onOverlayDblClicked = [];
                _callbacks.onOverlayReady = [];
            },
        };
    }

    exports.createOverlayRenderer = createOverlayRenderer;

})(window.PdfPreviewModalOverlayRenderer);
