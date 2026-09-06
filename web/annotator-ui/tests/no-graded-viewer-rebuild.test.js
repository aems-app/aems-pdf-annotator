import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The graded viewer must never be rebuilt from outside pdf-viewer.js.
//
// reRenderAllPages() calls renderSkeleton(), which does
// `container.innerHTML = ''` and destroys every page wrapper together with the
// .drawing-canvas-overlay inside it. That is the teardown behind issue #472.
//
// The resize paths were converted to relayoutPagesForContainer() one at a time,
// and each conversion missed one: first the ResizeObserver, then the
// document-controller's 400 ms fullscreen path, then the pre-shell monolith
// fallback, and finally `scheduleGradedViewerRelayout` -- a function NAMED
// relayout that called reRenderAllPages(true) 180 ms after the "Show Annotated"
// pane is activated, with no drawing guard. An external review found that one
// still live after I had twice declared the teardown gone.
//
// Grepping the source is the only check that scales to "every call site",
// including the ones no unit test reaches. It would have caught all four.

// fileURLToPath, not URL.pathname: on Windows the latter yields '/D:/...' and a
// hand-rolled strip produced a path that does not exist.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The one legitimate home: the method and its internals live here, and the zoom
// path genuinely must rebuild because the bitmap resolution changes with zoom.
const OWNER = 'pdf-viewer.js';

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Strip comments so the prose explaining why a file no longer calls this does
// not fail the test.
//
// Carriage returns go first. These files are CRLF, and in JS a dot does not
// match a line terminator, so a pattern anchored with $ can never reach that
// anchor on a line ending in CR -- the strip silently did nothing and two
// comments were reported as offenders. Same family as every other "matched
// without its context" bug in this codebase.
function codeOnly(line) {
  return line
    .split('\r').join('')
    .replace(/\/\/.*/, '')
    .replace(/\/\*.*?\*\//g, '');
}

describe('no external rebuild of the graded viewer', () => {
  it('nothing outside pdf-viewer.js calls reRenderAllPages', () => {
    const offenders = [];
    let scanned = 0;
    for (const file of jsFiles(SRC)) {
      if (file.endsWith(OWNER)) continue;
      scanned += 1;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\breRenderAllPages\s*\(/.test(codeOnly(line))) {
          offenders.push(`${file.split(/[/\\]/).pop()}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(scanned, 'the file walk found nothing, so this test is vacuous')
      .toBeGreaterThan(5);
    expect(
      offenders,
      'these rebuild the page DOM and destroy the drawing overlay; '
      + 'call relayoutPagesForContainer() instead',
    ).toEqual([]);
  });

  it('the comment filter does not swallow a real call', () => {
    // Guards the guard: if codeOnly() were too eager the test above would pass
    // on any codebase at all.
    expect(codeOnly('  viewer.reRenderAllPages(true);')).toContain('reRenderAllPages');
    expect(codeOnly('  // viewer.reRenderAllPages(true);\r')).not.toContain('reRenderAllPages');
    expect(codeOnly('  viewer.reRenderAllPages(true); // why\r')).toContain('reRenderAllPages');
  });

  it('ensureModalViewers arms the document-replace guard', () => {
    // Structural, deliberately: the call site sits inside ensureModalViewers,
    // which is only reachable by opening the modal for real. A behavioural test
    // of armDocumentReplaceGuard() proves the helper works but not that anything
    // calls it -- deleting the call survived the whole suite.
    const monolith = readFileSync(join(SRC, 'pdf-preview-modal.js'), 'utf8');
    const fn = monolith.indexOf('function ensureModalViewers');
    expect(fn, 'ensureModalViewers not found').toBeGreaterThan(-1);
    const body = monolith.slice(fn, fn + 12000);
    expect(
      body,
      'ensureModalViewers no longer arms the document-replace guard',
    ).toContain('armDocumentReplaceGuard()');
  });

  it('both modal close paths reset the drawing-persistence bookkeeping', () => {
    // Structural, because the shell close path runs only when a real modal is
    // composed. The reset used to sit behind `if (_currentShell) return;`, so it
    // never ran in production while its test passed on the fallback path. Two
    // call sites are required: the fallback listener and the shell's onClose.
    const monolith = readFileSync(join(SRC, 'pdf-preview-modal.js'), 'utf8');
    // CALL sites only. Counting bare occurrences also counted the `function`
    // declaration, so one call plus the definition satisfied a >= 2 check and
    // deleting the shell-path call survived the whole suite.
    const calls = (monolith.match(/(?<!function\s)resetDrawingPersistenceBookkeeping\(\);/g) || []).length;
    expect(
      calls,
      'the reset must be CALLED from both the fallback and the shell close path',
    ).toBeGreaterThanOrEqual(2);
    expect(monolith).toContain('_currentShell.onClose(');
  });

  it('the reflow method exists and the zoom path still rebuilds', () => {
    // Guards the escape hatch: if someone "fixes" the test above by deleting
    // the reflow, or routes zoom through it, this fails.
    const viewer = readFileSync(join(SRC, 'pdf-preview-modal', OWNER), 'utf8');
    expect(viewer).toContain('async relayoutPagesForContainer()');
    expect(viewer).toContain('zoomResizeAndRenderVisible');
  });
});
