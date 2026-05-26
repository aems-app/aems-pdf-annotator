import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/utils.js';

async function loadUtilsModule() {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalUtils;
}

describe('pdf-preview utils annotation routing', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalUtils;
    delete window.AEMS;
    delete window.__WIZARD_MODE;
  });

  it('keeps local-agent annotation requests on agent routes inside offline wizard pages', async () => {
    window.__WIZARD_MODE = 'offline';

    const utils = await loadUtilsModule();

    expect(utils.shouldUseOfflineAnnotationRoutes('local')).toBe(false);
  });

  it('uses offline routes for true offline preview sessions', async () => {
    window.__WIZARD_MODE = 'offline';

    const utils = await loadUtilsModule();

    expect(utils.shouldUseOfflineAnnotationRoutes('offline')).toBe(true);
  });

  it('falls back to the page-level wizard mode when assignment mode is unknown', async () => {
    const utils = await loadUtilsModule();

    window.__WIZARD_MODE = 'offline';
    expect(utils.shouldUseOfflineAnnotationRoutes(null)).toBe(true);

    delete window.__WIZARD_MODE;
    expect(utils.shouldUseOfflineAnnotationRoutes(null)).toBe(false);
  });
});
