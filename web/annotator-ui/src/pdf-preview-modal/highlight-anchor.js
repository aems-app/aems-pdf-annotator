/**
 * PDF Preview Modal - Highlight Anchor (extend / shorten)
 *
 * Lets a user extend or shorten a text-anchored highlight by dragging a handle
 * at each end of the highlighted phrase. There is no selectable text layer, so
 * word geometry is derived from pdf.js ``page.getTextContent()`` (the same
 * technique the search highlighter uses) and the handles snap to word
 * boundaries. On release the new per-line quads (PDF bottom-left points) and the
 * re-derived anchor phrase are handed to the host via ``onExtendCompleted`` for
 * persistence — which flips the highlight AI -> HUMAN.
 *
 * @module pdf-preview-modal/highlight-anchor
 */

window.PdfPreviewModalHighlightAnchor = window.PdfPreviewModalHighlightAnchor || {};

(function (exports) {
    'use strict';

    /** @type {null|Object} */
    var selected = null; // { marker, ann, pageIdx, words, startOrder, endOrder, scaleX, scaleY }

    /** @type {Object} Host dependencies injected via init(). */
    var deps = {
        getViewer: null,          // () => viewer with .pdf and getViewportForPage(pageNum)
        onExtendCompleted: null,  // (marker, ann, {quadsPdf, anchorText, pageIdx}) => void
    };

    /** @type {CanvasRenderingContext2D|null} */
    var measureCtx = null;

    /** @type {{start: HTMLElement, end: HTMLElement}|null} */
    var handles = null;

    /** @type {boolean} */
    var draggingHandle = null; // 'start' | 'end' | null

    exports.init = function init(hostDeps) {
        deps = Object.assign(deps, hostDeps || {});
    };

    function getMeasureContext() {
        if (measureCtx) return measureCtx;
        try {
            var canvas = document.createElement('canvas');
            measureCtx = canvas.getContext('2d');
            if (measureCtx) {
                measureCtx.font = '12px Georgia, "Times New Roman", serif';
            }
        } catch (_e) {
            measureCtx = null;
        }
        return measureCtx;
    }

    exports.hasSelection = function hasSelection() {
        return selected !== null;
    };

    exports.getSelected = function getSelected() {
        return selected;
    };

    /**
     * Build an ordered word index for a page in page-relative pixel space, each
     * word also carrying its PDF bottom-left rect (for persistence).
     */
    async function buildWordIndex(pageNum, viewport, wrapper) {
        var empty = { words: [], scaleX: 1, scaleY: 1 };
        var viewer = deps.getViewer && deps.getViewer();
        if (!viewer || !viewer.pdf) return empty;
        var page = await viewer.pdf.getPage(pageNum);
        var textContent = await page.getTextContent();
        var canvas = wrapper.querySelector('.pdf-page-canvas');
        if (!canvas) return empty;
        var canvasRect = canvas.getBoundingClientRect();
        var scaleX = canvasRect.width / viewport.width;
        var scaleY = canvasRect.height / viewport.height;
        var ctx = getMeasureContext();

        var words = [];
        textContent.items.forEach(function (item) {
            var itemStr = item.str;
            if (!itemStr || !itemStr.trim()) return;
            var tx = item.transform;
            var itemWidth = item.width;
            var itemHeight = Math.hypot(tx[2], tx[3]) || Math.abs(tx[0]) || 10;
            var fullWidth = (ctx && ctx.measureText(itemStr).width) || itemStr.length || 1;

            var re = /\S+/g;
            var m;
            while ((m = re.exec(itemStr)) !== null) {
                var wStart = m.index;
                var wEnd = m.index + m[0].length;
                var prefixW = ctx ? ctx.measureText(itemStr.substring(0, wStart)).width : (wStart / itemStr.length) * fullWidth;
                var wordW = ctx ? ctx.measureText(itemStr.substring(wStart, wEnd)).width : (m[0].length / itemStr.length) * fullWidth;
                var startRatio = prefixW / fullWidth;
                var widthRatio = wordW / fullWidth;

                var pdfX = tx[4] + itemWidth * startRatio;
                var pdfY = tx[5];
                var pdfW = itemWidth * widthRatio;
                var pdfH = itemHeight;
                var pdfRect = [pdfX, pdfY, pdfX + pdfW, pdfY + pdfH];
                var vr = viewport.convertToViewportRectangle(pdfRect);
                var vx0 = Math.min(vr[0], vr[2]) * scaleX;
                var vy0 = Math.min(vr[1], vr[3]) * scaleY;
                var vx1 = Math.max(vr[0], vr[2]) * scaleX;
                var vy1 = Math.max(vr[1], vr[3]) * scaleY;

                words.push({
                    text: m[0],
                    px0: vx0, py0: vy0, px1: vx1, py1: vy1,
                    cx: (vx0 + vx1) / 2, cy: (vy0 + vy1) / 2,
                    pdfRect: pdfRect,
                });
            }
        });

        // Group into lines FIRST, then sort within each line. A pairwise
        // comparator with a pair-dependent "same line" tolerance is not a strict
        // weak order (A~B and B~C do not imply A~C), so Array.prototype.sort
        // could produce engine-dependent, jumbled word orders. Sorting by cy,
        // bucketing against each line's first word with a height-relative
        // tolerance (NOT a fixed pixel count — zoom-independence), and sorting
        // each bucket by cx is transitive and deterministic.
        words.sort(function (a, b) { return a.cy - b.cy; });
        var lines = [];
        words.forEach(function (w) {
            for (var i = 0; i < lines.length; i++) {
                var baseline = lines[i][0];
                var tol = Math.min(
                    Math.max(1, w.py1 - w.py0),
                    Math.max(1, baseline.py1 - baseline.py0)
                ) * 0.5;
                if (Math.abs(w.cy - baseline.cy) <= tol) {
                    lines[i].push(w);
                    return;
                }
            }
            lines.push([w]);
        });
        lines.sort(function (a, b) { return a[0].cy - b[0].cy; });
        words = [];
        lines.forEach(function (line) {
            line.sort(function (a, b) { return a.cx - b.cx; });
            words = words.concat(line);
        });
        words.forEach(function (w, i) { w.order = i; });

        // Tag every word with the COLUMN band it belongs to. On a multi-column
        // page the line-bucketing above merges same-height words from BOTH
        // columns into one visual "line" (their cy overlaps) and interleaves
        // them in `order`; an extend from one left-column line to the next would
        // then sweep in the intervening right-column words (their `order` falls
        // inside the range). Column tagging lets the extend stay within the
        // anchor's column. On a single-column page there is exactly ONE band, so
        // every word gets col 0 and the constraint is a strict no-op.
        var bands = computeColumnBands(words);
        words.forEach(function (w) { w.col = colOfWord(w, bands); });
        return { words: words, scaleX: scaleX, scaleY: scaleY, bands: bands };
    }

    /** Cluster words into column bands using a LINE-AWARE STRADDLE classifier.
     * Returns a list of [x0, x1] in page-relative px, left to right.
     *
     * The discriminator that separates a real column gutter from an ordinary gap
     * (codex 2026-07-20): a genuine two-column gutter has MANY rows with text on
     * BOTH sides of it (a left-column word AND a right-column word) while almost no
     * word crosses it. A single-column page — even one full of centered display
     * equations or short/indented lines — produces NO such straddling rows: prose
     * rows cross every interior x, and a centered equation only ever sits on one
     * side. So `straddle` stays ~0 and the page yields ONE band (strict no-op on
     * the exam corpus). A full-width heading/footer crosses the gutter on a row or
     * two, tolerated because the straddle count still dominates. Validated on the
     * SE2134 corpus (0 false splits) and synthetic 2-column ± heading pages. */
    function computeColumnBands(words) {
        if (!words.length) return [[0, Infinity]];
        var heights = words
            .map(function (w) { return Math.max(1, w.py1 - w.py0); })
            .sort(function (a, b) { return a - b; });
        var medH = heights[Math.floor(heights.length / 2)] || 10;

        var minX = Infinity;
        var maxX = -Infinity;
        words.forEach(function (w) {
            if (w.px0 < minX) minX = w.px0;
            if (w.px1 > maxX) maxX = w.px1;
        });
        var span = Math.max(1, maxX - minX);

        // Group words into visual rows by VERTICAL-EXTENT OVERLAP against a STABLE
        // seed extent (never a growing union), so a two-column page whose columns
        // have staggered baselines still puts a left- and right-column word into
        // the SAME row — otherwise the straddle test never sees text flanking the
        // gutter and the page mis-merges to one band (codex 2026-07-20). The seed
        // is fixed (not expanded by matched words) so a row can never transitively
        // bridge into the next line. Adjacent single-column lines have ZERO
        // vertical overlap, so the small threshold safely unifies staggers up to
        // ~a font height without ever merging separate lines. An extreme stagger
        // (offset >= a full font height) degrades gracefully to a single band —
        // an unconstrained extend, never wrong data.
        var byCy = words.slice().sort(function (a, b) { return a.cy - b.cy; });
        var rows = [];
        byCy.forEach(function (w) {
            for (var i = 0; i < rows.length; i++) {
                var ov = Math.min(w.py1, rows[i].sy1) - Math.max(w.py0, rows[i].sy0);
                var mh = Math.min(Math.max(1, w.py1 - w.py0), rows[i].sy1 - rows[i].sy0);
                if (ov > 0.1 * mh) {
                    rows[i].words.push(w);
                    return;
                }
            }
            rows.push({ sy0: w.py0, sy1: w.py1, words: [w] });
        });
        // Too few rows to infer a persistent gutter statistically: one band.
        if (rows.length < 5) return [[minX, maxX]];

        // Per-row x-extent + sorted intervals for the crossing test.
        rows.forEach(function (row) {
            var mn = Infinity;
            var mx = -Infinity;
            row.words.forEach(function (w) {
                if (w.px0 < mn) mn = w.px0;
                if (w.px1 > mx) mx = w.px1;
            });
            row.minX = mn;
            row.maxX = mx;
            row.iv = row.words
                .map(function (w) { return [w.px0, w.px1]; })
                .sort(function (a, b) { return a[0] - b[0]; });
        });
        function crossesAt(row, x) {
            for (var i = 0; i < row.iv.length; i++) {
                if (row.iv[i][0] <= x && x <= row.iv[i][1]) return true;
            }
            return false;
        }

        var nBins = Math.min(500, Math.max(40, Math.ceil(span / Math.max(2, medH * 0.4))));
        var binW = span / nBins;
        var straddleThresh = 0.35 * rows.length; // rows with text flanking x on both sides
        // A full-width heading AND footer may each cross the gutter, so allow ~2
        // crossings as an absolute floor (the straddle + share checks below still
        // protect single-column pages, where crossing is far higher).
        var crossCap = Math.max(2.5, 0.15 * rows.length);
        var minGutterBins = Math.max(1, Math.ceil(medH / binW));

        var isGutter = new Array(nBins);
        for (var b = 0; b < nBins; b++) {
            var x = minX + (b + 0.5) * binW;
            var straddle = 0;
            var crossing = 0;
            for (var r = 0; r < rows.length; r++) {
                var row = rows[r];
                if (crossesAt(row, x)) crossing += 1;
                else if (row.minX < x && x < row.maxX) straddle += 1;
            }
            isGutter[b] = straddle >= straddleThresh && crossing <= crossCap;
        }

        var bands = [];
        var bb = 0;
        while (bb < nBins && isGutter[bb]) bb++; // skip any leading gutter
        var start = bb;
        while (bb < nBins) {
            if (isGutter[bb]) {
                var g = bb;
                while (g < nBins && isGutter[g]) g++;
                if (g - bb >= minGutterBins) {
                    bands.push([minX + start * binW, minX + bb * binW]);
                    start = g;
                }
                bb = g;
            } else {
                bb++;
            }
        }
        bands.push([minX + start * binW, maxX]);
        bands = bands.filter(function (bd) { return bd[1] - bd[0] > medH; });
        if (bands.length <= 1) return bands.length ? bands : [[minX, maxX]];

        // A genuine column is BOTH physically wide AND holds a real share of the
        // words. This rejects a narrow "label" column (a numbered/lettered list's
        // "1." / "a)" markers, or a right-aligned equation-number gutter): the
        // marker band is thin and holds ~one word per row. If any band fails,
        // fall back to a single band — biasing toward NOT constraining the extend
        // is safe on the single-column exam corpus (worst case: an unconstrained
        // extend on a rare true 2-column page, the original graceful fallback).
        var minColWidth = Math.max(medH, 0.18 * span);
        var minColWords = Math.max(2, 0.2 * words.length);
        function bandWordCount(bd) {
            var n = 0;
            words.forEach(function (w) {
                if (w.cx >= bd[0] - 1 && w.cx <= bd[1] + 1) n += 1;
            });
            return n;
        }
        var allReal = bands.every(function (bd) {
            return bd[1] - bd[0] >= minColWidth && bandWordCount(bd) >= minColWords;
        });
        return allReal ? bands : [[minX, maxX]];
    }

    /** Column-band index whose x-range contains the word center (nearest band
     * as a fallback so every word maps somewhere). */
    function colOfWord(w, bands) {
        for (var i = 0; i < bands.length; i++) {
            if (w.cx >= bands[i][0] - 1 && w.cx <= bands[i][1] + 1) return i;
        }
        var best = 0;
        var bestDist = Infinity;
        for (var j = 0; j < bands.length; j++) {
            var mid = (bands[j][0] + bands[j][1]) / 2;
            var d = Math.abs(w.cx - mid);
            if (d < bestDist) { bestDist = d; best = j; }
        }
        return best;
    }

    /** Find the covered [startOrder, endOrder] whose word centers fall in the
     * current highlight quads (page-relative px). */
    function spanFromQuads(words, quadBoxes) {
        var covered = [];
        words.forEach(function (w) {
            for (var i = 0; i < quadBoxes.length; i++) {
                var q = quadBoxes[i];
                if (w.cx >= q.x0 - 1 && w.cx <= q.x1 + 1 && w.cy >= q.y0 - 1 && w.cy <= q.y1 + 1) {
                    covered.push(w.order);
                    return;
                }
            }
        });
        if (!covered.length) return null;
        // `orders` are the words ACTUALLY inside the quads. The [start,end] range
        // additionally spans interleaved neighbouring-column words on multi-column
        // pages, so the anchor column must be inferred from `orders`, not the range
        // (codex 2026-07-20: a wrapped left-column phrase otherwise has more
        // right-column words in its range and picks the wrong column).
        return {
            startOrder: Math.min.apply(null, covered),
            endOrder: Math.max.apply(null, covered),
            orders: covered,
        };
    }

    /** Most common column among a set of word `orders` (the words truly covered by
     * a highlight). Returns 0 when unknown. */
    function modeColumn(words, orders) {
        var counts = {};
        (orders || []).forEach(function (o) {
            var wc = words[o] && words[o].col;
            if (wc != null) counts[wc] = (counts[wc] || 0) + 1;
        });
        var best = 0;
        var bestCount = -1;
        Object.keys(counts).forEach(function (k) {
            if (counts[k] > bestCount) {
                bestCount = counts[k];
                best = parseInt(k, 10);
            }
        });
        return best;
    }

    /** Current highlight quad child boxes in page-relative px. */
    function readMarkerQuadBoxes(marker) {
        var boxes = [];
        var left = parseFloat(marker.style.left) || 0;
        var top = parseFloat(marker.style.top) || 0;
        marker.querySelectorAll('.annotation-highlight-quad').forEach(function (q) {
            var x0 = left + (parseFloat(q.style.left) || 0);
            var y0 = top + (parseFloat(q.style.top) || 0);
            boxes.push({
                x0: x0, y0: y0,
                x1: x0 + (parseFloat(q.style.width) || 0),
                y1: y0 + (parseFloat(q.style.height) || 0),
            });
        });
        return boxes;
    }

    /** Group covered words into per-line boxes (page-relative) and PDF rects.
     * Each line is additionally split into horizontal RUNS at large gaps so a
     * single quad never spans a column gutter (mitigates multi-column extends). */
    function coveredToQuads(words, startOrder, endOrder, anchorCol) {
        // 1) cluster covered words into line bands by vertical overlap (mirrors
        //    the backend _group_token_rects_by_line).
        var bands = []; // { words:[...], y0, y1 }
        for (var order = startOrder; order <= endOrder; order++) {
            var w = words[order];
            if (!w) continue;
            // Skip words outside the anchor's column: on a multi-column page the
            // [startOrder,endOrder] range can straddle the gutter, so a plain
            // range sweep would otherwise paint (and persist) the neighbouring
            // column's words. No-op on single-column pages (one band).
            if (anchorCol != null && w.col != null && w.col !== anchorCol) continue;
            var placed = false;
            for (var i = 0; i < bands.length; i++) {
                var bnd = bands[i];
                var overlap = Math.min(w.py1, bnd.y1) - Math.max(w.py0, bnd.y0);
                var minH = Math.min(Math.max(1, w.py1 - w.py0), Math.max(1, bnd.y1 - bnd.y0));
                if (overlap > 0.4 * minH) {
                    bnd.words.push(w);
                    bnd.y0 = Math.min(bnd.y0, w.py0);
                    bnd.y1 = Math.max(bnd.y1, w.py1);
                    placed = true;
                    break;
                }
            }
            if (!placed) bands.push({ words: [w], y0: w.py0, y1: w.py1 });
        }

        // 2) within each band split into horizontal runs at gaps wider than ~2
        //    line-heights (a column gutter), emitting a tight quad per run.
        var lines = [];
        bands.forEach(function (bnd) {
            var ordered = bnd.words.slice().sort(function (a, b) { return a.px0 - b.px0; });
            var gapThreshold = Math.max(1, bnd.y1 - bnd.y0) * 2;
            var run = null;
            ordered.forEach(function (w) {
                if (run && (w.px0 - run.box[2]) > gapThreshold) {
                    lines.push(run);
                    run = null;
                }
                if (!run) {
                    run = { box: [w.px0, w.py0, w.px1, w.py1], pdf: w.pdfRect.slice() };
                } else {
                    run.box[0] = Math.min(run.box[0], w.px0);
                    run.box[1] = Math.min(run.box[1], w.py0);
                    run.box[2] = Math.max(run.box[2], w.px1);
                    run.box[3] = Math.max(run.box[3], w.py1);
                    run.pdf[0] = Math.min(run.pdf[0], w.pdfRect[0]);
                    run.pdf[1] = Math.min(run.pdf[1], w.pdfRect[1]);
                    run.pdf[2] = Math.max(run.pdf[2], w.pdfRect[2]);
                    run.pdf[3] = Math.max(run.pdf[3], w.pdfRect[3]);
                }
            });
            if (run) lines.push(run);
        });
        lines.sort(function (a, b) { return (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]); });
        return lines;
    }

    /** Repaint the marker's per-line quad children + reposition it to the union. */
    function repaintMarker(marker, lines) {
        if (!lines.length) return;
        var ux0 = Math.min.apply(null, lines.map(function (l) { return l.box[0]; }));
        var uy0 = Math.min.apply(null, lines.map(function (l) { return l.box[1]; }));
        var ux1 = Math.max.apply(null, lines.map(function (l) { return l.box[2]; }));
        var uy1 = Math.max.apply(null, lines.map(function (l) { return l.box[3]; }));

        var fill = marker.querySelector('.annotation-highlight-quad');
        var color = fill ? fill.style.backgroundColor : 'rgba(255,165,0,0.30)';

        marker.style.left = ux0 + 'px';
        marker.style.top = uy0 + 'px';
        marker.style.width = Math.max(1, ux1 - ux0) + 'px';
        marker.style.height = Math.max(1, uy1 - uy0) + 'px';
        marker.style.backgroundColor = 'transparent';

        marker.querySelectorAll('.annotation-highlight-quad').forEach(function (q) { q.remove(); });
        lines.forEach(function (ln) {
            var div = document.createElement('div');
            div.className = 'annotation-highlight-quad';
            div.style.position = 'absolute';
            div.style.left = (ln.box[0] - ux0) + 'px';
            div.style.top = (ln.box[1] - uy0) + 'px';
            div.style.width = Math.max(1, ln.box[2] - ln.box[0]) + 'px';
            div.style.height = Math.max(1, ln.box[3] - ln.box[1]) + 'px';
            div.style.backgroundColor = color;
            div.style.borderRadius = '2px';
            div.style.pointerEvents = 'none';
            marker.appendChild(div);
        });
    }

    function positionHandles() {
        if (!selected || !handles) return;
        var words = selected.words;
        var s = words[selected.startOrder];
        var e = words[selected.endOrder];
        var marker = selected.marker;
        var mLeft = parseFloat(marker.style.left) || 0;
        var mTop = parseFloat(marker.style.top) || 0;
        if (s) {
            handles.start.style.left = (s.px0 - mLeft - 4) + 'px';
            handles.start.style.top = (s.py0 - mTop) + 'px';
            handles.start.style.height = Math.max(8, s.py1 - s.py0) + 'px';
        }
        if (e) {
            handles.end.style.left = (e.px1 - mLeft) + 'px';
            handles.end.style.top = (e.py0 - mTop) + 'px';
            handles.end.style.height = Math.max(8, e.py1 - e.py0) + 'px';
        }
    }

    function nearestWordOrder(words, px, py, col) {
        var best = null;
        var bestDist = Infinity;
        words.forEach(function (w) {
            // Keep the drag target inside the anchor's column so a handle dragged
            // across a gutter cannot select a word in the neighbouring column.
            if (col != null && w.col != null && w.col !== col) return;
            var dx = px - w.cx;
            var dy = py - w.cy;
            var dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; best = w.order; }
        });
        return best;
    }

    var dragStartSpan = null;

    function detachHandleDragListeners(handleEl) {
        handleEl.removeEventListener('pointermove', onHandlePointerMove);
        handleEl.removeEventListener('pointerup', onHandlePointerUp);
        handleEl.removeEventListener('pointercancel', onHandlePointerCancel);
    }

    function onHandlePointerDown(which, e) {
        e.preventDefault();
        e.stopPropagation();
        draggingHandle = which;
        // Remember the span at grab time so a zero-movement click does not
        // persist / recreate the annotation or flip ownership.
        dragStartSpan = selected
            ? { s: selected.startOrder, e: selected.endOrder }
            : null;
        var handleEl = handles[which];
        try { handleEl.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
        handleEl.addEventListener('pointermove', onHandlePointerMove);
        handleEl.addEventListener('pointerup', onHandlePointerUp);
        handleEl.addEventListener('pointercancel', onHandlePointerCancel);
    }

    function onHandlePointerCancel(e) {
        if (!draggingHandle) return;
        var handleEl = handles[draggingHandle];
        try { handleEl.releasePointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
        detachHandleDragListeners(handleEl);
        draggingHandle = null;
        dragStartSpan = null;
    }

    function onHandlePointerMove(e) {
        if (!draggingHandle || !selected) return;
        var marker = selected.marker;
        var overlay = marker.parentElement;
        if (!overlay) return;
        var oRect = overlay.getBoundingClientRect();
        var px = e.clientX - oRect.left;
        var py = e.clientY - oRect.top;
        var target = nearestWordOrder(selected.words, px, py, selected.anchorCol);
        if (target === null) return;
        if (draggingHandle === 'start') {
            selected.startOrder = Math.min(target, selected.endOrder);
        } else {
            selected.endOrder = Math.max(target, selected.startOrder);
        }
        var lines = coveredToQuads(
            selected.words, selected.startOrder, selected.endOrder, selected.anchorCol
        );
        repaintMarker(marker, lines);
        positionHandles();
    }

    function onHandlePointerUp(e) {
        if (!draggingHandle || !selected) return;
        var handleEl = handles[draggingHandle];
        try { handleEl.releasePointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
        detachHandleDragListeners(handleEl);
        var startSpan = dragStartSpan;
        draggingHandle = null;
        dragStartSpan = null;

        // A plain click on a handle (span unchanged) must not persist, recreate
        // the annotation, or transfer ownership.
        if (
            startSpan &&
            selected.startOrder === startSpan.s &&
            selected.endOrder === startSpan.e
        ) {
            return;
        }

        var words = selected.words;
        var lines = coveredToQuads(
            words, selected.startOrder, selected.endOrder, selected.anchorCol
        );
        var quadsPdf = lines.map(function (l) { return l.pdf; });
        var anchorParts = [];
        for (var order = selected.startOrder; order <= selected.endOrder; order++) {
            var wd = words[order];
            // Mirror the coveredToQuads column filter so anchor_text never
            // records the neighbouring column's words on a multi-column page.
            if (!wd) continue;
            if (selected.anchorCol != null && wd.col != null && wd.col !== selected.anchorCol) continue;
            anchorParts.push(wd.text);
        }
        var anchorText = anchorParts.join(' ');

        if (typeof deps.onExtendCompleted === 'function' && quadsPdf.length) {
            deps.onExtendCompleted(selected.marker, selected.ann, {
                quadsPdf: quadsPdf,
                anchorText: anchorText,
                pageIdx: selected.pageIdx,
            });
        }
    }

    function createHandles(marker) {
        removeHandles();
        var start = document.createElement('div');
        start.className = 'highlight-anchor-handle highlight-anchor-handle-start';
        var end = document.createElement('div');
        end.className = 'highlight-anchor-handle highlight-anchor-handle-end';
        [start, end].forEach(function (h) {
            h.style.position = 'absolute';
            h.style.width = '8px';
            h.style.zIndex = '30';
            h.style.cursor = 'ew-resize';
            h.style.pointerEvents = 'auto';
        });
        start.addEventListener('pointerdown', function (e) { onHandlePointerDown('start', e); });
        end.addEventListener('pointerdown', function (e) { onHandlePointerDown('end', e); });
        marker.appendChild(start);
        marker.appendChild(end);
        handles = { start: start, end: end };
    }

    function removeHandles() {
        if (handles) {
            // Detach drag listeners and drop drag state: a handle removed
            // mid-drag (e.g. marker re-render) otherwise keeps dispatching
            // captured pointer events into leaked listeners and leaves a stale
            // dragStartSpan behind.
            if (handles.start) detachHandleDragListeners(handles.start);
            if (handles.end) detachHandleDragListeners(handles.end);
            if (handles.start && handles.start.parentNode) handles.start.parentNode.removeChild(handles.start);
            if (handles.end && handles.end.parentNode) handles.end.parentNode.removeChild(handles.end);
        }
        handles = null;
        draggingHandle = null;
        dragStartSpan = null;
    }

    /**
     * Select a highlight marker and show its extend/shorten handles.
     */
    exports.select = async function select(marker, ann, pageIdx) {
        exports.deselect();
        if (!marker || !ann) return;
        var viewer = deps.getViewer && deps.getViewer();
        if (!viewer) return;
        var pageNum = pageIdx + 1;
        var viewport = viewer.getViewportForPage ? viewer.getViewportForPage(pageNum) : null;
        var wrapper = (document.getElementById('pdfGradedContainer') || document)
            .querySelector('.pdf-page-wrapper[data-page-num="' + pageNum + '"]');
        if (!viewport || !wrapper) return;

        var index;
        try {
            index = await buildWordIndex(pageNum, viewport, wrapper);
        } catch (_err) {
            index = null;
        }
        if (!index || !index.words.length) return;

        var quadBoxes = readMarkerQuadBoxes(marker);
        var span = spanFromQuads(index.words, quadBoxes);
        if (!span) return;

        // Anchor the extend to the column the highlight already lives in: the most
        // common column among the words ACTUALLY covered by its quads (span.orders),
        // NOT the [start,end] range — on a multi-column page the range spans
        // interleaved neighbouring-column words and would mis-infer the column
        // (codex 2026-07-20). Single-column pages have one band -> always 0 -> no-op.
        var anchorCol = modeColumn(index.words, span.orders);

        selected = {
            marker: marker,
            ann: ann,
            pageIdx: pageIdx,
            words: index.words,
            startOrder: span.startOrder,
            endOrder: span.endOrder,
            scaleX: index.scaleX,
            scaleY: index.scaleY,
            anchorCol: anchorCol,
        };
        marker.classList.add('highlight-anchor-selected');
        createHandles(marker);
        positionHandles();
    };

    exports.deselect = function deselect() {
        if (selected && selected.marker) {
            selected.marker.classList.remove('highlight-anchor-selected');
        }
        removeHandles();
        selected = null;
        draggingHandle = null;
    };

    exports.destroy = function destroy() {
        exports.deselect();
    };

    // Test-only surface for the pure column-band / quad-grouping helpers. Harmless
    // in production (no state), exercised by the column-awareness vitest suite.
    exports._internals = {
        computeColumnBands: computeColumnBands,
        colOfWord: colOfWord,
        coveredToQuads: coveredToQuads,
        spanFromQuads: spanFromQuads,
        modeColumn: modeColumn,
    };

})(window.PdfPreviewModalHighlightAnchor);

window.PdfPreviewModalHighlightAnchor._version = '1.0.0';

window.AEMS = window.AEMS || {};
window.AEMS.pdfPreview = window.AEMS.pdfPreview || {};
window.AEMS.pdfPreview.highlightAnchor = window.PdfPreviewModalHighlightAnchor;
