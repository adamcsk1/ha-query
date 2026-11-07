# HA Query contributor guide

## Purpose

HA Query is a read-only Home Assistant custom integration and bundled Lovelace card. It queries live entities and registered devices with bounded YAML filters. Device inactivity is the only Recorder-backed feature.

Minimum supported target: Home Assistant **2026.11.0**, Python **3.14.2+**. CI runs on Linux with Python 3.14 and Node.js 22.

## Structure

- `custom_components/ha_query/__init__.py`: HA lifecycle, resource ownership, and WebSocket endpoint.
- `custom_components/ha_query/query_language.py`: pure filter validation, normalization, typed operators, and boolean evaluation.
- `custom_components/ha_query/query_execution.py`: live row construction, permissions, device membership, and Recorder orchestration.
- `custom_components/ha_query/query_engine.py`: bounded read-only SQLite access and sorting.
- `custom_components/ha_query/query_response.py`: attribute projection and bounded HA-compatible response preparation.
- `custom_components/ha_query/frontend/ha-query-card.js`: dependency-free card rendering, grouping, polling, and stale-response handling.
- `examples/`: complete card configurations validated by tests.
- `tests/test_query_language.py`: pure filter semantics and validation bounds.
- `tests/test_integration.py`: HA API contracts, permissions, history, resources, examples, and response limits.
- `tests/test_query_engine.py`: real temporary SQLite fixtures and sort behavior.
- `tests/test_query_response.py`: response compatibility, serialization, and early resource bounds.
- `tests/test_examples.py`: shipped card queries validated against HA and query schemas.
- `tests/test_card.cjs`: dependency-free Node tests for card behavior.
- `.github/workflows/tests.yml`: mandatory lint/test checks.

## Required checks

Run before committing:

```bash
python -m pip install -r requirements-test.txt
npm ci
python -m ruff check .
npm run lint
python -m unittest discover -s tests -v
python -m compileall -q custom_components
npm test
```

Run the complete suite after shared-code changes. A mocked unit test alone does not cover HA API contracts; retain the real HA schema/decorator tests and real SQLite tests. Do not call the integration production-proven without a live Home Assistant dashboard smoke test.

## Compatibility

Keep the `ha_query/run` payload, legacy shorthand, existing examples, and current card YAML working unless the user explicitly requests a breaking change. Device inactivity defaults to 14 days and supports `1d` through `365d`.

Test both validation and execution when changing the query grammar. `validate_query()` must not mutate input because requests are validated before orchestration.

## Security and data invariants

- Check `POLICY_READ` before exposing entity data. Device results require permission for every participating registered entity; recheck after Recorder reads.
- Never add raw SQL, Jinja, Python evaluation, arbitrary JavaScript, or user-supplied regular expressions.
- Attribute access is dictionary-only with validated, bounded paths. Never expose the internal `_attributes` row member in WebSocket responses.
- Keep SQL entity IDs parameter-bound and connections read-only. Do not weaken executor, timeout, concurrency, row, column, nesting, or response-size limits.
- Missing or excluded history is not proof of inactivity. Check Recorder health, current device membership, and recent live updates after database reads.
- Entity areas override device areas; device history uses device area.
- Resource cleanup deletes only the unchanged resource created and owned by this integration.
- Disable/unload must stop query access without returning stale results.
- Render remote names, attributes, warnings, and errors as text, not HTML.

## Changes and tests

Make the smallest complete change. Update callers, tests, examples, and README together. Add a regression test for every bug fixed. Cover both successful behavior and rejected malformed input for new query features.

Review dependency locks and configuration changes. No new runtime dependency without demonstrated need. Development-only lint tools must stay out of the integration manifest requirements.

## Git

Do not amend, force-push, disable protection, or mutate GitHub settings without explicit user instruction. Prefer `--force-with-lease` when force-push is requested. Restore branch protection immediately if it was temporarily relaxed for an explicitly requested force-push.

Config-entry `VERSION` is a schema version, not the package version.
