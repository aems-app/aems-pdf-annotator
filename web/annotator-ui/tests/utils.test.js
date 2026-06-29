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

describe('pdf-preview utils attribute escaping (XSS hardening)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.PdfPreviewModalUtils;
    delete window.AEMS;
  });

  it('escapeHtml does NOT escape quotes (documents why escapeHtmlAttribute exists)', async () => {
    const utils = await loadUtilsModule();
    // Root cause: textContent -> innerHTML serialisation only encodes & < >,
    // never " or '. This makes escapeHtml() unsafe for attribute context.
    expect(utils.escapeHtml('a"b\'c')).toBe('a"b\'c');
    expect(utils.escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('escapeHtmlAttribute encodes the five HTML metacharacters incl. quotes', async () => {
    const utils = await loadUtilsModule();
    expect(utils.escapeHtmlAttribute('a"b\'c&d<e>f'))
      .toBe('a&quot;b&#39;c&amp;d&lt;e&gt;f');
    expect(utils.escapeHtmlAttribute(null)).toBe('');
    expect(utils.escapeHtmlAttribute(undefined)).toBe('');
    expect(utils.escapeHtmlAttribute(42)).toBe('42');
  });

  it('escapeHtmlAttribute output cannot break out of a double-quoted attribute', async () => {
    const utils = await loadUtilsModule();
    delete window.__xssUtils;
    const payload = 'x" onmouseover="window.__xssUtils=1" data-z="';
    const host = document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property -- test asserts the escaper makes this safe
    host.innerHTML = '<span data-id="' + utils.escapeHtmlAttribute(payload) + '">hi</span>';
    const span = host.firstElementChild;
    expect(span.getAttribute('onmouseover')).toBeNull();
    expect(span.hasAttribute('data-z')).toBe(false);
    // Lossless round-trip: the browser decodes the entities back to the raw value.
    expect(span.dataset.id).toBe(payload);
    span.dispatchEvent(new window.Event('mouseover'));
    expect(window.__xssUtils).toBeUndefined();
  });
});
