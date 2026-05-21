import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/modal-shell.js';

describe('createModalShell', () => {
  let modalEl, fullscreenBtn, splitPanelBtn, markupBtn, gradedTab, originalTab;

  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalShell;

    // Set up minimal DOM
    document.body.innerHTML = `
      <div id="pdfPreviewModal" class="modal">
        <button id="pdfPreviewFullscreenToggle">
          <i class="bi bi-fullscreen"></i>
          <span class="d-none d-sm-inline">Fullscreen</span>
        </button>
        <button id="pdfPreviewSplitPanelToggle" class="d-none">
          <i class="bi bi-layout-three-columns"></i>
        </button>
        <button class="js-toggle-markup">
          <i class="bi bi-pencil"></i>
        </button>
        <button id="pdfOriginalTab">Original</button>
        <button id="pdfGradedTab">Graded</button>
      </div>
    `;

    modalEl = document.getElementById('pdfPreviewModal');
    fullscreenBtn = document.getElementById('pdfPreviewFullscreenToggle');
    splitPanelBtn = document.getElementById('pdfPreviewSplitPanelToggle');
    markupBtn = document.querySelector('.js-toggle-markup');
    originalTab = document.getElementById('pdfOriginalTab');
    gradedTab = document.getElementById('pdfGradedTab');
  });

  async function loadShellModule() {
    await import(new URL(MODULE_PATH, import.meta.url));
    return window.PdfPreviewModalShell;
  }

  it('exports createModalShell function', async () => {
    const mod = await loadShellModule();
    expect(typeof mod.createModalShell).toBe('function');
  });

  it('creates a shell with expected public API', async () => {
    const mod = await loadShellModule();
    const uiState = { fullscreen: false, splitPanelActive: false, activeToolbar: null };
    const shell = mod.createModalShell(uiState, {});

    expect(typeof shell.onFullscreenChanged).toBe('function');
    expect(typeof shell.onSplitPanelToggled).toBe('function');
    expect(typeof shell.onToolbarToggled).toBe('function');
    expect(typeof shell.onClose).toBe('function');
    expect(typeof shell.onResizeNeeded).toBe('function');
    expect(typeof shell.onSearchHighlightNeeded).toBe('function');
    expect(typeof shell.setFullscreen).toBe('function');
    expect(typeof shell.isFullscreen).toBe('function');
    expect(typeof shell.isSplitPanel).toBe('function');
    expect(typeof shell.isMarkupActive).toBe('function');
    expect(typeof shell.destroy).toBe('function');
  });

  it('isFullscreen returns false initially', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell({ fullscreen: false, splitPanelActive: false, activeToolbar: null }, {});
    expect(shell.isFullscreen()).toBe(false);
  });

  it('setFullscreen(true) toggles fullscreen class and icon', async () => {
    const mod = await loadShellModule();
    const uiState = { fullscreen: false, splitPanelActive: false, activeToolbar: null };
    const shell = mod.createModalShell(uiState, {});

    shell.setFullscreen(true);
    expect(shell.isFullscreen()).toBe(true);
    expect(modalEl.classList.contains('preview-fullscreen')).toBe(true);
    expect(fullscreenBtn.querySelector('i').className).toBe('bi bi-fullscreen-exit');
    expect(uiState.fullscreen).toBe(true);

    shell.setFullscreen(false);
    expect(shell.isFullscreen()).toBe(false);
    expect(modalEl.classList.contains('preview-fullscreen')).toBe(false);
    expect(fullscreenBtn.querySelector('i').className).toBe('bi bi-fullscreen');
    expect(uiState.fullscreen).toBe(false);
  });

  it('emits onFullscreenChanged when state changes', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell({ fullscreen: false, splitPanelActive: false, activeToolbar: null }, {});
    const handler = vi.fn();
    shell.onFullscreenChanged(handler);

    shell.setFullscreen(true);
    expect(handler).toHaveBeenCalledWith({ active: true });

    shell.setFullscreen(false);
    expect(handler).toHaveBeenCalledWith({ active: false });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not emit onFullscreenChanged when state does not change', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell({ fullscreen: false, splitPanelActive: false, activeToolbar: null }, {});
    const handler = vi.fn();
    shell.onFullscreenChanged(handler);

    shell.setFullscreen(false); // Already false
    expect(handler).not.toHaveBeenCalled();
  });

  it('split panel toggle only works in fullscreen mode', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell({ fullscreen: false, splitPanelActive: false, activeToolbar: null }, {});

    shell.toggleSplitPanel();
    expect(shell.isSplitPanel()).toBe(false);

    shell.setFullscreen(true);
    shell.toggleSplitPanel();
    expect(shell.isSplitPanel()).toBe(true);
  });

  it('emits onSplitPanelToggled when toggling split panel', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell({ fullscreen: false, splitPanelActive: false, activeToolbar: null }, {});
    const handler = vi.fn();
    shell.onSplitPanelToggled(handler);

    shell.setFullscreen(true);
    shell.toggleSplitPanel();
    expect(handler).toHaveBeenCalledWith({ active: true });
  });

  it('split panel deactivates when fullscreen exits', async () => {
    const mod = await loadShellModule();
    const uiState = { fullscreen: false, splitPanelActive: false, activeToolbar: null };
    const shell = mod.createModalShell(uiState, {});

    shell.setFullscreen(true);
    shell.setSplitPanel(true);
    expect(shell.isSplitPanel()).toBe(true);

    shell.setFullscreen(false);
    expect(shell.isSplitPanel()).toBe(false);
    expect(splitPanelBtn.classList.contains('d-none')).toBe(true);
  });

  it('toggleMarkupMode toggles markup state', async () => {
    const mod = await loadShellModule();
    const mockDrawingCanvas = {
      setMarkupMode: vi.fn(),
      init: vi.fn(),
      setActiveTool: vi.fn(),
      setActiveColor: vi.fn(),
    };
    const mockToolbar = {
      show: vi.fn(),
      hide: vi.fn(),
      getActiveTool: () => 'pen',
      getActiveColor: () => 'red',
    };
    const mockSelection = {
      init: vi.fn(),
      deselect: vi.fn(),
    };

    const shell = mod.createModalShell(
      { fullscreen: false, splitPanelActive: false, activeToolbar: null },
      {
        markupModules: {
          DrawingCanvas: mockDrawingCanvas,
          MarkupToolbar: mockToolbar,
          MarkupSelection: mockSelection,
        },
      }
    );

    shell.toggleMarkupMode();
    expect(shell.isMarkupActive()).toBe(true);
    expect(mockDrawingCanvas.setMarkupMode).toHaveBeenCalledWith(true);
    expect(mockToolbar.show).toHaveBeenCalled();
  });

  it('emits onToolbarToggled when markup is toggled', async () => {
    const mod = await loadShellModule();
    const handler = vi.fn();
    const shell = mod.createModalShell(
      { fullscreen: false, splitPanelActive: false, activeToolbar: null },
      {}
    );
    shell.onToolbarToggled(handler);
    shell.toggleMarkupMode();
    expect(handler).toHaveBeenCalledWith({ active: true });
  });

  it('exitFullscreen respects isEditingFn', async () => {
    const mod = await loadShellModule();
    const shell = mod.createModalShell(
      { fullscreen: false, splitPanelActive: false, activeToolbar: null },
      { isEditingFn: () => true }
    );

    // Set fullscreen via setFullscreen (bypass native API)
    shell.setFullscreen(true);
    expect(shell.isFullscreen()).toBe(true);

    // exitFullscreen should be blocked because isEditingFn returns true
    await shell.exitFullscreen();
    // Note: since there's no native fullscreen in jsdom, exitFullscreen
    // falls through to updatePreviewFullscreenUi(false), but the guard
    // should prevent that. Actually, exitFullscreen checks isEditingFn first.
    // In jsdom, document.fullscreenElement is null, so it goes to else branch
    // calling updatePreviewFullscreenUi(false) — but isEditingFn returns early first.
    expect(shell.isFullscreen()).toBe(true);
  });

  it('emits onClose on hidden.bs.modal', async () => {
    const mod = await loadShellModule();
    const handler = vi.fn();
    const shell = mod.createModalShell(
      { fullscreen: false, splitPanelActive: false, activeToolbar: null },
      {}
    );
    shell.onClose(handler);

    // Dispatch hidden.bs.modal event
    modalEl.dispatchEvent(new Event('hidden.bs.modal'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('destroy removes all listeners', async () => {
    const mod = await loadShellModule();
    const handler = vi.fn();
    const shell = mod.createModalShell(
      { fullscreen: false, splitPanelActive: false, activeToolbar: null },
      {}
    );
    shell.onFullscreenChanged(handler);

    shell.destroy();

    // After destroy, clicking fullscreen button should not toggle
    fullscreenBtn.click();
    // Since listener is removed, handler should not be called
    expect(handler).not.toHaveBeenCalled();
  });

  it('syncs uiState slices correctly', async () => {
    const mod = await loadShellModule();
    const uiState = { visible: false, fullscreen: false, splitPanelActive: false, activeToolbar: null, activeTab: 'graded' };
    const shell = mod.createModalShell(uiState, {});

    shell.setFullscreen(true);
    expect(uiState.fullscreen).toBe(true);

    shell.setFullscreen(false);
    shell.setFullscreen(true);
    shell.setSplitPanel(true);
    expect(uiState.splitPanelActive).toBe(true);
    expect(uiState.fullscreen).toBe(true);

    shell.toggleMarkupMode();
    expect(uiState.activeToolbar).toBe('markup');

    shell.toggleMarkupMode();
    expect(uiState.activeToolbar).toBe(null);
  });

  it('tracks modal visibility in uiState', async () => {
    const mod = await loadShellModule();
    const uiState = { visible: false, fullscreen: false, splitPanelActive: false, activeToolbar: null, activeTab: 'graded' };
    mod.createModalShell(uiState, {});

    modalEl.classList.add('show');
    modalEl.dispatchEvent(new Event('show.bs.modal'));
    expect(uiState.visible).toBe(true);

    modalEl.classList.remove('show');
    modalEl.dispatchEvent(new Event('hidden.bs.modal'));
    expect(uiState.visible).toBe(false);
  });

  it('emits onTabSwitched and syncs uiState.activeTab', async () => {
    const mod = await loadShellModule();
    const uiState = { visible: false, fullscreen: false, splitPanelActive: false, activeToolbar: null, activeTab: 'graded' };
    const shell = mod.createModalShell(uiState, {});
    const handler = vi.fn();

    shell.onTabSwitched(handler);
    gradedTab.dispatchEvent(new Event('shown.bs.tab'));
    originalTab.dispatchEvent(new Event('shown.bs.tab'));

    expect(handler).toHaveBeenNthCalledWith(1, { tab: 'graded' });
    expect(handler).toHaveBeenNthCalledWith(2, { tab: 'original' });
    expect(uiState.activeTab).toBe('original');
  });
});
