/**
 * PDF Preview Modal JavaScript
 * 
 * Extracted from _pdf_preview_modal.html as part of Phase 9 refactoring.
 * This module provides PDF viewing, annotation management, and fullscreen
 * functionality for the Canvas grading wizard.
 * 
 * Configuration:
 * Before loading this script, define window.PDFPreviewConfig with:
 * - pdfjsWorkerSrc: URL to pdf.worker.min.js
 * 
 * @module pdf-preview-modal
 */
// Wrap entire module in IIFE to prevent global scope pollution
(function () {
    'use strict';

    // Configuration - passed from template (used by pdf-viewer.js module)
    const _PDFPreviewConfig = window.PDFPreviewConfig || {
        pdfjsWorkerSrc: '/static/js/pdf.worker.min.js'
    };

    // =========================================================================
    // Module Imports - Use extracted modules for shared utilities
    // =========================================================================
    const UtilsModule = window.PdfPreviewModalUtils || {};
    const PDF_DEBUG = UtilsModule.PDF_DEBUG || false;
    const debugLog = UtilsModule.debugLog || function () { };
    const PLACEHOLDER_STRINGS = UtilsModule.PLACEHOLDER_STRINGS || ['', 'New comment...', 'New comment'];

    function translatePdfPreviewText(key, params) {
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

    const csrfTokenElement = document.querySelector('meta[name="csrf-token"]');
    const _csrfToken = csrfTokenElement ? csrfTokenElement.content : null;

    const pdfPreviewModalEl = document.getElementById('pdfPreviewModal');
    const fullscreenToggleBtn = document.getElementById('pdfPreviewFullscreenToggle');
    let previewFullscreenActive = false;
    let _legacyFullscreenClickHandler = null;
    let _legacyMarkupToggleClickHandler = null;
    let _legacySplitPanelClickHandler = null;
    let _legacySplitPanelFullscreenHandler = null;

    // Phase 5A: shell controller instance (created by composition root)
    let _currentShell = null;

    // Phase 5A: document controller instance (created by composition root)
    let _currentDocCtrl = null;

    // Phase 5A: overlay renderer instance (created by composition root)
    let _currentOverlayRenderer = null;

    // Phase 5A: annotation controller instance (created by composition root)
    let _currentAnnotationCtrl = null;
    // Guard flag: prevents infinite recursion when annotation controller
    // delegates back into the monolith helpers it was given.
    let _annotationCtrlDelegating = false;

    // Phase 5A: version sync instance (created by composition root)
    let _currentVersionSync = null;

    // Markup mode modules
    var DrawingCanvas = window.PdfPreviewModalDrawingCanvas || null;
    var TextboxModule = window.PdfPreviewModalTextbox || null;
    var MarkupToolbar = window.PdfPreviewModalMarkupToolbar || null;
    var MarkupSelection = window.PdfPreviewModalMarkupSelection || null;
    var markupModeActive = false;

    function fallbackFormatGraderDisplayName(fullName, mode) {
        const raw = String(fullName || '').trim();
        if (!raw) {
            return '';
        }

        const roleMatch = raw.match(/^(.+?)\s*(\([^)]+\))$/);
        const nameOnly = roleMatch ? roleMatch[1].trim() : raw;
        const parts = nameOnly.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
            return nameOnly;
        }

        const toTokenInitials = (token) => {
            const initials = token
                .split('-')
                .filter(Boolean)
                .map((segment) => segment.charAt(0).toUpperCase())
                .join('-');
            return initials ? `${initials}.` : '';
        };

        if (mode === 'reduced') {
            return parts.map(toTokenInitials).join('');
        }

        const givenNames = parts.slice(0, -1).join(' ');
        const surnameInitial = toTokenInitials(parts[parts.length - 1]);
        return `${givenNames} ${surnameInitial}`.trim();
    }

    function formatGraderDisplayName(fullName) {
        const sidebarPanelModule = window.PdfPreviewModalSidebarPanel || {};
        const formatter = typeof sidebarPanelModule.formatDisplayName === 'function'
            ? sidebarPanelModule.formatDisplayName
            : fallbackFormatGraderDisplayName;
        const displayMode = previewFullscreenActive ? 'full' : 'reduced';
        return formatter(fullName, displayMode);
    }

    // Phase 5A: Fullscreen functions — delegate to shell if available, fallback for pre-shell path.
    function updatePreviewFullscreenUi(active) {
        if (_currentShell) {
            _currentShell.setFullscreen(active);
            previewFullscreenActive = _currentShell.isFullscreen();
            return;
        }
        // Fallback (before shell is created)
        const previousState = previewFullscreenActive;
        previewFullscreenActive = !!active;
        if (pdfPreviewModalEl) {
            pdfPreviewModalEl.classList.toggle('preview-fullscreen', previewFullscreenActive);
        }
        if (fullscreenToggleBtn) {
            const icon = fullscreenToggleBtn.querySelector('i');
            if (icon) {
                icon.className = `bi ${previewFullscreenActive ? 'bi-fullscreen-exit' : 'bi-fullscreen'}`;
            }
        }

        if (previousState !== previewFullscreenActive && typeof renderAnnotationsList === 'function') {
            renderAnnotationsList();
            if (
                pdfPreviewModalEl &&
                pdfPreviewModalEl.classList.contains('split-panel-mode') &&
                typeof renderAIAnnotationsList === 'function'
            ) {
                renderAIAnnotationsList();
            }
        }
    }

    async function requestPreviewFullscreen() {
        if (_currentShell) { _currentShell.requestFullscreen(); return; }
        if (!pdfPreviewModalEl) return;
        try {
            if (pdfPreviewModalEl.requestFullscreen) {
                await pdfPreviewModalEl.requestFullscreen();
            } else if (pdfPreviewModalEl.webkitRequestFullscreen) {
                await pdfPreviewModalEl.webkitRequestFullscreen();
            } else {
                updatePreviewFullscreenUi(true);
            }

            // Attempt to lock Escape so the browser does not force-exit fullscreen.
            if (navigator.keyboard && navigator.keyboard.lock) {
                try {
                    await navigator.keyboard.lock(['Escape']);
                } catch {
                    // Keyboard lock not critical, ignore
                }
            }
        } catch (error) {
            console.error('Fullscreen request failed:', error);
            updatePreviewFullscreenUi(true);
        }
    }

    async function exitPreviewFullscreen() {
        if (_currentShell) { _currentShell.exitFullscreen(); return; }
        // CRITICAL: Don't exit fullscreen if editing annotation
        if (editingAnnotationId !== null) {
            return;
        }

        // Unlock keyboard when exiting fullscreen so Escape works normally elsewhere.
        if (navigator.keyboard && navigator.keyboard.unlock) {
            navigator.keyboard.unlock();
        }

        if (document.fullscreenElement === pdfPreviewModalEl && document.exitFullscreen) {
            await document.exitFullscreen();
        } else if (document.webkitFullscreenElement === pdfPreviewModalEl && document.webkitExitFullscreen) {
            await document.webkitExitFullscreen();
        } else {
            updatePreviewFullscreenUi(false);
        }
    }

    function togglePreviewFullscreen() {
        if (_currentShell) { _currentShell.toggleFullscreen(); return; }
        if (previewFullscreenActive) {
            exitPreviewFullscreen();
        } else {
            requestPreviewFullscreen();
        }
    }

    // Phase 5A: click listener only active before shell takes over
    if (!_currentShell) {
        _legacyFullscreenClickHandler = function () {
            if (_currentShell) { return; }
            togglePreviewFullscreen();
        };
        fullscreenToggleBtn?.addEventListener('click', _legacyFullscreenClickHandler);
    }

    // =========================================================================
    // Markup Mode Toggle — Phase 5A: delegate to shell when available
    // =========================================================================
    function toggleMarkupMode() {
        if (_currentShell) { _currentShell.toggleMarkupMode(); markupModeActive = _currentShell.isMarkupActive(); return; }
        markupModeActive = !markupModeActive;

        var toggleBtn = pdfPreviewModalEl ? pdfPreviewModalEl.querySelector('.js-toggle-markup') : null;
        if (toggleBtn) toggleBtn.classList.toggle('active', markupModeActive);

        if (DrawingCanvas) DrawingCanvas.setMarkupMode(markupModeActive);

        if (MarkupToolbar) {
            if (markupModeActive) {
                if (DrawingCanvas && typeof DrawingCanvas.init === 'function') {
                    DrawingCanvas.init();
                }
                if (MarkupSelection && typeof MarkupSelection.init === 'function') {
                    MarkupSelection.init();
                }
                MarkupToolbar.show();
                if (DrawingCanvas) {
                    DrawingCanvas.setActiveTool(MarkupToolbar.getActiveTool ? MarkupToolbar.getActiveTool() : 'select');
                    DrawingCanvas.setActiveColor(MarkupToolbar.getActiveColor ? MarkupToolbar.getActiveColor() : 'black');
                }
            } else {
                MarkupToolbar.hide();
                if (MarkupSelection) MarkupSelection.deselect();
                if (DrawingCanvas) DrawingCanvas.setActiveTool(null);
            }
        }
    }

    // Phase 5A: click listener only active before shell takes over
    if (!_currentShell && pdfPreviewModalEl) {
        _legacyMarkupToggleClickHandler = function (e) {
            if (_currentShell) { return; }
            if (e.target.closest('.js-toggle-markup')) {
                toggleMarkupMode();
                return;
            }
        };
        pdfPreviewModalEl.addEventListener('click', _legacyMarkupToggleClickHandler);
    }

    // Split Panel Mode for AI/Human annotations — Phase 5A: delegate to shell
    const splitPanelToggleBtn = document.getElementById('pdfPreviewSplitPanelToggle');
    let splitPanelActive = false;

    function updateSplitPanelUi(active) {
        if (_currentShell) {
            _currentShell.setSplitPanel(active);
            splitPanelActive = _currentShell.isSplitPanel();
            return;
        }
        splitPanelActive = !!active;
        if (pdfPreviewModalEl) {
            pdfPreviewModalEl.classList.toggle('split-panel-mode', splitPanelActive);
        }
        if (!splitPanelToggleBtn) return;
        splitPanelToggleBtn.classList.toggle('active', splitPanelActive);

        // Re-render annotations lists when toggling (both on and off)
        // When turning ON: human panel filters to HUMAN only, AI panel renders
        // When turning OFF: human panel shows ALL annotations again
        renderAnnotationsList();
        if (splitPanelActive) {
            renderAIAnnotationsList();
        }
    }

    function toggleSplitPanel() {
        if (_currentShell) { _currentShell.toggleSplitPanel(); splitPanelActive = _currentShell.isSplitPanel(); return; }
        // Split panel only works in fullscreen
        if (!previewFullscreenActive) {
            return;
        }
        updateSplitPanelUi(!splitPanelActive);
    }

    // Phase 5A: click listener only active before shell takes over
    if (!_currentShell) {
        _legacySplitPanelClickHandler = function () {
            if (_currentShell) { return; }
            toggleSplitPanel();
        };
        splitPanelToggleBtn?.addEventListener('click', _legacySplitPanelClickHandler);
    }

    // Show/hide split panel button based on fullscreen state
    function updateSplitPanelButtonVisibility() {
        if (_currentShell) { _currentShell.updateSplitPanelButtonVisibility(); return; }
        if (!splitPanelToggleBtn) return;
        if (previewFullscreenActive) {
            splitPanelToggleBtn.classList.remove('d-none');
        } else {
            splitPanelToggleBtn.classList.add('d-none');
            // Also disable split panel when exiting fullscreen
            if (splitPanelActive) {
                updateSplitPanelUi(false);
            }
        }
    }

    // Phase 5A: fullscreenchange for split panel only active before shell
    if (!_currentShell) {
        _legacySplitPanelFullscreenHandler = function () {
            if (_currentShell) { return; }
            setTimeout(updateSplitPanelButtonVisibility, 100);
        };
        document.addEventListener('fullscreenchange', _legacySplitPanelFullscreenHandler);
    }

    /**
     * Shared helper to attach event listeners to annotation panel list elements.
     * Uses event delegation for better performance - listeners are attached to the
     * container and handle dynamically added elements without re-attachment.
     * @param {HTMLElement} listEl - The list container element
     * @param {Object} options - Configuration options
     * @param {boolean} options.skipPriority - Skip priority dot handlers (main panel has specialized version)
     * @param {boolean} options.skipFocus - Skip focus/blur handlers (main panel has specialized version)
     */
    function attachPanelEventListeners(listEl, options = {}) {
        if (!listEl) return;
        const { skipPriority = false, skipFocus = false } = options;

        // Delegated click handler for buttons and list items (bound once per list).
        if (!listEl.dataset.panelClickBound) {
            listEl.dataset.panelClickBound = 'true';
            listEl.addEventListener('click', (e) => {
                // Edit button
                const editBtn = e.target.closest('.edit-annotation');
                if (editBtn) {
                    const id = editBtn.dataset.annotationRequestId || editBtn.dataset.annotationIdentifier || editBtn.dataset.annotationXref;
                    if (!id) { showToast('error', 'Unable to locate annotation.'); return; }
                    editAnnotation(parseInt(editBtn.dataset.annotationPage), id, editBtn.dataset.annotationId);
                    return;
                }

                // Delete button
                const deleteBtn = e.target.closest('.delete-annotation');
                if (deleteBtn) {
                    const id = deleteBtn.dataset.annotationRequestId || deleteBtn.dataset.annotationIdentifier || deleteBtn.dataset.annotationXref;
                    if (!id) { showToast('error', 'Unable to delete annotation.'); return; }
                    deleteAnnotation(parseInt(deleteBtn.dataset.annotationPage), id, deleteBtn);
                    return;
                }

                // Save button
                const saveBtn = e.target.closest('.save-annotation-btn');
                if (saveBtn) {
                    const id = saveBtn.dataset.annotationIdentifier || saveBtn.dataset.annotationXref;
                    if (!id) { showToast('error', 'Annotation missing.'); return; }
                    saveAnnotationEdit(id, saveBtn);
                    return;
                }

                // Verdict indicator toggle
                const verdictIcon = e.target.closest('.verdict-indicator');
                if (verdictIcon) {
                    e.preventDefault();
                    e.stopPropagation();
                    const id = verdictIcon.dataset.annotationRequestId || verdictIcon.dataset.annotationIdentifier || verdictIcon.dataset.annotationXref;
                    const page = parseInt(verdictIcon.dataset.annotationPage);
                    if (id && !Number.isNaN(page)) {
                        toggleAnnotationVerdict(page, id, verdictIcon);
                    }
                    return;
                }

                // List item click-to-scroll (skip if clicking button or textarea)
                if (e.target.closest('button') || e.target.tagName === 'TEXTAREA') return;
                const listItem = e.target.closest('.list-group-item');
                if (listItem) {
                    const id = listItem.dataset.annotationRequestId || listItem.dataset.annotationIdentifier;
                    const page = parseInt(listItem.dataset.annotationPage);
                    if (id && !Number.isNaN(page)) scrollToAnnotationMarker(page, id);
                }
            });
        }

        // Delegated mousedown handler for priority dots (skip for main panel)
        if (!skipPriority && !listEl.dataset.panelPriorityBound) {
            listEl.dataset.panelPriorityBound = 'true';
            listEl.addEventListener('mousedown', (e) => {
                const dot = e.target.closest('.priority-dot');
                if (!dot) return;
                e.preventDefault();
                e.stopPropagation();
                const container = dot.closest('.priority-dots');
                if (!container) return;
                const id = container.dataset.annotationRequestId || container.dataset.annotationIdentifier;
                if (!id) return;
                updateAnnotationPriority(parseInt(container.dataset.annotationPage), id, dot.dataset.priority);
            });
        }

        // Delegated focus/blur handlers (skip for main panel which has specialized version)
        if (!skipFocus && !listEl.dataset.panelFocusBound) {
            listEl.dataset.panelFocusBound = 'true';
            listEl.addEventListener('focusin', (e) => {
                const item = e.target.closest('.list-group-item');
                if (item) {
                    item.classList.add('item-focused', 'active');
                }
            });
            listEl.addEventListener('focusout', (e) => {
                const item = e.target.closest('.list-group-item');
                if (item) {
                    item.classList.remove('item-focused', 'active');
                }
            });
        }
    }

    function getAnnotationOrderRect(entry) {
        const rect = entry?.ann?.rect || entry?.rect;
        if (!Array.isArray(rect) || rect.length !== 4) {
            return null;
        }
        const x0 = Number(rect[0]);
        const y0 = Number(rect[1]);
        const x1 = Number(rect[2]);
        const y1 = Number(rect[3]);
        if (![x0, y0, x1, y1].every(Number.isFinite)) {
            return null;
        }
        return {
            left: Math.min(x0, x1),
            right: Math.max(x0, x1),
            top: Math.min(y0, y1),
            bottom: Math.max(y0, y1),
        };
    }

    function compareAnnotationsByDocumentPosition(a, b) {
        const rectA = getAnnotationOrderRect(a);
        const rectB = getAnnotationOrderRect(b);
        if (rectA && rectB) {
            const yDiff = rectA.top - rectB.top;
            if (Math.abs(yDiff) > 0.1) {
                return yDiff;
            }
            const xDiff = rectA.left - rectB.left;
            if (Math.abs(xDiff) > 0.1) {
                return xDiff;
            }
        } else if (rectA && !rectB) {
            return -1;
        } else if (!rectA && rectB) {
            return 1;
        }

        const xrefA = Number.parseInt(String(a?.ann?.xref ?? a?.xref ?? ''), 10);
        const xrefB = Number.parseInt(String(b?.ann?.xref ?? b?.xref ?? ''), 10);
        if (Number.isFinite(xrefA) && Number.isFinite(xrefB) && xrefA !== xrefB) {
            return xrefA - xrefB;
        }

        const fallbackA = Number.isFinite(a?.sourceIndex) ? a.sourceIndex : (a?.indexOnPage ?? 0);
        const fallbackB = Number.isFinite(b?.sourceIndex) ? b.sourceIndex : (b?.indexOnPage ?? 0);
        return fallbackA - fallbackB;
    }

    function buildDisplayOrderByPagePosition(pageAnnotations) {
        const ordered = (pageAnnotations || [])
            .filter((ann) => {
                if (isMarkupAnnotation(ann)) {
                    return false;
                }
                const isPlaceholder = isPlaceholderAnnotation(ann);
                const hasBeenEdited = ann?._hasBeenEdited === true || ann?._priorityChanged === true;
                return !isPlaceholder || ann?._isTemporary || hasBeenEdited;
            })
            .map((ann, sourceIndex) => ({ ann, sourceIndex }));
        ordered.sort(compareAnnotationsByDocumentPosition);
        const orderByKey = new Map();
        ordered.forEach((entry, idx) => {
            const order = idx + 1;
            const candidates = [
                entry.ann?.requestIdentifier,
                entry.ann?.identifier,
                entry.ann?.stable_id,
                entry.ann?.id,
                entry.ann?.xref,
            ];
            candidates.forEach((candidate) => {
                const key = normalizeAnnotationIdentifierValue(candidate);
                if (key !== null && !orderByKey.has(key)) {
                    orderByKey.set(key, order);
                }
            });
        });
        return orderByKey;
    }

    function isMarkupAnnotation(ann) {
        const CrudRef = window.PdfPreviewModalCrud;
        return !!(CrudRef && CrudRef.isMarkupType && CrudRef.isMarkupType(ann?.type));
    }

    function isPlaceholderAnnotation(ann) {
        if (isMarkupAnnotation(ann)) {
            return false;
        }
        const content = String(ann?.content || '').trim();
        return content === '' || content === 'New comment...' || content === 'New comment';
    }

    function resolveDisplayOrderFromLookup(annotation, orderLookup) {
        if (!annotation || !orderLookup) {
            return null;
        }
        const candidates = [
            annotation.requestIdentifier,
            annotation.identifier,
            annotation.stable_id,
            annotation.id,
            annotation.xref,
        ];
        for (const candidate of candidates) {
            const key = normalizeAnnotationIdentifierValue(candidate);
            if (key !== null && orderLookup.has(key)) {
                return orderLookup.get(key);
            }
        }
        return null;
    }

    function renderCompactInlineLabelContent(label, annotationNumber, fullText) {
        if (!label) {
            return;
        }
        const maxChars = 18;
        const rawText = String(fullText || 'Click to edit');
        const compactText = rawText.length > maxChars
            ? rawText.substring(0, maxChars) + '...'
            : rawText;
        const compactNumber = String(annotationNumber || '').trim();

        label.dataset.annotationNumber = compactNumber;
        label.dataset.originalText = compactText;

        label.innerHTML = '';
        const textSpan = document.createElement('span');
        textSpan.className = 'annotation-label-text';
        textSpan.textContent = compactText;
        label.appendChild(textSpan);
    }

    /**
     * Render AI-only annotations list for split panel mode.
     * This populates the AI comments panel with only AI-generated annotations.
     */
    function renderAIAnnotationsList() {
        if (_currentAnnotationCtrl && _currentAnnotationCtrl.renderAIList && !_annotationCtrlDelegating) {
            return _currentAnnotationCtrl.renderAIList();
        }
        syncVisibleAnnotationMarkersFromDom();
        // Also update AI list when in split panel mode
        const listEl = document.getElementById('pdfGradedAICommentsList');
        if (!listEl) return;

        // Collect all VISIBLE AI annotations
        const aiAnnotations = [];

        // Iterate through all pages and their annotations (same logic as renderAnnotationsList)
        let hasAnyAiAnnotations = false;

        for (const pageIdxStr in annotationsData) {
            const pageAnns = annotationsData[pageIdxStr] || [];
            const pageIdx = parseInt(pageIdxStr);
            const displayOrderLookup = buildDisplayOrderByPagePosition(pageAnns);

            pageAnns.forEach((ann, idx) => {
                // Skip drawing and textbox annotations from sidebar
                var CrudRef = window.PdfPreviewModalCrud;
                if (CrudRef && CrudRef.isMarkupType && CrudRef.isMarkupType(ann.type)) {
                    return;
                }

                const source = resolveAnnotationSource(ann);
                if (source === 'AI') {
                    hasAnyAiAnnotations = true;

                    const markerKey = buildAnnotationVisibilityKey(pageIdx, { annotation: ann });

                    // Only show AI comments that are currently visible in the document viewport.
                    if (!markerKey || !visibleAnnotationMarkers.has(markerKey)) {
                        return;
                    }

                    // Filter 3: Must not be placeholder/empty (unless edited)
                    const content = (ann.content || '').trim();
                    const isPlaceholder = content === '' ||
                        content === 'New comment...' ||
                        content === 'New comment';

                    const hasBeenEdited = ann._hasBeenEdited === true || ann._priorityChanged === true;
                    const shouldDisplay = !isPlaceholder || ann._isTemporary || hasBeenEdited;

                    if (shouldDisplay) {
                        const displayIndexOnPage = resolveDisplayOrderFromLookup(ann, displayOrderLookup) || (idx + 1);
                        aiAnnotations.push({
                            ...ann,
                            pageIdx: pageIdx,
                            displayIndexOnPage,
                            indexOnPage: idx,
                            sourceIndex: idx,
                        });
                    }
                }
            });
        }

        // Sort by page and actual on-page position (top-to-bottom, then left-to-right)
        aiAnnotations.sort((a, b) => {
            if (a.pageIdx !== b.pageIdx) return a.pageIdx - b.pageIdx;
            const displayA = Number(a.displayIndexOnPage || 0);
            const displayB = Number(b.displayIndexOnPage || 0);
            if (displayA !== displayB) {
                return displayA - displayB;
            }
            return compareAnnotationsByDocumentPosition(a, b);
        });

        if (aiAnnotations.length === 0) {
            const message = hasAnyAiAnnotations ? 'No AI feedback visible' : 'No AI annotations';
            listEl.innerHTML = `<div class="text-muted small text-center p-3">${message}</div>`;
            return;
        }

        // Render annotations with page separators
        let lastPageIdx = null;
        const html = aiAnnotations.map((ann) => {
            const xrefValue = normalizeAnnotationIdentifierValue(
                typeof ann.xref === 'number' ? String(ann.xref) : ann.xref
            ) || '';
            const stableId = normalizeAnnotationIdentifierValue(
                ann.id || ann.identifier || ann.stable_id || ann.name || ann.title
            ) || '';
            const identifier = stableId || resolveAnnotationIdentifierValue(ann);
            const { xref: resolvedXref, stableId: resolvedStable } = resolveAnnotationIdParts({
                xref: xrefValue,
                requestId: ann.requestIdentifier,
                identifier,
            });
            const requestId = resolvedStable || resolvedXref || '';
            // Escape identifiers for safe use in HTML attributes (prevent attribute injection)
            const displayIdentifier = escapeHtml(requestId || `idx-${ann.indexOnPage}`);
            const domId = escapeHtml(`ann-${ann.pageIdx}-${displayIdentifier}`);

            // Determine priority from annotation data using helper function
            const priority = deriveAnnotationPriority(ann);
            const colorClass = priority === 'red' ? 'danger' : priority === 'green' ? 'success' : 'warning';

            // Clear placeholder text when editing - show empty for new annotations
            let content = ann.content || '';
            const contentIsPlaceholder = content === '' ||
                content === 'New comment...' ||
                content === 'New comment';

            // For editing mode, show empty string for placeholders; for display mode show actual content
            const editContent = contentIsPlaceholder ? '' : escapeHtml(content);
            const displayContent = escapeHtml(content) || 'No comment text';

            // Get grader name from annotation and format according to current display mode
            const rawGraderName = ann.grader_name || ann.author_name || '';
            const graderName = formatGraderDisplayName(rawGraderName);
            const displayIndexOnPage = Number(ann.displayIndexOnPage || 1);
            const commentId = `${ann.pageIdx + 1}.${displayIndexOnPage}`;

            // Source badge HTML - Icon only
            const sourceBadgeHtml = `<span class="source-badge source-ai" title="AI-generated"><i class="bi bi-robot"></i></span>`;

            // Verdict indicator
            const isVerdict = !!ann.is_verdict;
            const verdictHtml = isVerdict
                ? `<i class="bi bi-patch-check-fill verdict-indicator" title="Verdict comment" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}" data-annotation-page="${ann.pageIdx}"></i>`
                : `<i class="bi bi-patch-check verdict-indicator verdict-inactive" title="Mark as verdict" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}" data-annotation-page="${ann.pageIdx}"></i>`;
            const verdictClass = isVerdict ? ' is-verdict' : '';

            // Add page separator if this is a new page
            let separator = '';
            if (lastPageIdx !== null && ann.pageIdx !== lastPageIdx) {
                separator = `<div class="page-separator">
                    <small class="text-muted d-block text-center page-separator-label">${translatePdfPreviewText('Page %(page)s', { page: ann.pageIdx + 1 })}</small>
                </div>`;
            }
            lastPageIdx = ann.pageIdx;

            return `
                ${separator}
                <div class="list-group-item source-ai${verdictClass}" tabindex="0" data-annotation-id="${domId}" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}" data-annotation-stable-id="${stableId}" data-annotation-page="${ann.pageIdx}" data-annotation-source="AI">
                    <div class="d-flex justify-content-between align-items-start gap-2">
                        <div class="flex-grow-1" style="min-width: 0">
                            <div class="d-flex align-items-center gap-2 mb-1">
                                <span class="badge bg-${colorClass}">${commentId}</span>
                                ${sourceBadgeHtml}
                                ${verdictHtml}
                                ${graderName ? `<small class="text-muted grader-name-badge" title="${escapeHtml(rawGraderName)}">${escapeHtml(graderName)}</small>` : ''}
                                <div class="priority-dots d-flex gap-1 ms-2" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}" data-annotation-page="${ann.pageIdx}">
                                    <span class="priority-dot priority-red ${priority === 'red' ? 'active' : ''}" data-priority="red" title="High priority"></span>
                                    <span class="priority-dot priority-amber ${priority === 'amber' ? 'active' : ''}" data-priority="amber" title="Medium priority"></span>
                                    <span class="priority-dot priority-green ${priority === 'green' ? 'active' : ''}" data-priority="green" title="Low priority"></span>
                                </div>
                            </div>
                            <div class="annotation-content ${editingAnnotationId === domId ? 'editing' : ''}" data-annotation-id="${domId}" data-annotation-identifier="${displayIdentifier}">
                                ${editingAnnotationId === domId ? `
                                    <textarea class="form-control form-control-sm mb-2 auto-resize-textarea" id="edit-annotation-text-${displayIdentifier}" rows="2" placeholder="Type your comment...">${editContent}</textarea>
                                    <div class="btn-group btn-group-sm">
                                        <button class="btn btn-primary btn-sm save-annotation-btn" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}">
                                            <span class="spinner-border spinner-border-sm d-none" role="status"></span>
                                            <span class="btn-text">Save</span>
                                        </button>
                                        <button class="btn btn-secondary btn-sm cancel-edit-btn" data-annotation-identifier="${displayIdentifier}" data-annotation-request-id="${requestId}" data-annotation-xref="${xrefValue}">Cancel</button>
                                    </div>
                                ` : displayContent}
                            </div>
                        </div>
                        ${editingAnnotationId !== domId ? `
                        <div class="btn-group btn-group-sm flex-shrink-0">
                             <button class="btn btn-outline-primary btn-sm edit-annotation"
                                    data-annotation-identifier="${displayIdentifier}"
                                     data-annotation-request-id="${requestId}"
                                     data-annotation-page="${ann.pageIdx}"
                                     data-annotation-id="${domId}"
                                     title="Edit comment">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-outline-danger btn-sm delete-annotation"
                                    data-annotation-identifier="${displayIdentifier}"
                                    data-annotation-request-id="${requestId}"
                                    data-annotation-xref="${ann.xref || ''}"
                                    data-annotation-page="${ann.pageIdx}"
                                    data-annotation-id="${domId}"
                                    title="Delete comment">
                                <span class="spinner-border spinner-border-sm d-none" role="status"></span>
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        // Avoid unnecessary DOM churn
        if (listEl.innerHTML === html) {
            return;
        }

        listEl.innerHTML = html;

        // Use shared helper - skip specific logic that might conflict or be handled by the main panel listeners if they are global
        // However, we DO want priority and focus logic here for the AI panel
        // Note: attachPanelEventListeners attaches to the specific        // Use shared helper for consistent event handling
        attachPanelEventListeners(listEl);

        // Add Double-click to edit support (mirroring main panel logic)
        listEl.querySelectorAll('.list-group-item').forEach(item => {
            item.addEventListener('dblclick', (event) => {
                const targetElement = event.target;
                if (targetElement.closest('button') || targetElement.tagName === 'TEXTAREA') {
                    return;
                }
                const identifierValue = item.dataset.annotationRequestId
                    || item.dataset.annotationIdentifier
                    || item.dataset.annotationXref
                    || null;

                if (!identifierValue) {
                    showToast('error', 'Unable to locate this annotation for editing.');
                    return;
                }

                const pageIdx = parseInt(item.dataset.annotationPage);
                const domId = item.dataset.annotationId;
                editAnnotation(pageIdx, identifierValue, domId);
            });
        });

        // BIDIRECTIONAL SYNC: Add input handlers to sidebar textareas for syncing to inline editor
        listEl.querySelectorAll('.auto-resize-textarea').forEach(sidebarTextarea => {
            if (!sidebarTextarea.id) return;

            // Sync sidebar → inline on input
            sidebarTextarea.addEventListener('input', () => {
                const inlineLabel = document.querySelector(`.annotation-label.label-editing`);
                if (inlineLabel) {
                    const inlineTextarea = inlineLabel.querySelector('.inline-annotation-editor');
                    if (inlineTextarea && inlineTextarea !== document.activeElement) {
                        inlineTextarea.value = sidebarTextarea.value;
                    }
                }
            });

            // Keep both open when focus moves from sidebar to inline
            sidebarTextarea.addEventListener('blur', () => {
                setTimeout(() => {
                    const inlineLabel = document.querySelector('.annotation-label.label-editing');
                    if (inlineLabel) {
                        const inlineTextarea = inlineLabel.querySelector('.inline-annotation-editor');
                        if (inlineTextarea && document.activeElement === inlineTextarea) {
                            if (sidebarTextarea.value && sidebarTextarea.value.trim()) {
                                inlineTextarea.value = sidebarTextarea.value;
                            }
                            return;
                        }
                    }
                }, 100);
            });
        });

        // Wire up cancel buttons specifically for this panel if needed (shared handler might cover it but good to be safe)
        listEl.querySelectorAll('.cancel-edit-btn').forEach(btn => {
            btn.addEventListener('click', async (_e) => {
                // Reuse the same logic as the main panel cancel handler
                // Since we're in the same scope, we can just trigger a re-render or let the common handler do it
                // The common handler relies on finding elements by ID usually, so it should work
                // Manually triggering generic re-render just in case
                setTimeout(() => {
                    renderAIAnnotationsList();
                }, 50);
            });
        });
    }

    /**
     * Scroll to an annotation marker on the PDF canvas.
     * Used by split panel click handlers.
     */
    function scrollToAnnotationMarker(pageIdx, identifier) {
        if (_currentOverlayRenderer) return _currentOverlayRenderer.scrollToMarker(pageIdx, identifier);

        // Find the marker element
        const marker = document.querySelector(
            `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-identifier="${identifier}"]`
        ) || document.querySelector(
            `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-xref="${identifier}"]`
        );

        if (marker) {
            // Scroll marker into view and highlight temporarily
            marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
            marker.classList.add('ownership-transferred');
            setTimeout(() => marker.classList.remove('ownership-transferred'), 1000);
        } else {
            // If marker not found, try to scroll to the page
            const pageWrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${pageIdx + 1}"]`);
            if (pageWrapper) {
                pageWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
    }

    async function handleFullscreenResize() {
        if (_currentDocCtrl) return _currentDocCtrl.handleResize();

        // Fallback: original monolith code
        const redrawAll = async () => {
            // For continuous scroll, re-render all pages
            if (window.__pdfGradedViewer?.pdf) {
                // Force re-render after fullscreen toggles so marker geometry is recomputed immediately.
                await window.__pdfGradedViewer.reRenderAllPages(true);
                if (typeof renderAllAnnotations === 'function') {
                    renderAllAnnotations(true);
                }

                refreshMarkupFromAnnotations();
            }
            if (window.__pdfOriginalViewer?.pdf) {
                // Original viewer still uses single page, keep old behavior
                window.__pdfOriginalViewer.renderPage(window.__pdfOriginalViewer.currentPage || 1);
            }

            // Re-highlight search if active
            if (pdfSearchState.matches.length > 0 && pdfSearchState.currentIndex >= 0) {
                setTimeout(() => {
                    highlightSearchMatch(pdfSearchState.matches[pdfSearchState.currentIndex]);
                }, 100);
            }
        };

        // Wait for transition to complete then re-render
        setTimeout(redrawAll, 400);
    }

    // Phase 5A: fullscreenchange / resize / modal events — delegate to shell when available.
    // When shell is active, these document listeners are redundant (shell owns them).
    // Keep fallback for pre-shell path (e.g. initial page load before composition root fires).

    function _monolithFullscreenChangeHandler() {
        if (_currentShell) return; // Shell handles this
        const isActive = document.fullscreenElement === pdfPreviewModalEl;
        if (!isActive && editingAnnotationId !== null) {
            _forcedExitDuringEdit = true;
            updatePreviewFullscreenUi(true);
            if (navigator.keyboard && navigator.keyboard.unlock) {
                navigator.keyboard.unlock();
            }
        }
        if (isActive) {
            _forcedExitDuringEdit = false;
        }
        updatePreviewFullscreenUi(isActive);
        syncSearchOverlayGeometry();
        handleFullscreenResize();
        if (pdfSearchState.matches.length > 0 && pdfSearchState.currentIndex >= 0) {
            highlightSearchMatch(pdfSearchState.matches[pdfSearchState.currentIndex]);
        }
    }

    document.addEventListener('fullscreenchange', _monolithFullscreenChangeHandler);
    document.addEventListener('webkitfullscreenchange', function () {
        if (_currentShell) return; // Shell handles this
        const isActive = document.webkitFullscreenElement === pdfPreviewModalEl;
        if (!isActive && editingAnnotationId !== null) {
            _forcedExitDuringEdit = true;
            updatePreviewFullscreenUi(true);
            if (navigator.keyboard && navigator.keyboard.unlock) {
                navigator.keyboard.unlock();
            }
        }
        if (isActive) {
            _forcedExitDuringEdit = false;
        }
        updatePreviewFullscreenUi(isActive);
        syncSearchOverlayGeometry();
        handleFullscreenResize();
        if (pdfSearchState.matches.length > 0 && pdfSearchState.currentIndex >= 0) {
            highlightSearchMatch(pdfSearchState.matches[pdfSearchState.currentIndex]);
        }
    });

    // Keep markers aligned when browser is zoomed (Ctrl+Wheel) or resized
    let resizeDebounceTimer;
    // FE-5 FIX: Named handler for cleanup
    const handleResize = () => {
        if (_currentShell) return; // Shell handles resize
        if (!pdfPreviewModalEl.classList.contains('show')) return;

        // Re-render after resize settles for sharpness/alignment
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            handleFullscreenResize();
        }, 100);
    };

    // Initial state: do not add listener until modal is shown.

    // Clean up listener when modal closes
    if (pdfPreviewModalEl) {
        // Exit native fullscreen before the modal hides so the user doesn't
        // see a black "press Esc to exit fullscreen" screen.
        pdfPreviewModalEl.addEventListener('hide.bs.modal', () => {
            if (_currentShell) return; // Shell handles this
            if (previewFullscreenActive) {
                const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
                if (fsEl === pdfPreviewModalEl) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                }
                updatePreviewFullscreenUi(false);
            }
        });

        pdfPreviewModalEl.addEventListener('hidden.bs.modal', () => {
            if (_currentShell) return; // Shell handles this
            window.removeEventListener('resize', handleResize);
            // Stop polling for annotation updates when modal closes
            if (typeof stopAnnotationsPolling === 'function') {
                stopAnnotationsPolling();
            }

            // Cleanup markup state
            if (DrawingCanvas) DrawingCanvas.destroy();
            if (TextboxModule) TextboxModule.destroy();
            if (MarkupToolbar) MarkupToolbar.destroy();
            if (MarkupSelection) MarkupSelection.destroy();
            markupModeActive = false;
            var markupToggleBtn = pdfPreviewModalEl ? pdfPreviewModalEl.querySelector('.js-toggle-markup') : null;
            if (markupToggleBtn) markupToggleBtn.classList.remove('active');
        });

        pdfPreviewModalEl.addEventListener('show.bs.modal', () => {
            if (_currentShell) return; // Shell handles this
            window.removeEventListener('resize', handleResize); // Prevent duplicates
            window.addEventListener('resize', handleResize);
            wireMarkupModuleCallbacks();

            if (DrawingCanvas && typeof DrawingCanvas.init === 'function') {
                DrawingCanvas.init();
            }
            if (MarkupSelection && typeof MarkupSelection.init === 'function') {
                MarkupSelection.init();
            }

            // Initialize markup toolbar
            if (MarkupToolbar && !document.querySelector('.markup-toolbar')) {
                var toolbarContainer = pdfPreviewModalEl || document.body;
                MarkupToolbar.create(toolbarContainer);
            }

            // Wire toolbar callbacks
            if (MarkupToolbar) {
                MarkupToolbar.onToolChange = function (toolId) {
                    if (DrawingCanvas) DrawingCanvas.setActiveTool(toolId);
                };

                MarkupToolbar.onColorChange = function (colorName) {
                    if (!DrawingCanvas) return;
                    var colors = DrawingCanvas.getPresetColors ? DrawingCanvas.getPresetColors() : [];
                    var activeColor = colorName;
                    for (var i = 0; i < colors.length; i++) {
                        if (colors[i].name === colorName) {
                            activeColor = colors[i];
                            break;
                        }
                    }
                    DrawingCanvas.setActiveColor(activeColor);
                };
            }

            // Wire toolbar click delegation
            var toolbarEl = pdfPreviewModalEl ? pdfPreviewModalEl.querySelector('.markup-toolbar') : document.querySelector('.markup-toolbar');
            if (!toolbarEl) toolbarEl = document.querySelector('.markup-toolbar');
            if (toolbarEl && !toolbarEl.dataset.markupClickBound) {
                toolbarEl.dataset.markupClickBound = 'true';
                toolbarEl.addEventListener('click', function (e) {
                    var toolBtn = e.target.closest('.js-markup-tool');
                    if (toolBtn) {
                        var toolId = toolBtn.dataset.tool;
                        if (DrawingCanvas) DrawingCanvas.setActiveTool(toolId);
                        if (MarkupToolbar) MarkupToolbar.setActiveTool(toolId);
                        return;
                    }

                    var colorBtn = e.target.closest('.js-markup-color');
                    if (colorBtn) {
                        var colorName = colorBtn.dataset.colorName;
                        var colors = DrawingCanvas ? DrawingCanvas.getPresetColors() : [];
                        var color = null;
                        for (var i = 0; i < colors.length; i++) {
                            if (colors[i].name === colorName) { color = colors[i]; break; }
                        }
                        if (color) {
                            if (DrawingCanvas) DrawingCanvas.setActiveColor(color);
                            if (MarkupToolbar) MarkupToolbar.setActiveColor(colorName);
                        }
                    }
                });
            }
        });

        // Add tab change event listener for split panel visibility
        if (!_currentShell) {
            const gradedTabEl = document.getElementById('pdfGradedTab');
            if (gradedTabEl) {
                gradedTabEl.addEventListener('shown.bs.tab', () => {
                    // When graded tab is shown and split panel is active, refresh both lists
                    if (splitPanelActive) {
                        renderAnnotationsList();
                        renderAIAnnotationsList();
                    }
                });
            }
        }
    }

    // Initial setup if already open (unlikely on load but safe)
    if (!_currentShell && pdfPreviewModalEl && pdfPreviewModalEl.classList.contains('show')) {
        window.addEventListener('resize', handleResize);
    }

    function withCsrf(headers = {}) {
        // Delegate to utils module if available
        if (UtilsModule.withCsrf) {
            return UtilsModule.withCsrf(headers);
        }
        // Fallback: Read CSRF token fresh on each request
        const csrfElement = document.querySelector('meta[name="csrf-token"]');
        const token = csrfElement ? csrfElement.content : null;
        if (token) {
            return { ...headers, 'X-CSRFToken': token };
        }
        return headers;
    }

    // =========================================================================
    // PDF Viewer Integration - Uses extracted pdf-viewer.js module
    // =========================================================================

    /**
     * Ensure PDF viewers are initialized using the extracted PDFViewer module.
     * The PDFViewer class has been extracted to pdf-preview-modal/pdf-viewer.js
     * for better modularity and reduced file size.
     */
    function ensureModalViewers() {
        if (_currentDocCtrl) return _currentDocCtrl.ensureViewers();

        // Fallback: original monolith code (used when document controller not loaded)
        const ViewerModule = window.PdfPreviewModalViewer;
        if (!ViewerModule || !ViewerModule.PDFViewer) {
            console.error('[PDF-PREVIEW] PDFViewer module not loaded. Ensure pdf-viewer.js is included before pdf-preview-modal.js');
            return false;
        }

        const ViewerClass = ViewerModule.PDFViewer;
        const resolvePdfjsLib = ViewerModule.resolvePdfjsLib;

        const lib = resolvePdfjsLib();
        if (!lib) {
            return false;
        }

        if (!window.__pdfOriginalViewer) {
            window.__pdfOriginalViewer = new ViewerClass('pdfOriginalCanvas', 'pdfOriginalContainer', 'pdfOriginalLoading', 'pdfOriginalControls');
        }

        if (!window.__pdfGradedViewer) {
            window.__pdfGradedViewer = new ViewerClass('pdfGradedCanvas', 'pdfGradedContainer', 'pdfGradedLoading', 'pdfGradedControls');
            // Set up callbacks for annotation page synchronization
            window.__pdfGradedViewer.onAnnotationsPageChange((pageIdx) => {
                if (currentAnnotationsPage !== pageIdx) {
                    currentAnnotationsPage = pageIdx;
                    // Debounce annotation list updates
                    if (typeof renderAnnotationsList === 'function') {
                        clearTimeout(window._annotationListUpdateTimer);
                        window._annotationListUpdateTimer = setTimeout(() => {
                            renderAnnotationsList();
                        }, 150);
                    }
                }
            });
            window.__pdfGradedViewer.onPageRendered((pageNum) => {
                if (typeof renderAnnotationsForPage === 'function') {
                    renderAnnotationsForPage(pageNum);
                }
                refreshMarkupFromAnnotations();
            });
            window.__pdfGradedViewer.onSliderSync((viewer) => {
                syncGradedPageSlider(viewer);
            });
        }
        return true;
    }

    // Annotation management for graded PDF
    let currentSubmissionId = null;
    let currentAssignmentId = null;
    let currentCanvasUserName = null;
    let annotationsData = {};

    // =========================================================================
    // ModeAdapter-backed annotation CRUD wrappers
    // =========================================================================
    //
    // _annotationAdapter is initialised when the modal opens (see openPDFPreview).
    // These thin wrappers exist so that the ~23 annotation fetch call-sites do not
    // each need branching logic for server vs local mode.
    // =========================================================================

    let _annotationAdapter = null;
    let _annotationAdapterError = null;

    /** @returns {boolean} Whether the current wizard session is in offline mode */
    function _isOfflineMode() {
        return window.__WIZARD_MODE === 'offline';
    }

    function _resolveAnnotationAssignmentMode() {
        const previewHost = window.AEMSPdfAnnotatorHost || null;
        return previewHost?.mode
            || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('aems_assignment_mode'))
            || 'server';
    }

    async function _buildAnnotationAdapter() {
        const previewHost = window.AEMSPdfAnnotatorHost || null;
        if (previewHost && typeof previewHost.createDefaultHostApi === 'function') {
            const hostApi = await previewHost.createDefaultHostApi();
            if (hostApi) {
                _annotationAdapterError = null;
                return hostApi;
            }
        }
        _annotationAdapterError = 'Annotation routing is unavailable because no host API was provided.';
        return null;
    }

    function _requireAnnotationAdapter() {
        if (_annotationAdapter) {
            return _annotationAdapter;
        }
        throw new Error(_annotationAdapterError || 'Annotation routing is unavailable. Reload the page and try again.');
    }

    /**
     * List all annotations for the current submission.
     * @returns {Promise<Object>} Parsed JSON response with annotations data
     */
    async function listAnnotationsRequest() {
        return _requireAnnotationAdapter().listAnnotations(currentAssignmentId, currentSubmissionId, {
            offline: _isOfflineMode()
        });
    }

    /**
     * Get annotation version hash for polling.
     * @returns {Promise<Object>} Parsed JSON with version info
     */
    async function getAnnotationsVersionRequest() {
        return _requireAnnotationAdapter().getAnnotationsVersion(
            currentAssignmentId,
            currentSubmissionId
        );
    }

    /**
     * Create a new annotation.
     * @param {Object} body - Raw annotation body (will be JSON-stringified by adapter)
     * @returns {Promise<Object>} Parsed JSON response with created annotation
     */
    async function createAnnotationRequest(body) {
        return _requireAnnotationAdapter().createAnnotation(currentAssignmentId, currentSubmissionId, body, {
            offline: _isOfflineMode()
        });
    }

    /**
     * Update an existing annotation.
     * @param {string} annotationId - The annotation identifier (already resolved via buildApiAnnotationIdentifier)
     * @param {Object} body - Raw update body (will be JSON-stringified by adapter)
     * @returns {Promise<Object>} Parsed JSON response with updated annotation
     */
    async function updateAnnotationRequest(annotationId, body) {
        return _requireAnnotationAdapter().updateAnnotation(currentAssignmentId, currentSubmissionId, annotationId, body, {
            offline: _isOfflineMode()
        });
    }

    /**
     * Delete an annotation.
     * @param {string} annotationId - The annotation identifier (already resolved via buildApiAnnotationIdentifier)
     * @returns {Promise<Object>} Parsed JSON response confirming deletion
     */
    async function deleteAnnotationRequest(annotationId) {
        return _requireAnnotationAdapter().deleteAnnotation(currentAssignmentId, currentSubmissionId, annotationId, {
            offline: _isOfflineMode()
        });
    }
    let currentAnnotationsPage = 0;
    // Track if the browser forced exit from real fullscreen while editing; we keep the pseudo-fullscreen styling active.
    let _forcedExitDuringEdit = false;
    let editingAnnotationId = null;
    let _savingAnnotationId = null; // Track annotation being saved to prevent blur handler race condition
    let _updatingPriorityId = null; // Track annotation having priority updated to prevent blur handler deletion
    let _isDraggingAnnotation = false; // FIX Issue #32: Track when annotation is being dragged to prevent deletion
    // FIX Issue #27: Track currently selected annotation to preserve highlight after scroll/re-render
    let selectedAnnotation = { pageIdx: null, identifier: null };
    let dragHandlers = { mousemove: null, mouseup: null };

    // Smart polling for annotation synchronization across browser sessions
    let annotationsPollInterval = null;
    let currentAnnotationsVersion = null;
    let skipNextPollingCycle = false; // Skip reload for our own changes
    const ANNOTATIONS_POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

    function _startAnnotationsPolling() {
        // Delegate to version-sync module if available
        if (_currentVersionSync) { _currentVersionSync.start(); return; }
        if (annotationsPollInterval) return; // Already polling
        // Set to non-null immediately to prevent race condition with multiple startups
        annotationsPollInterval = true;
        annotationsPollInterval = setInterval(checkAnnotationsVersion, ANNOTATIONS_POLL_INTERVAL_MS);
    }

    function stopAnnotationsPolling() {
        // Delegate to version-sync module if available
        if (_currentVersionSync) { _currentVersionSync.stop(); return; }
        if (annotationsPollInterval) {
            clearInterval(annotationsPollInterval);
            annotationsPollInterval = null;
        }
        currentAnnotationsVersion = null;
        skipNextPollingCycle = false;
    }

    // Call this after any local annotation change to prevent self-triggered reloads
    function markLocalAnnotationChange() {
        // Delegate to version-sync module if available
        if (_currentVersionSync) {
            _currentVersionSync.markLocalChange();
            // Immediately fetch the new version to prevent subsequent poll cycles
            // from treating our own change as external
            if (_annotationAdapter && currentSubmissionId) {
                getAnnotationsVersionRequest().then(function (data) {
                    if (data && data.version) {
                        _currentVersionSync.markLocalChange(data.version);
                    }
                }).catch(function () { /* ignore */ });
            }
            return;
        }
        skipNextPollingCycle = true;
    }

    async function checkAnnotationsVersion() {
        if (!currentSubmissionId || !_annotationAdapter) return;
        try {
            const data = await getAnnotationsVersionRequest();
            if (!data.success) return;

            // Compare version - if changed and NOT our own change, reload annotations
            if (currentAnnotationsVersion !== null && data.version !== currentAnnotationsVersion) {
                if (skipNextPollingCycle) {
                    // This is our own change - just update version, don't reload
                    skipNextPollingCycle = false;
                } else {
                    // This is a change from another session - reload
                    await loadAnnotations(currentSubmissionId, currentAssignmentId);
                }
            }
            currentAnnotationsVersion = data.version;
        } catch {
            // Silently ignore polling errors to avoid spamming console
        }
    }

    function setupLabelTooltipEvents(label, fullText) {
        // CRITICAL: Prevent duplicate event listener registration
        if (label._tooltipEventsSetup) {
            // Update stored full text in case it changed
            label.dataset.fullText = fullText;
            return;
        }
        label._tooltipEventsSetup = true;

        // Store full text for retrieval
        label.dataset.fullText = fullText;

        // -- State machine: COLLAPSED -> EXPANDED (read-only) -> EDITING --
        // No timers for click/dblclick disambiguation. State drives behavior.
        let collapseTimer = null;

        function cancelCollapseTimer() {
            if (collapseTimer) {
                clearTimeout(collapseTimer);
                collapseTimer = null;
            }
        }

        // Helper: enter edit mode (shared by click-on-expanded and dblclick-on-collapsed)
        function enterEditFromLabel() {
            cancelCollapseTimer();
            label.dataset.expandSource = 'click'; // pin it

            // Collapse any other expanded labels first
            document.querySelectorAll('.annotation-label.label-expanded').forEach(otherLabel => {
                if (otherLabel !== label) {
                    collapseInlineLabel(otherLabel);
                }
            });

            // Get annotation details from parent marker
            const marker = label.closest('.annotation-marker');
            const pageIdx = parseInt(marker?.dataset.pageIdx || marker?.dataset.annotationPage || '0');
            const identifier = marker?.dataset.identifier ||
                marker?.dataset.annotationRequestId ||
                marker?.dataset.annotationIdentifier ||
                marker?.dataset.annotationXref;

            // Enter inline edit mode on PDF
            expandInlineLabelEdit(label);

            // SYNC: Also enter edit mode in sidebar
            if (identifier) {
                const domId = `ann-${pageIdx}-${identifier}`;
                editingAnnotationId = domId;
                renderAnnotationsList();

                setTimeout(() => {
                    const textarea = document.getElementById(`edit-annotation-text-${identifier}`);
                    if (textarea) {
                        setupTextareaAutoResize(textarea);
                        // Don't focus sidebar textarea - keep focus on PDF inline editor
                    }
                }, 100);

                highlightAnnotationSelection(pageIdx, identifier);
            }
        }

        // CLICK: State-dependent, no delay
        label.addEventListener('click', (e) => {
            e.stopPropagation();

            // EDITING -> do nothing (let textarea handle clicks)
            if (label.classList.contains('label-editing')) {
                return;
            }

            // EXPANDED (read-only) -> enter edit mode
            if (label.classList.contains('label-expanded')) {
                enterEditFromLabel();
                return;
            }

            // COLLAPSED -> expand read-only (pinned, won't collapse on mouseleave)
            cancelCollapseTimer();
            label.dataset.expandSource = 'click';

            // Collapse any other expanded labels first
            document.querySelectorAll('.annotation-label.label-expanded').forEach(otherLabel => {
                if (otherLabel !== label) {
                    collapseInlineLabel(otherLabel);
                }
            });

            expandInlineLabelReadOnly(label);

            // Highlight the annotation
            const pageIdx = parseInt(label.closest('.annotation-marker')?.dataset.pageIdx || '0');
            const identifier = label.closest('.annotation-marker')?.dataset.identifier;
            if (identifier) {
                highlightAnnotationSelection(pageIdx, identifier);
            }
        });

        // DBLCLICK: Always enter edit mode (shortcut from any non-editing state)
        label.addEventListener('dblclick', (e) => {
            e.stopPropagation();

            if (label.classList.contains('label-editing')) {
                return;
            }

            enterEditFromLabel();
        });

        // MOUSEENTER: Expand (read-only) after short delay if collapsed
        let hoverExpandTimer = null;
        label.addEventListener('mouseenter', () => {
            cancelCollapseTimer();

            if (label.classList.contains('label-expanded')) return;

            hoverExpandTimer = setTimeout(() => {
                hoverExpandTimer = null;
                if (!label.classList.contains('label-expanded') && label.matches(':hover')) {
                    label.dataset.expandSource = 'hover';
                    expandInlineLabelReadOnly(label);
                }
            }, 800);
        });

        // MOUSELEAVE: Collapse after 200ms grace, only if hover-expanded (not click-pinned or editing)
        label.addEventListener('mouseleave', () => {
            if (hoverExpandTimer) { clearTimeout(hoverExpandTimer); hoverExpandTimer = null; }
            // Never collapse if editing
            if (label.classList.contains('label-editing')) return;

            // Never collapse if click-pinned
            if (label.dataset.expandSource === 'click') return;

            // Only collapse hover-expanded labels, with grace period
            if (label.classList.contains('label-expanded')) {
                collapseTimer = setTimeout(() => {
                    collapseTimer = null;
                    if (!label.matches(':hover') && !label.classList.contains('label-editing') && label.dataset.expandSource !== 'click') {
                        collapseInlineLabel(label);
                    }
                }, 200);
            }
        });

        // Click outside: collapse click-pinned labels
        const outsideClickHandler = (e) => {
            if (label.dataset.expandSource !== 'click') return;
            if (label.classList.contains('label-editing')) return;
            if (label.contains(e.target)) return;
            // Also don't collapse if clicking on the parent marker
            if (label.closest('.annotation-marker')?.contains(e.target)) return;

            collapseInlineLabel(label);
        };

        // Store for cleanup (annotation re-render removes markers from DOM)
        if (!label._outsideClickHandler) {
            document.addEventListener('click', outsideClickHandler);
            label._outsideClickHandler = outsideClickHandler;
        }
    }

    // Track currently editing inline label (for escape handling in fullscreen)
    let inlineEditingLabel = null;

    function resolveExpandedLabelMaxWidth(label) {
        const marker = label?.closest('.annotation-marker');
        const overlay = marker?.parentElement;
        const container = document.getElementById('pdfGradedContainer');
        const overlayWidth = overlay?.getBoundingClientRect?.().width || 0;
        const containerWidth = container?.getBoundingClientRect?.().width || 0;
        const availableWidth = overlayWidth || containerWidth;
        if (!availableWidth) {
            return 420;
        }
        return Math.max(180, Math.min(420, Math.floor(availableWidth - 24)));
    }

    function composeLabelTransform(anchorTransform, dx = 0, dy = 0) {
        const safeAnchor = anchorTransform || 'translate(2px, 2px)';
        const transforms = [safeAnchor];
        if (dx || dy) {
            transforms.push(`translate(${Math.round(dx)}px, ${Math.round(dy)}px)`);
        }
        return transforms.join(' ');
    }

    function readStoredLabelOffset(label) {
        return {
            dx: Number.parseFloat(label?.dataset?.residualDx || '0') || 0,
            dy: Number.parseFloat(label?.dataset?.residualDy || '0') || 0,
        };
    }

    function applyStoredLabelTransform(label, dx, dy) {
        if (!label) return;
        const anchorTransform = label.dataset.anchorTransform || label.dataset.baseTransform || 'translate(2px, 2px)';
        const transform = composeLabelTransform(anchorTransform, dx, dy);
        label.dataset.residualDx = String(Math.round(dx));
        label.dataset.residualDy = String(Math.round(dy));
        label.dataset.baseTransform = transform;
        label.style.transform = transform;
    }

    function resetStoredLabelOffset(label) {
        if (!label) return;
        delete label.dataset.residualDx;
        delete label.dataset.residualDy;
        const anchorTransform = label.dataset.anchorTransform || label.dataset.baseTransform || 'translate(2px, 2px)';
        label.dataset.baseTransform = anchorTransform;
        label.style.transform = anchorTransform;
    }

    function focusElementWithoutScroll(element) {
        if (!element || typeof element.focus !== 'function') {
            return;
        }
        try {
            element.focus({ preventScroll: true });
        } catch (_error) {
            element.focus();
        }
    }

    function parseTranslatePair(transform) {
        const match = String(transform || '').match(/translate\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\s*\)/);
        if (!match) {
            return { x: 2, y: 2 };
        }
        return {
            x: Number.parseFloat(match[1]) || 0,
            y: Number.parseFloat(match[2]) || 0,
        };
    }

    function getRelativeRect(element, originRect) {
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left - originRect.left,
            top: rect.top - originRect.top,
            right: rect.right - originRect.left,
            bottom: rect.bottom - originRect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function resolveLabelClampRect(overlayRect, options = {}) {
        const clampRect = {
            left: overlayRect.left,
            top: overlayRect.top,
            right: overlayRect.right,
            bottom: overlayRect.bottom,
        };

        if (!options || !options.respectViewport) {
            return clampRect;
        }

        const container = document.getElementById('pdfGradedContainer');
        const containerRect = container?.getBoundingClientRect?.();
        if (!containerRect) {
            return clampRect;
        }

        return {
            left: Math.max(clampRect.left, containerRect.left),
            top: Math.max(clampRect.top, containerRect.top),
            right: Math.min(clampRect.right, containerRect.right),
            bottom: Math.min(clampRect.bottom, containerRect.bottom),
        };
    }

    function clampLabelToOverlayBounds(label, overlay, options = {}) {
        if (!label || !overlay) return;

        const overlayRect = overlay.getBoundingClientRect();
        const clampRect = resolveLabelClampRect(overlayRect, options);
        if (clampRect.right <= clampRect.left || clampRect.bottom <= clampRect.top) {
            return;
        }
        const labelRect = label.getBoundingClientRect();
        const margin = 8;
        let dx = 0;
        let dy = 0;

        if (labelRect.left < clampRect.left + margin) {
            dx = clampRect.left + margin - labelRect.left;
        } else if (labelRect.right > clampRect.right - margin) {
            dx = clampRect.right - margin - labelRect.right;
        }

        if (labelRect.top < clampRect.top + margin) {
            dy = clampRect.top + margin - labelRect.top;
        } else if (labelRect.bottom > clampRect.bottom - margin) {
            dy = clampRect.bottom - margin - labelRect.bottom;
        }

        const currentOffset = readStoredLabelOffset(label);
        if (dx || dy) {
            applyStoredLabelTransform(
                label,
                currentOffset.dx + dx,
                currentOffset.dy + dy,
            );
            return;
        }

        applyStoredLabelTransform(label, currentOffset.dx, currentOffset.dy);
    }

    function clearPendingInlineLabelReposition(label) {
        if (!label?._repositionTimeouts) return;
        label._repositionTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
        label._repositionTimeouts = [];
    }

    function getLabelPlacementBounds(overlay, overlayRect, labelWidth, labelHeight, options = {}) {
        const clampRect = resolveLabelClampRect(overlayRect, options);

        if (clampRect.right <= clampRect.left || clampRect.bottom <= clampRect.top) {
            return {
                left: 0,
                top: 0,
                right: overlayRect.width,
                bottom: overlayRect.height,
            };
        }

        return {
            left: Math.max(0, clampRect.left - overlayRect.left),
            top: Math.max(0, clampRect.top - overlayRect.top),
            right: Math.min(overlayRect.width, clampRect.right - overlayRect.left),
            bottom: Math.min(overlayRect.height, clampRect.bottom - overlayRect.top),
        };
    }

    function getBoundsOverflow(left, top, width, height, bounds) {
        let overflow = 0;
        if (left < bounds.left) {
            overflow += bounds.left - left;
        }
        if (top < bounds.top) {
            overflow += bounds.top - top;
        }
        if (left + width > bounds.right) {
            overflow += left + width - bounds.right;
        }
        if (top + height > bounds.bottom) {
            overflow += top + height - bounds.bottom;
        }
        return overflow;
    }

    function buildLabelPosition(
        name,
        markerLeft,
        markerTop,
        offsetLeft,
        offsetTop,
    ) {
        const left = markerLeft + offsetLeft;
        const top = markerTop + offsetTop;
        return {
            name,
            left,
            top,
            css: {
                top: '0',
                left: '0',
                bottom: 'auto',
                right: 'auto',
                transform: `translate(${Math.round(offsetLeft)}px, ${Math.round(offsetTop)}px)`,
            },
        };
    }

    function buildNamedLabelPosition(
        name,
        markerLeft,
        markerTop,
        markerWidth,
        markerHeight,
        labelWidth,
        labelHeight,
        gap,
    ) {
        const centerOffsetX = (markerWidth - labelWidth) / 2;
        const centerOffsetY = (markerHeight - labelHeight) / 2;
        switch (name) {
            case 'right-center':
                return buildLabelPosition(name, markerLeft, markerTop, markerWidth + gap, centerOffsetY);
            case 'left-center':
                return buildLabelPosition(name, markerLeft, markerTop, -(labelWidth + gap), centerOffsetY);
            case 'bottom-right':
                return buildLabelPosition(name, markerLeft, markerTop, markerWidth + gap, markerHeight + gap);
            case 'top-right':
                return buildLabelPosition(name, markerLeft, markerTop, markerWidth + gap, -(labelHeight + gap));
            case 'bottom-left':
                return buildLabelPosition(name, markerLeft, markerTop, -(labelWidth + gap), markerHeight + gap);
            case 'top-left':
                return buildLabelPosition(name, markerLeft, markerTop, -(labelWidth + gap), -(labelHeight + gap));
            case 'top-center':
                return buildLabelPosition(name, markerLeft, markerTop, centerOffsetX, -(labelHeight + gap));
            case 'bottom-center':
                return buildLabelPosition(name, markerLeft, markerTop, centerOffsetX, markerHeight + gap);
            default:
                return null;
        }
    }

    function getRectOverlapArea(rect1, rect2, gap = 0) {
        const xOverlap = Math.max(
            0,
            Math.min(rect1.right + gap, rect2.right + gap) - Math.max(rect1.left - gap, rect2.left - gap),
        );
        const yOverlap = Math.max(
            0,
            Math.min(rect1.bottom + gap, rect2.bottom + gap) - Math.max(rect1.top - gap, rect2.top - gap),
        );
        return xOverlap * yOverlap;
    }

    function cloneRelativeRect(rect) {
        return {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
    }

    function createRelativeRect(left, top, width, height) {
        return {
            left,
            top,
            right: left + width,
            bottom: top + height,
            width,
            height,
        };
    }

    function clampRelativeRectToBounds(rect, bounds, margin = 0) {
        const minLeft = bounds.left + margin;
        const maxLeft = bounds.right - rect.width - margin;
        const minTop = bounds.top + margin;
        const maxTop = bounds.bottom - rect.height - margin;
        const left = Math.min(Math.max(rect.left, minLeft), Math.max(minLeft, maxLeft));
        const top = Math.min(Math.max(rect.top, minTop), Math.max(minTop, maxTop));
        return createRelativeRect(left, top, rect.width, rect.height);
    }

    function buildProtectedCornerRect(overlayRect) {
        return {
            left: 0,
            top: 0,
            right: Math.min(overlayRect.width * 0.28, 180),
            bottom: Math.min(overlayRect.height * 0.16, 120),
        };
    }

    function deriveMarkerTaskGroupKey(marker) {
        if (!marker) {
            return '';
        }

        const directTaskId = String(marker.dataset.annotationTaskId || '').trim();
        if (directTaskId) {
            return directTaskId;
        }

        const checkId = String(marker.dataset.annotationCheckId || '').trim();
        if (checkId) {
            const match = checkId.match(/^(Q\d+)/i);
            if (match) {
                return match[1].toUpperCase();
            }
            return checkId;
        }

        const labelText = String(marker.querySelector('.annotation-label')?.dataset?.fullText || marker.querySelector('.annotation-label')?.textContent || '').trim();
        const labelMatch = labelText.match(/^(Q\d+)\s*:/i);
        if (labelMatch) {
            return labelMatch[1].toUpperCase();
        }

        return '';
    }

    function isSummaryPlacementEntry(entry) {
        const marker = entry?.label?.closest?.('.annotation-marker');
        const checkId = String(marker?.dataset?.annotationCheckId || '').trim();
        return checkId.endsWith('_SUMMARY');
    }

    function compareTaskPlacementEntries(a, b) {
        const aIsSummary = isSummaryPlacementEntry(a);
        const bIsSummary = isSummaryPlacementEntry(b);
        if (aIsSummary !== bIsSummary) {
            return aIsSummary ? 1 : -1;
        }
        if (Math.abs(a.markerRect.top - b.markerRect.top) > 1) {
            return a.markerRect.top - b.markerRect.top;
        }
        return a.markerRect.left - b.markerRect.left;
    }

    function buildTaskPlacementBands(entries, pageBounds, margin = 0) {
        const summaryAnchors = entries
            .filter(entry => entry.taskGroupKey)
            .map(entry => ({
                key: entry.taskGroupKey,
                centerY: entry.markerRect.top + (entry.markerRect.height / 2),
            }));

        entries.forEach(entry => {
            if (entry.taskGroupKey) {
                return;
            }

            if (summaryAnchors.length) {
                const markerCenterY = entry.markerRect.top + (entry.markerRect.height / 2);
                const nearestSummary = summaryAnchors
                    .slice()
                    .sort((a, b) => Math.abs(a.centerY - markerCenterY) - Math.abs(b.centerY - markerCenterY))[0];
                if (nearestSummary?.key) {
                    entry.taskGroupKey = nearestSummary.key;
                    return;
                }
            }

            const pageKey = entry.label.closest('.annotation-marker')?.dataset.annotationPage
                || entry.label.closest('.annotation-marker')?.dataset.pageIdx
                || '0';
            entry.taskGroupKey = `page-${pageKey}`;
        });

        const groups = new Map();
        entries.forEach(entry => {
            const groupKey = entry.taskGroupKey || `page-${entry.markerRect.top}`;
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    key: groupKey,
                    entries: [],
                    minTop: entry.markerRect.top,
                    maxBottom: entry.markerRect.bottom,
                });
            }

            const group = groups.get(groupKey);
            group.entries.push(entry);
            group.minTop = Math.min(group.minTop, entry.markerRect.top, entry.baseRect.top);
            group.maxBottom = Math.max(group.maxBottom, entry.markerRect.bottom, entry.baseRect.bottom);
        });

        const orderedGroups = Array.from(groups.values()).sort((a, b) => a.minTop - b.minTop);
        const bandByKey = new Map();
        const seamPadding = Math.max(0, Math.round(margin));

        orderedGroups.forEach((group, index) => {
            const previous = orderedGroups[index - 1];
            const next = orderedGroups[index + 1];
            let top = pageBounds.top;
            let bottom = pageBounds.bottom;
            let midpointTop = pageBounds.top;
            let midpointBottom = pageBounds.bottom;

            if (previous) {
                midpointTop = Math.ceil((previous.maxBottom + group.minTop) / 2);
                top = Math.max(pageBounds.top, midpointTop + seamPadding);
            }

            if (next) {
                midpointBottom = Math.floor((group.maxBottom + next.minTop) / 2);
                bottom = Math.min(pageBounds.bottom, midpointBottom - seamPadding);
            }

            // Fall back to midpoint-only bands if the desired seam would collapse a tight group.
            if (bottom <= top) {
                top = Math.max(pageBounds.top, midpointTop);
                bottom = Math.min(pageBounds.bottom, Math.max(midpointBottom, top + 1));
            }

            bandByKey.set(group.key, {
                left: pageBounds.left,
                right: pageBounds.right,
                top,
                bottom: Math.max(top + 1, bottom),
            });
        });

        return bandByKey;
    }

    function nudgeRelativeRectAwayFromProtectedCorner(rect, bounds, overlayRect, margin = 0) {
        const adjusted = clampRelativeRectToBounds(rect, bounds, margin);
        const protectedCorner = buildProtectedCornerRect(overlayRect);
        const overlapArea = getRectOverlapArea(adjusted, protectedCorner, 0);
        if (!overlapArea) {
            return adjusted;
        }

        const padding = 10;
        const candidates = [];
        const pushRight = protectedCorner.right + padding - adjusted.left;
        const pushDown = protectedCorner.bottom + padding - adjusted.top;

        if (pushRight > 0) {
            candidates.push(
                clampRelativeRectToBounds(
                    createRelativeRect(
                        adjusted.left + pushRight,
                        adjusted.top,
                        adjusted.width,
                        adjusted.height,
                    ),
                    bounds,
                    margin,
                ),
            );
        }

        if (pushDown > 0) {
            candidates.push(
                clampRelativeRectToBounds(
                    createRelativeRect(
                        adjusted.left,
                        adjusted.top + pushDown,
                        adjusted.width,
                        adjusted.height,
                    ),
                    bounds,
                    margin,
                ),
            );
        }

        candidates.push(adjusted);

        let bestRect = adjusted;
        let bestScore = Number.POSITIVE_INFINITY;
        candidates.forEach(candidate => {
            const protectedOverlap = getRectOverlapArea(candidate, protectedCorner, 0);
            const drift =
                Math.abs(candidate.left - rect.left) +
                Math.abs(candidate.top - rect.top);
            const score = protectedOverlap * 1000 + drift;
            if (score < bestScore) {
                bestScore = score;
                bestRect = candidate;
            }
        });

        return bestRect;
    }

    function scoreResidualPlacementRect(rect, referenceRect, occupiedRects, bounds, overlayRect) {
        const overlapPenalty = occupiedRects.reduce(
            (total, occupiedRect) => total + getRectOverlapArea(rect, occupiedRect, 0),
            0,
        );
        const boundsOverflow = getBoundsOverflow(
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            bounds,
        );
        const protectedPenalty = getRectOverlapArea(
            rect,
            buildProtectedCornerRect(overlayRect),
            0,
        );
        const topBandLimit = Math.min(overlayRect.height * 0.14, 96);
        const topBandPenalty = rect.top < topBandLimit
            ? Math.ceil((topBandLimit - rect.top) * 12)
            : 0;
        const driftPenalty = Math.abs(rect.left - referenceRect.left) + Math.abs(rect.top - referenceRect.top);
        return overlapPenalty * 1000 + boundsOverflow * 500 + protectedPenalty * 24 + topBandPenalty + driftPenalty;
    }

    function resolveResidualLabelOverlaps(overlay) {
        if (!overlay) return;

        const overlayRect = overlay.getBoundingClientRect();
        const pageBounds = {
            left: 0,
            top: 0,
            right: overlayRect.width,
            bottom: overlayRect.height,
        };
        const labelGap = 8;
        const margin = 8;
        const labels = Array.from(overlay.querySelectorAll('.annotation-label'))
            .filter(label => label && label.offsetParent !== null);

        if (labels.length < 2) {
            return;
        }

        labels.forEach(label => {
            resetStoredLabelOffset(label);
        });
        const anchorEntries = labels.map(label => {
            const labelRect = label.getBoundingClientRect();
            const marker = label.closest('.annotation-marker');
            const markerRect = marker?.getBoundingClientRect();
            const anchorTransform = label.dataset.anchorTransform || label.dataset.baseTransform || 'translate(2px, 2px)';
            const anchorOffset = parseTranslatePair(anchorTransform);
            const rect = markerRect
                ? createRelativeRect(
                    markerRect.left - overlayRect.left + anchorOffset.x,
                    markerRect.top - overlayRect.top + anchorOffset.y,
                    labelRect.width,
                    labelRect.height,
                )
                : getRelativeRect(label, overlayRect);
            const adjustedRect = nudgeRelativeRectAwayFromProtectedCorner(
                rect,
                pageBounds,
                overlayRect,
                margin,
            );
            return {
                label,
                baseRect: adjustedRect,
                placedRect: cloneRelativeRect(adjustedRect),
                bounds: pageBounds,
                markerRect: markerRect
                    ? createRelativeRect(
                        markerRect.left - overlayRect.left,
                        markerRect.top - overlayRect.top,
                        markerRect.width,
                        markerRect.height,
                    )
                    : cloneRelativeRect(adjustedRect),
                taskGroupKey: deriveMarkerTaskGroupKey(marker),
            };
        });

        const taskBands = buildTaskPlacementBands(anchorEntries, pageBounds, margin);
        anchorEntries.forEach(entry => {
            entry.bounds = taskBands.get(entry.taskGroupKey) || pageBounds;
            entry.baseRect = clampRelativeRectToBounds(entry.baseRect, entry.bounds, margin);
            entry.placedRect = cloneRelativeRect(entry.baseRect);
        });

        function horizontalOverlap(rectA, rectB) {
            return Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left));
        }

        function sharesLane(rectA, rectB) {
            const overlap = horizontalOverlap(rectA, rectB);
            const minWidth = Math.min(rectA.width, rectB.width);
            const verticalDistance = Math.abs(rectA.top - rectB.top);
            return (
                verticalDistance <= 96 &&
                (overlap >= 30 || overlap >= minWidth * 0.25)
            );
        }

        function sharesTaskGroup(entryA, entryB) {
            return (entryA.taskGroupKey || '') === (entryB.taskGroupKey || '');
        }

        const visited = new Set();
        const components = [];

        anchorEntries.forEach((entry) => {
            if (visited.has(entry.label)) {
                return;
            }
            const queue = [entry];
            const component = [];
            visited.add(entry.label);

            while (queue.length) {
                const current = queue.shift();
                component.push(current);
                anchorEntries.forEach((candidate) => {
                    if (visited.has(candidate.label)) {
                        return;
                    }
                    if (sharesTaskGroup(current, candidate) && sharesLane(current.baseRect, candidate.baseRect)) {
                        visited.add(candidate.label);
                        queue.push(candidate);
                    }
                });
            }

            components.push(component);
        });

        components.forEach(component => {
            if (component.length < 2) {
                return;
            }

            const placements = component
                .slice()
                .sort(compareTaskPlacementEntries)
                .map(entry => ({
                    entry,
                    top: Math.max(entry.baseRect.top, entry.bounds.top + margin),
                }));

            for (let index = 1; index < placements.length; index += 1) {
                const previous = placements[index - 1];
                placements[index].top = Math.max(
                    placements[index].top,
                    previous.top + previous.entry.baseRect.height + labelGap,
                );
            }

            const maxBottom = Math.max(...placements.map(item => item.top + item.entry.baseRect.height));
            const componentBottomLimit = Math.min(
                ...placements.map(item => item.entry.bounds.bottom - margin),
            );
            const overflow = Math.max(0, maxBottom - componentBottomLimit);
            if (overflow > 0) {
                const maxUpwardShift = Math.max(
                    0,
                    Math.min(
                        ...placements.map(item => item.top - (item.entry.bounds.top + margin)),
                    ),
                );
                const shift = Math.min(overflow, maxUpwardShift);
                if (shift > 0) {
                    placements.forEach(item => {
                        item.top -= shift;
                    });
                }
            }

            placements.forEach(({ entry, top }) => {
                entry.placedRect = nudgeRelativeRectAwayFromProtectedCorner(
                    createRelativeRect(
                        entry.baseRect.left,
                        top,
                        entry.baseRect.width,
                        entry.baseRect.height,
                    ),
                    entry.bounds,
                    overlayRect,
                    margin,
                );
            });
        });

        function sharesResidualCluster(rectA, rectB) {
            const overlapArea = getRectOverlapArea(rectA, rectB, 0);
            const overlapWidth = horizontalOverlap(rectA, rectB);
            const minWidth = Math.min(rectA.width, rectB.width);
            const verticalGap = Math.max(
                0,
                Math.max(rectA.top, rectB.top) - Math.min(rectA.bottom, rectB.bottom),
            );
            return (
                overlapArea > 0 ||
                (
                    verticalGap <= 140 &&
                    (overlapWidth >= 20 || overlapWidth >= minWidth * 0.15)
                )
            );
        }

        function repackPlacedComponents() {
            const repackVisited = new Set();
            const repackComponents = [];

            anchorEntries.forEach(entry => {
                if (repackVisited.has(entry.label)) {
                    return;
                }
                const queue = [entry];
                const component = [];
                repackVisited.add(entry.label);

                while (queue.length) {
                    const current = queue.shift();
                    component.push(current);
                    anchorEntries.forEach(candidate => {
                        if (repackVisited.has(candidate.label)) {
                            return;
                        }
                        if (sharesTaskGroup(current, candidate) && sharesResidualCluster(current.placedRect, candidate.placedRect)) {
                            repackVisited.add(candidate.label);
                            queue.push(candidate);
                        }
                    });
                }

                repackComponents.push(component);
            });

            repackComponents.forEach(component => {
                if (component.length < 2) {
                    return;
                }

                const ordered = component
                    .slice()
                    .sort(compareTaskPlacementEntries);

                ordered.forEach((entry, index) => {
                    const previous = ordered[index - 1];
                    const top = index === 0
                        ? entry.placedRect.top
                        : Math.max(entry.placedRect.top, previous.placedRect.bottom + labelGap);
                    entry.placedRect = nudgeRelativeRectAwayFromProtectedCorner(
                        createRelativeRect(
                            entry.placedRect.left,
                            top,
                            entry.placedRect.width,
                            entry.placedRect.height,
                        ),
                        entry.bounds,
                        overlayRect,
                        margin,
                    );
                });

                const componentBottomLimit = Math.min(
                    ...ordered.map(entry => entry.bounds.bottom - margin),
                );
                const maxBottom = Math.max(...ordered.map(entry => entry.placedRect.bottom));
                const overflow = Math.max(0, maxBottom - componentBottomLimit);
                if (overflow > 0) {
                    const maxUpwardShift = Math.max(
                        0,
                        Math.min(
                            ...ordered.map(entry => entry.placedRect.top - (entry.bounds.top + margin)),
                        ),
                    );
                    const shift = Math.min(overflow, maxUpwardShift);
                    if (shift > 0) {
                        ordered.forEach(entry => {
                            entry.placedRect = nudgeRelativeRectAwayFromProtectedCorner(
                                createRelativeRect(
                                    entry.placedRect.left,
                                    entry.placedRect.top - shift,
                                    entry.placedRect.width,
                                    entry.placedRect.height,
                                ),
                                entry.bounds,
                                overlayRect,
                                margin,
                            );
                        });
                    }
                }
            });
        }

        function normalizeTaskGroupSpacing() {
            const groups = new Map();
            anchorEntries.forEach(entry => {
                const key = entry.taskGroupKey || 'page';
                if (!groups.has(key)) {
                    groups.set(key, []);
                }
                groups.get(key).push(entry);
            });

            groups.forEach(entries => {
                if (entries.length < 2) {
                    return;
                }

                const ordered = entries
                    .slice()
                    .sort(compareTaskPlacementEntries);

                ordered.forEach((entry, index) => {
                    const minTop = index === 0
                        ? entry.bounds.top + margin
                        : ordered[index - 1].placedRect.bottom + labelGap;
                    const top = Math.max(entry.placedRect.top, minTop);
                    entry.placedRect = nudgeRelativeRectAwayFromProtectedCorner(
                        createRelativeRect(
                            entry.placedRect.left,
                            top,
                            entry.placedRect.width,
                            entry.placedRect.height,
                        ),
                        entry.bounds,
                        overlayRect,
                        margin,
                    );
                });

                const groupBottomLimit = Math.min(
                    ...ordered.map(entry => entry.bounds.bottom - margin),
                );
                const overflow = Math.max(0, Math.max(...ordered.map(entry => entry.placedRect.bottom)) - groupBottomLimit);
                if (overflow > 0) {
                    const maxUpwardShift = Math.max(
                        0,
                        Math.min(
                            ...ordered.map((entry, index) => {
                                const minTop = index === 0
                                    ? entry.bounds.top + margin
                                    : ordered[index - 1].placedRect.bottom + labelGap;
                                return entry.placedRect.top - minTop;
                            }),
                        ),
                    );
                    const shift = Math.min(overflow, maxUpwardShift);
                    if (shift > 0) {
                        ordered.forEach(entry => {
                            entry.placedRect = createRelativeRect(
                                entry.placedRect.left,
                                entry.placedRect.top - shift,
                                entry.placedRect.width,
                                entry.placedRect.height,
                            );
                        });
                    }
                }

                ordered.forEach((entry, index) => {
                    if (index === 0) {
                        return;
                    }
                    const minTop = ordered[index - 1].placedRect.bottom + labelGap;
                    if (entry.placedRect.top < minTop) {
                        entry.placedRect = createRelativeRect(
                            entry.placedRect.left,
                            minTop,
                            entry.placedRect.width,
                            entry.placedRect.height,
                        );
                    }
                });
            });
        }

        repackPlacedComponents();
        repackPlacedComponents();
        normalizeTaskGroupSpacing();

        anchorEntries.forEach(entry => {
            const dx = entry.placedRect.left - entry.baseRect.left;
            const dy = entry.placedRect.top - entry.baseRect.top;
            applyStoredLabelTransform(entry.label, dx, dy);
            clampLabelToOverlayBounds(entry.label, overlay);
        });
    }

    function repositionInlineLabel(label) {
        if (!label) return;
        const marker = label.closest('.annotation-marker');
        const overlay = marker?.parentElement;
        if (!marker || !overlay) return;

        clearPendingInlineLabelReposition(label);

        const syncLabelBounds = () => {
            if (!label.isConnected || !marker.isConnected || !overlay.isConnected) return;
            const preserveCompactAnchor =
                label.classList.contains('label-expanded') ||
                label.classList.contains('label-editing');
            const preferredPosition = preserveCompactAnchor
                ? (label.dataset.compactPosition || label.dataset.position || '')
                : '';
            positionLabelOptimally(marker, label, overlay, undefined, {
                respectViewport: preserveCompactAnchor,
                preferredPosition,
                preservePreferredPosition: preserveCompactAnchor && !!preferredPosition,
            });
            if (preserveCompactAnchor) {
                clampLabelToOverlayBounds(label, overlay, {
                    respectViewport: true,
                });
            } else {
                resetStoredLabelOffset(label);
            }
        };

        requestAnimationFrame(() => {
            syncLabelBounds();
            requestAnimationFrame(() => {
                syncLabelBounds();
            });
        });

        label._repositionTimeouts = [120, 240, 400, 640, 900, 1200].map(delay => (
            setTimeout(() => {
                syncLabelBounds();
            }, delay)
        ));
    }

    function shouldIgnoreDetachedInlineBlur(textarea, label) {
        return !textarea || !label || !textarea.isConnected || !label.isConnected;
    }

    // Expand label to show full text (read-only mode)
    function expandInlineLabelReadOnly(label) {
        if (!label) return;

        // Get latest fullText from dataset (may have been updated after save)
        const fullText = label.dataset.fullText || 'No content';

        // Store original state
        label.dataset.originalText = label.dataset.originalText || '';
        label.dataset.originalMaxWidth = label.style.maxWidth;
        label.dataset.originalWhitespace = label.style.whiteSpace;
        label.dataset.originalOverflow = label.style.overflow;

        // Mark as expanded (but not editing)
        label.classList.add('label-expanded');
        label.classList.remove('label-editing');

        // Expand the label - fit content, with min-width only for long lines
        const maxWidthPx = resolveExpandedLabelMaxWidth(label);
        label.style.maxWidth = `${maxWidthPx}px`;
        // Check longest line - if any line >= 30 chars, use wider box for readability
        const longestLine = Math.max(...fullText.split('\n').map(line => line.length));
        label.style.minWidth = longestLine >= 30 ? '200px' : '';
        label.style.width = 'fit-content';
        label.style.whiteSpace = 'pre-wrap';
        label.style.overflow = 'visible';
        label.style.zIndex = '1000';

        // Show full text (read-only span)
        label.innerHTML = '';
        const textSpan = document.createElement('span');
        textSpan.className = 'inline-annotation-text';
        textSpan.textContent = fullText;
        textSpan.style.cssText = `
            display: block;
            word-wrap: break-word;
        `;
        label.appendChild(textSpan);
        repositionInlineLabel(label);
    }

    // Enter edit mode with textarea
    function expandInlineLabelEdit(label) {
        if (!label) return;

        // Get latest fullText from dataset (may have been updated after save)
        let fullText = label.dataset.fullText || '';

        // Check if original was placeholder
        const isPlaceholder = fullText === '' ||
            fullText === 'New comment...' ||
            fullText === 'New comment';

        // Store ORIGINAL fullText before any modifications (for detecting changes later)
        label.dataset.originalFullText = fullText;

        // Clear placeholder text - show empty textarea for new annotations
        if (isPlaceholder) {
            fullText = '';
        }

        // If not already expanded, store original state
        if (!label.classList.contains('label-expanded')) {
            label.dataset.originalText = label.dataset.originalText || '';
            label.dataset.originalMaxWidth = label.style.maxWidth;
            label.dataset.originalWhitespace = label.style.whiteSpace;
            label.dataset.originalOverflow = label.style.overflow;
        }

        // EDIT MODE: ALWAYS set full width for comfortable editing (even if already expanded from read-only)
        const maxWidthPx = resolveExpandedLabelMaxWidth(label);
        const editWidthPx = Math.min(300, maxWidthPx);
        label.style.maxWidth = `${maxWidthPx}px`;
        label.style.minWidth = `${editWidthPx}px`;
        label.style.width = `${editWidthPx}px`;
        label.style.whiteSpace = 'pre-wrap';
        label.style.overflow = 'visible';
        label.style.zIndex = '1000';

        // Mark as expanded AND editing
        label.classList.add('label-expanded');
        label.classList.add('label-editing');

        // Track for escape handling
        inlineEditingLabel = label;

        // Clear and add textarea
        label.innerHTML = '';

        const textarea = document.createElement('textarea');
        textarea.className = 'inline-annotation-editor';
        textarea.value = fullText;
        textarea.placeholder = 'Type your comment...';
        textarea.style.cssText = `
            width: 100%;
            min-height: 60px;
            max-height: 200px;
            border: none;
            outline: none;
            background: transparent;
            color: inherit;
            font-size: 12px;
            font-family: inherit;
            resize: vertical;
            padding: 0;
            margin: 0;
        `;

        // Auto-resize textarea based on content
        const autoResize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(200, textarea.scrollHeight) + 'px';
            repositionInlineLabel(label);
        };
        textarea.addEventListener('input', autoResize);

        // SYNC: Keep sidebar textarea in sync with inline editor
        // Get identifier from parent marker to find sidebar textarea
        const marker = label.closest('.annotation-marker');
        const identifier = marker?.dataset.identifier ||
            marker?.dataset.annotationRequestId ||
            marker?.dataset.annotationIdentifier ||
            marker?.dataset.annotationXref;

        if (identifier) {
            textarea.addEventListener('input', () => {
                // SEC-FIX: Try multiple ID formats to handle escaped/unescaped identifiers
                let sidebarTextarea = document.getElementById(`edit-annotation-text-${identifier}`);

                // Fallback: search by data attribute if direct ID lookup fails
                if (!sidebarTextarea) {
                    sidebarTextarea = document.querySelector(
                        `.auto-resize-textarea[id^="edit-annotation-text-"][id*="${CSS.escape(identifier)}"]`
                    );
                }

                if (sidebarTextarea && sidebarTextarea !== document.activeElement) {
                    sidebarTextarea.value = textarea.value;
                    // NOTE: Do NOT update label.dataset.fullText here - it should only be
                    // updated after successful save, so we can detect changes properly
                }
            });
        }

        // Handle save on blur
        textarea.addEventListener('blur', async () => {
            // Small delay to check if clicking on another element within the label
            setTimeout(async () => {
                if (shouldIgnoreDetachedInlineBlur(textarea, label)) {
                    return;
                }
                if (document.activeElement !== textarea && label.classList.contains('label-editing')) {
                    // CRITICAL FIX: Check if focus moved to the sidebar textarea for same annotation
                    // If so, DON'T collapse - keep BOTH editors open for bidirectional editing
                    if (identifier) {
                        // SEC-FIX: Use same robust matching as input handler
                        let sidebarTextarea = document.getElementById(`edit-annotation-text-${identifier}`);
                        if (!sidebarTextarea) {
                            sidebarTextarea = document.querySelector(
                                `.auto-resize-textarea[id^="edit-annotation-text-"][id*="${CSS.escape(identifier)}"]`
                            );
                        }
                        if (sidebarTextarea && document.activeElement === sidebarTextarea) {
                            // Sync value to sidebar in case user typed something in inline
                            if (textarea.value && textarea.value.trim()) {
                                sidebarTextarea.value = textarea.value;
                            }
                            // DON'T collapse - keep inline editor open for return focus
                            return;
                        }
                    }
                    await saveAndCollapseInlineLabel(label, textarea.value);
                }
            }, 100);
        });



        // CRITICAL: Use capture phase keydown listener - same pattern as sidebar
        // This must be registered on document level like preventModalCloseOnEscape
        const escapeHandler = async (e) => {
            if (e.key === 'Escape' && label.classList.contains('label-editing')) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                // Remove this handler
                document.removeEventListener('keydown', escapeHandler, true);

                // Save unless content is empty (match panel behavior)
                await saveAndCollapseInlineLabel(label, textarea.value);

                // Also clear panel editing mode
                editingAnnotationId = null;
                inlineEditingLabel = null;
                renderAnnotationsList();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && label.classList.contains('label-editing')) {
                e.preventDefault();
                document.removeEventListener('keydown', escapeHandler, true);
                await saveAndCollapseInlineLabel(label, textarea.value);
                editingAnnotationId = null;
                inlineEditingLabel = null;
                renderAnnotationsList();
            }
        };

        // CRITICAL: Register on document with capture phase BEFORE other handlers
        document.addEventListener('keydown', escapeHandler, true);
        // Store handler reference for cleanup
        label._escapeHandler = escapeHandler;

        // === INLINE PRIORITY STRIP (replaces left border) ===
        // Get annotation data to determine current priority
        const pageIdx = parseInt(marker?.dataset.annotationPage || '0');
        const annotation = identifier ? findAnnotationEntry(pageIdx, identifier) : null;
        const currentPriority = annotation ? deriveAnnotationPriority(annotation) : 'amber';

        // Create priority strip container (3-section vertical strip)
        const priorityStrip = document.createElement('div');
        priorityStrip.className = 'inline-priority-strip';

        ['red', 'amber', 'green'].forEach(priority => {
            const section = document.createElement('div');
            section.className = `strip-section priority-${priority}`;
            if (priority === currentPriority) {
                section.classList.add('active');
            }
            section.dataset.priority = priority;
            section.title = priority.charAt(0).toUpperCase() + priority.slice(1);

            // CRITICAL: Use mousedown with preventDefault to avoid blur on textarea
            section.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (!identifier) return;

                // CRITICAL: Set _updatingPriorityId to prevent blur handler from deleting annotation
                _updatingPriorityId = identifier;

                // Update visual state immediately
                priorityStrip.querySelectorAll('.strip-section').forEach(s => s.classList.remove('active'));
                section.classList.add('active');

                // Update annotation data directly WITHOUT re-rendering
                // This prevents the editor from closing
                if (annotationsData[pageIdx]) {
                    const annIdx = findAnnotationIndex(pageIdx, identifier);
                    if (annIdx >= 0) {
                        annotationsData[pageIdx][annIdx].color = priority;
                        annotationsData[pageIdx][annIdx]._priorityChanged = true;
                        annotationsData[pageIdx][annIdx]._hasBeenEdited = true;
                    }
                }

                // Update marker background color IMMEDIATELY
                let r, g, b;
                if (priority === 'red') {
                    r = 255; g = 0; b = 0;
                } else if (priority === 'amber') {
                    r = 255; g = 165; b = 0;
                } else {
                    r = 0; g = 200; b = 0;
                }
                marker.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.25)`;

                // Make API call in background without awaiting re-render
                (async () => {
                    try {
                        const apiIdentifier = buildApiAnnotationIdentifier({
                            identifier: identifier,
                            xref: marker?.dataset.annotationXref,
                            requestId: marker?.dataset.annotationRequestId,
                        });
                        if (!apiIdentifier) return;

                        await updateAnnotationRequest(apiIdentifier, { color: priority });

                        markLocalAnnotationChange();
                    } catch (error) {
                        console.error('Failed to update priority:', error);
                    } finally {
                        // Clear the flag after a delay
                        setTimeout(() => { _updatingPriorityId = null; }, 300);
                    }
                })();

                // Keep focus on textarea - DO NOT re-render
                focusElementWithoutScroll(textarea);
            });

            priorityStrip.appendChild(section);
        });

        // Add strip and textarea to label
        label.appendChild(priorityStrip);
        label.appendChild(textarea);
        repositionInlineLabel(label);

        // Focus textarea and put cursor at beginning
        setTimeout(() => {
            focusElementWithoutScroll(textarea);
            // Put cursor at beginning of text
            textarea.setSelectionRange(0, 0);
            autoResize();
        }, 50);
    }

    // Collapse label back to compact view
    function collapseInlineLabel(label) {
        if (!label || !label.classList.contains('label-expanded')) return;

        clearPendingInlineLabelReposition(label);

        // Remove escape handler if exists
        if (label._escapeHandler) {
            document.removeEventListener('keydown', label._escapeHandler, true);
            label._escapeHandler = null;
        }

        // Clear tracking
        if (inlineEditingLabel === label) {
            inlineEditingLabel = null;
        }

        // Get marker to update its color based on current annotation data
        const marker = label.closest('.annotation-marker');
        if (marker) {
            const pageIdx = parseInt(marker.dataset.annotationPage || '0');
            const identifier = marker.dataset.identifier ||
                marker.dataset.annotationRequestId ||
                marker.dataset.annotationIdentifier;

            if (identifier) {
                const annotation = findAnnotationEntry(pageIdx, identifier);
                if (annotation) {
                    const priority = deriveAnnotationPriority(annotation);
                    let r, g, b;
                    if (priority === 'red') {
                        r = 255; g = 0; b = 0;
                    } else if (priority === 'amber') {
                        r = 255; g = 165; b = 0;
                    } else {
                        r = 0; g = 200; b = 0;
                    }
                    // Update marker background
                    marker.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.25)`;
                    // Keep number and ribbon color in sync with priority color.
                    label.style.borderLeft = `4px solid rgba(${r}, ${g}, ${b}, 1)`;
                    label.style.setProperty('--annotation-number-color', `rgba(${r}, ${g}, ${b}, 0.62)`);
                }
            }
        }

        // Restore original styling
        label.style.maxWidth = label.dataset.originalMaxWidth || '180px';
        label.style.minWidth = '';
        label.style.width = '';
        label.style.whiteSpace = label.dataset.originalWhitespace || 'nowrap';
        label.style.overflow = label.dataset.originalOverflow || 'visible';
        label.style.zIndex = '';
        label.classList.remove('label-expanded');
        label.classList.remove('label-editing');
        delete label.dataset.expandSource;

        if (label._outsideClickHandler) {
            document.removeEventListener('click', label._outsideClickHandler);
            label._outsideClickHandler = null;
        }

        // Restore compact label with number ribbon + text.
        const markerNumber = marker?.dataset?.annotationNumber || '';
        const annotationNumber = label.dataset.annotationNumber || markerNumber;
        const compactTextSource = label.dataset.fullText || label.dataset.originalText || 'Click to edit';
        renderCompactInlineLabelContent(label, annotationNumber, compactTextSource);
        repositionInlineLabel(label);
    }

    // Save edits and collapse label
    async function saveAndCollapseInlineLabel(label, newContent) {
        if (!label || !label.classList.contains('label-expanded')) {
            return;
        }

        const marker = label.closest('.annotation-marker');
        if (!marker) {
            collapseInlineLabel(label);
            return;
        }

        const pageIdx = parseInt(marker.dataset.annotationPage || marker.dataset.pageIdx || '0');
        const identifier = marker.dataset.annotationRequestId ||
            marker.dataset.annotationIdentifier ||
            marker.dataset.annotationXref ||
            marker.dataset.identifier;

        if (!identifier) {
            collapseInlineLabel(label);
            return;
        }

        const trimmedContent = (newContent || '').trim();

        // Use originalFullText (stored when editing started) for comparison, NOT fullText (which may have been updated)
        const originalFullText = label.dataset.originalFullText || label.dataset.fullText || '';

        // Check if original was placeholder
        const originalIsPlaceholder = originalFullText === '' ||
            originalFullText === 'New comment...' ||
            originalFullText === 'New comment';

        // Get annotation to check if temporary
        const annotation = findAnnotationEntry(pageIdx, identifier);
        const isTemporary = annotation?._isTemporary === true;
        const hasEditedFlags = annotation?._hasBeenEdited === true || annotation?._priorityChanged === true;

        // If content is empty/unchanged AND temporary AND no other edits → DELETE
        const contentIsEmpty = trimmedContent === '';
        const contentUnchanged = trimmedContent === originalFullText.trim() ||
            (contentIsEmpty && originalIsPlaceholder);

        if (contentIsEmpty || contentUnchanged) {
            if (isTemporary && !hasEditedFlags) {
                // Delete the temporary annotation
                await deleteAnnotationSilently(pageIdx, identifier);
                collapseInlineLabel(label);
                scheduleAnnotationUpdate();
                return;
            }
            // Not temporary or has edits - just collapse without saving
            collapseInlineLabel(label);
            return;
        }

        // Save to backend

        try {
            const apiIdentifier = buildApiAnnotationIdentifier({
                identifier: identifier,
                xref: marker.dataset.annotationXref,
                requestId: marker.dataset.annotationRequestId,
            });

            const data = await updateAnnotationRequest(apiIdentifier, { content: trimmedContent });

            if (data.success && data.annotation) {
                // Update local data
                const responsePageIdx = data.annotation.page_index;

                if (annotationsData[responsePageIdx]) {
                    const annIdx = findAnnotationIndex(responsePageIdx, identifier);

                    if (annIdx >= 0) {
                        const updatedAnn = enhanceAnnotationEntry(data.annotation);
                        delete updatedAnn._isTemporary;
                        updatedAnn._originalContent = updatedAnn.content || '';
                        annotationsData[responsePageIdx][annIdx] = updatedAnn;
                    } else {
                        // FALLBACK: Try to find by xref or stable_id
                        const xref = data.annotation.xref;
                        const stableId = data.annotation.stable_id || data.annotation.id;
                        const fallbackIdx = annotationsData[responsePageIdx].findIndex(ann =>
                            ann.xref === xref ||
                            ann.stable_id === stableId ||
                            ann.id === stableId
                        );
                        if (fallbackIdx >= 0) {
                            const updatedAnn = enhanceAnnotationEntry(data.annotation);
                            delete updatedAnn._isTemporary;
                            updatedAnn._originalContent = updatedAnn.content || '';
                            annotationsData[responsePageIdx][fallbackIdx] = updatedAnn;
                        }
                    }
                }
                // Keep compact and expanded label text in sync after save.
                label.dataset.fullText = trimmedContent;

                markLocalAnnotationChange(); // Prevent polling reload
            }
        } catch (error) {
            console.error('Error saving inline annotation:', error);
        }

        collapseInlineLabel(label);
        renderAnnotationsList(); // Update the right panel too
    }

    // Undo stack for annotation operations
    const MAX_UNDO_STACK_SIZE = 50;
    let undoStack = [];
    let isUndoing = false; // Flag to prevent adding undo entries during undo operation
    const pdfSearchState = {
        term: '',
        matches: [],
        currentIndex: -1,
        pageTextCache: new Map(),
        searching: false,
    };
    // Cached measuring context for search highlights (avoids recreating canvases)
    let searchMeasureCtx = null;
    function getSearchMeasureContext() {
        if (!searchMeasureCtx) {
            searchMeasureCtx = document.createElement('canvas').getContext('2d');
        }
        if (searchMeasureCtx) {
            searchMeasureCtx.font = '100px "Times New Roman", serif';
        }
        return searchMeasureCtx;
    }

    // =========================================================================
    // Annotation Identifier Functions - Delegate to extracted modules
    // =========================================================================
    const _helpers = window.PdfPreviewModalAnnotationHelpers || {};

    // Delegate to module or provide local fallback
    function normalizeAnnotationIdentifierValue(value) {
        if (_helpers.normalizeAnnotationIdentifierValue) {
            return _helpers.normalizeAnnotationIdentifierValue(value);
        }
        // Fallback
        if (value === null || value === undefined) return null;
        const normalized = String(value).trim();
        return normalized ? normalized : null;
    }

    function parseCompositeIdentifier(raw) {
        if (_helpers.parseCompositeIdentifier) {
            return _helpers.parseCompositeIdentifier(raw);
        }
        // Fallback - simplified
        const value = normalizeAnnotationIdentifierValue(raw);
        return { xref: value && /^\d+$/.test(value) ? value : null, stableId: value };
    }

    function resolveAnnotationIdParts(params) {
        if (_helpers.resolveAnnotationIdParts) {
            return _helpers.resolveAnnotationIdParts(params);
        }
        // Fallback - use local parseCompositeIdentifier
        const { xref, requestId, identifier } = params;
        const parsedRequest = parseCompositeIdentifier(requestId);
        const parsedIdentifier = parseCompositeIdentifier(identifier);
        return {
            xref: normalizeAnnotationIdentifierValue(xref) || parsedRequest.xref || parsedIdentifier.xref,
            stableId: normalizeAnnotationIdentifierValue(requestId) || parsedRequest.stableId || parsedIdentifier.stableId || normalizeAnnotationIdentifierValue(identifier)
        };
    }

    function buildApiAnnotationIdentifier(params) {
        if (_helpers.buildApiAnnotationIdentifier) {
            return _helpers.buildApiAnnotationIdentifier(params);
        }
        // Fallback
        const { identifier, xref, requestId } = params;
        const normXref = normalizeAnnotationIdentifierValue(xref);
        const normRequest = normalizeAnnotationIdentifierValue(requestId);
        const normIdentifier = normalizeAnnotationIdentifierValue(identifier);
        const validRequestId = normRequest && !isAnnotationType(normRequest) ? normRequest : null;
        const { xref: parsedXref, stableId: parsedStable } = resolveAnnotationIdParts({
            xref: normXref, requestId: validRequestId, identifier: normIdentifier,
        });
        if (parsedXref) return `xref:${parsedXref}`;
        if (parsedStable) return /^\d+$/.test(parsedStable) ? `id:${parsedStable}` : parsedStable;
        return normIdentifier || null;
    }

    function isAnnotationType(value) {
        if (_helpers.isAnnotationType) {
            return _helpers.isAnnotationType(value);
        }
        // Fallback
        const annotationTypes = ['Text', 'Note', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut',
            'FreeText', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine',
            'Stamp', 'Caret', 'Ink', 'Popup', 'FileAttachment', 'Sound'];
        return annotationTypes.includes(String(value));
    }

    // Undo functionality
    function pushUndoOperation(operation) {
        if (isUndoing) {
            // Don't record undo operations while we're undoing
            return;
        }
        if (operation && !operation.undoTimestamp) {
            operation.undoTimestamp = Date.now();
        }

        undoStack.push(operation);

        // Limit stack size to prevent memory issues
        if (undoStack.length > MAX_UNDO_STACK_SIZE) {
            undoStack.shift();
        }

    }

    function getNextUndoOperation() {
        const localOperation = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
        const controllerOperation = _currentAnnotationCtrl && !_annotationCtrlDelegating &&
            _currentAnnotationCtrl.peekUndoOperation
            ? _currentAnnotationCtrl.peekUndoOperation()
            : null;

        const isSameUndoOperation = (left, right) => (
            !!left &&
            !!right &&
            left.type === right.type &&
            left.undoTimestamp === right.undoTimestamp &&
            normalizeAnnotationIdentifierValue(left.identifier || left.requestId || left.annotation?.id || left.annotation?.stable_id)
                === normalizeAnnotationIdentifierValue(right.identifier || right.requestId || right.annotation?.id || right.annotation?.stable_id) &&
            Number(left.pageIdx ?? left.oldPageIdx ?? -1) === Number(right.pageIdx ?? right.oldPageIdx ?? -1)
        );

        if (!localOperation && !controllerOperation) {
            return null;
        }

        const localTimestamp = Number(localOperation?.undoTimestamp || 0);
        const controllerTimestamp = Number(controllerOperation?.undoTimestamp || 0);

        if (controllerOperation && controllerTimestamp >= localTimestamp) {
            if (localOperation && isSameUndoOperation(localOperation, controllerOperation)) {
                undoStack.pop();
            }
            return _currentAnnotationCtrl.popUndoOperation
                ? _currentAnnotationCtrl.popUndoOperation()
                : controllerOperation;
        }

        if (controllerOperation && isSameUndoOperation(localOperation, controllerOperation) && _currentAnnotationCtrl.popUndoOperation) {
            _currentAnnotationCtrl.popUndoOperation();
        }
        return undoStack.pop();
    }

    function buildAnnotationVisibilityKey(pageIdx, params) {
        if (pageIdx === undefined || pageIdx === null || Number.isNaN(Number(pageIdx))) {
            return null;
        }

        const value = params || {};
        const annotation = value.annotation || null;
        const marker = value.marker || null;
        const rawXref = value.xref
            ?? annotation?.xref
            ?? annotation?._tempXref
            ?? marker?.dataset?.annotationXref
            ?? null;
        const rawRequestId = value.requestId
            ?? annotation?.requestIdentifier
            ?? marker?.dataset?.annotationRequestId
            ?? null;
        const rawIdentifier = value.identifier
            ?? annotation?.stable_id
            ?? annotation?.stableId
            ?? annotation?.id
            ?? annotation?.identifier
            ?? annotation?.name
            ?? annotation?.title
            ?? annotation?._tempIdentifier
            ?? marker?.dataset?.annotationStableId
            ?? marker?.dataset?.annotationIdentifier
            ?? marker?.dataset?.identifier
            ?? null;

        const normalizedXref = normalizeAnnotationIdentifierValue(rawXref);
        const normalizedRequestId = normalizeAnnotationIdentifierValue(rawRequestId);
        const normalizedIdentifier = normalizeAnnotationIdentifierValue(rawIdentifier);
        const resolvedIds = resolveAnnotationIdParts({
            xref: normalizedXref,
            requestId: normalizedRequestId,
            identifier: normalizedIdentifier,
        });
        const keyId = resolvedIds.stableId
            || resolvedIds.xref
            || normalizedRequestId
            || normalizedIdentifier
            || normalizedXref;

        if (!keyId) {
            return null;
        }

        return `${Number(pageIdx)}:${keyId}`;
    }

    // =========================================================================
    // Markup Module Wiring — Drawing strokes, text boxes, selection
    // =========================================================================

    function wireMarkupModuleCallbacks() {
        if (DrawingCanvas) {
            DrawingCanvas.onStrokeComplete = function (pageIdx, stroke) {
                var pageWrapper = null;
                var wrappers = document.querySelectorAll('#pdfGradedContainer .pdf-page-wrapper');
                if (wrappers[pageIdx]) pageWrapper = wrappers[pageIdx];
                if (!pageWrapper) return;

                var pdfCanvas = pageWrapper.querySelector('canvas');
                var viewer = window.__pdfGradedViewer;
                if (!pdfCanvas || !viewer) return;

                var viewport = viewer.getViewportForPage(stroke.pageIdx + 1);
                if (!viewport) return;

                var pdfPoints = stroke.points.map(function (pt) {
                    return viewport.convertToPdfPoint(pt.x, pt.y);
                });

                createAnnotationRequest({
                    page_index: pageIdx,
                    content: '',
                    type: 'drawing',
                    drawing_style: stroke.style,
                    points: pdfPoints,
                    stroke_width: stroke.strokeWidth,
                    stroke_opacity: stroke.opacity,
                    stroke_color_rgb: stroke.color.rgb,
                    color: 'amber'
                })
                .then(function (data) {
                    if (data.success && data.annotation) {
                        stroke.annotationId = data.annotation.stable_id || data.annotation.xref;
                        upsertAnnotationEntryLocal(data.annotation, pageIdx);
                        refreshMarkupFromAnnotations();
                        pushUndoOperation({
                            type: 'create-drawing',
                            pageIdx: stroke.pageIdx,
                            annotationId: stroke.annotationId
                        });
                    }
                })
                .catch(function (err) {
                    console.error('Failed to save drawing stroke:', err);
                });
            };
        }

        if (TextboxModule) {
            TextboxModule.onTextboxCommitted = function (entry) {
                var pageWrapper = null;
                var wrappers = document.querySelectorAll('#pdfGradedContainer .pdf-page-wrapper');
                if (wrappers[entry.pageIdx]) pageWrapper = wrappers[entry.pageIdx];
                var viewer = window.__pdfGradedViewer;
                if (!pageWrapper || !viewer) return;

                var canvasRect = TextboxModule.getTextboxCanvasRect(entry, pageWrapper);
                if (!canvasRect) return;

                var pdfCanvas = pageWrapper.querySelector('canvas');
                if (!pdfCanvas) return;

                var viewport = viewer.getViewportForPage(entry.pageIdx + 1);
                if (!viewport) return;

                var topLeft = viewport.convertToPdfPoint(canvasRect[0], canvasRect[1]);
                var bottomRight = viewport.convertToPdfPoint(canvasRect[2], canvasRect[3]);
                var pdfRect = [
                    Math.min(topLeft[0], bottomRight[0]),
                    Math.min(topLeft[1], bottomRight[1]),
                    Math.max(topLeft[0], bottomRight[0]),
                    Math.max(topLeft[1], bottomRight[1])
                ];

                var isUpdate = !!entry.annotationId;
                var textboxBody = {
                    page_index: entry.pageIdx,
                    content: entry.content,
                    type: 'textbox',
                    rect: pdfRect,
                    stroke_color_rgb: entry.color && entry.color.rgb ? entry.color.rgb : [0, 0, 0],
                    color: 'amber'
                };

                (isUpdate
                    ? updateAnnotationRequest(buildApiAnnotationIdentifier({ identifier: entry.annotationId }) || entry.annotationId, textboxBody)
                    : createAnnotationRequest(textboxBody)
                )
                .then(function (data) {
                    if (data.success && data.annotation) {
                        entry.annotationId = data.annotation.stable_id || data.annotation.xref;
                        upsertAnnotationEntryLocal(data.annotation, entry.pageIdx);
                        refreshMarkupFromAnnotations();
                        if (!isUpdate) {
                            pushUndoOperation({
                                type: 'create-textbox',
                                pageIdx: entry.pageIdx,
                                annotationId: entry.annotationId
                            });
                        }
                    }
                })
                .catch(function (err) {
                    console.error('Failed to save text box:', err);
                });
            };

            TextboxModule.onTextboxDeleted = function (entry) {
                if (entry.annotationId) {
                    deleteAnnotationRequest(buildApiAnnotationIdentifier({ identifier: entry.annotationId }) || entry.annotationId)
                    .then(function () {
                        removeAnnotationEntryLocal(entry.pageIdx, entry.annotationId);
                        refreshMarkupFromAnnotations();
                    }).catch(function (err) {
                        console.error('Failed to delete empty text box:', err);
                    });
                }
            };
        }

        if (MarkupSelection) {
            MarkupSelection.onDeleteRequested = function () {
                var item = MarkupSelection.deleteSelected();
                if (!item) return;

                var annotationId = item.entry.annotationId;

                if (item.type === 'stroke' && DrawingCanvas) {
                    DrawingCanvas.removeStroke(item.pageIdx, annotationId);
                } else if (item.type === 'textbox' && TextboxModule) {
                    TextboxModule.removeTextbox(item.pageIdx, item.entry);
                }

                if (annotationId) {
                    deleteAnnotationRequest(buildApiAnnotationIdentifier({ identifier: annotationId }) || annotationId)
                    .then(function () {
                        removeAnnotationEntryLocal(item.pageIdx, annotationId);
                        refreshMarkupFromAnnotations();
                        pushUndoOperation({
                            type: 'delete-markup',
                            markupType: item.type,
                            pageIdx: item.pageIdx,
                            annotationId: annotationId
                        });
                    })
                    .catch(function (err) {
                        console.error('Failed to delete markup:', err);
                    });
                }
            };

            MarkupSelection.onMoveCompleted = async function (item) {
                if (!item || !item.entry.annotationId) return;

                var sourcePageIdx = item.sourcePageIdx !== undefined ? item.sourcePageIdx : item.pageIdx;
                var targetPageIdx = item.pageIdx;
                var originalAnnotationId = item.entry.annotationId;
                var pageWrapper = null;
                var wrappers = document.querySelectorAll('#pdfGradedContainer .pdf-page-wrapper');
                if (wrappers[targetPageIdx]) pageWrapper = wrappers[targetPageIdx];
                var viewer = window.__pdfGradedViewer;
                if (!pageWrapper || !viewer) return;

                var pdfCanvas = pageWrapper.querySelector('canvas');
                if (!pdfCanvas) return;

                var viewport = viewer.getViewportForPage(targetPageIdx + 1);
                var convertCanvasPointToPdf = null;

                if (viewport && typeof viewport.convertToPdfPoint === 'function') {
                    convertCanvasPointToPdf = function (x, y) {
                        return viewport.convertToPdfPoint(x, y);
                    };
                } else if (viewer.pdf && typeof viewer.pdf.getPage === 'function') {
                    var pdfPage = await viewer.pdf.getPage(targetPageIdx + 1);
                    var baseViewport = pdfPage.getViewport({ scale: 1 });
                    convertCanvasPointToPdf = function (x, y) {
                        return [
                            (x / pdfCanvas.width) * baseViewport.width,
                            baseViewport.height - ((y / pdfCanvas.height) * baseViewport.height)
                        ];
                    };
                }

                if (!convertCanvasPointToPdf) return;

                var body = {};

                if (item.type === 'textbox' && TextboxModule) {
                    // Refresh the entry by annotationId before reading offsets.
                    // refreshMarkupFromAnnotations() recreates textbox entries
                    // after every CRUD round-trip; the entry stored in
                    // MarkupSelection may point to a detached element whose
                    // offsetLeft/Top/Width/Height all return 0, producing a
                    // [0, page_h, 0, page_h] rect that the agent rejects with
                    // "rect requires x0 < x1 and y0 < y1".
                    var freshEntry = item.entry;
                    if (typeof TextboxModule.getPageTextboxes === 'function' && originalAnnotationId) {
                        var entries = TextboxModule.getPageTextboxes(targetPageIdx) || [];
                        for (var fi = 0; fi < entries.length; fi++) {
                            if (entries[fi] && entries[fi].annotationId === originalAnnotationId) {
                                freshEntry = entries[fi];
                                break;
                            }
                        }
                    }
                    var canvasRect = TextboxModule.getTextboxCanvasRect(freshEntry, pageWrapper);
                    if (canvasRect) {
                        var movedTopLeft = convertCanvasPointToPdf(canvasRect[0], canvasRect[1]);
                        var movedBottomRight = convertCanvasPointToPdf(canvasRect[2], canvasRect[3]);
                        body.rect = [
                            Math.min(movedTopLeft[0], movedBottomRight[0]),
                            Math.min(movedTopLeft[1], movedBottomRight[1]),
                            Math.max(movedTopLeft[0], movedBottomRight[0]),
                            Math.max(movedTopLeft[1], movedBottomRight[1])
                        ];
                    }
                } else if (item.type === 'stroke') {
                    body.points = item.entry.points.map(function (pt) {
                        return convertCanvasPointToPdf(pt.x, pt.y);
                    });
                }

                if (sourcePageIdx !== targetPageIdx) {
                    body.page_index = targetPageIdx;
                }

                try {
                    var data = await updateAnnotationRequest(buildApiAnnotationIdentifier({ identifier: item.entry.annotationId }) || item.entry.annotationId, body);
                    if (data.success && data.annotation) {
                        item.entry.annotationId = data.annotation.stable_id || data.annotation.xref || item.entry.annotationId;
                        if (sourcePageIdx !== targetPageIdx) {
                            removeAnnotationEntryLocal(sourcePageIdx, originalAnnotationId);
                        }
                        upsertAnnotationEntryLocal(data.annotation, targetPageIdx);
                        refreshMarkupFromAnnotations();
                    }
                } catch (err) {
                    console.error('Failed to update markup position:', err);
                    refreshMarkupFromAnnotations();
                }
            };
        }
    }

    wireMarkupModuleCallbacks();

    // Markup click handler on the graded PDF container (text placement + selection)
    (function () {
        var gradedContainer = document.getElementById('pdfGradedContainer');
        if (!gradedContainer) return;

        gradedContainer.addEventListener('click', function (e) {
            if (!markupModeActive || !DrawingCanvas) return;

            var target = e.target;
            var currentTool = DrawingCanvas.getActiveTool();

            if (currentTool === 'text' && TextboxModule) {
                var pageWrapper = target.closest('.pdf-page-wrapper');
                if (!pageWrapper) return;
                var pageIdx = parseInt(pageWrapper.dataset.pageIndex || pageWrapper.dataset.pageIdx || '0', 10);
                var pdfCanvas = pageWrapper.querySelector('canvas');
                if (!pdfCanvas) return;

                var canvasRect = pdfCanvas.getBoundingClientRect();
                var canvasScaleX = pdfCanvas.width / pdfCanvas.offsetWidth;
                var canvasScaleY = pdfCanvas.height / pdfCanvas.offsetHeight;
                var canvasX = (e.clientX - canvasRect.left) * canvasScaleX;
                var canvasY = (e.clientY - canvasRect.top) * canvasScaleY;

                var activeColor = DrawingCanvas.getActiveColor();
                TextboxModule.createTextbox(pageIdx, pageWrapper, canvasX, canvasY, activeColor);
                return;
            }

            if (currentTool === 'select') {
                var pageWrapper2 = target.closest('.pdf-page-wrapper');
                if (!pageWrapper2) return;
                var pageIdx2 = parseInt(pageWrapper2.dataset.pageIndex || pageWrapper2.dataset.pageIdx || '0', 10);

                // Check text box hit first
                if (TextboxModule) {
                    var hitTextbox = TextboxModule.hitTestTextbox(pageIdx2, e.clientX, e.clientY);
                    if (hitTextbox) {
                        // Identity check by annotationId, not object reference, because
                        // refreshMarkupFromAnnotations recreates the entry after every
                        // CRUD round-trip and the stale reference in MarkupSelection no
                        // longer === the fresh entry returned by hitTestTextbox.
                        var prevSel = MarkupSelection && MarkupSelection.getSelected();
                        var prevId = prevSel && prevSel.entry && prevSel.entry.annotationId;
                        var hitId = hitTextbox.annotationId;
                        if (MarkupSelection && prevSel &&
                            (prevSel.entry === hitTextbox ||
                             (prevId && hitId && prevId === hitId))) {
                            TextboxModule.editTextbox(hitTextbox);
                        } else if (MarkupSelection) {
                            MarkupSelection.select('textbox', hitTextbox, pageIdx2, pageWrapper2);
                        }
                        return;
                    }
                }

                // Check stroke hit
                if (DrawingCanvas) {
                    var pdfCanvas2 = pageWrapper2.querySelector('canvas');
                    if (pdfCanvas2) {
                        var rect2 = pdfCanvas2.getBoundingClientRect();
                        var scaleX2 = pdfCanvas2.width / pdfCanvas2.offsetWidth;
                        var scaleY2 = pdfCanvas2.height / pdfCanvas2.offsetHeight;
                        var cx = (e.clientX - rect2.left) * scaleX2;
                        var cy = (e.clientY - rect2.top) * scaleY2;

                        var hitStroke = DrawingCanvas.hitTestStroke(pageIdx2, cx, cy);
                        if (hitStroke && MarkupSelection) {
                            MarkupSelection.select('stroke', hitStroke, pageIdx2, pageWrapper2);
                            return;
                        }
                    }
                }

                // Empty area click — deselect
                if (MarkupSelection) MarkupSelection.deselect();
                return;
            }
        });
    })();

    async function performUndo() {
        const operation = getNextUndoOperation();
        if (!operation) {
            // No operations to undo; silently ignore to keep flow smooth
            return;
        }

        isUndoing = true;

        try {
            if (operation.type === 'delete') {
                let apiRect = operation.annotation.rect;
                const viewer = window.__pdfGradedViewer;
                if (Array.isArray(apiRect) && apiRect.length === 4 && viewer?.pdf) {
                    try {
                        const pg = await viewer.pdf.getPage(operation.pageIdx + 1);
                        const pageHeight = pg.view[3] - pg.view[1];
                        apiRect = [
                            apiRect[0],
                            pageHeight - apiRect[3],
                            apiRect[2],
                            pageHeight - apiRect[1],
                        ];
                    } catch (_error) {
                        // Fall back to the original rect if page metadata is unavailable.
                    }
                }

                // Recreate the deleted annotation
                const annotationData = {
                    content: operation.annotation.content || '',
                    type: operation.annotation.type || 'Text',
                    rect: apiRect,
                    color: operation.annotation.priority || 'amber',  // Use priority string, not color dict
                    page_index: operation.pageIdx,
                    source: operation.annotation.source || 'HUMAN',  // Preserve original source
                };

                // Call the API to recreate the annotation
                try {
                    const data = await createAnnotationRequest(annotationData);

                    // CRITICAL FIX: Add annotation directly instead of reloading all annotations
                    if (data.success && data.annotation) {
                        const responsePageIdx = data.annotation.page_index;
                        if (!annotationsData[responsePageIdx]) {
                            annotationsData[responsePageIdx] = [];
                        }
                        const newAnn = enhanceAnnotationEntry(data.annotation);
                        annotationsData[responsePageIdx].push(newAnn);
                    }

                    // Re-render the page first so visibility-tracked sidebars see
                    // the recreated marker before they re-evaluate display rules.
                    renderAnnotationsForPage(operation.pageIdx + 1, true);
                    try {
                        syncVisibleAnnotationMarkersFromDom();
                    } catch (_error) {
                        // Visibility sync is best-effort; the observer will catch up.
                    }
                    renderAnnotationsList();
                    markLocalAnnotationChange(); // Prevent polling from reloading
                } catch (undoErr) {
                    console.error('Failed to recreate annotation:', undoErr);
                    showToast('error', 'Failed to undo deletion');
                    // Push operation back to stack if failed
                    undoStack.push(operation);
                }

            } else if (operation.type === 'move') {
                // Move the annotation back to its original position
                const identifier = operation.identifier;
                const apiIdentifier = buildApiAnnotationIdentifier({
                    identifier: identifier,
                    xref: operation.xref,
                    requestId: operation.requestId,
                });

                if (!apiIdentifier) {
                    console.error('Unable to resolve annotation identifier for undo');
                    showToast('error', 'Failed to undo move');
                    undoStack.push(operation);
                    return;
                }

                // oldRect is in PyMuPDF top-left format (from annotationsData),
                // but the API expects PDF bottom-left format and converts internally.
                // Convert PyMuPDF → PDF to avoid double-conversion.
                let apiRect = operation.oldRect;
                const viewer = window.__pdfGradedViewer;
                if (apiRect && viewer && viewer.pdf) {
                    try {
                        const pg = await viewer.pdf.getPage(operation.oldPageIdx + 1);
                        const pageHeight = pg.view[3] - pg.view[1];
                        apiRect = [apiRect[0], pageHeight - apiRect[3], apiRect[2], pageHeight - apiRect[1]];
                    } catch (_e) { /* fallback to raw rect */ }
                }

                const updateData = {
                    page_index: operation.oldPageIdx,
                    rect: apiRect,
                };

                // Revert source if this was an ownership transfer
                if (operation.isOwnershipTransfer && operation.oldSource) {
                    updateData.source = operation.oldSource;
                }

                try {
                    const data = await updateAnnotationRequest(apiIdentifier, updateData);

                    // CRITICAL FIX: Update annotation directly instead of reloading all annotations
                    if (data.success && data.annotation) {
                        const updatedAnn = enhanceAnnotationEntry(data.annotation);
                        const isSamePageUndo = operation.oldPageIdx === operation.newPageIdx;

                        if (isSamePageUndo) {
                            // Same-page undo: update rect in-place (no splice+push on same array)
                            const idx = findAnnotationIndex(operation.newPageIdx, operation.identifier || operation.requestId);
                            if (idx >= 0) {
                                annotationsData[operation.newPageIdx][idx] = updatedAnn;
                            }
                        } else {
                            // Cross-page undo: remove from new page, add to old page
                            if (annotationsData[operation.newPageIdx]) {
                                const newIdx = findAnnotationIndex(operation.newPageIdx, operation.identifier || operation.requestId);
                                if (newIdx >= 0) {
                                    annotationsData[operation.newPageIdx].splice(newIdx, 1);
                                }
                            }
                            if (annotationsData[operation.oldPageIdx]) {
                                annotationsData[operation.oldPageIdx].push(updatedAnn);
                            } else {
                                annotationsData[operation.oldPageIdx] = [updatedAnn];
                            }
                        }

                        // For same-page undo, update marker position in-place
                        // to avoid destroying IntersectionObserver tracking
                        if (isSamePageUndo) {
                            _suppressSidebarRender = true;
                            const pageNum = operation.oldPageIdx + 1;
                            const container = document.getElementById('pdfGradedContainer');
                            const wrapper = container ? container.querySelector('.pdf-page-wrapper[data-page-num="' + pageNum + '"]') : null;
                            const overlay = wrapper ? wrapper.querySelector('.pdf-annotation-overlay') : null;
                            if (overlay) {
                                const xref = operation.xref || (data.annotation && String(data.annotation.xref));
                                const markers = overlay.querySelectorAll('.annotation-marker');
                                for (const m of markers) {
                                    if (m.dataset.annotationXref === xref ||
                                        m.dataset.annotationRequestId === (operation.identifier || operation.requestId)) {
                                        updateMarkerPositionInPlace(m, updatedAnn, operation.oldPageIdx);
                                        break;
                                    }
                                }
                            }
                            setTimeout(() => { _suppressSidebarRender = false; }, 300);
                            // Sidebar content unchanged for same-page undo
                        } else {
                            renderAnnotationsList();
                            renderAnnotationsForPage(operation.oldPageIdx + 1, true);
                            renderAnnotationsForPage(operation.newPageIdx + 1, true);
                        }
                    }

                    markLocalAnnotationChange(); // Prevent polling from reloading

                    // Show toast for ownership revert
                    if (operation.isOwnershipTransfer) {
                        showToast('success', translatePdfPreviewText('Ownership reverted to AI'));
                    }
                } catch (undoErr) {
                    console.error('Failed to undo move:', undoErr);
                    showToast('error', 'Failed to undo move');
                    undoStack.push(operation);
                }

            } else if (operation.type === 'edit') {
                // Restore content AND source for edit operations
                const apiIdentifier = buildApiAnnotationIdentifier({
                    identifier: operation.identifier,
                    xref: operation.xref,
                    requestId: operation.requestId,
                });

                if (!apiIdentifier) {
                    console.error('Unable to resolve annotation identifier for undo edit');
                    showToast('error', 'Failed to undo edit');
                    undoStack.push(operation);
                    return;
                }

                const updateData = { content: operation.oldContent };
                // Revert source if this was an ownership transfer
                if (operation.isOwnershipTransfer && operation.oldSource) {
                    updateData.source = operation.oldSource;
                }

                try {
                    const data = await updateAnnotationRequest(apiIdentifier, updateData);

                    // CRITICAL FIX: Update annotation directly instead of reloading all annotations
                    if (data.success && data.annotation) {
                        const responsePageIdx = data.annotation.page_index;
                        if (annotationsData[responsePageIdx]) {
                            const annIdx = findAnnotationIndex(responsePageIdx, operation.identifier || operation.requestId);
                            if (annIdx >= 0) {
                                const updatedAnn = enhanceAnnotationEntry(data.annotation);
                                annotationsData[responsePageIdx][annIdx] = updatedAnn;
                            }
                        }
                    }

                    // Only re-render the affected page, don't reload all annotations
                    renderAnnotationsList();
                    renderAnnotationsForPage(operation.pageIdx + 1, true);
                    markLocalAnnotationChange(); // Prevent polling from reloading

                    if (operation.isOwnershipTransfer) {
                        showToast('success', translatePdfPreviewText('Ownership reverted to AI'));
                    }
                } catch (undoErr) {
                    console.error('Failed to undo edit:', undoErr);
                    showToast('error', 'Failed to undo edit');
                    undoStack.push(operation);
                }

            } else if (operation.type === 'priority') {
                // Restore color AND source for priority operations
                const apiIdentifier = buildApiAnnotationIdentifier({
                    identifier: operation.identifier,
                    xref: operation.xref,
                    requestId: operation.requestId,
                });

                if (!apiIdentifier) {
                    console.error('Unable to resolve annotation identifier for undo priority');
                    showToast('error', 'Failed to undo priority change');
                    undoStack.push(operation);
                    return;
                }

                const updateData = { color: operation.oldColor };
                // Revert source if this was an ownership transfer
                if (operation.isOwnershipTransfer && operation.oldSource) {
                    updateData.source = operation.oldSource;
                }

                try {
                    const data = await updateAnnotationRequest(apiIdentifier, updateData);

                    // CRITICAL FIX: Update annotation directly instead of reloading all annotations
                    if (data.success && data.annotation) {
                        const responsePageIdx = data.annotation.page_index;
                        if (annotationsData[responsePageIdx]) {
                            const annIdx = findAnnotationIndex(responsePageIdx, operation.identifier || operation.requestId);
                            if (annIdx >= 0) {
                                const updatedAnn = enhanceAnnotationEntry(data.annotation);
                                annotationsData[responsePageIdx][annIdx] = updatedAnn;
                            }
                        }
                    }

                    // Only re-render the affected page, don't reload all annotations
                    renderAnnotationsList();
                    renderAnnotationsForPage(operation.pageIdx + 1, true);
                    markLocalAnnotationChange(); // Prevent polling from reloading

                    if (operation.isOwnershipTransfer) {
                        showToast('success', translatePdfPreviewText('Ownership reverted to AI'));
                    }
                } catch (undoErr) {
                    console.error('Failed to undo priority:', undoErr);
                    showToast('error', 'Failed to undo priority change');
                    undoStack.push(operation);
                }
            }
        } catch (error) {
            console.error('Error during undo:', error);
            showToast('error', translatePdfPreviewText('Undo operation failed'));
            // Push operation back to stack if error occurred
            undoStack.push(operation);
        } finally {
            isUndoing = false;
        }
    }

    // =========================================================================
    // Priority/Identifier Functions - Delegate to annotation-helpers module
    // =========================================================================

    function deriveAnnotationPriority(entry) {
        if (_helpers.deriveAnnotationPriority) {
            return _helpers.deriveAnnotationPriority(entry);
        }
        // Fallback
        return entry?.priority || 'amber';
    }

    /**
     * Resolve annotation source (AI or HUMAN).
     * Returns 'AI' or 'HUMAN' based on annotation data.
     */
    function resolveAnnotationSource(ann) {
        if (_helpers.resolveAnnotationSource) {
            return _helpers.resolveAnnotationSource(ann);
        }
        // Fallback
        if (ann.source === 'AI' || ann.source === 'HUMAN') {
            return ann.source;
        }
        return ann.is_system_generated !== false ? 'AI' : 'HUMAN';
    }

    function resolveAnnotationIdentifierValue(entry) {
        if (_helpers.resolveAnnotationIdentifierValue) {
            return _helpers.resolveAnnotationIdentifierValue(entry);
        }
        if (!entry) {
            return null;
        }

        // Prefer stable IDs (most reliable for user-created annotations)
        const stableId = extractAnnotationStableName(entry);
        // IMPORTANT: allow fitz-* stable IDs here so UI/drag/edit uses the same identifier seen in the backend payload.
        if (stableId && !isAnnotationType(stableId)) {
            return stableId;
        }

        // Fall back to xref if stable ID not available
        if (typeof entry.xref === 'number' && !Number.isNaN(entry.xref) && entry.xref > 0) {
            return String(entry.xref);
        }
        const normalizedXref = normalizeAnnotationIdentifierValue(entry.xref);
        if (normalizedXref && normalizedXref !== '0') {
            return normalizedXref;
        }

        // Last resort: use any ID that's not a PyMuPDF internal ID or annotation type
        const candidateFields = [
            entry.identifier,
            entry.id,
            entry.name,
            entry.title,
        ];
        for (const candidate of candidateFields) {
            const normalized = normalizeAnnotationIdentifierValue(candidate);
            if (
                normalized &&
                normalized !== '0' &&
                !isAnnotationType(normalized)
            ) {
                return normalized;
            }
        }
        return null;
    }

    function extractAnnotationStableName(entry) {
        if (!entry) {
            return null;
        }
        const candidates = [
            entry.stable_id,
            entry.stableId,
            entry.id && entry.xref != null && String(entry.xref) === String(entry.id) ? null : entry.id,
            entry.name,
            entry.title,
        ];
        for (const candidate of candidates) {
            const normalized = normalizeAnnotationIdentifierValue(candidate);
            if (
                normalized &&
                normalized !== '0' &&
                !isAnnotationType(normalized)
            ) {
                return normalized;
            }
        }
        return null;
    }

    function buildAnnotationRequestIdentifier(entry) {
        if (!entry) {
            return null;
        }

        // Prefer stable ID; fall back to xref
        const stableId = extractAnnotationStableName(entry);
        if (
            stableId &&
            !stableId.startsWith('fitz-') &&
            stableId !== '0' &&
            !isAnnotationType(stableId)
        ) {
            return stableId;
        }

        const xref = typeof entry.xref === 'number' ? entry.xref : null;
        if (xref && xref > 0) {
            return String(xref);
        }

        // Last resort: use identifier field if it's not a PyMuPDF internal ID or annotation type
        const identifier = entry.identifier || entry.id;
        if (
            identifier &&
            !String(identifier).startsWith('fitz-') &&
            identifier !== '0' &&
            !isAnnotationType(String(identifier))
        ) {
            return String(identifier);
        }

        return null;
    }

    function findAnnotationIndex(pageIdx, identifier) {
        const normalized = normalizeAnnotationIdentifierValue(identifier);
        if (normalized === null) {
            return -1;
        }
        const pageEntries = annotationsData[pageIdx] || [];

        // Parse the search identifier to get both xref and UUID  
        const searchParts = parseCompositeIdentifier(normalized);
        const searchXref = searchParts.xref;
        const searchUuid = searchParts.stableId;

        return pageEntries.findIndex(
            (ann) => {
                // Parse annotation identifiers
                const annParts = parseCompositeIdentifier(ann.stable_id || ann.id || ann.requestIdentifier);
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
                if (ann._tempXref && String(ann._tempXref) === normalized) {
                    return true;
                }
                if (ann._tempIdentifier && String(ann._tempIdentifier) === normalized) {
                    return true;
                }

                return false;
            }
        );
    }

    // =========================================================================
    // Utility Functions - Delegate to extracted modules (UtilsModule defined at top)
    // =========================================================================

    function escapeCssAttribute(value) {
        if (UtilsModule.escapeCssAttribute) {
            return UtilsModule.escapeCssAttribute(value);
        }
        // Fallback
        const text = String(value);
        return (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
            ? CSS.escape(text)
            : text.replace(/(["\\])/g, '\\$1');
    }

    // Use AEMS.utils.escapeHtml when available, fallback for standalone usage
    var escapeHtml = (window.AEMS && window.AEMS.utils && typeof window.AEMS.utils.escapeHtml === 'function')
        ? window.AEMS.utils.escapeHtml
        : function (text) {
            if (text == null) return '';
            var div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        };

    /**
     * Setup auto-resize for a textarea element - delegates to module
     */
    function setupTextareaAutoResize(textarea) {
        if (UtilsModule.setupTextareaAutoResize) {
            return UtilsModule.setupTextareaAutoResize(textarea, escapeCssAttribute);
        }
        // Fallback implementation
        if (!textarea || textarea._autoResizeSetup) return;
        textarea._autoResizeSetup = true;
        const resize = () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 60), 300) + 'px';
        };
        textarea.addEventListener('input', resize);
        setTimeout(resize, 0);
    }

    function enhanceAnnotationEntry(entry) {
        if (!entry) {
            return entry;
        }
        const identifier = resolveAnnotationIdentifierValue(entry);
        const requestIdentifier = buildAnnotationRequestIdentifier({
            ...entry,
            identifier,
        });

        return {
            ...entry,
            identifier,
            requestIdentifier,
            // Preserve original content snapshot for cancel/undo purposes
            _originalContent: entry._originalContent !== undefined ? entry._originalContent : (entry.content || ''),
            _createdAtSession: entry._createdAtSession === true,
        };
    }

    function normalizeAnnotationsPayload(raw) {
        const normalized = {};
        Object.entries(raw || {}).forEach(([pageKey, list]) => {
            const pageIdx = Number(pageKey);
            normalized[pageIdx] = (list || []).map(enhanceAnnotationEntry);
        });
        return normalized;
    }

    function getMarkupPageWrappers() {
        const wrappers = [];
        document.querySelectorAll('#pdfGradedContainer .pdf-page-wrapper').forEach((wrapper, idx) => {
            wrappers[idx] = wrapper;
        });
        return wrappers;
    }

    function projectDrawingAnnotationsForCanvas() {
        const projected = [];
        const viewer = window.__pdfGradedViewer;
        if (!viewer) {
            return projected;
        }

        Object.entries(annotationsData || {}).forEach(([pageKey, pageAnnotations]) => {
            const pageIdx = Number(pageKey);
            const viewport = viewer.getViewportForPage(pageIdx + 1);
            if (!viewport) {
                return;
            }

            (pageAnnotations || []).forEach((ann) => {
                if (ann.type !== 'drawing' || !Array.isArray(ann.points)) {
                    return;
                }

                projected.push({
                    type: 'drawing',
                    pageIdx,
                    annotationId: ann.stable_id || ann.id || ann.xref || null,
                    drawing_style: ann.drawing_style || 'pen',
                    stroke_width: ann.stroke_width,
                    stroke_opacity: ann.stroke_opacity,
                    stroke_color_rgb: ann.stroke_color_rgb || [0, 0, 0],
                    points: ann.points.map((pt) => {
                        const viewPoint = viewport.convertToViewportPoint(pt[0], pt[1]);
                        return { x: viewPoint[0], y: viewPoint[1] };
                    }),
                });
            });
        });

        return projected;
    }

    function projectTextboxAnnotationsForDom() {
        const projected = [];
        const viewer = window.__pdfGradedViewer;
        const RenderingModule = window.PdfPreviewModalRendering || {};
        if (!viewer) {
            return projected;
        }

        Object.entries(annotationsData || {}).forEach(([pageKey, pageAnnotations]) => {
            const pageIdx = Number(pageKey);
            const viewport = viewer.getViewportForPage(pageIdx + 1);
            if (!viewport) {
                return;
            }

            (pageAnnotations || []).forEach((ann) => {
                if (ann.type !== 'textbox' || !Array.isArray(ann.rect) || ann.rect.length !== 4) {
                    return;
                }

                const viewRect = RenderingModule.convertTopLeftRectToViewport(ann.rect, viewport);
                const x = Math.min(viewRect[0], viewRect[2]);
                const y = Math.min(viewRect[1], viewRect[3]);
                const width = Math.abs(viewRect[0] - viewRect[2]);
                const height = Math.abs(viewRect[1] - viewRect[3]);

                projected.push({
                    type: 'textbox',
                    pageIdx,
                    annotationId: ann.stable_id || ann.id || ann.xref || null,
                    content: ann.content || '',
                    x,
                    y,
                    width,
                    height,
                    color: ann.stroke_color_rgb
                        ? { name: ann.color || 'custom', rgb: ann.stroke_color_rgb }
                        : '#000',
                    stable_id: ann.stable_id || null,
                    id: ann.id || null,
                });
            });
        });

        return projected;
    }

    function refreshMarkupFromAnnotations() {
        const wrappers = getMarkupPageWrappers();

        if (DrawingCanvas) {
            DrawingCanvas.loadStrokesFromAnnotations(projectDrawingAnnotationsForCanvas());
            wrappers.forEach((wrapper, idx) => {
                if (!wrapper) return;
                DrawingCanvas.ensureCanvasForPage(idx, wrapper);
                DrawingCanvas.redrawPage(idx);
            });
        }

        if (TextboxModule) {
            TextboxModule.loadTextboxesFromAnnotations(projectTextboxAnnotationsForDom(), wrappers);
        }
    }

    function removeAnnotationEntryLocal(pageIdx, identifier) {
        const normalized = normalizeAnnotationIdentifierValue(identifier);
        if (normalized === null || !annotationsData[pageIdx]) {
            return;
        }

        annotationsData[pageIdx] = (annotationsData[pageIdx] || []).filter((ann) => {
            if (ann.xref && String(ann.xref) === normalized) {
                return false;
            }
            if (ann.requestIdentifier && normalizeAnnotationIdentifierValue(ann.requestIdentifier) === normalized) {
                return false;
            }
            if (resolveAnnotationIdentifierValue(ann) === normalized) {
                return false;
            }
            return true;
        });

        if (annotationsData[pageIdx].length === 0) {
            delete annotationsData[pageIdx];
        }
    }

    function upsertAnnotationEntryLocal(annotation, fallbackPageIdx) {
        if (!annotation) {
            return;
        }

        const enhanced = enhanceAnnotationEntry(annotation);
        const pageIdx = enhanced.page_index !== undefined ? enhanced.page_index : fallbackPageIdx;
        if (pageIdx === undefined || pageIdx === null) {
            return;
        }

        if (!annotationsData[pageIdx]) {
            annotationsData[pageIdx] = [];
        }

        const identifier = normalizeAnnotationIdentifierValue(resolveAnnotationIdentifierValue(enhanced));
        const xrefString = enhanced.xref ? String(enhanced.xref) : null;
        let replaced = false;

        annotationsData[pageIdx] = annotationsData[pageIdx].map((ann) => {
            const annIdentifier = normalizeAnnotationIdentifierValue(resolveAnnotationIdentifierValue(ann));
            if ((identifier !== null && annIdentifier === identifier) ||
                (xrefString && ann.xref && String(ann.xref) === xrefString)) {
                replaced = true;
                return enhanced;
            }
            return ann;
        });

        if (!replaced) {
            annotationsData[pageIdx].push(enhanced);
        }
    }

    function findAnnotationEntry(pageIdx, identifier) {
        const normalized = normalizeAnnotationIdentifierValue(identifier);
        if (normalized === null) {
            return undefined;
        }
        const pageEntries = annotationsData[pageIdx] || [];
        return pageEntries.find(
            (ann) => {
                // Check xref (as string) - CRITICAL FIX for cross-page moves
                if (ann.xref && String(ann.xref) === normalized) {
                    return true;
                }
                // Check requestIdentifier
                if (ann.requestIdentifier && normalizeAnnotationIdentifierValue(ann.requestIdentifier) === normalized) {
                    return true;
                }
                // Check resolved identifier
                if (resolveAnnotationIdentifierValue(ann) === normalized) {
                    return true;
                }
                if (ann._tempXref && String(ann._tempXref) === normalized) {
                    return true;
                }
                if (ann._tempIdentifier && String(ann._tempIdentifier) === normalized) {
                    return true;
                }
                return false;
            }
        );
    }

    async function loadAnnotations(submissionId, assignmentId = null) {
        if (_currentAnnotationCtrl && !_annotationCtrlDelegating) {
            return _currentAnnotationCtrl.loadAnnotations(submissionId, assignmentId);
        }
        throw new Error('Annotation controller must be initialized before loading annotations.');
    }

    // Track which annotation markers are currently visible in the viewport
    const visibleAnnotationMarkers = new Set();
    let _annotationObserver = null;
    let observerInitialized = false;  // Track if observer has completed initial detection
    let pendingAnnotationsListFrame = null;
    // Suppress observer-triggered sidebar re-renders during same-page drag/undo
    let _suppressSidebarRender = false;
    let _annotationVisibilityScrollHandler = null;

    function _scheduleAnnotationsListRender() {
        if (_suppressSidebarRender) return;
        if (pendingAnnotationsListFrame !== null) {
            return;
        }
        pendingAnnotationsListFrame = requestAnimationFrame(() => {
            pendingAnnotationsListFrame = null;
            if (!_suppressSidebarRender) {
                renderAnnotationsList();
            }
        });
    }

    function _isMarkerVisibleInContainer(marker, containerRect) {
        if (!marker || !containerRect) {
            return false;
        }

        const rect = marker.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const intersectionWidth = Math.min(rect.right, containerRect.right) - Math.max(rect.left, containerRect.left);
        const intersectionHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
        if (intersectionWidth <= 0 || intersectionHeight <= 0) {
            return false;
        }

        const visibleArea = intersectionWidth * intersectionHeight;
        const totalArea = rect.width * rect.height;
        return totalArea > 0 && (visibleArea / totalArea) >= 0.1;
    }

    function syncVisibleAnnotationMarkersFromDom() {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.syncVisibleMarkersFromDom) {
            throw new Error('Annotation controller must be initialized before syncing visible markers.');
        }
        const hasChanges = _currentAnnotationCtrl.syncVisibleMarkersFromDom();
        visibleAnnotationMarkers.clear();
        _currentAnnotationCtrl.getVisibleMarkers().forEach((markerKey) => {
            visibleAnnotationMarkers.add(markerKey);
        });
        observerInitialized = _currentAnnotationCtrl.isObserverInitialized
            ? _currentAnnotationCtrl.isObserverInitialized()
            : observerInitialized;
        return hasChanges;
    }

    /**
     * Initialize Intersection Observer to track marker visibility
     */
    function _initializeAnnotationObserver() {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.initializeAnnotationObserver || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before starting visibility observation.');
        }
        _currentAnnotationCtrl.initializeAnnotationObserver();
        visibleAnnotationMarkers.clear();
        _currentAnnotationCtrl.getVisibleMarkers().forEach((markerKey) => {
            visibleAnnotationMarkers.add(markerKey);
        });
        observerInitialized = _currentAnnotationCtrl.isObserverInitialized
            ? _currentAnnotationCtrl.isObserverInitialized()
            : observerInitialized;
    }

    /**
     * Observe an annotation marker for visibility changes
     */
    function observeAnnotationMarker(marker) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.observeAnnotationMarker || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before observing markers.');
        }
        _currentAnnotationCtrl.observeAnnotationMarker(marker);
    }

    /**
     * Unobserve an annotation marker
     */
    function _unobserveAnnotationMarker(marker) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.unobserveAnnotationMarker || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before unobserving markers.');
        }
        _currentAnnotationCtrl.unobserveAnnotationMarker(marker);
        visibleAnnotationMarkers.clear();
        _currentAnnotationCtrl.getVisibleMarkers().forEach((markerKey) => {
            visibleAnnotationMarkers.add(markerKey);
        });
    }

    function renderAnnotationsList() {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.renderList || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before rendering the sidebar.');
        }
        return _currentAnnotationCtrl.renderList();
    }

    // Debounced combined update for list + overlays to avoid double work
    function scheduleAnnotationUpdate() {
        clearTimeout(window._annotationUpdateTimer);
        window._annotationUpdateTimer = setTimeout(() => {
            renderAnnotationsList();
            if (typeof renderAllAnnotations === 'function') {
                renderAllAnnotations(true);
            }
        }, 50);
    }

    function highlightAnnotationSelection(pageIdx, identifierValue) {
        if (_currentAnnotationCtrl && !_annotationCtrlDelegating) {
            return _currentAnnotationCtrl.selectAnnotation(identifierValue, pageIdx);
        }
        const stableId = normalizeAnnotationIdentifierValue(identifierValue);
        if (stableId === null || Number.isNaN(pageIdx)) {
            return;
        }

        // FIX Issue #27: Store the selected annotation to preserve after scroll/re-render
        selectedAnnotation = { pageIdx: pageIdx, identifier: stableId };

        // Highlight markers on the PDF
        document.querySelectorAll('.annotation-marker').forEach(marker => {
            const markerId = normalizeAnnotationIdentifierValue(
                marker.dataset.annotationRequestId ||
                marker.dataset.annotationIdentifier ||
                marker.dataset.annotationXref
            );
            const markerPage = parseInt(marker.dataset.annotationPage);
            const isMatch = markerId === stableId && markerPage === pageIdx;
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

        // Highlight and focus the list item
        const listEl = document.getElementById('pdfGradedCommentsList');
        if (listEl) {
            const escapedId = escapeCssAttribute(stableId);
            const selector = [
                `.list-group-item[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `.list-group-item[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `.list-group-item[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`
            ].join(', ');
            const target = listEl.querySelector(selector);

            listEl.querySelectorAll('.list-group-item').forEach(li => {
                li.classList.remove('item-focused', 'active');
            });

            if (target) {
                target.classList.add('item-focused', 'active');
                // Focus without jumping the scroll too aggressively
                if (typeof target.focus === 'function') {
                    target.focus({ preventScroll: true });
                }
            }
        }
    }

    // DELETED: renderAnnotationsOverlay() - This function relied on global canvas/overlay elements
    // that no longer exist in continuous scroll mode. All annotation rendering is now handled by
    // renderAnnotationsForPage() which works with page-specific wrappers and overlays.

    /**
     * Smart label positioning: finds optimal corner to avoid overlaps and stay within bounds
     * @param {HTMLElement} marker - The annotation marker element
     * @param {HTMLElement} label - The label element to position
     * @param {HTMLElement} overlay - The overlay container
     */
    function positionLabelOptimally(marker, label, overlay, preComputed, options = {}) {
        if (!marker || !label || !overlay) return;

        // Use pre-computed rects when available (batch path from repositionAllLabels),
        // otherwise read from DOM (standalone calls e.g. after drag)
        const overlayRect = (preComputed && preComputed.overlayRect) || overlay.getBoundingClientRect();
        const markerRect = (preComputed && preComputed.markerRects && preComputed.markerRects.get(marker))
            || marker.getBoundingClientRect();

        // Label dimensions (estimate if not yet rendered)
        const labelWidth = label.offsetWidth || 120;
        const labelHeight = label.offsetHeight || 24;
        const gap = 2; // Gap between marker and label

        // Calculate marker position relative to overlay
        const markerLeft = markerRect.left - overlayRect.left;
        const markerTop = markerRect.top - overlayRect.top;
        const markerWidth = markerRect.width;
        const markerHeight = markerRect.height;
        const markerRight = markerLeft + markerRect.width;
        const markerBottom = markerTop + markerRect.height;
        const markerCenterX = markerLeft + markerWidth / 2;
        const markerCenterY = markerTop + markerRect.height / 2;
        const placementBounds = getLabelPlacementBounds(
            overlay,
            overlayRect,
            labelWidth,
            labelHeight,
            options,
        );

        // Collect collision rects. Marker rects are stable (use pre-computed);
        // label rects are read fresh since earlier labels may have been repositioned.
        const otherRects = [];
        const allLabels = overlay.querySelectorAll('.annotation-label');
        allLabels.forEach(otherLabel => {
            if (otherLabel !== label && otherLabel.offsetParent !== null) {
                const rect = otherLabel.getBoundingClientRect();
                otherRects.push({
                    left: rect.left - overlayRect.left,
                    top: rect.top - overlayRect.top,
                    right: rect.right - overlayRect.left,
                    bottom: rect.bottom - overlayRect.top,
                    isLabel: true
                });
            }
        });

        if (preComputed && preComputed.allMarkerRects) {
            // Use pre-computed marker collision rects (skip this marker)
            preComputed.allMarkerRects.forEach(mr => {
                if (mr.el !== marker) {
                    otherRects.push(mr);
                }
            });
        } else {
            const allMarkers = overlay.querySelectorAll('.annotation-marker');
            allMarkers.forEach(otherMarker => {
                if (otherMarker !== marker) {
                    const rect = otherMarker.getBoundingClientRect();
                    otherRects.push({
                        left: rect.left - overlayRect.left,
                        top: rect.top - overlayRect.top,
                        right: rect.right - overlayRect.left,
                        bottom: rect.bottom - overlayRect.top,
                        isMarker: true
                    });
                }
            });
        }

        const isExpandedLabel = label.classList.contains('label-expanded') || label.classList.contains('label-editing');

        // Calculate overlap area between two rectangles
        function getOverlapArea(rect1, rect2) {
            const xOverlap = Math.max(0, Math.min(rect1.right, rect2.right) - Math.max(rect1.left, rect2.left));
            const yOverlap = Math.max(0, Math.min(rect1.bottom, rect2.bottom) - Math.max(rect1.top, rect2.top));
            return xOverlap * yOverlap;
        }

        // Calculate total overlap for a label position
        function getOverlapTotals(left, top, width, height) {
            const labelRect = { left, top, right: left + width, bottom: top + height };
            let labelOverlap = 0;
            let markerOverlap = 0;
            for (const rect of otherRects) {
                const overlap = getOverlapArea(labelRect, rect);
                if (rect.isLabel) {
                    labelOverlap += overlap;
                } else {
                    markerOverlap += overlap;
                }
            }
            return {
                labelOverlap,
                markerOverlap,
                totalOverlap: labelOverlap + markerOverlap,
            };
        }

        // Define all possible positions
        const compactPositionNames = [
            'bottom-right',
            'top-right',
            'bottom-left',
            'top-left',
        ];
        const expandedPositionNames = [
            'right-center',
            'left-center',
            'bottom-right',
            'top-right',
            'bottom-left',
            'top-left',
            'top-center',
            'bottom-center',
        ];
        const positionNames = isExpandedLabel ? expandedPositionNames : compactPositionNames;
        const positions = positionNames.map((name) => buildNamedLabelPosition(
            name,
            markerLeft,
            markerTop,
            markerWidth,
            markerHeight,
            labelWidth,
            labelHeight,
            gap,
        )).filter(Boolean);
        const preferredPositionName = options.preferredPosition || '';
        const preservePreferredPosition = options.preservePreferredPosition === true;
        const stabilizeCompactPosition = options.stabilizeCompactPosition === true;

        // Score each position
        let bestPosition = positions[0];
        let bestScore = -Infinity;
        const pageBounds = {
            left: 0,
            top: 0,
            right: overlayRect.width,
            bottom: overlayRect.height,
        };
        const spaceLeft = Math.max(0, markerLeft - placementBounds.left);
        const spaceRight = Math.max(0, placementBounds.right - markerRight);
        const spaceAbove = Math.max(0, markerTop - placementBounds.top);
        const spaceBelow = Math.max(0, placementBounds.bottom - markerBottom);
        const nearLeftEdge = spaceLeft <= labelWidth + gap + 16;
        const nearRightEdge = spaceRight <= labelWidth + gap + 16;
        const nearTopEdge = spaceAbove <= labelHeight + gap + 20;
        const nearBottomEdge = spaceBelow <= labelHeight + gap + 16;
        const nearUpperLeftCorner =
            spaceLeft <= labelWidth + 28 &&
            spaceAbove <= labelHeight + 28;
        const nearUpperRightCorner =
            spaceRight <= labelWidth + 28 &&
            spaceAbove <= labelHeight + 28;
        const shouldKeepStableCompactPosition = () => {
            if (isExpandedLabel || !stabilizeCompactPosition || !preferredPositionName) {
                return false;
            }
            const preferredPosition = positions.find((position) => position.name === preferredPositionName);
            if (!preferredPosition) {
                return false;
            }
            const boundsOverflow = getBoundsOverflow(
                preferredPosition.left,
                preferredPosition.top,
                labelWidth,
                labelHeight,
                placementBounds,
            );
            const pageOverflow = getBoundsOverflow(
                preferredPosition.left,
                preferredPosition.top,
                labelWidth,
                labelHeight,
                pageBounds,
            );
            if (boundsOverflow > 0 || pageOverflow > 0) {
                return false;
            }

            const horizontalHysteresis = Math.min(64, Math.max(48, Math.round(labelWidth * 0.45)));
            const verticalHysteresis = Math.min(28, Math.max(18, Math.round(labelHeight * 0.5)));

            if (preferredPositionName.includes('left') && spaceLeft < Math.max(0, labelWidth + gap - horizontalHysteresis)) {
                return false;
            }
            if (preferredPositionName.includes('right') && spaceRight < Math.max(0, labelWidth + gap - horizontalHysteresis)) {
                return false;
            }
            if (preferredPositionName.startsWith('top') && spaceAbove < Math.max(0, labelHeight + gap - verticalHysteresis)) {
                return false;
            }
            if (preferredPositionName.startsWith('bottom') && spaceBelow < Math.max(0, labelHeight + gap - verticalHysteresis)) {
                return false;
            }
            return true;
        };
        const positionMetrics = positions.map(pos => {
            const boundsOverflow = getBoundsOverflow(
                pos.left,
                pos.top,
                labelWidth,
                labelHeight,
                placementBounds,
            );
            const pageOverflow = getBoundsOverflow(
                pos.left,
                pos.top,
                labelWidth,
                labelHeight,
                pageBounds,
            );
            const overlaps = getOverlapTotals(pos.left, pos.top, labelWidth, labelHeight);
            return {
                pos,
                boundsOverflow,
                pageOverflow,
                overlaps,
                fullyVisible: boundsOverflow === 0 && pageOverflow === 0,
            };
        });
        const hasFullyVisiblePosition = positionMetrics.some(metric => metric.fullyVisible);

        for (const metric of positionMetrics) {
            const pos = metric.pos;
            let score = 0;

            const boundsOverflow = metric.boundsOverflow;
            const pageOverflow = metric.pageOverflow;
            const overlapTotals = metric.overlaps;
            if (hasFullyVisiblePosition && (boundsOverflow > 0 || pageOverflow > 0)) {
                continue;
            }

            score -= boundsOverflow * 240;
            score -= pageOverflow * (isExpandedLabel ? 320 : 220);

            const labelOverlapPenalty = isExpandedLabel ? 1.2 : 20;
            const markerOverlapPenalty = isExpandedLabel ? 12 : 10;
            score -= overlapTotals.labelOverlap * labelOverlapPenalty;
            score -= overlapTotals.markerOverlap * markerOverlapPenalty;

            // Slight preference for positions that don't cover markers below
            // If there's a marker below this one, prefer top positions
            const hasMarkerBelow = otherRects.some(r => r.isMarker && r.top > markerCenterY);
            const hasMarkerAbove = otherRects.some(r => r.isMarker && r.bottom < markerCenterY);

            if (pos.name.startsWith('top') && hasMarkerBelow) {
                score += 40; // Bonus for top when there's stuff below
            }
            if (pos.name.startsWith('bottom') && hasMarkerAbove && !hasMarkerBelow) {
                score += 40; // Bonus for bottom when there's stuff above but not below
            }

            if (pageOverflow > 0) {
                score -= Math.max(40, pageOverflow * 24);
            }

            if (pos.name.includes('left') && spaceLeft < labelWidth + gap) {
                score -= (labelWidth + gap - spaceLeft) * 18;
            }
            if (pos.name.includes('right') && spaceRight < labelWidth + gap) {
                score -= (labelWidth + gap - spaceRight) * 18;
            }
            if (pos.name.startsWith('top') && spaceAbove < labelHeight + gap) {
                score -= (labelHeight + gap - spaceAbove) * 24;
            }
            if (pos.name.startsWith('bottom') && spaceBelow < labelHeight + gap) {
                score -= (labelHeight + gap - spaceBelow) * 16;
            }

            if (nearLeftEdge && pos.name.includes('right')) {
                score += 70;
            }
            if (nearLeftEdge && pos.name.includes('left')) {
                score -= 55;
            }
            if (nearRightEdge && pos.name.includes('left')) {
                score += 70;
            }
            if (nearRightEdge && pos.name.includes('right')) {
                score -= 55;
            }
            if (nearTopEdge && pos.name.startsWith('bottom')) {
                score += 52;
            }
            if (nearTopEdge && pos.name.startsWith('top')) {
                score -= 90;
            }
            if (nearBottomEdge && pos.name.startsWith('top')) {
                score += 36;
            }
            if (nearBottomEdge && pos.name.startsWith('bottom')) {
                score -= 30;
            }

            if (isExpandedLabel) {
                if (pos.name.includes('center')) {
                    score += 28;
                }
                if (pos.name.includes('right') && spaceRight >= labelWidth + gap) {
                    score += 42;
                }
                if (pos.name.includes('left') && spaceLeft >= labelWidth + gap) {
                    score += 28;
                }
                if (pos.name.startsWith('top') && spaceAbove >= labelHeight + gap) {
                    score += 16;
                }
                if (pos.name.startsWith('bottom') && spaceBelow >= labelHeight + gap) {
                    score += 16;
                }
            }

            const labelRect = {
                left: pos.left,
                top: pos.top,
                right: pos.left + labelWidth,
                bottom: pos.top + labelHeight,
            };
            const protectedCorner = {
                left: 0,
                top: 0,
                right: Math.min(overlayRect.width * 0.28, 180),
                bottom: Math.min(overlayRect.height * 0.16, 120),
            };
            score -= getOverlapArea(labelRect, protectedCorner) * 16;

            const nearTopBand = markerTop <= Math.min(overlayRect.height * 0.22, 170);
            const nearLeftThird = markerLeft <= overlayRect.width * 0.38;
            if (nearTopBand && pos.name.startsWith('top')) {
                score -= 120;
            }
            if (nearTopBand && pos.name.startsWith('bottom')) {
                score += 45;
            }
            if (nearTopBand && nearLeftThird && (pos.name.includes('left') || pos.name === 'top-center')) {
                score -= 80;
            }
            if (nearTopBand && nearLeftThird && pos.name.includes('right')) {
                score += 32;
            }

            if (nearUpperLeftCorner) {
                if (pos.name === 'top-left' || pos.name === 'left-center' || pos.name === 'top-center') {
                    score -= 140;
                }
                if (pos.name === 'right-center' || pos.name === 'bottom-right' || pos.name === 'bottom-center') {
                    score += 48;
                }
            }

            if (nearUpperRightCorner) {
                if (pos.name === 'top-right' || pos.name === 'right-center' || pos.name === 'top-center') {
                    score -= 140;
                }
                if (pos.name === 'left-center' || pos.name === 'bottom-left' || pos.name === 'bottom-center') {
                    score += 48;
                }
            }

            if ((pos.name === 'left-center' || pos.name === 'right-center') && otherRects.length >= 4) {
                score += 20;
            }

            const dx = pos.left + labelWidth / 2 - markerCenterX;
            const dy = pos.top + labelHeight / 2 - markerCenterY;
            score -= Math.hypot(dx, dy) * 0.08;

            if (score > bestScore) {
                bestScore = score;
                bestPosition = pos;
            }
        }

        if ((preservePreferredPosition || shouldKeepStableCompactPosition()) && preferredPositionName) {
            const preferredPosition = positions.find((position) => position.name === preferredPositionName);
            if (preferredPosition) {
                bestPosition = preferredPosition;
            }
        }

        // Apply the best position
        label.style.top = bestPosition.css.top;
        label.style.left = bestPosition.css.left;
        label.style.bottom = bestPosition.css.bottom;
        label.style.right = bestPosition.css.right;
        label.style.transform = bestPosition.css.transform;

        // Store the transform and position for hover effects and tooltip direction
        label.dataset.anchorTransform = bestPosition.css.transform;
        label.dataset.baseTransform = bestPosition.css.transform;
        delete label.dataset.residualDx;
        delete label.dataset.residualDy;
        label.dataset.position = bestPosition.name;  // e.g., 'bottom-right', 'top-left'
        if (!isExpandedLabel) {
            label.dataset.compactPosition = bestPosition.name;
            label.dataset.compactAnchorTransform = bestPosition.css.transform;
        }
    }

    /**
     * Reposition all labels in an overlay to avoid overlaps
     * Called after any marker is moved
     * @param {HTMLElement} overlay - The overlay container
     * @param {string} [priorityIdentifier] - Optional annotation identifier that should keep its position (just-dragged)
     */
    function repositionAllLabels(overlay, priorityIdentifier) {
        if (!overlay) return;

        // Get all markers and sort by vertical position (top to bottom)
        const markers = Array.from(overlay.querySelectorAll('.annotation-marker'));

        // Batch-read all bounding rects ONCE before sorting or positioning
        const overlayRect = overlay.getBoundingClientRect();
        const markerRects = new Map();
        markers.forEach(m => {
            markerRects.set(m, m.getBoundingClientRect());
        });

        markers.sort((a, b) => {
            return markerRects.get(a).top - markerRects.get(b).top;
        });

        // Pre-compute stable marker collision rects (markers don't move during repositioning)
        const allMarkerRects = [];
        markers.forEach(m => {
            const rect = markerRects.get(m);
            allMarkerRects.push({
                el: m,
                left: rect.left - overlayRect.left,
                top: rect.top - overlayRect.top,
                right: rect.right - overlayRect.left,
                bottom: rect.bottom - overlayRect.top,
                isMarker: true
            });
        });

        // Build pre-computed data to pass into positionLabelOptimally
        const preComputed = { overlayRect, markerRects, allMarkerRects };

        // Position labels in order from top to bottom (skip priority marker)
        markers.forEach(marker => {
            if (priorityIdentifier) {
                const markerIdentifier = marker.dataset.identifier ||
                    marker.dataset.annotationRequestId ||
                    marker.dataset.annotationXref ||
                    marker.dataset.annotationIdentifier;
                if (markerIdentifier === priorityIdentifier) {
                    return; // Skip - keep its current position
                }
            }

            const label = marker.querySelector('.annotation-label');
            if (label) {
                positionLabelOptimally(marker, label, overlay, preComputed);
            }
        });

        const hasExpandedOrEditingLabels = markers.some(marker => {
            const label = marker.querySelector('.annotation-label');
            return label && (
                label.classList.contains('label-expanded') ||
                label.classList.contains('label-editing')
            );
        });

        // Keep compact labels anchored tightly to their marker corner. The
        // residual overlap packer deliberately detaches labels from their
        // original anchor to make room, which is useful while editing but
        // visually wrong for the resting annotation state.
        if (hasExpandedOrEditingLabels) {
            resolveResidualLabelOverlaps(overlay);
        }
    }

    // Helper function to re-render annotations for all rendered pages (continuous scroll)
    function renderAllAnnotations(forceRender = false) {
        if (_currentOverlayRenderer) return _currentOverlayRenderer.renderAnnotations(forceRender);
        throw new Error('Overlay renderer must be initialized before rendering annotations.');
    }

    /**
     * Update a single marker's DOM position in-place without recreating all markers.
     * Used for same-page drags and undo to avoid destroying IntersectionObserver tracking.
     *
     * @param {HTMLElement} marker - The annotation marker element
     * @param {Object} ann - The annotation data with .rect
     * @param {number} pageIdx - 0-based page index
     */
    function updateMarkerPositionInPlace(marker, ann, pageIdx) {
        const viewer = window.__pdfGradedViewer;
        if (!viewer || !marker) return;

        const pageNum = pageIdx + 1;
        const viewport = viewer.getViewportForPage(pageNum);
        if (!viewport) return;

        const container = document.getElementById('pdfGradedContainer');
        const wrapper = container ? container.querySelector('.pdf-page-wrapper[data-page-num="' + pageNum + '"]') : null;
        if (!wrapper) return;
        const canvas = wrapper.querySelector('.pdf-page-canvas');
        if (!canvas) return;

        const canvasRect = canvas.getBoundingClientRect();
        const canvasWidth = canvas.clientWidth || canvasRect.width;
        const canvasHeight = canvas.clientHeight || canvasRect.height;
        if (!canvasWidth || !canvasHeight) return;

        const scaleX = canvasWidth / viewport.width;
        const scaleY = canvasHeight / viewport.height;

        const rect = ann.rect;
        if (!Array.isArray(rect) || rect.length !== 4) return;

        const Rendering = window.PdfPreviewModalRendering || {};
        const convertFn = Rendering.convertTopLeftRectToViewport || function (r) { return r; };
        const zoom = (viewer && viewer.zoom) || 1.0;
        const MIN_SIZE = Math.round((Rendering.MIN_MARKER_SIZE || 16) * zoom);

        const viewportRect = convertFn(rect, viewport);
        const minX = Math.min(viewportRect[0], viewportRect[2]);
        const maxX = Math.max(viewportRect[0], viewportRect[2]);
        const minY = Math.min(viewportRect[1], viewportRect[3]);
        const maxY = Math.max(viewportRect[1], viewportRect[3]);

        marker.style.left = (minX * scaleX) + 'px';
        marker.style.top = (minY * scaleY) + 'px';
        marker.style.width = Math.max((maxX - minX) * scaleX, MIN_SIZE) + 'px';
        marker.style.height = Math.max((maxY - minY) * scaleY, MIN_SIZE) + 'px';

        // Reposition labels to avoid overlaps after position change
        const overlay = marker.closest('.pdf-annotation-overlay');
        if (overlay) {
            requestAnimationFrame(function () {
                const label = marker.querySelector('.annotation-label');
                const priorityIdentifier = marker.dataset.identifier ||
                    marker.dataset.annotationRequestId ||
                    marker.dataset.annotationXref ||
                    marker.dataset.annotationIdentifier;
                if (label) {
                    const preferredPosition = label.dataset.compactPosition || label.dataset.position || '';
                    positionLabelOptimally(marker, label, overlay, undefined, {
                        preferredPosition,
                        stabilizeCompactPosition: true,
                    });
                }
                repositionAllLabels(overlay, priorityIdentifier);
            });
        }
    }

    // New function for continuous scroll: renders annotations for a specific page
    function renderAnnotationsForPage(pageNum, forceRender = false) {
        if (_currentOverlayRenderer) return _currentOverlayRenderer.renderPage(pageNum, forceRender);
        throw new Error('Overlay renderer must be initialized before rendering a page overlay.');
    }

    async function createTemporaryAnnotation(rect, pageIdx) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.createTemporaryAnnotation || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before creating annotations.');
        }
        return _currentAnnotationCtrl.createTemporaryAnnotation(rect, pageIdx);
    }

    /**
     * Cleanup function that deletes all placeholder annotations from the database.
     * Called on page load to remove stuck "New comment..." annotations that were
     * created but never edited (when Escape/blur deletion failed).
     */
    async function cleanupPlaceholderAnnotations() {
        const logCleanup = (...args) => {
            if (PDF_DEBUG) debugLog(...args);
        };
        logCleanup('[CLEANUP] Starting cleanup of placeholder annotations...');

        const placeholdersToDelete = [];

        // Find all placeholder annotations
        for (let pageIdx in annotationsData) {
            const pageAnns = annotationsData[pageIdx] || [];
            pageAnns.forEach((ann) => {
                const isPlaceholder = isPlaceholderAnnotation(ann);
                const hasEdits = ann._hasBeenEdited === true || ann._priorityChanged === true;

                if (isPlaceholder && !hasEdits) {
                    const identifier = resolveAnnotationIdentifierValue(ann);
                    placeholdersToDelete.push({
                        pageIdx: parseInt(pageIdx),
                        identifier: identifier,
                        xref: ann.xref,
                        content: ann.content
                    });
                }
            });
        }

        if (placeholdersToDelete.length === 0) {
            logCleanup('[CLEANUP] ✓ No placeholder annotations found');
            return;
        }

        logCleanup(`[CLEANUP] Found ${placeholdersToDelete.length} placeholder annotations to delete:`);
        placeholdersToDelete.forEach((p, idx) => {
            logCleanup(`  [${idx}] page=${p.pageIdx}, xref=${p.xref}, identifier=${p.identifier}, content="${p.content}"`);
        });

        // Delete each placeholder
        let deletedCount = 0;
        let failedCount = 0;

        for (const placeholder of placeholdersToDelete) {
            const stableIdentifier = normalizeAnnotationIdentifierValue(placeholder.identifier);
            if (!stableIdentifier) {
                logCleanup(`[CLEANUP] ⚠️ Skipping placeholder with no stable identifier:`, placeholder);
                failedCount++;
                continue;
            }

            try {
                const apiIdentifier = buildApiAnnotationIdentifier({
                    identifier: stableIdentifier,
                    xref: null,
                    requestId: null,
                });

                if (!apiIdentifier) {
                    logCleanup(`[CLEANUP] ⚠️ Could not build API identifier for:`, placeholder);
                    failedCount++;
                    continue;
                }

                const data = await deleteAnnotationRequest(apiIdentifier);
                if (data.success) {
                    // Remove from annotationsData
                    if (annotationsData[placeholder.pageIdx]) {
                        const removalIdx = findAnnotationIndex(placeholder.pageIdx, stableIdentifier);
                        if (removalIdx >= 0) {
                            annotationsData[placeholder.pageIdx].splice(removalIdx, 1);
                            deletedCount++;
                            logCleanup(`[CLEANUP] ✓ Deleted placeholder: page=${placeholder.pageIdx}, xref=${placeholder.xref}`);
                        }
                    }
                } else {
                    logCleanup(`[CLEANUP] ❌ Backend returned success=false for xref=${placeholder.xref}`);
                    failedCount++;
                }
            } catch (error) {
                console.error(`[CLEANUP] ❌ Error deleting placeholder xref=${placeholder.xref}:`, error);
                failedCount++;
            }
        }

        logCleanup(`[CLEANUP] ✓ Cleanup complete: deleted=${deletedCount}, failed=${failedCount}, total=${placeholdersToDelete.length}`);
    }

    async function deleteAnnotationSilently(pageIdx, identifier) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.deleteAnnotationSilently || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before silently deleting annotations.');
        }
        return _currentAnnotationCtrl.deleteAnnotationSilently(pageIdx, identifier);
    }

    function makeAnnotationDraggable(marker, identifier) {
        const stableIdentifier =
            normalizeAnnotationIdentifierValue(identifier)
            || normalizeAnnotationIdentifierValue(marker?.dataset?.annotationRequestId)
            || normalizeAnnotationIdentifierValue(marker?.dataset?.annotationIdentifier)
            || normalizeAnnotationIdentifierValue(marker?.dataset?.annotationXref);
        if (!stableIdentifier) {
            marker.style.cursor = 'not-allowed';
            return;
        }

        let isDragging = false;
        let hasMoved = false;
        let startX, startY, initialLeft, initialTop;
        let dragSourceWrapper = null;
        let dragSourceWrapperOriginalOverflow = '';
        let dragSourceWrapperOriginalZIndex = '';

        // CRITICAL FIX: Find actual source page by searching annotationsData
        // marker.dataset.annotationPage can be stale after previous moves
        const markerIdentifier = stableIdentifier;
        let sourcePageIdx = null;

        // Search all pages to find where this annotation currently lives
        for (let pageIdx in annotationsData) {
            const pageAnns = annotationsData[pageIdx] || [];
            const found = pageAnns.find(ann => {
                const annId = resolveAnnotationIdentifierValue(ann);
                return annId === markerIdentifier;
            });
            if (found) {
                sourcePageIdx = parseInt(pageIdx);
                break;
            }
        }

        // Fallback if not found in data
        if (sourcePageIdx === null) {
            sourcePageIdx = parseInt(marker.dataset.annotationPage) || currentAnnotationsPage;
            if (PDF_DEBUG) {
                debugLog(`[DRAG-START] Could not find annotation "${markerIdentifier}" in annotationsData, using fallback page ${sourcePageIdx}`);
            }
        }

        let targetPageIdx = sourcePageIdx;
        let highlightedWrapper = null;
        // Fix 4A: Cache page wrapper rects at drag start to avoid per-mousemove DOM queries
        let cachedPageRects = [];

        // Clean up any existing handlers
        cleanupDragHandlers();

        const handleMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!hasMoved && (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)) {
                hasMoved = true;
            }

            // Calculate new position
            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            // Cross-page detection: find which page the mouse is over
            // NOTE: Do this BEFORE clamping so we can detect cross-page intent
            const mouseX = e.clientX;
            const mouseY = e.clientY;
            let newTargetPageIdx = sourcePageIdx;

            // Use cached rects instead of querying DOM per mousemove
            for (const cached of cachedPageRects) {
                if (mouseX >= cached.rect.left && mouseX <= cached.rect.right &&
                    mouseY >= cached.rect.top && mouseY <= cached.rect.bottom) {
                    newTargetPageIdx = cached.pageIdx;
                    break;
                }
            }

            // Update visual feedback if target page changed
            if (newTargetPageIdx !== targetPageIdx) {
                // Remove previous highlight
                if (highlightedWrapper) {
                    highlightedWrapper.style.outline = '';
                }

                targetPageIdx = newTargetPageIdx;

                // Add highlight to new target page (if different from source)
                if (targetPageIdx !== sourcePageIdx) {
                    const targetWrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${targetPageIdx + 1}"]`);
                    if (targetWrapper) {
                        targetWrapper.style.outline = '3px solid #0d6efd';
                        targetWrapper.style.outlineOffset = '-3px';
                        highlightedWrapper = targetWrapper;
                    }
                } else {
                    highlightedWrapper = null;
                }
            }

            // FIX Issue #29 + Cross-page drag: Only clamp to overlay bounds when staying on same page
            // When dragging to another page, allow marker to move freely for visual feedback
            const overlay = marker.parentElement;
            if (overlay && targetPageIdx === sourcePageIdx) {
                const markerWidth = marker.offsetWidth || 50;
                const markerHeight = marker.offsetHeight || 30;
                const overlayWidth = overlay.offsetWidth || 0;
                const overlayHeight = overlay.offsetHeight || 0;

                // Clamp left/top to keep marker fully within overlay (same page only)
                newLeft = Math.max(0, Math.min(newLeft, overlayWidth - markerWidth));
                newTop = Math.max(0, Math.min(newTop, overlayHeight - markerHeight));
            }

            // Update marker visual position
            marker.style.left = `${newLeft}px`;
            marker.style.top = `${newTop}px`;
        };

        const handleMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                marker.style.cursor = 'move';
                if (dragSourceWrapper) {
                    dragSourceWrapper.style.overflow = dragSourceWrapperOriginalOverflow;
                    dragSourceWrapper.style.zIndex = dragSourceWrapperOriginalZIndex;
                }

                // Remove highlight
                if (highlightedWrapper) {
                    highlightedWrapper.style.outline = '';
                    highlightedWrapper = null;
                }

                // Only persist position if the marker actually moved
                if (hasMoved) {
                    if (targetPageIdx !== sourcePageIdx) {
                        // Optimistic cross-page move: re-parent immediately to prevent
                        // temporary clipping/disappearance while async API update runs.
                        const targetWrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${targetPageIdx + 1}"]`);
                        const targetOverlay = targetWrapper
                            ? targetWrapper.querySelector('.pdf-annotation-overlay')
                            : null;
                        if (targetOverlay) {
                            const markerRect = marker.getBoundingClientRect();
                            const overlayRect = targetOverlay.getBoundingClientRect();
                            const optimisticLeft = markerRect.left - overlayRect.left;
                            const optimisticTop = markerRect.top - overlayRect.top;
                            marker.style.left = `${Math.max(0, optimisticLeft)}px`;
                            marker.style.top = `${Math.max(0, optimisticTop)}px`;
                            targetOverlay.appendChild(marker);
                            marker.dataset.annotationPage = String(targetPageIdx);
                        }

                        const movedXref = normalizeAnnotationIdentifierValue(
                            marker?.dataset?.annotationXref
                        );
                        if (movedXref) {
                            const sourceMarkerKey = buildAnnotationVisibilityKey(sourcePageIdx, {
                                xref: movedXref,
                                identifier: stableIdentifier,
                            });
                            const targetMarkerKey = buildAnnotationVisibilityKey(targetPageIdx, {
                                xref: movedXref,
                                identifier: stableIdentifier,
                            });
                            if (sourceMarkerKey) {
                                visibleAnnotationMarkers.delete(sourceMarkerKey);
                            }
                            if (targetMarkerKey) {
                                visibleAnnotationMarkers.add(targetMarkerKey);
                            }
                        }

                        currentAnnotationsPage = targetPageIdx;
                        renderAnnotationsList();
                    }

                    // Detect ownership transfer (AI annotation being moved)
                    const currentSource = marker.dataset.annotationSource;
                    const isOwnershipTransfer = currentSource === 'AI';

                    if (isOwnershipTransfer) {
                        // Visual feedback immediately
                        marker.classList.add('ownership-transferred');
                        setTimeout(() => marker.classList.remove('ownership-transferred'), 500);

                        // Update marker classes immediately
                        marker.classList.remove('source-ai');
                        marker.classList.add('source-human');
                        marker.dataset.annotationSource = 'HUMAN';
                    }

                    // Pass both source and target page indices
                    // NOTE: _isDraggingAnnotation will be cleared inside updateAnnotationPosition
                    // after the async API call completes (to prevent blur handler race condition)
                    updateAnnotationPosition(sourcePageIdx, targetPageIdx, stableIdentifier, marker, isOwnershipTransfer);
                } else {
                    // FIX Issue #32: Only clear flag here if marker didn't move (no async call)
                    _isDraggingAnnotation = false;
                }
                cleanupDragHandlers();
            }
        };

        marker.addEventListener('mousedown', (e) => {
            // CRITICAL FIX: Don't start drag if label is in editing mode
            // (user is trying to position cursor in text, not move the annotation)
            const label = marker.querySelector('.annotation-label');
            if (label && label.classList.contains('label-editing')) {
                return; // Allow normal text selection/cursor positioning
            }

            // Also don't drag if clicking directly on the inline textarea
            if (e.target.classList.contains('inline-annotation-editor') ||
                e.target.tagName === 'TEXTAREA') {
                return;
            }

            isDragging = true;
            _isDraggingAnnotation = true; // FIX Issue #32: Set global flag
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;

            // Fix 4A: Pre-compute all page wrapper rects once at drag start
            cachedPageRects = [];
            const viewer = window.__pdfGradedViewer;
            if (viewer && viewer.pdf) {
                for (let pageNum = 1; pageNum <= viewer.pdf.numPages; pageNum++) {
                    const wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${pageNum}"]`);
                    if (wrapper) {
                        cachedPageRects.push({ pageIdx: pageNum - 1, rect: wrapper.getBoundingClientRect() });
                    }
                }
            }
            // CRITICAL FIX: Use offsetLeft/Top (relative to parent) not getBoundingClientRect (absolute)
            // This ensures marker follows mouse accurately
            initialLeft = marker.offsetLeft;
            initialTop = marker.offsetTop;
            marker.style.cursor = 'grabbing';
            dragSourceWrapper = marker.closest('.pdf-page-wrapper');
            if (dragSourceWrapper) {
                dragSourceWrapperOriginalOverflow = dragSourceWrapper.style.overflow;
                dragSourceWrapperOriginalZIndex = dragSourceWrapper.style.zIndex;
                dragSourceWrapper.style.overflow = 'visible';
                dragSourceWrapper.style.zIndex = '1000';
            }
            e.preventDefault();

            // Attach handlers only when dragging starts
            dragHandlers.mousemove = handleMouseMove;
            dragHandlers.mouseup = handleMouseUp;
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });

        // Store cleanup reference on marker
        marker._cleanupDrag = () => {
            if (dragSourceWrapper) {
                dragSourceWrapper.style.overflow = dragSourceWrapperOriginalOverflow;
                dragSourceWrapper.style.zIndex = dragSourceWrapperOriginalZIndex;
            }
            if (dragHandlers.mousemove) {
                document.removeEventListener('mousemove', dragHandlers.mousemove);
            }
            if (dragHandlers.mouseup) {
                document.removeEventListener('mouseup', dragHandlers.mouseup);
            }
            dragHandlers.mousemove = null;
            dragHandlers.mouseup = null;
        };
    }

    function cleanupDragHandlers() {
        if (dragHandlers.mousemove) {
            document.removeEventListener('mousemove', dragHandlers.mousemove);
        }
        if (dragHandlers.mouseup) {
            document.removeEventListener('mouseup', dragHandlers.mouseup);
        }
        dragHandlers.mousemove = null;
        dragHandlers.mouseup = null;
    }

    // Clean up drag handlers when modal is closed
    document.addEventListener('hidden.bs.modal', (e) => {
        if (e.target.id === 'pdfPreviewModal') {
            cleanupDragHandlers();
            // Also clean up any marker cleanup functions
            document.querySelectorAll('.annotation-marker').forEach(marker => {
                if (marker._cleanupDrag) {
                    marker._cleanupDrag();
                }
            });
        }
    });

    // Edit/Delete functions
    function editAnnotation(pageIdx, identifier, domId) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.beginEdit || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before editing annotations.');
        }
        return _currentAnnotationCtrl.beginEdit(pageIdx, identifier, domId);
    }

    async function saveAnnotationEdit(identifier, sourceButton = null) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.saveAnnotationEdit || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before saving annotations.');
        }
        return _currentAnnotationCtrl.saveAnnotationEdit(identifier, sourceButton);
    }

    function applyVerdictIconState(iconEl, isVerdict) {
        if (!iconEl) return;
        iconEl.classList.toggle('bi-patch-check-fill', !!isVerdict);
        iconEl.classList.toggle('bi-patch-check', !isVerdict);
        iconEl.classList.toggle('verdict-inactive', !isVerdict);
        iconEl.title = isVerdict ? 'Verdict comment' : 'Mark as verdict';
    }

    function getPriorityRgb(priority) {
        if (priority === 'red') {
            return { r: 255, g: 0, b: 0 };
        }
        if (priority === 'green') {
            return { r: 0, g: 200, b: 0 };
        }
        return { r: 255, g: 165, b: 0 };
    }

    function applyPriorityStylesToMarker(marker, priority) {
        if (!marker) return;
        const { r, g, b } = getPriorityRgb(priority);
        const annotationType = (marker.dataset.annotationType || '').toLowerCase();

        marker.style.border = 'none';
        marker.style.backgroundColor = `rgba(${r}, ${g}, ${b}, 0.25)`;
        marker.style.backgroundImage = 'none';
        marker.style.boxShadow = 'none';
        marker.style.borderRadius = '2px';

        // Reset style variants first.
        marker.style.borderTop = 'none';
        marker.style.borderLeft = 'none';
        marker.style.borderRight = 'none';
        marker.style.borderBottom = 'none';
        marker.style.borderBottomWidth = '';
        marker.style.borderBottomColor = '';
        marker.style.textDecoration = '';
        marker.style.textDecorationColor = '';
        marker.style.textDecorationThickness = '';

        if (annotationType === 'underline') {
            marker.style.borderBottomWidth = '2px';
            marker.style.borderBottomColor = `rgba(${r}, ${g}, ${b}, 0.7)`;
        } else if (annotationType === 'squiggly') {
            marker.style.borderBottom = `2px wavy rgba(${r}, ${g}, ${b}, 0.7)`;
        } else if (annotationType === 'strikeout') {
            marker.style.textDecoration = 'line-through';
            marker.style.textDecorationColor = `rgba(${r}, ${g}, ${b}, 0.7)`;
            marker.style.textDecorationThickness = '2px';
        }

        // Update icon badge color to match new priority
        const iconEl = marker.querySelector('.annotation-marker-icon');
        if (iconEl) {
            if (priority === 'red') {
                iconEl.style.color = '#ef4444';
            } else if (priority === 'amber') {
                iconEl.style.color = '#f59e0b';
            } else {
                iconEl.style.color = '#22c55e';
            }
        }

        const label = marker.querySelector('.annotation-label');
        if (label) {
            label.style.borderLeft = `4px solid rgba(${r}, ${g}, ${b}, 1)`;
            label.style.setProperty('--annotation-number-color', `rgba(${r}, ${g}, ${b}, 0.62)`);
        }
    }

    function updateAnnotationPriorityUi(pageIdx, identifierCandidates, priority) {
        const uniqueIds = Array.from(
            new Set(
                (identifierCandidates || [])
                    .map(value => normalizeAnnotationIdentifierValue(value))
                    .filter(value => value !== null)
            )
        );
        if (!uniqueIds.length || Number.isNaN(pageIdx)) {
            return;
        }

        const badgeByPriority = {
            red: 'bg-danger',
            amber: 'bg-warning',
            green: 'bg-success',
        };

        uniqueIds.forEach((idValue) => {
            const escapedId = escapeCssAttribute(idValue);
            const listSelector = [
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`,
            ].join(', ');

            document.querySelectorAll(listSelector).forEach((listItem) => {
                const dots = listItem.querySelectorAll('.priority-dot');
                dots.forEach((dotEl) => {
                    dotEl.classList.toggle('active', dotEl.dataset.priority === priority);
                });

                const badge = listItem.querySelector('.badge');
                if (badge) {
                    badge.classList.remove('bg-danger', 'bg-warning', 'bg-success');
                    badge.classList.add(badgeByPriority[priority] || 'bg-warning');
                }
            });

            const markerSelector = [
                `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`,
                `.annotation-marker[data-page-idx="${pageIdx}"][data-identifier="${escapedId}"]`,
            ].join(', ');
            document.querySelectorAll(markerSelector).forEach((markerEl) => {
                applyPriorityStylesToMarker(markerEl, priority);
            });
        });
    }

    function updateAnnotationVerdictUi(pageIdx, identifierCandidates, isVerdict) {
        const uniqueIds = Array.from(
            new Set(
                (identifierCandidates || [])
                    .map(value => normalizeAnnotationIdentifierValue(value))
                    .filter(value => value !== null)
            )
        );
        if (!uniqueIds.length || Number.isNaN(pageIdx)) {
            return;
        }

        uniqueIds.forEach((idValue) => {
            const escapedId = escapeCssAttribute(idValue);
            const listSelector = [
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `#pdfGradedCommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-request-id="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-identifier="${escapedId}"]`,
                `#pdfGradedAICommentsList .list-group-item[data-annotation-page="${pageIdx}"][data-annotation-xref="${escapedId}"]`,
            ].join(', ');

            document.querySelectorAll(listSelector).forEach((listItem) => {
                listItem.classList.toggle('is-verdict', !!isVerdict);
                const icon = listItem.querySelector('.verdict-indicator');
                applyVerdictIconState(icon, isVerdict);
            });
        });
    }

    async function toggleAnnotationVerdict(pageIdx, identifier, clickedIcon = null) {
        const stableIdentifier = normalizeAnnotationIdentifierValue(identifier);
        if (!stableIdentifier) {
            showToast('error', 'Unable to determine which annotation to update.');
            return;
        }

        // Try multiple lookup strategies: raw identifier first, then parsed components
        let ann = findAnnotationEntry(pageIdx, stableIdentifier);
        if (!ann) {
            const compositeParts = parseCompositeIdentifier(stableIdentifier);
            const parsedId = compositeParts.stableId || compositeParts.xref;
            if (parsedId && parsedId !== stableIdentifier) {
                ann = findAnnotationEntry(pageIdx, parsedId);
            }
        }
        if (!ann) {
            console.warn('Verdict toggle: annotation not found for', stableIdentifier, 'on page', pageIdx);
            return;
        }

        const currentSource = resolveAnnotationSource(ann);
        const newVerdict = !ann.is_verdict;

        // Optimistic update
        ann.is_verdict = newVerdict;
        applyVerdictIconState(clickedIcon, newVerdict);
        updateAnnotationVerdictUi(
            pageIdx,
            [
                stableIdentifier,
                ann.requestIdentifier,
                ann.identifier,
                ann.id,
                ann.stable_id,
                ann.xref,
            ],
            newVerdict
        );

        // Build API identifier from the annotation's own data
        const requestId = buildApiAnnotationIdentifier({
            identifier: ann.identifier || ann.id || ann.stable_id,
            xref: ann.xref,
            requestId: ann.requestIdentifier,
        }) || stableIdentifier;

        try {
            // Preserve existing source explicitly. Verdict toggling should not reclassify AI comments as HUMAN.
            const data = await updateAnnotationRequest(requestId, { is_verdict: newVerdict, source: currentSource });
            if (!data.success) {
                throw new Error(data.error || 'Failed to toggle verdict');
            }

            if (data.annotation) {
                const responsePageIdx = data.annotation.page_index;
                const updatedAnn = enhanceAnnotationEntry(data.annotation);

                // Keep local editing flags that should survive metadata-only updates.
                updatedAnn._hasBeenEdited = ann._hasBeenEdited;
                updatedAnn._priorityChanged = ann._priorityChanged;
                updatedAnn._isTemporary = ann._isTemporary;
                if (ann._originalContent !== undefined) {
                    updatedAnn._originalContent = ann._originalContent;
                }

                if (!annotationsData[responsePageIdx]) {
                    annotationsData[responsePageIdx] = [];
                }

                const annIdx = findAnnotationIndex(responsePageIdx, stableIdentifier);
                if (annIdx >= 0) {
                    annotationsData[responsePageIdx][annIdx] = updatedAnn;
                } else {
                    // Fallback by xref/stable id if identifier mapping changed during save.
                    const fallbackIdx = annotationsData[responsePageIdx].findIndex((candidate) =>
                        candidate.xref === updatedAnn.xref ||
                        candidate.stable_id === updatedAnn.stable_id ||
                        candidate.id === updatedAnn.id
                    );
                    if (fallbackIdx >= 0) {
                        annotationsData[responsePageIdx][fallbackIdx] = updatedAnn;
                    }
                }
            }

            markLocalAnnotationChange();
        } catch (error) {
            // Revert on failure
            ann.is_verdict = !newVerdict;
            applyVerdictIconState(clickedIcon, !newVerdict);
            updateAnnotationVerdictUi(
                pageIdx,
                [
                    stableIdentifier,
                    ann.requestIdentifier,
                    ann.identifier,
                    ann.id,
                    ann.stable_id,
                    ann.xref,
                ],
                !newVerdict
            );
            console.error('Error toggling verdict:', error);
            showToast('error', 'Failed to toggle verdict status.');
        }
    }

    async function updateAnnotationPriority(pageIdx, identifier, priority) {
        const stableIdentifier = normalizeAnnotationIdentifierValue(identifier);
        const compositeParts = parseCompositeIdentifier(stableIdentifier);
        const lookupIdentifier = compositeParts.stableId || compositeParts.xref || stableIdentifier;

        if (!lookupIdentifier) {
            showToast('error', 'Unable to determine which annotation to update.');
            return;
        }

        if (!['red', 'amber', 'green'].includes((priority || '').toLowerCase())) {
            showToast('error', 'Invalid priority. Must be red, amber, or green.');
            return;
        }

        const originalAnn = findAnnotationEntry(pageIdx, lookupIdentifier);
        const originalPriority = deriveAnnotationPriority(originalAnn);
        const originalColor = originalPriority;
        const originalSource = resolveAnnotationSource(originalAnn || {});
        const priorityIdentifierCandidates = [
            lookupIdentifier,
            stableIdentifier,
            originalAnn?.requestIdentifier,
            originalAnn?.identifier,
            originalAnn?.id,
            originalAnn?.stable_id,
            originalAnn?.xref,
        ];
        // CRITICAL FIX: Capture textarea value BEFORE the API call
        // Check if this annotation is being edited by matching editingAnnotationId
        // editingAnnotationId format: "ann-{pageIdx}-{displayIdentifier}"
        // displayIdentifier could be UUID, xref, or stableIdentifier (composite)
        let preservedTextareaValue = null;
        // Try both formats: extracted UUID and original composite identifier
        const annotationDomIdUUID = `ann-${pageIdx}-${lookupIdentifier}`;
        const annotationDomIdComposite = `ann-${pageIdx}-${stableIdentifier}`;

        // Check if editingAnnotationId matches this annotation (handle different identifier formats)
        const isEditingThisAnnotation = !!(editingAnnotationId && (
            editingAnnotationId === annotationDomIdUUID ||
            editingAnnotationId === annotationDomIdComposite ||
            (editingAnnotationId.startsWith(`ann-${pageIdx}-`) && originalAnn)
        ));

        if (isEditingThisAnnotation) {


            // Try to find textarea using multiple possible identifiers
            let textarea = null;
            const possibleIdentifiers = [
                stableIdentifier,
                originalAnn?.id,
                originalAnn?.identifier,
                originalAnn?.requestIdentifier,
                originalAnn?.stable_id,
                originalAnn?.name,
                originalAnn?.title,
                originalAnn?.xref ? String(originalAnn.xref) : null
            ].filter(id => id != null);

            // If editingAnnotationId has a specific identifier, extract it and try that first
            if (editingAnnotationId.startsWith(`ann-${pageIdx}-`)) {
                const extractedId = editingAnnotationId.replace(`ann-${pageIdx}-`, '');
                possibleIdentifiers.unshift(extractedId); // Try extracted ID first
            }

            // Try each identifier until we find the textarea
            for (const id of possibleIdentifiers) {
                const normalizedId = normalizeAnnotationIdentifierValue(id);
                if (normalizedId) {
                    textarea = document.getElementById(`edit-annotation-text-${normalizedId}`);
                    if (textarea) {
                        break;
                    }
                }
            }

            // CRITICAL FIX: Also check inline editor and use whichever has actual content
            const inlineLabel = document.querySelector('.annotation-label.label-editing');
            const inlineTextarea = inlineLabel?.querySelector('.inline-annotation-editor');

            // Get values from both editors
            const sidebarValue = textarea?.value || '';
            const inlineValue = inlineTextarea?.value || '';

            // Use the non-placeholder, non-empty value (prefer sidebar if both have content)
            const sidebarHasContent = sidebarValue.trim() && !PLACEHOLDER_STRINGS.includes(sidebarValue.trim());
            const inlineHasContent = inlineValue.trim() && !PLACEHOLDER_STRINGS.includes(inlineValue.trim());

            if (sidebarHasContent) {
                preservedTextareaValue = sidebarValue;
            } else if (inlineHasContent) {
                preservedTextareaValue = inlineValue;
            } else if (sidebarValue.trim()) {
                preservedTextareaValue = sidebarValue;
            } else if (inlineValue.trim()) {
                preservedTextareaValue = inlineValue;
            }

            // UPDATE annotationsData BEFORE API call to preserve user's edits
            if (preservedTextareaValue !== null && annotationsData[pageIdx]) {
                const annIdx = findAnnotationIndex(pageIdx, lookupIdentifier);
                if (annIdx >= 0) {
                    annotationsData[pageIdx][annIdx].content = preservedTextareaValue;
                }
            }
        }

        // Optimistic visual update for priority controls/markers.
        updateAnnotationPriorityUi(pageIdx, priorityIdentifierCandidates, priority);


        try {
            const apiIdentifier = buildApiAnnotationIdentifier({
                identifier: lookupIdentifier,
                xref: originalAnn?.xref,
                requestId: originalAnn?.requestIdentifier || originalAnn?.identifier,
            });
            if (!apiIdentifier) {
                showToast('error', 'Unable to resolve annotation identifier.');
                return;
            }

            // Note: _updatingPriorityId and _isTemporary are already set in the click handler above

            const data = await updateAnnotationRequest(apiIdentifier, { color: priority });

            // Check for explicit error in response
            if (!data.success) {
                throw new Error(data.error || 'Update failed');
            }

            // Handle successful update - annotation may be null if retrieval failed after update
            if (data.annotation) {
                    // Use server-provided annotation data
                    const responsePageIdx = data.annotation.page_index;
                    if (annotationsData[responsePageIdx]) {
                        const annIdx = findAnnotationIndex(responsePageIdx, lookupIdentifier);

                        if (annIdx >= 0) {
                            const existingAnn = annotationsData[responsePageIdx][annIdx];
                            const updatedAnn = enhanceAnnotationEntry(data.annotation);

                            // CRITICAL FIX: Override API response content with preserved textarea value
                            if (preservedTextareaValue !== null) {
                                updatedAnn.content = preservedTextareaValue;
                            }
                            // Preserve original snapshot and creation flag
                            if (existingAnn?._originalContent !== undefined) {
                                updatedAnn._originalContent = existingAnn._originalContent;
                            }
                            if (existingAnn?._createdAtSession) {
                                updatedAnn._createdAtSession = true;
                            }

                            // CRITICAL FIX: Remove temporary flag when priority is changed - this marks annotation as "edited"
                            delete updatedAnn._isTemporary;
                            // Preserve _hasBeenEdited and _priorityChanged flags from click handler
                            if (existingAnn?._hasBeenEdited) {
                                updatedAnn._hasBeenEdited = true;
                            }
                            if (existingAnn?._priorityChanged) {
                                updatedAnn._priorityChanged = true;
                            }
                            annotationsData[responsePageIdx][annIdx] = updatedAnn;

                            // Track priority operation for undo (Ctrl+Z)
                            const newSource = resolveAnnotationSource(updatedAnn);
                            const isOwnershipTransfer = originalSource === 'AI' && newSource === 'HUMAN';
                            pushUndoOperation({
                                type: 'priority',
                                identifier: lookupIdentifier,
                                xref: originalAnn?.xref,
                                requestId: originalAnn?.requestIdentifier,
                                pageIdx: pageIdx,
                                oldColor: originalColor,
                                newColor: priority,
                                oldSource: originalSource,
                                newSource: newSource,
                                isOwnershipTransfer: isOwnershipTransfer,
                            });
                        }
                    }
                } else {
                    // Update succeeded but annotation couldn't be retrieved - update local data optimistically
                    if (annotationsData[pageIdx]) {
                        const annIdx = findAnnotationIndex(pageIdx, lookupIdentifier);
                        if (annIdx >= 0) {
                            const existingAnn = annotationsData[pageIdx][annIdx];
                            // Update priority/color locally
                            existingAnn.priority = priority;
                            existingAnn.color = priority;
                            // Mark as human-edited since user changed the priority
                            existingAnn.source = 'HUMAN';
                            if (!existingAnn.original_source) {
                                existingAnn.original_source = originalSource;
                            }
                            existingAnn._hasBeenEdited = true;
                            existingAnn._priorityChanged = true;
                            delete existingAnn._isTemporary;

                            // Track priority operation for undo (Ctrl+Z)
                            pushUndoOperation({
                                type: 'priority',
                                identifier: lookupIdentifier,
                                xref: originalAnn?.xref,
                                requestId: originalAnn?.requestIdentifier,
                                pageIdx: pageIdx,
                                oldColor: originalColor,
                                newColor: priority,
                                oldSource: originalSource,
                                newSource: 'HUMAN',
                                isOwnershipTransfer: originalSource === 'AI',
                            });
                        }
                    }
                }

                // Keep priority UX local and immediate without rebuilding the panel.
                updateAnnotationPriorityUi(pageIdx, priorityIdentifierCandidates, priority);

                // Clear flag after successful update, but with delay to ensure blur handler has checked it
                // Blur handler runs after 200ms, so wait at least 300ms before clearing
                setTimeout(() => {
                    _updatingPriorityId = null;
                }, 300);

                markLocalAnnotationChange(); // Prevent polling from reloading for our own change
                // Keep editing mode active if user was editing this annotation
                if (isEditingThisAnnotation) {
                    editingAnnotationId = annotationDomIdComposite;
                    setTimeout(() => {
                        // Restore sidebar textarea
                        const textareaId = `edit-annotation-text-${lookupIdentifier}`;
                        const textarea = document.getElementById(textareaId);
                        if (textarea) {
                            // Set preserved value
                            if (preservedTextareaValue !== null) {
                                textarea.value = preservedTextareaValue;
                            }
                            textarea.focus();
                            const len = textarea.value.length;
                            textarea.setSelectionRange(len, len);
                        } else {
                            // Try with stableIdentifier
                            const altTextareaId = `edit-annotation-text-${stableIdentifier}`;
                            const altTextarea = document.getElementById(altTextareaId);
                            if (altTextarea && preservedTextareaValue !== null) {
                                altTextarea.value = preservedTextareaValue;
                                altTextarea.focus();
                            }
                        }

                        // CRITICAL FIX: Also re-open inline editor on PDF
                        // Try multiple identifier formats since markers may use different ones
                        let marker = null;
                        const identifiersToTry = [lookupIdentifier, stableIdentifier];
                        for (const id of identifiersToTry) {
                            const markerSelector = `.annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-request-id="${id}"], .annotation-marker[data-annotation-page="${pageIdx}"][data-annotation-identifier="${id}"]`;
                            marker = document.querySelector(markerSelector);
                            if (marker) break;
                        }

                        if (marker) {
                            const label = marker.querySelector('.annotation-label');
                            if (label && !label.classList.contains('label-editing')) {
                                // Re-open inline edit mode
                                expandInlineLabelEdit(label);
                                // Set preserved value in inline editor too
                                const inlineTextarea = label.querySelector('.inline-annotation-editor');
                                if (inlineTextarea && preservedTextareaValue !== null) {
                                    inlineTextarea.value = preservedTextareaValue;
                                }
                            }
                        }
                    }, 60);
                }

                // Success: silent to keep UI smooth

        } catch (error) {
            // Clear flag on error, but with delay to ensure blur handler has checked it
            setTimeout(() => {
                _updatingPriorityId = null;
            }, 300);
            console.error('Error updating annotation priority:', error);
            if (originalAnn && annotationsData[pageIdx]) {
                const annIdx = findAnnotationIndex(pageIdx, lookupIdentifier);
                if (annIdx >= 0) {
                    annotationsData[pageIdx][annIdx].priority = originalColor;
                    annotationsData[pageIdx][annIdx].color = originalColor;
                }
            }
            updateAnnotationPriorityUi(
                pageIdx,
                [
                    lookupIdentifier,
                    stableIdentifier,
                    originalAnn?.requestIdentifier,
                    originalAnn?.identifier,
                    originalAnn?.id,
                    originalAnn?.stable_id,
                    originalAnn?.xref,
                ],
                originalColor
            );
            showToast('error', error.message || 'Failed to update priority. Please try again.');
        }
    }

    function syncGradedPageSlider(viewer) {
        if (_currentDocCtrl) return _currentDocCtrl.syncGradedPageSlider(viewer);

        // Fallback: original monolith code
        const slider = document.getElementById('pdfGradedPageSlider');
        const label = document.getElementById('pdfGradedPageSliderLabel');
        if (!slider || !viewer) return;
        const totalPages = viewer.pdf ? viewer.pdf.numPages : 1;
        slider.max = totalPages;
        slider.value = viewer.currentPage || 1;
        if (label) {
            label.textContent = translatePdfPreviewText('Page %(page)s', { page: viewer.currentPage || 1 });
        }
    }

    function bindGradedPageSlider() {
        if (_currentDocCtrl) return; // Controller binds on creation

        // Fallback: original monolith code
        const slider = document.getElementById('pdfGradedPageSlider');
        if (slider && !slider.dataset.bound) {
            slider.dataset.bound = 'true';
            slider.addEventListener('input', (e) => {
                const targetPage = parseInt(e.target.value, 10) || 1;
                if (window.__pdfGradedViewer) {
                    window.__pdfGradedViewer.renderPage(targetPage);
                }
            });
        }
    }

    // FIX Issue #28: Bind page number input for direct page navigation
    function bindGradedPageInput() {
        if (_currentDocCtrl) return; // Controller binds on creation
        const pageInput = document.getElementById('pdfGradedPageInput');
        if (pageInput && !pageInput.dataset.bound) {
            pageInput.dataset.bound = 'true';

            const navigateFromPageInput = (updateValue) => {
                const targetPage = parseInt(pageInput.value, 10) || 1;
                if (window.__pdfGradedViewer) {
                    const maxPage = window.__pdfGradedViewer.pdf?.numPages || 1;
                    const clampedPage = Math.max(1, Math.min(targetPage, maxPage));
                    if (updateValue) {
                        pageInput.value = clampedPage;
                    }
                    window.__pdfGradedViewer.renderPage(clampedPage);
                }
            };

            // Handle Enter key to navigate
            pageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    navigateFromPageInput(true);
                }
            });

            // Handle spinner button clicks (up/down arrows change value)
            pageInput.addEventListener('input', () => {
                navigateFromPageInput(false);
            });

            // Handle programmatic/manual change dispatch consistently with Enter.
            pageInput.addEventListener('change', () => {
                navigateFromPageInput(true);
            });

            // Also handle blur to navigate when focus leaves the input
            pageInput.addEventListener('blur', () => {
                navigateFromPageInput(true);
            });
        }
    }

    async function deleteAnnotation(pageIdx, identifier, sourceButton = null) {
        if (!_currentAnnotationCtrl || !_currentAnnotationCtrl.deleteAnnotation || _annotationCtrlDelegating) {
            throw new Error('Annotation controller must be initialized before deleting annotations.');
        }
        return _currentAnnotationCtrl.deleteAnnotation(pageIdx, identifier, sourceButton);
    }

    async function updateAnnotationPosition(sourcePageIdx, targetPageIdx, identifier, marker, isOwnershipTransfer = false) {
        // Add timeout wrapper to prevent infinite hangs
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Annotation update timeout after 30 seconds')), 30000)
        );

        try {
            await Promise.race([
                updateAnnotationPositionInternal(sourcePageIdx, targetPageIdx, identifier, marker, isOwnershipTransfer),
                timeoutPromise
            ]);
        } catch (error) {
            console.error('Annotation position update failed:', error);
            if (error.message.includes('timeout')) {
                showToast('error', 'Annotation update timed out. Please try again.');
            }
            // Re-throw to let existing error handling take over
            throw error;
        }
    }

    async function updateAnnotationPositionInternal(sourcePageIdx, targetPageIdx, identifier, marker, isOwnershipTransfer = false) {
        if (!marker || !window.__pdfGradedViewer) {
            console.warn('[FRONTEND] Cannot update position: marker or viewer missing');
            return;
        }

        // CRITICAL: Use stable UUID (requestId) first — it survives cross-page moves.
        // xref is volatile: PyMuPDF destroys and recreates it when moving across pages,
        // so concurrent requests that fire before the move response arrives will fail
        // if they use the old xref. The stable UUID is preserved by the server.
        const targetIdentifier =
            normalizeAnnotationIdentifierValue(marker?.dataset?.annotationRequestId)  // Prefer stable UUID (survives cross-page move)
            || normalizeAnnotationIdentifierValue(identifier)  // Use passed identifier
            || normalizeAnnotationIdentifierValue(marker?.dataset?.annotationXref)  // xref as fallback (volatile on cross-page move)
            || normalizeAnnotationIdentifierValue(marker?.dataset?.annotationIdentifier);

        if (!targetIdentifier) {
            console.error('[FRONTEND] No identifier found for annotation');
            showToast('error', 'Unable to determine annotation identifier. Refresh the annotations and try again.');
            // CRITICAL FIX: Only re-render if sourcePageIdx is valid
            if (typeof sourcePageIdx !== 'undefined' && !isNaN(sourcePageIdx)) {
                renderAnnotationsForPage(sourcePageIdx + 1);
            }
            return;
        }

        const viewer = window.__pdfGradedViewer;
        const logCrossPage = (...args) => {
            if (PDF_DEBUG) debugLog(...args);
        };
        const isCrossPageMove = (sourcePageIdx !== targetPageIdx);

        if (isCrossPageMove) {
            logCrossPage(`[CROSS-PAGE] Moving annotation from page ${sourcePageIdx} to page ${targetPageIdx}`);
            logCrossPage(`[CROSS-PAGE] Target identifier: ${targetIdentifier}`);
            logCrossPage(`[CROSS-PAGE] Marker dataset:`, {
                xref: marker?.dataset?.annotationXref,
                requestId: marker?.dataset?.annotationRequestId,
                identifier: marker?.dataset?.annotationIdentifier,
                id: marker?.dataset?.annotationId
            });

            // Log all annotations on source page
            const sourceAnns = annotationsData[sourcePageIdx] || [];
            logCrossPage(`[CROSS-PAGE] Source page ${sourcePageIdx} has ${sourceAnns.length} annotations:`);
            sourceAnns.forEach((ann, idx) => {
                const annIdentifier = resolveAnnotationIdentifierValue(ann);
                const annRequestId = ann.requestIdentifier || buildAnnotationRequestIdentifier(ann);
                logCrossPage(`  [${idx}] xref:${ann.xref}, id:${ann.id}, identifier:${annIdentifier}, requestId:${annRequestId}, content:${ann.content?.substring(0, 30) || 'N/A'}`);
            });

            // Try to find the annotation on source page
            const findResult = findAnnotationIndex(sourcePageIdx, targetIdentifier);
            logCrossPage(`[CROSS-PAGE] findAnnotationIndex result for "${targetIdentifier}": ${findResult}`);
        }

        // Use target page for calculating new position
        const pageNum = targetPageIdx + 1; // Convert to 1-based for PDF.js
        const viewport = viewer.getViewportForPage(pageNum);
        if (!viewport) {
            console.error('[FRONTEND] Viewport not available for page', pageNum);
            return;
        }

        // CRITICAL FIX: Add error handling for getPage
        let page;
        try {
            page = await viewer.pdf.getPage(pageNum);
        } catch (error) {
            console.error('[FRONTEND] Error getting page', pageNum, error);
            showToast('error', 'Failed to load page for annotation update.');
            return;
        }

        // Store original position for rollback on error
        // CRITICAL FIX: Try multiple identifier formats if first lookup fails
        let originalAnn = findAnnotationEntry(sourcePageIdx, targetIdentifier);
        if (!originalAnn && marker?.dataset?.annotationRequestId) {
            // Try with requestId if xref lookup failed
            originalAnn = findAnnotationEntry(sourcePageIdx, marker.dataset.annotationRequestId);
            logCrossPage(`[CROSS-PAGE] Retry with requestId "${marker.dataset.annotationRequestId}":`, originalAnn ? 'FOUND' : 'NOT FOUND');
        }
        if (!originalAnn && marker?.dataset?.annotationIdentifier) {
            // Try with identifier if requestId lookup also failed
            originalAnn = findAnnotationEntry(sourcePageIdx, marker.dataset.annotationIdentifier);
            logCrossPage(`[CROSS-PAGE] Retry with identifier "${marker.dataset.annotationIdentifier}":`, originalAnn ? 'FOUND' : 'NOT FOUND');
        }
        logCrossPage(`[CROSS-PAGE] findAnnotationEntry for page ${sourcePageIdx}, identifier "${targetIdentifier}":`, originalAnn ? { xref: originalAnn.xref, id: originalAnn.id, content: originalAnn.content?.substring(0, 30) } : 'NOT FOUND');
        const originalRect = originalAnn ? [...(originalAnn.rect || [])] : null;
        const originalPage = sourcePageIdx;

        // CRITICAL FIX: Get canvas and overlay from TARGET page wrapper for cross-page moves
        const wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${pageNum}"]`);
        if (!wrapper) {
            console.error('[FRONTEND] Page wrapper not found for page', pageNum);
            return;
        }

        const canvas = wrapper.querySelector('.pdf-page-canvas');
        const overlay = wrapper.querySelector('.pdf-annotation-overlay');
        if (!canvas || !overlay) {
            console.error('[FRONTEND] Canvas or overlay not found in wrapper for page', pageNum);
            return;
        }

        const canvasRect = canvas.getBoundingClientRect();

        // CRITICAL FIX for cross-page moves: When moving to a different page,
        // marker.offsetLeft/Top are relative to SOURCE page's overlay, not target page.
        // We need to calculate position relative to TARGET page's overlay.
        let containerX0, containerY0, containerX1, containerY1;

        if (isCrossPageMove) {
            // For cross-page moves: get absolute positions and calculate relative to target overlay
            const markerRect = marker.getBoundingClientRect();
            const overlayRect = overlay.getBoundingClientRect();

            // Calculate marker position relative to target page's overlay
            containerX0 = markerRect.left - overlayRect.left;
            containerY0 = markerRect.top - overlayRect.top;
            containerX1 = containerX0 + marker.offsetWidth;
            containerY1 = containerY0 + marker.offsetHeight;

            logCrossPage('[CROSS-PAGE] Coordinate calculation:', {
                markerAbsolute: { left: markerRect.left, top: markerRect.top },
                overlayAbsolute: { left: overlayRect.left, top: overlayRect.top },
                relativeToTarget: { x0: containerX0, y0: containerY0 }
            });
        } else {
            // For same-page moves: use offsetLeft/Top (relative to parent overlay)
            containerX0 = marker.offsetLeft;
            containerY0 = marker.offsetTop;
            containerX1 = containerX0 + marker.offsetWidth;
            containerY1 = containerY0 + marker.offsetHeight;
        }

        debugLog('[DEBUG] Marker position:', {
            offsetLeft: containerX0,
            offsetTop: containerY0,
            canvasWidth: canvasRect.width,
            canvasHeight: canvasRect.height,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height
        });

        // Convert container (pixel) coordinates to viewport (PDF.js) coordinates
        // Use canvas dimensions to calculate scale
        const scaleX = viewport.width / canvasRect.width;
        const scaleY = viewport.height / canvasRect.height;
        const viewportX0 = containerX0 * scaleX;
        const viewportY0 = containerY0 * scaleY;
        const viewportX1 = containerX1 * scaleX;
        const viewportY1 = containerY1 * scaleY;

        debugLog('[DEBUG] Viewport coordinates:', {
            scaleX,
            scaleY,
            viewportX0,
            viewportY0,
            viewportX1,
            viewportY1
        });

        // Use PDF.js convertToPdfPoint for accurate conversion
        let pdfPoint0, pdfPoint1;
        try {
            pdfPoint0 = viewport.convertToPdfPoint(viewportX0, viewportY0);
            pdfPoint1 = viewport.convertToPdfPoint(viewportX1, viewportY1);
        } catch {
            // Fallback if convertToPdfPoint not available
            debugLog('convertToPdfPoint not available, using manual conversion');
            const pageRect = page.getRect();
            pdfPoint0 = [
                (viewportX0 / viewport.width) * pageRect.width,
                pageRect.height - (viewportY0 / viewport.height) * pageRect.height
            ];
            pdfPoint1 = [
                (viewportX1 / viewport.width) * pageRect.width,
                pageRect.height - (viewportY1 / viewport.height) * pageRect.height
            ];
        }

        // Create rect in PDF coordinates [x0, y0, x1, y1]
        const newRect = [
            Math.min(pdfPoint0[0], pdfPoint1[0]), // x0
            Math.min(pdfPoint0[1], pdfPoint1[1]), // y0
            Math.max(pdfPoint0[0], pdfPoint1[0]), // x1
            Math.max(pdfPoint0[1], pdfPoint1[1])  // y1
        ];

        debugLog('[DEBUG] PDF coordinates:', {
            pdfPoint0,
            pdfPoint1,
            newRect,
            originalRect
        });

        try {
            const apiIdentifier = buildApiAnnotationIdentifier({
                identifier: targetIdentifier,
                xref: marker?.dataset?.annotationXref,
                requestId: marker?.dataset?.annotationRequestId || marker?.dataset?.annotationIdentifier,
            });
            if (!apiIdentifier) {
                throw new Error('Unable to resolve annotation identifier for update.');
            }

            debugLog('[FRONTEND] Sending PUT request:', {
                identifier: targetIdentifier,
                apiIdentifier,
                rect: newRect,
                assignmentId: currentAssignmentId,
            });

            // Build request body
            const requestBody = { rect: newRect };
            const preservePriority = deriveAnnotationPriority(originalAnn);
            if (preservePriority) {
                requestBody.color = preservePriority;
            }

            // Add source for ownership transfer (AI -> HUMAN)
            if (isOwnershipTransfer) {
                requestBody.source = 'HUMAN';
            }

            if (isCrossPageMove) {
                requestBody.page_index = targetPageIdx;
                logCrossPage(`[CROSS-PAGE] Including page_index=${targetPageIdx} in API request`);

                // FIX: Preserve the original content when moving to a new page
                // Without this, the backend may reset content to default when recreating the annotation
                if (originalAnn?.content) {
                    requestBody.content = originalAnn.content;
                    logCrossPage(`[CROSS-PAGE] Preserving content: "${originalAnn.content.substring(0, 50)}..."`);
                }
            }

            const data = await updateAnnotationRequest(apiIdentifier, requestBody);

            if (data.success && data.annotation) {
                    const responsePageIdx = data.annotation.page_index;
                    logCrossPage(`[CROSS-PAGE] API Response - annotation moved to page ${responsePageIdx}`, {
                        xref: data.annotation.xref,
                        id: data.annotation.id,
                        stable_id: data.annotation.stable_id,
                        page_index: responsePageIdx
                    });

                    // Push to undo stack AFTER modifying data
                    // FIX Issue #30: For cross-page moves, use the NEW xref and NEW stable_id from API response
                    // because PyMuPDF assigns new IDs when moving to a different page
                    const undoXref = isCrossPageMove && data.annotation.xref
                        ? String(data.annotation.xref)
                        : marker?.dataset?.annotationXref;

                    // For cross-page moves, use the NEW stable_id from API response for undo
                    // The old requestId won't work because the annotation was recreated with new IDs
                    const undoRequestId = isCrossPageMove
                        ? (data.annotation.stable_id || data.annotation.id)
                        : marker?.dataset?.annotationRequestId;
                    const undoIdentifier = isCrossPageMove
                        ? (data.annotation.stable_id || data.annotation.id || String(data.annotation.xref))
                        : targetIdentifier;

                    pushUndoOperation({
                        type: 'move',
                        identifier: undoIdentifier,
                        xref: undoXref,
                        requestId: undoRequestId,
                        oldPageIdx: originalPage,
                        newPageIdx: responsePageIdx,
                        oldRect: originalRect,
                        newRect: newRect,
                        oldSource: isOwnershipTransfer ? 'AI' : (originalAnn?.source || resolveAnnotationSource(originalAnn || {})),
                        newSource: isOwnershipTransfer ? 'HUMAN' : (originalAnn?.source || resolveAnnotationSource(originalAnn || {})),
                        isOwnershipTransfer: isOwnershipTransfer,
                    });

                    const normalizedAnn = enhanceAnnotationEntry(data.annotation);
                    debugLog('[CROSS-PAGE] Normalized annotation payload:', normalizedAnn);
                    const normalizedAnnIdentifier =
                        normalizedAnn.requestIdentifier ||
                        resolveAnnotationIdentifierValue(normalizedAnn) ||
                        normalizeAnnotationIdentifierValue(normalizedAnn.xref);
                    logCrossPage(`[CROSS-PAGE] Normalized annotation identifier: ${normalizedAnnIdentifier}`);

                    // Handle cross-page move: remove from source, add to target
                    if (isCrossPageMove) {
                        logCrossPage(`[CROSS-PAGE] Before move - Source page ${originalPage} has ${annotationsData[originalPage]?.length || 0} annotations, Target page ${responsePageIdx} has ${annotationsData[responsePageIdx]?.length || 0} annotations`);
                        logCrossPage(`[CROSS-PAGE] Current comments page: ${currentAnnotationsPage}`);

                        // Remove from source page
                        if (annotationsData[originalPage]) {
                            const srcIdx = findAnnotationIndex(originalPage, targetIdentifier);
                            logCrossPage(`[CROSS-PAGE] Attempting to remove annotation with identifier "${targetIdentifier}" from source page ${originalPage}, found at index: ${srcIdx}`);
                            if (srcIdx >= 0) {
                                const removed = annotationsData[originalPage].splice(srcIdx, 1)[0];
                                logCrossPage(`[CROSS-PAGE] Successfully removed annotation:`, {
                                    xref: removed.xref,
                                    id: removed.id,
                                    stable_id: removed.stable_id,
                                    identifier: resolveAnnotationIdentifierValue(removed),
                                    requestIdentifier: removed.requestIdentifier,
                                    content: removed.content?.substring(0, 50) || 'N/A'
                                });
                            } else {
                                logCrossPage(`[CROSS-PAGE] FAILED to locate annotation on source page ${originalPage} for identifier "${targetIdentifier}"`);
                                logCrossPage(`[CROSS-PAGE] Available annotations on source page ${originalPage}:`, annotationsData[originalPage].map(a => ({
                                    xref: a.xref,
                                    id: a.id,
                                    identifier: resolveAnnotationIdentifierValue(a),
                                    requestIdentifier: a.requestIdentifier
                                })));
                            }

                            // FIX: Preserve temporary/edited flags from the original annotation
                            // The API response doesn't include these client-side flags, but they're needed
                            // to prevent the moved annotation from being filtered out by the placeholder check
                            // Note: originalAnn was captured before the move via findAnnotationEntry()
                            if (originalAnn?._isTemporary) {
                                normalizedAnn._isTemporary = true;
                                logCrossPage('[CROSS-PAGE] Preserved _isTemporary flag on moved annotation');
                            }
                            if (originalAnn?._hasBeenEdited) {
                                normalizedAnn._hasBeenEdited = true;
                            }
                            if (originalAnn?._priorityChanged) {
                                normalizedAnn._priorityChanged = true;
                            }
                        }

                        // Add to target page
                        if (!annotationsData[responsePageIdx]) {
                            annotationsData[responsePageIdx] = [];
                        }
                        const existingIdx = normalizedAnnIdentifier
                            ? findAnnotationIndex(responsePageIdx, normalizedAnnIdentifier)
                            : -1;
                        logCrossPage(`[CROSS-PAGE] Looking for existing annotation on target page ${responsePageIdx} with identifier "${normalizedAnnIdentifier}", found at index: ${existingIdx}`);
                        if (existingIdx >= 0) {
                            const oldAnn = annotationsData[responsePageIdx][existingIdx];
                            logCrossPage(`[CROSS-PAGE] Replacing existing annotation:`, {
                                old_xref: oldAnn.xref,
                                old_id: oldAnn.id,
                                new_xref: normalizedAnn.xref,
                                new_id: normalizedAnn.id,
                                new_identifier: resolveAnnotationIdentifierValue(normalizedAnn),
                                new_requestIdentifier: normalizedAnn.requestIdentifier
                            });
                            annotationsData[responsePageIdx][existingIdx] = normalizedAnn;
                            logCrossPage(`[CROSS-PAGE] Updated existing annotation on target page ${responsePageIdx}`);
                        } else {
                            logCrossPage(`[CROSS-PAGE] Adding new annotation to target page ${responsePageIdx}:`, {
                                xref: normalizedAnn.xref,
                                id: normalizedAnn.id,
                                identifier: resolveAnnotationIdentifierValue(normalizedAnn),
                                requestIdentifier: normalizedAnn.requestIdentifier
                            });
                            annotationsData[responsePageIdx].push(normalizedAnn);
                            logCrossPage(`[CROSS-PAGE] Added new annotation to target page ${responsePageIdx}`);
                        }
                        logCrossPage(`[CROSS-PAGE] After move - Source page ${originalPage} has ${annotationsData[originalPage]?.length || 0} annotations, Target page ${responsePageIdx} has ${annotationsData[responsePageIdx]?.length || 0} annotations`);
                        debugLog(`[CROSS-PAGE] Target page ${responsePageIdx} annotations snapshot:`, annotationsData[responsePageIdx]);

                        // Keep comments panel in sync immediately (observer updates are async).
                        const previousXref = normalizeAnnotationIdentifierValue(
                            marker?.dataset?.annotationXref
                        );
                        if (previousXref) {
                            const previousSourceKey = buildAnnotationVisibilityKey(originalPage, {
                                xref: previousXref,
                                identifier: targetIdentifier,
                            });
                            const previousTargetKey = buildAnnotationVisibilityKey(responsePageIdx, {
                                xref: previousXref,
                                identifier: targetIdentifier,
                            });
                            if (previousSourceKey) {
                                visibleAnnotationMarkers.delete(previousSourceKey);
                            }
                            if (previousTargetKey) {
                                visibleAnnotationMarkers.delete(previousTargetKey);
                            }
                        }
                        const responseXref = normalizeAnnotationIdentifierValue(
                            data.annotation.xref
                        );
                        if (responseXref) {
                            const responseMarkerKey = buildAnnotationVisibilityKey(responsePageIdx, {
                                xref: responseXref,
                                annotation: normalizedAnn,
                            });
                            if (responseMarkerKey) {
                                visibleAnnotationMarkers.add(responseMarkerKey);
                            }
                            marker.dataset.annotationXref = responseXref;
                        }
                        marker.dataset.annotationPage = String(responsePageIdx);
                        if (normalizedAnn.requestIdentifier) {
                            marker.dataset.annotationRequestId = normalizedAnn.requestIdentifier;
                            marker.dataset.annotationIdentifier = normalizedAnn.requestIdentifier;
                        }

                        // Re-render both pages with force to update positions
                        renderAnnotationsForPage(originalPage + 1, true);
                        renderAnnotationsForPage(responsePageIdx + 1, true);

                        // Success: silent to keep UI smooth
                        // NOTE: Do NOT call loadAnnotations() here - it would refetch from backend
                        // and overwrite our local changes with potentially stale data.
                        // The local annotationsData is already correct from the API response.
                        markLocalAnnotationChange(); // Prevent polling from reloading for our own change
                    } else {
                        // Same page move: update position in local data
                        if (annotationsData[responsePageIdx]) {
                            const annIdx = findAnnotationIndex(responsePageIdx, targetIdentifier);
                            if (annIdx >= 0) {
                                annotationsData[responsePageIdx][annIdx] = normalizedAnn;
                            }
                        }
                        // Update only the dragged marker's position in-place.
                        // Suppress observer-triggered sidebar re-renders during the update
                        // to prevent sidebar badge flash (red→blue from stale visibility data).
                        _suppressSidebarRender = true;
                        updateMarkerPositionInPlace(marker, normalizedAnn, responsePageIdx);
                        markLocalAnnotationChange();
                        setTimeout(() => { _suppressSidebarRender = false; }, 300);
                    }

                    // Only re-render sidebar for cross-page moves (page numbering changes).
                    // Same-page drags only change position — sidebar content is unchanged.
                    if (isCrossPageMove) {
                        const focusedPageIdx = (window.__pdfGradedViewer?.currentPage || responsePageIdx + 1) - 1;
                        currentAnnotationsPage = focusedPageIdx;
                        renderAnnotationsList();
                    }
                } else {
                    throw new Error(data.error || 'Position update failed');
                }
        } catch (error) {
            console.error('Error updating annotation position:', error);

            // Restore original position/page on error
            if (isCrossPageMove) {
                // For cross-page moves: ensure annotation is back on original page
                if (originalAnn && annotationsData[originalPage]) {
                    const annIdx = findAnnotationIndex(originalPage, targetIdentifier);
                    if (annIdx < 0) {
                        // Re-add to original page if it was removed
                        annotationsData[originalPage].push(originalAnn);
                    }
                }
                // Remove from target page if it was added
                if (annotationsData[targetPageIdx]) {
                    const targetIdx = findAnnotationIndex(targetPageIdx, targetIdentifier);
                    if (targetIdx >= 0) {
                        annotationsData[targetPageIdx].splice(targetIdx, 1);
                    }
                }
                // Re-render both pages with force after rollback
                renderAnnotationsForPage(originalPage + 1, true);
                renderAnnotationsForPage(targetPageIdx + 1, true);
                const rollbackXref = normalizeAnnotationIdentifierValue(
                    marker?.dataset?.annotationXref
                );
                if (rollbackXref) {
                    const rollbackTargetKey = buildAnnotationVisibilityKey(targetPageIdx, {
                        xref: rollbackXref,
                        identifier: targetIdentifier,
                    });
                    const rollbackSourceKey = buildAnnotationVisibilityKey(originalPage, {
                        xref: rollbackXref,
                        identifier: targetIdentifier,
                    });
                    if (rollbackTargetKey) {
                        visibleAnnotationMarkers.delete(rollbackTargetKey);
                    }
                    if (rollbackSourceKey) {
                        visibleAnnotationMarkers.add(rollbackSourceKey);
                    }
                }
                currentAnnotationsPage = originalPage;
                renderAnnotationsList();
                showToast('error', 'Failed to move annotation. Please try again.');
            } else {
                // For same-page moves: restore original rect
                if (originalAnn && originalRect && annotationsData[sourcePageIdx]) {
                    const annIdx = findAnnotationIndex(sourcePageIdx, targetIdentifier);
                    if (annIdx >= 0) {
                        annotationsData[sourcePageIdx][annIdx].rect = originalRect;
                    }
                }
                // Re-render overlay with original position (force to update)
                renderAnnotationsForPage(sourcePageIdx + 1, true);
                showToast('error', 'Failed to update annotation position. Please try again.');
            }
        } finally {
            // FIX Issue #32: Clear drag flag AFTER async operation completes
            // This prevents blur handler from deleting temporary annotation during cross-page move
            _isDraggingAnnotation = false;
        }
    }

    function showToast(type, message) {
        // Simple toast notification - you can replace with your toast library
        const toast = document.createElement('div');
        toast.className = `alert alert-${type === 'error' ? 'danger' : type === 'success' ? 'success' : 'info'} alert-dismissible fade show position-fixed`;
        toast.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';

        toast.innerHTML = `
            ${escapeHtml(message)}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.remove();
        }, 3000);
    }

    async function getPdfPageText(pageNum) {
        // Note: no delegation stub needed — this internal function is only called
        // by other search functions which are themselves delegated.
        if (pdfSearchState.pageTextCache.has(pageNum)) {
            return pdfSearchState.pageTextCache.get(pageNum);
        }
        const pdf = window.__pdfGradedViewer?.pdf;
        if (!pdf) {
            return '';
        }
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const text = textContent.items.map((item) => item.str).join(' ');
        const normalized = text.toLowerCase();
        pdfSearchState.pageTextCache.set(pageNum, normalized);
        return normalized;
    }

    // FIX Issue #31: Check if PDF has searchable text and hide search if not
    async function checkPdfSearchable() {
        if (_currentDocCtrl) return _currentDocCtrl.checkPdfSearchable();
        const searchWrapper = document.getElementById('pdfSearchWrapper');
        if (!searchWrapper) return;

        const pdf = window.__pdfGradedViewer?.pdf;
        if (!pdf) {
            searchWrapper.classList.add('d-none');
            searchWrapper.classList.remove('d-flex');
            return;
        }

        // Check content pages (skip page 1 = cover page which often has typed
        // boilerplate even for handwritten exams). Require text on at least one
        // content page to enable search.
        const startPage = Math.min(2, pdf.numPages);
        const endPage = Math.min(startPage + 2, pdf.numPages);
        let hasText = false;

        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
            try {
                const page = await pdf.getPage(pageNum);
                const textContent = await page.getTextContent();
                const text = textContent.items.map((item) => item.str).join('').trim();
                if (text.length > 10) { // More than just whitespace/artifacts
                    hasText = true;
                    break;
                }
            } catch (error) {
                console.warn(`[SEARCH] Error checking page ${pageNum} for text:`, error);
            }
        }

        if (hasText) {
            searchWrapper.classList.remove('d-none');
            searchWrapper.classList.add('d-flex');
            updateSearchStatus('');
        } else {
            searchWrapper.classList.add('d-none');
            searchWrapper.classList.remove('d-flex');
            showToast('info', 'PDF has no searchable text (scanned image). Search is not available.');
        }
    }

    function updateSearchStatus(message) {
        // Note: no delegation stub needed — this internal function is only called
        // by other search functions which are themselves delegated.
        const statusEl = document.getElementById('pdfSearchStatus');
        if (!statusEl) return;
        if (message) {
            statusEl.textContent = message;
            return;
        }
        if (!pdfSearchState.matches.length || pdfSearchState.currentIndex < 0) {
            statusEl.textContent = '';
            return;
        }
        const match = pdfSearchState.matches[pdfSearchState.currentIndex];
        statusEl.textContent = `Match ${pdfSearchState.currentIndex + 1}/${pdfSearchState.matches.length} on page ${match.page}`;
    }

    async function goToSearchMatch(matchIndex) {
        // Note: no delegation stub needed — called by buildPdfSearchMatches
        // which is delegated through handleSearchNavigation.
        const match = pdfSearchState.matches[matchIndex];
        if (!match) {
            updateSearchStatus('No matches');
            return;
        }
        // For continuous scroll, scroll to the page wrapper
        const wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${match.page}"]`);
        if (wrapper) {
            wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        // Wait briefly, then draw highlight
        setTimeout(() => {
            highlightSearchMatch(match);
        }, 150);
        pdfSearchState.currentIndex = matchIndex;
        updateSearchStatus();
    }

    async function buildPdfSearchMatches(term) {
        // Note: no delegation stub needed — called by handleSearchNavigation
        // which is delegated.
        const pdf = window.__pdfGradedViewer?.pdf;
        if (!pdf) {
            updateSearchStatus('Load graded PDF first');
            return;
        }
        const normalizedTerm = term.trim().toLowerCase();
        if (!normalizedTerm) {
            pdfSearchState.matches = [];
            pdfSearchState.currentIndex = -1;
            updateSearchStatus('Enter a search term');
            return;
        }
        pdfSearchState.term = normalizedTerm;
        pdfSearchState.matches = [];
        pdfSearchState.currentIndex = -1;
        updateSearchStatus('Searching…');

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
            const text = await getPdfPageText(pageNum);
            if (!text) continue;
            let offset = text.indexOf(normalizedTerm);
            while (offset !== -1) {
                const preview = text.substring(Math.max(0, offset - 40), Math.min(text.length, offset + normalizedTerm.length + 60)).trim();
                pdfSearchState.matches.push({
                    page: pageNum,
                    offset,
                    preview,
                });
                offset = text.indexOf(normalizedTerm, offset + normalizedTerm.length);
            }
        }

        if (!pdfSearchState.matches.length) {
            updateSearchStatus('No matches');
            return;
        }

        await goToSearchMatch(0);
    }

    function clearSearchHighlights() {
        if (_currentDocCtrl) return _currentDocCtrl.clearSearchHighlights();
        // Clear highlights from all page search overlays
        const overlays = document.querySelectorAll('.pdf-search-overlay');
        overlays.forEach(overlay => {
            overlay.innerHTML = '';
        });
    }

    function syncSearchOverlayGeometry() {
        if (_currentDocCtrl) return _currentDocCtrl.syncSearchOverlayGeometry();
        // No longer needed for continuous scroll (each overlay is sized by CSS)
        // Kept for backward compatibility
    }

    async function highlightSearchMatch(match) {
        if (_currentDocCtrl) return _currentDocCtrl.highlightSearchMatch(match);

        // Fallback: original monolith code
        const viewer = window.__pdfGradedViewer;
        if (!viewer || !viewer.pdf) return;

        // Get the specific page wrapper and its elements
        const wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector(`.pdf-page-wrapper[data-page-num="${match.page}"]`);
        if (!wrapper) return;

        const canvas = wrapper.querySelector('.pdf-page-canvas');
        const overlay = wrapper.querySelector('.pdf-search-overlay');
        if (!canvas || !overlay) return;

        // Get viewport for this specific page
        const viewport = viewer.getViewportForPage(match.page);
        if (!viewport) {
            // If viewport not yet available, wait for page to render
            setTimeout(() => highlightSearchMatch(match), 100);
            return;
        }

        const page = await viewer.pdf.getPage(match.page);
        const textContent = await page.getTextContent();

        // Clear all search highlights across all pages
        clearSearchHighlights();

        const canvasRect = canvas.getBoundingClientRect();
        const scaleX = canvasRect.width / viewport.width;
        const scaleY = canvasRect.height / viewport.height;

        // Use cached Serif font context to avoid re-creating canvases
        const measureCtx = getSearchMeasureContext();
        if (!measureCtx) return;

        let currentIdx = 0;
        const targetStart = match.offset;
        const targetEnd = match.offset + pdfSearchState.term.length;
        let firstHighlightEl = null;

        textContent.items.forEach(item => {
            const itemStr = item.str;
            const itemStart = currentIdx;
            const itemEnd = currentIdx + itemStr.length;

            if (itemEnd > targetStart && itemStart < targetEnd) {
                const localStart = Math.max(0, targetStart - itemStart);
                const localEnd = Math.min(itemStr.length, targetEnd - itemStart);

                // Measure with the CORRECT font type
                const fullWidth = measureCtx.measureText(itemStr).width || 1;
                const prefixWidth = measureCtx.measureText(itemStr.substring(0, localStart)).width;
                const matchWidth = measureCtx.measureText(itemStr.substring(localStart, localEnd)).width;

                const startRatio = prefixWidth / fullWidth;
                const widthRatio = matchWidth / fullWidth;

                const tx = item.transform;
                const itemWidth = item.width;
                const itemHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[0]);

                const pdfX = tx[4] + (itemWidth * startRatio);
                const pdfY = tx[5];
                const pdfW = (itemWidth * widthRatio);
                const pdfH = itemHeight;

                const rect = [pdfX, pdfY, pdfX + pdfW, pdfY + pdfH];
                const viewRect = viewport.convertToViewportRectangle(rect);

                const rawX = Math.min(viewRect[0], viewRect[2]);
                const rawY = Math.min(viewRect[1], viewRect[3]);
                const rawW = Math.abs(viewRect[0] - viewRect[2]);
                const rawH = Math.abs(viewRect[1] - viewRect[3]);

                // Page-relative coordinates (no global offset needed)
                const finalX = rawX * scaleX;
                const finalY = rawY * scaleY;
                const finalW = rawW * scaleX;
                const finalH = rawH * scaleY;

                const div = document.createElement('div');
                div.className = 'search-highlight';

                // Generous padding and optical centering
                const padY = finalH * 0.2;
                const padX = 4 * scaleX;
                const verticalNudge = finalH * 0.1; // shift down to cover descenders

                div.style.left = `${finalX - padX}px`;
                div.style.top = `${finalY - padY + verticalNudge}px`;
                div.style.width = `${finalW + (padX * 2)}px`;
                div.style.height = `${finalH + (padY * 2)}px`;
                overlay.appendChild(div);

                if (!firstHighlightEl) firstHighlightEl = div;
            }
            currentIdx += itemStr.length + 1;
        });

        // Scroll the first highlight into view within its page
        if (firstHighlightEl) {
            firstHighlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    async function handleSearchNavigation(action) {
        if (_currentDocCtrl) return _currentDocCtrl.handleSearchAction(action);

        // Fallback: original monolith code
        const input = document.getElementById('pdfSearchInput');
        if (!input) return;
        const term = input.value.trim();
        if (!term) {
            pdfSearchState.matches = [];
            pdfSearchState.currentIndex = -1;
            updateSearchStatus('Enter a search term');
            return;
        }

        const normalized = term.toLowerCase();
        if (action === 'go' || normalized !== pdfSearchState.term) {
            await buildPdfSearchMatches(term);
            return;
        }

        if (!pdfSearchState.matches.length) {
            updateSearchStatus('No matches');
            return;
        }

        if (action === 'next') {
            const nextIndex = (pdfSearchState.currentIndex + 1) % pdfSearchState.matches.length;
            await goToSearchMatch(nextIndex);
        } else if (action === 'prev') {
            const prevIndex = (pdfSearchState.currentIndex - 1 + pdfSearchState.matches.length) % pdfSearchState.matches.length;
            await goToSearchMatch(prevIndex);
        }
    }

    const addCommentModalEl = document.getElementById('addCommentModal');
    const addCommentForm = document.getElementById('addCommentForm');
    const addCommentSpinner = document.getElementById('addCommentSpinner');
    const addCommentText = document.getElementById('addCommentText');
    const addCommentPriority = document.getElementById('addCommentPriority');
    const addCommentType = document.getElementById('addCommentType');
    const addCommentPageLabel = document.getElementById('addCommentPage');
    let addCommentModalInstance = null;

    async function addManualAnnotation(options = {}) {
        const { comment, priority = 'amber', kind = 'text', is_verdict = false } = options;
        if (!currentSubmissionId) {
            showToast('error', 'Select a submission first.');
            return false;
        }
        if (!comment || !comment.trim()) {
            showToast('error', translatePdfPreviewText('Comment cannot be empty.'));
            return false;
        }
        const viewer = window.__pdfGradedViewer;
        if (!viewer || !viewer.pdf) {
            showToast('error', 'Load the graded PDF before adding comments.');
            return false;
        }
        const pageIdx = (viewer.currentPage || 1) - 1;
        try {
            const data = await createAnnotationRequest({
                content: comment.trim(),
                page_index: pageIdx,
                color: priority,
                kind,
                is_verdict,
            });
            if (!data.success || !data.annotation) {
                throw new Error(data.error || 'Failed to add annotation');
            }
            const targetPage = data.annotation.page_index ?? pageIdx;
            currentAnnotationsPage = targetPage;
            await loadAnnotations(currentSubmissionId, currentAssignmentId);
            if (window.__pdfGradedViewer) {
                await window.__pdfGradedViewer.renderPage(targetPage + 1);
            }
            // Success: silent to keep UI smooth
            return true;
        } catch (error) {
            console.error('Error creating annotation:', error);
            showToast('error', error.message || 'Failed to create annotation.');
            return false;
        }
    }

    function bindPdfSearchControls() {
        if (_currentDocCtrl) return; // Controller binds on creation

        // Fallback: original monolith code
        const goBtn = document.getElementById('pdfSearchGo');
        if (goBtn && !goBtn.dataset.bound) {
            goBtn.dataset.bound = 'true';
            goBtn.addEventListener('click', () => handleSearchNavigation('go'));
        }
        const prevBtn = document.getElementById('pdfSearchPrev');
        if (prevBtn && !prevBtn.dataset.bound) {
            prevBtn.dataset.bound = 'true';
            prevBtn.addEventListener('click', () => handleSearchNavigation('prev'));
        }
        const nextBtn = document.getElementById('pdfSearchNext');
        if (nextBtn && !nextBtn.dataset.bound) {
            nextBtn.dataset.bound = 'true';
            nextBtn.addEventListener('click', () => handleSearchNavigation('next'));
        }
        const input = document.getElementById('pdfSearchInput');
        if (input && !input.dataset.bound) {
            input.dataset.bound = 'true';
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    handleSearchNavigation('go');
                }
            });
        }
    }

    const addCommentBtn = document.getElementById('pdfGradedAddComment');
    if (addCommentBtn && !addCommentBtn.dataset.bound) {
        addCommentBtn.dataset.bound = 'true';
        addCommentBtn.addEventListener('click', () => openAddCommentModal());
    }

    bindPdfSearchControls();
    bindGradedPageSlider();
    bindGradedPageInput(); // FIX Issue #28: Bind page number input

    // Global function to open preview
    function openAddCommentModal() {
        if (!addCommentModalEl) {
            showToast('error', translatePdfPreviewText('Comment dialog is not available in this build.'));
            return;
        }
        if (!addCommentModalInstance) {
            addCommentModalInstance = new bootstrap.Modal(addCommentModalEl);
        }
        addCommentForm?.reset();
        addCommentSpinner?.classList.add('d-none');
        if (addCommentText) {
            addCommentText.value = '';
        }
        const pageDisplay = window.__pdfGradedViewer?.currentPage || 1;
        if (addCommentPageLabel) {
            addCommentPageLabel.textContent = pageDisplay;
        }
        setTimeout(() => addCommentText?.focus(), 150);
        addCommentModalInstance.show();
    }

    addCommentForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!addCommentForm) return;
        const submitBtn = addCommentForm.querySelector('button[type="submit"]');
        submitBtn?.setAttribute('disabled', 'disabled');
        addCommentSpinner?.classList.remove('d-none');
        const addCommentVerdictEl = document.getElementById('addCommentVerdict');
        const success = await addManualAnnotation({
            comment: addCommentText?.value || '',
            priority: addCommentPriority?.value || 'amber',
            kind: addCommentType?.value || 'text',
            is_verdict: addCommentVerdictEl?.checked || false,
        });
        addCommentSpinner?.classList.add('d-none');
        submitBtn?.removeAttribute('disabled');
        if (success && addCommentModalInstance) {
            addCommentModalInstance.hide();
        }
    });

    async function _openPdfPreviewInternal(submissionId, studentName, assignmentId = null, context = null) {
        if (!ensureModalViewers()) {
            console.error('PDF.js is not yet ready for preview.');
            const unsubscribe = () => {
                window.removeEventListener('pdfjsready', retryHandler);
            };
            const retryHandler = () => {
                unsubscribe();
                _openPdfPreviewInternal(submissionId, studentName, assignmentId, context);
            };
            window.addEventListener('pdfjsready', retryHandler, { once: true });
            return;
        }

        const openContext = context || {};
        const explicitMode = openContext.mode || null;
        const isOfflineMode = explicitMode === 'offline' || window.__WIZARD_MODE === 'offline';

        const modalElement = document.getElementById('pdfPreviewModal');

        // Prevent accessibility warning when Bootstrap toggles aria-hidden while a child retains focus
        if (!modalElement._blurOnHideHandler) {
            modalElement._blurOnHideHandler = () => {
                const active = document.activeElement;
                if (active && modalElement.contains(active)) {
                    active.blur();
                }
            };
            modalElement.addEventListener('hide.bs.modal', modalElement._blurOnHideHandler);
        }

        // Remove old escape handler if exists
        if (modalElement._preventEscapeHandler) {
            document.removeEventListener('keydown', modalElement._preventEscapeHandler, true);
        }

        const modal = new bootstrap.Modal(modalElement);
        currentSubmissionId = submissionId;
        const resolvedAssignmentId = assignmentId ?? openContext.assignmentId ?? null;
        currentAssignmentId = resolvedAssignmentId;
        currentCanvasUserName = openContext.canvasUserName || currentCanvasUserName || null;
        _annotationAdapter = openContext.modeAdapter || null;
        _annotationAdapterError = null;

        // Initialize annotation adapter for this modal session when the caller
        // did not provide one explicitly (legacy shim path).
        if (!_annotationAdapter) {
            _annotationAdapter = await _buildAnnotationAdapter();
            if (!_annotationAdapter && _annotationAdapterError) {
                console.error('[pdf-preview-modal] %s', _annotationAdapterError);
            }
        }

        wireMarkupModuleCallbacks();

        const originalPdfUrl = isOfflineMode
            ? `/offline/assessments/${resolvedAssignmentId}/submissions/${submissionId}/pdf`
            : `/api/canvas/submissions/${submissionId}/pdf${resolvedAssignmentId ? `?assignment_id=${resolvedAssignmentId}` : ''}`;
        let originalPdfLoadPromise = null;

        const ensureOriginalPdfLoaded = () => {
            if (!window.__pdfOriginalViewer) {
                return Promise.resolve();
            }
            if (!originalPdfLoadPromise) {
                originalPdfLoadPromise = window.__pdfOriginalViewer.loadPDF(originalPdfUrl).catch((error) => {
                    originalPdfLoadPromise = null;
                    throw error;
                });
            }
            return originalPdfLoadPromise;
        };

        const scheduleGradedViewerRelayout = () => {
            window.setTimeout(() => {
                if (!window.__pdfGradedViewer?.pdf) {
                    return;
                }
                window.__pdfGradedViewer.reRenderAllPages(true).then(() => {
                    if (typeof renderAnnotationsList === 'function') {
                        renderAnnotationsList();
                    }
                    if (splitPanelActive && typeof renderAIAnnotationsList === 'function') {
                        renderAIAnnotationsList();
                    }
                }).catch((error) => {
                    console.error('[FRONTEND] Failed to relayout graded PDF after modal pane activation:', error);
                });
            }, 180);
        };

        // CRITICAL: Prevent modal AND fullscreen from closing on Escape when editing annotation
        // Attach to document with capture phase to intercept BEFORE browser's fullscreen handler
        const preventModalCloseOnEscape = async (e) => {
            if (e.key !== 'Escape') return;

            // Case 0: INLINE editing (on PDF) -> save and exit inline edit (stay in fullscreen/modal)
            if (inlineEditingLabel !== null && inlineEditingLabel.classList.contains('label-editing')) {
                debugLog('[MODAL-ESCAPE] Intercepting Escape for INLINE Edit');
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                // Get textarea content
                const textarea = inlineEditingLabel.querySelector('textarea.inline-annotation-editor');
                const content = textarea ? textarea.value : '';

                // Save and collapse
                await saveAndCollapseInlineLabel(inlineEditingLabel, content);

                // Clear tracking and panel editing mode
                inlineEditingLabel = null;
                editingAnnotationId = null;
                renderAnnotationsList();
                return;
            }

            // Case 1: Panel editing -> cancel edit (stay in fullscreen/modal)
            if (editingAnnotationId !== null) {
                debugLog('[MODAL-ESCAPE] Intercepting Escape to Cancel Edit');
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const pageIdx = currentAnnotationsPage;
                const pageAnnotations = annotationsData[pageIdx] || [];

                let foundAnnotation = false;

                const buildDomIdCandidates = (ann, idx) => {
                    const raw = [];
                    const pushCandidate = (value, source) => {
                        const normalized = normalizeAnnotationIdentifierValue(value);
                        if (normalized) {
                            raw.push({ id: normalized, source });
                        }
                    };
                    pushCandidate(resolveAnnotationIdentifierValue(ann), 'resolveAnnotationIdentifierValue');
                    pushCandidate(ann.requestIdentifier, 'requestIdentifier');
                    pushCandidate(ann.identifier, 'identifier');
                    pushCandidate(ann.id, 'id');
                    pushCandidate(ann.stableId || ann.stable_id, 'stableId');
                    pushCandidate(ann.displayIdentifier, 'displayIdentifier');
                    pushCandidate(ann.name, 'name');
                    pushCandidate(ann.title, 'title');
                    pushCandidate(ann.xref, 'xref');

                    const seen = new Set();
                    return raw
                        .filter((entry) => {
                            if (seen.has(entry.id)) {
                                return false;
                            }
                            seen.add(entry.id);
                            return true;
                        })
                        .map((entry) => ({
                            domId: `ann-${idx}-${entry.id}`,
                            id: entry.id,
                            source: entry.source,
                        }));
                };

                const handleAnnotationMatch = async (ann, idx, matchedId, _matchedSource) => {
                    foundAnnotation = true;

                    const textarea = document.getElementById(`edit-annotation-text-${matchedId}`);
                    const currentContent = textarea ? textarea.value.trim() : '';
                    const originalContent = (ann.content || '').trim();

                    const isPlaceholder = PLACEHOLDER_STRINGS.includes(currentContent);
                    const neverEdited = PLACEHOLDER_STRINGS.includes(originalContent);

                    // CRITICAL: Check if annotation has been edited (text or priority changed)
                    // If edited, DON'T delete on Escape - only revert to view mode
                    const hasBeenEdited = ann._hasBeenEdited === true || ann._priorityChanged === true;

                    // CRITICAL FIX: Also check if user typed something different from the original
                    // This handles the case where user types into a new comment but _hasBeenEdited flag wasn't set
                    const contentWasEdited = currentContent !== originalContent && !PLACEHOLDER_STRINGS.includes(currentContent);

                    // Only delete if: (temporary OR never edited OR placeholder) AND no edits made AND no text changes
                    // If user edited the text or changed priority, keep the annotation
                    if ((ann._isTemporary || neverEdited || isPlaceholder) && !hasBeenEdited && !contentWasEdited) {
                        const requestId = ann.requestIdentifier || matchedId;
                        await deleteAnnotationSilently(idx, requestId);
                    } else if (contentWasEdited) {
                        // User typed something - preserve the content by updating the annotation
                        ann.content = currentContent;
                        ann._isTemporary = false; // No longer temporary since it has user content
                        ann._hasBeenEdited = true;
                        debugLog('[MODAL-ESCAPE] Preserved user content on Escape:', currentContent.substring(0, 50));
                    }

                    editingAnnotationId = null;
                    renderAnnotationsList();
                    renderAllAnnotations(true);
                };

                // Try direct match on current page
                if (!foundAnnotation && typeof editingAnnotationId === 'string' && editingAnnotationId.startsWith('ann-')) {
                    const match = editingAnnotationId.match(/^ann-(\d+)-(.*)$/);
                    if (match) {
                        const targetId = normalizeAnnotationIdentifierValue(match[2]);
                        const candidates = pageAnnotations.map((ann) => buildDomIdCandidates(ann, pageIdx)).flat();
                        const matchCandidate = candidates.find((c) => c.id === targetId || c.domId === editingAnnotationId);
                        if (matchCandidate) {
                            const ann = pageAnnotations.find((a) => buildDomIdCandidates(a, pageIdx).some((c) => c.id === matchCandidate.id));
                            if (ann) {
                                await handleAnnotationMatch(ann, pageIdx, matchCandidate.id, matchCandidate.source);
                            }
                        }
                    }
                }

                // Check each annotation with all identifier candidates on current page
                if (!foundAnnotation) {
                    for (const ann of pageAnnotations) {
                        const candidates = buildDomIdCandidates(ann, pageIdx);
                        const matchCandidate = candidates.find((c) => c.domId === editingAnnotationId);
                        if (matchCandidate) {
                            await handleAnnotationMatch(ann, pageIdx, matchCandidate.id, matchCandidate.source);
                            break;
                        }
                    }
                }

                // Cross-page search
                if (!foundAnnotation) {
                    for (let searchPageIdx in annotationsData) {
                        const searchPageAnns = annotationsData[searchPageIdx] || [];
                        for (const ann of searchPageAnns) {
                            const candidates = buildDomIdCandidates(ann, searchPageIdx);
                            const matchCandidate = candidates.find((c) => c.domId === editingAnnotationId);
                            if (matchCandidate) {
                                await handleAnnotationMatch(ann, parseInt(searchPageIdx, 10), matchCandidate.id, matchCandidate.source);
                                foundAnnotation = true;
                                break;
                            }
                        }
                        if (foundAnnotation) break;
                    }
                }

                if (!foundAnnotation && PDF_DEBUG) {
                    debugLog('[MODAL-ESCAPE] No annotation matched for editingAnnotationId:', editingAnnotationId);
                }
                editingAnnotationId = null;
                renderAnnotationsList();
                renderAllAnnotations(true);
                return;
            }

            // Case 2: Exit markup mode before fullscreen handling.
            if (markupModeActive) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                toggleMarkupMode();
                return;
            }

            // Case 3: In fullscreen (not editing) -> BLOCK Escape entirely
            // User requirement: Only F11 or the fullscreen button should exit fullscreen mode
            // Escape should do nothing in fullscreen to prevent accidental exits
            if (previewFullscreenActive) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                // Do NOT call exitPreviewFullscreen() - just consume the event
                return;
            }

            // Case 4: Not editing and not fullscreen -> allow Bootstrap/modal default handling
        };
        // CRITICAL: Attach to document, not modalElement, to intercept before fullscreen handler
        document.addEventListener('keydown', preventModalCloseOnEscape, true);
        modalElement._preventEscapeHandler = preventModalCloseOnEscape;

        // Add Ctrl+Z undo functionality
        const handleUndo = async (e) => {
            // Check for Ctrl+Z (Windows/Linux) or Cmd+Z (Mac)
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                const target = e.target;
                const isTextInput = target instanceof HTMLInputElement && target.type !== 'number';
                const isTextarea = target instanceof HTMLTextAreaElement;
                const isEditableNode = !!target?.isContentEditable;
                // Keep native undo inside real text editors, but still allow
                // modal-wide undo when focus is on the page-number navigator.
                if (isTextInput || isTextarea || isEditableNode) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                await performUndo();
            }
        };
        document.addEventListener('keydown', handleUndo, true);
        modalElement._undoHandler = handleUndo;

        // Cleanup when modal is hidden
        modalElement.addEventListener('hidden.bs.modal', () => {
            if (modalElement._preventEscapeHandler) {
                document.removeEventListener('keydown', modalElement._preventEscapeHandler, true);
                modalElement._preventEscapeHandler = null;
            }
            if (modalElement._undoHandler) {
                document.removeEventListener('keydown', modalElement._undoHandler, true);
                modalElement._undoHandler = null;
            }
            if (navigator.keyboard && navigator.keyboard.unlock) {
                navigator.keyboard.unlock();
            }
            exitPreviewFullscreen();
        }, { once: true });

        // Update title
        document.getElementById('pdfPreviewStudent').textContent = studentName || `Submission ${submissionId}`;

        const originalTabContainer = document.getElementById('pdfOriginalTabContainer');
        const showOriginalBtn = document.getElementById('pdfShowOriginalBtn');
        const showAnnotatedBtn = document.getElementById('pdfShowAnnotatedBtn');
        const showOriginalBtnContainer = document.getElementById('pdfShowOriginalBtnContainer');
        const showAnnotatedBtnContainer = document.getElementById('pdfShowAnnotatedBtnContainer');
        if (originalTabContainer) {
            originalTabContainer.classList.remove('d-none');
        }
        if (showOriginalBtnContainer) {
            showOriginalBtnContainer.classList.add('d-none');
        }
        if (showOriginalBtn) {
            showOriginalBtn.onclick = null;
        }
        if (showAnnotatedBtnContainer) {
            showAnnotatedBtnContainer.classList.add('d-none');
        }
        if (showAnnotatedBtn) {
            showAnnotatedBtn.onclick = null;
        }
        // Reset search state — use controller when available, fallback to local
        if (_currentDocCtrl) {
            _currentDocCtrl.resetSearchState();
        } else {
            const searchInput = document.getElementById('pdfSearchInput');
            if (searchInput) {
                searchInput.value = '';
            }
            pdfSearchState.pageTextCache.clear();
            pdfSearchState.matches = [];
            pdfSearchState.currentIndex = -1;
            pdfSearchState.term = '';
            updateSearchStatus('');
        }

        // Reset annotations missing banner (hidden by default, shown only if no graded PDF)
        const annotationsBannerReset = document.getElementById('pdfAnnotationsMissingBanner');
        if (annotationsBannerReset) {
            annotationsBannerReset.classList.add('d-none');
        }

        // CRITICAL FIX: Show modal FIRST, then wait for animation to finish
        // before loading PDF so the container is at its final width.
        // This prevents the ResizeObserver from triggering a re-render
        // (which causes visible flicker) after the initial render.
        const _pdfLoadHandler = async () => {
            modalElement.removeEventListener('shown.bs.modal', _pdfLoadHandler);

            debugLog('[FRONTEND] Modal delay complete, fetching graded PDF...');

            // ---------------------------------------------------------------
            // Phase 5A: Delegate PDF loading to document controller when available.
            // The controller owns fetch, blob URL tracking, tab switching,
            // and viewer loading. The monolith retains annotation loading and
            // the "Show Original" button wiring (cross-controller concern).
            // ---------------------------------------------------------------
            if (_currentDocCtrl) {
                try {
                    // Unhide and activate the graded tab BEFORE loading so the PDF
                    // container has its final width when renderSkeleton runs.
                    // If no graded PDF exists, we re-hide it below.
                    document.getElementById('pdfGradedTabContainer')?.classList.remove('d-none');
                    _currentDocCtrl.activateTab('graded');

                    const result = await _currentDocCtrl.loadGradedPdf(resolvedAssignmentId, submissionId);

                    if (result) {
                        // Graded PDF loaded successfully — set up UI
                        const annotationsBannerHide = document.getElementById('pdfAnnotationsMissingBanner');
                        if (annotationsBannerHide) { annotationsBannerHide.classList.add('d-none'); }

                        _currentDocCtrl.activateTab('graded');

                        // Hide built-in tabs, show toggle tabs instead
                        if (originalTabContainer) { originalTabContainer.classList.add('d-none'); }
                        document.getElementById('pdfGradedTabContainer')?.classList.add('d-none');
                        if (showOriginalBtnContainer) { showOriginalBtnContainer.classList.remove('d-none'); }
                        if (showAnnotatedBtnContainer) { showAnnotatedBtnContainer.classList.remove('d-none'); }
                        // Mark "Graded with Annotations" toggle as active
                        showAnnotatedBtn?.classList.add('active');
                        showOriginalBtn?.classList.remove('active');

                        if (showOriginalBtn) {
                            showOriginalBtn.onclick = () => {
                                _currentDocCtrl.activateTab('original');
                                showOriginalBtn.classList.add('active');
                                showAnnotatedBtn?.classList.remove('active');
                                setTimeout(() => {
                                    _currentDocCtrl.loadOriginalPdf(resolvedAssignmentId, submissionId).catch((loadError) => {
                                        console.error('[FRONTEND] Original PDF load error:', loadError);
                                    });
                                }, 50);
                            };
                        }
                        if (showAnnotatedBtn) {
                            showAnnotatedBtn.onclick = () => {
                                _currentDocCtrl.activateTab('graded');
                                showAnnotatedBtn.classList.add('active');
                                showOriginalBtn?.classList.remove('active');
                            };
                        }

                        loadAnnotations(submissionId, resolvedAssignmentId);
                    } else {
                        // No graded PDF — fall back to original
                        debugLog('[FRONTEND] No graded PDF (controller), loading original...');
                        document.getElementById('pdfGradedTabContainer')?.classList.add('d-none');
                        if (originalTabContainer) { originalTabContainer.classList.remove('d-none'); }
                        if (showOriginalBtnContainer) { showOriginalBtnContainer.classList.add('d-none'); }
                        if (showOriginalBtn) { showOriginalBtn.onclick = null; }
                        if (showAnnotatedBtnContainer) { showAnnotatedBtnContainer.classList.add('d-none'); }
                        if (showAnnotatedBtn) { showAnnotatedBtn.onclick = null; }

                        const annotationsBanner = document.getElementById('pdfAnnotationsMissingBanner');
                        if (annotationsBanner) { annotationsBanner.classList.remove('d-none'); }

                        setTimeout(() => {
                            _currentDocCtrl.loadOriginalPdf(resolvedAssignmentId, submissionId).catch((loadError) => {
                                console.error('[FRONTEND] Original PDF load error:', loadError);
                            });
                        }, 200);
                    }
                } catch (error) {
                    // Error from controller — fall back to original
                    debugLog('[FRONTEND] Error from document controller, loading original...', error);
                    document.getElementById('pdfGradedTabContainer')?.classList.add('d-none');
                    if (originalTabContainer) { originalTabContainer.classList.remove('d-none'); }
                    if (showOriginalBtnContainer) { showOriginalBtnContainer.classList.add('d-none'); }
                    if (showOriginalBtn) { showOriginalBtn.onclick = null; }
                    if (showAnnotatedBtnContainer) { showAnnotatedBtnContainer.classList.add('d-none'); }
                    if (showAnnotatedBtn) { showAnnotatedBtn.onclick = null; }

                    const annotationsBannerError = document.getElementById('pdfAnnotationsMissingBanner');
                    if (annotationsBannerError) { annotationsBannerError.classList.remove('d-none'); }

                    setTimeout(() => {
                        _currentDocCtrl.loadOriginalPdf(resolvedAssignmentId, submissionId).catch((loadError) => {
                            console.error('[FRONTEND] Original PDF load error:', loadError);
                        });
                    }, 200);
                }
                return;
            }

            // ---------------------------------------------------------------
            // Fallback: original monolith code (when document controller is not loaded)
            // ---------------------------------------------------------------
            try {
                let gradedBlob = null;

                // Route through adapter first (any mode) when available.
                if (_annotationAdapter && typeof _annotationAdapter.fetchAnnotatedPdf === 'function') {
                    try {
                        gradedBlob = await _annotationAdapter.fetchAnnotatedPdf(
                            resolvedAssignmentId,
                            submissionId,
                            {
                                courseId: openContext.courseId || null,
                                offline: isOfflineMode,
                                annotatedPdfPolicy: openContext.annotatedPdfPolicy || (isOfflineMode ? 'offline_only' : 'server_allowed'),
                            }
                        );
                    } catch (adapterErr) {
                        var requiresLocalAnnotatedPdf = !!(adapterErr && adapterErr.localAnnotatedPdfRequired);
                        debugLog('[FRONTEND] Adapter fetchAnnotatedPdf failed:', adapterErr);
                        if (requiresLocalAnnotatedPdf) {
                            throw adapterErr;
                        }
                    }
                }

                // Server / offline fallback only if adapter didn't provide blob
                if (!gradedBlob) {
                    const gradedPdfUrl = isOfflineMode
                        ? `/offline/api/assessments/${resolvedAssignmentId}/submissions/${submissionId}/pdf-graded`
                        : `/api/canvas/submissions/${submissionId}/pdf-graded${resolvedAssignmentId ? `?assignment_id=${resolvedAssignmentId}` : ''}`;
                    const response = await fetch(gradedPdfUrl, {
                        headers: withCsrf(),
                        credentials: 'same-origin'
                    });
                    if (response.ok) {
                        gradedBlob = await response.blob();
                    }
                }

                if (gradedBlob) {
                    const blob = gradedBlob;
                    const url = URL.createObjectURL(blob);
                    document.getElementById('pdfGradedTabContainer').classList.remove('d-none');

                    // Hide annotations missing banner when graded PDF is available
                    const annotationsBannerHide = document.getElementById('pdfAnnotationsMissingBanner');
                    if (annotationsBannerHide) {
                        annotationsBannerHide.classList.add('d-none');
                    }

                    // CRITICAL FIX: Switch to graded tab FIRST
                    const originalTab = document.getElementById('pdfOriginalTab');
                    const gradedTab = document.getElementById('pdfGradedTab');
                    const originalPane = document.getElementById('pdfOriginalPane');
                    const gradedPane = document.getElementById('pdfGradedPane');

                    if (originalTab && gradedTab && originalPane && gradedPane) {
                        originalTab.classList.remove('active');
                        gradedTab.classList.add('active');
                        originalPane.classList.remove('show', 'active');
                        gradedPane.classList.add('show', 'active');
                    }

                    // Hide built-in tabs, show toggle tabs instead
                    if (originalTabContainer) { originalTabContainer.classList.add('d-none'); }
                    document.getElementById('pdfGradedTabContainer')?.classList.add('d-none');
                    showOriginalBtnContainer?.classList.remove('d-none');
                    showAnnotatedBtnContainer?.classList.remove('d-none');
                    showAnnotatedBtn?.classList.add('active');
                    showOriginalBtn?.classList.remove('active');

                    if (showOriginalBtn) {
                        showOriginalBtn.onclick = () => {
                            originalTab?.classList.add('active');
                            originalPane?.classList.add('show', 'active');
                            gradedTab?.classList.remove('active');
                            gradedPane?.classList.remove('show', 'active');
                            showOriginalBtn.classList.add('active');
                            showAnnotatedBtn?.classList.remove('active');
                            setTimeout(() => {
                                ensureOriginalPdfLoaded().catch((loadError) => {
                                    console.error('[FRONTEND] Original PDF load error:', loadError);
                                });
                            }, 50);
                        };
                    }
                    if (showAnnotatedBtn) {
                        showAnnotatedBtn.onclick = () => {
                            originalTab?.classList.remove('active');
                            originalPane?.classList.remove('show', 'active');
                            gradedTab?.classList.add('active');
                            gradedPane?.classList.add('show', 'active');
                            showAnnotatedBtn.classList.add('active');
                            showOriginalBtn?.classList.remove('active');
                            scheduleGradedViewerRelayout();
                        };
                    }

                    // CRITICAL FIX: Poll until container is actually visible with real width
                    const container = document.getElementById('pdfGradedContainer');
                    let pollAttempts = 0;
                    const maxPolls = 20; // Max 2 seconds (20 * 100ms)

                    const checkVisibility = () => {
                        pollAttempts++;
                        const width = container?.clientWidth || 0;
                        debugLog(`[FRONTEND] Poll attempt ${pollAttempts}: container width = ${width}px`);

                        if (width > 0) {
                            debugLog('[FRONTEND] Container is visible! Loading graded PDF...');
                            if (window.__pdfGradedViewer) {
                                window.__pdfGradedViewer.loadPDF(url).then(() => {
                                    // FIX Issue #31: Check if PDF is searchable after loading
                                    checkPdfSearchable();
                                }).catch(err => console.error('[FRONTEND] PDF load error:', err));
                            }
                            loadAnnotations(submissionId, resolvedAssignmentId);
                        } else if (pollAttempts >= maxPolls) {
                            console.error(`[FRONTEND] Container still hidden after ${maxPolls} polls! Loading anyway...`);
                            if (window.__pdfGradedViewer) {
                                window.__pdfGradedViewer.loadPDF(url).then(() => {
                                    checkPdfSearchable();
                                }).catch(err => console.error('[FRONTEND] PDF load error:', err));
                            }
                            loadAnnotations(submissionId, resolvedAssignmentId);
                        } else {
                            // Poll again in 50ms for snappier startup
                            setTimeout(checkVisibility, 50);
                        }
                    };

                    // Start polling after small initial delay
                    setTimeout(checkVisibility, 50);

                    // Update annotations when page changes
                    // CRITICAL FIX: Removed renderPage override and duplicate handlers
                    // The IntersectionObserver now handles currentAnnotationsPage updates automatically
                    // (see lines 771-779 in setupIntersectionObserver)
                } else {
                    // No graded PDF - load original instead
                    debugLog('[FRONTEND] No graded PDF, loading original...');
                    document.getElementById('pdfGradedTabContainer').classList.add('d-none');
                    if (originalTabContainer) {
                        originalTabContainer.classList.remove('d-none');
                    }
                    if (showOriginalBtnContainer) { showOriginalBtnContainer.classList.add('d-none'); }
                    if (showOriginalBtn) { showOriginalBtn.onclick = null; }
                    if (showAnnotatedBtnContainer) { showAnnotatedBtnContainer.classList.add('d-none'); }
                    if (showAnnotatedBtn) { showAnnotatedBtn.onclick = null; }

                    // Show warning banner when annotations are missing
                    const annotationsBanner = document.getElementById('pdfAnnotationsMissingBanner');
                    if (annotationsBanner) {
                        annotationsBanner.classList.remove('d-none');
                    }

                    // Load original PDF (original tab is already active)
                    setTimeout(() => {
                        ensureOriginalPdfLoaded().catch((loadError) => {
                            console.error('[FRONTEND] Original PDF load error:', loadError);
                        });
                    }, 200);
                }
            } catch (error) {
                // Error fetching graded PDF - load original instead
                debugLog('[FRONTEND] Error fetching graded PDF, loading original...', error);
                const gradedTabContainer = document.getElementById('pdfGradedTabContainer');
                if (gradedTabContainer) {
                    gradedTabContainer.classList.add('d-none');
                }
                if (originalTabContainer) {
                    originalTabContainer.classList.remove('d-none');
                }
                if (showOriginalBtnContainer) { showOriginalBtnContainer.classList.add('d-none'); }
                if (showOriginalBtn) { showOriginalBtn.onclick = null; }
                if (showAnnotatedBtnContainer) { showAnnotatedBtnContainer.classList.add('d-none'); }
                if (showAnnotatedBtn) { showAnnotatedBtn.onclick = null; }

                // Show warning banner when annotations are missing
                const annotationsBannerError = document.getElementById('pdfAnnotationsMissingBanner');
                if (annotationsBannerError) {
                    annotationsBannerError.classList.remove('d-none');
                }

                // Load original PDF (original tab is already active)
                setTimeout(() => {
                    ensureOriginalPdfLoaded().catch((loadError) => {
                        console.error('[FRONTEND] Original PDF load error:', loadError);
                    });
                }, 200);
            }
        };
        modalElement.addEventListener('shown.bs.modal', _pdfLoadHandler);
        modal.show();
    }

    // =========================================================================
    // New Interface Contract (Phase 5A)
    // =========================================================================

    /**
     * Create a new PDF Preview Modal instance with explicit options.
     *
     * Phase 5A composition root — currently wraps the existing monolith.
     * Controllers will be extracted in subsequent tasks.
     *
     * @param {Object} opts - Modal configuration
     * @returns {Object} Controller handle with open/close/destroy/refresh/getAnnotations
     */
    function createPdfPreviewModal(opts) {
        var ModalState = window.PdfPreviewModalStateCore;
        if (!ModalState || !ModalState.createModalState) {
            throw new Error('modal-state.js must be loaded before pdf-preview-modal.js');
        }

        var state = ModalState.createModalState(opts);
        var _destroyed = false;

        // Phase 5A: Create shell controller if module is loaded
        var Shell = window.PdfPreviewModalShell;
        if (Shell && typeof Shell.createModalShell === 'function') {
            // Destroy previous shell if any
            if (_currentShell) { _currentShell.destroy(); _currentShell = null; }

            _currentShell = Shell.createModalShell(state.ui, {
                isEditingFn: function () { return editingAnnotationId !== null; },
                markupModules: {
                    DrawingCanvas: DrawingCanvas,
                    TextboxModule: TextboxModule,
                    MarkupToolbar: MarkupToolbar,
                    MarkupSelection: MarkupSelection,
                },
            });

            // Wire shell events to monolith functions
            _currentShell.onFullscreenChanged(function (data) {
                // Sync compatibility variable
                previewFullscreenActive = data.active;
                // Re-render annotation lists
                if (typeof renderAnnotationsList === 'function') {
                    renderAnnotationsList();
                }
                if (data.active && pdfPreviewModalEl &&
                    pdfPreviewModalEl.classList.contains('split-panel-mode') &&
                    typeof renderAIAnnotationsList === 'function') {
                    renderAIAnnotationsList();
                }
                // Re-render viewers after fullscreen change
                syncSearchOverlayGeometry();
                handleFullscreenResize();
                // Re-highlight search match (use controller search state when available)
                var ss = _currentDocCtrl ? _currentDocCtrl.getSearchState() : pdfSearchState;
                if (ss.matches.length > 0 && ss.currentIndex >= 0) {
                    highlightSearchMatch(ss.matches[ss.currentIndex]);
                }
            });

            _currentShell.onSplitPanelToggled(function (data) {
                // Sync compatibility variable
                splitPanelActive = data.active;
                // Re-render annotations
                if (typeof renderAnnotationsList === 'function') {
                    renderAnnotationsList();
                }
                if (data.active && typeof renderAIAnnotationsList === 'function') {
                    renderAIAnnotationsList();
                }
            });

            _currentShell.onClose(function () {
                // Stop polling
                if (typeof stopAnnotationsPolling === 'function') {
                    stopAnnotationsPolling();
                }
                // Sync compatibility variable
                markupModeActive = false;
            });

            _currentShell.onResizeNeeded(function () {
                handleFullscreenResize();
            });

            _currentShell.onSearchHighlightNeeded(function () {
                syncSearchOverlayGeometry();
                // Use controller search state when available
                var ss = _currentDocCtrl ? _currentDocCtrl.getSearchState() : pdfSearchState;
                if (ss.matches.length > 0 && ss.currentIndex >= 0) {
                    highlightSearchMatch(ss.matches[ss.currentIndex]);
                }
            });

            _currentShell.onToolbarToggled(function (data) {
                // Sync compatibility variable
                markupModeActive = data.active;
            });

            _currentShell.onTabSwitched(function (data) {
                if (_currentDocCtrl && data && data.tab) {
                    _currentDocCtrl.activateTab(data.tab);
                }
            });
        }

        // Phase 5A: Create document controller if module is loaded
        var DocCtrl = window.PdfPreviewModalDocumentController;
        if (DocCtrl && typeof DocCtrl.createDocumentController === 'function') {
            // Destroy previous controller if any
            if (_currentDocCtrl) { _currentDocCtrl.destroy(); _currentDocCtrl = null; }

            _currentDocCtrl = DocCtrl.createDocumentController(state.document, {
                modeAdapter: state.options.modeAdapter,
                assignmentId: state.options.assignmentId,
                submissionId: state.options.submissionId,
                courseId: state.options.courseId,
                mode: state.options.mode,
                annotatedPdfPolicy: state.options.annotatedPdfPolicy,
                capabilities: state.options.capabilities,
            });

            // Wire document controller events to monolith functions
            _currentDocCtrl.onPageRendered(function (pageNum) {
                if (typeof renderAnnotationsForPage === 'function') {
                    renderAnnotationsForPage(pageNum);
                }
                refreshMarkupFromAnnotations();
            });

            _currentDocCtrl.onPageChanged(function (pageIdx) {
                if (currentAnnotationsPage !== pageIdx) {
                    currentAnnotationsPage = pageIdx;
                    if (typeof renderAnnotationsList === 'function') {
                        clearTimeout(window._annotationListUpdateTimer);
                        window._annotationListUpdateTimer = setTimeout(function () {
                            renderAnnotationsList();
                        }, 150);
                    }
                }
            });

            _currentDocCtrl.onResizeComplete(function () {
                if (typeof renderAllAnnotations === 'function') {
                    renderAllAnnotations(true);
                }
                refreshMarkupFromAnnotations();
            });
        }

        // Phase 5A: Create overlay renderer if module is loaded
        var OverlayRendererMod = window.PdfPreviewModalOverlayRenderer;
        if (OverlayRendererMod && typeof OverlayRendererMod.createOverlayRenderer === 'function') {
            if (_currentOverlayRenderer) { _currentOverlayRenderer.destroy(); _currentOverlayRenderer = null; }

            _currentOverlayRenderer = OverlayRendererMod.createOverlayRenderer({
                getAnnotationsData: function () { return annotationsData; },
                getSelectedAnnotation: function () { return selectedAnnotation; },
                helpers: {
                    normalizeAnnotationIdentifierValue: normalizeAnnotationIdentifierValue,
                    resolveAnnotationIdParts: resolveAnnotationIdParts,
                    resolveAnnotationIdentifierValue: resolveAnnotationIdentifierValue,
                    deriveAnnotationPriority: deriveAnnotationPriority,
                    resolveAnnotationSource: resolveAnnotationSource,
                    isPlaceholderAnnotation: isPlaceholderAnnotation,
                    isMarkupType: function (type) {
                        var CrudRef = window.PdfPreviewModalCrud;
                        return CrudRef && CrudRef.isMarkupType ? CrudRef.isMarkupType(type) : false;
                    },
                    renderCompactInlineLabelContent: renderCompactInlineLabelContent,
                    positionLabelOptimally: positionLabelOptimally,
                    repositionAllLabels: repositionAllLabels,
                    setupLabelTooltipEvents: setupLabelTooltipEvents,
                    buildDisplayOrderByPagePosition: buildDisplayOrderByPagePosition,
                    resolveDisplayOrderFromLookup: resolveDisplayOrderFromLookup,
                    observeAnnotationMarker: observeAnnotationMarker,
                    makeAnnotationDraggable: makeAnnotationDraggable,
                    DrawingCanvas: DrawingCanvas,
                },
                capabilities: state.options.capabilities,
            });

            // Wire overlay renderer events to monolith functions
            // onMarkerClicked fallback: only register if annotation controller is absent.
            // When the annotation controller IS present it re-wires onMarkerClicked
            // below via selectAnnotation → highlightSelection.  Wiring here too would
            // cause highlightAnnotationSelection to fire twice per click (flicker).
            var _annotationCtrlAvailable = !!(window.PdfPreviewModalAnnotationController &&
                typeof window.PdfPreviewModalAnnotationController.createAnnotationController === 'function');
            if (!_annotationCtrlAvailable) {
                _currentOverlayRenderer.onMarkerClicked(function (data) {
                    highlightAnnotationSelection(data.pageIdx, data.identifier);
                });
            }

            _currentOverlayRenderer.onMarkerDblClicked(function (data) {
                if (_currentAnnotationCtrl && _currentAnnotationCtrl.beginEdit) {
                    _currentAnnotationCtrl.beginEdit(
                        data.pageIdx,
                        data.identifier,
                        'ann-' + data.pageIdx + '-' + data.identifier
                    );
                    return;
                }

                var domId = 'ann-' + data.pageIdx + '-' + data.identifier;
                editingAnnotationId = domId;
                renderAnnotationsList();
                document.querySelectorAll('.annotation-label.label-expanded').forEach(function (otherLabel) {
                    if (otherLabel !== data.label) {
                        collapseInlineLabel(otherLabel);
                    }
                });
                expandInlineLabelEdit(data.label);
                setTimeout(function () {
                    var textarea = document.getElementById('edit-annotation-text-' + data.identifier);
                    if (textarea) {
                        setupTextareaAutoResize(textarea);
                    }
                }, 100);
                highlightAnnotationSelection(data.pageIdx, data.identifier);
            });

            _currentOverlayRenderer.onOverlayDblClicked(function (data) {
                if (_currentAnnotationCtrl && _currentAnnotationCtrl.createTemporaryAnnotation) {
                    _currentAnnotationCtrl.createTemporaryAnnotation(data.rect, data.pageIdx);
                    return;
                }
                createTemporaryAnnotation(data.rect, data.pageIdx);
            });

            _currentOverlayRenderer.onOverlayReady(function (_data) {
                // Reserved for future wiring
            });
        }

        // Phase 5A: Create annotation controller if module is loaded
        var AnnotationCtrlMod = window.PdfPreviewModalAnnotationController;
        if (AnnotationCtrlMod && typeof AnnotationCtrlMod.createAnnotationController === 'function') {
            if (_currentAnnotationCtrl) { _currentAnnotationCtrl.destroy(); _currentAnnotationCtrl = null; }

            _currentAnnotationCtrl = AnnotationCtrlMod.createAnnotationController({
                annotationsState: state.annotations,
                modeAdapter: state.options.modeAdapter,
                mode: state.options.mode,
                assignmentId: state.options.assignmentId,
                submissionId: state.options.submissionId,
                courseId: state.options.courseId,
                canvasUserName: state.options.canvasUserName,
                capabilities: state.options.capabilities,
                callbacks: state.options.callbacks,
                getAnnotationsData: function () { return annotationsData; },
                setAnnotationsData: function (data) { annotationsData = data; },
                getCurrentSubmissionId: function () { return currentSubmissionId; },
                getCurrentAssignmentId: function () { return currentAssignmentId; },
                getEditingAnnotationId: function () { return editingAnnotationId; },
                setEditingAnnotationId: function (id) { editingAnnotationId = id; },
                getSelectedAnnotation: function () { return selectedAnnotation; },
                setSelectedAnnotation: function (sel) { selectedAnnotation = sel; },
                getSplitPanelActive: function () { return splitPanelActive; },
                getPreviewFullscreenActive: function () { return previewFullscreenActive; },
                helpers: {
                    highlightAnnotationSelection: function (pageIdx, identifierValue) {
                        _annotationCtrlDelegating = true;
                        try { return highlightAnnotationSelection(pageIdx, identifierValue); }
                        finally { _annotationCtrlDelegating = false; }
                    },
                    renderAIAnnotationsList: function () {
                        _annotationCtrlDelegating = true;
                        try { return renderAIAnnotationsList(); }
                        finally { _annotationCtrlDelegating = false; }
                    },
                    listAnnotationsRequest: function () { return listAnnotationsRequest(); },
                    normalizeAnnotationsPayload: normalizeAnnotationsPayload,
                    cleanupPlaceholderAnnotations: cleanupPlaceholderAnnotations,
                    refreshMarkupFromAnnotations: refreshMarkupFromAnnotations,
                    buildAnnotationVisibilityKey: buildAnnotationVisibilityKey,
                    buildDisplayOrderByPagePosition: buildDisplayOrderByPagePosition,
                    resolveDisplayOrderFromLookup: resolveDisplayOrderFromLookup,
                    compareAnnotationsByDocumentPosition: compareAnnotationsByDocumentPosition,
                    normalizeAnnotationIdentifierValue: normalizeAnnotationIdentifierValue,
                    resolveAnnotationIdParts: resolveAnnotationIdParts,
                    buildApiAnnotationIdentifier: buildApiAnnotationIdentifier,
                    createAnnotationRequest: createAnnotationRequest,
                    updateAnnotationRequest: updateAnnotationRequest,
                    deleteAnnotationRequest: deleteAnnotationRequest,
                    deriveAnnotationPriority: deriveAnnotationPriority,
                    resolveAnnotationSource: resolveAnnotationSource,
                    isPlaceholderAnnotation: isPlaceholderAnnotation,
                    enhanceAnnotationEntry: enhanceAnnotationEntry,
                    resolveAnnotationIdentifierValue: resolveAnnotationIdentifierValue,
                    findAnnotationEntry: findAnnotationEntry,
                    findAnnotationIndex: findAnnotationIndex,
                    translatePdfPreviewText: translatePdfPreviewText,
                    escapeHtml: escapeHtml,
                    escapeCssAttribute: escapeCssAttribute,
                    formatGraderDisplayName: formatGraderDisplayName,
                    showToast: showToast,
                    scrollToAnnotationMarker: scrollToAnnotationMarker,
                    toggleAnnotationVerdict: toggleAnnotationVerdict,
                    updateAnnotationPriority: updateAnnotationPriority,
                    pushUndoOperation: pushUndoOperation,
                    collapseInlineLabel: collapseInlineLabel,
                    expandInlineLabelEdit: expandInlineLabelEdit,
                    setupTextareaAutoResize: setupTextareaAutoResize,
                },
            });

            // Wire annotation controller events to monolith functions
            var _annCtrlCallbacks = state.options.callbacks || {};
            _currentAnnotationCtrl.onAnnotationsChanged(function (data) {
                if (_currentOverlayRenderer && data?.renderOverlays !== false) {
                    _currentOverlayRenderer.renderAnnotations(data?.forceRender === true);
                }
                if (_annCtrlCallbacks.onAnnotationsChanged) {
                    _annCtrlCallbacks.onAnnotationsChanged(data);
                }
            });

            _currentAnnotationCtrl.onAnnotationsLoaded(function () {
                if (_currentVersionSync) {
                    _currentVersionSync.start();
                }
            });

            _currentAnnotationCtrl.onRenderListNeeded(function () {
                if (typeof renderAnnotationsList === 'function') {
                    renderAnnotationsList();
                }
            });

            _currentAnnotationCtrl.onRenderOverlaysNeeded(function (data) {
                if (typeof renderAllAnnotations === 'function') {
                    var force = data && data.forceRender !== undefined ? data.forceRender : false;
                    renderAllAnnotations(force);
                }
            });

            _currentAnnotationCtrl.onScheduleUpdate(function () {
                if (typeof scheduleAnnotationUpdate === 'function') {
                    scheduleAnnotationUpdate();
                }
            });

            // Re-wire overlay marker click through annotation controller
            if (_currentOverlayRenderer) {
                _currentOverlayRenderer.onMarkerClicked(function (data) {
                    _currentAnnotationCtrl.selectAnnotation(data.identifier, data.pageIdx);
                });
            }
        }

        // Phase 5A: Create version sync if module is loaded
        var VersionSync = window.PdfPreviewModalVersionSync;
        if (VersionSync && typeof VersionSync.createVersionSync === 'function') {
            if (_currentVersionSync) { _currentVersionSync.destroy(); _currentVersionSync = null; }
            _currentVersionSync = VersionSync.createVersionSync(state.sync, {
                modeAdapter: state.options.modeAdapter,
                submissionId: state.options.submissionId,
                assignmentId: state.options.assignmentId,
            });
            _currentVersionSync.onExternalChange(function () {
                // Reload annotations — the overlay renderer's xref-based cache
                // check (forceRender=false) will skip re-rendering pages where
                // annotation data hasn't actually changed.
                if (_currentAnnotationCtrl) {
                    _currentAnnotationCtrl.reload();
                } else {
                    loadAnnotations(currentSubmissionId, currentAssignmentId);
                }
            });
        }

        var handle = {
            async open() {
                if (_destroyed) throw new Error('Modal has been destroyed');
                await _openPdfPreviewInternal(
                    state.options.submissionId,
                    state.options.studentName,
                    state.options.assignmentId,
                    {
                        modeAdapter: state.options.modeAdapter,
                        mode: state.options.mode,
                        courseId: state.options.courseId,
                        annotatedPdfPolicy: state.options.annotatedPdfPolicy,
                        canvasUserName: state.options.canvasUserName,
                    }
                );
            },

            close() {
                var modalEl = document.getElementById('pdfPreviewModal');
                if (modalEl) {
                    var bsModal = bootstrap.Modal.getInstance(modalEl);
                    if (bsModal) bsModal.hide();
                }
            },

            destroy() {
                if (_destroyed) return;
                _destroyed = true;
                handle.close();
                stopAnnotationsPolling();
                _annotationAdapter = null;
                currentCanvasUserName = null;
                // Phase 5A: destroy controllers
                if (_currentVersionSync) { _currentVersionSync.destroy(); _currentVersionSync = null; }
                if (_currentAnnotationCtrl) { _currentAnnotationCtrl.destroy(); _currentAnnotationCtrl = null; }
                if (_currentOverlayRenderer) { _currentOverlayRenderer.destroy(); _currentOverlayRenderer = null; }
                if (_currentDocCtrl) { _currentDocCtrl.destroy(); _currentDocCtrl = null; }
                if (_currentShell) { _currentShell.destroy(); _currentShell = null; }
            },

            async refresh() {
                if (_destroyed) throw new Error('Modal has been destroyed');
                await loadAnnotations(currentSubmissionId, currentAssignmentId);
            },

            getAnnotations() {
                return JSON.parse(JSON.stringify(annotationsData));
            },

            /** @internal — expose state for testing */
            _state: state,
        };

        return handle;
    }

    function normalizePackageOptions(options) {
        var normalized = Object.assign({}, options || {});
        var context = normalized.context || {};
        if (context.assignmentId != null && normalized.assignmentId == null) {
            normalized.assignmentId = context.assignmentId;
        }
        if (context.submissionId != null && normalized.submissionId == null) {
            normalized.submissionId = context.submissionId;
        }
        if (context.courseId != null && normalized.courseId == null) {
            normalized.courseId = context.courseId;
        }
        if (context.studentName != null && normalized.studentName == null) {
            normalized.studentName = context.studentName;
        }
        if (context.mode != null && normalized.mode == null) {
            normalized.mode = context.mode;
        }
        if (context.annotatedPdfPolicy != null && normalized.annotatedPdfPolicy == null) {
            normalized.annotatedPdfPolicy = context.annotatedPdfPolicy;
        }
        if (normalized.hostApi && !normalized.modeAdapter) {
            normalized.modeAdapter = normalized.hostApi;
        }
        return normalized;
    }

    // Make it globally available (PDFViewer is now from the module)
    window.PDFViewer = window.PdfPreviewModalViewer?.PDFViewer;
    window.ensureModalPdfViewers = ensureModalViewers;

    /**
     * Get current annotations from the PDF preview modal (if loaded).
     * This allows client-side extraction without re-fetching from server.
     *
     * @returns {Object|null} Object with submissionId and annotations array, or null if not loaded
     */
    window.getCurrentAnnotations = function () {
        if (!currentSubmissionId || !annotationsData) {
            return null;
        }
        // Use shared utility to flatten annotations (avoids code duplication)
        // flattenAnnotations is defined in wizard_utils.js
        const annotations = typeof window.flattenAnnotations === 'function'
            ? window.flattenAnnotations(annotationsData)
            : (function () {
                // Fallback inline implementation if utility not loaded
                const result = [];
                for (const [pageIdx, pageAnnotations] of Object.entries(annotationsData)) {
                    for (const ann of pageAnnotations) {
                        const text = ann.content || ann.text || '';
                        if (text.trim()) {
                            result.push({
                                text: text.trim(),
                                page: parseInt(pageIdx) + 1,
                                type: ann.type || 'unknown'
                            });
                        }
                    }
                }
                return result;
            })();
        return {
            submissionId: currentSubmissionId,
            annotations: annotations
        };
    };

    /**
     * Load PDF for comparison mode.
     * This loads the PDF and sets up the viewer for A/B comparison.
     *
     * @param {string} url - URL to the PDF file
     * @returns {Promise<void>}
     */
    window.loadPdfForComparison = async function (url) {
        if (!url) {
            console.error('[Comparison] No PDF URL provided');
            return;
        }

        if (!ensureModalViewers()) {
            console.error('[Comparison] PDF viewers not initialized');
            return;
        }

        const viewer = window.__pdfGradedViewer;
        if (!viewer) {
            console.error('[Comparison] Graded PDF viewer not available');
            return;
        }

        try {
            // Load the PDF
            await viewer.loadPDF(url);

            // Update comparison mode page info
            if (window.PdfPreviewModalComparison) {
                window.PdfPreviewModalComparison.totalPages = viewer.pdf?.numPages || 1;
                window.PdfPreviewModalComparison.currentPage = 1;
            }
        } catch (error) {
            console.error('[Comparison] Error loading PDF:', error);
            throw error;
        }
    };

    // Expose createPdfPreviewModal on PdfPreviewModal namespace
    window.PdfPreviewModal = window.PdfPreviewModal || {};
    window.PdfPreviewModal.createPdfPreviewModal = function (options) {
        return createPdfPreviewModal(normalizePackageOptions(options));
    };
    window.PdfPreviewModal.__test = {
        buildTaskPlacementBands,
        compareTaskPlacementEntries,
        buildDisplayOrderByPagePosition,
        deriveMarkerTaskGroupKey,
        isSummaryPlacementEntry,
        collapseInlineLabel,
        expandInlineLabelReadOnly,
        positionLabelOptimally,
        repositionAllLabels,
        renderCompactInlineLabelContent,
        setupLabelTooltipEvents,
        shouldIgnoreDetachedInlineBlur,
        focusElementWithoutScroll,
        getUndoStacks: () => ({
            local: undoStack.slice(),
            controller: _currentAnnotationCtrl && _currentAnnotationCtrl.getUndoStack
                ? _currentAnnotationCtrl.getUndoStack().slice()
                : [],
        }),
    };

    window.AEMSPdfAnnotator = window.AEMSPdfAnnotator || {};
    window.AEMSPdfAnnotator.createAnnotatorModal = function (options) {
        return createPdfPreviewModal(normalizePackageOptions(options));
    };
    window.AEMSPdfAnnotator.ensureModalPdfViewers = ensureModalViewers;
    window.AEMSPdfAnnotator.getCurrentAnnotations = window.getCurrentAnnotations;
    window.AEMSPdfAnnotator.loadPdfForComparison = window.loadPdfForComparison;
    window.AEMSPdfAnnotator.viewer = window.PdfPreviewModalViewer || null;

    if (!ensureModalViewers()) {
        window.addEventListener('pdfjsready', () => ensureModalViewers(), { once: true });
    }

})(); // End of IIFE
