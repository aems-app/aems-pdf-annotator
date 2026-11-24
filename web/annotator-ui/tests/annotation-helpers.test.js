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

// H1-r2: the source the UI displays defaults an unrecorded marker to "AI"; the source it SENDS
// must be the recorded one only, or one click relabels a legacy teacher marker "AEMS".
describe('recorded annotation source', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalAnnotationHelpers;
  });

  it.each([
    [{ source: 'AI' }, 'AI'],
    [{ source: 'HUMAN' }, 'HUMAN'],
    [{ source: null }, null],
    [{}, null],
    [{ source: 'ai' }, null],
    [{ is_system_generated: true }, null],
  ])('%j records %s', async (ann, expected) => {
    const helpers = await loadAnnotationHelpersModule();
    expect(helpers.recordedAnnotationSource(ann)).toBe(expected);
  });

  it('the displayed source still defaults to AI for an unrecorded marker', async () => {
    const helpers = await loadAnnotationHelpersModule();
    expect(helpers.resolveAnnotationSource({ source: null })).toBe('AI');
  });

  it('a verdict toggle names the recorded source only', async () => {
    const helpers = await loadAnnotationHelpersModule();
    expect(helpers.verdictToggleBody({ source: 'AI' }, true)).toEqual({ is_verdict: true, source: 'AI' });
    expect(helpers.verdictToggleBody({ source: 'HUMAN' }, false)).toEqual({ is_verdict: false, source: 'HUMAN' });
    expect(helpers.verdictToggleBody({ source: null }, true)).toEqual({ is_verdict: true });
    expect(helpers.verdictToggleBody({}, false)).toEqual({ is_verdict: false });
  });
});
