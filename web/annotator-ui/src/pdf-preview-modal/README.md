# Annotator UI Source

This directory is the browser-source-of-truth for the extracted AEMS PDF
annotator UI.

The bundle is built by `web/annotator-ui/rollup.config.js` into:
- `dist/annotator-ui.js`
- `dist/annotator-ui.css`

The build preserves the existing global runtime expected by AEMS while also
exporting the portable package entrypoint:
- `window.AEMSPdfAnnotator.createAnnotatorModal(options)`

Important ownership rules:
- edit annotator UI code here, not in AEMS
- keep AEMS-specific routing and legacy globals in the AEMS wrapper only
- when the bundle changes, rebuild this package and sync the dist assets into
  AEMS via `npm run sync:annotator-ui` in the AEMS repo

Primary source files:
- `pdf-preview-modal.js` - extracted modal engine and portable export bridge
- `pdf-preview-modal/` - controllers, utilities, viewer, comparison, and markup modules

Tests:
- `npm test` in `web/annotator-ui`
