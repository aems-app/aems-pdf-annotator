import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function concatIife(files) {
    return {
        name: 'concat-annotator-iife',
        load(id) {
            const normalizedId = id.replace(/\\/g, '/');
            if (!normalizedId.endsWith('src/bundle-entry.js')) {
                return null;
            }

            return files.map((file) => {
                const filePath = join(__dirname, 'src', file);
                return readFileSync(filePath, 'utf-8');
            }).join('\n\n');
        },
    };
}

function emitCss(cssFile) {
    return {
        name: 'emit-annotator-css',
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'annotator-ui.css',
                source: readFileSync(join(__dirname, 'src', cssFile), 'utf-8'),
            });
        },
    };
}

const orderedSources = [
    'pdf-preview-modal/utils.js',
    'pdf-preview-modal/annotation-helpers.js',
    'pdf-preview-modal/annotation-state.js',
    'pdf-preview-modal/inline-editor.js',
    'pdf-preview-modal/sidebar-panel.js',
    'pdf-preview-modal/rendering.js',
    'pdf-preview-modal/annotation-controller.js',
    'pdf-preview-modal/drag-drop.js',
    'pdf-preview-modal/search.js',
    'pdf-preview-modal/comparison-mode.js',
    'pdf-preview-modal/pdf-viewer.js',
    'pdf-preview-modal/drawing-canvas.js',
    'pdf-preview-modal/textbox.js',
    'pdf-preview-modal/markup-toolbar.js',
    'pdf-preview-modal/markup-selection.js',
    'pdf-preview-modal/modal-state.js',
    'pdf-preview-modal/modal-shell.js',
    'pdf-preview-modal/document-controller.js',
    'pdf-preview-modal/overlay-renderer.js',
    'pdf-preview-modal/version-sync.js',
    'pdf-preview-modal/index.js',
    'pdf-preview-modal.js',
];

export default {
    input: 'src/bundle-entry.js',
    output: {
        file: 'dist/annotator-ui.js',
        format: 'iife',
        name: 'AEMSPdfAnnotatorBundle',
        sourcemap: true,
    },
    plugins: [
        concatIife(orderedSources),
        emitCss('annotator-ui.css'),
    ],
};
