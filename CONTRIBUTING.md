# Contributing

See [AGENTS.md](AGENTS.md) for the code layout, compatibility rules, and security invariants.

## Setup

Use Python 3.14.2 or newer and Node.js 22.13 or newer:

```bash
python -m pip install -r requirements-test.txt
npm ci
```

## Checks

Run the complete suite before committing:

```bash
python -m ruff check .
npm run lint
python -m unittest discover -s tests -v
python -m compileall -q custom_components
npm test
```

GitHub Actions runs these checks on Linux with Python 3.14 and Node.js 22.

Tests cover filter semantics, Home Assistant API contracts, permissions, area resolution, resource ownership, query lifecycle, read-only SQLite access, response limits, examples, and card behavior. Keep real Home Assistant schema tests and temporary SQLite fixtures when changing those contracts.

Add a regression test for each bug fix. Test valid behavior and rejected malformed input for new query features. Update callers, examples, and documentation with shared-code changes.

Automated tests do not replace a live Home Assistant dashboard smoke test for card changes.
