/**
 * PDF Preview Modal - Drawing Canvas
 *
 * Manages freeform drawing tools (pen/highlighter) as canvas overlays
 * on PDF pages. Handles stroke capture, rendering with Catmull-Rom
 * spline smoothing, and stroke data management.
 *
 * @module pdf-preview-modal/drawing-canvas
 */

// Namespace for PDF Preview Modal drawing canvas
window.PdfPreviewModalDrawingCanvas = window.PdfPreviewModalDrawingCanvas || {};

(function (exports) {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    /** @type {number} Pen stroke width in pixels */
    var PEN_WIDTH = 1.5;

    /** @type {number} Highlighter stroke width in pixels */
    var HIGHLIGHTER_WIDTH = 10;

    /** @type {number} Highlighter opacity (0-1) */
    var HIGHLIGHTER_OPACITY = 0.28;

    /** @type {number} Catmull-Rom smoothing factor */
    var SMOOTHING_FACTOR = 0.22;

    /** @type {number} Minimum movement before another stroke point is recorded */
    var MIN_POINT_DISTANCE = 1.5;

    /**
     * Preset color palette for drawing tools.
     * Each entry has a name and RGB array.
     * @type {Array<{name: string, rgb: number[]}>}
     */
    var PRESET_COLORS = [
        { name: 'orange', rgb: [245, 158, 11] },
        { name: 'red',    rgb: [239, 68, 68] },
        { name: 'green',  rgb: [34, 197, 94] },
        { name: 'black',  rgb: [30, 30, 30] },
        { name: 'white',  rgb: [255, 255, 255] }
    ];

    // Export constants for external use
    exports.PEN_WIDTH = PEN_WIDTH;
    exports.HIGHLIGHTER_WIDTH = HIGHLIGHTER_WIDTH;
    exports.HIGHLIGHTER_OPACITY = HIGHLIGHTER_OPACITY;
    exports.SMOOTHING_FACTOR = SMOOTHING_FACTOR;

    // =========================================================================
    // State
    // =========================================================================

    /** @type {{name: string, rgb: number[]}} Currently active color */
    var activeColor = PRESET_COLORS[0];

    /** @type {null|'select'|'text'|'pen'|'highlighter'} Currently active tool */
    var activeTool = null;

    /** @type {boolean} Whether markup mode is enabled */
    var markupModeActive = false;

    /** @type {Object|null} In-progress stroke data */
    var currentStroke = null;

    /** @type {boolean} Whether user is currently drawing */
    var isDrawing = false;

    /** @type {boolean} Whether Shift key is held (straight line mode) */
    var isShiftHeld = false;

    /** @type {boolean} Whether document key listeners are attached */
    var keyListenersAttached = false;

    /** @type {Map<number, {canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}>} */
    var pageCanvases = new Map();

    /** @type {Map<number, Array<Object>>} Page index to array of stroke objects */
    var pageStrokes = new Map();

    /**
     * Callback fired when a stroke is completed.
     * Receives (pageIdx, strokeData).
     * @type {Function|null}
     */
    exports.onStrokeComplete = null;

    // =========================================================================
    // Shift Key Tracking
    // =========================================================================

    /**
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
        if (e.key === 'Shift') {
            isShiftHeld = true;
        }
    }

    /**
     * @param {KeyboardEvent} e
     */
    function handleKeyUp(e) {
        if (e.key === 'Shift') {
            isShiftHeld = false;
        }
    }

    exports.init = function init() {
        if (keyListenersAttached) return;
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        keyListenersAttached = true;
    };

    /**
     * Build an rgba() CSS color string from an RGB tuple.
     *
     * @param {{rgb?: number[]}|null|undefined} color
     * @param {number} alpha
     * @returns {string}
     */
    function colorToRgba(color, alpha) {
        var rgb = color && Array.isArray(color.rgb) ? color.rgb : [0, 0, 0];
        return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
    }

    /**
     * Build an rgb() CSS color string from an RGB tuple.
     *
     * @param {{rgb?: number[]}|null|undefined} color
     * @returns {string}
     */
    function colorToRgb(color) {
        var rgb = color && Array.isArray(color.rgb) ? color.rgb : [0, 0, 0];
        return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    }

    /**
     * Convert an SVG string into a data URL for use as a cursor.
     *
     * @param {string} svg
     * @returns {string}
     */
    function svgCursorDataUrl(svg) {
        return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    }

    /**
     * Create a focused dot cursor for the pen tool.
     *
     * @returns {string}
     */
    function buildPenCursor() {
        var svg = '' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
                '<circle cx="14" cy="14" r="7" fill="' + colorToRgba(activeColor, 0.14) + '"/>' +
                '<circle cx="14" cy="14" r="5.5" fill="rgba(255,255,255,0.96)" stroke="rgba(15,23,42,0.4)" stroke-width="1.25"/>' +
                '<circle cx="14" cy="14" r="2.75" fill="' + colorToRgb(activeColor) + '"/>' +
                '<circle cx="18.5" cy="9.5" r="1.1" fill="rgba(255,255,255,0.82)"/>' +
            '</svg>';
        return svgCursorDataUrl(svg) + ' 14 14, auto';
    }

    /**
     * Create a soft capsule cursor for the highlighter tool.
     *
     * @returns {string}
     */
    function buildHighlighterCursor() {
        var svg = '' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
                '<circle cx="16" cy="16" r="9" fill="' + colorToRgba(activeColor, 0.12) + '"/>' +
                '<rect x="9" y="11" width="14" height="10" rx="5" fill="' + colorToRgba(activeColor, 0.38) + '" stroke="rgba(15,23,42,0.18)" stroke-width="1"/>' +
                '<rect x="12" y="12.5" width="8" height="7" rx="3.5" fill="rgba(255,255,255,0.28)"/>' +
            '</svg>';
        return svgCursorDataUrl(svg) + ' 16 16, auto';
    }

    /**
     * Resolve the cursor CSS to use for the active markup tool.
     *
     * @returns {string}
     */
    function getToolCursor() {
        if (activeTool === 'pen') {
            return buildPenCursor();
        }
        if (activeTool === 'highlighter') {
            return buildHighlighterCursor();
        }
        return 'default';
    }

    // =========================================================================
    // Canvas Management
    // =========================================================================

    /**
     * Create or retrieve the drawing canvas overlay for a page.
     * The canvas is inserted after the PDF render canvas but before
     * the `.pdf-annotation-overlay` element.
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {HTMLElement} pageWrapper - The `.pdf-page-wrapper` element
     * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}}
     */
    exports.ensureCanvasForPage = function ensureCanvasForPage(pageIdx, pageWrapper) {
        if (pageCanvases.has(pageIdx)) {
            var existingEntry = pageCanvases.get(pageIdx);
            var existingCanvas = existingEntry && existingEntry.canvas;
            if (existingCanvas && existingCanvas.isConnected && pageWrapper.contains(existingCanvas)) {
                var existingPdfCanvas = pageWrapper.querySelector('canvas');
                if (existingPdfCanvas &&
                    (existingCanvas.width !== existingPdfCanvas.width ||
                        existingCanvas.height !== existingPdfCanvas.height)) {
                    existingCanvas.width = existingPdfCanvas.width;
                    existingCanvas.height = existingPdfCanvas.height;
                    redrawPage(pageIdx);
                }
                existingCanvas.style.pointerEvents = (activeTool === 'pen' || activeTool === 'highlighter') ? 'auto' : 'none';
                existingCanvas.style.cursor = (activeTool === 'pen' || activeTool === 'highlighter') ? getToolCursor() : 'default';
                return existingEntry;
            }

            if (existingCanvas) {
                existingCanvas.removeEventListener('pointerdown', handlePointerDown);
                existingCanvas.removeEventListener('pointermove', handlePointerMove);
                existingCanvas.removeEventListener('pointerup', handlePointerUp);
                existingCanvas.removeEventListener('pointercancel', handlePointerUp);
                if (existingCanvas.parentNode) {
                    existingCanvas.parentNode.removeChild(existingCanvas);
                }
            }
            pageCanvases.delete(pageIdx);
        }

        var canvas = document.createElement('canvas');
        canvas.className = 'drawing-canvas-overlay';
        canvas.dataset.pageIdx = String(pageIdx);
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = '5';
        // Only intercept pointer events when a drawing tool is active
        canvas.style.pointerEvents = (activeTool === 'pen' || activeTool === 'highlighter') ? 'auto' : 'none';
        canvas.style.touchAction = 'none'; // Prevent scroll during drawing

        // Size to match the PDF canvas
        var pdfCanvas = pageWrapper.querySelector('canvas');
        if (pdfCanvas) {
            canvas.width = pdfCanvas.width;
            canvas.height = pdfCanvas.height;
        }

        // Insert before the annotation overlay if present, otherwise append
        var annotationOverlay = pageWrapper.querySelector('.pdf-annotation-overlay');
        if (annotationOverlay) {
            pageWrapper.insertBefore(canvas, annotationOverlay);
        } else {
            pageWrapper.appendChild(canvas);
        }

        var ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in ctx) {
                ctx.imageSmoothingQuality = 'high';
            }
        }

        // Attach pointer event listeners
        canvas.addEventListener('pointerdown', handlePointerDown);
        canvas.addEventListener('pointermove', handlePointerMove);
        canvas.addEventListener('pointerup', handlePointerUp);
        canvas.addEventListener('pointercancel', handlePointerUp);

        var entry = { canvas: canvas, ctx: ctx };
        pageCanvases.set(pageIdx, entry);

        // Initialize strokes array if needed
        if (!pageStrokes.has(pageIdx)) {
            pageStrokes.set(pageIdx, []);
        }

        // Redraw any existing strokes
        redrawPage(pageIdx);

        return entry;
    };

    /**
     * Resize the drawing canvas to match the current PDF canvas dimensions.
     * Redraws all strokes after resizing.
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {HTMLElement} pageWrapper - The `.pdf-page-wrapper` element
     */
    exports.resizeCanvasForPage = function resizeCanvasForPage(pageIdx, pageWrapper) {
        var entry = pageCanvases.get(pageIdx);
        if (!entry) return;

        var pdfCanvas = pageWrapper.querySelector('canvas');
        if (pdfCanvas) {
            entry.canvas.width = pdfCanvas.width;
            entry.canvas.height = pdfCanvas.height;
        }

        redrawPage(pageIdx);
    };

    /**
     * Remove the drawing canvas for a page and clean up listeners.
     *
     * @param {number} pageIdx - Zero-based page index
     */
    exports.removeCanvasForPage = function removeCanvasForPage(pageIdx) {
        var entry = pageCanvases.get(pageIdx);
        if (!entry) return;

        entry.canvas.removeEventListener('pointerdown', handlePointerDown);
        entry.canvas.removeEventListener('pointermove', handlePointerMove);
        entry.canvas.removeEventListener('pointerup', handlePointerUp);
        entry.canvas.removeEventListener('pointercancel', handlePointerUp);

        if (entry.canvas.parentNode) {
            entry.canvas.parentNode.removeChild(entry.canvas);
        }

        pageCanvases.delete(pageIdx);
    };

    // =========================================================================
    // Drawing Logic (Pointer Events)
    // =========================================================================

    /**
     * Get the page index from a canvas element.
     *
     * @param {HTMLCanvasElement} canvas
     * @returns {number}
     */
    function getPageIdxFromCanvas(canvas) {
        return parseInt(canvas.dataset.pageIdx, 10);
    }

    /**
     * Get canvas-relative coordinates from a pointer event,
     * accounting for CSS scaling vs actual canvas resolution.
     *
     * @param {PointerEvent} e
     * @param {HTMLCanvasElement} canvas
     * @returns {{x: number, y: number}}
     */
    function getCanvasCoords(e, canvas) {
        var rect = canvas.getBoundingClientRect();
        var scaleX = canvas.width / rect.width;
        var scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    /**
     * Handle pointerdown - start a new stroke if a drawing tool is active.
     *
     * @param {PointerEvent} e
     */
    function handlePointerDown(e) {
        if (activeTool !== 'pen' && activeTool !== 'highlighter') return;
        if (e.button !== 0) return; // Only primary button

        var canvas = e.currentTarget;
        var coords = getCanvasCoords(e, canvas);
        var pageIdx = getPageIdxFromCanvas(canvas);

        canvas.setPointerCapture(e.pointerId);

        isDrawing = true;
        currentStroke = {
            pageIdx: pageIdx,
            points: [{ x: coords.x, y: coords.y }],
            style: activeTool,
            color: { name: activeColor.name, rgb: activeColor.rgb.slice() },
            strokeWidth: activeTool === 'pen' ? PEN_WIDTH : HIGHLIGHTER_WIDTH,
            opacity: activeTool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1.0,
            annotationId: null
        };

        e.preventDefault();
    }

    /**
     * Handle pointermove - add point to current stroke and live-preview.
     *
     * @param {PointerEvent} e
     */
    function handlePointerMove(e) {
        if (!isDrawing || !currentStroke) return;

        var canvas = e.currentTarget;
        var coords = getCanvasCoords(e, canvas);

        if (isShiftHeld) {
            // Straight line mode: keep only start point + current point
            currentStroke.points = [currentStroke.points[0], { x: coords.x, y: coords.y }];
        } else {
            var lastPoint = currentStroke.points[currentStroke.points.length - 1];
            var dx = coords.x - lastPoint.x;
            var dy = coords.y - lastPoint.y;
            if ((dx * dx) + (dy * dy) < (MIN_POINT_DISTANCE * MIN_POINT_DISTANCE)) {
                e.preventDefault();
                return;
            }
            currentStroke.points.push({ x: coords.x, y: coords.y });
        }

        // Live preview: redraw page strokes + current in-progress stroke
        var pageIdx = currentStroke.pageIdx;
        redrawPage(pageIdx);
        var entry = pageCanvases.get(pageIdx);
        if (entry) {
            drawStroke(entry.ctx, currentStroke, 1);
        }

        e.preventDefault();
    }

    /**
     * Handle pointerup - finalize stroke and store it.
     *
     * @param {PointerEvent} e
     */
    function handlePointerUp(e) {
        if (!isDrawing || !currentStroke) return;

        var canvas = e.currentTarget;
        canvas.releasePointerCapture(e.pointerId);

        // Only store strokes with at least 2 points (or 1 for a dot)
        if (currentStroke.points.length >= 1) {
            // For single-point strokes, duplicate the point for rendering
            if (currentStroke.points.length === 1) {
                currentStroke.points.push({
                    x: currentStroke.points[0].x,
                    y: currentStroke.points[0].y
                });
            }

            var pageIdx = currentStroke.pageIdx;
            if (!pageStrokes.has(pageIdx)) {
                pageStrokes.set(pageIdx, []);
            }

            var finalStroke = {
                pageIdx: pageIdx,
                points: currentStroke.points.slice(),
                style: currentStroke.style,
                color: currentStroke.color,
                strokeWidth: currentStroke.strokeWidth,
                opacity: currentStroke.opacity,
                annotationId: currentStroke.annotationId
            };

            pageStrokes.get(pageIdx).push(finalStroke);
            redrawPage(pageIdx);

            // Fire callback
            if (typeof exports.onStrokeComplete === 'function') {
                exports.onStrokeComplete(pageIdx, finalStroke);
            }
        }

        isDrawing = false;
        currentStroke = null;

        e.preventDefault();
    }

    // =========================================================================
    // Stroke Rendering
    // =========================================================================

    /**
     * Render a single stroke onto a canvas context.
     *
     * For highlighter strokes, uses `multiply` composite operation with
     * rgba opacity. For pen strokes, uses `source-over`. Applies
     * Catmull-Rom spline interpolation for smooth curves when there are
     * more than 2 points; straight lines (2 points) are drawn directly.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {Object} stroke - Stroke data object
     * @param {number} scaleFactor - Scale factor for stroke width
     */
    function drawStroke(ctx, stroke, scaleFactor) {
        var points = stroke.points;
        if (!points || points.length < 2) return;

        ctx.save();

        // Set composite operation and style
        if (stroke.style === 'highlighter') {
            ctx.globalCompositeOperation = 'multiply';
            var rgb = stroke.color.rgb;
            ctx.strokeStyle = 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + stroke.opacity + ')';
        } else {
            ctx.globalCompositeOperation = 'source-over';
            var penRgb = stroke.color.rgb;
            ctx.strokeStyle = 'rgb(' + penRgb[0] + ', ' + penRgb[1] + ', ' + penRgb[2] + ')';
        }

        ctx.lineWidth = stroke.strokeWidth * scaleFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;

        ctx.beginPath();

        if (points.length === 2) {
            // Straight line
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
        } else {
            // Catmull-Rom spline interpolation for smooth curves
            ctx.moveTo(points[0].x, points[0].y);

            for (var i = 0; i < points.length - 1; i++) {
                var p0 = points[Math.max(0, i - 1)];
                var p1 = points[i];
                var p2 = points[i + 1];
                var p3 = points[Math.min(points.length - 1, i + 2)];

                // Calculate control points using Catmull-Rom to Bezier conversion
                var cp1x = p1.x + (p2.x - p0.x) * SMOOTHING_FACTOR;
                var cp1y = p1.y + (p2.y - p0.y) * SMOOTHING_FACTOR;
                var cp2x = p2.x - (p3.x - p1.x) * SMOOTHING_FACTOR;
                var cp2y = p2.y - (p3.y - p1.y) * SMOOTHING_FACTOR;

                ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
            }
        }

        ctx.stroke();
        ctx.restore();
    }

    // Export for external use (e.g., PDF export rendering)
    exports.drawStroke = drawStroke;

    /**
     * Clear and redraw all stored strokes for a page.
     *
     * @param {number} pageIdx - Zero-based page index
     */
    function redrawPage(pageIdx) {
        var entry = pageCanvases.get(pageIdx);
        if (!entry) return;

        var canvas = entry.canvas;
        var ctx = entry.ctx;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var strokes = pageStrokes.get(pageIdx);
        if (!strokes) return;

        for (var i = 0; i < strokes.length; i++) {
            drawStroke(ctx, strokes[i], 1);
        }
    }

    exports.redrawPage = redrawPage;

    // =========================================================================
    // Data Management
    // =========================================================================

    /**
     * Load strokes from API annotation objects.
     * Filters for annotations with type === 'drawing' and populates
     * the pageStrokes map.
     *
     * @param {Array<Object>} annotationsData - Array of annotation objects from API
     */
    exports.loadStrokesFromAnnotations = function loadStrokesFromAnnotations(annotationsData) {
        if (!Array.isArray(annotationsData)) return;

        pageStrokes.clear();

        for (var i = 0; i < annotationsData.length; i++) {
            var ann = annotationsData[i];
            if (ann.type !== 'drawing') continue;

            var pageIdx = ann.page_index !== undefined ? ann.page_index : ann.pageIdx;
            if (pageIdx === undefined || pageIdx === null) continue;

            if (!pageStrokes.has(pageIdx)) {
                pageStrokes.set(pageIdx, []);
            }

            var stroke = {
                pageIdx: pageIdx,
                points: (ann.points || []).map(function (pt) {
                    if (Array.isArray(pt)) {
                        return { x: pt[0], y: pt[1] };
                    }
                    return { x: pt.x, y: pt.y };
                }),
                style: ann.drawing_style || ann.style || 'pen',
                color: ann.color && ann.color.rgb ? ann.color : {
                    name: ann.colorName || 'black',
                    rgb: ann.stroke_color_rgb || [0, 0, 0]
                },
                strokeWidth: ann.stroke_width || ann.strokeWidth || ((ann.drawing_style || ann.style) === 'highlighter' ? HIGHLIGHTER_WIDTH : PEN_WIDTH),
                opacity: ann.stroke_opacity !== undefined ? ann.stroke_opacity :
                    (ann.opacity !== undefined ? ann.opacity : ((ann.drawing_style || ann.style) === 'highlighter' ? HIGHLIGHTER_OPACITY : 1.0)),
                annotationId: ann.annotationId || ann.stable_id || ann.id || null
            };

            pageStrokes.get(pageIdx).push(stroke);
        }
    };

    /**
     * Get the bounding box of a stroke with padding.
     *
     * @param {Object} stroke - Stroke data object
     * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
     */
    exports.getStrokeBounds = function getStrokeBounds(stroke) {
        var points = stroke.points;
        if (!points || points.length === 0) {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        var minX = Infinity;
        var minY = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;

        for (var i = 0; i < points.length; i++) {
            var p = points[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }

        // Add padding based on stroke width
        var pad = (stroke.strokeWidth || PEN_WIDTH) / 2 + 2;
        return {
            minX: minX - pad,
            minY: minY - pad,
            maxX: maxX + pad,
            maxY: maxY + pad
        };
    };

    /**
     * Test if a point hits any stroke on a page.
     * Returns the topmost (last-drawn) hit stroke, or null.
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {number} canvasX - X coordinate in canvas space
     * @param {number} canvasY - Y coordinate in canvas space
     * @param {number} [tolerance=6] - Hit test tolerance in pixels
     * @returns {Object|null} The hit stroke object, or null
     */
    exports.hitTestStroke = function hitTestStroke(pageIdx, canvasX, canvasY, tolerance) {
        if (tolerance === undefined) tolerance = 6;

        var strokes = pageStrokes.get(pageIdx);
        if (!strokes) return null;

        // Iterate in reverse so topmost stroke wins
        for (var i = strokes.length - 1; i >= 0; i--) {
            var stroke = strokes[i];
            var points = stroke.points;
            if (!points || points.length < 2) continue;

            var halfWidth = (stroke.strokeWidth || PEN_WIDTH) / 2 + tolerance;

            for (var j = 0; j < points.length - 1; j++) {
                var p1 = points[j];
                var p2 = points[j + 1];

                // Point-to-segment distance
                var dx = p2.x - p1.x;
                var dy = p2.y - p1.y;
                var lenSq = dx * dx + dy * dy;

                var t = 0;
                if (lenSq > 0) {
                    t = ((canvasX - p1.x) * dx + (canvasY - p1.y) * dy) / lenSq;
                    t = Math.max(0, Math.min(1, t));
                }

                var nearX = p1.x + t * dx;
                var nearY = p1.y + t * dy;
                var distSq = (canvasX - nearX) * (canvasX - nearX) + (canvasY - nearY) * (canvasY - nearY);

                if (distSq <= halfWidth * halfWidth) {
                    return stroke;
                }
            }
        }

        return null;
    };

    /**
     * Remove a stroke by its annotationId and redraw the page.
     *
     * @param {number} pageIdx - Zero-based page index
     * @param {string} annotationId - The annotation ID to remove
     */
    exports.removeStroke = function removeStroke(pageIdx, annotationId) {
        var strokes = pageStrokes.get(pageIdx);
        if (!strokes) return;

        for (var i = strokes.length - 1; i >= 0; i--) {
            if (strokes[i].annotationId === annotationId) {
                strokes.splice(i, 1);
                break;
            }
        }

        redrawPage(pageIdx);
    };

    /**
     * Translate all points of a stroke by (dx, dy).
     *
     * @param {Object} stroke - Stroke data object
     * @param {number} dx - X translation
     * @param {number} dy - Y translation
     */
    exports.moveStroke = function moveStroke(stroke, dx, dy) {
        if (!stroke || !stroke.points) return;

        for (var i = 0; i < stroke.points.length; i++) {
            stroke.points[i].x += dx;
            stroke.points[i].y += dy;
        }

        if (typeof stroke.pageIdx === 'number') {
            redrawPage(stroke.pageIdx);
        }
    };

    /**
     * Get all strokes for a page.
     *
     * @param {number} pageIdx - Zero-based page index
     * @returns {Array<Object>} Array of stroke objects (empty if none)
     */
    exports.getPageStrokes = function getPageStrokes(pageIdx) {
        return pageStrokes.get(pageIdx) || [];
    };

    // =========================================================================
    // Mode Management
    // =========================================================================

    /**
     * Toggle markup mode. Controls whether drawing canvases accept
     * pointer events.
     *
     * @param {boolean} active - Whether markup mode should be active
     */
    exports.setMarkupMode = function setMarkupMode(active) {
        markupModeActive = !!active;
        updateCanvasPointerEvents();
    };

    /**
     * Set the active drawing tool.
     *
     * @param {null|'select'|'text'|'pen'|'highlighter'} tool
     */
    exports.setActiveTool = function setActiveTool(tool) {
        activeTool = tool;
        updateCanvasPointerEvents();
    };

    /**
     * Set the active drawing color.
     *
     * @param {{name: string, rgb: number[]}} color
     */
    exports.setActiveColor = function setActiveColor(color) {
        if (typeof color === 'string') {
            for (var i = 0; i < PRESET_COLORS.length; i++) {
                if (PRESET_COLORS[i].name === color) {
                    activeColor = PRESET_COLORS[i];
                    updateCanvasPointerEvents();
                    return;
                }
            }
        }
        if (color && Array.isArray(color.rgb)) {
            activeColor = color;
            updateCanvasPointerEvents();
        }
    };

    /**
     * Get the currently active color.
     *
     * @returns {{name: string, rgb: number[]}}
     */
    exports.getActiveColor = function getActiveColor() {
        return activeColor;
    };

    /**
     * Get the currently active tool.
     *
     * @returns {null|'select'|'text'|'pen'|'highlighter'}
     */
    exports.getActiveTool = function getActiveTool() {
        return activeTool;
    };

    /**
     * Check if markup mode is currently active.
     *
     * @returns {boolean}
     */
    exports.isMarkupActive = function isMarkupActive() {
        return markupModeActive;
    };

    /**
     * Get the preset color palette.
     *
     * @returns {Array<{name: string, rgb: number[]}>}
     */
    exports.getPresetColors = function getPresetColors() {
        return PRESET_COLORS;
    };

    /**
     * Update pointer-events on all drawing canvases based on the
     * current tool. Only pen/highlighter should intercept pointer events.
     */
    function updateCanvasPointerEvents() {
        var shouldCapture = (activeTool === 'pen' || activeTool === 'highlighter');
        pageCanvases.forEach(function (entry) {
            entry.canvas.style.pointerEvents = shouldCapture ? 'auto' : 'none';
            entry.canvas.style.cursor = shouldCapture ? getToolCursor() : 'default';
        });
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    /**
     * Remove all drawing canvases, clear state, and remove document
     * event listeners. Call this when the modal is destroyed.
     */
    exports.destroy = function destroy() {
        // Remove all canvases
        pageCanvases.forEach(function (entry, _pageIdx) {
            entry.canvas.removeEventListener('pointerdown', handlePointerDown);
            entry.canvas.removeEventListener('pointermove', handlePointerMove);
            entry.canvas.removeEventListener('pointerup', handlePointerUp);
            entry.canvas.removeEventListener('pointercancel', handlePointerUp);

            if (entry.canvas.parentNode) {
                entry.canvas.parentNode.removeChild(entry.canvas);
            }
        });

        pageCanvases.clear();
        pageStrokes.clear();

        // Reset state
        isDrawing = false;
        currentStroke = null;
        activeTool = null;
        markupModeActive = false;
        activeColor = PRESET_COLORS[0];

        // Remove document-level key listeners
        if (keyListenersAttached) {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            keyListenersAttached = false;
        }

        // Preserve integration callbacks across modal sessions. The preview
        // shell/monolith rewires them when needed, and clearing them here can
        // leave reopen flows without a create handler.
    };

})(window.PdfPreviewModalDrawingCanvas);

// Version marker
window.PdfPreviewModalDrawingCanvas._version = '1.0.0';

window.PdfPreviewModalDrawingCanvas.init();

// Also expose via AEMS namespace (new pattern)
window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.drawingCanvas = window.PdfPreviewModalDrawingCanvas;
