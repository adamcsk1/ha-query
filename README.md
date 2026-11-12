# HA Query

[![CI](https://github.com/adamcsk1/ha-query/actions/workflows/tests.yml/badge.svg)](https://github.com/adamcsk1/ha-query/actions/workflows/tests.yml)

A read-only [Home Assistant](https://www.home-assistant.io/) integration with a bundled dashboard card. Query live entities and registered devices with structured YAML filters, then display and group the results.

The query language supports boolean groups, numeric and text comparisons, wildcards, exclusions, nested attributes, and device history. It does not accept SQL, Jinja, or executable code.

## Requirements

- Home Assistant **2026.11.0 or newer**
- SQLite Recorder database for history queries; MariaDB and PostgreSQL are not supported
- Dashboard resources managed through the UI for automatic registration; YAML-managed resources need one manual entry

## Install with HACS

1. In [HACS](https://www.hacs.xyz/), add `https://github.com/adamcsk1/ha-query` as a custom **Integration** repository.
2. Install **HA Query** and restart Home Assistant.
3. Go to **Settings > Devices & services > Add integration**, then select **HA Query**.
4. Add a **Manual** dashboard card using the quick start below or one of the [examples](examples/).

The integration registers its `/ha-query/ha-query-card.js` dashboard resource automatically where supported. Restart Home Assistant after every update, then hard-refresh the browser to load matching backend and card versions.

### Manual install

Copy `custom_components/ha_query/` into `/config/custom_components/ha_query/`, restart Home Assistant, then add the integration through **Settings > Devices & services**.

For YAML-managed dashboard resources, add this entry under your existing `lovelace:` section:

```yaml
lovelace:
  resource_mode: yaml
  resources:
    - url: /ha-query/ha-query-card.js
      type: module
```

## Quick start

Copy this into a **Manual** dashboard card:

```yaml
type: custom:ha-query-card
title: Battery levels
group_by: area
entity_links: true
query:
  from: entities
  where:
    device_class: battery
  columns:
    - device.name
    - entity.state
    - entity.unit
  sort:
    by: entity.state
  limit: 100
```

This shows battery sensor tiles under area headings, sorted by charge. Device names open Home Assistant's More Information dialog.

## Documentation

- [Card and query options](docs/configuration.md): option tables, display settings, grouping, and updates
- [Query language and history](docs/query-language.md): filters, fields, sorting, and Recorder requirements
- [Examples](examples/): complete card configurations to copy and edit
- [Troubleshooting](docs/troubleshooting.md): updates, YAML, events, icons, and history
- [Security](docs/security.md): permissions, read-only access, and resource limits
- [Contributing](CONTRIBUTING.md): development setup and checks

To uninstall, remove dashboard cards and the integration first. HA Query removes only the unchanged resource it created; pre-existing or user-modified resources are preserved. Deleting files through HACS alone cannot perform resource cleanup.

## License

[MIT](LICENSE)
