import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const output = process.env.AEMS_TEST_OUTPUT_DIR
    || (process.platform === 'win32' ? 'C:/Temp/aems/ui/aems-pdf-annotator/components' : '/tmp/aems-pdf-annotator-components');

export default defineConfig({
    testDir: './tests/browser',
    outputDir: join(output, 'playwright-results'),
    reporter: [['list']],
    forbidOnly: true,
    use: { viewport: { width: 1200, height: 900 }, headless: true },
});
