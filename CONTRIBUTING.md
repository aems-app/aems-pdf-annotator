# Contributing to aems-pdf-annotator

Thanks for considering a contribution. This is a small, focused library — bug reports and well-scoped patches are most welcome.

## Dev setup

```bash
git clone https://github.com/aems-app/aems-pdf-annotator
cd aems-pdf-annotator
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

## Running tests

```bash
python -m pytest
```

The full suite uses real PyMuPDF (the rendering tests need it). Without PyMuPDF installed, only the model + validator + contract tests will run.

## Lint + type check

```bash
ruff check src tests
mypy src
```

CI runs the same three commands on Python 3.10 and 3.12 (Ubuntu). PRs that break either are blocked.

## UI bundle (`web/annotator-ui/`)

The repo also ships a Rollup-built JS overlay used by the AEMS server. If you touch anything under `web/annotator-ui/src/`:

```bash
cd web/annotator-ui
npm install
npm test
npm run build
```

CI runs `npm test` and `npm run build` for the UI bundle on every push.

## Filing issues

Open at [https://github.com/aems-app/aems-pdf-annotator/issues](https://github.com/aems-app/aems-pdf-annotator/issues). Include:

- The version (`python -c "import aems_pdf_annotator; print(aems_pdf_annotator.__version__)"`).
- A minimal reproducer if it's a rendering bug.
- The PDF page count + DPI if it's a coordinate / placement bug.

## Pull requests

- Branch from `main`.
- Keep the PR focused — one feature or fix per PR.
- New behaviour needs a test.
- Update `CHANGELOG.md` under an `## Unreleased` heading.
- The annotation-contract surface (`models.py`, `contract.py`) is consumer-coupled to the AEMS server and the AEMS Agent; changes that bump `CURRENT_CONTRACT_VERSION` require a coordinated update in both consumers and a CHANGELOG entry.

## License

By contributing you agree that your contributions are licensed under the AGPL-3.0-or-later, matching the project licence.
