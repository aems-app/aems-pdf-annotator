import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODULE_PATH = '../src/pdf-preview-modal/annotation-helpers.js';

const loadAnnotationHelpersModule = async () => {
  await import(new URL(MODULE_PATH, import.meta.url));
  return window.PdfPreviewModalAnnotationHelpers;
};

describe('annotation identifier helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalAnnotationHelpers;
  });

  it('keeps a bare numeric stable-only identifier in the stable namespace', async () => {
    const helpers = await loadAnnotationHelpersModule();

    expect(helpers.buildApiAnnotationIdentifier({ identifier: '123' })).toBe('id:123');
    expect(helpers.buildApiAnnotationIdentifier({ requestId: '456' })).toBe('id:456');
  });
});
