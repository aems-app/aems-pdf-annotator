import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function expectTranslated(root) {
  const untranslated = [];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const value = element.getAttribute(attr);
      if (value && !value.startsWith('T:') && !value.startsWith('U:')) untranslated.push(`${attr}: ${value}`);
    }
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || element.matches('textarea, script, style')) continue;
      const value = node.textContent.trim();
      // User data, page numbers and symbolic tool icons are not msgids.
      if (/[A-Za-z]{2}/.test(value) && !value.startsWith('T:') && !value.startsWith('U:')) untranslated.push(value);
    }
  }
  expect(untranslated).toEqual([]);
}

describe('annotator translations', () => {
  let controller;
  let editing;
  let annotations;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(window)) {
      if (key.startsWith('PdfPreviewModal')) delete window[key];
    }
    document.body.innerHTML = '<div id="pdfPreviewModal"><div id="pdfGradedCommentsList"></div></div>';
    window.i18n = { t: vi.fn((key, params = {}) => 'T:' + key.replace(/%\((\w+)\)s/g, (_, name) => params[name])) };
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await import('../src/pdf-preview-modal/utils.js');
    await import('../src/pdf-preview-modal/annotation-helpers.js');
    await import('../src/pdf-preview-modal/sidebar-panel.js');
    await import('../src/pdf-preview-modal/annotation-controller.js');
    await import('../src/pdf-preview-modal/markup-toolbar.js');
    editing = null;
    annotations = { 0: [{ id: 'comment', xref: 1, type: 'Text', content: 'U:Student feedback', source: 'HUMAN', can_revert_to_ai: true }] };
    window.PdfPreviewModalSidebarPanel.shouldDisplayAnnotation = () => true;
    controller = window.PdfPreviewModalAnnotationController.createAnnotationController({
      getAnnotationsData: () => annotations,
      getEditingAnnotationId: () => editing,
      setEditingAnnotationId: (id) => { editing = id; },
      helpers: {
        escapeHtml: window.PdfPreviewModalUtils.escapeHtml,
        resolveAnnotationSource: (ann) => ann.source,
        hostAdvertisesCapability: () => true,
      },
    });
  });

  afterEach(() => {
    controller?.destroy();
    window.PdfPreviewModalMarkupToolbar?.destroy();
    delete window.i18n;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('translates every rendered sidebar label, tooltip and editor placeholder', () => {
    const modal = document.getElementById('pdfPreviewModal');
    controller.renderSidebar();
    expect(modal.querySelector('.revert-annotation-to-ai')).not.toBeNull();
    expectTranslated(modal);
    editing = modal.querySelector('.list-group-item').dataset.annotationId;
    controller.renderSidebar();
    expect(modal.querySelector('textarea')).not.toBeNull();
    expectTranslated(modal);
    annotations = {};
    controller.renderSidebar();
    expectTranslated(modal);
  });

  it('translates every markup tool and colour tooltip', () => {
    const modal = document.getElementById('pdfPreviewModal');
    window.PdfPreviewModalMarkupToolbar.create(modal);
    window.PdfPreviewModalMarkupToolbar.show();
    expect(modal.querySelectorAll('[title]').length).toBeGreaterThan(8);
    expectTranslated(modal);
  });

  it('keeps translated quotes and markup as text in sidebar attributes', () => {
    window.i18n.t = (key) => `T:${key} "<img src=x onerror=alert(1)>`;
    controller.renderSidebar();
    const modal = document.getElementById('pdfPreviewModal');
    expect(modal.querySelectorAll('img, [onerror]')).toHaveLength(0);
    expect(modal.querySelector('[title]').title).toContain('"<img');
  });

  it('preserves standalone English and parameter interpolation without i18n', () => {
    delete window.i18n;
    window.PdfPreviewModalMarkupToolbar.create(document.getElementById('pdfPreviewModal'));
    expect(document.querySelector('[data-tool="pen"]').title).toBe('Pen (P)');
    expect(window.PdfPreviewModalUtils.translateText('Page %(page)s', { page: 2 })).toBe('Page 2');
  });
});

it('guards new direct English DOM literals throughout src, including unvisited modal states', () => {
  const directory = join(process.cwd(), 'src');
  const failures = [];
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(path, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/(?:title|placeholder|aria-label)="[A-Za-z][A-Za-z .!?,…-]*"/.test(line) ||
            />\s*[A-Za-z][A-Za-z .!?,…-]+\s*</.test(line) ||
            /\.(?:textContent|placeholder|title)\s*=\s*['"][A-Za-z][A-Za-z .!?,…-]+['"]/.test(line) ||
            /setAttribute\(['"](?:title|placeholder|aria-label)['"],\s*['"][A-Za-z]/.test(line)) {
          failures.push(`${entry.name}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }
  scan(directory);
  expect(failures).toEqual([]);
});
