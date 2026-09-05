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
            this._skeletonBaseViewport = null;
            this._onResizeComplete = null;
            this._zoomInFlight = false;

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

                        // Reflow, do NOT rebuild. A container-width change
                        // never alters canvas.width (that is scale*zoom), so
                        // there is nothing to re-render -- and rebuilding here
                        // destroys the drawing overlay mid-stroke, which is
                        // issue #472. See relayoutPagesForContainer().
                        this.relayoutPagesForContainer().catch((error) => {
                            console.error('[FRONTEND] Failed to reflow graded PDF after container resize:', error);
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
            this._onResizeComplete = null;

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

        /**
         * Drop every cache that describes the CURRENT document.
         *
         * Extracted so the skeleton base size cannot be forgotten here again:
         * it describes page 1 of one specific document, and a stale copy would
         * size the next document's not-yet-rendered pages.
         */
        _resetDocumentCaches() {
            this.renderedPages.clear();
            this.renderingPages.clear();
            this.pageViewports.clear();
            this._skeletonBaseViewport = null;
        }

        async loadPDF(url) {
            debugLog(`[FRONTEND] loadPDF called for ${this.containerId}, URL: ${url.substring(0, 50)}...`);
            try {
                const lib = resolvePdfjsLib();
                if (!lib) {
                    throw new Error('PDF.js library is not ready yet.');
                }
                this.showLoading(true);

                // Clear all tracking state when loading a new PDF
                this._resetDocumentCaches();
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
            // Kept so relayoutPagesForContainer() can size not-yet-rendered
            // pages the same way this loop does, without an async getPage().
            this._skeletonBaseViewport = {
                width: baseViewport.width,
                height: baseViewport.height,
            };

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

                const box = this._applyFittedBox(wrapper, displayWidth, displayHeight);

                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.width = `${box.width}px`;
                canvas.style.height = `${box.height}px`;

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
            // Set before the first await: zoom has already been mutated by the
            // caller, and pageViewports is not cleared until after getPage(1)
            // resolves. relayoutPagesForContainer() must not read that
            // inconsistent pair. See its guard.
            this._zoomInFlight = true;
            try {
                await this._zoomResizeAndRenderVisible();
            } finally {
                this._zoomInFlight = false;
            }
        }

        async _zoomResizeAndRenderVisible() {
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
         * Size a page box, honouring any CSS clamp on its width.
         *
         * The wrapper's width is inline px, but CSS can still narrow it without
         * JS: annotator-ui.css gives `.pdf-page-wrapper` a
         * `max-width: calc(100% - 1rem)` under
         * `.preview-fullscreen.split-panel-mode`, where the page canvas is also
         * `max-width:100%; height:auto`. Writing the height that goes with the
         * REQUESTED width then leaves the wrapper taller than the page it
         * contains, and the drawing overlay -- 100% x 100% of the wrapper --
         * inherits the surplus, so ink drifts further down the page the further
         * down you draw. Re-derive the height from the width the browser
         * actually used.
         *
         * @param {HTMLElement} wrapper
         * @param {number} displayWidth  requested CSS width in px
         * @param {number} displayHeight requested CSS height in px
         * @returns {{width: number, height: number}} the box actually applied
         */
        _applyFittedBox(wrapper, displayWidth, displayHeight) {
            wrapper.style.width = `${displayWidth}px`;
            wrapper.style.height = `${displayHeight}px`;

            let usedWidth = displayWidth;
            if (typeof wrapper.getBoundingClientRect === 'function') {
                const measured = wrapper.getBoundingClientRect().width;
                if (measured > 0) usedWidth = measured;
            }
            if (displayWidth > 0 && Math.abs(usedWidth - displayWidth) > 0.5) {
                const aspect = displayHeight / displayWidth;
                displayHeight = usedWidth * aspect;
                displayWidth = usedWidth;
                // Write the MEASURED width back, not just the height. The
                // drawing overlay is width:100%/height:100% of this wrapper
                // (drawing-canvas.js:270-271) and stroke coordinates are mapped
                // through it, so the wrapper's box has to be the page's box.
                // Leaving the requested width here looks harmless while the CSS
                // clamp is active -- both render clamped -- but the moment the
                // clamp lifts, the wrapper springs to the requested width while
                // the page canvas stays clamped, and the overlay goes with the
                // wrapper. That is ~115 bitmap px of error at the page edge.
                wrapper.style.width = `${displayWidth}px`;
                wrapper.style.height = `${displayHeight}px`;
            }
            return { width: displayWidth, height: displayHeight };
        }

        /**
         * Resize the page boxes for a new container width WITHOUT rebuilding.
         *
         * A pure container-width change does not alter the PDF bitmap: `scale`
         * is a constant and `zoom` is unchanged, so `canvas.width` — the
         * document coordinate frame — stays exactly as it is. Only the CSS box
         * moves. reRenderAllPages() nevertheless clears `pageViewports` and
         * calls renderSkeleton(), whose `container.innerHTML = ''` destroys
         * every page wrapper and with it the `.drawing-canvas-overlay`. That is
         * the teardown behind #472.
         *
         * So the resize path reflows instead. Nothing is torn down, no viewport
         * is cleared, no render is cancelled, and the drawing overlay keeps its
         * DOM identity and its bitmap — a stroke in progress simply continues.
         *
         * This is deliberately NOT the reverted arbiter, and the reason is in
         * drawing-canvas.js rather than here: getStrokeCoords() re-reads the
         * MOUNTED overlay's live getBoundingClientRect() on every pointer event
         * and only falls back to the transform frozen at pointerdown when the
         * overlay is detached (`isConnected === false`). Stroke points are
         * canvas-pixel coordinates, which a container resize cannot move, so the
         * ink is anchored to the document and absorbs a geometry change whenever
         * it lands -- including not at all. The reverted attempt broke precisely
         * by FORCING that frozen branch while the CSS box moved; keeping the
         * overlay mounted is what makes the timing irrelevant.
         *
         * Callers may therefore defer or skip this freely. document-controller's
         * 400 ms fullscreen path does defer it behind isDrawingFn().
         *
         * Known gap, pre-existing and not closed here: annotator-ui.css's
         * `.pdf-page-wrapper { max-width: calc(100% - 1rem) }` under
         * `.preview-fullscreen.split-panel-mode` clamps the used WIDTH without
         * JS while the inline height stays as written, so a container change
         * inside the ResizeObserver's 16 px dead-band leaves up to ~22 CSS px of
         * vertical skew at the bottom of an A4 page. The pre-change rebuild
         * computed height the same way and had the same skew.
         *
         * Only valid while `scale * zoom` is unchanged. A zoom change must keep
         * its destructive path, or pages would display at the wrong resolution.
         *
         * @returns {Promise<void>}
         */
        async relayoutPagesForContainer() {
            if (this._isDestroyed || !this.pdf || !this.container) return;

            // Single-page mode is the one path where the container width really
            // does set canvas.width (renderPage builds its viewport as
            // scale * fitScaleFactor * zoom), so a CSS-only reflow would leave
            // the page rendered at the wrong resolution. It must rebuild.
            if (this.useSinglePageMode) return;

            // A zoom mutates this.zoom synchronously but only clears
            // pageViewports after it has awaited getPage(1). A resize timer that
            // comes due in that gap would read viewports built at the PREVIOUS
            // zoom and divide them by the new one, sizing every page ~20% wrong.
            // The zoom path recomputes the container fit itself, so skipping
            // here loses nothing.
            if (this._zoomInFlight) return;

            const containerWidth = this.getEffectiveContainerWidth();
            if (!(containerWidth > 0)) return;

            // Fall back to the first page's base size for pages that have not
            // rendered yet, exactly as renderSkeleton() does.
            let skeletonBase = this._skeletonBaseViewport || null;
            if (!skeletonBase && typeof this.pdf.getPage === 'function') {
                try {
                    const firstPage = await this.pdf.getPage(1);
                    const bv = firstPage.getViewport({ scale: this.scale });
                    skeletonBase = { width: bv.width, height: bv.height };
                    this._skeletonBaseViewport = skeletonBase;
                } catch (error) {
                    debugLog(`[FRONTEND] relayout could not read page 1: ${error}`);
                }
            }
            if (this._isDestroyed) return;

            const zoom = this.zoom || 1;
            const wrappers = this.container.querySelectorAll('.pdf-page-wrapper');

            // Every page height is about to change, so container.scrollTop --
            // a pixel offset -- stops pointing at the same place in the
            // document. Anchor on the current page's position within its own
            // box, exactly as zoomResizeAndRenderVisible() does for the other
            // in-place resize. Without this the reader is thrown roughly half a
            // page per toggle, and further with every page above them.
            let scrollAnchor = null;
            const anchorWrapper = this.container.querySelector(
                `.pdf-page-wrapper[data-page-num="${this.currentPage}"]`
            );
            if (anchorWrapper) {
                const rect = anchorWrapper.getBoundingClientRect();
                const containerRect = this.container.getBoundingClientRect();
                const relativeTop = rect.top - containerRect.top;
                scrollAnchor = {
                    page: this.currentPage,
                    ratio: rect.height ? relativeTop / rect.height : 0,
                };
            }

            wrappers.forEach((wrapper) => {
                const pageNum = parseInt(wrapper.dataset.pageNum, 10);
                const viewport = this.pageViewports.get(pageNum);

                // The stored viewport is at scale*zoom, so its base is that
                // divided by zoom — the same quantity renderSpecificPage()
                // derives from page.getViewport({scale}), without needing an
                // async getPage() per page.
                let baseWidth;
                let baseHeight;
                if (viewport && viewport.width && viewport.height) {
                    baseWidth = viewport.width / zoom;
                    baseHeight = viewport.height / zoom;
                } else if (skeletonBase) {
                    baseWidth = skeletonBase.width;
                    baseHeight = skeletonBase.height;
                } else {
                    return;
                }

                const fitScaleFactor = Math.min(1, containerWidth / baseWidth);
                const displayWidth = baseWidth * fitScaleFactor * zoom;
                const displayHeight = baseHeight * fitScaleFactor * zoom;

                const box = this._applyFittedBox(wrapper, displayWidth, displayHeight);

                // Only the CSS size. Assigning canvas.width/height here would
                // clear the bitmap and blank the page.
                const pageCanvas = wrapper.querySelector('.pdf-page-canvas');
                if (pageCanvas && pageCanvas.style.width !== '100%') {
                    pageCanvas.style.width = `${box.width}px`;
                    pageCanvas.style.height = `${box.height}px`;
                }
            });

            if (scrollAnchor) {
                const newWrapper = this.container.querySelector(
                    `.pdf-page-wrapper[data-page-num="${scrollAnchor.page}"]`
                );
                if (newWrapper) {
                    const newHeight = newWrapper.offsetHeight || 1;
                    this.container.scrollTop =
                        newWrapper.offsetTop - (scrollAnchor.ratio * newHeight);
                }
            }

            this.lastRenderContainerWidth = containerWidth;
            this.updateZoomLevel();
            // The rebuild reached this through scrollToPage(); it fires
            // _onSliderSync and PdfPreviewModalComparison.onPageChange, which
            // would otherwise be orphaned on every resize.
            this.updatePageInfo();

            // Annotation markers and text boxes are positioned in CSS pixels,
            // so they need repositioning even though nothing was rebuilt.
            if (typeof this._onResizeComplete === 'function') {
                try {
                    this._onResizeComplete(this);
                } catch (error) {
                    console.error('[FRONTEND] resize-complete callback failed:', error);
                }
            }
        }

        /**
         * Register a callback invoked after a non-destructive reflow, so
         * overlay geometry can be recomputed without the page DOM being
         * replaced.
         *
         * @param {(viewer: PDFViewer) => void} callback
         */
        onResizeComplete(callback) {
            this._onResizeComplete = callback;
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
