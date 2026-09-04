/**
 * PDF Preview Modal - Document Controller
 *
 * Owns PDF loading, viewer initialization, page navigation (slider + input),
 * and text search. Emits events for cross-controller concerns (annotations,
 * markup) so the composition root can wire them without coupling.
 *
 * Routes the last direct fetch() for graded PDFs through ModeAdapter.
 *
 * @module pdf-preview-modal/document-controller
 */
window.PdfPreviewModalDocumentController = window.PdfPreviewModalDocumentController || {};

(function (exports) {
    'use strict';

    var UtilsModule = window.PdfPreviewModalUtils || {};
    var _debugLog = UtilsModule.debugLog || function () {};

    function translateText(key, params) {
        var translator = window.i18n && typeof window.i18n.t === 'function'
            ? window.i18n.t.bind(window.i18n)
            : null;
        if (translator) {
            return translator(key, params || {});
        }
        var text = key;
        Object.entries(params || {}).forEach(function (pair) {
            text = text.replace(new RegExp('%\\(' + pair[0] + '\\)s', 'g'), String(pair[1]));
        });
        return text;
    }

    /**
     * Create a document controller.
     *
     * @param {Object} documentState - The state.document slice from modal-state.js
     * @param {Object} options
     * @param {Object|null} options.modeAdapter - ModeAdapter instance
     * @param {string|number|null} options.assignmentId
     * @param {string|number|null} options.submissionId
     * @param {string|number|null} options.courseId
     * @param {string} options.mode - 'server' | 'local' | 'offline'
     * @param {Object} options.capabilities
     * @returns {Object} Document controller handle
     */
    function createDocumentController(documentState, options) {
        options = options || {};

        function _syncDocumentState(patch) {
            if (!documentState || !patch) {
                return;
            }
            Object.keys(patch).forEach(function (key) {
                documentState[key] = patch[key];
            });
        }

        // -----------------------------------------------------------------
        // Event system
        // -----------------------------------------------------------------
        var _callbacks = {
            onPageChanged: [],
            onDocumentLoaded: [],
            onViewerReady: [],
            onSearchHighlightsChanged: [],
            onPageRendered: [],
            onSliderSync: [],
            onResizeComplete: [],
        };

        function _emit(name, data) {
            if (_destroyed) return;
            var cbs = _callbacks[name] || [];
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](data); } catch (e) { console.error('[document-controller] callback error:', e); }
            }
        }

        // -----------------------------------------------------------------
        // Private runtime state
        // -----------------------------------------------------------------
        var _blobUrls = [];
        var _searchState = {
            term: '',
            matches: [],
            currentIndex: -1,
            pageTextCache: new Map(),
            searching: false,
        };
        var _searchMeasureCtx = null;
        var _destroyed = false;
        var _originalPdfLoadPromise = null;
        var _gradedPdfLoadPromise = null;
        var _fullscreenResizeTimer = null;

        // Handler references for cleanup (bound elements persist across modal opens)
        var _boundHandlers = {
            sliderInput: null,
            pageInputKeydown: null,
            pageInputInput: null,
            pageInputChange: null,
            pageInputBlur: null,
            searchGoClick: null,
            searchPrevClick: null,
            searchNextClick: null,
            searchInputKeydown: null,
        };

        // -----------------------------------------------------------------
        // CSRF helper (delegates to utils module)
        // -----------------------------------------------------------------

        function withCsrf(headers) {
            if (UtilsModule.withCsrf) {
                return UtilsModule.withCsrf(headers || {});
            }
            var csrfElement = document.querySelector('meta[name="csrf-token"]');
            var token = csrfElement ? csrfElement.content : null;
            if (token) {
                var merged = {};
                var keys = Object.keys(headers || {});
                for (var i = 0; i < keys.length; i++) {
                    merged[keys[i]] = (headers || {})[keys[i]];
                }
                merged['X-CSRFToken'] = token;
                return merged;
            }
            return headers || {};
        }

        // -----------------------------------------------------------------
        // Viewer initialization
        // -----------------------------------------------------------------

        function ensureModalViewers() {
            var ViewerModule = window.PdfPreviewModalViewer;
            if (!ViewerModule || !ViewerModule.PDFViewer) {
                console.error('[document-controller] PDFViewer module not loaded.');
                return false;
            }

            var ViewerClass = ViewerModule.PDFViewer;
            var resolvePdfjsLib = ViewerModule.resolvePdfjsLib;

            var lib = resolvePdfjsLib();
            if (!lib) {
                return false;
            }

            if (!window.__pdfOriginalViewer) {
                window.__pdfOriginalViewer = new ViewerClass(
                    'pdfOriginalCanvas', 'pdfOriginalContainer',
                    'pdfOriginalLoading', 'pdfOriginalControls'
                );
            }

            if (!window.__pdfGradedViewer) {
                window.__pdfGradedViewer = new ViewerClass(
                    'pdfGradedCanvas', 'pdfGradedContainer',
                    'pdfGradedLoading', 'pdfGradedControls'
                );
            }

            // Always re-wire viewer callbacks to THIS controller instance.
            // onPageRendered / onAnnotationsPageChange / onSliderSync are REPLACE
            // operations on the viewer (not accumulate), so each new controller
            // correctly takes over without stacking listeners.
            window.__pdfGradedViewer.onAnnotationsPageChange(function (pageIdx) {
                _syncDocumentState({
                    currentPage: pageIdx,
                    pageCount: window.__pdfGradedViewer && window.__pdfGradedViewer.pdf
                        ? window.__pdfGradedViewer.pdf.numPages
                        : (documentState && documentState.pageCount) || 0,
                });
                if (!_destroyed) _emit('onPageChanged', pageIdx);
            });
            window.__pdfGradedViewer.onPageRendered(function (pageNum) {
                _syncDocumentState({
                    currentPage: Math.max(0, (pageNum || 1) - 1),
                    pageCount: window.__pdfGradedViewer && window.__pdfGradedViewer.pdf
                        ? window.__pdfGradedViewer.pdf.numPages
                        : (documentState && documentState.pageCount) || 0,
                });
                if (!_destroyed) _emit('onPageRendered', pageNum);
            });
            window.__pdfGradedViewer.onSliderSync(function (viewer) {
                if (!_destroyed) {
                    syncGradedPageSlider(viewer);
                    _emit('onSliderSync', viewer);
                }
            });

            return true;
        }

        // -----------------------------------------------------------------
        // Resize handling
        // -----------------------------------------------------------------

        function handleFullscreenResize() {
            var redrawAll = function () {
                if (_destroyed) return Promise.resolve();

                if (typeof options.isDrawingFn === 'function' && options.isDrawingFn()) {
                    _fullscreenResizeTimer = setTimeout(redrawAll, 50);
                    return Promise.resolve();
                }

                _fullscreenResizeTimer = null;

                var gradedViewer = window.__pdfGradedViewer;
                var originalViewer = window.__pdfOriginalViewer;
                var promises = [];

                if (gradedViewer && gradedViewer.pdf) {
                    var p = gradedViewer.reRenderAllPages(false).then(function () {
                        // Emit so annotations + markup can re-render
                        _emit('onResizeComplete', { viewer: 'graded' });
                    });
                    promises.push(p);
                }
                if (originalViewer && originalViewer.pdf) {
                    originalViewer.renderPage(originalViewer.currentPage || 1);
                }

                // Re-highlight search if active
                if (_searchState.matches.length > 0 && _searchState.currentIndex >= 0) {
                    setTimeout(function () {
                        if (_destroyed) return;
                        highlightSearchMatch(_searchState.matches[_searchState.currentIndex]);
                    }, 100);
                }

                return Promise.all(promises);
            };

            // Wait for transition to complete then re-render
            clearTimeout(_fullscreenResizeTimer);
            _fullscreenResizeTimer = setTimeout(redrawAll, 400);
        }

        // -----------------------------------------------------------------
        // PDF loading — original
        // -----------------------------------------------------------------

        /**
         * Load the original (un-annotated) PDF into __pdfOriginalViewer.
         *
         * @param {string|number} assignmentId
         * @param {string|number} submissionId
         * @returns {Promise<void>}
         */
        function loadOriginalPdf(assignmentId, submissionId) {
            if (!window.__pdfOriginalViewer) {
                return Promise.resolve();
            }
            if (!_originalPdfLoadPromise) {
                var mode = options.mode || '';
                var adapter = options.modeAdapter;
                var originalSourcePromise;

                if (adapter && typeof adapter.fetchOriginalPdf === 'function') {
                    originalSourcePromise = adapter.fetchOriginalPdf(assignmentId, submissionId).then(function (blob) {
                        if (_destroyed || !blob) {
                            return null;
                        }
                        var url = URL.createObjectURL(blob);
                        _blobUrls.push(url);
                        return url;
                    });
                } else {
                    var url = (mode === 'offline')
                        ? '/offline/assessments/' + assignmentId + '/submissions/' + submissionId + '/pdf'
                        : '/api/canvas/submissions/' + submissionId + '/pdf' + (assignmentId ? '?assignment_id=' + assignmentId : '');
                    originalSourcePromise = Promise.resolve(url);
                }

                _originalPdfLoadPromise = originalSourcePromise.then(function (pdfSource) {
                    if (_destroyed || !pdfSource) {
                        return null;
                    }
                    return window.__pdfOriginalViewer.loadPDF(pdfSource).then(function () {
                        _syncDocumentState({
                            originalPdfLoaded: true,
                            pageCount: window.__pdfOriginalViewer && window.__pdfOriginalViewer.pdf
                                ? window.__pdfOriginalViewer.pdf.numPages
                                : (documentState && documentState.pageCount) || 0,
                        });
                        _emit('onDocumentLoaded', 'original');
                        _emit('onViewerReady', 'original');
                    });
                }).catch(function (error) {
                    _originalPdfLoadPromise = null;
                    throw error;
                });
            }
            return _originalPdfLoadPromise;
        }

        // -----------------------------------------------------------------
        // PDF loading — graded
        // -----------------------------------------------------------------

        /**
         * Load the graded (annotated) PDF. Routes through ModeAdapter first,
         * then falls back to a direct fetch with CSRF. Creates a blob URL
         * tracked in _blobUrls for cleanup.
         *
         * @param {string|number} assignmentId
         * @param {string|number} submissionId
         * @returns {Promise<{blob: Blob, url: string}|null>} null when no graded PDF
         */
        function loadGradedPdf(assignmentId, submissionId) {
            if (_gradedPdfLoadPromise) {
                return _gradedPdfLoadPromise;
            }

            var mode = options.mode || '';
            var adapter = options.modeAdapter;
            var gradedBlobPromise;

            if (adapter && typeof adapter.fetchAnnotatedPdf === 'function') {
                gradedBlobPromise = adapter.fetchAnnotatedPdf(assignmentId, submissionId, {
                    courseId: options.courseId || null,
                    offline: mode === 'offline',
                    annotatedPdfPolicy: options.annotatedPdfPolicy || 'server_allowed',
                });
            } else {
                var gradedPdfUrl = (mode === 'offline')
                    ? '/offline/api/assessments/' + assignmentId + '/submissions/' + submissionId + '/pdf-graded'
                    : '/api/canvas/submissions/' + submissionId + '/pdf-graded' + (assignmentId ? '?assignment_id=' + assignmentId : '');
                gradedBlobPromise = fetch(gradedPdfUrl, {
                    headers: withCsrf(),
                    credentials: 'same-origin'
                }).then(function (response) {
                    if (_destroyed) return null;
                    if (response.ok) {
                        return response.blob();
                    }
                    return null;
                });
            }

            _gradedPdfLoadPromise = gradedBlobPromise.then(function (blob) {
                if (_destroyed || !blob) {
                    return null;
                }

                // Track blob URL for cleanup
                var url = URL.createObjectURL(blob);
                _blobUrls.push(url);

                _emit('onDocumentLoaded', 'graded');

                // Load into viewer if available
                var loadPromise;
                if (window.__pdfGradedViewer) {
                    loadPromise = window.__pdfGradedViewer.loadPDF(url).then(function () {
                        _syncDocumentState({
                            gradedPdfLoaded: true,
                            currentPage: Math.max(0, (window.__pdfGradedViewer.currentPage || 1) - 1),
                            pageCount: window.__pdfGradedViewer.pdf ? window.__pdfGradedViewer.pdf.numPages : 0,
                        });
                        _emit('onViewerReady', 'graded');
                        // Check if PDF has searchable text
                        return checkPdfSearchable();
                    });
                } else {
                    loadPromise = Promise.resolve();
                }

                return loadPromise.then(function () {
                    return { blob: blob, url: url };
                });
            }).catch(function (error) {
                _gradedPdfLoadPromise = null;
                throw error;
            });

            return _gradedPdfLoadPromise;
        }

        // -----------------------------------------------------------------
        // Page navigation
        // -----------------------------------------------------------------

        /**
         * Navigate to a specific page in the graded PDF viewer.
         *
         * @param {number} n - Page number (1-based)
         */
        function goToPage(n) {
            if (window.__pdfGradedViewer) {
                _syncDocumentState({ currentPage: Math.max(0, (n || 1) - 1) });
                window.__pdfGradedViewer.renderPage(n);
            }
        }

        // -----------------------------------------------------------------
        // Tab switching
        // -----------------------------------------------------------------

        /**
         * Switch between original and graded tabs.
         *
         * @param {string} tab - 'original' or 'graded'
         */
        function activateTab(tab) {
            var originalTab = document.getElementById('pdfOriginalTab');
            var gradedTab = document.getElementById('pdfGradedTab');
            var originalPane = document.getElementById('pdfOriginalPane');
            var gradedPane = document.getElementById('pdfGradedPane');

            if (!originalTab || !gradedTab || !originalPane || !gradedPane) {
                return;
            }

            if (tab === 'graded') {
                originalTab.classList.remove('active');
                gradedTab.classList.add('active');
                originalPane.classList.remove('show', 'active');
                gradedPane.classList.add('show', 'active');
            } else if (tab === 'original') {
                gradedTab.classList.remove('active');
                originalTab.classList.add('active');
                gradedPane.classList.remove('show', 'active');
                originalPane.classList.add('show', 'active');
            }
        }

        // -----------------------------------------------------------------
        // Page slider
        // -----------------------------------------------------------------

        function syncGradedPageSlider(viewer) {
            var slider = document.getElementById('pdfGradedPageSlider');
            var label = document.getElementById('pdfGradedPageSliderLabel');
            if (!slider || !viewer) return;
            var totalPages = viewer.pdf ? viewer.pdf.numPages : 1;
            slider.max = totalPages;
            slider.value = viewer.currentPage || 1;
            if (label) {
                label.textContent = translateText('Page %(page)s', { page: viewer.currentPage || 1 });
            }
        }

        function bindGradedPageSlider() {
            var slider = document.getElementById('pdfGradedPageSlider');
            if (slider && !slider.dataset.bound) {
                slider.dataset.bound = 'true';
                _boundHandlers.sliderInput = function (e) {
                    var targetPage = parseInt(e.target.value, 10) || 1;
                    if (window.__pdfGradedViewer) {
                        window.__pdfGradedViewer.renderPage(targetPage);
                    }
                };
                slider.addEventListener('input', _boundHandlers.sliderInput);
            }
        }

        function bindGradedPageInput() {
            var pageInput = document.getElementById('pdfGradedPageInput');
            if (pageInput && !pageInput.dataset.bound) {
                pageInput.dataset.bound = 'true';

                function navigateFromPageInput(updateValue) {
                    var targetPage = parseInt(pageInput.value, 10) || 1;
                    if (window.__pdfGradedViewer) {
                        var maxPage = (window.__pdfGradedViewer.pdf && window.__pdfGradedViewer.pdf.numPages) || 1;
                        var clampedPage = Math.max(1, Math.min(targetPage, maxPage));
                        if (updateValue) {
                            pageInput.value = clampedPage;
                        }
                        window.__pdfGradedViewer.renderPage(clampedPage);
                    }
                }

                _boundHandlers.pageInputKeydown = function (e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        navigateFromPageInput(true);
                    }
                };
                pageInput.addEventListener('keydown', _boundHandlers.pageInputKeydown);

                _boundHandlers.pageInputInput = function () {
                    navigateFromPageInput(false);
                };
                pageInput.addEventListener('input', _boundHandlers.pageInputInput);

                _boundHandlers.pageInputChange = function () {
                    navigateFromPageInput(true);
                };
                pageInput.addEventListener('change', _boundHandlers.pageInputChange);

                _boundHandlers.pageInputBlur = function () {
                    navigateFromPageInput(true);
                };
                pageInput.addEventListener('blur', _boundHandlers.pageInputBlur);
            }
        }

        // -----------------------------------------------------------------
        // Search — measuring context
        // -----------------------------------------------------------------

        function getSearchMeasureContext() {
            if (!_searchMeasureCtx) {
                _searchMeasureCtx = document.createElement('canvas').getContext('2d');
            }
            if (_searchMeasureCtx) {
                _searchMeasureCtx.font = '100px "Times New Roman", serif';
            }
            return _searchMeasureCtx;
        }

        // -----------------------------------------------------------------
        // Search — page text retrieval
        // -----------------------------------------------------------------

        function getPdfPageText(pageNum) {
            if (_searchState.pageTextCache.has(pageNum)) {
                return Promise.resolve(_searchState.pageTextCache.get(pageNum));
            }
            var pdf = window.__pdfGradedViewer && window.__pdfGradedViewer.pdf;
            if (!pdf) {
                return Promise.resolve('');
            }
            return pdf.getPage(pageNum).then(function (page) {
                return page.getTextContent();
            }).then(function (textContent) {
                var text = textContent.items.map(function (item) { return item.str; }).join(' ');
                var normalized = text.toLowerCase();
                _searchState.pageTextCache.set(pageNum, normalized);
                return normalized;
            });
        }

        // -----------------------------------------------------------------
        // Search — check if PDF has searchable text
        // -----------------------------------------------------------------

        function checkPdfSearchable() {
            var searchWrapper = document.getElementById('pdfSearchWrapper');
            if (!searchWrapper) return Promise.resolve();

            var pdf = window.__pdfGradedViewer && window.__pdfGradedViewer.pdf;
            if (!pdf) {
                searchWrapper.classList.add('d-none');
                searchWrapper.classList.remove('d-flex');
                return Promise.resolve();
            }

            // Skip page 1 (cover page with typed boilerplate) — check content pages
            var startPage = Math.min(2, pdf.numPages);
            var endPage = Math.min(startPage + 2, pdf.numPages);
            var hasText = false;

            function checkPage(pageNum) {
                if (pageNum > endPage) {
                    if (hasText) {
                        searchWrapper.classList.remove('d-none');
                        searchWrapper.classList.add('d-flex');
                        updateSearchStatus('');
                    } else {
                        searchWrapper.classList.add('d-none');
                        searchWrapper.classList.remove('d-flex');
                    }
                    return Promise.resolve();
                }
                return pdf.getPage(pageNum).then(function (page) {
                    return page.getTextContent();
                }).then(function (textContent) {
                    var text = textContent.items.map(function (item) { return item.str; }).join('').trim();
                    if (text.length > 10) {
                        hasText = true;
                        // Short-circuit
                        searchWrapper.classList.remove('d-none');
                        searchWrapper.classList.add('d-flex');
                        updateSearchStatus('');
                        return;
                    }
                    return checkPage(pageNum + 1);
                }).catch(function (error) {
                    console.warn('[SEARCH] Error checking page ' + pageNum + ' for text:', error);
                    return checkPage(pageNum + 1);
                });
            }

            return checkPage(startPage);
        }

        // -----------------------------------------------------------------
        // Search — status display
        // -----------------------------------------------------------------

        function updateSearchStatus(message) {
            var statusEl = document.getElementById('pdfSearchStatus');
            if (!statusEl) return;
            if (message) {
                statusEl.textContent = message;
                return;
            }
            if (!_searchState.matches.length || _searchState.currentIndex < 0) {
                statusEl.textContent = '';
                return;
            }
            var match = _searchState.matches[_searchState.currentIndex];
            statusEl.textContent = 'Match ' + (_searchState.currentIndex + 1) + '/' + _searchState.matches.length + ' on page ' + match.page;
        }

        // -----------------------------------------------------------------
        // Search — navigate to match
        // -----------------------------------------------------------------

        function goToSearchMatch(matchIndex) {
            var match = _searchState.matches[matchIndex];
            if (!match) {
                updateSearchStatus('No matches');
                return Promise.resolve();
            }
            var wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector('.pdf-page-wrapper[data-page-num="' + match.page + '"]');
            if (wrapper) {
                wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return new Promise(function (resolve) {
                setTimeout(function () {
                    highlightSearchMatch(match);
                    _searchState.currentIndex = matchIndex;
                    updateSearchStatus();
                    resolve();
                }, 150);
            });
        }

        // -----------------------------------------------------------------
        // Search — build matches
        // -----------------------------------------------------------------

        function buildPdfSearchMatches(term) {
            var pdf = window.__pdfGradedViewer && window.__pdfGradedViewer.pdf;
            if (!pdf) {
                updateSearchStatus('Load graded PDF first');
                return Promise.resolve();
            }
            var normalizedTerm = term.trim().toLowerCase();
            if (!normalizedTerm) {
                _searchState.matches = [];
                _searchState.currentIndex = -1;
                updateSearchStatus('Enter a search term');
                return Promise.resolve();
            }
            _searchState.term = normalizedTerm;
            _searchState.matches = [];
            _searchState.currentIndex = -1;
            updateSearchStatus('Searching\u2026');

            var totalPages = pdf.numPages;

            function processPage(pageNum) {
                if (pageNum > totalPages) {
                    if (!_searchState.matches.length) {
                        updateSearchStatus('No matches');
                        return Promise.resolve();
                    }
                    return goToSearchMatch(0);
                }
                return getPdfPageText(pageNum).then(function (text) {
                    if (!text) return processPage(pageNum + 1);
                    var offset = text.indexOf(normalizedTerm);
                    while (offset !== -1) {
                        var preview = text.substring(
                            Math.max(0, offset - 40),
                            Math.min(text.length, offset + normalizedTerm.length + 60)
                        ).trim();
                        _searchState.matches.push({
                            page: pageNum,
                            offset: offset,
                            preview: preview,
                        });
                        offset = text.indexOf(normalizedTerm, offset + normalizedTerm.length);
                    }
                    return processPage(pageNum + 1);
                });
            }

            return processPage(1);
        }

        // -----------------------------------------------------------------
        // Search — highlight management
        // -----------------------------------------------------------------

        function clearSearchHighlights() {
            var overlays = document.querySelectorAll('.pdf-search-overlay');
            overlays.forEach(function (overlay) {
                overlay.textContent = '';
            });
        }

        function syncSearchOverlayGeometry() {
            // No longer needed for continuous scroll (each overlay sized by CSS).
            // Kept for backward compatibility.
        }

        function highlightSearchMatch(match, _retries) {
            if (_destroyed) return Promise.resolve();

            var viewer = window.__pdfGradedViewer;
            if (!viewer || !viewer.pdf) return Promise.resolve();

            var wrapper = (document.getElementById('pdfGradedContainer') || document).querySelector('.pdf-page-wrapper[data-page-num="' + match.page + '"]');
            if (!wrapper) return Promise.resolve();

            var canvas = wrapper.querySelector('.pdf-page-canvas');
            var overlay = wrapper.querySelector('.pdf-search-overlay');
            if (!canvas || !overlay) return Promise.resolve();

            var retryCount = _retries || 0;
            var viewport = viewer.getViewportForPage(match.page);
            if (!viewport) {
                // If viewport not yet available, wait for page to render (max 20 retries = ~2 s)
                if (retryCount >= 20) return Promise.resolve();
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        if (_destroyed) { resolve(); return; }
                        highlightSearchMatch(match, retryCount + 1).then(resolve);
                    }, 100);
                });
            }

            return viewer.pdf.getPage(match.page).then(function (page) {
                return page.getTextContent();
            }).then(function (textContent) {
                clearSearchHighlights();

                var canvasRect = canvas.getBoundingClientRect();
                var scaleX = canvasRect.width / viewport.width;
                var scaleY = canvasRect.height / viewport.height;

                var measureCtx = getSearchMeasureContext();
                if (!measureCtx) return;

                var currentIdx = 0;
                var targetStart = match.offset;
                var targetEnd = match.offset + _searchState.term.length;
                var firstHighlightEl = null;

                textContent.items.forEach(function (item) {
                    var itemStr = item.str;
                    var itemStart = currentIdx;
                    var itemEnd = currentIdx + itemStr.length;

                    if (itemEnd > targetStart && itemStart < targetEnd) {
                        var localStart = Math.max(0, targetStart - itemStart);
                        var localEnd = Math.min(itemStr.length, targetEnd - itemStart);

                        var fullWidth = measureCtx.measureText(itemStr).width || 1;
                        var prefixWidth = measureCtx.measureText(itemStr.substring(0, localStart)).width;
                        var matchWidth = measureCtx.measureText(itemStr.substring(localStart, localEnd)).width;

                        var startRatio = prefixWidth / fullWidth;
                        var widthRatio = matchWidth / fullWidth;

                        var tx = item.transform;
                        var itemWidth = item.width;
                        var itemHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[0]);

                        var pdfX = tx[4] + (itemWidth * startRatio);
                        var pdfY = tx[5];
                        var pdfW = (itemWidth * widthRatio);
                        var pdfH = itemHeight;

                        var rect = [pdfX, pdfY, pdfX + pdfW, pdfY + pdfH];
                        var viewRect = viewport.convertToViewportRectangle(rect);

                        var rawX = Math.min(viewRect[0], viewRect[2]);
                        var rawY = Math.min(viewRect[1], viewRect[3]);
                        var rawW = Math.abs(viewRect[0] - viewRect[2]);
                        var rawH = Math.abs(viewRect[1] - viewRect[3]);

                        var finalX = rawX * scaleX;
                        var finalY = rawY * scaleY;
                        var finalW = rawW * scaleX;
                        var finalH = rawH * scaleY;

                        var div = document.createElement('div');
                        div.className = 'search-highlight';

                        var padY = finalH * 0.2;
                        var padX = 4 * scaleX;
                        var verticalNudge = finalH * 0.1;

                        div.style.left = (finalX - padX) + 'px';
                        div.style.top = (finalY - padY + verticalNudge) + 'px';
                        div.style.width = (finalW + (padX * 2)) + 'px';
                        div.style.height = (finalH + (padY * 2)) + 'px';
                        overlay.appendChild(div);

                        if (!firstHighlightEl) firstHighlightEl = div;
                    }
                    currentIdx += itemStr.length + 1;
                });

                if (firstHighlightEl) {
                    firstHighlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }

                // Emit search highlights changed event
                _emit('onSearchHighlightsChanged', {
                    match: match,
                    term: _searchState.term,
                    totalMatches: _searchState.matches.length,
                    currentIndex: _searchState.currentIndex,
                });
            });
        }

        // -----------------------------------------------------------------
        // Search — navigation (go / next / prev)
        // -----------------------------------------------------------------

        function handleSearchNavigation(action) {
            var input = document.getElementById('pdfSearchInput');
            if (!input) return Promise.resolve();
            var term = input.value.trim();
            if (!term) {
                _searchState.matches = [];
                _searchState.currentIndex = -1;
                updateSearchStatus('Enter a search term');
                return Promise.resolve();
            }

            var normalized = term.toLowerCase();
            if (action === 'go' || normalized !== _searchState.term) {
                return buildPdfSearchMatches(term);
            }

            if (!_searchState.matches.length) {
                updateSearchStatus('No matches');
                return Promise.resolve();
            }

            if (action === 'next') {
                var nextIndex = (_searchState.currentIndex + 1) % _searchState.matches.length;
                return goToSearchMatch(nextIndex);
            } else if (action === 'prev') {
                var prevIndex = (_searchState.currentIndex - 1 + _searchState.matches.length) % _searchState.matches.length;
                return goToSearchMatch(prevIndex);
            }
            return Promise.resolve();
        }

        // -----------------------------------------------------------------
        // Search — control binding
        // -----------------------------------------------------------------

        function bindPdfSearchControls() {
            var goBtn = document.getElementById('pdfSearchGo');
            if (goBtn && !goBtn.dataset.bound) {
                goBtn.dataset.bound = 'true';
                _boundHandlers.searchGoClick = function () { handleSearchNavigation('go'); };
                goBtn.addEventListener('click', _boundHandlers.searchGoClick);
            }
            var prevBtn = document.getElementById('pdfSearchPrev');
            if (prevBtn && !prevBtn.dataset.bound) {
                prevBtn.dataset.bound = 'true';
                _boundHandlers.searchPrevClick = function () { handleSearchNavigation('prev'); };
                prevBtn.addEventListener('click', _boundHandlers.searchPrevClick);
            }
            var nextBtn = document.getElementById('pdfSearchNext');
            if (nextBtn && !nextBtn.dataset.bound) {
                nextBtn.dataset.bound = 'true';
                _boundHandlers.searchNextClick = function () { handleSearchNavigation('next'); };
                nextBtn.addEventListener('click', _boundHandlers.searchNextClick);
            }
            var input = document.getElementById('pdfSearchInput');
            if (input && !input.dataset.bound) {
                input.dataset.bound = 'true';
                _boundHandlers.searchInputKeydown = function (event) {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        handleSearchNavigation('go');
                    }
                };
                input.addEventListener('keydown', _boundHandlers.searchInputKeydown);
            }
        }

        // -----------------------------------------------------------------
        // Search state reset
        // -----------------------------------------------------------------

        function resetSearchState() {
            var searchInput = document.getElementById('pdfSearchInput');
            if (searchInput) {
                searchInput.value = '';
            }
            _searchState.pageTextCache.clear();
            _searchState.matches = [];
            _searchState.currentIndex = -1;
            _searchState.term = '';
            updateSearchStatus('');
        }

        // -----------------------------------------------------------------
        // Init bindings on creation
        // -----------------------------------------------------------------
        bindPdfSearchControls();
        bindGradedPageSlider();
        bindGradedPageInput();

        // -----------------------------------------------------------------
        // Public API
        // -----------------------------------------------------------------
        return {
            // Event registration
            onPageChanged: function (cb) { _callbacks.onPageChanged.push(cb); },
            onDocumentLoaded: function (cb) { _callbacks.onDocumentLoaded.push(cb); },
            onViewerReady: function (cb) { _callbacks.onViewerReady.push(cb); },
            onSearchHighlightsChanged: function (cb) { _callbacks.onSearchHighlightsChanged.push(cb); },
            onPageRendered: function (cb) { _callbacks.onPageRendered.push(cb); },
            onSliderSync: function (cb) { _callbacks.onSliderSync.push(cb); },
            onResizeComplete: function (cb) { _callbacks.onResizeComplete.push(cb); },

            // Viewer init
            ensureViewers: function () { return ensureModalViewers(); },

            // PDF loading
            loadOriginalPdf: function (assignmentId, submissionId) {
                return loadOriginalPdf(assignmentId, submissionId);
            },
            loadGradedPdf: function (assignmentId, submissionId) {
                return loadGradedPdf(assignmentId, submissionId);
            },

            // Page navigation
            goToPage: function (n) { goToPage(n); },

            // Tab switching
            activateTab: function (tab) { activateTab(tab); },

            // Resize
            handleResize: function () { return handleFullscreenResize(); },

            // Search
            syncSearchOverlayGeometry: function () { syncSearchOverlayGeometry(); },
            handleSearchAction: function (action) { return handleSearchNavigation(action); },
            getSearchState: function () { return _searchState; },
            checkPdfSearchable: function () { return checkPdfSearchable(); },
            clearSearchHighlights: function () { return clearSearchHighlights(); },
            highlightSearchMatch: function (match) { return highlightSearchMatch(match); },
            resetSearchState: function () { resetSearchState(); },

            // Slider
            syncGradedPageSlider: function (viewer) { syncGradedPageSlider(viewer); },
            bindGradedPageSlider: function () { bindGradedPageSlider(); },
            bindGradedPageInput: function () { bindGradedPageInput(); },

            // Cleanup
            destroy: function () {
                if (_destroyed) return;
                _destroyed = true;
                clearTimeout(_fullscreenResizeTimer);
                _fullscreenResizeTimer = null;
                _blobUrls.forEach(function (url) {
                    try { URL.revokeObjectURL(url); } catch (_e) { /* ignore */ }
                });
                _blobUrls = [];
                _searchState.pageTextCache.clear();
                _searchMeasureCtx = null;
                _syncDocumentState({
                    originalPdfLoaded: false,
                    gradedPdfLoaded: false,
                });

                // Remove stored event listeners and clear bound flags
                var slider = document.getElementById('pdfGradedPageSlider');
                if (slider) {
                    if (_boundHandlers.sliderInput) slider.removeEventListener('input', _boundHandlers.sliderInput);
                    delete slider.dataset.bound;
                }
                var pageInput = document.getElementById('pdfGradedPageInput');
                if (pageInput) {
                    if (_boundHandlers.pageInputKeydown) pageInput.removeEventListener('keydown', _boundHandlers.pageInputKeydown);
                    if (_boundHandlers.pageInputInput) pageInput.removeEventListener('input', _boundHandlers.pageInputInput);
                    if (_boundHandlers.pageInputChange) pageInput.removeEventListener('change', _boundHandlers.pageInputChange);
                    if (_boundHandlers.pageInputBlur) pageInput.removeEventListener('blur', _boundHandlers.pageInputBlur);
                    delete pageInput.dataset.bound;
                }
                var goBtn = document.getElementById('pdfSearchGo');
                if (goBtn) {
                    if (_boundHandlers.searchGoClick) goBtn.removeEventListener('click', _boundHandlers.searchGoClick);
                    delete goBtn.dataset.bound;
                }
                var prevBtn = document.getElementById('pdfSearchPrev');
                if (prevBtn) {
                    if (_boundHandlers.searchPrevClick) prevBtn.removeEventListener('click', _boundHandlers.searchPrevClick);
                    delete prevBtn.dataset.bound;
                }
                var nextBtn = document.getElementById('pdfSearchNext');
                if (nextBtn) {
                    if (_boundHandlers.searchNextClick) nextBtn.removeEventListener('click', _boundHandlers.searchNextClick);
                    delete nextBtn.dataset.bound;
                }
                var searchInput = document.getElementById('pdfSearchInput');
                if (searchInput) {
                    if (_boundHandlers.searchInputKeydown) searchInput.removeEventListener('keydown', _boundHandlers.searchInputKeydown);
                    delete searchInput.dataset.bound;
                }

                // Clear callback arrays to release composition-root closures
                Object.keys(_callbacks).forEach(function (key) { _callbacks[key] = []; });
            },
        };
    }

    exports.createDocumentController = createDocumentController;

})(window.PdfPreviewModalDocumentController);
