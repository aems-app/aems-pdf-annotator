/**
 * PDF Preview Modal - PDFViewer Class
 *
 * Reusable PDF viewer component using PDF.js with support for:
 * - Single-page mode (for step 4 preview)
 * - Continuous scroll mode (for graded PDF modal)
 * - Zoom controls and page navigation
 * - Responsive sizing
 *
 * This module is part of the PDF Preview Modal refactoring (Phase 1).
 *
 * @module pdf-preview-modal/pdf-viewer
 */

// Namespace for PDF Preview Modal PDFViewer
window.PdfPreviewModalViewer = window.PdfPreviewModalViewer || {};

(function (exports) {
    'use strict';

    /**
     * Returned by reRenderAllPages() when its pre-destruction recheck says a
     * rebuild would destroy work in progress. Nothing has been torn down;
     * the caller (requestRebuild) retries.
     */
    var REBUILD_DEFERRED = 'rebuild-deferred';

    /** How often a deferred rebuild retries. */
    var REBUILD_RETRY_MS = 50;

    /**
     * Upper bound on deferral. A predicate that never clears -- a stuck
     * isDrawing flag, say -- must not freeze the pages at the old width for
     * the life of the modal, so past this point the rebuild proceeds anyway.
     */
    var REBUILD_DEFER_DEADLINE_MS = 10000;

    exports.REBUILD_DEFERRED = REBUILD_DEFERRED;
    exports.REBUILD_RETRY_MS = REBUILD_RETRY_MS;
    exports.REBUILD_DEFER_DEADLINE_MS = REBUILD_DEFER_DEADLINE_MS;

    // =========================================================================
    // Dependencies
    // =========================================================================

    // Get utilities from modules or use fallbacks
    const utils = window.PdfPreviewModalUtils || {};
    const debugLog = utils.debugLog || function () { };
    const escapeHtml = utils.escapeHtml || function (text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    };

    // =========================================================================
    // Configuration
    // =========================================================================

    /**
     * Default PDF.js worker source
     * @type {string}
     */
    const DEFAULT_WORKER_SRC = '/static/js/pdf.worker.min.js';

    /**
     * Get PDF.js worker source from config or default
     * @returns {string}
     */
    function getWorkerSrc() {
        return window.PDFPreviewConfig?.pdfjsWorkerSrc || DEFAULT_WORKER_SRC;
    }

    // =========================================================================
    // PDF.js Library Resolution
    // =========================================================================

    /**
     * Resolve and configure PDF.js library
     * @returns {Object|null} PDF.js library or null if not available
     */
    function resolvePdfjsLib() {
        const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
        if (!lib) {
            return null;
        }

        if (!window.pdfjsLib) {
            window.pdfjsLib = lib;
        }

        if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
            lib.GlobalWorkerOptions.workerSrc = getWorkerSrc();
        }

        return lib;
    }

    // Export for use by other modules
    exports.resolvePdfjsLib = resolvePdfjsLib;

    // =========================================================================
    // PDFViewer Class
    // =========================================================================

    /**
     * PDF Viewer component with support for single-page and continuous scroll modes
     */
    class PDFViewer {
        /**
         * Create a new PDFViewer instance
         * @param {string} canvasId - ID of the canvas element
         * @param {string} containerId - ID of the container element
         * @param {string} loadingId - ID of the loading indicator element
         * @param {string} controlsId - ID prefix for control elements
         */
        constructor(canvasId, containerId, loadingId, controlsId) {
            this.canvasId = canvasId;
            this.canvas = document.getElementById(canvasId);
            this.containerId = containerId;
            this.container = document.getElementById(containerId);
            this.loadingEl = document.getElementById(loadingId);
            this.controlsId = controlsId;
            this.pdf = null;
            this.currentPage = 1;
            this.zoom = 1.0;
            this.scale = 1.5; // base scale
            this.isRendering = false;

            // Determine viewing mode: step 4 preview uses single-page, modal uses continuous scroll
            this.useSinglePageMode = (containerId === 'reviewPreviewCanvasWrapper');

            // Continuous scroll specific properties
            this.pageViewports = new Map(); // Map<pageNum, viewport>
            this.renderedPages = new Set(); // Set of page numbers already rendered
            this.renderingPages = new Set(); // Track pages currently being rendered
            this.renderTasks = new Map(); // Map<pageNum, renderTask> to cancel if needed
            this.observer = null;
            this.isGradedViewer = containerId === 'pdfGradedContainer';
            this.lastRenderContainerWidth = null;
            this.zoomVersion = 0; // Incremented on zoom to invalidate stale renders
            this.pendingNavigationPage = null;
            this._pendingNavigationToken = 0;
            this._pendingNavigationTimer = null;
            this.navigationLockUntil = 0;

            // Store viewport for coordinate conversion (single-page mode)
            this.currentViewport = null;
            this.currentPageObj = null;

            // Callbacks for external integration
            this._onPageChange = null;
            this._onAnnotationsPageChange = null;
            this._onPageRendered = null;
            this._onSliderSync = null;

            // Store bound event handler for cleanup
            this._keydownHandler = null;
            this._resizeObserver = null;
            this._resizeDebounceTimer = null;
            this._isDestroyed = false;

            /**
             * Injected predicate: return true while a rebuild would destroy
             * work in progress (a pen stroke being drawn, say). Set by the
             * modal via a setter rather than a constructor argument, because
             * viewer instances outlive individual modal opens. The viewer
             * deliberately knows nothing about what it is deferring for.
             * @type {null|(() => boolean)}
             */
            this.shouldDeferRebuild = null;
            /** @type {null|{force: boolean, timer: number|null, promise: Promise, resolve: Function, attempt: Function, deadline: number}} */
            this._pendingRebuild = null;
            /** Set only by the arbiter when its deadline has expired. */
            this._rebuildDeferOverride = false;

            if (this.isGradedViewer && this.container && typeof ResizeObserver !== 'undefined') {
                this._resizeObserver = new ResizeObserver(() => {
                    if (this._isDestroyed || this.useSinglePageMode || !this.pdf || this.isRendering) {
                        return;
                    }
                    // Skip when container is hidden (e.g. modal closed)
                    if (!this.container?.clientWidth) return;
                    const containerWidth = this.getEffectiveContainerWidth();
                    const previousWidth = this.lastRenderContainerWidth ?? 0;
                    if (containerWidth <= 0 || Math.abs(containerWidth - previousWidth) < 16) {
                        return;
                    }

                    clearTimeout(this._resizeDebounceTimer);
                    this._resizeDebounceTimer = window.setTimeout(() => {
                        if (this._isDestroyed || this.useSinglePageMode || !this.pdf || this.isRendering) {
                            return;
                        }
                        if (!this.container?.clientWidth) return;

                        const settledWidth = this.getEffectiveContainerWidth();
                        const lastWidth = this.lastRenderContainerWidth ?? 0;
                        if (settledWidth <= 0 || Math.abs(settledWidth - lastWidth) < 16) {
                            return;
                        }

                        // Through the arbiter, not straight into
                        // reRenderAllPages: this 120 ms timer beats the
                        // document-controller's 400 ms deferral, so before the
                        // arbiter existed it was this rebuild that destroyed
                        // the drawing overlay mid-stroke.
                        this.requestRebuild(true).catch((error) => {
                            console.error('[FRONTEND] Failed to re-render graded PDF after container resize:', error);
                        });
                    }, 120);
                });
                this._resizeObserver.observe(this.container);
            }

            this.setupControls();
        }

        // =====================================================================
        // Cleanup / Destroy
        // =====================================================================

        /**
         * Destroy the viewer and clean up resources.
         * Call this when the viewer is no longer needed to prevent memory leaks.
         */
        destroy() {
            this._isDestroyed = true;

            // Remove keyboard listener
            if (this._keydownHandler) {
                document.removeEventListener('keydown', this._keydownHandler);
                this._keydownHandler = null;
            }

            if (this._resizeDebounceTimer) {
                clearTimeout(this._resizeDebounceTimer);
                this._resizeDebounceTimer = null;
            }

            // A deferred rebuild must not outlive the viewer, or its retry
            // timer keeps firing against a torn-down container.
            if (this._pendingRebuild) {
                if (this._pendingRebuild.timer) clearTimeout(this._pendingRebuild.timer);
                const stale = this._pendingRebuild;
                this._pendingRebuild = null;
                stale.resolve();
            }
            this.shouldDeferRebuild = null;

            if (this._resizeObserver) {
                this._resizeObserver.disconnect();
                this._resizeObserver = null;
            }

            if (this._pendingNavigationTimer) {
                clearTimeout(this._pendingNavigationTimer);
                this._pendingNavigationTimer = null;
            }
            this.pendingNavigationPage = null;

            // Disconnect observer
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }

            // Cancel all render tasks
            this.renderTasks.forEach((task) => {
                try {
                    task.cancel();
                } catch {
                    // Ignore cancellation errors
                }
            });
            this.renderTasks.clear();

            // Clear state
            this.renderedPages.clear();
            this.renderingPages.clear();
            this.pageViewports.clear();

            // Clear callbacks
            this._onPageChange = null;
            this._onAnnotationsPageChange = null;
            this._onPageRendered = null;
            this._onSliderSync = null;

            // Release PDF document
            if (this.pdf) {
                this.pdf.destroy();
                this.pdf = null;
            }

            debugLog(`[FRONTEND] PDFViewer ${this.containerId} destroyed`);
        }

        // =====================================================================
        // Callback Registration
        // =====================================================================

        /**
         * Set callback for page changes
         * @param {Function} callback - Function(pageNum, totalPages)
         */
        onPageChange(callback) {
            this._onPageChange = callback;
        }

        /**
         * Set callback for annotations page changes
         * @param {Function} callback - Function(pageIdx)
         */
        onAnnotationsPageChange(callback) {
            this._onAnnotationsPageChange = callback;
        }

        /**
         * Set callback for page rendered events
         * @param {Function} callback - Function(pageNum)
         */
        onPageRendered(callback) {
            this._onPageRendered = callback;
        }

        /**
         * Set callback for slider sync
         * @param {Function} callback - Function(viewer)
         */
        onSliderSync(callback) {
            this._onSliderSync = callback;
        }

        // =====================================================================
        // Control Setup
        // =====================================================================

        setupControls() {
            const prevBtn = document.getElementById(`${this.controlsId.replace('Controls', '')}Prev`);
            const nextBtn = document.getElementById(`${this.controlsId.replace('Controls', '')}Next`);
            const zoomInBtn = document.getElementById(`${this.controlsId.replace('Controls', '')}ZoomIn`);
            const zoomOutBtn = document.getElementById(`${this.controlsId.replace('Controls', '')}ZoomOut`);

            if (prevBtn) prevBtn.addEventListener('click', () => this.previousPage());
            if (nextBtn) nextBtn.addEventListener('click', () => this.nextPage());
            if (zoomInBtn) zoomInBtn.addEventListener('click', () => this.zoomIn());
            if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => this.zoomOut());

            // Add keyboard navigation (store reference for cleanup)
            this._keydownHandler = (e) => {
                // Skip if destroyed
                if (this._isDestroyed) return;

                // Only handle if this viewer's container is visible
                if (!this.container || this.container.offsetParent === null) return;

                // Don't interfere if user is typing in an input
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

                if (e.key === 'Home') {
                    e.preventDefault();
                    this.scrollToPage(1);
                } else if (e.key === 'End') {
                    e.preventDefault();
                    if (this.pdf) this.scrollToPage(this.pdf.numPages);
                } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
                    e.preventDefault();
                    this.nextPage();
                } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
                    e.preventDefault();
                    this.previousPage();
                }
            };
            document.addEventListener('keydown', this._keydownHandler);
        }

        // =====================================================================
        // Container Width
        // =====================================================================

        getEffectiveContainerWidth() {
            if (!this.container) return 0;
            const computedStyle = window.getComputedStyle(this.container);
            const horizontalPadding = (
                parseFloat(computedStyle.paddingLeft || '0') +
                parseFloat(computedStyle.paddingRight || '0')
            );
            const widthGutter = 16;
            let containerWidth = (this.container.clientWidth || 0) - horizontalPadding - widthGutter;
            if (containerWidth <= 0) {
                const parentWidth = this.container.parentElement?.clientWidth || 0;
                const panelWidth = this.container.closest('.pdf-center-panel')?.clientWidth || 0;
                const fallbackBase = panelWidth > 0 ? panelWidth : parentWidth;
                const fallbackWidth = fallbackBase > 0
                    ? fallbackBase - horizontalPadding - widthGutter
                    : Math.min(window.innerWidth - 200, 1200);
                debugLog(`[FRONTEND] Container width is 0 (hidden?), using fallback: ${fallbackWidth}px`);
                containerWidth = fallbackWidth;
            }
            return Math.max(containerWidth, 50);
        }

        // =====================================================================
        // PDF Loading
        // =====================================================================

        async loadPDF(url) {
            debugLog(`[FRONTEND] loadPDF called for ${this.containerId}, URL: ${url.substring(0, 50)}...`);
            try {
                const lib = resolvePdfjsLib();
                if (!lib) {
                    throw new Error('PDF.js library is not ready yet.');
                }
                this.showLoading(true);

                // Clear all tracking state when loading a new PDF
                this.renderedPages.clear();
                this.renderingPages.clear();
                this.pageViewports.clear();
                this.renderTasks.forEach((task) => {
                    try {
                        task.cancel();
                    } catch {
                        // Ignore errors
                    }
                });
                this.renderTasks.clear();

                // Disconnect old observer
                if (this.observer) {
                    this.observer.disconnect();
                    this.observer = null;
                }

                // Reset scroll position (with null check)
                if (this.container) {
                    this.container.scrollTop = 0;
                }

                this.pdf = await lib.getDocument({
                    url,
                    withCredentials: url.startsWith('/') || url.startsWith(window.location.origin),
                }).promise;
                debugLog(`[FRONTEND] PDF loaded: ${this.pdf.numPages} pages`);
                this.currentPage = 1;
                this.zoom = 1.0;
                this.updatePageInfo();

                if (this.useSinglePageMode) {
                    await this.renderPage(1);
                    this.showLoading(false);
                } else {
                    await this.renderSkeleton();

                    // Explicitly render Page 1 before setting up observer
                    if (this.pdf && this.pdf.numPages > 0) {
                        try {
                            await this.renderSpecificPage(1);
                        } catch (error) {
                            console.error('[FRONTEND] Failed to render first page:', error);
                            throw error;
                        }
                    }

                    this.setupIntersectionObserver();
                    this.showLoading(false);
                }
            } catch (error) {
                console.error('Error loading PDF:', error);
                this.showLoading(false);
                this._showError(error);
            }
        }

        _showError(error) {
            // Guard against null container
            if (!this.container) {
                console.error('[FRONTEND] Cannot show error: container is null', error);
                return;
            }

            const msg = document.createElement('div');
            msg.className = 'alert alert-danger';
            const reason = (error && error.message) ? String(error.message) : 'Unknown error';
            let guidance = 'Unable to display this PDF.';
            if (/unexpected server response \(404\)/i.test(reason) || /404/.test(reason)) {
                guidance = 'The PDF is missing from the current download. Re-run Step 2 to download the submissions again.';
            } else if (/refused to connect/i.test(reason) || /failed to fetch/i.test(reason)) {
                guidance = 'The local grading service could not read the file. Ensure the web app is still running and the download folder has not been moved or deleted.';
            }
            msg.innerHTML = `<strong>Preview unavailable.</strong> ${escapeHtml(guidance)}<br><small>${escapeHtml(reason)}</small>`;
            this.container.innerHTML = '';
            this.container.appendChild(msg);
        }

        // =====================================================================
        // Skeleton Rendering (Continuous Scroll)
        // =====================================================================

        async renderSkeleton() {
            if (!this.pdf) return;

            // Guard against empty or corrupted PDFs
            if (!this.pdf.numPages || this.pdf.numPages < 1) {
                console.error('[FRONTEND] PDF has no pages');
                this._showError(new Error('PDF document has no pages'));
                return;
            }

            const firstPage = await this.pdf.getPage(1);
            const baseViewport = firstPage.getViewport({ scale: this.scale });

            const containerWidth = this.getEffectiveContainerWidth();
            const fitScaleFactor = Math.min(1, containerWidth / baseViewport.width);
            const displayWidth = baseViewport.width * fitScaleFactor * this.zoom;
            const displayHeight = baseViewport.height * fitScaleFactor * this.zoom;

            debugLog(`[FRONTEND] Creating skeleton for ${this.pdf.numPages} pages, container: ${this.container.clientWidth}px, fitScale: ${fitScaleFactor.toFixed(2)}, zoom: ${this.zoom}, displayWidth: ${displayWidth.toFixed(0)}px`);

            const loadingEl = this.loadingEl;
            this.container.innerHTML = '';
            if (loadingEl) {
                this.container.appendChild(loadingEl);
            }

            for (let pageNum = 1; pageNum <= this.pdf.numPages; pageNum++) {
                const wrapper = document.createElement('div');
                wrapper.className = 'pdf-page-wrapper';
                wrapper.id = `${this.container.id || 'pdf'}-page-wrapper-${pageNum}`;
                wrapper.dataset.pageNum = pageNum;
                wrapper.style.width = `${displayWidth}px`;
                wrapper.style.height = `${displayHeight}px`;
                wrapper.style.margin = '0 auto 20px auto';
                wrapper.style.backgroundColor = '#f0f0f0';
                wrapper.style.position = 'relative';

                const canvas = document.createElement('canvas');
                canvas.className = 'pdf-page-canvas';
                canvas.dataset.pageNum = pageNum;
                canvas.width = Math.ceil(baseViewport.width);
                canvas.height = Math.ceil(baseViewport.height);
                canvas.style.width = '100%';
                canvas.style.height = '100%';

                const annotationOverlay = document.createElement('div');
                annotationOverlay.className = 'pdf-annotation-overlay';
                annotationOverlay.dataset.pageNum = pageNum;

                const searchOverlay = document.createElement('div');
                searchOverlay.className = 'pdf-search-overlay';
                searchOverlay.dataset.pageNum = pageNum;

                wrapper.appendChild(canvas);
                wrapper.appendChild(annotationOverlay);
                wrapper.appendChild(searchOverlay);
                this.container.insertBefore(wrapper, loadingEl);
            }

            this.lastRenderContainerWidth = containerWidth;
        }

        // =====================================================================
        // Intersection Observer Setup
        // =====================================================================

        setupIntersectionObserver() {
            if (this.observer) {
                this.observer.disconnect();
            }

            const options = {
                root: this.container,
                rootMargin: '100px',
                threshold: [0.1, 0.5]
            };

            this.observer = new IntersectionObserver((entries) => {
                debugLog(`[FRONTEND] Observer callback fired with ${entries.length} entries`);
                entries.forEach(entry => {
                    const pageNum = parseInt(entry.target.dataset.pageNum, 10);

                    if (entry.isIntersecting && entry.intersectionRatio > 0.1) {
                        if (!this.renderedPages.has(pageNum) && !this.renderingPages.has(pageNum)) {
                            debugLog(`[FRONTEND] Observer: Triggering render for page ${pageNum}`);
                            this.renderSpecificPage(pageNum);
                        }
                    }

                    // Update current page based on visibility
                    if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
                        if (this.pendingNavigationPage !== null) {
                            if (pageNum !== this.pendingNavigationPage) {
                                return;
                            }
                            this._clearPendingNavigation(pageNum);
                        } else if (Date.now() < this.navigationLockUntil && pageNum !== this.currentPage) {
                            return;
                        }
                        this.currentPage = pageNum;
                        this.updatePageInfo();

                        // Notify annotations page change
                        if (this.isGradedViewer && this._onAnnotationsPageChange) {
                            const pageIdx = pageNum - 1;
                            this._onAnnotationsPageChange(pageIdx);
                        }
                    }
                });
            }, options);

            const wrappers = this.container.querySelectorAll('.pdf-page-wrapper');
            wrappers.forEach(wrapper => this.observer.observe(wrapper));
        }

        // =====================================================================
        // Page Rendering
        // =====================================================================

        async renderSpecificPage(pageNum) {
            if (!this.pdf || this.renderedPages.has(pageNum)) return;

            if (this.renderingPages.has(pageNum)) {
                debugLog(`[FRONTEND] Page ${pageNum} already rendering, skipping`);
                return;
            }
            this.renderingPages.add(pageNum);
            const startVersion = this.zoomVersion;

            debugLog(`[FRONTEND] Starting render for page ${pageNum}`);

            try {
                const wrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${pageNum}"]`);
                if (!wrapper) {
                    this.renderingPages.delete(pageNum);
                    return;
                }

                const canvas = wrapper.querySelector('.pdf-page-canvas');
                if (!canvas) {
                    this.renderingPages.delete(pageNum);
                    return;
                }

                const page = await this.pdf.getPage(pageNum);
                const baseViewport = page.getViewport({ scale: this.scale });
                const viewport = page.getViewport({ scale: this.scale * this.zoom });

                const containerWidth = this.getEffectiveContainerWidth();
                const fitScaleFactor = Math.min(1, containerWidth / baseViewport.width);
                const displayWidth = baseViewport.width * fitScaleFactor * this.zoom;
                const displayHeight = baseViewport.height * fitScaleFactor * this.zoom;

                wrapper.style.width = `${displayWidth}px`;
                wrapper.style.height = `${displayHeight}px`;

                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.width = `${displayWidth}px`;
                canvas.style.height = `${displayHeight}px`;

                this.pageViewports.set(pageNum, viewport);

                // Cancel any existing render task for this page
                if (this.renderTasks.has(pageNum)) {
                    try {
                        this.renderTasks.get(pageNum).cancel();
                    } catch {
                        // Ignore
                    }
                    this.renderTasks.delete(pageNum);
                }

                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                const renderContext = {
                    canvasContext: ctx,
                    viewport: viewport,
                    annotationMode: this.isGradedViewer ? 0 : 2
                };

                const renderTask = page.render(renderContext);
                this.renderTasks.set(pageNum, renderTask);

                await renderTask.promise;
                this.renderTasks.delete(pageNum);

                // Discard result if zoom changed during render
                if (startVersion !== this.zoomVersion) {
                    debugLog(`[FRONTEND] Page ${pageNum} render discarded (zoom version changed ${startVersion}->${this.zoomVersion})`);
                    return;
                }

                // Discard result if the canvas we rendered to is no longer in the
                // DOM, or has been replaced in its wrapper. This happens when
                // renderSkeleton() runs (e.g. ResizeObserver -> reRenderAllPages)
                // between the canvas-reference capture and the render-promise
                // resolution: the captured canvas is detached, a fresh blank
                // canvas takes its place, and the page would otherwise be marked
                // rendered against the orphaned canvas. Symptom (BUG-5): page
                // appears blank in the viewer even though renderedPages reports
                // it as rendered. Without this guard the page is "stuck blank"
                // until the user scrolls away and back.
                if (!canvas.isConnected) {
                    debugLog(`[FRONTEND] Page ${pageNum} render discarded (canvas detached during reflow)`);
                    return;
                }
                const currentCanvas = wrapper.isConnected
                    ? wrapper.querySelector('.pdf-page-canvas')
                    : null;
                if (!currentCanvas || currentCanvas !== canvas) {
                    debugLog(`[FRONTEND] Page ${pageNum} render discarded (canvas replaced during reflow)`);
                    return;
                }

                this.renderedPages.add(pageNum);
                debugLog(`[FRONTEND] Page ${pageNum} rendered successfully (${this.renderedPages.size}/${this.pdf.numPages})`);

                // Notify page rendered (guard against destroyed viewer in timeout)
                if (this.isGradedViewer && this._onPageRendered) {
                    setTimeout(() => {
                        if (!this._isDestroyed && this._onPageRendered) {
                            this._onPageRendered(pageNum);
                        }
                    }, 50);
                }
            } catch (error) {
                if (error && error.name === 'RenderingCancelledException') {
                    debugLog(`[FRONTEND] Render for page ${pageNum} was cancelled during reflow`);
                } else {
                    console.error(`[FRONTEND] Error rendering page ${pageNum}:`, error);
                }
            } finally {
                this.renderingPages.delete(pageNum);
            }
        }

        async renderPage(pageNum) {
            if (this.useSinglePageMode) {
                if (!this.pdf || this.isRendering || !this.canvas) return;

                this.isRendering = true;
                this.showLoading(true);

                try {
                    if (this.canvas) {
                        this.canvas.style.opacity = '0';
                    }

                    const page = await this.pdf.getPage(pageNum);
                    const baseViewport = page.getViewport({ scale: this.scale });

                    const containerWidth = this.getEffectiveContainerWidth();
                    const fitScaleFactor = Math.min(1, containerWidth / baseViewport.width);
                    const viewport = page.getViewport({ scale: this.scale * fitScaleFactor * this.zoom });

                    this.canvas.width = viewport.width;
                    this.canvas.height = viewport.height;

                    this.currentViewport = viewport;
                    this.currentPageObj = page;

                    const renderContext = {
                        canvasContext: this.canvas.getContext('2d'),
                        viewport: viewport,
                        annotationMode: this.isGradedViewer ? 0 : 2
                    };

                    await page.render(renderContext).promise;
                    this.currentPage = pageNum;
                    this.updatePageInfo();
                    this.updateZoomLevel();

                    requestAnimationFrame(() => {
                        if (this.canvas) {
                            this.canvas.style.opacity = '1';
                        }
                    });

                    this.showLoading(false);
                    this.isRendering = false;
                } catch (error) {
                    console.error('Error rendering page:', error);
                    this.showLoading(false);
                    this.isRendering = false;
                }
            } else {
                await this.scrollToPage(pageNum);
            }
        }

        // =====================================================================
        // Navigation
        // =====================================================================

        async ensurePageRendered(pageNum) {
            if (!this.pdf || pageNum < 1 || pageNum > this.pdf.numPages) {
                return;
            }
            if (this.renderedPages.has(pageNum)) {
                return;
            }

            if (this.renderingPages.has(pageNum)) {
                const waitDeadline = Date.now() + 4000;
                while (!this.renderedPages.has(pageNum) && this.renderingPages.has(pageNum)) {
                    const activeRenderTask = this.renderTasks.get(pageNum);
                    if (activeRenderTask?.promise) {
                        try {
                            await activeRenderTask.promise;
                        } catch (error) {
                            if (!(error && error.name === 'RenderingCancelledException')) {
                                throw error;
                            }
                        }
                    } else {
                        await new Promise((resolve) => setTimeout(resolve, 25));
                    }

                    if (Date.now() > waitDeadline) {
                        break;
                    }
                }
                return;
            }

            await this.renderSpecificPage(pageNum);
        }

        async scrollToPage(pageNum, smooth = true) {
            const wrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${pageNum}"]`);
            if (wrapper) {
                this._setPendingNavigation(pageNum);
                this.currentPage = pageNum;
                this.updatePageInfo();
                if (!this.useSinglePageMode && this.pdf) {
                    await this.ensurePageRendered(pageNum);
                }

                wrapper.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
                if (!this.useSinglePageMode && this.pdf) {
                    const pagesToRender = [
                        pageNum - 1,
                        pageNum + 1,
                    ].filter((candidatePage) => (
                        candidatePage >= 1 &&
                        candidatePage <= this.pdf.numPages
                    ));

                    requestAnimationFrame(() => {
                        pagesToRender.forEach((candidatePage) => {
                            this.renderSpecificPage(candidatePage).catch((error) => {
                                console.error(`[FRONTEND] Failed to render jumped-to page ${candidatePage}:`, error);
                            });
                        });
                    });
                }
            }
        }

        previousPage() {
            const activePage = this.pendingNavigationPage || this.currentPage;
            if (activePage > 1) {
                if (this.useSinglePageMode) {
                    this.renderPage(activePage - 1);
                } else {
                    this.scrollToPage(activePage - 1);
                }
            }
        }

        nextPage() {
            const activePage = this.pendingNavigationPage || this.currentPage;
            if (this.pdf && activePage < this.pdf.numPages) {
                if (this.useSinglePageMode) {
                    this.renderPage(activePage + 1);
                } else {
                    this.scrollToPage(activePage + 1);
                }
            }
        }

        // =====================================================================
        // Zoom
        // =====================================================================

        async zoomIn() {
            if (!this.pdf) {
                console.warn('[ZOOM] Cannot zoom - PDF not loaded');
                return;
            }
            if (this.zoom >= 3.0) {
                return;
            }
            try {
                this.zoom = Math.min(this.zoom + 0.25, 3.0);
                this.updateZoomLevel();
                if (this.useSinglePageMode) {
                    await this.renderPage(this.currentPage);
                } else {
                    await this.zoomResizeAndRenderVisible();
                }
            } catch (error) {
                console.error('[ZOOM] Error during zoom in:', error);
                this.updateZoomLevel();
            }
        }

        async zoomOut() {
            if (!this.pdf) {
                console.warn('[ZOOM] Cannot zoom - PDF not loaded');
                return;
            }
            if (this.zoom <= 0.5) {
                return;
            }
            try {
                this.zoom = Math.max(this.zoom - 0.25, 0.5);
                this.updateZoomLevel();
                if (this.useSinglePageMode) {
                    await this.renderPage(this.currentPage);
                } else {
                    await this.zoomResizeAndRenderVisible();
                }
            } catch (error) {
                console.error('[ZOOM] Error during zoom out:', error);
                this.updateZoomLevel();
            }
        }

        // =====================================================================
        // Zoom: resize skeletons in place, re-render only visible pages
        // =====================================================================

        async zoomResizeAndRenderVisible() {
            if (!this.pdf) return;
            this.zoomVersion++;
            const capturedVersion = this.zoomVersion;

            // Cancel in-flight renders (they use stale zoom)
            this.renderTasks.forEach((task) => {
                try { task.cancel(); } catch { /* ignore */ }
            });
            this.renderTasks.clear();
            this.renderingPages.clear();

            // Get first page viewport to compute new dimensions
            const firstPage = await this.pdf.getPage(1);
            const baseViewport = firstPage.getViewport({ scale: this.scale });
            const containerWidth = this.getEffectiveContainerWidth();
            const fitScaleFactor = Math.min(1, containerWidth / baseViewport.width);
            const displayWidth = baseViewport.width * fitScaleFactor * this.zoom;
            const displayHeight = baseViewport.height * fitScaleFactor * this.zoom;

            // Capture scroll anchor before resizing
            let scrollAnchor = null;
            const currentWrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${this.currentPage}"]`);
            if (currentWrapper && this.container) {
                const rect = currentWrapper.getBoundingClientRect();
                const containerRect = this.container.getBoundingClientRect();
                const relativeTop = rect.top - containerRect.top;
                const ratio = rect.height ? relativeTop / rect.height : 0;
                scrollAnchor = { page: this.currentPage, ratio };
            }

            // Update ALL wrapper/canvas dimensions in place (no DOM recreation)
            const wrappers = this.container.querySelectorAll('.pdf-page-wrapper');
            wrappers.forEach(wrapper => {
                wrapper.style.width = `${displayWidth}px`;
                wrapper.style.height = `${displayHeight}px`;
                const canvas = wrapper.querySelector('.pdf-page-canvas');
                if (canvas) {
                    canvas.style.width = `${displayWidth}px`;
                    canvas.style.height = `${displayHeight}px`;
                }
            });

            // Mark all pages as needing re-render (clear rendered state)
            this.renderedPages.clear();
            this.pageViewports.clear();
            this.lastRenderContainerWidth = containerWidth;

            // Restore scroll position
            if (scrollAnchor) {
                const newWrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${scrollAnchor.page}"]`);
                if (newWrapper && this.container) {
                    const newHeight = newWrapper.offsetHeight || 1;
                    this.container.scrollTop = newWrapper.offsetTop - (scrollAnchor.ratio * newHeight);
                }
            }

            // Determine visible pages (current ± 1 buffer)
            const visibleStart = Math.max(1, this.currentPage - 1);
            const visibleEnd = Math.min(this.pdf.numPages, this.currentPage + 1);

            // Immediately re-render visible pages
            const renderPromises = [];
            for (let p = visibleStart; p <= visibleEnd; p++) {
                if (capturedVersion === this.zoomVersion) {
                    renderPromises.push(this.renderSpecificPage(p));
                }
            }
            await Promise.all(renderPromises);

            // Observer will handle the rest when user scrolls
            debugLog(`[ZOOM] Resized all pages, rendered ${visibleStart}-${visibleEnd}, version=${capturedVersion}`);
        }

        // =====================================================================
        // Re-render All Pages (used by resize observer, not zoom)
        // =====================================================================

        /**
         * Whether a rebuild must be held off right now.
         *
         * A throwing predicate must never be able to freeze the layout, so a
         * failure is treated as "do not defer".
         *
         * @returns {boolean}
         */
        _shouldDeferRebuildNow() {
            if (this._rebuildDeferOverride) return false;
            if (typeof this.shouldDeferRebuild !== 'function') return false;
            try {
                return Boolean(this.shouldDeferRebuild());
            } catch (error) {
                console.error('[FRONTEND] shouldDeferRebuild threw; rebuilding anyway:', error);
                return false;
            }
        }

        /**
         * The single entry point for scheduling a page rebuild.
         *
         * Every destructive caller goes through here rather than calling
         * reRenderAllPages() directly, because the guard has to live at one
         * boundary: PDFViewer's own ResizeObserver used to rebuild on a 120 ms
         * debounce with no guard at all, which beat the 400 ms deferral in
         * document-controller and destroyed the drawing overlay mid-stroke.
         *
         * Concurrent requests coalesce into one rebuild and the strongest
         * `force` wins. The returned promise resolves after the rebuild has
         * actually happened, never merely because it was deferred. A pending
         * rebuild is retained while the predicate holds and is retried, so a
         * deferred resize is never silently dropped -- and a predicate that
         * never clears cannot defer past REBUILD_DEFER_DEADLINE_MS.
         *
         * @param {boolean} [force]
         * @returns {Promise<void>}
         */
        requestRebuild(force = false) {
            if (this._isDestroyed) return Promise.resolve();

            if (this._pendingRebuild) {
                this._pendingRebuild.force = this._pendingRebuild.force || Boolean(force);
                return this._pendingRebuild.promise;
            }

            const pending = {
                force: Boolean(force),
                timer: null,
                promise: null,
                resolve: null,
                attempt: null,
                deadline: Date.now() + REBUILD_DEFER_DEADLINE_MS,
            };
            pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
            this._pendingRebuild = pending;

            const finish = () => {
                if (this._pendingRebuild === pending) this._pendingRebuild = null;
                pending.resolve();
            };

            const attempt = () => {
                pending.timer = null;
                if (this._isDestroyed) { finish(); return; }

                const expired = Date.now() >= pending.deadline;
                if (!expired && this._shouldDeferRebuildNow()) {
                    pending.timer = window.setTimeout(attempt, REBUILD_RETRY_MS);
                    return;
                }
                if (expired) {
                    console.warn('[FRONTEND] rebuild defer deadline exceeded; rebuilding anyway');
                }

                // The override also suppresses the recheck inside
                // reRenderAllPages, or an expired deadline would bounce
                // straight back into the retry loop.
                this._rebuildDeferOverride = expired;
                let result;
                try {
                    result = this.reRenderAllPages(pending.force);
                } finally {
                    this._rebuildDeferOverride = false;
                }
                Promise.resolve(result)
                    .then((outcome) => {
                        if (outcome === REBUILD_DEFERRED && !this._isDestroyed) {
                            // A stroke started between the guard check and the
                            // destructive clear. Nothing was torn down; retry.
                            pending.timer = window.setTimeout(attempt, REBUILD_RETRY_MS);
                            return;
                        }
                        finish();
                    })
                    .catch((error) => {
                        console.error('[FRONTEND] Failed to rebuild PDF pages:', error);
                        finish();
                    });
            };

            pending.attempt = attempt;
            attempt();
            return pending.promise;
        }

        /**
         * Run a deferred rebuild now instead of waiting for the next retry.
         * Called when the work the rebuild was waiting for has finished.
         */
        flushPendingRebuild() {
            const pending = this._pendingRebuild;
            if (!pending || !pending.timer) return;
            clearTimeout(pending.timer);
            pending.timer = null;
            pending.attempt();
        }

        async reRenderAllPages(force = false) {
            const targetPage = this.pdf ? Math.min(Math.max(this.currentPage || 1, 1), this.pdf.numPages) : 1;
            const containerWidth = this.getEffectiveContainerWidth();
            const prevWidth = this.lastRenderContainerWidth ?? 0;
            const widthDelta = Math.abs(containerWidth - prevWidth);

            if (!force && widthDelta < 2) {
                this.updateZoomLevel();
                return;
            }

            // Capture scroll position
            let scrollAnchor = null;
            const currentWrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${this.currentPage}"]`);
            if (currentWrapper && this.container) {
                const rect = currentWrapper.getBoundingClientRect();
                const containerRect = this.container.getBoundingClientRect();
                const relativeTop = rect.top - containerRect.top;
                const ratio = rect.height ? relativeTop / rect.height : 0;
                scrollAnchor = { page: this.currentPage, ratio };
            }

            // Last recheck before the point of no return. Everything below
            // this line is destructive: pageViewports is cleared here and
            // renderSkeleton() then wipes the page wrappers, taking the
            // drawing overlay with them. Checking only at the scheduler's
            // timer entry is not enough -- renderSkeleton() awaits
            // pdf.getPage(1), so a stroke can begin after the guard passed.
            // Returning the sentinel tears nothing down; the arbiter retries.
            if (this._shouldDeferRebuildNow()) {
                return REBUILD_DEFERRED;
            }

            // Cancel in-flight renders
            this.renderTasks.forEach((task) => {
                try { task.cancel(); } catch { /* Intentionally empty */ }
            });
            this.renderTasks.clear();
            this.renderingPages.clear();

            this.renderedPages.clear();
            this.pageViewports.clear();

            if (this.observer) {
                this.observer.disconnect();
            }

            await this.renderSkeleton();
            this.setupIntersectionObserver();
            this.updateZoomLevel();

            // Restore scroll position
            if (scrollAnchor) {
                const newWrapper = this.container.querySelector(`.pdf-page-wrapper[data-page-num="${scrollAnchor.page}"]`);
                if (newWrapper && this.container) {
                    const newHeight = newWrapper.offsetHeight || 1;
                    this.container.scrollTop = newWrapper.offsetTop - (scrollAnchor.ratio * newHeight);
                } else if (targetPage) {
                    this.scrollToPage(targetPage, false);
                }
            } else if (targetPage) {
                this.scrollToPage(targetPage, false);
            }
        }

        // =====================================================================
        // UI Updates
        // =====================================================================

        updatePageInfo() {
            const totalPages = this.pdf ? this.pdf.numPages : 1;
            const pageInfo = document.querySelector(`#${this.controlsId.replace('Controls', '')}PageInfo`);
            if (pageInfo) {
                const spans = pageInfo.querySelectorAll('span');
                if (spans.length >= 2) {
                    spans[0].textContent = this.currentPage;
                    spans[1].textContent = totalPages;
                } else if (spans.length === 1) {
                    spans[0].textContent = totalPages;
                }
            }

            const pageInput = document.getElementById(`${this.controlsId.replace('Controls', '')}PageInput`);
            if (pageInput) {
                pageInput.value = this.currentPage;
                pageInput.max = totalPages;
            }

            // Sync slider via callback
            if (this.controlsId === 'pdfGradedControls' && this._onSliderSync) {
                this._onSliderSync(this);
            }

            // Notify comparison mode of page change (use optional chaining throughout)
            if (this.isGradedViewer && window.PdfPreviewModalComparison?.isActive?.()) {
                window.PdfPreviewModalComparison?.onPageChange?.(this.currentPage, totalPages);
            }
        }

        updateZoomLevel() {
            const zoomEl = document.getElementById(`${this.controlsId.replace('Controls', '')}ZoomLevel`);
            if (zoomEl) {
                zoomEl.textContent = Math.round(this.zoom * 100) + '%';
            }
        }

        showLoading(show) {
            if (this.loadingEl) {
                this.loadingEl.style.display = show ? 'block' : 'none';
            }
        }

        // =====================================================================
        // Viewport Access
        // =====================================================================

        /**
         * Get viewport for a specific page
         * @param {number} pageNum - Page number
         * @returns {Object|undefined} PDF.js viewport
         */
        getViewportForPage(pageNum) {
            return this.pageViewports.get(pageNum);
        }

        _setPendingNavigation(pageNum) {
            this.pendingNavigationPage = pageNum;
            this._pendingNavigationToken += 1;
            this.navigationLockUntil = Date.now() + 900;
            const token = this._pendingNavigationToken;
            clearTimeout(this._pendingNavigationTimer);
            this._pendingNavigationTimer = window.setTimeout(() => {
                if (this.pendingNavigationPage === pageNum && this._pendingNavigationToken === token) {
                    this._clearPendingNavigation(pageNum);
                }
            }, 900);
        }

        _clearPendingNavigation(pageNum) {
            if (pageNum !== undefined && this.pendingNavigationPage !== pageNum) {
                return;
            }
            this.pendingNavigationPage = null;
            this.navigationLockUntil = Math.max(this.navigationLockUntil, Date.now() + 450);
            clearTimeout(this._pendingNavigationTimer);
            this._pendingNavigationTimer = null;
        }
    }

    // =========================================================================
    // Factory Function
    // =========================================================================

    /**
     * Create a new PDFViewer instance
     * @param {string} canvasId - ID of the canvas element
     * @param {string} containerId - ID of the container element
     * @param {string} loadingId - ID of the loading indicator element
     * @param {string} controlsId - ID prefix for control elements
     * @returns {PDFViewer}
     */
    exports.createViewer = function createViewer(canvasId, containerId, loadingId, controlsId) {
        return new PDFViewer(canvasId, containerId, loadingId, controlsId);
    };

    // Export the class for direct usage
    exports.PDFViewer = PDFViewer;

})(window.PdfPreviewModalViewer);

// Also expose via AEMS namespace
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.viewer = window.PdfPreviewModalViewer;
