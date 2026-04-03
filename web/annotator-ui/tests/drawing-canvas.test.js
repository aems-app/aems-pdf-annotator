import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/drawing-canvas.js';

const loadDrawingCanvasModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalDrawingCanvas;
};

function createMockContext() {
  const operations = [];
  const state = {
    strokeStyle: '',
    lineWidth: 0,
    globalCompositeOperation: 'source-over',
  };

  return {
    operations,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    set strokeStyle(value) {
      state.strokeStyle = value;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set lineWidth(value) {
      state.lineWidth = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set globalCompositeOperation(value) {
      state.globalCompositeOperation = value;
    },
    get globalCompositeOperation() {
      return state.globalCompositeOperation;
    },
    set lineCap(_value) {},
    set lineJoin(_value) {},
    set miterLimit(_value) {},
    stroke() {
      operations.push({
        strokeStyle: state.strokeStyle,
        lineWidth: state.lineWidth,
        composite: state.globalCompositeOperation,
      });
    },
  };
}

describe('drawing-canvas stroke rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalDrawingCanvas;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws pen strokes with a contrast underlay plus the final colored stroke', async () => {
    const module = await loadDrawingCanvasModule();
    const ctx = createMockContext();

    module.drawStroke(ctx, {
      style: 'pen',
      points: [{ x: 10, y: 10 }, { x: 30, y: 24 }],
      color: { rgb: [245, 158, 11] },
      strokeWidth: module.PEN_WIDTH,
    }, 1);

    expect(ctx.operations).toHaveLength(2);
    expect(ctx.operations[0]).toMatchObject({
      strokeStyle: `rgba(255, 255, 255, ${module.PEN_UNDERLAY_OPACITY})`,
      composite: 'source-over',
    });
    expect(ctx.operations[0].lineWidth).toBeGreaterThan(ctx.operations[1].lineWidth);
    expect(ctx.operations[1]).toMatchObject({
      strokeStyle: 'rgb(245, 158, 11)',
      lineWidth: module.PEN_WIDTH,
      composite: 'source-over',
    });
  });

  it('keeps highlighter strokes single-pass with multiply blending', async () => {
    const module = await loadDrawingCanvasModule();
    const ctx = createMockContext();

    module.drawStroke(ctx, {
      style: 'highlighter',
      points: [{ x: 8, y: 12 }, { x: 28, y: 18 }],
      color: { rgb: [239, 68, 68] },
      strokeWidth: module.HIGHLIGHTER_WIDTH,
      opacity: module.HIGHLIGHTER_OPACITY,
    }, 1);

    expect(ctx.operations).toHaveLength(1);
    expect(ctx.operations[0]).toMatchObject({
      strokeStyle: `rgba(239, 68, 68, ${module.HIGHLIGHTER_OPACITY})`,
      lineWidth: module.HIGHLIGHTER_WIDTH,
      composite: 'multiply',
    });
  });
});
