// @vitest-environment node
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

let browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

function luminance(rgb) {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

it.each(['active', 'hover', 'active hover'])('dark comment %s meets AA for content and metadata', async state => {
  const page = await browser.newPage({ viewport: { width: 1093, height: 614 } });
  try {
    await page.setContent(`<body data-theme="dark"><div id="pdfPreviewModal"><div class="comments-panel">
      <div id="pdfGradedCommentsList"><div class="list-group-item ${state.includes('active') ? 'active item-focused' : ''}">
      <div class="annotation-content">Synthetic comment</div><div class="small">Page 1</div>
      </div></div></div></div></body>`);
    await page.addStyleTag({ content: readFileSync('src/annotator-ui.css', 'utf8') + '\n* { transition: none !important; }' });
    if (state.includes('hover')) await page.locator('.list-group-item').hover();
    // Read final browser colours; gradients must pass at every stop.
    const colors = await page.locator('.list-group-item').evaluate(card => {
      const css = getComputedStyle(card);
      return {
        backgrounds: css.backgroundImage === 'none' ? [css.backgroundColor]
          : css.backgroundImage.match(/rgba?\([^)]+\)/g),
        text: [...card.children].map(node => getComputedStyle(node).color),
      };
    });
    for (const bg of colors.backgrounds) for (const fg of colors.text) {
      const a = luminance(fg), b = luminance(bg);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  } finally { await page.close(); }
});
