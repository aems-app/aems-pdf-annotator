/**
 * PDF Preview Modal - Shell Controller
 *
 * Owns the modal's UI lifecycle: fullscreen, split panel, markup mode toggle,
 * modal show/hide/hidden handlers, document fullscreenchange, and resize.
 *
 * Emits events for cross-controller concerns; the composition root wires those
 * events to the appropriate monolith functions.
 *
 * Absorbs constants from fullscreen.js into inline use.
 *
 * @module pdf-preview-modal/modal-shell
 */
window.PdfPreviewModalShell = window.PdfPreviewModalShell || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants (absorbed from fullscreen.js)
    // =========================================================================
    var FULLSCREEN_CLASS = 'preview-fullscreen';
    var ICON_FULLSCREEN = 'bi-fullscreen';
    var ICON_FULLSCREEN_EXIT = 'bi-fullscreen-exit';
    var _RESIZE_DELAY = 400;
    var SPLIT_PANEL_VISIBILITY_DELAY = 100;

    // =========================================================================
    // Fullscreen helpers (absorbed from fullscreen.js)
    // =========================================================================

    function getFullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }

    // =========================================================================
    // Factory
    // =========================================================================

    /**
     * Create a modal shell controller.
     *
     * @param {Object} uiState - The state.ui slice from modal-state.js
     * @param {Object} options
     * @param {Function} options.isEditingFn - () => boolean, checks if annotation editing is active
     * @param {Object}  options.markupModules - { DrawingCanvas, TextboxModule, MarkupToolbar, MarkupSelection }
     * @returns {Object} Shell controller handle
     */
    function createModalShell(uiState, options) {
        var isEditingFn = options.isEditingFn || function () { return false; };
        var markupModules = options.markupModules || {};
        var DrawingCanvas = markupModules.DrawingCanvas || null;
        var TextboxModule = markupModules.TextboxModule || null;
        var MarkupToolbar = markupModules.MarkupToolbar || null;
        var MarkupSelection = markupModules.MarkupSelection || null;

        // -----------------------------------------------------------------
        // Event system
        // -----------------------------------------------------------------
        var _callbacks = {
            onFullscreenChanged: [],
            onSplitPanelToggled: [],
            onToolbarToggled: [],
            onTabSwitched: [],
            onClose: [],
            onResizeNeeded: [],
            onSearchHighlightNeeded: [],
        };

        function _emit(name, data) {
            var cbs = _callbacks[name] || [];
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](data); } catch (e) { console.error('[modal-shell] callback error:', e); }
            }
        }

        // -----------------------------------------------------------------
        // DOM refs
        // -----------------------------------------------------------------
        var modalEl = document.getElementById('pdfPreviewModal');
        var fullscreenBtn = document.getElementById('pdfPreviewFullscreenToggle');
        var splitPanelBtn = document.getElementById('pdfPreviewSplitPanelToggle');

        // -----------------------------------------------------------------
        // Listener tracking for cleanup
        // -----------------------------------------------------------------
        var _listeners = [];

        function _addListener(el, event, fn, opts) {
            if (!el) return;
            el.addEventListener(event, fn, opts);
            _listeners.push({ el: el, event: event, fn: fn, opts: opts });
        }

        // -----------------------------------------------------------------
        // State — the shell is source of truth, also mirrors into uiState
        // -----------------------------------------------------------------
        var _fullscreenActive = false;
        var _splitPanelActive = false;
        var _markupModeActive = false;
        var _forcedExitDuringEdit = false;

        function _syncUiState() {
            if (uiState) {
                uiState.visible = !!(modalEl && modalEl.classList.contains('show'));
                uiState.fullscreen = _fullscreenActive;
                uiState.splitPanelActive = _splitPanelActive;
                uiState.activeToolbar = _markupModeActive ? 'markup' : null;
            }
        }

        function _setActiveTab(tab) {
            if (uiState) {
                uiState.activeTab = tab;
            }
            _emit('onTabSwitched', { tab: tab });
        }

        // -----------------------------------------------------------------
        // Fullscreen
        // -----------------------------------------------------------------

        function updatePreviewFullscreenUi(active) {
            var previousState = _fullscreenActive;
            _fullscreenActive = !!active;
            _syncUiState();

            if (modalEl) {
                modalEl.classList.toggle(FULLSCREEN_CLASS, _fullscreenActive);
            }
            if (fullscreenBtn) {
                var icon = fullscreenBtn.querySelector('i');
                if (icon) {
                    icon.className = 'bi ' + (_fullscreenActive ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN);
                }
            }

            if (previousState !== _fullscreenActive) {
                _emit('onFullscreenChanged', { active: _fullscreenActive });
            }
        }

        async function requestPreviewFullscreen() {
            if (!modalEl) return;
            try {
                if (modalEl.requestFullscreen) {
                    await modalEl.requestFullscreen();
                } else if (modalEl.webkitRequestFullscreen) {
                    await modalEl.webkitRequestFullscreen();
                } else {
                    updatePreviewFullscreenUi(true);
                }

                // Attempt to lock Escape so the browser does not force-exit fullscreen.
                if (navigator.keyboard && navigator.keyboard.lock) {
                    try {
                        await navigator.keyboard.lock(['Escape']);
                    } catch (_e) {
                        // Keyboard lock not critical, ignore
                    }
                }
            } catch (error) {
                console.error('Fullscreen request failed:', error);
                updatePreviewFullscreenUi(true);
            }
        }

        async function exitPreviewFullscreen() {
            // CRITICAL: Don't exit fullscreen if editing annotation
            if (isEditingFn()) {
                return;
            }

            // Unlock keyboard when exiting fullscreen so Escape works normally elsewhere.
            if (navigator.keyboard && navigator.keyboard.unlock) {
                navigator.keyboard.unlock();
            }

            if (document.fullscreenElement === modalEl && document.exitFullscreen) {
                await document.exitFullscreen();
            } else if (document.webkitFullscreenElement === modalEl && document.webkitExitFullscreen) {
                await document.webkitExitFullscreen();
            } else {
                updatePreviewFullscreenUi(false);
            }
        }

        function togglePreviewFullscreen() {
            if (_fullscreenActive) {
                exitPreviewFullscreen();
            } else {
                requestPreviewFullscreen();
            }
        }

        // -----------------------------------------------------------------
        // Split Panel
        // -----------------------------------------------------------------

        function updateSplitPanelUi(active) {
            _splitPanelActive = !!active;
            _syncUiState();

            if (modalEl) {
                modalEl.classList.toggle('split-panel-mode', _splitPanelActive);
            }
            if (splitPanelBtn) {
                splitPanelBtn.classList.toggle('active', _splitPanelActive);
            }

            _emit('onSplitPanelToggled', { active: _splitPanelActive });
        }

        function toggleSplitPanel() {
            // Split panel works in both reduced and fullscreen modes
            // (gate lifted 2026-05-17 server-path follow-up — see CSS rule
            // `#pdfPreviewModal.split-panel-mode:not(.preview-fullscreen)`
            // which sizes the reduced-mode panel widths so the 3-column
            // layout fits inside the modal-xl dialog).
            updateSplitPanelUi(!_splitPanelActive);
        }

        function updateSplitPanelButtonVisibility() {
            if (!splitPanelBtn) return;
            // Split-panel toggle is now always visible (formerly fullscreen-only).
            // The reduced-mode split layout sizes panels at 280px each so the
            // 3-column view fits inside the modal-xl dialog.
            splitPanelBtn.classList.remove('d-none');
        }

        // -----------------------------------------------------------------
        // Markup Mode Toggle
        // -----------------------------------------------------------------

        function toggleMarkupMode() {
            _markupModeActive = !_markupModeActive;
            _syncUiState();

            var toggleBtn = modalEl ? modalEl.querySelector('.js-toggle-markup') : null;
            if (toggleBtn) toggleBtn.classList.toggle('active', _markupModeActive);

            if (DrawingCanvas) DrawingCanvas.setMarkupMode(_markupModeActive);

            if (MarkupToolbar) {
                if (_markupModeActive) {
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

            _emit('onToolbarToggled', { active: _markupModeActive });
        }

        // -----------------------------------------------------------------
        // Document fullscreenchange listeners
        // -----------------------------------------------------------------

        function _handleFullscreenChange() {
            var isActive = getFullscreenElement() === modalEl;

            if (!isActive && isEditingFn()) {
                // Browser forced us out of real fullscreen; keep pseudo-fullscreen
                // styling so layout stays stable.
                _forcedExitDuringEdit = true;
                updatePreviewFullscreenUi(true);
                if (navigator.keyboard && navigator.keyboard.unlock) {
                    navigator.keyboard.unlock();
                }
                return; // Early return — we already emitted via updatePreviewFullscreenUi
            }

            if (isActive) {
                _forcedExitDuringEdit = false;
            }

            updatePreviewFullscreenUi(isActive);

            // Emit resize needed so the monolith can re-render viewers
            _emit('onResizeNeeded', { source: 'fullscreenchange' });

            // Emit search highlight needed so monolith can repaint search overlays
            _emit('onSearchHighlightNeeded', { source: 'fullscreenchange' });
        }

        // -----------------------------------------------------------------
        // Resize handler (debounced)
        // -----------------------------------------------------------------
        var _resizeDebounceTimer = null;

        function _handleResize() {
            if (!modalEl || !modalEl.classList.contains('show')) return;

            clearTimeout(_resizeDebounceTimer);
            _resizeDebounceTimer = setTimeout(function () {
                _emit('onResizeNeeded', { source: 'resize' });
            }, 100);
        }

        // -----------------------------------------------------------------
        // Modal show/hide/hidden handlers
        // -----------------------------------------------------------------

        function _handleModalHide() {
            if (_fullscreenActive) {
                var fsEl = getFullscreenElement();
                if (fsEl === modalEl) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                }
                updatePreviewFullscreenUi(false);
            }
        }

        function _handleModalHidden() {
            window.removeEventListener('resize', _handleResize);
            if (uiState) {
                uiState.visible = false;
            }

            // Notify monolith to stop polling
            _emit('onClose', {});

            // Cleanup markup state
            if (DrawingCanvas) DrawingCanvas.destroy();
            if (TextboxModule) TextboxModule.destroy();
            if (MarkupToolbar) MarkupToolbar.destroy();
            if (MarkupSelection) MarkupSelection.destroy();
            _markupModeActive = false;
            _syncUiState();
            var markupToggleBtn = modalEl ? modalEl.querySelector('.js-toggle-markup') : null;
            if (markupToggleBtn) markupToggleBtn.classList.remove('active');
        }

        function _handleModalShow() {
            window.removeEventListener('resize', _handleResize); // Prevent duplicates
            window.addEventListener('resize', _handleResize);
            if (uiState) {
                uiState.visible = true;
            }

            if (DrawingCanvas && typeof DrawingCanvas.init === 'function') {
                DrawingCanvas.init();
            }
            if (MarkupSelection && typeof MarkupSelection.init === 'function') {
                MarkupSelection.init();
            }

            // Initialize markup toolbar
            if (MarkupToolbar && !document.querySelector('.markup-toolbar')) {
                var toolbarContainer = modalEl || document.body;
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
            var toolbarEl = modalEl ? modalEl.querySelector('.markup-toolbar') : document.querySelector('.markup-toolbar');
            if (!toolbarEl) toolbarEl = document.querySelector('.markup-toolbar');
            if (toolbarEl && !toolbarEl.dataset.markupClickBound) {
                toolbarEl.dataset.markupClickBound = 'true';
                var _toolbarClickHandler = function (e) {
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
                };
                _addListener(toolbarEl, 'click', _toolbarClickHandler);
            }
        }

        // -----------------------------------------------------------------
        // Fullscreenchange listener for split panel button visibility
        // -----------------------------------------------------------------
        function _handleFullscreenChangeForSplitPanel() {
            setTimeout(updateSplitPanelButtonVisibility, SPLIT_PANEL_VISIBILITY_DELAY);
        }

        // -----------------------------------------------------------------
        // Graded tab shown handler (refresh split panel)
        // -----------------------------------------------------------------
        function _handleGradedTabShown() {
            _setActiveTab('graded');
            if (_splitPanelActive) {
                _emit('onSplitPanelToggled', { active: true });
            }
        }

        function _handleOriginalTabShown() {
            _setActiveTab('original');
        }

        // -----------------------------------------------------------------
        // Markup toggle click handler (delegated)
        // -----------------------------------------------------------------
        function _handleMarkupToggleClick(e) {
            if (e.target.closest('.js-toggle-markup')) {
                toggleMarkupMode();
            }
        }

        // -----------------------------------------------------------------
        // Attach all listeners
        // -----------------------------------------------------------------
        _addListener(fullscreenBtn, 'click', togglePreviewFullscreen);
        _addListener(splitPanelBtn, 'click', toggleSplitPanel);
        _addListener(document, 'fullscreenchange', _handleFullscreenChange);
        _addListener(document, 'webkitfullscreenchange', _handleFullscreenChange);
        _addListener(document, 'fullscreenchange', _handleFullscreenChangeForSplitPanel);
        _addListener(modalEl, 'click', _handleMarkupToggleClick);

        if (modalEl) {
            _addListener(modalEl, 'hide.bs.modal', _handleModalHide);
            _addListener(modalEl, 'hidden.bs.modal', _handleModalHidden);
            _addListener(modalEl, 'show.bs.modal', _handleModalShow);
        }

        var gradedTabEl = document.getElementById('pdfGradedTab');
        if (gradedTabEl) {
            _addListener(gradedTabEl, 'shown.bs.tab', _handleGradedTabShown);
        }
        var originalTabEl = document.getElementById('pdfOriginalTab');
        if (originalTabEl) {
            _addListener(originalTabEl, 'shown.bs.tab', _handleOriginalTabShown);
        }

        // If already visible, add resize listener
        if (modalEl && modalEl.classList.contains('show')) {
            window.addEventListener('resize', _handleResize);
        }

        // -----------------------------------------------------------------
        // Public API
        // -----------------------------------------------------------------
        return {
            // Event registration
            onFullscreenChanged: function (cb) { _callbacks.onFullscreenChanged.push(cb); },
            onSplitPanelToggled: function (cb) { _callbacks.onSplitPanelToggled.push(cb); },
            onToolbarToggled: function (cb) { _callbacks.onToolbarToggled.push(cb); },
            onTabSwitched: function (cb) { _callbacks.onTabSwitched.push(cb); },
            onClose: function (cb) { _callbacks.onClose.push(cb); },
            onResizeNeeded: function (cb) { _callbacks.onResizeNeeded.push(cb); },
            onSearchHighlightNeeded: function (cb) { _callbacks.onSearchHighlightNeeded.push(cb); },

            // Fullscreen
            setFullscreen: function (active) { updatePreviewFullscreenUi(active); },
            isFullscreen: function () { return _fullscreenActive; },
            requestFullscreen: requestPreviewFullscreen,
            exitFullscreen: exitPreviewFullscreen,
            toggleFullscreen: togglePreviewFullscreen,

            // Split panel
            isSplitPanel: function () { return _splitPanelActive; },
            setSplitPanel: function (active) { updateSplitPanelUi(active); },
            toggleSplitPanel: toggleSplitPanel,
            updateSplitPanelButtonVisibility: updateSplitPanelButtonVisibility,

            // Markup
            isMarkupActive: function () { return _markupModeActive; },
            toggleMarkupMode: toggleMarkupMode,

            // Internal state for forced-exit tracking
            isForcedExitDuringEdit: function () { return _forcedExitDuringEdit; },
            clearForcedExitDuringEdit: function () { _forcedExitDuringEdit = false; },

            // Cleanup
            destroy: function () {
                for (var i = 0; i < _listeners.length; i++) {
                    var l = _listeners[i];
                    l.el.removeEventListener(l.event, l.fn, l.opts);
                }
                _listeners = [];
                window.removeEventListener('resize', _handleResize);
                clearTimeout(_resizeDebounceTimer);
                // Teardown markup modules
                if (DrawingCanvas && typeof DrawingCanvas.destroy === 'function') DrawingCanvas.destroy();
                if (TextboxModule && typeof TextboxModule.destroy === 'function') TextboxModule.destroy();
                if (MarkupToolbar && typeof MarkupToolbar.destroy === 'function') MarkupToolbar.destroy();
                if (MarkupSelection && typeof MarkupSelection.destroy === 'function') MarkupSelection.destroy();
                _markupModeActive = false;
            },
        };
    }

    exports.createModalShell = createModalShell;

})(window.PdfPreviewModalShell);
