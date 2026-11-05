import { defineConfig } from 'vitest/config';
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = process.platform === 'win32'
  ? process.env.AEMS_TEST_OUTPUT_DIR || join('C:/Temp/aems/unit', basename(fileURLToPath(new URL('../..', import.meta.url))), 'artifacts')
  : undefined;
if (outputDir) {
  const tempDir = resolve(outputDir, 'system-temp');
  mkdirSync(tempDir, { recursive: true });
  Object.assign(process.env, { AEMS_TEST_OUTPUT_DIR: outputDir, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir });
}

export default defineConfig({
  cacheDir: outputDir ? join(outputDir, 'vite-cache') : undefined,
  test: {
    coverage: outputDir ? { reportsDirectory: join(outputDir, 'coverage') } : {},
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
    clearMocks: true,
  },
});
