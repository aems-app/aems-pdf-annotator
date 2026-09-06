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
    clearRect: vi.fn(),
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
    window.PdfPreviewModalDrawingCanvas?.destroy();
    vi.restoreAllMocks();
  });

  it('ignores a stroke load that arrives after destroy', async () => {
    // loadStrokesFromAnnotations() begins with an unconditional
    // pageStrokes.clear(). Several callers now DEFER it behind a drawing guard,
    // so one can fire after the modal closed -- wiping the store of whatever
    // session is open by then, which is the exact loss #472 is about.
    const module = await loadDrawingCanvasModule();
    module.loadStrokesFromAnnotations([
      { type: 'drawing', page_index: 0, points: [[1, 2], [3, 4]], drawing_style: 'pen' },
    ]);
    expect(module.getPageStrokes(0)).toHaveLength(1);

    module.destroy();

    // The late call carries strokes, so "ignored" and "applied" differ: without
    // the guard these land in a destroyed module's store.
    module.loadStrokesFromAnnotations([
      { type: 'drawing', page_index: 0, points: [[5, 6], [7, 8]], drawing_style: 'pen' },
      { type: 'drawing', page_index: 1, points: [[9, 9], [10, 10]], drawing_style: 'pen' },
    ]);
    expect(module.getPageStrokes(0), 'a destroyed module accepted a stroke load')
      .toHaveLength(0);
    expect(module.getPageStrokes(1), 'a destroyed module accepted a stroke load')
      .toHaveLength(0);

    // Re-init is what a reopened modal does; the store must be usable again.
    if (typeof module.init === 'function') module.init();
    module.loadStrokesFromAnnotations([
      { type: 'drawing', page_index: 0, points: [[5, 6], [7, 8]], drawing_style: 'pen' },
    ]);
    expect(
      module.getPageStrokes(0),
      'the module stayed refusing work after re-init',
    ).toHaveLength(1);
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

  it('finishes a stroke through the document when its canvas is detached mid-drag', async () => {
    const ctx = createMockContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const wrapper = document.createElement('div');
    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = 600;
    pdfCanvas.height = 800;
    wrapper.appendChild(pdfCanvas);
    document.body.appendChild(wrapper);

    const module = await loadDrawingCanvasModule();
    module.setActiveTool('pen');
    const { canvas } = module.ensureCanvasForPage(0, wrapper);
    canvas.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      right: 310,
      bottom: 420,
      width: 300,
      height: 400,
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const completed = vi.fn();
    module.onStrokeComplete = completed;

    const dispatchPointer = (target, type, { x, y }) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: y,
      });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      target.dispatchEvent(event);
    };

    dispatchPointer(canvas, 'pointerdown', { x: 40, y: 60 });
    dispatchPointer(canvas, 'pointermove', { x: 70, y: 100 });
    canvas.remove();
    dispatchPointer(document, 'pointermove', { x: 100, y: 140 });
    dispatchPointer(document, 'pointerup', { x: 130, y: 180 });

    expect(completed).toHaveBeenCalledTimes(1);
    const stroke = completed.mock.calls[0][1];
    expect(stroke.points).toEqual([
      { x: 60, y: 80 },
      { x: 120, y: 160 },
      { x: 180, y: 240 },
      { x: 240, y: 320 },
    ]);
    expect(module.getPageStrokes(0)).toHaveLength(1);
  });

  it('appends one point per event when the overlay is REPLACED mid-drag', async () => {
    // Regression: renderSkeleton() does not merely detach the overlay, it installs a
    // replacement in a fresh wrapper. The replacement carries its own pointer
    // listeners, and the document-level fallback only skipped `e.target ===
    // activeStrokeCanvas` -- the OLD, detached canvas. Both handlers therefore
    // appended the same pointer event, one through the replacement's live rect and
    // one through the transform frozen at pointerdown, so the stored stroke
    // interleaved two coordinate frames. Measured live on a real server: 17
    // pointermoves produced 31 points with 27 x-direction reversals, rendered into
    // the student's annotated PDF as a sawtooth.
    const ctx = createMockContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const makeWrapper = () => {
      const wrapper = document.createElement('div');
      const pdfCanvas = document.createElement('canvas');
      pdfCanvas.width = 600;
      pdfCanvas.height = 800;
      wrapper.appendChild(pdfCanvas);
      document.body.appendChild(wrapper);
      return wrapper;
    };

    const module = await loadDrawingCanvasModule();
    module.setActiveTool('pen');

    const firstWrapper = makeWrapper();
    const { canvas } = module.ensureCanvasForPage(0, firstWrapper);
    canvas.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 310, bottom: 420, width: 300, height: 400,
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const completed = vi.fn();
    module.onStrokeComplete = completed;

    const dispatchPointer = (target, type, { x, y }) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      target.dispatchEvent(event);
    };

    dispatchPointer(canvas, 'pointerdown', { x: 40, y: 60 });
    dispatchPointer(canvas, 'pointermove', { x: 70, y: 100 });

    // renderSkeleton(): the container is wiped and the page wrappers rebuilt. The
    // replacement overlay sits at a different on-screen position because the
    // fullscreen layout changed, while canvas.width (the document frame) is
    // unchanged -- viewer.scale is a constant and only the CSS box moves.
    firstWrapper.remove();
    const secondWrapper = makeWrapper();
    const replacement = module.ensureCanvasForPage(0, secondWrapper).canvas;
    expect(replacement).not.toBe(canvas);
    replacement.getBoundingClientRect = () => ({
      left: 40, top: 50, right: 340, bottom: 450, width: 300, height: 400,
    });
    replacement.setPointerCapture = vi.fn();
    replacement.releasePointerCapture = vi.fn();

    // Events now target the replacement overlay and bubble up to document.
    dispatchPointer(replacement, 'pointermove', { x: 100, y: 140 });
    dispatchPointer(replacement, 'pointermove', { x: 130, y: 180 });
    dispatchPointer(replacement, 'pointerup', { x: 160, y: 220 });

    expect(completed).toHaveBeenCalledTimes(1);
    const stroke = completed.mock.calls[0][1];
    // Two points from the owning canvas, then one per post-rebuild pointermove,
    // each mapped through the overlay that is actually mounted. Never eight.
    expect(stroke.points).toEqual([
      { x: 60, y: 80 },
      { x: 120, y: 160 },
      { x: 120, y: 180 },
      { x: 180, y: 260 },
    ]);
    expect(module.getPageStrokes(0)).toHaveLength(1);
  });

  it('does not extend the stroke with the coordinates of a pointercancel', async () => {
    // A cancellation is not a terminal sample. Routing document pointercancel
    // through the pointerup path appended the cancel event's coordinates, which
    // for a cancel raised far from the stroke produced an off-page Ink rect
    // (measured: [-164.4, -294.7, 309.6, 300.9] on an A4 page).
    const ctx = createMockContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const wrapper = document.createElement('div');
    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = 600;
    pdfCanvas.height = 800;
    wrapper.appendChild(pdfCanvas);
    document.body.appendChild(wrapper);

    const module = await loadDrawingCanvasModule();
    module.setActiveTool('pen');
    const { canvas } = module.ensureCanvasForPage(0, wrapper);
    canvas.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 310, bottom: 420, width: 300, height: 400,
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const completed = vi.fn();
    module.onStrokeComplete = completed;

    const dispatchPointer = (target, type, { x, y }) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      target.dispatchEvent(event);
    };

    dispatchPointer(canvas, 'pointerdown', { x: 40, y: 60 });
    dispatchPointer(canvas, 'pointermove', { x: 70, y: 100 });
    canvas.remove();
    dispatchPointer(document, 'pointercancel', { x: 0, y: 0 });

    expect(completed).toHaveBeenCalledTimes(1);
    const stroke = completed.mock.calls[0][1];
    expect(stroke.points).toEqual([
      { x: 60, y: 80 },
      { x: 120, y: 160 },
    ]);
    expect(module.isDrawingActive()).toBe(false);
  });

  it('ignores a second pointer while another pointer owns the active stroke', async () => {
    const ctx = createMockContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

    const wrapper = document.createElement('div');
    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = 600;
    pdfCanvas.height = 800;
    wrapper.appendChild(pdfCanvas);
    document.body.appendChild(wrapper);

    const module = await loadDrawingCanvasModule();
    module.setActiveTool('pen');
    const { canvas } = module.ensureCanvasForPage(0, wrapper);
    canvas.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 310, bottom: 420, width: 300, height: 400,
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const completed = vi.fn();
    module.onStrokeComplete = completed;

    const dispatchPointer = (target, type, { x, y }, pointerId) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      target.dispatchEvent(event);
    };

    dispatchPointer(canvas, 'pointerdown', { x: 40, y: 60 }, 7);
    // A second stylus/touch must not overwrite or extend the first stroke.
    dispatchPointer(canvas, 'pointerdown', { x: 200, y: 300 }, 9);
    dispatchPointer(canvas, 'pointermove', { x: 210, y: 310 }, 9);
    dispatchPointer(canvas, 'pointermove', { x: 70, y: 100 }, 7);
    dispatchPointer(canvas, 'pointerup', { x: 70, y: 100 }, 7);

    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][1].points).toEqual([
      { x: 60, y: 80 },
      { x: 120, y: 160 },
    ]);
  });

  it('persists an active stroke before modal teardown clears the local store', async () => {
    const ctx = createMockContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    const wrapper = document.createElement('div');
    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = 600;
    pdfCanvas.height = 800;
    wrapper.appendChild(pdfCanvas);
    document.body.appendChild(wrapper);

    const module = await loadDrawingCanvasModule();
    module.setActiveTool('pen');
    const { canvas } = module.ensureCanvasForPage(0, wrapper);
    canvas.getBoundingClientRect = () => ({
      left: 10, top: 20, right: 310, bottom: 420, width: 300, height: 400,
    });
    canvas.setPointerCapture = vi.fn();
    canvas.releasePointerCapture = vi.fn();
    const completed = vi.fn();
    module.onStrokeComplete = completed;

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: 40, clientY: 60,
    });
    Object.defineProperty(pointerDown, 'pointerId', { value: 7 });
    canvas.dispatchEvent(pointerDown);

    module.destroy();

    expect(completed, 'destroy discarded the active stroke without starting persistence')
      .toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][1].points).toEqual([
      { x: 60, y: 80 },
      { x: 60, y: 80 },
    ]);
    expect(module.isDrawingActive()).toBe(false);
    expect(module.getPageStrokes(0)).toEqual([]);
  });
});
