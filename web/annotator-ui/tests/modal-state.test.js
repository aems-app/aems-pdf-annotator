import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/modal-state.js';

const loadModalStateModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalStateCore;
};

describe('createModalState', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalStateCore;
  });

  it('initializes options slice from caller input', async () => {
    const modalState = await loadModalStateModule();
    const state = modalState.createModalState({ assignmentId: 42, mode: 'server' });
    expect(state.options.assignmentId).toBe(42);
  });

  it('initializes empty slices for document, annotations, ui, sync', async () => {
    const modalState = await loadModalStateModule();
    const state = modalState.createModalState({ assignmentId: 42, mode: 'server' });
    expect(state.document.currentPage).toBe(0);
    expect(state.annotations.annotationsData).toEqual({});
    expect(state.ui.visible).toBe(false);
    expect(state.sync.versionToken).toBe(null);
  });

  it('freezes options slice after creation', async () => {
    const modalState = await loadModalStateModule();
    const state = modalState.createModalState({ assignmentId: 42, mode: 'server' });
    expect(Object.isFrozen(state.options)).toBe(true);
  });
});

describe('deriveCapabilities', () => {
  it('derives annotationCrud=true for server mode', async () => {
    const modalState = await loadModalStateModule();
    const caps = modalState.deriveCapabilities(null, 'server');
    expect(caps.annotationCrud).toBe(true);
  });

  it('checks modeAdapter.supportsAnnotationCrud() for local mode', async () => {
    const modalState = await loadModalStateModule();
    const mockAdapter = { supportsAnnotationCrud: () => false };
    const caps = modalState.deriveCapabilities(mockAdapter, 'local');
    expect(caps.annotationCrud).toBe(false);
  });

  it('applies overrides on top of derived defaults', async () => {
    const modalState = await loadModalStateModule();
    const caps = modalState.deriveCapabilities(null, 'server', { markupTools: false });
    expect(caps.markupTools).toBe(false);
    expect(caps.search).toBe(true);
  });

  it('disables comparisonMode in offline mode', async () => {
    const modalState = await loadModalStateModule();
    const caps = modalState.deriveCapabilities(null, 'offline');
    expect(caps.comparisonMode).toBe(false);
  });
});

describe('deriveAnnotatedPdfPolicy', () => {
  it('defaults local mode to local_required', async () => {
    const modalState = await loadModalStateModule();
    expect(modalState.deriveAnnotatedPdfPolicy('local')).toBe('local_required');
  });

  it('defaults offline mode to offline_only', async () => {
    const modalState = await loadModalStateModule();
    expect(modalState.deriveAnnotatedPdfPolicy('offline')).toBe('offline_only');
  });

  it('keeps explicit override when provided', async () => {
    const modalState = await loadModalStateModule();
    expect(modalState.deriveAnnotatedPdfPolicy('local', 'server_allowed')).toBe('server_allowed');
  });
});
