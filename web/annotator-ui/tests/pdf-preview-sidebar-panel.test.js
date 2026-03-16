import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/sidebar-panel.js';

const loadSidebarPanelModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalSidebarPanel;
};

describe('pdf preview sidebar panel name formatting', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalSidebarPanel;
  });

  it('formats full mode as given name(s) plus surname initial', async () => {
    const sidebarPanel = await loadSidebarPanelModule();
    expect(
      sidebarPanel.formatDisplayName('Artem Kulachenko (Instructor)', sidebarPanel.NAME_DISPLAY_MODE.FULL),
    ).toBe('Artem K.');
    expect(
      sidebarPanel.formatDisplayName('Eva-Karin Lindtrom', sidebarPanel.NAME_DISPLAY_MODE.FULL),
    ).toBe('Eva-Karin L.');
    expect(
      sidebarPanel.formatDisplayName('Anna Maria Lindtrom', sidebarPanel.NAME_DISPLAY_MODE.FULL),
    ).toBe('Anna Maria L.');
  });

  it('formats reduced mode as initials only', async () => {
    const sidebarPanel = await loadSidebarPanelModule();
    expect(
      sidebarPanel.formatDisplayName('Artem Kulachenko', sidebarPanel.NAME_DISPLAY_MODE.REDUCED),
    ).toBe('A.K.');
    expect(
      sidebarPanel.formatDisplayName('Eva-Karin Lindtrom', sidebarPanel.NAME_DISPLAY_MODE.REDUCED),
    ).toBe('E-K.L.');
    expect(
      sidebarPanel.formatDisplayName('Anna Maria Lindtrom', sidebarPanel.NAME_DISPLAY_MODE.REDUCED),
    ).toBe('A.M.L.');
  });

  it('keeps single-token names as-is', async () => {
    const sidebarPanel = await loadSidebarPanelModule();
    expect(sidebarPanel.formatDisplayName('Artem', sidebarPanel.NAME_DISPLAY_MODE.REDUCED)).toBe('Artem');
  });

  it('keeps abbreviateName backward compatible with full mode', async () => {
    const sidebarPanel = await loadSidebarPanelModule();
    expect(sidebarPanel.abbreviateName('Artem Kulachenko')).toBe('Artem K.');
  });
});
