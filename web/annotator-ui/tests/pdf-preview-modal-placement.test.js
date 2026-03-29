import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal.js';

const loadPlacementHelpers = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModal.__test;
};

function createMarker({
  taskId = '',
  checkId = '',
  labelText = '',
  fullText = '',
  page = '0',
} = {}) {
  const marker = document.createElement('div');
  marker.className = 'annotation-marker';
  marker.dataset.annotationTaskId = taskId;
  marker.dataset.annotationCheckId = checkId;
  marker.dataset.annotationPage = String(page);

  const label = document.createElement('div');
  label.className = 'annotation-label';
  if (fullText) {
    label.dataset.fullText = fullText;
  }
  label.textContent = labelText || fullText;
  marker.appendChild(label);
  document.body.appendChild(marker);

  return { marker, label };
}

function createPlacementEntry({
  taskGroupKey = '',
  checkId = '',
  top,
  left = 0,
  height = 12,
  width = 120,
  baseTop = top,
  baseBottom,
  page = '0',
} = {}) {
  const { marker, label } = createMarker({ checkId, page });
  const bottom = top + height;
  return {
    label,
    marker,
    taskGroupKey,
    markerRect: {
      top,
      left,
      height,
      width,
      right: left + width,
      bottom,
    },
    baseRect: {
      top: baseTop,
      left,
      width,
      height,
      right: left + width,
      bottom: baseBottom ?? (baseTop + height),
    },
  };
}

describe('pdf-preview-modal placement helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.AEMSPdfAnnotator;
    delete window.PdfPreviewModal;
    delete window.PdfPreviewModalUtils;
    delete window.PdfPreviewModalStateCore;
    delete window.PdfPreviewModalViewer;
    delete window.PDFViewer;
    document.body.innerHTML = `
      <div id="pdfPreviewModal"></div>
      <div id="pdfOriginalPane"></div>
      <div id="pdfGradedPane"></div>
      <button id="pdfOriginalTab"></button>
      <button id="pdfGradedTab"></button>
      <button id="pdfPreviewFullscreenToggle"></button>
      <button id="pdfPreviewSplitPanelToggle"></button>
      <button class="js-toggle-markup"></button>
      <div id="pdfGradedCommentsList"></div>
      <div id="pdfGradedAICommentsList"></div>
      <div id="pdfModelACommentsList"></div>
      <div id="pdfModelBCommentsList"></div>
      <div id="pdfGradedContainer"></div>
      <div id="pdfOriginalContainer"></div>
    `;
    window.bootstrap = {
      Modal: {
        getInstance: () => null,
      },
    };
  });

  it('derives the task group key from task id, check id, or label text', async () => {
    const { deriveMarkerTaskGroupKey } = await loadPlacementHelpers();

    const direct = createMarker({
      taskId: 'Q2',
      checkId: 'Q9-1',
      labelText: 'Q7: ignored',
    }).marker;
    const fromCheck = createMarker({
      checkId: 'q4-3_SUMMARY',
    }).marker;
    const fromLabel = createMarker({
      labelText: 'q6: final answer',
    }).marker;

    expect(deriveMarkerTaskGroupKey(direct)).toBe('Q2');
    expect(deriveMarkerTaskGroupKey(fromCheck)).toBe('Q4');
    expect(deriveMarkerTaskGroupKey(fromLabel)).toBe('Q6');
  });

  it('detects summary placement entries from the marker check id', async () => {
    const { isSummaryPlacementEntry } = await loadPlacementHelpers();
    const summaryEntry = createPlacementEntry({
      checkId: 'Q3_SUMMARY',
      top: 40,
    });
    const normalEntry = createPlacementEntry({
      checkId: 'Q3-2',
      top: 60,
    });

    expect(isSummaryPlacementEntry(summaryEntry)).toBe(true);
    expect(isSummaryPlacementEntry(normalEntry)).toBe(false);
  });

  it('sorts summaries last and otherwise orders entries by top then left', async () => {
    const { compareTaskPlacementEntries } = await loadPlacementHelpers();
    const entries = [
      createPlacementEntry({
        checkId: 'Q5_SUMMARY',
        top: 20,
        left: 0,
      }),
      createPlacementEntry({
        checkId: 'Q5-2',
        top: 100,
        left: 60,
      }),
      createPlacementEntry({
        checkId: 'Q5-1',
        top: 100.5,
        left: 20,
      }),
    ];

    const orderedCheckIds = entries
      .slice()
      .sort(compareTaskPlacementEntries)
      .map((entry) => entry.marker.dataset.annotationCheckId);

    expect(orderedCheckIds).toEqual(['Q5-1', 'Q5-2', 'Q5_SUMMARY']);
  });

  it('builds non-overlapping placement bands between adjacent task groups', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 400 };
    const q1 = createPlacementEntry({
      taskGroupKey: 'Q1',
      top: 40,
      baseTop: 30,
      baseBottom: 60,
    });
    const q2 = createPlacementEntry({
      taskGroupKey: 'Q2',
      top: 140,
      baseTop: 130,
      baseBottom: 160,
    });

    const bands = buildTaskPlacementBands([q1, q2], pageBounds, 8);

    expect(bands.get('Q1')).toEqual({
      left: 0,
      right: 300,
      top: 0,
      bottom: 87,
    });
    expect(bands.get('Q2')).toEqual({
      left: 0,
      right: 300,
      top: 103,
      bottom: 400,
    });
    expect(bands.get('Q1').bottom).toBeLessThan(bands.get('Q2').top);
  });

  it('falls back to midpoint-only bands when seam padding would collapse a middle group', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 300 };
    const entries = [
      createPlacementEntry({
        taskGroupKey: 'Q1',
        top: 90,
        baseTop: 80,
        baseBottom: 100,
      }),
      createPlacementEntry({
        taskGroupKey: 'Q2',
        top: 104,
        baseTop: 104,
        baseBottom: 108,
      }),
      createPlacementEntry({
        taskGroupKey: 'Q3',
        top: 112,
        baseTop: 112,
        baseBottom: 120,
      }),
    ];

    const bands = buildTaskPlacementBands(entries, pageBounds, 8);

    expect(bands.get('Q2')).toEqual({
      left: 0,
      right: 300,
      top: 103,
      bottom: 114,
    });
  });

  it('assigns an ungrouped entry to a page fallback band when no task anchors exist', async () => {
    const { buildTaskPlacementBands } = await loadPlacementHelpers();
    const pageBounds = { left: 0, top: 0, right: 300, bottom: 300 };
    const entry = createPlacementEntry({
      top: 24,
      baseTop: 18,
      baseBottom: 42,
      page: '7',
    });

    const bands = buildTaskPlacementBands([entry], pageBounds, 6);

    expect(entry.taskGroupKey).toBe('page-7');
    expect(bands.get('page-7')).toEqual({
      left: 0,
      right: 300,
      top: 0,
      bottom: 300,
    });
  });
});
