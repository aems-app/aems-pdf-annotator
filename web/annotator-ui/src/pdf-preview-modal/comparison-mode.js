/**
 * PDF Preview Modal - A/B Comparison Mode
 *
 * Provides comparison mode functionality for viewing annotations from
 * two different models (Model A and Model B) on a single PDF.
 *
 * This module is part of the A/B Comparison View feature.
 *
 * @module pdf-preview-modal/comparison-mode
 */

// Namespace for PDF Preview Modal comparison mode
window.PdfPreviewModalComparison = window.PdfPreviewModalComparison || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Utility References (use AEMS.utils if available)
    // =========================================================================

    /**
     * Get escapeHtml utility from AEMS.utils or use local fallback
     * @returns {Function}
     */
    function getEscapeHtml() {
        if (window.AEMS && window.AEMS.utils && typeof window.AEMS.utils.escapeHtml === 'function') {
            return window.AEMS.utils.escapeHtml;
        }
        // Fallback implementation
        return function escapeHtml(text) {
            if (text == null) return '';
            var div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        };
    }

    var escapeHtml = getEscapeHtml();

    function getEscapeCssAttribute() {
        var UtilsModule = window.PdfPreviewModalUtils || {};
        if (typeof UtilsModule.escapeCssAttribute === 'function') {
            return UtilsModule.escapeCssAttribute;
        }
        return function escapeCssAttribute(value) {
            var text = String(value);
            if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
                return CSS.escape(text);
            }
            return text.replace(/(["\\])/g, '\\$1');
        };
    }

    var escapeCssAttribute = getEscapeCssAttribute();

    /**
     * Attribute-context escaper. escapeHtml() (textContent -> innerHTML) does NOT
     * escape quotes, so it is unsafe inside double-quoted attributes; this also
     * encodes " and ' to prevent attribute-injection DOM XSS.
     * @returns {Function}
     */
    function getEscapeHtmlAttribute() {
        var UtilsModule = window.PdfPreviewModalUtils || {};
        if (typeof UtilsModule.escapeHtmlAttribute === 'function') {
            return UtilsModule.escapeHtmlAttribute;
        }
        return function escapeHtmlAttribute(value) {
            if (value == null) return '';
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        };
    }

    var escapeHtmlAttribute = getEscapeHtmlAttribute();

    function normalizePageNumber(value) {
        var page = Number(value);
        return Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
    }

    // =========================================================================
    // Comparison Mode State
    // =========================================================================

    /**
     * Whether comparison mode is currently active
     * @type {boolean}
     */
    exports.comparisonModeActive = false;

    /**
     * Comparison data from API
     * @type {Object|null}
     */
    exports.comparisonData = null;

    /**
     * Model A visibility state
     * @type {boolean}
     */
    exports.modelAVisible = true;

    /**
     * Model B visibility state
     * @type {boolean}
     */
    exports.modelBVisible = true;

    /**
     * Current page number (1-indexed)
     * @type {number}
     */
    exports.currentPage = 1;

    /**
     * Total page count
     * @type {number}
     */
    exports.totalPages = 1;

    // =========================================================================
    // DOM Element References
    // =========================================================================

    /**
     * Get the modal element
     * @returns {HTMLElement|null}
     */
    function getModalEl() {
        return document.getElementById('pdfPreviewModal');
    }

    // =========================================================================
    // Comparison Mode Entry/Exit
    // =========================================================================

    /**
     * Initialize comparison mode with A/B test data.
     * Called from wizard when comparison modal should open.
     *
     * @param {Object} data - Comparison data from API
     * @param {string} data.model_a - Model A name
     * @param {string} data.model_b - Model B name
     * @param {Object} data.result_a - Model A grading result
     * @param {Object} data.result_b - Model B grading result
     * @param {Object} data.comparison - Comparison metrics
     * @param {string} data.pdf_url - URL to the submission PDF
     * @returns {boolean} True if successfully initialized, false otherwise
     */
    exports.openComparisonMode = function openComparisonMode(data) {
        const modalEl = getModalEl();
        if (!modalEl) {
            console.error('[Comparison Mode] PDF Preview Modal not found');
            return false;
        }

        // Validate required data
        if (!data || typeof data !== 'object') {
            console.error('[Comparison Mode] Invalid comparison data provided');
            return false;
        }

        // Validate PDF URL exists
        const pdfUrl = data.pdf_url || data.submission_pdf_url;
        if (!pdfUrl) {
            console.error('[Comparison Mode] No PDF URL provided in comparison data');
            return false;
        }

        exports.comparisonModeActive = true;
        exports.modelAVisible = true;
        exports.modelBVisible = true;
        exports.currentPage = 1;

        // Parse and store comparison data with validation
        exports.comparisonData = {
            comparisonId: data.comparison_id || null,
            modelAName: data.model_a || 'Model A',
            modelBName: data.model_b || 'Model B',
            annotationsA: (data.result_a && Array.isArray(data.result_a.feedback_items))
                ? data.result_a.feedback_items
                : [],
            annotationsB: (data.result_b && Array.isArray(data.result_b.feedback_items))
                ? data.result_b.feedback_items
                : [],
            overlaps: (data.comparison && Array.isArray(data.comparison.overlaps))
                ? data.comparison.overlaps
                : [],
            agreementRate: (data.comparison && typeof data.comparison.agreement_rate === 'number')
                ? data.comparison.agreement_rate
                : 0,
            pdfUrl: pdfUrl,
            resultA: data.result_a || null,
            resultB: data.result_b || null
        };

        // Update data attributes
        modalEl.dataset.comparisonMode = 'true';
        modalEl.dataset.modelAName = exports.comparisonData.modelAName;
        modalEl.dataset.modelBName = exports.comparisonData.modelBName;

        // Add comparison-mode class
        modalEl.classList.add('comparison-mode');

        // Update UI labels
        updateModelLabels();
        updateAgreementBadge();

        // Show comparison header controls
        const headerControls = document.getElementById('comparisonHeaderControls');
        if (headerControls) {
            headerControls.classList.remove('d-none');
        }

        // Reset toggle checkboxes
        const toggleA = document.getElementById('toggleModelA');
        const toggleB = document.getElementById('toggleModelB');
        if (toggleA) toggleA.checked = true;
        if (toggleB) toggleB.checked = true;

        // Update modal title
        const studentSpan = document.getElementById('pdfPreviewStudent');
        if (studentSpan) {
            studentSpan.textContent = 'A/B Model Comparison';
        }

        // Wire up event listeners
        setupComparisonEventListeners();

        return true;
    };

    /**
     * Exit comparison mode and reset to normal state
     */
    exports.exitComparisonMode = function exitComparisonMode() {
        const modalEl = getModalEl();

        exports.comparisonModeActive = false;
        exports.comparisonData = null;
        exports.modelAVisible = true;
        exports.modelBVisible = true;

        if (modalEl) {
            modalEl.classList.remove('comparison-mode', 'hide-model-a', 'hide-model-b');
            modalEl.dataset.comparisonMode = 'false';
            modalEl.dataset.modelAName = '';
            modalEl.dataset.modelBName = '';
        }

        // Hide comparison header controls
        const headerControls = document.getElementById('comparisonHeaderControls');
        if (headerControls) {
            headerControls.classList.add('d-none');
        }

        // Clean up event listeners to prevent memory leaks
        cleanupComparisonEventListeners();

        // Clear comparison panels
        const panelA = document.getElementById('pdfModelACommentsList');
        const panelB = document.getElementById('pdfModelBCommentsList');

        const hideComparisonModelDetails = Boolean(window.__WIZARD_MODEL_CONFIG && window.__WIZARD_MODEL_CONFIG.hideLlmDetails);

        if (panelA) panelA.innerHTML = `<div class="text-muted small text-center p-3">${hideComparisonModelDetails ? 'Review A feedback' : 'Model A feedback'}</div>`;

        if (panelB) panelB.innerHTML = `<div class="text-muted small text-center p-3">${hideComparisonModelDetails ? 'Review B feedback' : 'Model B feedback'}</div>`;

        // Clear comparison markers from PDF overlays
        document.querySelectorAll('.annotation-marker.source-model-a, .annotation-marker.source-model-b, .annotation-marker.source-overlap')
            .forEach(m => m.remove());
    };

    // =========================================================================
    // UI Updates
    // =========================================================================

    /**
     * Update model name labels throughout the UI
     */
    function updateModelLabels() {
        if (!exports.comparisonData) return;

        const hideComparisonModelDetails = Boolean(window.__WIZARD_MODEL_CONFIG && window.__WIZARD_MODEL_CONFIG.hideLlmDetails);

        const elements = hideComparisonModelDetails
            ? {
                'modelALabel': 'Review A',
                'modelBLabel': 'Review B',
                'toggleModelALabel': 'Review A',
                'toggleModelBLabel': 'Review B'
            }
            : {
                'modelALabel': exports.comparisonData.modelAName,
                'modelBLabel': exports.comparisonData.modelBName,
                'toggleModelALabel': exports.comparisonData.modelAName,
                'toggleModelBLabel': exports.comparisonData.modelBName
            };

        for (const [id, text] of Object.entries(elements)) {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        }
    }

    /**
     * Update the agreement badge with current agreement rate
     */
    function updateAgreementBadge() {
        const badge = document.getElementById('comparisonAgreementBadge');
        if (!badge || !exports.comparisonData) return;

        const rate = exports.comparisonData.agreementRate;
        const percent = Math.round(rate * 100);

        badge.textContent = `${percent}% agreement`;
        badge.classList.remove('high-agreement', 'medium-agreement', 'low-agreement');

        if (percent >= 70) {
            badge.classList.add('high-agreement');
        } else if (percent >= 40) {
            badge.classList.add('medium-agreement');
        } else {
            badge.classList.add('low-agreement');
        }
    }

    /**
     * Toggle visibility of a model's annotations
     * @param {'A'|'B'} model - Which model to toggle
     */
    exports.toggleModelVisibility = function toggleModelVisibility(model) {
        const modalEl = getModalEl();
        if (!modalEl) return;

        if (model === 'A') {
            exports.modelAVisible = !exports.modelAVisible;
            modalEl.classList.toggle('hide-model-a', !exports.modelAVisible);
        } else {
            exports.modelBVisible = !exports.modelBVisible;
            modalEl.classList.toggle('hide-model-b', !exports.modelBVisible);
        }

        // Re-render annotations to update visibility
        exports.renderComparisonAnnotations();
    };

    // =========================================================================
    // Event Listeners
    // =========================================================================

    // Store event handler references for cleanup
    let _handleToggleA = null;
    let _handleToggleB = null;
    let _handleModalHidden = null;

    /**
     * Setup event listeners for comparison mode
     */
    function setupComparisonEventListeners() {
        const toggleA = document.getElementById('toggleModelA');
        const toggleB = document.getElementById('toggleModelB');
        const modalEl = getModalEl();

        // Create handler references (for later cleanup)
        _handleToggleA = () => exports.toggleModelVisibility('A');
        _handleToggleB = () => exports.toggleModelVisibility('B');
        _handleModalHidden = () => {
            if (exports.comparisonModeActive) {
                exports.exitComparisonMode();
            }
        };

        // Model visibility toggles
        if (toggleA) {
            // Remove any existing listener first
            if (toggleA._comparisonHandler) {
                toggleA.removeEventListener('change', toggleA._comparisonHandler);
            }
            toggleA._comparisonHandler = _handleToggleA;
            toggleA.addEventListener('change', _handleToggleA);
        }

        if (toggleB) {
            if (toggleB._comparisonHandler) {
                toggleB.removeEventListener('change', toggleB._comparisonHandler);
            }
            toggleB._comparisonHandler = _handleToggleB;
            toggleB.addEventListener('change', _handleToggleB);
        }

        // Exit comparison mode when modal is hidden
        if (modalEl && !modalEl._comparisonHiddenListenerAttached) {
            modalEl.addEventListener('hidden.bs.modal', _handleModalHidden);
            modalEl._comparisonHiddenListenerAttached = true;
            modalEl._comparisonHiddenHandler = _handleModalHidden;
        }
    }

    /**
     * Cleanup event listeners to prevent memory leaks
     */
    function cleanupComparisonEventListeners() {
        const toggleA = document.getElementById('toggleModelA');
        const toggleB = document.getElementById('toggleModelB');

        // Remove toggle listeners
        if (toggleA && toggleA._comparisonHandler) {
            toggleA.removeEventListener('change', toggleA._comparisonHandler);
            delete toggleA._comparisonHandler;
        }

        if (toggleB && toggleB._comparisonHandler) {
            toggleB.removeEventListener('change', toggleB._comparisonHandler);
            delete toggleB._comparisonHandler;
        }

        // Note: We keep the modal hidden listener attached because it's needed
        // to cleanup if modal is closed while in comparison mode. It's idempotent.

        // Clear handler references
        _handleToggleA = null;
        _handleToggleB = null;
    }

    // =========================================================================
    // Annotation Rendering
    // =========================================================================

    /**
     * Build a lookup set of feedback IDs that are part of overlaps
     * @returns {Set<string|number>}
     */
    function buildOverlapSet() {
        const overlapSet = new Set();
        if (!exports.comparisonData?.overlaps) return overlapSet;

        exports.comparisonData.overlaps.forEach(o => {
            if (o.feedback_a_id) overlapSet.add(o.feedback_a_id);
            if (o.feedback_b_id) overlapSet.add(o.feedback_b_id);
        });

        return overlapSet;
    }

    /**
     * Render comparison annotations on the current page
     */
    exports.renderComparisonAnnotations = function renderComparisonAnnotations() {
        if (!exports.comparisonModeActive || !exports.comparisonData) return;

        const currentPage = exports.currentPage;

        // Find all page overlays
        const overlays = document.querySelectorAll('.pdf-annotation-overlay');
        if (!overlays.length) {
            console.warn('[Comparison Mode] No annotation overlays found');
            return;
        }

        // Clear existing comparison markers from all overlays
        overlays.forEach(overlay => {
            overlay.querySelectorAll('.annotation-marker.source-model-a, .annotation-marker.source-model-b, .annotation-marker.source-overlap')
                .forEach(m => m.remove());
        });

        const overlapSet = buildOverlapSet();

        // Render Model A annotations for current page
        if (exports.modelAVisible) {
            exports.comparisonData.annotationsA
                .filter(ann => normalizePageNumber(ann.page) === currentPage)
                .forEach((ann, idx) => {
                    const isOverlap = overlapSet.has(ann.id);
                    createComparisonMarker(ann, 'A', isOverlap, idx);
                });
        }

        // Render Model B annotations for current page
        if (exports.modelBVisible) {
            exports.comparisonData.annotationsB
                .filter(ann => normalizePageNumber(ann.page) === currentPage)
                .forEach((ann, idx) => {
                    const isOverlap = overlapSet.has(ann.id);
                    createComparisonMarker(ann, 'B', isOverlap, idx);
                });
        }

        // Update panels
        renderComparisonPanels();
    };

    /**
     * Create a comparison marker on the PDF
     * @param {Object} ann - Annotation data
     * @param {'A'|'B'} model - Which model this annotation is from
     * @param {boolean} isOverlap - Whether this annotation overlaps with other model
     * @param {number} idx - Index for positioning fallback
     */
    function createComparisonMarker(ann, model, isOverlap, idx) {
        const page = normalizePageNumber(ann.page);
        const overlay = document.querySelector(`.pdf-page-wrapper[data-page="${page}"] .pdf-annotation-overlay`);
        if (!overlay) return;

        const marker = document.createElement('div');
        const sourceClass = isOverlap ? 'source-overlap' : `source-model-${model.toLowerCase()}`;
        marker.className = `annotation-marker ${sourceClass}`;
        marker.dataset.feedbackId = ann.id || `ann-${model}-${idx}`;
        marker.dataset.model = model;
        marker.style.pointerEvents = 'auto';
        marker.style.position = 'absolute';

        try {
            // Get overlay dimensions for coordinate conversion
            const overlayRect = overlay.getBoundingClientRect();
            if (!overlayRect || overlayRect.width === 0 || overlayRect.height === 0) {
                console.warn('[Comparison] Overlay has invalid dimensions, using fallback positioning');
                applyFallbackPosition(marker, model, idx);
                appendMarkerWithLabel(marker, ann, model, idx, overlay);
                return;
            }

            // Convert bbox to pixel coordinates
            const pixelRect = convertBboxToPixels(ann, overlayRect);

            if (pixelRect) {
                // Use nullish coalescing (??) to allow 0 values
                marker.style.left = `${pixelRect.x ?? 0}px`;
                marker.style.top = `${pixelRect.y ?? 0}px`;
                marker.style.width = `${pixelRect.width ?? 100}px`;
                marker.style.height = `${pixelRect.height ?? 20}px`;
            } else {
                // Fallback positioning
                applyFallbackPosition(marker, model, idx);
            }
        } catch (error) {
            console.error('[Comparison] Error positioning marker:', error);
            applyFallbackPosition(marker, model, idx);
        }

        appendMarkerWithLabel(marker, ann, model, idx, overlay);
    }

    /**
     * Convert bbox from various formats to pixel coordinates
     * API can return bbox as:
     * - Array: [x1, y1, x2, y2] in normalized coords (0-1)
     * - Object: {x0, y0, x1, y1} or {x, y, width, height}
     * @param {Object} ann - Annotation with bbox data
     * @param {DOMRect} overlayRect - Overlay dimensions for conversion
     * @returns {Object|null} Pixel coordinates {x, y, width, height}
     */
    function convertBboxToPixels(ann, overlayRect) {
        const bbox = ann.bbox;

        // Handle array format [x1, y1, x2, y2] - normalized coordinates
        if (Array.isArray(bbox) && bbox.length >= 4) {
            const [x1, y1, x2, y2] = bbox;
            // Validate all values are numbers
            if (!bbox.every(v => typeof v === 'number' && !isNaN(v))) {
                console.warn('[Comparison] Invalid bbox array values:', bbox);
                return null;
            }
            // Convert normalized (0-1) to pixels
            return {
                x: x1 * overlayRect.width,
                y: y1 * overlayRect.height,
                width: (x2 - x1) * overlayRect.width,
                height: (y2 - y1) * overlayRect.height
            };
        }

        // Handle object format {x0, y0, x1, y1}
        if (bbox && typeof bbox === 'object' && 'x0' in bbox) {
            return {
                x: bbox.x0,
                y: bbox.y0,
                width: bbox.x1 - bbox.x0,
                height: bbox.y1 - bbox.y0
            };
        }

        // Handle object format {x, y, width, height}
        if (bbox && typeof bbox === 'object' && 'x' in bbox && 'width' in bbox) {
            return {
                x: bbox.x,
                y: bbox.y,
                width: bbox.width,
                height: bbox.height
            };
        }

        // Try normalized_coords or rect fallback
        const coords = ann.normalized_coords || ann.rect;
        if (Array.isArray(coords) && coords.length >= 4) {
            const [x1, y1, x2, y2] = coords;
            if (!coords.every(v => typeof v === 'number' && !isNaN(v))) {
                return null;
            }
            return {
                x: x1 * overlayRect.width,
                y: y1 * overlayRect.height,
                width: (x2 - x1) * overlayRect.width,
                height: (y2 - y1) * overlayRect.height
            };
        }

        // Try x_normalized, y_normalized (single point)
        if (typeof ann.x_normalized === 'number' && typeof ann.y_normalized === 'number') {
            return {
                x: ann.x_normalized * overlayRect.width,
                y: ann.y_normalized * overlayRect.height,
                width: 100, // Default width for point annotations
                height: 24
            };
        }

        return null;
    }

    /**
     * Apply fallback positioning when bbox is unavailable
     * @param {HTMLElement} marker - The marker element
     * @param {'A'|'B'} model - Model identifier
     * @param {number} idx - Annotation index
     */
    function applyFallbackPosition(marker, model, idx) {
        const offsetY = idx * 35 + 20;
        const offsetX = model === 'A' ? 10 : 60;
        marker.style.left = `${offsetX}px`;
        marker.style.top = `${offsetY}px`;
        marker.style.width = '100px';
        marker.style.height = '24px';
    }

    /**
     * Append marker with label to overlay
     * @param {HTMLElement} marker - The marker element
     * @param {Object} ann - Annotation data
     * @param {'A'|'B'} model - Model identifier
     * @param {number} idx - Annotation index
     * @param {HTMLElement} overlay - The overlay element
     */
    function appendMarkerWithLabel(marker, ann, model, idx, overlay) {
        // Add label with comment preview
        const label = document.createElement('div');
        label.className = 'annotation-label';
        const commentText = ann.comment || ann.content || '';
        label.textContent = commentText.length > 40 ? commentText.substring(0, 40) + '...' : commentText;
        label.title = commentText;
        marker.appendChild(label);

        // Click to scroll to panel item
        const feedbackId = ann.id || `ann-${model}-${idx}`;
        marker.addEventListener('click', () => {
            scrollToComparisonPanelItem(feedbackId, model);
        });

        overlay.appendChild(marker);
    }

    /**
     * Scroll to a panel item and highlight it
     * @param {string|number} feedbackId - The feedback ID
     * @param {'A'|'B'} model - Which model panel
     */
    function scrollToComparisonPanelItem(feedbackId, model) {
        const panelId = model === 'A' ? 'pdfModelACommentsList' : 'pdfModelBCommentsList';
        const panel = document.getElementById(panelId);
        if (!panel) return;

        try {
            const escapedFeedbackId = escapeCssAttribute(feedbackId);
            const item = panel.querySelector(`[data-feedback-id="${escapedFeedbackId}"]`);
            if (item) {
                // Remove active from all items
                panel.querySelectorAll('.list-group-item').forEach(i => i.classList.remove('active'));
                // Add active to clicked item
                item.classList.add('active');
                // Scroll into view
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } catch (error) {
            console.error('[Comparison] Error scrolling to panel item:', error);
        }
    }

    // =========================================================================
    // Panel Rendering
    // =========================================================================

    /**
     * Render both comparison panels with feedback lists
     */
    function renderComparisonPanels() {
        const panelA = document.getElementById('pdfModelACommentsList');
        const panelB = document.getElementById('pdfModelBCommentsList');

        if (panelA) {
            panelA.innerHTML = renderComparisonFeedbackList(
                exports.comparisonData.annotationsA,
                'A'
            );
            attachComparisonPanelClickHandlers(panelA, 'A');
        }

        if (panelB) {
            panelB.innerHTML = renderComparisonFeedbackList(
                exports.comparisonData.annotationsB,
                'B'
            );
            attachComparisonPanelClickHandlers(panelB, 'B');
        }
    }

    /**
     * Render a feedback list as HTML
     * @param {Array} annotations - List of annotations
     * @param {'A'|'B'} model - Model identifier
     * @returns {string} HTML string
     */
    function renderComparisonFeedbackList(annotations, model) {
        if (!annotations || annotations.length === 0) {
            return '<div class="text-muted small text-center p-3">No feedback items</div>';
        }

        const sourceClass = `source-model-${model.toLowerCase()}`;
        const badgeClass = model === 'A' ? 'bg-danger' : 'bg-primary';
        const overlapSet = buildOverlapSet();

        return annotations.map((ann, idx) => {
            const isOverlap = overlapSet.has(ann.id);
            const itemClass = isOverlap ? 'source-overlap' : sourceClass;
            const comment = ann.comment || ann.content || '';
            const quote = ann.quote || '';
            // Coerce to an integer so a non-numeric ann.page cannot break out of
            // the data-page attribute / text below (attribute-injection DOM XSS).
            const page = normalizePageNumber(ann.page);
            const feedbackId = ann.id || `ann-${model}-${idx}`;

            return `
                <div class="list-group-item list-group-item-action ${itemClass} py-2"
                     data-feedback-id="${escapeHtmlAttribute(feedbackId)}"
                     data-page="${page}"
                     tabindex="0">
                    <div class="d-flex justify-content-between align-items-start">
                        <span class="badge ${badgeClass} me-2">#${idx + 1}</span>
                        <div class="flex-grow-1">
                            <p class="mb-1 small">${escapeHtml(comment)}</p>
                            ${quote ? `<small class="text-muted fst-italic">"${escapeHtml(quote.substring(0, 100))}${quote.length > 100 ? '...' : ''}"</small>` : ''}
                        </div>
                        <small class="text-muted ms-2">p.${page}</small>
                    </div>
                    ${isOverlap ? '<span class="badge badge-overlap text-white mt-1">Overlap</span>' : ''}
                </div>
            `;
        }).join('');
    }

    /**
     * Attach click handlers to panel items
     * @param {HTMLElement} panel - The panel element
     * @param {'A'|'B'} model - Model identifier
     */
    function attachComparisonPanelClickHandlers(panel, model) {
        panel.querySelectorAll('.list-group-item').forEach(item => {
            item.addEventListener('click', () => {
                const feedbackId = item.dataset.feedbackId;
                const page = parseInt(item.dataset.page, 10);

                // Navigate to page if different
                if (page !== exports.currentPage) {
                    exports.navigateToPage(page);
                }

                // Highlight corresponding marker
                highlightMarker(feedbackId, model);

                // Highlight this item
                panel.querySelectorAll('.list-group-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
        });
    }

    /**
     * Highlight a marker on the PDF
     * @param {string} feedbackId - Feedback ID
     * @param {'A'|'B'} model - Model identifier
     */
    function highlightMarker(feedbackId, model) {
        // Remove highlight from all markers
        document.querySelectorAll('.annotation-marker.highlighted').forEach(m => {
            m.classList.remove('highlighted');
        });

        // Find and highlight the target marker
        const escapedFeedbackId = escapeCssAttribute(feedbackId);
        const escapedModel = escapeCssAttribute(model);
        const marker = document.querySelector(`.annotation-marker[data-feedback-id="${escapedFeedbackId}"][data-model="${escapedModel}"]`);
        if (marker) {
            marker.classList.add('highlighted');
            marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // =========================================================================
    // Page Navigation
    // =========================================================================

    /**
     * Navigate to a specific page
     * @param {number} page - Page number (1-indexed)
     */
    exports.navigateToPage = function navigateToPage(page) {
        if (page < 1 || page > exports.totalPages) return;

        exports.currentPage = page;

        // Scroll to page wrapper
        const pageWrapper = document.querySelector(`.pdf-page-wrapper[data-page="${page}"]`);
        if (pageWrapper) {
            pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Re-render annotations for new page
        exports.renderComparisonAnnotations();
    };

    /**
     * Handle page change events from the main PDF viewer
     * Called by the main pdf-preview-modal.js when page changes
     * @param {number} newPage - New page number
     * @param {number} totalPages - Total pages
     */
    exports.onPageChange = function onPageChange(newPage, totalPages) {
        if (!exports.comparisonModeActive) return;

        exports.currentPage = newPage;
        exports.totalPages = totalPages;
        exports.renderComparisonAnnotations();
    };

    // =========================================================================
    // Public API Check
    // =========================================================================

    /**
     * Check if comparison mode is active
     * @returns {boolean}
     */
    exports.isActive = function isActive() {
        return exports.comparisonModeActive;
    };

    /**
     * Get current comparison data
     * @returns {Object|null}
     */
    exports.getData = function getData() {
        return exports.comparisonData;
    };

})(window.PdfPreviewModalComparison);

// Expose as global function for easy access from step4_comparison.js
window.openComparisonMode = window.PdfPreviewModalComparison.openComparisonMode;
window.exitComparisonMode = window.PdfPreviewModalComparison.exitComparisonMode;

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.comparison = window.PdfPreviewModalComparison;
