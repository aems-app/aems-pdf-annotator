import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Column-awareness of text-anchored highlight extend/shorten (codex 2026-07-20
 * findings 1 + review-2 P1a). On a multi-column page the word index interleaves
 * both columns' words at the same visual row; a plain [startOrder,endOrder] sweep
 * would drag in the neighbouring column. A LINE-AWARE persistent-gutter classifier
 * (computeColumnBands) + the coveredToQuads column filter keep an extend inside the
 * anchor's column. It must survive a full-width heading (still 2 columns) and must
 * NOT split a single-column page that has centered/indented lines (still 1 band ->
 * strict no-op, the exam corpus).
 */

const MODULE_PATH = '../src/pdf-preview-modal/highlight-anchor.js';

const loadModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalHighlightAnchor._internals;
};

const LINE_H = 18;
const ROW_STEP = 24;

/** A word rect in page-relative px (+ a dummy pdfRect), row centered at y. */
function word(text, x0, y, x1) {
  const y0 = y - LINE_H / 2;
  const y1 = y + LINE_H / 2;
  return {
    text,
    px0: x0, py0: y0, px1: x1, py1: y1,
    cx: (x0 + x1) / 2, cy: y,
    pdfRect: [x0, y0, x1, y1],
  };
}

const yOf = (row) => 100 + row * ROW_STEP;

describe('highlight-anchor column awareness', () => {
  let internals;
  beforeEach(async () => {
    vi.resetModules();
    delete window.PdfPreviewModalHighlightAnchor;
    internals = await loadModule();
  });

  it('single-column page (many rows) yields one band; the filter is a no-op', () => {
    const words = [];
    for (let r = 0; r < 8; r++) words.push(word(`line${r}`, 50, yOf(r), 540));
    const bands = internals.computeColumnBands(words);
    expect(bands.length).toBe(1);
    words.forEach((w) => expect(internals.colOfWord(w, bands)).toBe(0));
  });

  it('single-column with centered equations still yields ONE band (no false split)', () => {
    const words = [];
    for (let r = 0; r < 6; r++) words.push(word(`fulltextrow${r}`, 50, yOf(r), 540));
    words.push(word('x=y+z', 240, yOf(6), 360)); // centered short equation
    words.push(word('a=b-c', 250, yOf(7), 350)); // centered short equation
    const bands = internals.computeColumnBands(words);
    expect(bands.length).toBe(1);
  });

  it('numbered single-column list (label + body) stays ONE band', () => {
    // codex round-4 P1: "1.  body text ..." rows have a persistent label/body gap
    // that looks like a gutter, but the label column is thin with one word/row.
    const words = [];
    for (let r = 0; r < 8; r++) {
      const y = yOf(r);
      words.push(word(`${r + 1}.`, 50, y, 72)); // narrow marker column
      // multi-word body (so the marker column holds a low share of the words)
      for (let c = 0; c < 6; c++) {
        const x0 = 100 + c * 73;
        words.push(word(`b${r}_${c}`, x0, y, x0 + 66));
      }
    }
    expect(internals.computeColumnBands(words).length).toBe(1);
  });

  it('SHORT two-column page under a heading still splits (heading tolerated)', () => {
    // codex round-4 P1: 5 paired rows + one full-width heading must still split;
    // a single heading crossing must not defeat detection.
    const words = [
      word('SECTION', 50, yOf(0), 180),
      word('HEADING', 190, yOf(0), 320),
      word('FULLWIDTH', 400, yOf(0), 540),
    ];
    for (let r = 1; r <= 5; r++) {
      words.push(word(`L${r}`, 50, yOf(r), 250));
      words.push(word(`R${r}`, 340, yOf(r), 540));
    }
    expect(internals.computeColumnBands(words).length).toBe(2);
  });

  it('two-column page (many rows) splits into two bands', () => {
    const words = [];
    for (let r = 0; r < 8; r++) {
      words.push(word(`L${r}`, 50, yOf(r), 250));
      words.push(word(`R${r}`, 340, yOf(r), 540));
    }
    const bands = internals.computeColumnBands(words);
    expect(bands.length).toBe(2);
  });

  it('two-column page with STAGGERED baselines still splits (codex round-5/6)', () => {
    // Right column offset by ~2/3 of a font height (11px on 18px text) — beyond
    // both the old centre tolerance (round-5) and the union-expand grouping that
    // transitively bridged at this offset (round-6). Seed-based overlap grouping
    // unifies the staggered halves so the straddle test detects the gutter.
    const OFFSET = 11;
    const words = [];
    for (let r = 0; r < 10; r++) {
      words.push(word(`L${r}`, 50, yOf(r), 250));
      words.push(word(`R${r}`, 340, yOf(r) + OFFSET, 540));
    }
    expect(internals.computeColumnBands(words).length).toBe(2);
  });

  it('two-column page under a full-width heading still splits into two bands', () => {
    const words = [word('HEADINGSPANSTHEFULLWIDTH', 50, yOf(0), 540)];
    for (let r = 1; r < 9; r++) {
      words.push(word(`L${r}`, 50, yOf(r), 250));
      words.push(word(`R${r}`, 340, yOf(r), 540));
    }
    const bands = internals.computeColumnBands(words);
    expect(bands.length).toBe(2);
  });

  it('coveredToQuads excludes the neighbouring column when anchored', () => {
    // Interleaved reading order as buildWordIndex would produce: per row [L, R].
    const raw = [];
    for (let r = 0; r < 5; r++) {
      raw.push(word(`L${r}`, 50, yOf(r), 250));
      raw.push(word(`R${r}`, 340, yOf(r), 540));
    }
    const bands = internals.computeColumnBands(raw);
    expect(bands.length).toBe(2);
    raw.forEach((w, i) => { w.order = i; w.col = internals.colOfWord(w, bands); });

    // Unconstrained sweep across rows straddles the gutter -> both columns painted.
    const noFilter = internals.coveredToQuads(raw, 0, 8);
    const xsAll = noFilter.flatMap((l) => [l.box[0], l.box[2]]);
    expect(Math.max(...xsAll)).toBeGreaterThan(300);

    // Anchored to column 0 -> only left-column runs, never crossing the gutter.
    const filtered = internals.coveredToQuads(raw, 0, 8, 0);
    expect(filtered.length).toBeGreaterThan(0);
    filtered.forEach((l) => {
      expect(l.box[2]).toBeLessThanOrEqual(250 + 1);
    });
  });

  it('anchorCol is inferred from the covered words, not the interleaved range', () => {
    // Row buckets interleave columns as [La, Lb, Ra, Rb, Rc]. A left-column phrase
    // wrapping from Lb(row0) to La(row1) has an ORDER RANGE that contains 3
    // right-column words -> a range-mode picks the RIGHT column (codex 2026-07-20
    // P1a). Covered-mode (over the words truly in the quads) picks LEFT.
    const cols = [0, 0, 1, 1, 1, 0, 0, 1]; // La0 Lb0 Ra0 Rb0 Rc0 La1 Lb1 Ra1
    const words = cols.map((c, i) => ({ col: c, order: i }));
    const coveredOrders = [1, 5]; // Lb0, La1 — the wrapping left phrase
    expect(internals.modeColumn(words, coveredOrders)).toBe(0); // fix: left
    // Range 1..5 = Lb0,Ra0,Rb0,Rc0,La1 -> 2 left / 3 right -> right (the old bug).
    expect(internals.modeColumn(words, [1, 2, 3, 4, 5])).toBe(1);
  });

  it('spanFromQuads returns only the words inside the quads (not the range)', () => {
    const words = [
      { text: 'Lb0', cx: 70, cy: 100, col: 0 },
      { text: 'Ra0', cx: 400, cy: 100, col: 1 },
      { text: 'La1', cx: 70, cy: 126, col: 0 },
    ].map((w, i) => ({
      ...w, order: i, px0: w.cx - 10, px1: w.cx + 10, py0: w.cy - 6, py1: w.cy + 6,
    }));
    const quads = [
      { x0: 55, y0: 92, x1: 90, y1: 108 }, // covers Lb0
      { x0: 55, y0: 118, x1: 90, y1: 134 }, // covers La1
    ];
    const span = internals.spanFromQuads(words, quads);
    expect(span.orders.slice().sort((a, b) => a - b)).toEqual([0, 2]); // NOT Ra0(1)
    expect(internals.modeColumn(words, span.orders)).toBe(0);
  });
});
